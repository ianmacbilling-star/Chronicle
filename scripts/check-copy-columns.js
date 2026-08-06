#!/usr/bin/env node
// check-copy-columns.js -- run from the repo root.
//
// THE CLASS OF BUG THIS EXISTS FOR. Three were found by hand on 2026-08-06 and every one was
// silent: TD-250 (six columns missing from the session_forks copy, one of which -- narrative_verbosity
// -- changed the LENGTH of generated prose), and img_w/img_h missing from the moments copy, which
// made a branched version paginate differently from its source using identical pictures.
//
// A column-list copy fails silently when it is incomplete. Nothing errors; the row simply lacks a
// field, and the symptom surfaces weeks later somewhere else entirely. So the list is compared
// against the CREATE TABLE plus every ALTER TABLE ADD COLUMN, and anything not copied must be
// named in EXPECTED_SKIPS with a reason. Adding a column to one of these tables now fails the
// build until someone decides, in writing, whether a copy should carry it.

const fs = require('fs');

// Columns a copy deliberately does not carry, and WHY. A skip without a reason is not a skip.
const EXPECTED_SKIPS = {
  moments: {
    id: 'primary key',
    session_id: 'set explicitly by the copy',
    fork_id: 'the whole point -- the new fork owns the row',
    created_at: 'set to now',
    created_by: 'set to the caller',
    edited_at: 'a copy has never been edited',
    edited_by: 'a copy has never been edited',
    locked: 'a lock is a protection the OWNER set on THEIR panel; a new version starts editable, '
          + 'and inheriting a lock would leave someone unable to regenerate a picture in a version '
          + 'they just made, with nothing explaining why',
    revert_image: 'the one-deep undo of a retouch. A copy has no retouch history of its own, and '
                + 'carrying it would let someone revert a copy to an image that copy never had',
    revert_img_w: 'see revert_image',
    revert_img_h: 'see revert_image'
  },
  session_forks: {
    id: 'primary key',
    session_id: 'set explicitly by the copy',
    user_id: 'the new owner, set explicitly',
    role: 'decided by whether the session already has a canonical',
    name: 'the version names it',
    version_id: 'set explicitly by the copy',
    player_access_status: "forced to 'draft' -- a copy is not published by inheritance",
    narrative_style_used: 'records what was actually RUN, so a copy has not run anything',
    created_at: 'set to now',
    edited_at: 'a copy has never been edited',
    edited_by: 'a copy has never been edited'
  }
};

function tableColumns(src, table) {
  const cols = new Set();
  const re = new RegExp('CREATE TABLE IF NOT EXISTS ' + table + '\\s*\\(([\\s\\S]*?)\\n\\s*\\)', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('CREATE TABLE not found for ' + table);
  m[1].split('\n').forEach(function (line) {
    const t = line.trim();
    if (!t || /^(UNIQUE|PRIMARY|FOREIGN|CONSTRAINT|CHECK)\b/i.test(t)) return;
    const c = /^([a-z_][a-z0-9_]*)\s+/i.exec(t);
    if (c) cols.add(c[1]);
  });
  const alter = new RegExp('ALTER TABLE ' + table + " ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)", 'gi');
  let a;
  while ((a = alter.exec(src)) !== null) cols.add(a[1]);
  return cols;
}

function copyColumns(src, table) {
  // The INSERT column list of an INSERT ... SELECT against this table.
  const re = new RegExp('INSERT INTO ' + table + '\\s*\\(([^)]*)\\)[\\s\\S]{0,400}?SELECT', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(m[1].split(',').map(function (s) { return s.trim().replace(/^["`]|["`]$/g, ''); }).filter(Boolean));
  }
  return out;
}

// Paths come in as ARGUMENTS, so the apply script can check STAGED files before they are
// applied -- and because arguments to a native binary are the one place Git Bash rewrites a
// POSIX path correctly. A path baked into a script body is the trap that cost a v3.0.423 run.
const dbPath = process.argv[2] || 'database/db.js';
const sessPath = process.argv[3] || 'routes/sessions.js';
const db = fs.readFileSync(dbPath, 'utf8');
const sessions = fs.readFileSync(sessPath, 'utf8');

let fail = 0;
[['moments', sessions], ['session_forks', sessions]].forEach(function (pair) {
  const table = pair[0], src = pair[1];
  const all = tableColumns(db, table);
  const copies = copyColumns(src, table);
  if (!copies.length) {
    console.error('  FAIL no INSERT ... SELECT found for ' + table + ' -- did the copy move?');
    fail = 1;
    return;
  }
  copies.forEach(function (cols, i) {
    const have = new Set(cols);
    const skips = EXPECTED_SKIPS[table] || {};
    const missing = [];
    all.forEach(function (c) { if (!have.has(c) && !(c in skips)) missing.push(c); });
    if (missing.length) {
      console.error('  FAIL ' + table + ' copy #' + (i + 1) + ' does not carry: ' + missing.join(', '));
      console.error('       Either add them to the copy, or add them to EXPECTED_SKIPS with a reason.');
      fail = 1;
    } else {
      console.log('  ok   ' + table + ' copy #' + (i + 1) + ' carries every column (' + cols.length + ' copied, ' + Object.keys(skips).length + ' skipped by design)');
    }
  });
});

process.exit(fail);
