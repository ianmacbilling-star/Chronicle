'use strict';
// v3.2.68 -- TD-1006. The monthly storage clean-up. Once a month each environment looks at pictures under uploads/ in
// its OWN bucket that nothing in its own database uses (services/storageAudit.js decides, history tables aside) and
// that are over 30 days old. Mode (Dashboard > Support): off, report (the default: email the numbers) or hold.
// v3.2.69 -- TD-1006. Nothing is deleted from the main bucket by the clean-up any more (Ian 2026-10-24): an unused
// picture MOVES to the holding bucket (R2_HOLDING_BUCKET, default campaignia-holding) under <environment>/uploads/...,
// copied first, the copy checked, and only then removed from the main bucket. Put back copies pictures home; a picture
// put back is never moved again (the keep list). Pictures leave holding for good only by Ian's Empty holding button,
// or when the monthly run in Move to holding mode finds them held over 90 days (Ian 2026-10-24).
// Refused unless the environment is on its own bucket and the holding bucket is a third one, or when over 60% of the
// bucket looks unused (that would mean the check is wrong). Only counts are kept for the last run.
const storage = require('../storage/storage');
const audit = require('./storageAudit');

const MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_UNUSED_SHARE = 0.6;
const MODES = ['off', 'report', 'hold'];
const KEEP_MAX = 20000;
const HOLD_DAYS = 90;
const S = { running: false, phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, last: null, error: null, job: null };

async function getSetting(db, key) { try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(key); return r ? r.value : null; } catch (e) { return null; } }
async function setSetting(db, key, value) {
  const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(key);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(value), key);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(key, String(value));
}
async function getMode(db) { let m = await getSetting(db, 'storage_cleanup_mode'); if (m === 'delete') m = 'hold'; return MODES.indexOf(m) >= 0 ? m : 'report'; }
async function setMode(db, m) { if (MODES.indexOf(m) < 0) throw new Error('Mode must be off, report or hold.'); await setSetting(db, 'storage_cleanup_mode', m); return m; }

// Pictures put back are never moved again.
async function getKeep(db) { try { const a = JSON.parse(await getSetting(db, 'storage_cleanup_keep') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
async function addKeep(db, keys) {
  if (!keys.length) return;
  const set = new Set(await getKeep(db)); keys.forEach(function (k) { set.add(k); });
  await setSetting(db, 'storage_cleanup_keep', JSON.stringify(Array.from(set).slice(-KEEP_MAX)));
}

function envName() { return process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local'; }
function holdPrefix() { return String(envName()).toLowerCase().replace(/[^a-z0-9-]/g, '-') + '/'; }
function heldKey(key) { return holdPrefix() + key; }

function holdingOk() {
  const own = storage.bucketName(), hold = storage.holdingBucket();
  const shared = String(process.env.R2_SHARED_BUCKET || '').trim();
  if (!hold) return { ok: false, why: 'No holding bucket is set.' };
  if (hold === own || hold === shared || hold === 'chronicle-images' || hold === 'campaignia-staging-images') return { ok: false, why: 'The holding bucket must be a bucket of its own, not ' + hold + '.' };
  return { ok: true, why: '' };
}
function deletionAllowed() {
  const env = envName(), own = storage.bucketName();
  const shared = String(process.env.R2_SHARED_BUCKET || '').trim();
  if (shared && shared === own) return { ok: false, why: 'R2_SHARED_BUCKET is this environment\'s own bucket.' };
  if (env === 'production' && own !== 'chronicle-images') return { ok: false, why: 'Production is expected on chronicle-images, but uses ' + own + '.' };
  if (env !== 'production' && own === 'chronicle-images') return { ok: false, why: 'This is ' + env + ', which must not move pictures out of production\'s bucket (chronicle-images). Set R2_BUCKET.' };
  return holdingOk();
}

async function status(db) {
  let last = null; try { last = JSON.parse(await getSetting(db, 'storage_cleanup_last') || 'null'); } catch (e) { last = null; }
  return { env: envName(), bucket: storage.bucketName(), holdBucket: storage.holdingBucket(), holdPrefix: holdPrefix(), mode: await getMode(db),
    allowed: deletionAllowed(), month: await getSetting(db, 'storage_cleanup_month'), keep: (await getKeep(db)).length,
    last: last, job: S.job, running: S.running, phase: S.phase, done: S.done, total: S.total, error: S.error };
}

// Four at a time, counting progress.
async function pool(list, fn) {
  let i = 0; S.total = list.length; S.done = 0;
  const w = async function () { while (i < list.length) { const x = list[i++]; await fn(x); S.done++; } };
  await Promise.all([w(), w(), w(), w()]);
}

// One picture to holding: copy, check the copy, then remove it from the main bucket. Throws if any step fails, so
// the picture stays where it was (or, if only the last step failed, sits in both, which is harmless).
async function moveOne(it, own, hold) {
  const r = await storage.copyBetween(own, it.key, hold, heldKey(it.key));
  if (r !== 'copied') throw new Error('not copied: ' + r);
  const h = await storage.headObject(hold, heldKey(it.key));
  if (!h || (it.size != null && h.size !== it.size)) throw new Error('the held copy did not check out');
  await storage.deleteKey(it.key);
}

// One run. doMove false = report only.
async function run(db, doMove, now) {
  now = now || Date.now();
  const rep = await audit.unusedPictureReport(db, { now: now, minAgeMs: MIN_AGE_MS });
  if (rep.error) throw new Error(rep.error);
  const keep = new Set(await getKeep(db));
  const items = rep.items.filter(function (it) { return !keep.has(it.key); });
  const kept = rep.items.length - items.length;
  const unusedBytes = items.reduce(function (a, it) { return a + (it.size || 0); }, 0);
  const out = { at: new Date(now).toISOString(), env: rep.env, bucket: storage.bucketName(), holdBucket: storage.holdingBucket(), mode: doMove ? 'hold' : 'report',
    listed: rep.listed, listedBytes: rep.listed_bytes, inUse: rep.in_use, tooNew: rep.recent, unused: items.length, unusedBytes: unusedBytes, putBackBefore: kept,
    byKind: rep.by_kind, moved: 0, movedBytes: 0, nowInUse: 0, failed: 0, refused: '' };
  if (doMove && items.length) {
    const allowed = deletionAllowed();
    if (!allowed.ok) out.refused = allowed.why;
    else if (rep.listed && items.length / rep.listed > MAX_UNUSED_SHARE) out.refused = 'More than ' + Math.round(MAX_UNUSED_SHARE * 100) + '% of the bucket looks unused (' + items.length + ' of ' + rep.listed + '); nothing moved, as that suggests the check is wrong.';
    else {
      const fresh = await audit.referencedKeys(db);   // the last look, just before moving
      const todo = items.filter(function (it) { if (fresh.refs.has(it.key)) { out.nowInUse++; return false; } return true; });
      const own = storage.bucketName(), hold = storage.holdingBucket();
      S.phase = 'moving to holding';
      await pool(todo, async function (it) {
        try { await moveOne(it, own, hold); out.moved++; out.movedBytes += it.size || 0; }
        catch (e) { out.failed++; }
      });
    }
  }
  await setSetting(db, 'storage_cleanup_last', JSON.stringify(out));
  return out;
}

function mb(n) { return ((n || 0) / 1048576).toFixed(1) + ' MB'; }
function summaryText(o) {
  const NL = String.fromCharCode(10);
  return ['Storage clean-up (' + (o.mode === 'hold' ? 'move to holding' : 'report') + ') on ' + o.env + ', bucket ' + o.bucket + ', ' + o.at, '',
    'Files under uploads/: ' + o.listed + ' (' + mb(o.listedBytes) + ')',
    'In use: ' + o.inUse + '   newer than 30 days: ' + o.tooNew + (o.putBackBefore ? ('   put back before, kept: ' + o.putBackBefore) : ''),
    'Unused and over 30 days: ' + o.unused + ' (' + mb(o.unusedBytes) + ')' + (o.byKind ? ('  ' + Object.keys(o.byKind).sort().map(function (k) { return k + ' ' + o.byKind[k].count; }).join(', ')) : ''),
    o.mode === 'hold' ? ('Moved to holding (' + o.holdBucket + '): ' + o.moved + ' (' + mb(o.movedBytes) + ')   started being used, kept: ' + o.nowInUse + '   failed: ' + o.failed + NL + 'Nothing is deleted. Put back or Empty holding on Dashboard > Support.')
      : 'Report only: nothing moved. Switch the mode to Move to holding on Dashboard > Support when you are happy.',
    o.refused ? ('NOT MOVED: ' + o.refused) : '',
    o.emptied ? ('Held over ' + o.emptied.days + ' days, deleted for good: ' + o.emptied.deleted + ' (' + mb(o.emptied.deletedBytes) + ')   failed: ' + o.emptied.failed) : ''].join(NL);
}
async function mail(o) { try { await require('../routes/email').sendAlertEmail('Storage clean-up: ' + (o.mode === 'hold' ? (o.moved + ' moved to holding') : (o.unused + ' unused')) + ' on ' + o.env, summaryText(o)); } catch (e) {} }

// One background job at a time (a run, a put back, or emptying holding), with progress.
function startJob(phase, fn) {
  if (S.running) throw new Error('Something is already running (' + S.phase + ').');
  Object.assign(S, { running: true, phase: phase, done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  (async function () {
    try { await fn(); S.phase = 'finished'; }
    catch (e) { S.error = (e && e.message) || String(e); S.phase = 'error'; }
    finally { S.running = false; S.finishedAt = new Date().toISOString(); }
  })();
}

// The Dashboard's Run now.
async function runNow(db, doMove) {
  startJob('checking', async function () { const o = await run(db, !!doMove); S.last = o; await mail(o); });
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
  try {
    const o = await run(db, mode === 'hold', now.getTime());
    if (mode === 'hold' && holdingOk().ok) { try { S.phase = 'emptying holding'; o.emptied = await emptyOld(HOLD_DAYS, now.getTime()); } catch (e) { o.emptied = { days: HOLD_DAYS, deleted: 0, deletedBytes: 0, tooRecent: 0, failed: -1 }; }
      await setSetting(db, 'storage_cleanup_last', JSON.stringify(o)); }
    S.last = o; S.phase = 'finished'; await mail(o); return o;
  }
  finally { S.running = false; S.finishedAt = new Date().toISOString(); }
}

// ---- Holding -------------------------------------------------------------------------------------------------
async function held() {
  const list = await storage.listObjects(holdPrefix() + 'uploads/', storage.holdingBucket());
  return (list || []).map(function (o) { return { key: o.key.slice(holdPrefix().length), size: o.size, heldSince: o.lastModified }; });
}
async function holdingSummary() {
  const ok = holdingOk(); if (!ok.ok) return { bucket: storage.holdingBucket(), prefix: holdPrefix(), error: ok.why };
  const h = await held();
  const dates = h.map(function (o) { return o.heldSince; }).filter(Boolean).sort();
  return { bucket: storage.holdingBucket(), prefix: holdPrefix(), count: h.length, bytes: h.reduce(function (a, o) { return a + (o.size || 0); }, 0),
    oldest: dates[0] || null, newest: dates[dates.length - 1] || null };
}
async function heldCsv() {
  const h = await held();
  return 'key,held_since,size_bytes\n' + h.map(function (o) { return o.key + ',' + (o.heldSince || '') + ',' + (o.size || 0); }).join('\n') + '\n';
}

// A picture's name or its web address -> its key (uploads/<name>), or null.
function nameToKey(s) {
  s = String(s || '').trim().split(/[?#]/)[0];
  if (!s) return null;
  const m = s.match(/(?:^|\/)uploads\/([A-Za-z0-9._\-]+)$/);
  const name = m ? m[1] : (/^[A-Za-z0-9._\-]+$/.test(s) ? s : null);
  return (name && name !== '.' && name !== '..') ? ('uploads/' + name) : null;
}

// One picture home: never over a file that is already there; copy, check, then remove the held copy.
async function restoreOne(key, own, hold) {
  if (await storage.headObject(own, key)) return 'already';
  const r = await storage.copyBetween(hold, heldKey(key), own, key);
  if (r === 'missing') return 'notheld';
  if (r !== 'copied') throw new Error('not copied: ' + r);
  if (!(await storage.headObject(own, key))) throw new Error('not back');
  await storage.deleteHeld(heldKey(key));
  return 'restored';
}
async function restore(db, names, all) {
  const ok = holdingOk(); if (!ok.ok) throw new Error(ok.why);
  startJob('putting back', async function () {
    const res = { kind: 'restore', at: new Date().toISOString(), restored: 0, already: 0, notHeld: 0, unreadable: 0, failed: 0 };
    let keys;
    if (all) keys = (await held()).map(function (o) { return o.key; });
    else { keys = []; (names || []).forEach(function (n) { const k = nameToKey(n); if (k) { if (keys.indexOf(k) < 0) keys.push(k); } else if (String(n || '').trim()) res.unreadable++; }); }
    const own = storage.bucketName(), hold = storage.holdingBucket(), back = [];
    await pool(keys, async function (k) {
      try { const r = await restoreOne(k, own, hold); if (r === 'restored') { res.restored++; back.push(k); } else if (r === 'already') { res.already++; back.push(k); } else res.notHeld++; }
      catch (e) { res.failed++; }
    });
    await addKeep(db, back);
    S.job = res;
  });
  return status(db);
}
async function emptyHolding(db, olderThanDays) {
  const ok = holdingOk(); if (!ok.ok) throw new Error(ok.why);
  const days = Math.max(0, parseInt(olderThanDays, 10) || 0);
  startJob('emptying holding', async function () { S.job = await emptyOld(days); });
  return status(db);
}
// This environment's held pictures held at least `days` days (0 = all), deleted for good.
async function emptyOld(days, now) {
  const res = { kind: 'empty', at: new Date(now || Date.now()).toISOString(), days: days, deleted: 0, deletedBytes: 0, tooRecent: 0, failed: 0 };
  const cut = (now || Date.now()) - days * 86400000;
  const h = await held();
  const todo = h.filter(function (o) { const t = Date.parse(o.heldSince || ''); if (days && !(t <= cut)) { res.tooRecent++; return false; } return true; });
  await pool(todo, async function (o) {
    try { await storage.deleteHeld(heldKey(o.key)); res.deleted++; res.deletedBytes += o.size || 0; }
    catch (e) { res.failed++; }
  });
  return res;
}

module.exports = { status, run, runNow, maybeMonthly, getMode, setMode, deletionAllowed, holdingOk, summaryText, holdingSummary, heldCsv,
  nameToKey, restore, emptyHolding, MIN_AGE_MS, MAX_UNUSED_SHARE, HOLD_DAYS };
