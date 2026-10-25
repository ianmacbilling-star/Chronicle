// v3.2.67 -- TD-1006. STAGING MOVES TO ITS OWN BUCKET (Ian, 2026-10-24: "we do staging").
// Staging and production shared one bucket (chronicle-images) with separate databases, and shared only about 15
// pictures, so a clean-up on either would have deleted the other's pictures. Production stays where it is. Staging
// gets its own bucket through Railway settings, and this one-time tool, run FROM STAGING, does the move:
//   1. COPY: every storage key staging's database mentions (the same full scan as the unused-picture report) is
//      copied from the shared bucket into staging's own bucket under the same key, inside R2. Nothing is deleted.
//   2. REWRITE: only after a copy pass with no failures, every stored address under one of the OLD public addresses
//      (R2_LEGACY_PUBLIC_URLS) is rewritten to staging's new one (R2_PUBLIC_URL), in every text and JSON column.
// Both steps can be run again safely. It refuses to run unless R2_BUCKET and R2_SHARED_BUCKET are both set and
// differ, so on production (neither set) it cannot do anything.
'use strict';
const storage = require('../storage/storage');
const audit = require('./storageAudit');

const S = { running: false, phase: null, total: 0, done: 0, copied: 0, missing: [], failed: [], startedAt: null, finishedAt: null, copyClean: false, rewrite: null, error: null };

function config() {
  const own = storage.bucketName();
  const shared = String(process.env.R2_SHARED_BUCKET || '').trim();
  const explicit = !!String(process.env.R2_BUCKET || '').trim();
  const bases = storage.r2PublicBases();
  const cur = String(process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const legacy = bases.filter(function (b) { return b !== cur; });
  const problems = [];
  if (!explicit) problems.push('R2_BUCKET is not set (this environment is still on the shared bucket).');
  if (!shared) problems.push('R2_SHARED_BUCKET is not set.');
  if (shared && shared === own) problems.push('R2_SHARED_BUCKET is this environment\'s own bucket.');
  if (!cur) problems.push('R2_PUBLIC_URL is not set.');
  if (!legacy.length) problems.push('R2_LEGACY_PUBLIC_URLS lists no old address to rewrite from.');
  return { env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local', own: own, shared: shared, publicUrl: cur, legacy: legacy, ready: problems.length === 0, problems: problems };
}
function status() { return Object.assign({ config: config() }, S, { missing: S.missing.slice(0, 50), missingCount: S.missing.length, failed: S.failed.slice(0, 50), failedCount: S.failed.length }); }

async function runCopy(db) {
  const c = config();
  if (!c.ready) throw new Error('Not set up: ' + c.problems.join(' '));
  if (S.running) throw new Error('Already running.');
  Object.assign(S, { running: true, phase: 'scanning', total: 0, done: 0, copied: 0, missing: [], failed: [], startedAt: new Date().toISOString(), finishedAt: null, copyClean: false, error: null });
  (async function () {
    try {
      const scan = await audit.referencedKeys(db);
      const keys = Array.from(scan.refs).sort();
      S.total = keys.length; S.phase = 'copying';
      let i = 0;
      const worker = async function () {
        while (i < keys.length) {
          const k = keys[i++];
          try { const r = await storage.copyFromBucket(c.shared, k); if (r === 'missing') S.missing.push(k); else S.copied++; }
          catch (e) { S.failed.push(k + ': ' + ((e && e.message) || 'error')); }
          S.done++;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      S.copyClean = S.failed.length === 0;
      S.phase = 'copied';
    } catch (e) { S.error = (e && e.message) || String(e); S.phase = 'error'; }
    finally { S.running = false; S.finishedAt = new Date().toISOString(); }
  })();
  return status();
}

function textType(dt, udt) {
  if (dt === 'text' || dt === 'character varying') return { read: function (c) { return c; }, cast: '' };
  if (dt === 'json') return { read: function (c) { return c + '::text'; }, cast: '::json' };
  if (dt === 'jsonb') return { read: function (c) { return c + '::text'; }, cast: '::jsonb' };
  return null;
}
function qid(n) { return '"' + String(n).replace(/"/g, '""') + '"'; }

async function runRewrite(db) {
  const c = config();
  if (!c.ready) throw new Error('Not set up: ' + c.problems.join(' '));
  if (S.running) throw new Error('Something is still running.');
  if (!S.copyClean) throw new Error('Run Copy first, and only rewrite after a copy with no failures.');
  const cols = await db.prepare(
    "SELECT c.table_name, c.column_name, c.data_type, c.udt_name FROM information_schema.columns c JOIN information_schema.tables t " +
    "ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' " +
    "AND c.data_type IN ('text', 'character varying', 'json', 'jsonb') ORDER BY c.table_name, c.column_name"
  ).all();
  const out = { rows: 0, byColumn: {} };
  for (let i = 0; i < (cols || []).length; i++) {
    const col = cols[i];
    const tt = textType(col.data_type, col.udt_name); if (!tt) continue;
    const C = qid(col.column_name), Tn = qid(col.table_name);
    for (let j = 0; j < c.legacy.length; j++) {
      const from = c.legacy[j] + '/', to = c.publicUrl + '/';
      const r = await db.prepare('UPDATE ' + Tn + ' SET ' + C + ' = replace(' + tt.read(C) + ', ?, ?)' + tt.cast + ' WHERE strpos(' + tt.read(C) + ', ?) > 0').run(from, to, from);
      const n = (r && r.changes) || 0;
      if (n) { out.rows += n; out.byColumn[col.table_name + '.' + col.column_name] = (out.byColumn[col.table_name + '.' + col.column_name] || 0) + n; }
    }
  }
  S.rewrite = Object.assign({ at: new Date().toISOString() }, out);
  return status();
}

module.exports = { config, status, runCopy, runRewrite };
