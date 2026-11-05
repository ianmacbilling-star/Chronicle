'use strict';
// =====================================================================================================
// v3.4.32 -- TD-1107. MOVING AND DELETING STORY PANELS, AND EVERYTHING THAT BELONGS TO THEM.
// v3.4.36 -- FREE ORDER (claude/FREE_ORDER_STORY_SPEC.md). Ian, 2026-11-05: "A user should be able to move the image
// panels and narrative panels around separately wherever they want... there should be no rules... only warnings."
//
// TWO KINDS OF SPACE: a PICTURE (its picture and its own Moment text, never apart) and a BRIDGE (text on its own).
// A picture's block of text keeps the bridges that follow it on the page, each with an id of its own:
//   { panel_index, moment_id, before, before_summary,
//     bridges: [ { id, text, summary, between: [picture id before, picture id after] } ],
//     after, after_summary }                      <- after = the bridges' text joined: what every book layout reads
// `bridges` is the truth; after / after_summary are made from it HERE and nowhere else (derive), so the printed book
// is unchanged for any story nobody has moved. `between` is where a bridge was written; when the pictures either side
// are no longer those, the block says bridge_stale (the page shows "this bridge now sits between different panels").
//
// THE TITLE PICTURE AND THE OPENING NEVER MOVE. The title's block holds text the AI writes but nobody ever sees or
// prints (TD-1106); it is left exactly as it is and never turned into a bridge. A bridge a user places right after
// the title will be kept in the title block's `bridges` -- but the book cannot print those until v3.4.38, so until
// then (TITLE_BRIDGES false) nothing may be placed there.
//
// WHAT ELSE IS KEYED BY POSITION (measured in v3.4.31): moments.panel_order (the order itself),
// narrative_directions/outlines ('moment:i' follow their picture; 'between:i' belong to the first bridge of gap i
// and follow it), narrative_outline (Generate Story's Review lines, the same way), and
// session_characters.change_moment_index (follows its picture). Everything happens in ONE transaction.
// Only on your own version; refused while a narrative or Generate Story is being written. Locks are on the PICTURE
// and no longer stop a move (Ian: "Lift the rule on the locked panels").
// =====================================================================================================
const crypto = require('crypto');

const JOB_WINDOW_MS = 20 * 60 * 1000;   // the narrative route's own window for a run still going
const TITLE_BRIDGES = false;            // v3.4.38: the book prints a bridge placed right after the title

function parseJson(s, dflt) {
  if (s == null || s === '') return dflt;
  if (typeof s === 'object') return s;
  try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; }
}

// The text blocks in the order of momentIds, each stamped with its panel's id and position. By id when every block
// already carries one and they cover this version's panels; otherwise by position when the counts agree (text written
// before the ids, or copied from another version, whose panels have other ids). null when neither.
function alignSections(sections, momentIds) {
  const secs = Array.isArray(sections) ? sections : [];
  if (!secs.length) return [];
  const ids = momentIds.map(String);
  const byId = {};
  let allIds = true;
  secs.forEach(function (s) { if (s && s.moment_id != null && byId[String(s.moment_id)] === undefined) byId[String(s.moment_id)] = s; else allIds = false; });
  let ordered = null;
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

// 'moment:i' keys follow their picture (oldToNew); 'between:i' keys follow gapMap (old gap -> new gap). Dropped when
// the map says null; anything else is kept.
function remapKeys(map, oldToNew, gapMap) {
  const out = {};
  Object.keys(map || {}).forEach(function (k) {
    const m = /^(moment|between):(\d+)$/.exec(k);
    if (!m) { out[k] = map[k]; return; }
    const ni = (m[1] === 'between' && gapMap) ? gapMap[Number(m[2])] : oldToNew[Number(m[2])];
    if (ni === undefined || ni === null) return;
    out[m[1] + ':' + ni] = map[k];
  });
  return out;
}

function fail(code, message, status) { const e = new Error(message); e.code = code; e.status = status || 409; return e; }

// A new bridge id, unique among `taken` (and recorded there).
function bid(taken) {
  let id;
  do { id = 'b' + crypto.randomBytes(4).toString('hex').slice(0, 7); } while (taken && taken[id]);
  if (taken) taken[id] = true;
  return id;
}
function isTitle(m) { return !!(m && m.kind === 'establishing'); }

// after / after_summary from the bridges, and the stale flag from `between`. The title's block is never touched.
function derive(b, i, ids, title) {
  delete b.bridge_stale;
  if (!title) {
    if (b.bridges.length) {
      b.after = b.bridges.map(function (x) { return String(x.text || ''); }).join('\n\n');
      b.after_summary = b.bridges.map(function (x) { return x.summary || ''; }).filter(Boolean).join(' ');
    } else {
      if (b.after !== undefined) b.after = '';
      if (b.after_summary !== undefined) b.after_summary = '';
    }
  }
  const want0 = Number(ids[i]), want1 = (i + 1 < ids.length) ? Number(ids[i + 1]) : null;
  const off = b.bridges.some(function (x) {
    if (!Array.isArray(x.between)) return true;
    const b1 = x.between[1] == null ? null : Number(x.between[1]);
    return Number(x.between[0]) !== want0 || b1 !== want1;
  });
  if (off) b.bridge_stale = true;
  return b;
}

// Blocks (aligned to `moments`) in the new shape. Old text: a non-empty `after` becomes one bridge written for the
// pictures either side (or already out of place, when v3.4.35 had marked it so); the title's hidden text is left be.
function normBlocks(blocks, moments) {
  const ids = moments.map(function (m) { return Number(m.id); });
  const taken = {};
  blocks.forEach(function (b) { (Array.isArray(b && b.bridges) ? b.bridges : []).forEach(function (x) { if (x && x.id) taken[x.id] = true; }); });
  return blocks.map(function (b0, i) {
    const b = Object.assign({}, b0 || {});
    const title = isTitle(moments[i]);
    if (Array.isArray(b.bridges)) {
      b.bridges = b.bridges.filter(function (x) { return x && x.id; }).map(function (x) { return Object.assign({}, x); });
    } else if (title || !String(b.after || '').trim()) {
      b.bridges = [];
    } else {
      b.bridges = [{ id: bid(taken), text: String(b.after), summary: b.after_summary || '',
        between: b.bridge_stale ? null : [ids[i], (i + 1 < ids.length) ? ids[i + 1] : null] }];
    }
    return derive(b, i, ids, title);
  });
}

// The page order after the fixed head (the title, when there is one): pictures and bridges, as {t:'p'|'b', id}.
function flatten(norm, moments) {
  const out = [];
  moments.forEach(function (m, i) {
    if (!(i === 0 && isTitle(m))) out.push({ t: 'p', id: Number(m.id) });
    (norm ? norm[i].bridges : []).forEach(function (x) { out.push({ t: 'b', id: x.id }); });
  });
  return out;
}

// v3.4.36 -- THE SAVE ROUTE. What the page sent, merged with what is stored so no bridge or id is lost. A page that
// knows bridges sends them (by id; unknown ids are dropped). An older page sends only `after` for each block: when
// it is what is stored, the bridges are kept as they are; when it was edited, the block's bridges become that one
// text (it is what the writer sees and changed), keeping the first bridge's id so its Directions stay with it.
function mergeSave(incoming, storedRaw, moments) {
  const ids = moments.map(function (m) { return Number(m.id); });
  const a = alignSections(incoming, ids);
  if (a === null) return Array.isArray(incoming) ? incoming : [];
  let old = null;
  const sa = alignSections(parseJson(storedRaw, []), ids);
  if (sa && sa.length) old = normBlocks(sa, moments);
  const taken = {};
  if (old) old.forEach(function (b) { b.bridges.forEach(function (x) { taken[x.id] = true; }); });
  return a.map(function (b0, i) {
    const b = Object.assign({}, b0);
    const title = isTitle(moments[i]);
    const ob = old ? old[i] : null;
    const want = [ids[i], (i + 1 < ids.length) ? ids[i + 1] : null];
    if (Array.isArray(b0.bridges)) {
      const known = {};
      if (ob) ob.bridges.forEach(function (x) { known[x.id] = x; });
      b.bridges = b0.bridges.filter(function (x) { return x && known[x.id]; }).map(function (x) {
        const k = known[x.id], t = String(x.text == null ? '' : x.text);
        const o = Object.assign({}, k, { text: t, summary: (x.summary !== undefined) ? (x.summary || '') : (k.summary || '') });
        if (t.trim() !== String(k.text || '').trim()) o.between = want;   // rewritten here: it is written for where it sits now (pages trim)
        return o;
      });
    } else if (title) {
      b.bridges = ob ? ob.bridges.map(function (x) { return Object.assign({}, x); }) : [];
    } else {
      const ia = b0.after == null ? '' : String(b0.after);
      const sb = ob ? ob.bridges : [];
      const cur = sb.map(function (x) { return String(x.text || ''); }).join('\n\n');
      if (ob && ia.trim() === cur.trim()) b.bridges = sb.map(function (x) { return Object.assign({}, x); });   // pages trim what they send
      else if (!ia.trim()) b.bridges = [];
      else b.bridges = [{ id: sb.length ? sb[0].id : bid(taken), text: ia,
        summary: (b0.after_summary !== undefined) ? (b0.after_summary || '') : (sb[0] ? (sb[0].summary || '') : ''),
        between: (!ob && b0.bridge_stale) ? null : want }];
    }
    return derive(b, i, ids, title);
  });
}

// v3.4.36 -- A FRESH NARRATIVE (Regenerate Narrative, and the first write). One bridge between each pair of pictures,
// in the pictures' order now; each takes the id of the first bridge that sits in that gap today, so its Directions
// stay with it. Extra bridges, and any right after the title, are gone (Ian: "a regenerate narrative fixes it all").
function fromGenerated(sections, moments, oldRaw) {
  const ids = moments.map(function (m) { return Number(m.id); });
  const a = alignSections(sections, ids);
  if (a === null) return Array.isArray(sections) ? sections : [];
  let old = null;
  try { const oa = alignSections(parseJson(oldRaw, []), ids); if (oa && oa.length) old = normBlocks(oa, moments); } catch (e) { old = null; }
  const taken = {};
  if (old) old.forEach(function (b) { b.bridges.forEach(function (x) { taken[x.id] = true; }); });
  return a.map(function (b0, i) {
    const b = Object.assign({}, b0);
    const title = isTitle(moments[i]);
    const keep = (old && old[i] && old[i].bridges[0]) ? old[i].bridges[0].id : null;
    b.bridges = (!title && String(b.after || '').trim())
      ? [{ id: keep || bid(taken), text: String(b.after), summary: b.after_summary || '', between: [ids[i], (i + 1 < ids.length) ? ids[i + 1] : null] }]
      : [];
    return derive(b, i, ids, title);
  });
}

// The rules a new order of pictures is checked against (the arrows' and drag's old route; still used by v3.4.35 pages).
function planOrder(moments, newIds, deleteId) {
  const oldIds = moments.map(function (m) { return Number(m.id); });
  if (deleteId != null) {
    const d = moments.find(function (m) { return Number(m.id) === Number(deleteId); });
    if (!d) throw fail('NOT_FOUND', 'That panel is not in this version.', 404);
    if (isTitle(d)) throw fail('TITLE', 'The title picture cannot be deleted.', 403);
    return { oldIds: oldIds, newIds: oldIds.filter(function (id) { return id !== Number(deleteId); }) };
  }
  const want = (Array.isArray(newIds) ? newIds : []).map(Number);
  if (want.length !== oldIds.length || want.some(function (id) { return oldIds.indexOf(id) < 0; }) || new Set(want).size !== want.length) {
    throw fail('STALE', 'The panels have changed since this page loaded. Reload and try again.', 409);
  }
  moments.forEach(function (m, i) {
    if (want[i] !== Number(m.id) && isTitle(m)) throw fail('TITLE', 'The title picture stays first.', 403);
  });
  return { oldIds: oldIds, newIds: want };
}

async function busyCheck(db, forkId, sessionId) {
  const cut = new Date(Date.now() - JOB_WINDOW_MS).toISOString();
  const nj = await db.prepare("SELECT id FROM narrative_jobs WHERE fork_id = ? AND status IN ('pending','running') AND updated_at > ?").get(forkId, cut);
  const ej = await db.prepare("SELECT id FROM extract_jobs WHERE session_id = ? AND status IN ('pending','running') AND updated_at > ?").get(sessionId, cut);
  if (nj || ej) throw fail('BUSY', (nj ? 'The narrative is being written' : 'Generate Story is running') + ' for this session. Wait for it to finish, then try again.', 409);
}

// THE ONE PLACE A VERSION'S LAYOUT CHANGES. `make(ctx)` returns { items } (the whole page order after the title) and
// optionally deleteId (a picture to delete, absent from items). Everything else follows from the items.
async function applyLayout(db, opts, make) {
  const forkId = Number(opts.forkId), sessionId = Number(opts.sessionId);
  await busyCheck(db, forkId, sessionId);
  return db.transaction(async function (tx) {
    const moments = await tx.prepare('SELECT id, kind, locked, image, revert_image FROM moments WHERE fork_id = ? AND session_id = ? ORDER BY panel_order ASC, id ASC FOR UPDATE').all(forkId, sessionId);
    if (!moments.length) throw fail('NOT_FOUND', 'That version has no panels.', 404);
    const oldIds = moments.map(function (m) { return Number(m.id); });
    const fk = await tx.prepare('SELECT role, narrative_sections, narrative_directions, narrative_outlines, narrative_outline FROM session_forks WHERE id = ? FOR UPDATE').get(forkId);
    let secHome = 'fork', rawSecs = fk ? fk.narrative_sections : null;
    if (rawSecs == null && fk && fk.role === 'dm') {
      const s = await tx.prepare('SELECT narrative_sections FROM sessions WHERE id = ?').get(sessionId);
      if (s && s.narrative_sections != null) { secHome = 'session'; rawSecs = s.narrative_sections; }
    }
    const secs0 = parseJson(rawSecs, []);
    let norm = null;
    if (Array.isArray(secs0) && secs0.length) {
      const al = alignSections(secs0, oldIds);
      if (al === null) throw fail('MISMATCH', 'This session’s text no longer matches its panels. Regenerate the narrative first, then move the panels.', 409);
      norm = normBlocks(al, moments);
    }
    const head = isTitle(moments[0]) ? moments[0] : null;
    const ctx = { moments: moments, norm: norm, head: head, flat: flatten(norm, moments) };
    const plan = make(ctx);
    const items = (plan.items || []).map(function (it) { return { t: it && it.t === 'b' ? 'b' : 'p', id: (it && it.t === 'b') ? String(it.id) : Number(it && it.id) }; });

    // Every picture (but a deleted one) and every bridge (but deleted ones) exactly once, and nothing new.
    const delId = (plan.deleteId != null) ? Number(plan.deleteId) : null;
    const dropB = plan.dropBridges || {};
    const expect = ctx.flat.filter(function (it) { return !(it.t === 'p' && it.id === delId) && !(it.t === 'b' && dropB[it.id]); })
      .map(function (it) { return it.t + ':' + it.id; }).sort();
    const got = items.map(function (it) { return it.t + ':' + it.id; }).sort();
    if (expect.length !== got.length || expect.some(function (k, n) { return k !== got[n]; })) throw fail('STALE', 'The panels have changed since this page loaded. Reload and try again.', 409);
    if (items.length && items[0].t === 'b' && !(head && TITLE_BRIDGES)) throw fail('SPOT', 'A bridge cannot go before the first picture.', 409);

    // The new pictures, and the bridges after each.
    const bridgeById = {}, oldGapOf = {}, wasFirst = {};
    if (norm) norm.forEach(function (b, g) { b.bridges.forEach(function (x, k) { bridgeById[x.id] = x; oldGapOf[x.id] = g; if (k === 0) wasFirst[x.id] = true; }); });
    const newIds = head ? [Number(head.id)] : [];
    const groups = head ? [[]] : [];
    items.forEach(function (it) {
      if (it.t === 'p') { newIds.push(it.id); groups.push([]); } else groups[groups.length - 1].push(bridgeById[it.id]);
    });
    const posOf = {}; oldIds.forEach(function (id, i) { posOf[id] = i; });
    const newIndex = {}; newIds.forEach(function (id, i) { newIndex[id] = i; });
    const oldToNew = oldIds.map(function (id) { return newIndex[id] === undefined ? null : newIndex[id]; });
    const kindOf = {}; moments.forEach(function (m) { kindOf[Number(m.id)] = m; });

    // Which old gap's Directions / outline each new gap takes: the gap its first bridge was first in; an empty gap
    // keeps those of the gap after the same picture, when nothing else has taken them.
    const gapMap = oldIds.map(function () { return null; });
    const srcOf = newIds.map(function () { return null; });
    groups.forEach(function (gr, k) {
      if (gr.length && wasFirst[gr[0].id]) { srcOf[k] = oldGapOf[gr[0].id]; gapMap[srcOf[k]] = k; }
    });
    groups.forEach(function (gr, k) {
      if (gr.length) return;
      const g = posOf[newIds[k]];
      if (g !== undefined && gapMap[g] === null) { srcOf[k] = g; gapMap[g] = k; }
    });

    let newSecs = null;
    if (norm) {
      newSecs = newIds.map(function (id, i) {
        const s = Object.assign({}, norm[posOf[id]]);
        s.bridges = groups[i].map(function (x) { return Object.assign({}, x); });
        s.panel_index = i; s.moment_id = id;
        return derive(s, i, newIds, isTitle(kindOf[id]));
      });
    }
    // v3.4.37 -- a bridge's Directions and outline live under its id and go with it; a deleted bridge's go with it.
    const dirs = pruneKeys(liftKeys(remapKeys(parseJson(fk && fk.narrative_directions, {}), oldToNew, gapMap), newSecs), newSecs);
    const outs = pruneKeys(liftKeys(remapKeys(parseJson(fk && fk.narrative_outlines, {}), oldToNew, gapMap), newSecs), newSecs);
    // Generate Story's Review lines: the narration line follows its picture, the bridge line follows its bridge.
    let newOutline = null;
    const ol = parseJson(fk && fk.narrative_outline, null);
    if (ol && Array.isArray(ol.sections) && ol.sections.length) {
      const byPos = ol.sections.slice().sort(function (a, b) { return ((a && a.panel_index) || 0) - ((b && b.panel_index) || 0); });
      const olA = alignSections(byPos, oldIds);
      if (olA !== null) newOutline = Object.assign({}, ol, { sections: newIds.map(function (id, i) {
        const s = Object.assign({}, olA[posOf[id]], { panel_index: i, moment_id: id });
        s.outline = (srcOf[i] !== null && olA[srcOf[i]] && olA[srcOf[i]].outline !== undefined) ? olA[srcOf[i]].outline : '';
        return s;
      }) });
    }

    if (delId != null) await tx.prepare('DELETE FROM moments WHERE id = ? AND fork_id = ?').run(delId, forkId);
    for (let i = 0; i < newIds.length; i++) await tx.prepare('UPDATE moments SET panel_order = ? WHERE id = ? AND fork_id = ?').run(i, newIds[i], forkId);
    const sets = ['narrative_directions = ?', 'narrative_outlines = ?'], vals = [JSON.stringify(dirs), JSON.stringify(outs)];
    if (newSecs && secHome === 'fork') { sets.push('narrative_sections = ?'); vals.push(JSON.stringify(newSecs)); }
    if (newOutline) { sets.push('narrative_outline = ?'); vals.push(JSON.stringify(newOutline)); }
    vals.push(forkId);
    await tx.prepare('UPDATE session_forks SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
    if (newSecs && secHome === 'session') await tx.prepare('UPDATE sessions SET narrative_sections = ? WHERE id = ?').run(JSON.stringify(newSecs), sessionId);

    // A character change follows its picture; from a deleted picture it starts at the picture after (the same index).
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
    const gone = (delId != null) ? moments.find(function (m) { return Number(m.id) === delId; }) : null;
    return { order: newIds, items: items, release: gone ? [gone.image, gone.revert_image].filter(Boolean) : [] };
  });
}

// The items with the pictures in `order` and each gap's bridges where they were (a v3.4.35 page's arrows).
function itemsKeepingGaps(ctx, order) {
  const items = [];
  order.forEach(function (id, i) {
    if (!(i === 0 && ctx.head)) items.push({ t: 'p', id: Number(id) });
    (ctx.norm ? ctx.norm[i].bridges : []).forEach(function (x) { items.push({ t: 'b', id: x.id }); });
  });
  return items;
}
// Leading bridges with nowhere to go (right after the title, until v3.4.38): they go with what was deleted.
function stripLead(ctx, items, drop) {
  while (items.length && items[0].t === 'b' && !(ctx.head && TITLE_BRIDGES)) { drop[items[0].id] = true; items.shift(); }
  return items;
}

// Move pictures (order) or delete one (deleteId). A deleted picture's bridges stay where they sat on the page, after
// the picture before it.
async function applyPanels(db, opts) {
  return applyLayout(db, opts, function (ctx) {
    const plan = planOrder(ctx.moments, opts.order, opts.deleteId);
    if (opts.deleteId != null) {
      const drop = {};
      const items = stripLead(ctx, ctx.flat.filter(function (it) { return !(it.t === 'p' && it.id === Number(opts.deleteId)); }), drop);
      return { items: items, deleteId: opts.deleteId, dropBridges: drop };
    }
    return { items: itemsKeepingGaps(ctx, plan.newIds) };
  });
}

// v3.4.35 pages: swap the bridges of two gaps, or empty one gap. A gap is one the page shows: after a picture that is
// not the title, up to the last but one.
async function applyBridges(db, opts) {
  return applyLayout(db, opts, function (ctx) {
    const n = ctx.moments.length;
    const shown = function (g) { return Number.isInteger(g) && g >= 0 && g < n - 1 && !isTitle(ctx.moments[g]); };
    const a = Number(opts.a), b = (opts.op === 'swap') ? Number(opts.b) : null;
    if (!shown(a) || (opts.op === 'swap' && (!shown(b) || a === b)) || (opts.op !== 'swap' && opts.op !== 'clear')) throw fail('STALE', 'The panels have changed since this page loaded. Reload and try again.', 409);
    if (!ctx.norm) throw fail('NO_TEXT', 'There is no narrative text here yet.', 409);
    const order = ctx.moments.map(function (m) { return Number(m.id); });
    const gaps = ctx.norm.map(function (blk) { return blk.bridges.map(function (x) { return x.id; }); });
    const drop = {};
    if (opts.op === 'swap') { const t = gaps[a]; gaps[a] = gaps[b]; gaps[b] = t; }
    else { gaps[a].forEach(function (id) { drop[id] = true; }); gaps[a] = []; }
    const items = [];
    order.forEach(function (id, i) {
      if (!(i === 0 && ctx.head)) items.push({ t: 'p', id: id });
      gaps[i].forEach(function (x) { items.push({ t: 'b', id: x }); });
    });
    return { items: items, dropBridges: drop };
  });
}

// v3.4.36 -- FREE ORDER: the whole page order after the title ({items}), or one bridge to delete ({deleteBridge}).
async function applyArrange(db, opts) {
  return applyLayout(db, opts, function (ctx) {
    if (opts.deleteBridge != null) {
      const id = String(opts.deleteBridge);
      if (!ctx.flat.some(function (it) { return it.t === 'b' && it.id === id; })) throw fail('STALE', 'That bridge is not there any more. Reload and try again.', 409);
      const drop = {}; drop[id] = true;
      return { items: ctx.flat.filter(function (it) { return !(it.t === 'b' && it.id === id); }), dropBridges: drop };
    }
    if (!Array.isArray(opts.items)) throw fail('BAD_ORDER', 'No order was sent.', 400);
    return { items: opts.items };
  });
}

// =====================================================================================================
// v3.4.37 -- KEYS BY BRIDGE. A bridge's Directions and outline are kept under 'bridge:<id>' and go wherever it goes.
// Older text kept them under 'between:i' (the gap after picture i): those of a gap that holds bridges belong to its
// first bridge and move to it. An empty gap keeps 'between:i' (Regenerate Narrative writes a bridge there).
// =====================================================================================================
function liftKeys(map, norm) {
  const out = Object.assign({}, map || {});
  if (!norm) return out;
  norm.forEach(function (b, g) {
    const k = 'between:' + g;
    if (out[k] === undefined || !b.bridges.length) return;
    const nk = 'bridge:' + b.bridges[0].id;
    if (out[nk] === undefined) out[nk] = out[k];
    delete out[k];
  });
  return out;
}
// Keys of bridges that are gone are dropped (a deleted bridge is deleted for good).
function pruneKeys(map, norm) {
  if (!norm) return map;
  const have = {};
  norm.forEach(function (b) { b.bridges.forEach(function (x) { have[x.id] = true; }); });
  const out = {};
  Object.keys(map || {}).forEach(function (k) { const m = /^bridge:(.+)$/.exec(k); if (!m || have[m[1]]) out[k] = map[k]; });
  return out;
}
// For a writer that still thinks in gaps (Generate Narrative writes one bridge per gap): 'between:i' read from the
// gap's first bridge.
function gapView(map, norm) {
  const out = Object.assign({}, map || {});
  if (!norm) return out;
  norm.forEach(function (b, g) {
    if (b.bridges.length && out['bridge:' + b.bridges[0].id] !== undefined) out['between:' + g] = out['bridge:' + b.bridges[0].id];
  });
  return out;
}
// A version's text in the new shape, read only. null when there is none, or it does not match the pictures.
function readNorm(rawSecs, moments) {
  const secs = parseJson(rawSecs, []);
  if (!Array.isArray(secs) || !secs.length || !moments || !moments.length) return null;
  const al = alignSections(secs, moments.map(function (m) { return Number(m.id); }));
  return al === null ? null : normBlocks(al, moments);
}
// v3.4.37 -- A VERSION'S BRIDGE IDS ARE MADE ONCE AND KEPT. Called before a page reads a version's text: older text
// gets its ids (and its Directions moved to them) and is written back, so the ids the page holds are the ones stored.
// The text itself is unchanged (after is the same words). Written only when something changes, and only if the row
// still holds what was read (a write that happened meanwhile wins; the next read tries again).
async function ensureIds(db, forkId) {
  const fk = await db.prepare('SELECT narrative_sections, narrative_directions, narrative_outlines FROM session_forks WHERE id = ?').get(forkId);
  if (!fk || fk.narrative_sections == null || typeof fk.narrative_sections !== 'string') return false;
  const secs = parseJson(fk.narrative_sections, []);
  if (!Array.isArray(secs) || !secs.length) return false;
  const moments = await db.prepare('SELECT id, kind FROM moments WHERE fork_id = ? ORDER BY panel_order ASC, id ASC').all(forkId);
  const ids = moments.map(function (m) { return Number(m.id); });
  const al = alignSections(secs, ids);
  if (al === null) return false;
  const fresh = al.some(function (b, i) { return !Array.isArray(b.bridges) || !secs[i] || Number(secs[i].moment_id) !== ids[i] || secs[i].panel_index !== i; });
  const norm = normBlocks(al, moments);
  const d0 = parseJson(fk.narrative_directions, {}), o0 = parseJson(fk.narrative_outlines, {});
  const d1 = liftKeys(d0, norm), o1 = liftKeys(o0, norm);
  const keysMoved = JSON.stringify(d1) !== JSON.stringify(d0) || JSON.stringify(o1) !== JSON.stringify(o0);
  if (!fresh && !keysMoved) return false;
  const r = await db.prepare('UPDATE session_forks SET narrative_sections = ?, narrative_directions = ?, narrative_outlines = ? WHERE id = ? AND narrative_sections = ? AND COALESCE(narrative_directions, \'\') = ? AND COALESCE(narrative_outlines, \'\') = ?')
    .run(JSON.stringify(norm), JSON.stringify(d1), JSON.stringify(o1), forkId, fk.narrative_sections, fk.narrative_directions || '', fk.narrative_outlines || '');
  return !!(r && r.changes);
}

module.exports = { alignSections, stampSections, remapKeys, planOrder, applyPanels, applyBridges, applyArrange, liftKeys, pruneKeys, gapView, readNorm, ensureIds,

  normBlocks, mergeSave, fromGenerated, flatten, derive, parseJson, TITLE_BRIDGES };
