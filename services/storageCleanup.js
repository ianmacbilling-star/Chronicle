// v3.2.68 -- TD-1006 THE MONTHLY CLEAN-UP (Ian, 2026-10-24: "a clean up routine ... that deletes anything orphaned
// older than 30 days"). Pictures under uploads/ in THIS environment's bucket that nothing in THIS environment's
// database uses (services/storageAudit.js decides, history tables aside) and that are over 30 days old.
//
// SAFE ONLY BECAUSE EACH ENVIRONMENT HAS ITS OWN BUCKET (v3.2.67: staging moved to campaignia-staging-images).
// Deleting is refused unless that holds: production must be on chronicle-images, any other environment must NOT be
// (a staging deploy that lost R2_BUCKET would otherwise delete production's pictures). It is also refused when more
// than 60% of the bucket looks unused, which would mean the check has gone wrong rather than that storage is dirty.
//
// Mode (app_settings storage_cleanup_mode): off | report | delete; 'report' until Ian says otherwise, so the first
// run only emails a summary. Runs once a month, on the first hourly tick on or after the 1st at 09:00 UTC. Before
// deleting it scans the database again and skips anything that has started being used. Deletes 4 at a time. Only
// counts are stored and emailed, never keys: a stored key would itself count as "in use" next time.
'use strict';
const storage = require('../storage/storage');
const audit = require('./storageAudit');

const MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_UNUSED_SHARE = 0.6;
const MODES = ['off', 'report', 'delete'];
const S = { running: false, phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, last: null, error: null };

async function getSetting(db, key) { try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(key); return r ? r.value : null; } catch (e) { return null; } }
async function setSetting(db, key, value) {
  const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(key);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(value), key);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(key, String(value));
}
async function getMode(db) { const m = await getSetting(db, 'storage_cleanup_mode'); return MODES.indexOf(m) >= 0 ? m : 'report'; }
async function setMode(db, m) { if (MODES.indexOf(m) < 0) throw new Error('Mode must be off, report or delete.'); await setSetting(db, 'storage_cleanup_mode', m); return m; }

function envName() { return process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local'; }
function deletionAllowed() {
  const env = envName(), own = storage.bucketName();
  const shared = String(process.env.R2_SHARED_BUCKET || '').trim();
  if (shared && shared === own) return { ok: false, why: 'R2_SHARED_BUCKET is this environment\'s own bucket.' };
  if (env === 'production' && own !== 'chronicle-images') return { ok: false, why: 'Production is expected on chronicle-images, but uses ' + own + '.' };
  if (env !== 'production' && own === 'chronicle-images') return { ok: false, why: 'This is ' + env + ', which must not delete from production\'s bucket (chronicle-images). Set R2_BUCKET.' };
  return { ok: true, why: '' };
}

async function status(db) {
  let last = null; try { last = JSON.parse(await getSetting(db, 'storage_cleanup_last') || 'null'); } catch (e) { last = null; }
  return { env: envName(), bucket: storage.bucketName(), mode: await getMode(db), allowed: deletionAllowed(), month: await getSetting(db, 'storage_cleanup_month'),
    last: last, running: S.running, phase: S.phase, done: S.done, total: S.total, error: S.error };
}

// One run. doDelete false = report only.
async function run(db, doDelete, now) {
  now = now || Date.now();
  const rep = await audit.unusedPictureReport(db, { now: now, minAgeMs: MIN_AGE_MS });
  if (rep.error) throw new Error(rep.error);
  const out = { at: new Date(now).toISOString(), env: rep.env, bucket: storage.bucketName(), mode: doDelete ? 'delete' : 'report',
    listed: rep.listed, listedBytes: rep.listed_bytes, inUse: rep.in_use, tooNew: rep.recent, unused: rep.unused, unusedBytes: rep.unused_bytes,
    byKind: rep.by_kind, deleted: 0, deletedBytes: 0, nowInUse: 0, failed: 0, refused: '' };
  if (doDelete && rep.unused) {
    const allowed = deletionAllowed();
    if (!allowed.ok) out.refused = allowed.why;
    else if (rep.listed && rep.unused / rep.listed > MAX_UNUSED_SHARE) out.refused = 'More than ' + Math.round(MAX_UNUSED_SHARE * 100) + '% of the bucket looks unused (' + rep.unused + ' of ' + rep.listed + '); nothing deleted, as that suggests the check is wrong.';
    else {
      const fresh = await audit.referencedKeys(db);   // the last look, just before deleting
      const todo = rep.items.filter(function (it) { if (fresh.refs.has(it.key)) { out.nowInUse++; return false; } return true; });
      S.total = todo.length; S.done = 0; S.phase = 'deleting';
      let i = 0;
      const worker = async function () {
        while (i < todo.length) {
          const it = todo[i++];
          try { await storage.deleteKey(it.key); out.deleted++; out.deletedBytes += it.size || 0; }
          catch (e) { out.failed++; }
          S.done++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    }
  }
  await setSetting(db, 'storage_cleanup_last', JSON.stringify(out));
  return out;
}

function mb(n) { return ((n || 0) / 1048576).toFixed(1) + ' MB'; }
function summaryText(o) {
  const NL = String.fromCharCode(10);
  return ['Storage clean-up (' + o.mode + ') on ' + o.env + ', bucket ' + o.bucket + ', ' + o.at, '',
    'Files under uploads/: ' + o.listed + ' (' + mb(o.listedBytes) + ')',
    'In use: ' + o.inUse + '   newer than 30 days: ' + o.tooNew,
    'Unused and over 30 days: ' + o.unused + ' (' + mb(o.unusedBytes) + ')' + (o.byKind ? ('  ' + Object.keys(o.byKind).sort().map(function (k) { return k + ' ' + o.byKind[k].count; }).join(', ')) : ''),
    o.mode === 'delete' ? ('Deleted: ' + o.deleted + ' (' + mb(o.deletedBytes) + ')   started being used, kept: ' + o.nowInUse + '   failed: ' + o.failed) : 'Report only: nothing deleted. Switch the mode to Delete on Dashboard > Support when you are happy.',
    o.refused ? ('NOT DELETED: ' + o.refused) : ''].join(NL);
}
async function mail(o) { try { await require('../routes/email').sendAlertEmail('Storage clean-up: ' + (o.mode === 'delete' ? (o.deleted + ' deleted') : (o.unused + ' unused')) + ' on ' + o.env, summaryText(o)); } catch (e) {} }

// The Dashboard's Run now: in the background, with progress.
async function runNow(db, doDelete) {
  if (S.running) throw new Error('A clean-up is already running.');
  Object.assign(S, { running: true, phase: 'checking', done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  (async function () {
    try { const o = await run(db, !!doDelete); S.last = o; S.phase = 'finished'; await mail(o); }
    catch (e) { S.error = (e && e.message) || String(e); S.phase = 'error'; }
    finally { S.running = false; S.finishedAt = new Date().toISOString(); }
  })();
  return status(db);
}

// The scheduler's monthly call. Marks the month BEFORE running, so a restart can never run it twice.
async function maybeMonthly(db, nowDate) {
  const now = nowDate || new Date();
  const month = now.toISOString().slice(0, 7);
  if (now.getUTCHours() < 9 && now.getUTCDate() === 1) return null;
  const mode = await getMode(db);
  if (mode === 'off') return null;
  if (await getSetting(db, 'storage_cleanup_month') === month) return null;
  if (S.running) return null;
  await setSetting(db, 'storage_cleanup_month', month);
  S.running = true; S.phase = 'checking';
  try { const o = await run(db, mode === 'delete', now.getTime()); S.last = o; S.phase = 'finished'; await mail(o); return o; }
  finally { S.running = false; S.finishedAt = new Date().toISOString(); }
}

module.exports = { status, run, runNow, maybeMonthly, getMode, setMode, deletionAllowed, summaryText, MIN_AGE_MS, MAX_UNUSED_SHARE };
