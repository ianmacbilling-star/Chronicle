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
const { sendAlertEmail, sendTrialLifecycleEmail } = require('./routes/email');
const { getTier, isLoneCopper } = require('./middleware/tiers');
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
// Account-lifecycle idle sweep (ACCOUNT_LIFECYCLE_SPEC Phase 2). PHASE 2 SHIPS
// IN WARN-ONLY MODE: it reconciles lone_since for every active copper user and
// flags warn-stage users (idle_warned_at). Suspend (Phase 3) and purge (Phase 4)
// are intentionally NOT implemented here yet. Thresholds are admin-tunable via
// app_settings and clamped to a floor so a fat-fingered 0 can't sweep everyone.
// ---------------------------------------------------------------------------
const LIFECYCLE_FLOOR_DAYS = 1; // safety floor; revisit before enabling purge
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
    scannedCopper: 0, loneStamped: 0, loneCleared: 0, warned: 0, suspended: 0, purged: 0, dryRun: !!opts.dryRun };

  // Anyone no longer copper (e.g. upgraded) shouldn't carry a lone clock.
  try { await db.prepare("UPDATE users SET lone_since = NULL WHERE lone_since IS NOT NULL AND tier <> 'copper'").run(); } catch (e) {}

  const coppers = await db.prepare(
    "SELECT id, lone_since, last_active_at, last_purchase_at, idle_warned_at FROM users WHERE tier = 'copper' AND status = 'active'"
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
    // Clock 1 start = max(lone_since, last_active_at, last_purchase_at).
    const startMs = Math.max(_ms(loneSince), _ms(u.last_active_at), _ms(u.last_purchase_at));
    const ageDays = (nowMs - startMs) / 86400000;
    if (ageDays >= idleDays && !u.idle_warned_at) {
      if (!opts.dryRun) { try { await db.prepare('UPDATE users SET idle_warned_at = ? WHERE id = ?').run(nowIso, u.id); } catch (e) {} }
      summary.warned++;
      // Phase 2: log the warning. The warning EMAIL is wired in Phase 2b.
      try { await logDebug(u.id, { level: 'info', source: 'lifecycle', page: 'sweep', fn: 'runLifecycleSweep',
        message: 'Idle warning: lone copper ~' + Math.floor(ageDays) + 'd (threshold ' + idleDays + 'd)',
        detail: { ageDays: Math.floor(ageDays), idleDays: idleDays } }); } catch (e) {}
    }
    // Phase 3 (suspend) / Phase 4 (purge) slot in here, each behind its own flag.
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

module.exports = { startScheduler, runLifecycleSweep };
