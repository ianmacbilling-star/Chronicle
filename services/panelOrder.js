'use strict';
// =====================================================================================================
// v3.4.32 -- TD-1107. MOVING AND DELETING STORY PANELS, AND EVERYTHING THAT BELONGS TO THEM.
//
// Ian, 2026-11-05: testers "want to reorder or delete the story panels... sometimes the AI gets things out of order
// or repeats something", without Generate Story again. And: "couldn't we put some shared identifier on text so they
// are linked with a reference id... that way you move panel 5... both text and image panel 5 go together".
//
// WHAT IS KEYED BY POSITION, AND SO MUST MOVE WITH A PANEL (measured in the v3.4.31 code):
//   moments.panel_order                          -- the order itself; read everywhere as the 0-based index
//   session_forks.narrative_sections             -- one block per panel BY POSITION: { panel_index, before (the
//                                                   panel's Moment text), after (its Bridge to the next), summaries }
//   session_forks.narrative_directions/outlines  -- maps keyed 'moment:i' and 'between:i' (and opening / closing)
//   session_characters.change_moment_index       -- "this character looks different from panel i on"
// The opening and closing text belong to the session, not a panel, and never move.
//
// THE RULES (Ian): the title picture stays first; a locked panel can be neither moved nor deleted and keeps its place
// (others move around it); every session, Draft or Ready; only on your own version (the same rule as editing a
// panel). A panel's Bridge travels with it; any Bridge whose next panel changed is marked bridge_stale, for the page
// to say so. A moved character-change panel takes its marker along; a deleted one passes it to the panel after.
// Everything happens in ONE transaction: the panels and their text can never be left half moved.
//
// THE LINK BY ID: every block of text carries its panel's id (moment_id). Positions still line them up, so every
// reader (the page, the PDF, saved books) is unchanged; the id lets a write put them back in step if they ever drift.
// =====================================================================================================

const JOB_WINDOW_MS = 20 * 60 * 1000;   // the narrative route's own window for a run still going

function parseJson(s, dflt) {
  if (s == null || s === '') return dflt;
  if (typeof s === 'object') return s;
  try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; }
}

// The text blocks in the order of momentIds, each stamped with its panel's id and position. By id when every block
// already carries one and they are exactly this version's panels; otherwise by position when the counts agree
// (text written before the ids, or copied from another version, whose panels have other ids). null when neither.
function alignSections(sections, momentIds) {
  const secs = Array.isArray(sections) ? sections : [];
  if (!secs.length) return [];
  const ids = momentIds.map(String);
  const byId = {};
  let allIds = true;
  secs.forEach(function (s) { if (s && s.moment_id != null && byId[String(s.moment_id)] === undefined) byId[String(s.moment_id)] = s; else allIds = false; });
  let ordered = null;
  // v3.4.33 -- by id even when the text also holds a panel that is gone (a save from a page that had not reloaded
  // after a delete): the deleted panel's block is dropped and the rest are put back against their own panels.
  if (allIds && ids.every(function (id) { return byId[id] !== undefined; })) {
    ordered = ids.map(function (id) { return byId[id]; });
  } else if (secs.length === ids.length) {
    ordered = secs.slice();
  } else {
    return null;
  }
  return ordered.map(function (s, i) { return Object.assign({}, s || {}, { panel_index: i, moment_id: Number(momentIds[i]) }); });
}

// Text as saved by a write path: lined up and stamped when it can be; left exactly as given when it cannot.
function stampSections(sections, momentIds) {
  const a = alignSections(sections, momentIds);
  return a === null ? (Array.isArray(sections) ? sections : []) : a;
}

// 'moment:i' / 'between:i' keys follow their panel; a deleted panel's are dropped; anything else is kept.
function remapKeys(map, oldToNew) {
  const out = {};
  Object.keys(map || {}).forEach(function (k) {
    const m = /^(moment|between):(\d+)$/.exec(k);
    if (!m) { out[k] = map[k]; return; }
    const ni = oldToNew[Number(m[2])];
    if (ni === undefined || ni === null) return;
    out[m[1] + ':' + ni] = map[k];
  });
  return out;
}

function fail(code, message, status) { const e = new Error(message); e.code = code; e.status = status || 409; return e; }

// The new order and what moved, checked against the rules. oldIds: the version's panels as they stand.
function planOrder(moments, newIds, deleteId) {
  const oldIds = moments.map(function (m) { return Number(m.id); });
  if (deleteId != null) {
    const d = moments.find(function (m) { return Number(m.id) === Number(deleteId); });
    if (!d) throw fail('NOT_FOUND', 'That panel is not in this version.', 404);
    if (d.kind === 'establishing') throw fail('TITLE', 'The title picture cannot be deleted.', 403);
    if (d.locked) throw fail('LOCKED', 'This panel is locked. Unlock it first.', 403);
    return { oldIds: oldIds, newIds: oldIds.filter(function (id) { return id !== Number(deleteId); }) };
  }
  const want = (Array.isArray(newIds) ? newIds : []).map(Number);
  if (want.length !== oldIds.length || want.some(function (id) { return oldIds.indexOf(id) < 0; }) || new Set(want).size !== want.length) {
    throw fail('STALE', 'The panels have changed since this page loaded. Reload and try again.', 409);
  }
  moments.forEach(function (m, i) {
    if (want[i] === Number(m.id)) return;
    if (m.kind === 'establishing') throw fail('TITLE', 'The title picture stays first.', 403);
    if (m.locked) throw fail('LOCKED', 'A locked panel keeps its place. Unlock it first.', 403);
  });
  return { oldIds: oldIds, newIds: want };
}

// Apply a new order (reorder) or a deletion to one version, all or nothing. Returns what the caller should release.
async function applyPanels(db, opts) {
  const forkId = Number(opts.forkId), sessionId = Number(opts.sessionId);
  // A narrative being written, or Generate Story running, would land in the old order: refuse until it finishes.
  const cut = new Date(Date.now() - JOB_WINDOW_MS).toISOString();
  const nj = await db.prepare("SELECT id FROM narrative_jobs WHERE fork_id = ? AND status IN ('pending','running') AND updated_at > ?").get(forkId, cut);
  const ej = await db.prepare("SELECT id FROM extract_jobs WHERE session_id = ? AND status IN ('pending','running') AND updated_at > ?").get(sessionId, cut);
  if (nj || ej) throw fail('BUSY', (nj ? 'The narrative is being written' : 'Generate Story is running') + ' for this session. Wait for it to finish, then try again.', 409);
  return db.transaction(async function (tx) {
    const moments = await tx.prepare('SELECT id, kind, locked, image, revert_image FROM moments WHERE fork_id = ? AND session_id = ? ORDER BY panel_order ASC, id ASC FOR UPDATE').all(forkId, sessionId);
    if (!moments.length) throw fail('NOT_FOUND', 'That version has no panels.', 404);
    const plan = planOrder(moments, opts.order, opts.deleteId);
    const oldIds = plan.oldIds, newIds = plan.newIds;
    const newIndex = {}; newIds.forEach(function (id, i) { newIndex[id] = i; });
    const oldToNew = oldIds.map(function (id) { return newIndex[id] === undefined ? null : newIndex[id]; });

    // The text: the version's own, or (a version from before versions held text) the session's.
    const fk = await tx.prepare('SELECT role, narrative_sections, narrative_directions, narrative_outlines, narrative_outline FROM session_forks WHERE id = ? FOR UPDATE').get(forkId);
    let secHome = 'fork', rawSecs = fk ? fk.narrative_sections : null;
    if (rawSecs == null && fk && fk.role === 'dm') {
      const s = await tx.prepare('SELECT narrative_sections FROM sessions WHERE id = ?').get(sessionId);
      if (s && s.narrative_sections != null) { secHome = 'session'; rawSecs = s.narrative_sections; }
    }
    const secs = parseJson(rawSecs, []);
    let newSecs = null;
    if (Array.isArray(secs) && secs.length) {
      const oldAligned = alignSections(secs, oldIds);
      if (oldAligned === null) throw fail('MISMATCH', 'This session’s text no longer matches its panels. Regenerate the narrative first, then move the panels.', 409);
      const oldNext = {}; oldIds.forEach(function (id, i) { oldNext[id] = (i + 1 < oldIds.length) ? oldIds[i + 1] : null; });
      newSecs = newIds.map(function (id, i) {
        const s = Object.assign({}, oldAligned[oldIds.indexOf(id)]);
        s.panel_index = i; s.moment_id = id;
        const next = (i + 1 < newIds.length) ? newIds[i + 1] : null;
        if (next !== oldNext[id]) s.bridge_stale = true;   // its Bridge was written to lead into a different panel
        return s;
      });
    }
    const dirs = remapKeys(parseJson(fk && fk.narrative_directions, {}), oldToNew);
    // v3.4.33 -- THE GENERATE STORY OUTLINE (narrative_outline: { intro, sections:[{ panel_index, before, outline }], outro }),
    // the Review tab's short summaries, is kept by position too, so it follows its panels the same way (stamped by id).
    // Left as it is when it does not match the panels; it is a summary, and the text is what must never be wrong.
    let newOutline = null;
    const ol = parseJson(fk && fk.narrative_outline, null);
    if (ol && Array.isArray(ol.sections) && ol.sections.length) {
      const byPos = ol.sections.slice().sort(function (a, b) { return ((a && a.panel_index) || 0) - ((b && b.panel_index) || 0); });
      const olAligned = alignSections(byPos, oldIds);
      if (olAligned !== null) newOutline = Object.assign({}, ol, { sections: newIds.map(function (id, i) { return Object.assign({}, olAligned[oldIds.indexOf(id)], { panel_index: i, moment_id: id }); }) });
    }
    const outs = remapKeys(parseJson(fk && fk.narrative_outlines, {}), oldToNew);

    if (opts.deleteId != null) await tx.prepare('DELETE FROM moments WHERE id = ? AND fork_id = ?').run(Number(opts.deleteId), forkId);
    for (let i = 0; i < newIds.length; i++) await tx.prepare('UPDATE moments SET panel_order = ? WHERE id = ? AND fork_id = ?').run(i, newIds[i], forkId);

    const sets = ['narrative_directions = ?', 'narrative_outlines = ?'], vals = [JSON.stringify(dirs), JSON.stringify(outs)];
    if (newSecs && secHome === 'fork') { sets.push('narrative_sections = ?'); vals.push(JSON.stringify(newSecs)); }
    if (newOutline) { sets.push('narrative_outline = ?'); vals.push(JSON.stringify(newOutline)); }   // v3.4.33
    vals.push(forkId);
    await tx.prepare('UPDATE session_forks SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
    if (newSecs && secHome === 'session') await tx.prepare('UPDATE sessions SET narrative_sections = ? WHERE id = ?').run(JSON.stringify(newSecs), sessionId);

    // A character change follows its panel; from a deleted panel it starts at the panel after (the same index).
    const ch = await tx.prepare('SELECT id, change_moment_index FROM session_characters WHERE fork_id = ? AND change_moment_index IS NOT NULL').all(forkId);
    for (const r of ch) {
      const o = Number(r.change_moment_index);
      if (!(o >= 0)) continue;
      let n;
      if (o >= oldIds.length) n = newIds.length;
      else if (oldToNew[o] !== null) n = oldToNew[o];
      else n = oldIds.slice(0, o).filter(function (id) { return newIndex[id] !== undefined; }).length;
      if (n !== o) await tx.prepare('UPDATE session_characters SET change_moment_index = ? WHERE id = ?').run(n, r.id);
    }
    const gone = (opts.deleteId != null) ? moments.find(function (m) { return Number(m.id) === Number(opts.deleteId); }) : null;
    return { order: newIds, release: gone ? [gone.image, gone.revert_image].filter(Boolean) : [] };
  });
}

module.exports = { alignSections, stampSections, remapKeys, planOrder, applyPanels, parseJson };
