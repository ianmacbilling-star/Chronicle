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
const { getDb } = require('./database/db');
const { runSnapshot } = require('./routes/admin');
const { sendAlertEmail } = require('./routes/email');

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
  // Future slices hook in here (e.g. daily trial-lifecycle pass).
}

let started = false;
function startScheduler() {
  if (started) return;
  started = true;
  setTimeout(function () { tick(); }, 90 * 1000); // first pass once the app has settled
  setInterval(function () { tick(); }, HOUR);     // then hourly
  console.log('[scheduler] started (hourly tick; weekly snapshot Sunday night UTC)');
}

module.exports = { startScheduler };
