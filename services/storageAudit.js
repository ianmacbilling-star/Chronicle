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
'use strict';
const storage = require('../storage/storage');
const KEY_RE = /(?:uploads|archives|optimized|print|story)\/[A-Za-z0-9._\-]+/g;
const RECENT_MS = 24 * 60 * 60 * 1000;

function kindOf(key) {
  const name = String(key).replace(/^[^/]*\//, '');
  const m = name.match(/^(gen|rest|arch)-\d+-/);
  return m ? m[1] : 'other';
}
function qid(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

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
    const sel = byTable[t].map(function (c, j) { return qid(c) + '::text AS c' + j; }).join(', ');
    const rows = await db.prepare('SELECT ' + sel + ' FROM ' + qid(t)).all();
    (rows || []).forEach(function (row) {
      Object.keys(row).forEach(function (k) {
        const v = row[k];
        if (v == null) return;
        const s = String(v);
        if (s.indexOf('/') < 0) return;
        const m = s.match(KEY_RE);
        if (m) m.forEach(function (key) { refs.add(key); });
      });
    });
  }
  return { refs: refs, tables: tables.length };
}

async function unusedPictureReport(db, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const prefix = opts.prefix || 'uploads/';
  const objects = await storage.listObjects(prefix);
  if (objects === null) return { error: 'This server stores pictures on its own disk, not in the bucket.' };
  const scan = await referencedKeys(db);
  const out = { env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local', prefix: prefix,
    listed: objects.length, listed_bytes: 0, tables_read: scan.tables, keys_mentioned: scan.refs.size,
    in_use: 0, recent: 0, unused: 0, unused_bytes: 0, by_kind: {}, items: [] };
  objects.forEach(function (o) {
    out.listed_bytes += o.size || 0;
    if (scan.refs.has(o.key)) { out.in_use++; return; }
    const t = Date.parse(o.lastModified);
    if (!isNaN(t) && (now - t) < RECENT_MS) { out.recent++; return; }
    const k = kindOf(o.key);
    out.unused++; out.unused_bytes += o.size || 0;
    const b = out.by_kind[k] = out.by_kind[k] || { count: 0, bytes: 0 };
    b.count++; b.bytes += o.size || 0;
    out.items.push({ key: o.key, size: o.size || 0, last_modified: o.lastModified, kind: k });
  });
  out.items.sort(function (a, b) { return String(a.last_modified).localeCompare(String(b.last_modified)); });
  return out;
}

module.exports = { unusedPictureReport, referencedKeys, kindOf, KEY_RE };
