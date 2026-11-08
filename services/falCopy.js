'use strict';
// v3.5.01 -- PICTURES STILL ON FAL (Ian, 2026-11-08). When a new picture comes back from fal, persistToR2 copies it to
// our bucket; if that copy fails it keeps fal's own address so nobody loses a paid-for picture. That is right in the
// moment, but every R2 failure leaves rows pointing at fal, and fal does not keep files for ever. On 21-22 October an
// R2 key problem left 18 storyboard pictures on staging that way, and a video cut made from them could never be saved.
//
// This finds every fal address still in THIS environment's database and, for Copy, fetches each file once, stores it
// with storage.uploadFile (the same function every picture uses, so the same bucket and the same public address as
// any other picture here: staging writes to staging's bucket and production to production's, from their own
// settings), and then replaces that exact address wherever it appears, in one transaction per picture. The archive's
// source_url (how the storyboard knows a picture is archived) changes with the picture, so nothing loses its mark.
// A file fal no longer has is listed and left alone. The rights verdict follows the picture to its new address.
//
// Runs from: Dashboard > Tools (Find, Copy them to our storage), the scheduler once a night, and the start of the
// monthly storage clean-up. Never names a bucket or an address of ours itself.

const storage = require('../storage/storage');

const FAL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*fal\.media\/[^\s"'<>\\)]+/gi;
// Tables never touched: logs and history of what happened, the rights record (the verdict is copied instead), and
// the login sessions table.
const SKIP_TABLES = ['debug_logs', 'image_rights', 'session', 'sessions_store'];
// Columns that hold fal's address on purpose, beside our own copy in another column.
const SKIP_COLUMNS = { moves: ['fal_video_url'] };   // v3.5.04: the video clips' table is moves now (was video_shots)
const NIGHT_HOUR_UTC = 8;   // 3 am Eastern (4 am in summer): the site is quiet
const S = { running: false, phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, last: null, error: null };

function okIdent(s) { return /^[a-z_][a-z0-9_]*$/.test(String(s || '')); }
function q(s) { return '"' + s + '"'; }
function envName() { return process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local'; }

async function getSetting(db, key) { try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(key); return r ? r.value : null; } catch (e) { return null; } }
async function setSetting(db, key, value) {
  const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(key);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(value), key);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(key, String(value));
}

// Every text and JSON column of every table in this database, less the skipped ones.
async function columns(db) {
  const rows = await db.prepare(
    "SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c " +
    "JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema " +
    "WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' " +
    "AND c.data_type IN ('text', 'character varying', 'json', 'jsonb') ORDER BY c.table_name, c.column_name").all();
  return rows.filter(function (r) {
    if (!okIdent(r.table_name) || !okIdent(r.column_name)) return false;
    if (SKIP_TABLES.indexOf(r.table_name) >= 0) return false;
    if ((SKIP_COLUMNS[r.table_name] || []).indexOf(r.column_name) >= 0) return false;
    return true;
  });
}

// The report: every fal address, where it is used (table, column, rows), and the totals.
async function find(db) {
  const cols = await columns(db);
  const byUrl = {};
  const places = [];
  for (const c of cols) {
    const rows = await db.prepare('SELECT ' + q(c.column_name) + '::text AS v FROM ' + q(c.table_name) + ' WHERE ' + q(c.column_name) + "::text LIKE '%fal.media%'").all();
    if (!rows.length) continue;
    places.push({ table: c.table_name, column: c.column_name, rows: rows.length });
    rows.forEach(function (r) {
      const found = String(r.v || '').match(FAL_RE) || [];
      found.forEach(function (u) {
        const k = byUrl[u] || (byUrl[u] = { url: u, places: {} });
        const pk = c.table_name + '.' + c.column_name;
        k.places[pk] = (k.places[pk] || 0) + 1;
      });
    });
  }
  // Longest first, so an address that is the start of another is never replaced inside it.
  const pictures = Object.keys(byUrl).sort(function (a, b) { return b.length - a.length || (a < b ? -1 : 1); }).map(function (u) {
    return { url: u, places: Object.keys(byUrl[u].places).map(function (p) { return p + (byUrl[u].places[p] > 1 ? ' x' + byUrl[u].places[p] : ''); }) };
  });
  return { env: envName(), bucket: storage.bucketName(), columns_read: cols.length, places: places, pictures: pictures, count: pictures.length };
}

// One fal file into our bucket. { url } on success, { gone: true } when fal no longer has it, else { error }.
async function fetchAndStore(falUrl) {
  const axios = require('axios');
  let resp;
  try {
    resp = await axios.get(falUrl, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: function () { return true; } });
  } catch (e) { return { error: 'could not reach fal (' + ((e && e.code) || (e && e.message) || 'no answer') + ')' }; }
  if (resp.status === 404 || resp.status === 403 || resp.status === 410) return { gone: true, status: resp.status };
  if (resp.status < 200 || resp.status >= 300) return { error: 'fal answered ' + resp.status };
  const buf = Buffer.from(resp.data);
  if (!buf.length) return { error: 'fal sent an empty file' };
  const ct = String((resp.headers && resp.headers['content-type']) || 'image/png').split(';')[0].trim();
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const ext = isPng ? 'png' : (ct.indexOf('jpeg') >= 0 ? 'jpg' : ct.indexOf('webp') >= 0 ? 'webp' : ct.indexOf('gif') >= 0 ? 'gif' : ct.indexOf('mp4') >= 0 ? 'mp4' : 'png');
  const name = 'gen-' + Date.now() + '-' + require('crypto').randomBytes(8).toString('hex') + '.' + ext;
  try {
    const url = await storage.uploadFile(buf, name, isPng ? 'image/png' : ct);
    if (!url || !storage.isOurPublicUrl(url)) return { error: 'the copy did not come back with one of our addresses' };
    return { url: url, bytes: buf.length };
  } catch (e) { return { error: 'could not store it (' + ((e && e.message) || 'unknown') + ')' }; }
}

// Replace one exact address with another wherever it appears, in one transaction. Returns rows changed per place.
async function repoint(db, cols, fromUrl, toUrl) {
  const changed = {};
  await db.transaction(async function (tx) {
    for (const c of cols) {
      const col = q(c.column_name), tbl = q(c.table_name);
      const cast = c.data_type === 'json' ? '::json' : c.data_type === 'jsonb' ? '::jsonb' : '';
      const r = await tx.prepare('UPDATE ' + tbl + ' SET ' + col + ' = replace(' + col + '::text, ?, ?)' + cast + ' WHERE strpos(' + col + '::text, ?) > 0').run(fromUrl, toUrl, fromUrl);
      if (r && r.changes) changed[c.table_name + '.' + c.column_name] = r.changes;
    }
  });
  return changed;
}

// Copy every picture still on fal. why: 'button', 'nightly' or 'monthly' (for the log and the email).
async function copyAll(db, why) {
  const report = await find(db);
  const out = { env: report.env, bucket: report.bucket, why: why || 'button', found: report.count, copied: 0, rows_changed: 0, gone: [], failed: [], moved: [], startedAt: new Date().toISOString() };
  S.total = report.count; S.done = 0;
  if (!report.count) { out.finishedAt = new Date().toISOString(); return out; }
  const cols = await columns(db);
  for (const p of report.pictures) {
    const got = await fetchAndStore(p.url);
    if (got.gone) out.gone.push({ url: p.url, places: p.places });
    else if (got.error) out.failed.push({ url: p.url, error: got.error, places: p.places });
    else {
      try {
        const changed = await repoint(db, cols, p.url, got.url);
        const n = Object.keys(changed).reduce(function (t, k) { return t + changed[k]; }, 0);
        try { await require('./rightsCheck').inherit(p.url, got.url); } catch (e) { /* the verdict follows when it can; never blocks */ }
        out.copied++; out.rows_changed += n;
        out.moved.push({ from: p.url, to: got.url, rows: changed });
      } catch (e) {
        out.failed.push({ url: p.url, error: 'stored, but the rows could not be changed (' + ((e && e.message) || 'unknown') + '); nothing was changed for it', places: p.places });
      }
    }
    S.done++;
  }
  out.finishedAt = new Date().toISOString();
  console.log('[fal copy] ' + out.why + ' on ' + out.env + ': found ' + out.found + ', copied ' + out.copied + ' (' + out.rows_changed + ' rows), fal no longer has ' + out.gone.length + ', failed ' + out.failed.length);
  return out;
}

function summaryText(o) {
  const NL = String.fromCharCode(10);
  const lines = ['Pictures still on fal, ' + o.why + ' run on ' + o.env + ' (bucket ' + o.bucket + ').',
    'Found ' + o.found + '. Copied to our storage: ' + o.copied + ' (' + o.rows_changed + ' rows re-pointed).',
    'Fal no longer has: ' + o.gone.length + '. Failed: ' + o.failed.length + '.'];
  if (o.gone.length) lines.push('', 'Fal no longer has these (left as they are):', o.gone.map(function (g) { return '  ' + g.url + '  (' + g.places.join(', ') + ')'; }).join(NL));
  if (o.failed.length) lines.push('', 'Failed (left as they are; tried again next night):', o.failed.map(function (f) { return '  ' + f.url + ': ' + f.error; }).join(NL));
  lines.push('', 'Dashboard > Tools > Pictures still on fal shows the list at any time.');
  return lines.join(NL);
}
async function mailIfNews(o) {
  if (!o || (!o.copied && !o.gone.length && !o.failed.length)) return false;
  try { await require('../routes/email').sendAlertEmail('Pictures still on fal: ' + o.copied + ' copied, ' + o.gone.length + ' gone, ' + o.failed.length + ' failed on ' + o.env, summaryText(o)); return true; }
  catch (e) { return false; }
}

// The Dashboard's button: one run at a time, in the background, with progress.
function status() { return { running: S.running, phase: S.phase, done: S.done, total: S.total, startedAt: S.startedAt, finishedAt: S.finishedAt, last: S.last, error: S.error }; }
function startCopy(db) {
  if (S.running) throw new Error('A copy is already running (' + S.done + ' of ' + S.total + ').');
  Object.assign(S, { running: true, phase: 'copying', done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null });
  (async function () {
    try { S.last = await copyAll(db, 'button'); S.phase = 'finished'; }
    catch (e) { S.error = (e && e.message) || String(e); S.phase = 'error'; }
    finally { S.running = false; S.finishedAt = new Date().toISOString(); }
  })();
  return status();
}

// The scheduler's call, every hourly tick: runs once a day, after NIGHT_HOUR_UTC. Marks the day BEFORE running, so a
// restart never runs it twice. Quiet when there is nothing to copy; emails Ian when it copied or found a problem.
async function maybeNightly(db, nowDate) {
  const now = nowDate || new Date();
  if (now.getUTCHours() < NIGHT_HOUR_UTC) return null;
  const day = now.toISOString().slice(0, 10);
  if (await getSetting(db, 'fal_copy_day') === day) return null;
  if (S.running) return null;
  await setSetting(db, 'fal_copy_day', day);
  S.running = true; S.phase = 'nightly';
  try { const o = await copyAll(db, 'nightly'); S.last = o; S.phase = 'finished'; await mailIfNews(o); return o; }
  finally { S.running = false; S.finishedAt = new Date().toISOString(); }
}

// The monthly clean-up's first step: the same copy, so a picture is never judged under its old fal address.
async function beforeMonthly(db) {
  if (S.running) return null;
  S.running = true; S.phase = 'monthly';
  try { const o = await copyAll(db, 'monthly'); S.last = o; S.phase = 'finished'; await mailIfNews(o); return o; }
  finally { S.running = false; S.finishedAt = new Date().toISOString(); }
}

module.exports = { find, copyAll, startCopy, status, maybeNightly, beforeMonthly, summaryText, _internals: { columns, fetchAndStore, repoint, FAL_RE, SKIP_TABLES, SKIP_COLUMNS, NIGHT_HOUR_UTC, S } };
