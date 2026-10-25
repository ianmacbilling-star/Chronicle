// v3.2.65 -- TD-1006 THE UNUSED-PICTURE REPORT (read only). Regen kept every picture it replaced from v3.2.21 until
// v3.2.37 fixed releaseImage's order, so the bucket holds files nothing points to. This finds them and DELETES
// NOTHING: a delete comes later, on Ian's word, from a list he has looked at.
//
// HOW "NOTHING POINTS TO IT" IS DECIDED -- deliberately wider than releaseImage. releaseImage checks eight named
// columns; this reads EVERY text and JSON column of EVERY table in the database and collects every bucket key that
// appears anywhere (as "uploads/<file>" inside a URL, a JSON blob, a layout_meta, a debug log...). A picture counts
// as unused only if its key appears in none of them. A false "in use" costs storage; a false "unused" would cost a
// picture that cannot be redrawn, so this over-keeps on purpose.
//
// THE BUCKET IS SHARED. Staging and production write to the same bucket (chronicle-images) but keep separate
// databases, so a picture only staging uses looks unused from production, and the reverse. The report names the
// database it read; anything deleted later must be unused in BOTH.
//
// Pictures made in the last 24 hours are left out: a generation can be stored a moment before its row is written.
//
// v3.2.68 -- HISTORY IS NOT USE. Three tables only ever RECORD a picture: the debug logs, the watermark-check
// verdicts (image_rights) and the image-job log (image_jobs keeps every Regen's new and replaced picture forever;
// the app reads a job only while it finishes). Counting them kept nearly every replaced panel "in use". They are
// skipped now -- image_jobs only for jobs that have ended (done or failed); a job still running still counts.
//
// v3.2.70 -- SAVED BOOKS ARE USE TOO. Every Save on Optimize writes the book's layout and reading snapshot to the
// bucket (optimized/approved-<campaign>-<layout>-<time>.json.gz), and the Bookshelf keeps its own copies. They list
// the panel pictures AS SAVED, which may since have been regenerated -- and publishing that book, its Edit buttons
// and the print fallback all read them. The database only holds their addresses, so every saved book the database
// mentions is opened and every key inside it counts as in use. If one cannot be read (other than not being there),
// the whole check fails rather than guess -- a failed check moves nothing.
// Addresses are also read with %2F as /, so an address inside an encoded link still counts.
'use strict';
const zlib = require('zlib');
const storage = require('../storage/storage');
const KEY_RE = /(?:uploads|archives|optimized|print|story)\/[A-Za-z0-9._\-]+/g;
const RECENT_MS = 24 * 60 * 60 * 1000;
const HISTORY_TABLES = { debug_logs: true, image_rights: true };   // v3.2.68 -- records, not uses
const JOB_TABLE = 'image_jobs';                                     // v3.2.68 -- only unfinished jobs count

function kindOf(key) {
  const name = String(key).replace(/^[^/]*\//, '');
  const m = name.match(/^(gen|rest|arch)-\d+-/);
  return m ? m[1] : 'other';
}
function qid(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
const SAVED_BOOK_RE = /^optimized\/[A-Za-z0-9._\-]+\.json\.gz$/;
function addKeys(refs, s) {
  if (s.indexOf('/') < 0 && s.indexOf('%2') < 0) return;
  if (/%2F/i.test(s)) s = s.replace(/%2F/gi, '/');   // v3.2.70
  const m = s.match(KEY_RE);
  if (m) m.forEach(function (key) { refs.add(key); });
}

// Every bucket key mentioned anywhere in the database.
async function referencedKeys(db) {
  const cols = await db.prepare(
    "SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t " +
    "ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
    "WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' " +
    "AND c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY', 'character') ORDER BY c.table_name, c.column_name"
  ).all();
  const byTable = {};
  (cols || []).forEach(function (r) { (byTable[r.table_name] = byTable[r.table_name] || []).push(r.column_name); });
  const refs = new Set();
  const tables = Object.keys(byTable);
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (HISTORY_TABLES[t]) continue;   // v3.2.68
    const sel = byTable[t].map(function (c, j) { return qid(c) + '::text AS c' + j; }).join(', ');
    const rows = await db.prepare('SELECT ' + sel + ' FROM ' + qid(t) + (t === JOB_TABLE ? " WHERE status NOT IN ('done', 'failed')" : '')).all();
    (rows || []).forEach(function (row) {
      Object.keys(row).forEach(function (k) {
        const v = row[k];
        if (v == null) return;
        addKeys(refs, String(v));   // v3.2.70
      });
    });
  }
  // v3.2.70 -- open every saved book the database mentions, four at a time.
  const books = Array.from(refs).filter(function (k) { return SAVED_BOOK_RE.test(k); });
  const before = refs.size;
  let opened = 0, gone = 0, i = 0;
  const worker = async function () {
    while (i < books.length) {
      const k = books[i++];
      let buf;
      try { buf = await storage.getObject(k); } catch (e) { throw new Error('Could not open the saved book ' + k + ' (' + ((e && e.message) || e) + '), so nothing counts as unused.'); }
      if (!buf) { gone++; continue; }
      let text;
      try { text = zlib.gunzipSync(buf).toString('utf8'); } catch (e) { throw new Error('The saved book ' + k + ' could not be unpacked, so nothing counts as unused.'); }
      addKeys(refs, text); opened++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { refs: refs, tables: tables.length, savedBooks: opened, savedBooksGone: gone, savedBookKeys: refs.size - before };
}

async function unusedPictureReport(db, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const minAge = (opts.minAgeMs != null) ? opts.minAgeMs : RECENT_MS;   // v3.2.68 -- the clean-up asks for 30 days
  const prefix = opts.prefix || 'uploads/';
  const objects = await storage.listObjects(prefix);
  if (objects === null) return { error: 'This server stores pictures on its own disk, not in the bucket.' };
  const scan = await referencedKeys(db);
  const out = { env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local', prefix: prefix,
    listed: objects.length, listed_bytes: 0, tables_read: scan.tables, keys_mentioned: scan.refs.size,
    saved_books: scan.savedBooks || 0, saved_book_keys: scan.savedBookKeys || 0,   // v3.2.70
    in_use: 0, recent: 0, unused: 0, unused_bytes: 0, by_kind: {}, items: [] };
  objects.forEach(function (o) {
    out.listed_bytes += o.size || 0;
    if (scan.refs.has(o.key)) { out.in_use++; return; }
    const t = Date.parse(o.lastModified);
    if (isNaN(t) || (now - t) < minAge) { out.recent++; return; }   // v3.2.68 -- no date: treated as recent, never removed
    const k = kindOf(o.key);
    out.unused++; out.unused_bytes += o.size || 0;
    const b = out.by_kind[k] = out.by_kind[k] || { count: 0, bytes: 0 };
    b.count++; b.bytes += o.size || 0;
    out.items.push({ key: o.key, size: o.size || 0, last_modified: o.lastModified, kind: k });
  });
  out.items.sort(function (a, b) { return String(a.last_modified).localeCompare(String(b.last_modified)); });
  return out;
}

module.exports = { unusedPictureReport, referencedKeys, kindOf, KEY_RE, HISTORY_TABLES };
