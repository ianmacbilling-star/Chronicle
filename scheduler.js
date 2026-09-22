// ============================================================
// scheduler.js -- in-app scheduler
// ------------------------------------------------------------
// Runs INSIDE the main web process (the same always-on process that
// serves requests and runs the DB heartbeat). It wakes on a timer,
// checks whether any scheduled job is due, runs it, and goes back to
// sleep. No external cron / Railway dashboard job is required.
//
// Jobs are idempotent and use app_settings markers so a restart can
// neither double-run nor silently skip a week.
// ============================================================
const { getDb, getAppSettingInt } = require('./database/db');
const { runSnapshot } = require('./routes/admin');
const { sendAlertEmail, sendTrialLifecycleEmail, sendIdleWarningEmail, sendSuspendedEmail, sendPurgeWarningEmail, sendAccountClosedEmail, sendPassEndingSoonEmail, sendPassExpiredEmail } = require('./routes/email');
const { getTier, TIERS, isLoneCopper, sqlLivePass } = require('./middleware/tiers');
const { logDebug } = require('./routes/debug');

const HOUR = 60 * 60 * 1000;

async function getSetting(db, key) {
  try {
    const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(key);
    return r ? r.value : null;
  } catch (e) { return null; }
}

async function setSetting(db, key, value) {
  const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(key);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(value), key);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(key, String(value));
}

// Monday (UTC) of the week containing dateObj, as YYYY-MM-DD. Matches the
// week-keying runSnapshot() uses internally.
function mondayOf(dateObj) {
  var d = new Date(dateObj.getTime());
  var day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// Weekly metrics snapshot: target Sunday night (UTC), once per week.
// Bootstraps on first ever run, and catches up if a week was missed
// (e.g. the app was down all Sunday), so it never goes dark for long.
// runSnapshot() upserts by week, so a duplicate run is harmless.
// ------------------------------------------------------------
async function maybeWeeklySnapshot(db) {
  const now = new Date();
  const thisWeek = mondayOf(now);
  const last = await getSetting(db, 'scheduler_last_snapshot_week');
  if (last === thisWeek) return null;                       // already done this week
  const lastWeek = mondayOf(new Date(now.getTime() - 7 * 24 * HOUR));
  const isSundayLate = (now.getUTCDay() === 0 && now.getUTCHours() >= 22);
  const behind = !last || last < lastWeek;                  // never ran, or 2+ weeks dark
  if (!isSundayLate && !behind) return null;                // not Sunday night yet; wait
  const result = await runSnapshot(db);
  await setSetting(db, 'scheduler_last_snapshot_week', thisWeek);
  await setSetting(db, 'scheduler_last_snapshot_at', now.toISOString());
  console.log('[scheduler] weekly snapshot written for week ' + thisWeek);
  return result;
}

// Monitoring report -> ALERT_EMAIL. sendAlertEmail is production-gated
// (ALERTS_ENABLED), so this is a no-op on staging by design.
async function sendSnapshotReport(db, snap) {
  try {
    const active = await db.prepare("SELECT value FROM metric_snapshots WHERE week_start = ? AND metric = 'active_users'").get(snap.week_start);
    const tiers = await db.prepare("SELECT tier, value FROM metric_snapshots WHERE week_start = ? AND metric = 'tier_count' ORDER BY tier").all(snap.week_start);
    var body = 'The automatic weekly metrics snapshot just ran.' + String.fromCharCode(10) + String.fromCharCode(10);
    body += 'Week of:      ' + snap.week_start + String.fromCharCode(10);
    body += 'Active users: ' + (active ? active.value : '?') + String.fromCharCode(10);
    (tiers || []).forEach(function (t) { body += '  ' + t.tier + ': ' + t.value + String.fromCharCode(10); });
    body += String.fromCharCode(10) + 'Rows written: ' + snap.written;
    await sendAlertEmail('Weekly snapshot complete', body);
  } catch (e) {
    console.error('[scheduler] snapshot report email failed:', e && e.message);
  }
}

// ------------------------------------------------------------
// Tick: called shortly after boot, then hourly. Each job decides for
// itself whether it is due, so the tick stays cheap and safe to repeat.
// ------------------------------------------------------------
// ------------------------------------------------------------
// Trial-lifecycle emails. PRODUCTION-GATED behind LIFECYCLE_EMAILS_ENABLED
// so staging never emails real users. Runs at most once per calendar day.
// Each milestone is keyed off trial_started_at + the configured trial
// window; the lifecycle_emails table guarantees one send per (user, type).
// 'requireNotMember' suppresses the nudge for users who are players in
// someone else's campaign (they still have access, so no expiry nag).
// ------------------------------------------------------------
async function runMilestone(db, type, daysAgo, requireNotMember) {
  var sql =
    "SELECT u.id, u.name, u.email FROM users u " +
    "WHERE u.trial_started_at IS NOT NULL " +
    "AND u.trial_started_at::date = (CURRENT_DATE - (? * INTERVAL '1 day'))::date " +
    "AND u.tier NOT IN ('silver','gold','platinum') " +
    // v3.0.919 -- TD-780 Push 3. NOR anyone holding a live pass. They are Platinum; chasing
    // them with "your trial is ending, upgrade" mail is the version of this feature that
    // makes a paying customer think nobody is looking.
    "AND NOT " + sqlLivePass('u') + " " +
    "AND NOT EXISTS (SELECT 1 FROM lifecycle_emails le WHERE le.user_id = u.id AND le.email_type = ?)";
  if (requireNotMember) {
    sql += " AND NOT EXISTS (SELECT 1 FROM campaign_members cm WHERE cm.user_id = u.id AND cm.role = 'player')";
  }
  const rows = await db.prepare(sql).all(daysAgo, type);
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    var u = rows[i];
    try {
      await sendTrialLifecycleEmail(type, u.name, u.email);
      await db.prepare("INSERT INTO lifecycle_emails (user_id, email_type) VALUES (?, ?) ON CONFLICT (user_id, email_type) DO NOTHING").run(u.id, type);
      sent++;
      console.log('[scheduler] ' + type + ' -> user ' + u.id);
    } catch (e) {
      console.error('[scheduler] ' + type + ' failed for user ' + u.id + ':', e && e.message);
    }
  }
  return sent;
}

async function maybeDailyTrialPass(db) {
  if (process.env.LIFECYCLE_EMAILS_ENABLED !== 'true') return;   // production-gated
  const today = new Date().toISOString().slice(0, 10);
  const last = await getSetting(db, 'scheduler_last_trial_pass');
  if (last === today) return;                                    // already ran today
  var trialDays = 30;
  try { trialDays = getTier('trial').trial_days || 30; } catch (e) {}
  // ending_soon fires 7 days before expiry; the rest at / after expiry.
  await runMilestone(db, 'trial_ending_soon', trialDays - 7, false);
  await runMilestone(db, 'trial_expired',     trialDays,      true);
  await runMilestone(db, 'trial_week_after',  trialDays + 7,  true);
  await runMilestone(db, 'trial_month_after', trialDays + 30, true);
  await setSetting(db, 'scheduler_last_trial_pass', today);
  console.log('[scheduler] daily trial-lifecycle pass complete for ' + today);
}

// ---------------------------------------------------------------------------
// v3.0.936 -- TD-780 Push 8 of 8. PASS EXPIRY EMAILS.
//
// Same shape as the trial pass above: production-gated behind LIFECYCLE_EMAILS_ENABLED, at most
// one run per calendar day, one row in lifecycle_emails per send. The differences are all in the
// key and in who is excluded.
//
// THE KEY CARRIES THE PASS'S OWN EXPIRY DATE -- 'pass_warn_30:2026-12-16'. lifecycle_emails is
// UNIQUE (user_id, email_type) and email_type is TEXT, so putting the occurrence in the key gives
// a repeat buyer a fresh row without any DDL against a live production database. TD-780 recorded
// this push as blocked on a schema change; it was not.
//
// THE DATE COMES OUT OF POSTGRES ALREADY FORMATTED. Doing it in JS would mean parsing a timestamp
// the query has already compared against CURRENT_DATE, and the two could then disagree about which
// day it is -- which is exactly how a mail goes out keyed to one date and reading another.
// `offset` is days from today to the pass expiry date: POSITIVE for a warning ahead of time,
// NEGATIVE for the notice afterwards.
//
// THE SIGN ALSO DECIDES WHETHER THE PASS MUST STILL BE LIVE, and getting that wrong was the first
// version of this function. It required sqlLivePass() for every milestone, which for the
// end-of-pass notice is a contradiction: pass_expires_at is a TIMESTAMP, so on the expiry day the
// pass is live until its own time of day. That query would have mailed "your pass has ended" in
// the morning while it was still running, and then -- once the hour passed -- matched nobody at
// all, because the row is no longer live. The notice would simply never have gone out, and the
// daily gate means one silent miss per person, forever.
//
// So the notice runs the day AFTER at offset -1, against a pass that is definitely OVER.
// v3.0.956 -- opts.dryRun collects the people and skips exactly two statements: the send and
// the lifecycle_emails insert. Everything before that -- the query, the exclusions, the
// once-only check -- is identical, because a dry run that runs a different query is not a
// dry run.
//
// RETURNS A RESULT OBJECT rather than a bare count. The count was already being computed and
// thrown away by the only caller, which is why the completion log could never say whether it
// had mailed anybody.
async function runPassMilestone(db, prefix, offset, opts) {
  // WHO IS DELIBERATELY NOT MAILED:
  //  * anybody whose account status is not active -- a suspended account has other mail coming.
  //  * anybody with a live subscription that is NOT cancelling. Their access does not end when the
  //    pass does, so "your pass ends" is a false alarm. A subscriber who bought a pass IS mailed,
  //    because v3.0.935 set their subscription to stop and they really will land on Copper.
  //  * anybody who bought another pass -- no clause needed, because that moves pass_expires_at and
  //    the date arithmetic below stops matching the old one.
  const stillLive = (offset > 0)
    ? sqlLivePass('u')
    : "(u.pass_tier IS NOT NULL AND u.pass_expires_at IS NOT NULL AND u.pass_expires_at <= CURRENT_TIMESTAMP)";
  const sql =
    "SELECT u.id, u.name, u.email, u.pass_tier, " +
    "  to_char(u.pass_expires_at, 'YYYY-MM-DD') AS key_date, " +
    "  to_char(u.pass_expires_at, 'FMMonth FMDD, YYYY') AS nice_date " +
    "FROM users u " +
    "WHERE " + stillLive + " " +
    "AND u.pass_expires_at::date = (CURRENT_DATE + (? * INTERVAL '1 day'))::date " +
    "AND COALESCE(u.status, 'active') = 'active' " +
    "AND NOT (u.tier IN ('silver','gold','platinum') AND COALESCE(u.cancel_at_period_end, false) = false) " +
    "AND NOT EXISTS (SELECT 1 FROM lifecycle_emails le WHERE le.user_id = u.id " +
    "                AND le.email_type = ?::text || ':' || to_char(u.pass_expires_at, 'YYYY-MM-DD'))";
  const dryRun = !!(opts && opts.dryRun);
  const rows = await db.prepare(sql).all(offset, prefix);
  const out = { prefix: prefix, offset: offset, matched: rows.length, sent: 0, failed: 0, people: [] };
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    const type = prefix + ':' + u.key_date;
    const tierName = (TIERS[u.pass_tier] && TIERS[u.pass_tier].name) || u.pass_tier || 'Platinum';
    // WHAT THE DRY RUN SHOWS is the same identifying detail the send would use, so a reader can
    // tell whether the right person matched for the right date.
    const who = { id: u.id, name: u.name || '', email: u.email, pass_tier: u.pass_tier,
                  expires: u.key_date, expires_nice: u.nice_date, email_type: type };
    if (dryRun) { who.would_send = true; out.people.push(who); continue; }
    try {
      if (offset > 0) await sendPassEndingSoonEmail(u.name, u.email, tierName, u.nice_date, offset);
      else await sendPassExpiredEmail(u.name, u.email, tierName);
      // THE ROW GOES IN AFTER THE SEND, NEVER BEFORE. Recording first and failing to send would
      // mean this person is never warned about THIS pass again -- the unique index guarantees it.
      // The other way round, a send that succeeds and a row that does not costs one duplicate.
      await db.prepare("INSERT INTO lifecycle_emails (user_id, email_type) VALUES (?, ?) ON CONFLICT (user_id, email_type) DO NOTHING").run(u.id, type);
      out.sent++;
      who.sent = true;
      console.log('[scheduler] ' + type + ' -> user ' + u.id);
    } catch (e) {
      out.failed++;
      who.sent = false;
      who.error = (e && e.message) || 'unknown';
      console.error('[scheduler] ' + type + ' failed for user ' + u.id + ':', e && e.message);
    }
    out.people.push(who);
  }
  return out;
}

// v3.0.956 -- THE WHOLE SWEEP, IN ONE PLACE, CALLED BY THE DAILY JOB AND BY THE ADMIN BUTTON.
//
// It deliberately does NOT look at the daily gate or at LIFECYCLE_EMAILS_ENABLED. Those are
// the DAILY JOB's business -- one says "the hourly tick already did this today", the other says
// "this environment does not send lifecycle mail at all". An operator pressing a button has
// answered both questions by pressing it, and a dry run must work regardless of either.
//
// Duplicate mail is prevented by lifecycle_emails -- one row per person per milestone per
// expiry date -- and that holds however the sweep is started. The gate is a scheduling
// convenience, not the safety mechanism, and it is worth being clear about which is which.
async function runPassSweep(db, opts) {
  const dryRun = !!(opts && opts.dryRun);
  // Offsets are configurable the same way the purge warnings are, and for the same reason: the
  // right notice for a three-month pass is not obviously the right one for a twelve-month pass,
  // and that is a judgement to make from real behaviour rather than to guess at now.
  const stored = await getSetting(db, 'pass_warn_days');
  // A WHITESPACE-ONLY VALUE IS AN ABSENT ONE. '   ' is truthy, so taking the stored value
  // whenever it is merely truthy would accept it as the setting, parse it to no offsets, and
  // -- because it also fails the "was anything really set" test below -- disable every advance
  // warning while reporting nothing wrong. Found by the mutation harness, which is the only
  // reason it is not shipping.
  const raw = (stored && String(stored).trim()) ? stored : '30,7';
  const offsets = String(raw).split(',')
    .map(function (s) { return parseInt(s.trim(), 10); })
    .filter(function (n) { return Number.isFinite(n) && n > 0; });

  // A SETTING THAT PARSES TO NOTHING IS NOT THE SAME AS AN ABSENT ONE, AND IT USED TO LOOK IT.
  // '0', '-7', 'thirty', a stray semicolon -- each yields an empty array, every advance warning
  // stops, and the expired notice below keeps firing because it is hardcoded. The feature then
  // looks alive while the half that gives somebody time to renew is gone. TD-587: say so.
  const offsetsInvalid = !!(stored && String(stored).trim() && offsets.length === 0);
  if (offsetsInvalid) {
    console.error('[scheduler] pass_warn_days is set to "' + stored + '" which parses to NO valid ' +
                  'offsets -- every advance warning is disabled. The expired notice still runs.');
  }

  const result = {
    dryRun: dryRun,
    ranAt: new Date().toISOString(),
    offsets: offsets,
    offsetsRaw: String(raw),
    offsetsSource: stored ? 'pass_warn_days setting' : 'default (no pass_warn_days row)',
    offsetsInvalid: offsetsInvalid,
    emailsEnabled: process.env.LIFECYCLE_EMAILS_ENABLED === 'true',
    milestones: [],
    matched: 0, sent: 0, failed: 0
  };

  for (let i = 0; i < offsets.length; i++) {
    result.milestones.push(await runPassMilestone(db, 'pass_warn_' + offsets[i], offsets[i], { dryRun: dryRun }));
  }
  // THE DAY AFTER, NOT THE DAY OF. See the note on runPassMilestone: on the expiry day the pass is
  // still live until its own time of day, so a day-0 notice is either premature or never sent.
  result.milestones.push(await runPassMilestone(db, 'pass_expired', -1, { dryRun: dryRun }));

  result.milestones.forEach(function (m) {
    result.matched += m.matched; result.sent += m.sent; result.failed += m.failed;
  });
  return result;
}

async function maybeDailyPassPass(db) {
  const today = new Date().toISOString().slice(0, 10);
  if (process.env.LIFECYCLE_EMAILS_ENABLED !== 'true') {         // production-gated
    console.log('[scheduler] pass-expiry pass SKIPPED for ' + today + ': LIFECYCLE_EMAILS_ENABLED is not true');
    return;
  }
  const last = await getSetting(db, 'scheduler_last_pass_email_pass');
  if (last === today) {
    // v3.0.956 -- SAY SO. This used to return in silence, so on a day with several deploys the
    // completion line lived in an earlier deployment's log and the current one looked dead. That
    // cost an hour on 2026-09-19 to establish that nothing was wrong.
    console.log('[scheduler] pass-expiry pass already ran today (' + today + '); skipping');
    return;
  }

  const r = await runPassSweep(db, { dryRun: false });
  await setSetting(db, 'scheduler_last_pass_email_pass', today);
  // v3.0.956 -- THE COUNTS. "Mailed nobody" and "found nobody" were indistinguishable from this
  // line, which is the one thing you want it to tell you.
  console.log('[scheduler] daily pass-expiry pass complete for ' + today +
              ' -- matched ' + r.matched + ', sent ' + r.sent + ', failed ' + r.failed +
              ' (offsets ' + r.offsetsRaw + ')');
}

// ---------------------------------------------------------------------------
// Account-lifecycle idle sweep (ACCOUNT_LIFECYCLE_SPEC Phase 2). PHASE 2 SHIPS
// IN WARN-ONLY MODE: it reconciles lone_since for every active copper user and
// flags warn-stage users (idle_warned_at). Suspend (Phase 3) and purge (Phase 4)
// are intentionally NOT implemented here yet. Thresholds are admin-tunable via
// app_settings and clamped to a floor so a fat-fingered 0 can't sweep everyone.
// ---------------------------------------------------------------------------
const LIFECYCLE_FLOOR_DAYS = 1; // safety floor; revisit before enabling purge
const PURGE_MAX_PER_RUN = 50; // safety cap: never tombstone more than this per sweep
function _ms(v) {
  if (!v) return 0;
  const t = (v instanceof Date) ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// Run the sweep once. opts.dryRun = compute + report without writing. Returns a
// summary object (also used by the admin 'Run sweep now' button).
async function runLifecycleSweep(db, opts) {
  opts = opts || {};
  let idleDays = await getAppSettingInt('lifecycle_idle_days', 90);
  let purgeDays = await getAppSettingInt('lifecycle_purge_days', 180);
  if (!(idleDays >= LIFECYCLE_FLOOR_DAYS)) idleDays = LIFECYCLE_FLOOR_DAYS;
  if (!(purgeDays >= LIFECYCLE_FLOOR_DAYS)) purgeDays = LIFECYCLE_FLOOR_DAYS;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const summary = { mode: 'warn-only', idleDays: idleDays, purgeDays: purgeDays,
    scannedCopper: 0, loneStamped: 0, loneCleared: 0, warned: 0, wouldWarn: 0, emailed: 0,
    suspended: 0, wouldSuspend: 0, purgeWarned: 0, wouldPurgeWarn: 0, tombstoned: 0, wouldTombstone: 0, dryRun: !!opts.dryRun };
  const emailsEnabled = process.env.LIFECYCLE_EMAILS_ENABLED === 'true';
  const suspendEnabled = process.env.LIFECYCLE_SUSPEND_ENABLED === 'true';
  const purgeEnabled = process.env.LIFECYCLE_PURGE_ENABLED === 'true';
  let graceDays = await getAppSettingInt('lifecycle_warn_grace_days', 14);
  if (!(graceDays >= LIFECYCLE_FLOOR_DAYS)) graceDays = LIFECYCLE_FLOOR_DAYS;

  // Anyone no longer copper (e.g. upgraded) shouldn't carry a lone clock.
  // v3.0.919 -- TD-780 Push 3. A LIVE PASS HOLDER IS NOT A COPPER EITHER. Ian, 2026-09-15:
  // "no active pass holder should be on copper. They would still be platinum." Their account
  // tier is untouched by a pass (see ownTier in middleware/tiers.js), so a bare tier test
  // still sees 'copper' and would leave the clock running on somebody who has paid.
  try { await db.prepare("UPDATE users SET lone_since = NULL WHERE lone_since IS NOT NULL AND (tier <> 'copper' OR " + sqlLivePass() + ")").run(); } catch (e) {}

  // v3.0.919 -- TD-780 Push 3. The live-pass clause is here rather than only inside
  // isLoneCopper() for two reasons: the sweep should not walk people it cannot act on, and
  // the rule reads correctly at the point somebody looks at this query. (isLoneCopper has
  // been returning false for them since v3.0.918, so the BEHAVIOUR was already right -- this
  // makes it visible and saves the per-row call.)
  // pass_expires_at is selected because the idle clock below has to start when the pass
  // ended, not when they last logged in.
  const coppers = await db.prepare(
    "SELECT id, name, email, lone_since, last_active_at, last_purchase_at, idle_warned_at, pass_expires_at " +
    "FROM users WHERE tier = 'copper' AND status = 'active' AND NOT " + sqlLivePass()
  ).all();
  for (let i = 0; i < coppers.length; i++) {
    const u = coppers[i];
    summary.scannedCopper++;
    let lone = false;
    try { lone = await isLoneCopper(u.id); } catch (e) { lone = false; }
    if (!lone) {
      if (u.lone_since && !opts.dryRun) { try { await db.prepare('UPDATE users SET lone_since = NULL WHERE id = ?').run(u.id); } catch (e) {} }
      if (u.lone_since) summary.loneCleared++;
      continue;
    }
    let loneSince = u.lone_since;
    if (!loneSince) {
      if (!opts.dryRun) { try { await db.prepare('UPDATE users SET lone_since = ? WHERE id = ?').run(nowIso, u.id); } catch (e) {} }
      loneSince = nowIso;
      summary.loneStamped++;
    }
    // Clock 1 start = max(lone_since, last_active_at, last_purchase_at, pass_expires_at).
    // v3.0.919 -- TD-780 Push 3. pass_expires_at IS THE IMPORTANT ONE HERE, and it is the
    // reason this is not merely tidying. Somebody buys a twelve-month pass, makes their book
    // in month one and does not come back. Their last_active_at is eleven months old when the
    // pass finally lapses, so on the very first sweep afterwards they are already past the
    // idle threshold and get warned immediately -- having been a paying customer the day
    // before. Taking the pass expiry into the max starts their clock when the pass ended.
    const startMs = Math.max(_ms(loneSince), _ms(u.last_active_at), _ms(u.last_purchase_at), _ms(u.pass_expires_at));
    const ageDays = (nowMs - startMs) / 86400000;
    if (ageDays >= idleDays && !u.idle_warned_at) {
      if (opts.dryRun || !emailsEnabled) {
        // Preview / emails not enabled: identify but do NOT warn or progress, so
        // nobody is ever advanced toward suspension without a delivered warning.
        summary.wouldWarn++;
      } else {
        try { await db.prepare('UPDATE users SET idle_warned_at = ? WHERE id = ?').run(nowIso, u.id); } catch (e) {}
        summary.warned++;
        let emailed = false;
        try { await sendIdleWarningEmail(u.name, u.email); emailed = true; summary.emailed++; } catch (e) {}
        try { await logDebug(u.id, { level: 'info', source: 'lifecycle', page: 'sweep', fn: 'runLifecycleSweep',
          message: 'Idle warning (lone copper ~' + Math.floor(ageDays) + 'd, threshold ' + idleDays + 'd, emailed ' + emailed + ')',
          detail: { ageDays: Math.floor(ageDays), idleDays: idleDays, emailed: emailed } }); } catch (e) {}
      }
    }
    // SUSPEND stage (Phase 3): a warned user still idle past the grace window.
    // Gated by LIFECYCLE_SUSPEND_ENABLED; reactivation is automatic on next login.
    if (u.idle_warned_at && ageDays >= idleDays) {
      const warnedAgeDays = (nowMs - _ms(u.idle_warned_at)) / 86400000;
      if (warnedAgeDays >= graceDays) {
        if (opts.dryRun || !suspendEnabled) {
          summary.wouldSuspend++;
        } else {
          try { await db.prepare("UPDATE users SET status = 'suspended', suspended_at = ? WHERE id = ?").run(nowIso, u.id); } catch (e) {}
          summary.suspended++;
          let sEmailed = false;
          if (emailsEnabled) { try { await sendSuspendedEmail(u.name, u.email); sEmailed = true; } catch (e) {} }
          try { await logDebug(u.id, { level: 'info', source: 'lifecycle', page: 'sweep', fn: 'runLifecycleSweep',
            message: 'Account suspended (idle lone copper, warned ~' + Math.floor(warnedAgeDays) + 'd ago, grace ' + graceDays + 'd, emailed ' + sEmailed + ')',
            detail: { warnedAgeDays: Math.floor(warnedAgeDays), graceDays: graceDays, emailed: sEmailed } }); } catch (e) {}
        }
      }
    }
  }

  // ===== PURGE stage (Phase 4): suspended accounts nearing / past the purge window.
  // Sends escalating warnings, then TOMBSTONES (scrub PII + status='deleted'). Stored
  // content and R2 objects are NOT reclaimed yet -- that runs in a later, reference-
  // counted pass. Gated by LIFECYCLE_PURGE_ENABLED; capped per run.
  const warnRaw = (await getSetting(db, 'lifecycle_purge_warn_days')) || '30,7';
  const warnLeads = warnRaw.split(',').map(function (x) { return parseInt((x || '').trim(), 10); })
    .filter(function (n) { return Number.isFinite(n) && n >= 0; }).sort(function (a, b) { return b - a; });
  let tombstonedThisRun = 0;
  const suspended = await db.prepare("SELECT id, name, email, suspended_at FROM users WHERE status = 'suspended' AND suspended_at IS NOT NULL").all();
  for (let j = 0; j < suspended.length; j++) {
    const su = suspended[j];
    const suspMs = _ms(su.suspended_at);
    const daysSusp = (nowMs - suspMs) / 86400000;
    const deleteDateStr = new Date(suspMs + purgeDays * 86400000).toISOString().slice(0, 10);
    for (let k = 0; k < warnLeads.length; k++) {
      const L = warnLeads[k];
      if (daysSusp >= (purgeDays - L)) {
        const etype = 'purge_warn_' + L;
        let already = false;
        try { already = !!(await db.prepare('SELECT 1 FROM lifecycle_emails WHERE user_id = ? AND email_type = ?').get(su.id, etype)); } catch (e) {}
        if (already) continue;
        if (opts.dryRun || !purgeEnabled || !emailsEnabled) { summary.wouldPurgeWarn++; continue; }
        let pw = false;
        try { await sendPurgeWarningEmail(su.name, su.email, L, deleteDateStr); pw = true; } catch (e) {}
        if (pw) { try { await db.prepare("INSERT INTO lifecycle_emails (user_id, email_type) VALUES (?, ?) ON CONFLICT (user_id, email_type) DO NOTHING").run(su.id, etype); } catch (e) {} summary.purgeWarned++; }
      }
    }
    if (daysSusp >= purgeDays) {
      if (opts.dryRun || !purgeEnabled || tombstonedThisRun >= PURGE_MAX_PER_RUN) { summary.wouldTombstone++; continue; }
      if (emailsEnabled) { try { await sendAccountClosedEmail(su.name, su.email); } catch (e) {} }
      try {
        await db.prepare("UPDATE users SET status = 'deleted', tombstoned_at = ?, name = '[removed]', email = ?, password = 'TOMBSTONED' WHERE id = ?")
          .run(nowIso, 'deleted-' + su.id + '@removed.invalid', su.id);
        summary.tombstoned++;
        tombstonedThisRun++;
        try { await logDebug(su.id, { level: 'info', source: 'lifecycle', page: 'sweep', fn: 'runLifecycleSweep',
          message: 'Account tombstoned (suspended ~' + Math.floor(daysSusp) + 'd, purge ' + purgeDays + 'd). Stored content/R2 NOT reclaimed yet (deferred).',
          detail: { daysSusp: Math.floor(daysSusp), purgeDays: purgeDays } }); } catch (e) {}
      } catch (e) {}
    }
  }

  return summary;
}

// Once-per-day gate, mirroring maybeDailyTrialPass.
async function maybeDailyLifecyclePass(db) {
  const today = new Date().toISOString().slice(0, 10);
  const last = await getSetting(db, 'scheduler_last_lifecycle_pass');
  if (last === today) return;
  const summary = await runLifecycleSweep(db, {});
  await setSetting(db, 'scheduler_last_lifecycle_pass', today);
  console.log('[scheduler] daily lifecycle sweep complete for ' + today + ' ' + JSON.stringify(summary));
}

async function tick() {
  let db;
  try { db = await getDb(); }
  catch (e) { console.error('[scheduler] no db this tick:', e && e.message); return; }
  try {
    const snap = await maybeWeeklySnapshot(db);
    if (snap) await sendSnapshotReport(db, snap);
  } catch (e) {
    console.error('[scheduler] weekly snapshot failed:', e && e.message);
    try { await sendAlertEmail('Weekly snapshot FAILED', 'The automatic weekly snapshot threw an error:' + String.fromCharCode(10) + (e && e.message ? e.message : String(e))); } catch (_) {}
  }
  try {
    await maybeDailyTrialPass(db);
  } catch (e) {
    console.error('[scheduler] trial-lifecycle pass failed:', e && e.message);
  }
  // v3.0.936 -- TD-780 Push 8. ITS OWN try, like every other job here: a throw in the pass mails
  // must not stop the lifecycle sweep that runs after it.
  try {
    await maybeDailyPassPass(db);
  } catch (e) {
    console.error('[scheduler] pass-expiry pass failed:', e && e.message);
  }
  try {
    await maybeDailyLifecyclePass(db);
  } catch (e) {
    console.error('[scheduler] lifecycle sweep failed:', e && e.message);
  }
}

let started = false;
function startScheduler() {
  if (started) return;
  started = true;
  setTimeout(function () { tick(); }, 90 * 1000); // first pass once the app has settled
  setInterval(function () { tick(); }, HOUR);     // then hourly
  console.log('[scheduler] started (hourly tick; weekly snapshot Sunday night UTC)');
}

module.exports = { startScheduler, runLifecycleSweep, runPassSweep };
