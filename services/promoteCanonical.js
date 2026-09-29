'use strict';
// v3.1.35 -- TD-928. PROMOTE TO CANONICAL. Spec: claude/PROMOTE_CANONICAL_SPEC.md.
//
// Ian, 2026-09-28: "I start experimenting with different styles via our versions... version 3 say is
// now my favorite. Now I want to continue on with my next session(s) using my new favorite stylings.
// I don't want to have to make a Canonical version... then remake it in a new version."
//
// So the Story Master can make one of HIS OWN versions the Canonical. His rulings, all kept here:
//   * only the Story Master's own versions; never a member's;
//   * a session the version never branched is COPIED IN from the current Canonical first (as it is),
//     so the new Canonical always covers every session;
//   * the promoted version's Story Instructions (or none) become the Canonical's;
//   * members' pins stay exactly where they are;
//   * every other version FOLLOWS THE NEW CANONICAL on the sessions it never branched -- the ordinary
//     rule. v3.1.35 froze each of them with its own copy of the old pages; Ian, 2026-09-28, after seeing
//     that it hid which sessions a member had never made their own: "take out the freezing". v3.1.36;
//   * the old Canonical is kept under a name, or deleted (with a second confirmation on the client);
//   * refused while an Optimize, a save, a render or a generation is running on the campaign.
//
// NOTHING IS COPIED FOR THE SWAP ITSELF. Canonical is two markers -- campaign_versions.is_canonical and
// session_forks.role = 'dm' -- and the pictures and prose stay on the forks they are on. What moves with
// the markers is the data that belongs to "the Canonical" rather than to a fork id:
//   sessions.art_style / session_notes / novel_include   (a named version keeps these on its fork)
//   fork_book_prefs at version 0                          (the Canonical's cover, layout and saved book)
//   bookshelf_books.prefs_version_id                      (0 = the Canonical, for bring-back)
// Orders, reorders and published stories are frozen files and are untouched by any of this.
//
// ONE TRANSACTION. The database wrapper has none of its own, so this runs on a single client
// (db.transaction, v3.1.35) and either all of it happens or none of it does.

const ACTIVE_JOB_WINDOW_MS = 20 * 60 * 1000;
const NAME_MAX = 60;
const LOCK_CLASS = 928;   // pg_advisory_xact_lock(928, campaignId): one promote per campaign at a time

function isOn(v) { return !(v === false || v === 0 || v === 'f' || v === 'false'); }
function cleanName(s) { return (typeof s === 'string') ? s.trim().slice(0, NAME_MAX) : ''; }

async function loadState(db, campaignId, versionId) {
  const X = versionId ? await db.prepare('SELECT id, campaign_id, user_id, name, is_canonical FROM campaign_versions WHERE id = ?').get(versionId) : null;
  const C = await db.prepare('SELECT id, campaign_id, user_id, name, is_canonical FROM campaign_versions WHERE campaign_id = ? AND is_canonical').get(campaignId);
  const sessions = await db.prepare('SELECT id, name, session_date, created_at FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC, created_at ASC, id ASC').all(campaignId);
  const forks = await db.prepare(
    'SELECT f.id, f.session_id, f.user_id, f.role, f.version_id, f.player_access_status FROM session_forks f JOIN sessions s ON s.id = f.session_id WHERE s.campaign_id = ?'
  ).all(campaignId);
  const versions = await db.prepare('SELECT id, user_id, name, is_canonical FROM campaign_versions WHERE campaign_id = ? ORDER BY id ASC').all(campaignId);
  return { X: X, C: C, sessions: sessions || [], forks: forks || [], versions: versions || [] };
}

// Queued or running generation for this campaign, from the job tables. A job that has not moved in
// ACTIVE_JOB_WINDOW_MS is not counted: a crashed worker must not lock the Story Master out forever.
async function jobsInFlight(db, campaignId) {
  const cutoff = new Date(Date.now() - ACTIVE_JOB_WINDOW_MS).toISOString();
  const checks = [
    ['image_jobs', "('queued','processing')", 'Picture generation'],
    ['narrative_jobs', "('pending','running')", 'Generate Narrative'],
    ['extract_jobs', "('pending','running')", 'Generate Story']
  ];
  for (let i = 0; i < checks.length; i++) {
    const r = await db.prepare(
      'SELECT 1 AS x FROM ' + checks[i][0] + ' WHERE campaign_id = ? AND status IN ' + checks[i][1] + ' AND COALESCE(updated_at, created_at) > ? LIMIT 1'
    ).get(campaignId, cutoff);
    if (r) return checks[i][2];
  }
  return null;
}

// THE CHECK. Read-only, and the POST runs it again before it changes anything.
async function promoteCheck(db, campaignId, versionId, userId, deps) {
  deps = deps || {};
  const out = { ok: false, reason: '', code: '' };
  const mem = await db.prepare('SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?').get(campaignId, userId);
  if (!mem || mem.role !== 'dm') { out.code = 'not_sm'; out.reason = 'Only the Story Master can choose the Canonical.'; return out; }
  const st = await loadState(db, campaignId, versionId);
  const X = st.X, C = st.C;
  if (!X || String(X.campaign_id) !== String(campaignId)) { out.code = 'not_found'; out.reason = 'That version is not in this campaign.'; return out; }
  if (X.is_canonical) { out.code = 'already'; out.reason = '\u201c' + X.name + '\u201d is already the Canonical.'; return out; }
  if (String(X.user_id) !== String(userId)) { out.code = 'not_yours'; out.reason = 'Only one of your own versions can be made the Canonical.'; return out; }
  if (!C) { out.code = 'no_canonical'; out.reason = 'This campaign has no Canonical yet.'; return out; }
  out.version = { id: X.id, name: X.name };
  out.canonical = { id: C.id, name: C.name };

  // THE TWO MARKERS MUST AGREE BEFORE THEY ARE MOVED. Every session has exactly one 'dm' fork and it is
  // in the Canonical version; every fork in the Canonical version is 'dm'; every fork of the promoted
  // version is an ordinary fork of the Story Master's. A Story Master handover flips role without
  // touching version_id (invites.js), so this is not hypothetical -- and swapping markers that already
  // disagree would make it worse, not better. Refused, never repaired here.
  const bySession = {};
  st.sessions.forEach(function (s) { bySession[s.id] = { s: s, dm: [], x: null }; });
  let bad = '';
  st.forks.forEach(function (f) {
    const b = bySession[f.session_id];
    if (!b) return;
    if (f.role === 'dm') b.dm.push(f);
    if (String(f.version_id) === String(X.id)) b.x = f;
    if (String(f.version_id) === String(C.id) && f.role !== 'dm') bad = bad || 'a Canonical session is marked as an ordinary version';
    if (String(f.version_id) === String(X.id) && (f.role !== 'player' || String(f.user_id) !== String(userId))) bad = bad || 'the version has a session that is not an ordinary copy of yours';
  });
  st.sessions.forEach(function (s) {
    const b = bySession[s.id];
    if (b.dm.length !== 1) bad = bad || ('\u201c' + (s.name || 'a session') + '\u201d has no single Canonical copy');
    else if (String(b.dm[0].version_id) !== String(C.id)) bad = bad || ('\u201c' + (s.name || 'a session') + '\u201d has a Canonical copy outside the Canonical version');
  });
  if (bad) { out.code = 'markers'; out.reason = 'This campaign\u2019s versions need a repair before the Canonical can be changed (' + bad + '). Nothing was changed; please contact support.'; return out; }

  out.missing = [];
  out.drafts = [];
  st.sessions.forEach(function (s) {
    const b = bySession[s.id];
    if (!b.x) out.missing.push({ id: s.id, name: s.name || '' });
    // v3.1.41 -- EVERY session that will be Draft once this version is the Canonical, not only the ones
    // that were Ready before (tester: a version whose sessions were all Draft promoted with no warning,
    // and members saw nothing). A missing session is copied in with the current Canonical's status.
    const willBe = b.x ? b.x.player_access_status : b.dm[0].player_access_status;
    if (willBe !== 'ready') out.drafts.push({ id: s.id, name: s.name || '' });
  });
  out.session_count = st.sessions.length;


  // Who else is using the current Canonical, for the delete choice.
  const pins = await db.prepare('SELECT COUNT(*)::int AS n FROM campaign_members WHERE campaign_id = ? AND default_version_id = ? AND user_id <> ?').get(campaignId, C.id, userId);
  const saved = await db.prepare(
    "SELECT COUNT(*)::int AS n FROM fork_book_prefs WHERE campaign_id = ? AND fork_user_id = ? AND version_id = 0 AND chooser_user_id <> ? AND prefs LIKE '%lastOptimized%'"
  ).get(campaignId, userId, userId);
  const shelved = await db.prepare(
    'SELECT COUNT(*)::int AS n FROM bookshelf_books WHERE campaign_id = ? AND user_id <> ? AND (version_id = ? OR (version_id IS NULL AND COALESCE(prefs_version_id, 0) = 0))'
  ).get(campaignId, userId, C.id);
  out.others_using = { pins: pins ? pins.n : 0, saved_layouts: saved ? saved.n : 0, shelved: shelved ? shelved.n : 0 };

  out.taken_names = st.versions.filter(function (v) { return !v.is_canonical && String(v.user_id) === String(userId); }).map(function (v) { return v.name; });
  out.suggested_name = (C.name && C.name !== 'Canonical' && out.taken_names.indexOf(C.name) === -1) ? C.name : 'Original';
  if (out.taken_names.indexOf(out.suggested_name) !== -1) out.suggested_name = '';

  let busy = null;
  try {
    const members = await db.prepare('SELECT user_id FROM campaign_members WHERE campaign_id = ?').all(campaignId);
    busy = deps.inFlight ? deps.inFlight(campaignId, (members || []).map(function (m) { return m.user_id; })) : null;
  } catch (e) { busy = 'Work'; }
  if (!busy) busy = await jobsInFlight(db, campaignId);
  if (busy) { out.code = 'busy'; out.reason = busy + ' is running on this campaign. Let it finish, then try again.'; out.busy = busy; return out; }

  out.ok = true;
  return out;
}

async function tableColumns(tx, table) {
  const r = await tx.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table]);
  return r.rows.map(function (x) { return x.column_name; });
}
function q(c) { return '"' + String(c).replace(/"/g, '') + '"'; }

// A VERBATIM COPY of one fork into another version: the fork row, its panels, its characters and each
// panel's explicit cast and assets. Every column is copied (read from the table, not listed by hand), so
// a column added later can never be silently dropped -- the failure the branch route's comments record
// three times. Pictures are shared by URL; releaseImage counts references, so nothing is lost when either
// copy is later deleted.
async function copyFork(tx, cols, srcForkId, target) {
  const skipF = { id: 1, session_id: 1, user_id: 1, role: 1, name: 1, version_id: 1, player_access_status: 1, created_at: 1 };
  const fc = cols.forks.filter(function (c) { return !skipF[c]; });
  const ins = await tx.query(
    'INSERT INTO session_forks (session_id, user_id, role, name, version_id, player_access_status, created_at' + (fc.length ? ', ' + fc.map(q).join(', ') : '') + ') ' +
    'SELECT session_id, $1, $2, $3, $4, $5, $6' + (fc.length ? ', ' + fc.map(q).join(', ') : '') + ' FROM session_forks WHERE id = $7 RETURNING id',
    [target.user_id, target.role, target.name, target.version_id, target.status, new Date().toISOString(), srcForkId]
  );
  const newId = ins.rows[0].id;
  // What the Canonical kept on the SESSION row belongs to this copy now: its art style and its Story
  // Instructions. Frozen here so the copy reads exactly what the Canonical read.
  await tx.query(
    "UPDATE session_forks SET art_style_override = COALESCE(NULLIF(art_style_override, ''), (SELECT s.art_style FROM sessions s WHERE s.id = session_forks.session_id)), " +
    'fork_notes = (SELECT s.session_notes FROM sessions s WHERE s.id = session_forks.session_id) WHERE id = $1', [newId]
  );
  const mc = cols.moments.filter(function (c) { return c !== 'id' && c !== 'fork_id'; });
  await tx.query('INSERT INTO moments (fork_id, ' + mc.map(q).join(', ') + ') SELECT $1, ' + mc.map(q).join(', ') + ' FROM moments WHERE fork_id = $2 ORDER BY panel_order ASC, id ASC', [newId, srcForkId]);
  const cc = cols.chars.filter(function (c) { return c !== 'id' && c !== 'fork_id'; });
  await tx.query('INSERT INTO session_characters (fork_id, ' + cc.map(q).join(', ') + ') SELECT $1, ' + cc.map(q).join(', ') + ' FROM session_characters WHERE fork_id = $2', [newId, srcForkId]);
  await tx.query(
    'INSERT INTO moment_characters (moment_id, character_id) SELECT nm.id, mc.character_id FROM moment_characters mc ' +
    'JOIN moments om ON om.id = mc.moment_id JOIN moments nm ON nm.fork_id = $1 AND nm.panel_order = om.panel_order WHERE om.fork_id = $2 ON CONFLICT DO NOTHING', [newId, srcForkId]
  );
  await tx.query(
    'INSERT INTO moment_assets (moment_id, asset_id) SELECT nm.id, ma.asset_id FROM moment_assets ma ' +
    'JOIN moments om ON om.id = ma.moment_id JOIN moments nm ON nm.fork_id = $1 AND nm.panel_order = om.panel_order WHERE om.fork_id = $2 ON CONFLICT DO NOTHING', [newId, srcForkId]
  );
  return newId;
}

function stripSaved(prefsText) {
  let p = {};
  try { p = JSON.parse(prefsText || '{}') || {}; } catch (e) { p = {}; }
  delete p.lastOptimized;
  return JSON.stringify(p);
}

// THE PROMOTE. opts: { new_name, delete_old }. deps: { inFlight, releaseImage, deleteFile, forgetCaches,
// versionStyleDefaults, versionPriorCharacterLooks }. Returns { status, body }.
async function promoteRun(db, campaignId, versionId, userId, opts, deps) {
  opts = opts || {}; deps = deps || {};
  const chk = await promoteCheck(db, campaignId, versionId, userId, deps);
  if (!chk.ok) return { status: chk.code === 'busy' ? 409 : (chk.code === 'not_sm' || chk.code === 'not_yours' ? 403 : 400), body: { error: chk.reason, code: chk.code } };
  const deleteOld = !!opts.delete_old;
  let newName = cleanName(opts.new_name);
  if (!deleteOld) {
    if (!newName) return { status: 400, body: { error: 'Please give your current Canonical a name.', code: 'name' } };
    if (newName.toLowerCase() === 'canonical') return { status: 400, body: { error: 'Please choose a name other than \u201cCanonical\u201d.', code: 'name' } };
    if (chk.taken_names.indexOf(newName) !== -1) return { status: 409, body: { error: 'You already have a version called \u201c' + newName + '\u201d.', code: 'name' } };
  } else {
    newName = '(removed) ' + chk.canonical.id;   // never seen: the row is deleted in the same transaction
  }
  const X = chk.version, C = chk.canonical;
  const st = await loadState(db, campaignId, versionId);
  const cFork = {}, xFork = {};
  st.forks.forEach(function (f) {
    if (String(f.version_id) === String(C.id)) cFork[f.session_id] = f;
    if (String(f.version_id) === String(X.id)) xFork[f.session_id] = f;
  });
  // Style values resolved BEFORE the transaction: these helpers read through the pool.
  const xStyle = {}, xLooks = {};
  for (let i = 0; i < st.sessions.length; i++) {
    const sid = st.sessions[i].id;
    if (!xFork[sid]) {
      try { xStyle[sid] = deps.versionStyleDefaults ? await deps.versionStyleDefaults(db, X.id, sid) : {}; } catch (e) { xStyle[sid] = {}; }
      try { xLooks[sid] = deps.versionPriorCharacterLooks ? await deps.versionPriorCharacterLooks(db, X.id, sid) : {}; } catch (e) { xLooks[sid] = {}; }
    }
  }
  const STYLE_KEYS = ['narrative_style', 'narrative_verbosity', 'narrative_narrator', 'illustrate_mode'];
  const release = [], dropFiles = [];
  let copiedMissing = 0;

  await db.transaction(async function (tx) {
    await tx.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LOCK_CLASS, Number(campaignId)]);
    // Re-read under the lock: a second promote that won the race has already moved the markers.
    const cNow = await tx.query('SELECT id FROM campaign_versions WHERE campaign_id = $1 AND is_canonical FOR UPDATE', [campaignId]);
    const xNow = await tx.query('SELECT id, is_canonical FROM campaign_versions WHERE id = $1 FOR UPDATE', [X.id]);
    if (!cNow.rows[0] || String(cNow.rows[0].id) !== String(C.id) || !xNow.rows[0] || xNow.rows[0].is_canonical) {
      throw Object.assign(new Error('The Canonical changed while this was being set up. Nothing was changed; please try again.'), { status: 409 });
    }
    const cols = { forks: await tableColumns(tx, 'session_forks'), moments: await tableColumns(tx, 'moments'), chars: await tableColumns(tx, 'session_characters') };

    // 1. OTHER VERSIONS ARE NOT TOUCHED. On a session they never branched they read the Canonical, which
    //    from the commit on is the promoted version -- the same rule as any other day (v3.1.36).
    // 2. THE PROMOTED VERSION GETS EVERY SESSION. A session it never branched is copied in from the
    //    Canonical as it is (Ian: regenerate it later if you want it in the new style), wearing the
    //    version's own styles and character looks the way "add this session to a version" does.
    for (let k = 0; k < st.sessions.length; k++) {
      const sid = st.sessions[k].id;
      if (xFork[sid] || !cFork[sid]) continue;
      const nid = await copyFork(tx, cols, cFork[sid].id, { user_id: userId, role: 'player', name: X.name, version_id: X.id, status: cFork[sid].player_access_status });
      const sets = [], vals = [];
      ['art_style_override'].concat(STYLE_KEYS).forEach(function (key) { if (xStyle[sid] && xStyle[sid][key]) { sets.push(key + ' = $' + (vals.length + 1)); vals.push(xStyle[sid][key]); } });
      if (sets.length) { vals.push(nid); await tx.query('UPDATE session_forks SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals); }
      const looks = xLooks[sid] || {};
      const ids = Object.keys(looks);
      for (let j = 0; j < ids.length; j++) {
        const l = looks[ids[j]] || {};
        if (l.reference_url) await tx.query('UPDATE session_characters SET reference_url = $1 WHERE fork_id = $2 AND character_id = $3', [l.reference_url, nid, ids[j]]);
        if (l.prompt) await tx.query('UPDATE session_characters SET prompt = $1 WHERE fork_id = $2 AND character_id = $3', [l.prompt, nid, ids[j]]);
      }
      copiedMissing++;
    }

    // 3. THE MARKERS. Demote first: both unique indexes are checked row by row.
    await tx.query('UPDATE campaign_versions SET is_canonical = false, user_id = $1, name = $2, edited_at = CURRENT_TIMESTAMP WHERE id = $3', [userId, newName, C.id]);
    await tx.query('UPDATE campaign_versions SET is_canonical = true, user_id = NULL, edited_at = CURRENT_TIMESTAMP WHERE id = $1', [X.id]);
    // The old Canonical's forks take the session-row art style and Story Instructions they were using.
    await tx.query(
      "UPDATE session_forks SET role = 'player', user_id = $1, name = $2, " +
      "art_style_override = COALESCE(NULLIF(art_style_override, ''), (SELECT s.art_style FROM sessions s WHERE s.id = session_forks.session_id)), " +
      'fork_notes = (SELECT s.session_notes FROM sessions s WHERE s.id = session_forks.session_id) WHERE version_id = $3',
      [userId, newName, C.id]
    );
    await tx.query("UPDATE session_forks SET role = 'dm' WHERE version_id = $1", [X.id]);

    // 4. THE SESSION ROW NOW DESCRIBES THE NEW CANONICAL. Its art style is whatever the promoted version
    //    showed there; its Story Instructions are the version's own, or none (Ian: "whatever
    //    instructions (or no instructions) are in the instruction field on the new version become the
    //    canonical instructions"). The fork's override is cleared, or it would shadow every later change
    //    the Story Master makes to the Canonical's art style.
    await tx.query(
      "UPDATE sessions s SET art_style = COALESCE(NULLIF(xf.art_style_override, ''), s.art_style), session_notes = COALESCE(xf.fork_notes, '') " +
      'FROM session_forks xf WHERE xf.session_id = s.id AND xf.version_id = $1 AND s.campaign_id = $2',
      [X.id, campaignId]
    );
    await tx.query('UPDATE session_forks SET art_style_override = NULL WHERE version_id = $1', [X.id]);

    // 5. WHICH SESSIONS ARE IN THE BOOK. The Canonical keeps this on sessions.novel_include; a named
    //    version in session_includes, falling back to the owner's base rows, then "in".
    await tx.query(
      'INSERT INTO session_includes (user_id, session_id, include, version_id, created_at) ' +
      'SELECT $1, s.id, COALESCE(s.novel_include, true), $2, CURRENT_TIMESTAMP FROM sessions s WHERE s.campaign_id = $3 ' +
      'ON CONFLICT (user_id, session_id, version_id) DO UPDATE SET include = EXCLUDED.include, edited_at = CURRENT_TIMESTAMP',
      [userId, C.id, campaignId]
    );
    await tx.query(
      'UPDATE sessions s SET novel_include = COALESCE(' +
      '(SELECT i.include FROM session_includes i WHERE i.user_id = $1 AND i.session_id = s.id AND i.version_id = $2), ' +
      '(SELECT i.include FROM session_includes i WHERE i.user_id = $1 AND i.session_id = s.id AND i.version_id = 0), true) WHERE s.campaign_id = $3',
      [userId, X.id, campaignId]
    );
    await tx.query('DELETE FROM session_includes WHERE user_id = $1 AND version_id = $2', [userId, X.id]);

    // 6. BOOK PREFS: cover, title, layout and saved books. Version 0 IS the Canonical. The Story
    //    Master's other versions that have no prefs of their own read version 0, so they follow the new
    //    Canonical's cover and layout, like their sessions (v3.1.36 -- no longer frozen).
    //    Rows at the old Canonical's own id cannot have been read (the Canonical always maps to 0), so
    //    they are cleared out of the way of the move.
    await tx.query('DELETE FROM fork_book_prefs WHERE campaign_id = $1 AND fork_user_id = $2 AND version_id = $3', [campaignId, userId, C.id]);
    const base = await tx.query('SELECT prefs FROM fork_book_prefs WHERE chooser_user_id = $1 AND fork_user_id = $1 AND campaign_id = $2 AND version_id = 0', [userId, campaignId]);
    const baseRow = base.rows[0] || null;
    await tx.query('UPDATE fork_book_prefs SET version_id = $1 WHERE campaign_id = $2 AND fork_user_id = $3 AND version_id = 0', [-Number(C.id), campaignId, userId]);
    await tx.query('UPDATE fork_book_prefs SET version_id = 0 WHERE campaign_id = $1 AND fork_user_id = $2 AND version_id = $3', [campaignId, userId, X.id]);
    await tx.query('UPDATE fork_book_prefs SET version_id = $1 WHERE campaign_id = $2 AND fork_user_id = $3 AND version_id = $4', [C.id, campaignId, userId, -Number(C.id)]);
    // A promoted version with no prefs row of its own was showing the Canonical's cover and layout
    // through the read-time fallback. Keep showing it: seed its row from what it was reading.
    const newBase = await tx.query('SELECT 1 FROM fork_book_prefs WHERE chooser_user_id = $1 AND fork_user_id = $1 AND campaign_id = $2 AND version_id = 0', [userId, campaignId]);
    if (!newBase.rows[0] && baseRow) {
      await tx.query(
        'INSERT INTO fork_book_prefs (chooser_user_id, fork_user_id, campaign_id, version_id, prefs, updated_at) VALUES ($1, $1, $2, 0, $3, CURRENT_TIMESTAMP)',
        [userId, campaignId, stripSaved(baseRow.prefs)]
      );
    }

    // 7. BOOKSHELF: prefs_version_id 0 means "the Canonical" to bring-back. Books shelved from the old
    //    Canonical now belong to it by id; books shelved from the promoted version are the Canonical's.
    await tx.query('UPDATE bookshelf_books SET version_id = $1, prefs_version_id = $1 WHERE campaign_id = $2 AND version_id IS NULL AND COALESCE(prefs_version_id, 0) = 0', [C.id, campaignId]);
    await tx.query('UPDATE bookshelf_books SET prefs_version_id = $1 WHERE campaign_id = $2 AND version_id = $1', [C.id, campaignId]);
    await tx.query('UPDATE bookshelf_books SET prefs_version_id = 0 WHERE campaign_id = $1 AND version_id = $2', [campaignId, X.id]);

    // 8. DELETE THE OLD CANONICAL, if that was the choice. Forks go before the version row: ON DELETE SET
    //    NULL would orphan them and the boot backfill would bring the version back. Files are released
    //    after the commit, by reference count, so pictures now shared with other versions stay.
    if (deleteOld) {
      const cf = await tx.query('SELECT id FROM session_forks WHERE version_id = $1', [C.id]);
      const ids = cf.rows.map(function (r) { return r.id; });
      if (ids.length) {
        const mi = await tx.query('SELECT image FROM moments WHERE fork_id = ANY($1::int[])', [ids]);
        mi.rows.forEach(function (r) { if (r.image) release.push(r.image); });
        const ri = await tx.query('SELECT reference_url FROM session_characters WHERE fork_id = ANY($1::int[])', [ids]);
        ri.rows.forEach(function (r) { if (r.reference_url) release.push(r.reference_url); });
        await tx.query('DELETE FROM moments WHERE fork_id = ANY($1::int[])', [ids]);
        await tx.query('DELETE FROM session_characters WHERE fork_id = ANY($1::int[])', [ids]);
        await tx.query('DELETE FROM session_forks WHERE id = ANY($1::int[])', [ids]);
      }
      const pr = await tx.query('SELECT prefs FROM fork_book_prefs WHERE campaign_id = $1 AND version_id = $2', [campaignId, C.id]);
      pr.rows.forEach(function (r) {
        let lo = null;
        try { lo = (JSON.parse(r.prefs) || {}).lastOptimized || null; } catch (e) { lo = null; }
        if (!lo) return;
        Object.keys(lo).forEach(function (k) { if (lo[k] && lo[k].pdfUrl) dropFiles.push(lo[k].pdfUrl); if (lo[k] && lo[k].bodyUrl) dropFiles.push(lo[k].bodyUrl); });
      });
      await tx.query('DELETE FROM fork_book_prefs WHERE campaign_id = $1 AND version_id = $2', [campaignId, C.id]);
      await tx.query('DELETE FROM session_includes WHERE version_id = $1', [C.id]);
      await tx.query('UPDATE campaign_members SET default_version_id = NULL WHERE default_version_id = $1', [C.id]);
      await tx.query('DELETE FROM campaign_versions WHERE id = $1 AND NOT is_canonical', [C.id]);
    }
  });

  // AFTER THE COMMIT. The composed-book caches are keyed without the version for a Canonical request,
  // so they are cleared rather than trusted; then the old Canonical's files, if it was deleted.
  try { if (deps.forgetCaches) deps.forgetCaches(campaignId); } catch (e) { console.error('[promote] cache clear failed: ' + ((e && e.message) || e)); }
  const seen = {};
  for (let i = 0; i < release.length; i++) {
    if (seen[release[i]]) continue; seen[release[i]] = 1;
    try { if (deps.releaseImage) await deps.releaseImage(db, release[i]); } catch (e) {}
  }
  for (let i = 0; i < dropFiles.length; i++) {
    if (seen[dropFiles[i]]) continue; seen[dropFiles[i]] = 1;
    try { if (deps.deleteFile) await deps.deleteFile(dropFiles[i]); } catch (e) { console.error('[promote] saved book file left in place: ' + ((e && e.message) || e)); }
  }
  console.log('[promote] campaign ' + campaignId + ': version ' + X.id + ' is the Canonical; old ' + C.id + (deleteOld ? ' deleted' : ' kept as "' + newName + '"') +
    '; copied ' + copiedMissing + ' missing session(s)');
  return { status: 200, body: {
    success: true,
    canonical: { id: X.id, name: X.name },
    old: deleteOld ? null : { id: C.id, name: newName },
    deleted_old: deleteOld,
    copied_missing: copiedMissing
  } };
}

module.exports = { promoteCheck: promoteCheck, promoteRun: promoteRun, jobsInFlight: jobsInFlight };
