const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork, getDmForkId, getViewableForkId } = require('../database/db');
const { releaseImage } = require('../storage/storage');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');
const { checkSessionLimit, getEffectiveTier, tierRank, artStyleAllowed } = require('../middleware/tiers');
const imageHelpers = require('./images');
const { getTokenCost, canAfford, spendTokens } = require('./tokens');

// GET last used art style and layout style
// Phase 4 Step 3c — resolve which version the caller is acting on: the DM
// acts on the canonical (DM) fork; a player acts on their OWN version.
// Returns null if a player has no version of this session yet.
async function callerForkId(db, sessionId, userId, role) {
  if (role === 'dm') return await getDmForkId(db, sessionId);
  const f = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
  return f ? f.id : null;
}

router.get('/last-style', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare(
    'SELECT art_style, layout_style FROM sessions WHERE campaign_id=? AND (art_style IS NOT NULL OR layout_style IS NOT NULL) ORDER BY session_date DESC, created_at DESC LIMIT 1'
  ).get(req.params.campaignId);
  res.json({
    art_style: session ? session.art_style : null,
    layout_style: session ? session.layout_style : null
  });
});

// GET novel/all - must come before /:id
router.get('/novel/all', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  // The DM may assemble a player's novel via ?as_user=<userId>; for any
  // session that player hasn't versioned, fall back to the DM canonical fork.
  const asUser = (req.campaignRole === 'dm' && req.query.as_user) ? Number(req.query.as_user) : null;
  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id=? ORDER BY session_date ASC').all(req.params.campaignId);
  const result = await Promise.all(sessions.map(async function(s) {
    let forkId = null;
    if (asUser) {
      const pf = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player'").get(s.id, asUser);
      if (pf) forkId = pf.id;
    }
    if (!forkId) forkId = await getDmForkId(db, s.id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id=? ORDER BY panel_order ASC').all(forkId);
    const fk = await db.prepare('SELECT player_access_status FROM session_forks WHERE id = ?').get(forkId);
    return Object.assign({}, s, { moments, fork_status: fk ? fk.player_access_status : 'draft' });
  }));
  res.json(result);
});

// GET novel/people - the Story Master + any players who have at least one
// version, for the Graphic Novel page's person picker. Must come before /:id.
router.get('/novel/people', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const rows = await db.prepare(
    "SELECT u.id AS user_id, u.name, u.email, cm.role, " +
    "EXISTS(SELECT 1 FROM session_forks sf JOIN sessions s ON s.id = sf.session_id " +
    "WHERE s.campaign_id = ? AND sf.user_id = u.id AND sf.role = 'player') AS has_version " +
    "FROM campaign_members cm JOIN users u ON u.id = cm.user_id " +
    "WHERE cm.campaign_id = ? ORDER BY (cm.role = 'dm') DESC, u.name ASC"
  ).all(req.params.campaignId, req.params.campaignId);
  res.json(rows);
});

// GET all sessions
// PUT novel-include - DM toggles whether a session appears in the graphic
// novel (preview + export). Default true. Per-session, not per-fork.
router.put('/:id/novel-include', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const include = !(req.body && (req.body.include === false || req.body.include === 'false' || req.body.include === 0));
  await db.prepare('UPDATE sessions SET novel_include = ? WHERE id = ? AND campaign_id = ?').run(include, req.params.id, req.params.campaignId);
  res.json({ ok: true, include: include });
});

router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  // Phase 3 polish — include the first generated storyboard image with
  // each session for the session-list thumbnail. Subquery picks the
  // moment with the lowest panel_order that has an image URL set. NULL
  // if no images have been generated yet (the row just shows no thumb).
  // Players do not see the DM's Draft sessions unless they have already
  // made their own version of that session. The DM sees everything.
  var visFilter = '';
  var listParams = [req.params.campaignId];
  if (req.campaignRole !== 'dm') {
    visFilter = " AND ( (SELECT f.player_access_status FROM session_forks f WHERE f.session_id = s.id AND f.role = 'dm' LIMIT 1) = 'ready'" +
      " OR EXISTS (SELECT 1 FROM session_forks fo WHERE fo.session_id = s.id AND fo.user_id = ? AND fo.role = 'player') )";
    listParams.push(req.session.userId);
  }
  const sessions = await db.prepare(
    'SELECT s.*, ' +
    '(SELECT m.image FROM moments m JOIN session_forks f ON f.id = m.fork_id WHERE f.session_id = s.id AND f.role = \'dm\' AND m.image IS NOT NULL AND m.image <> \'\' ORDER BY m.panel_order ASC LIMIT 1) AS first_image_url, ' +
    // Deploy 4.0 — player_access_status now lives on the DM fork. This
    // aliased column comes AFTER s.* so it wins in the row object,
    // keeping the JSON key identical (frontend session-list untouched).
    "(SELECT f.player_access_status FROM session_forks f WHERE f.session_id = s.id AND f.role = 'dm' LIMIT 1) AS player_access_status " +
    'FROM sessions s ' +
    'WHERE s.campaign_id=?' + visFilter + ' ORDER BY s.session_date ASC'
  ).all(...listParams);
  res.json(sessions);
});

// GET single session
router.get('/:id', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT * FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Deploy 4.0 — override the (now-stale) sessions column with the DM
  // fork's status so the frontend keeps reading the same key.
  const dmFork = await db.prepare("SELECT player_access_status FROM session_forks WHERE session_id=? AND role='dm' LIMIT 1").get(session.id);
  if (dmFork) session.player_access_status = dmFork.player_access_status;
  // Step 1 (Phase 4) — read moments from the requested fork (default:
  // DM fork). ?fork_id= lets a player view their own fork or another
  // player's READY fork; getViewableForkId enforces who may see what.
  const viewForkId = await getViewableForkId(db, session.id, req.session.userId, req.query.fork_id);
  if (!viewForkId) return res.status(403).json({ error: 'Fork not viewable' });
  const moments = await db.prepare(
    'SELECT m.*, EXISTS(SELECT 1 FROM campaign_archives ca WHERE ca.moment_id = m.id AND ca.source_url = m.image AND ca.archived_by = ?) AS archived ' +
    'FROM moments m WHERE m.fork_id=? ORDER BY m.panel_order ASC'
  ).all(req.session.userId, viewForkId);
  // fork_status = the VIEWED fork's own status (the access-status dropdown
  // reflects whichever version you're looking at). player_access_status
  // above stays the DM-canonical value (campaign-lock semantics).
  const viewForkRow = await db.prepare('SELECT player_access_status, fork_notes, narrative_intro, narrative_sections, narrative_outro, narrative_outline, narrative_directions, narrative_style, narrative_style_used, art_style_override FROM session_forks WHERE id=?').get(viewForkId);
  // Narrative is per-version now; surface the viewed fork's narrative so the
  // frontend (which reads data.narrative_* from this response) shows the
  // right story for the selected version.
  res.json(Object.assign({}, session, {
    moments,
    fork_id: viewForkId,
    fork_status: viewForkRow ? viewForkRow.player_access_status : (session.player_access_status || 'draft'),
    fork_notes: viewForkRow ? (viewForkRow.fork_notes || '') : '',
    narrative_intro: viewForkRow ? (viewForkRow.narrative_intro || '') : (session.narrative_intro || ''),
    narrative_sections: viewForkRow ? (viewForkRow.narrative_sections || null) : (session.narrative_sections || null),
    narrative_outro: viewForkRow ? (viewForkRow.narrative_outro || '') : (session.narrative_outro || ''),
    narrative_directions: viewForkRow ? (viewForkRow.narrative_directions || null) : null,
    narrative_style: viewForkRow ? (viewForkRow.narrative_style || 'classic') : 'classic',
    narrative_style_used: viewForkRow ? (viewForkRow.narrative_style_used || null) : null,
    art_style_override: viewForkRow ? (viewForkRow.art_style_override || null) : null
  }));
});

// POST create session
router.post('/', requireAuth, verifyCampaignDM, checkSessionLimit, async function(req, res) {
  const { name, session_date } = req.body;
  if (!name || !session_date) return res.json({ error: 'Name and date required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO sessions (campaign_id, name, session_date, created_at, created_by) VALUES (?,?,?,?,?)'
  ).run(req.params.campaignId, name.trim(), session_date, now, req.session.userId);
  // Deploy 4.0 — every session is born with a DM fork row. All its
  // moments / session_characters reference this fork_id.
  await getOrCreateDmFork(db, result.lastInsertRowid, req.session.userId);
  const session = await db.prepare('SELECT * FROM sessions WHERE id=?').get(result.lastInsertRowid);
  res.json(session);
});

// PUT update session
router.put('/:id', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT * FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE sessions SET name=?, session_date=?, transcript=?, session_notes=?, art_style=?, layout_style=?, edited_at=?, edited_by=? WHERE id=?'
  ).run(
    req.body.name || session.name,
    req.body.session_date || session.session_date,
    req.body.transcript !== undefined ? req.body.transcript : session.transcript,
    req.body.session_notes !== undefined ? req.body.session_notes : session.session_notes,
    req.body.art_style !== undefined ? req.body.art_style : session.art_style,
    req.body.layout_style !== undefined ? req.body.layout_style : session.layout_style,
    now, req.session.userId, session.id
  );
  const updated = await db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
  const dmForkId = await getDmForkId(db, session.id);
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id=? ORDER BY panel_order ASC').all(dmForkId);
  res.json(Object.assign({}, updated, { moments }));
});

// PUT update session's player_access_status (Phase 3 Deploy 3)
// DM-only. Values: 'draft' | 'ready'. Future states (archived, private)
// can be added by extending the validation list — UI is built around a
// dropdown so adding states is a one-place change.
//
// FORK MIGRATION NOTE: today the status lives on the sessions row. In
// Phase 4 when session_forks lands, this status migrates to the DM's
// fork (one row per session in session_forks, with the DM's fork being
// the canonical one). The endpoint signature stays the same; only the
// underlying storage moves.
// Set the art style for the caller's VERSION. DM writes the session-level
// canonical art_style (existing behavior). A player writes their OWN fork's
// art_style_override (per-version; never touches canon). Owner-scoped.
router.put('/:id/art-style', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const sess = await db.prepare('SELECT id, campaign_id FROM sessions WHERE id=?').get(req.params.id);
  if (!sess || String(sess.campaign_id) !== String(req.params.campaignId)) return res.status(404).json({ error: 'Session not found' });
  const artStyle = (req.body && typeof req.body.art_style === 'string') ? req.body.art_style : '';
  // Tier gate: the chosen art style must be unlocked at the caller's effective
  // tier (max of their own tier and the SM's). Empty value clears it.
  if (artStyle) {
    const effRank = tierRank(await getEffectiveTier(req.session.userId, req.params.campaignId));
    if (!artStyleAllowed(effRank, artStyle)) {
      return res.status(403).json({ error: "That art style isn't available on your current plan. Pick another, or upgrade for more styles.", code: 'STYLE_LOCKED' });
    }
  }
  const now = new Date().toISOString();
  if (req.campaignRole === 'dm') {
    await db.prepare('UPDATE sessions SET art_style=?, edited_at=?, edited_by=? WHERE id=?')
      .run(artStyle, now, req.session.userId, req.params.id);
    return res.json({ success: true, scope: 'session', art_style: artStyle });
  }
  const forkId = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole);
  if (!forkId) return res.status(403).json({ error: 'You have no version of this session' });
  await db.prepare('UPDATE session_forks SET art_style_override=?, edited_at=?, edited_by=? WHERE id=?')
    .run(artStyle, now, req.session.userId, forkId);
  res.json({ success: true, scope: 'fork', art_style: artStyle });
});

router.put('/:id/access-status', requireAuth, verifyCampaignMember, async function(req, res) {
  const ALLOWED = ['draft', 'ready'];
  const status = (req.body && req.body.status) || '';
  if (ALLOWED.indexOf(status) === -1) {
    return res.status(400).json({ error: 'Invalid status. Must be one of: ' + ALLOWED.join(', ') });
  }
  const db = await getDb();
  const session = await db.prepare('SELECT id, campaign_id FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // The DM sets the canonical (DM fork) status; a player sets the status of
  // THEIR OWN version. Marking a player version Ready is what exposes it to
  // the other members' version dropdown.
  let targetForkId;
  if (req.campaignRole === 'dm') {
    targetForkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id=? AND user_id=?').get(session.id, req.session.userId);
    if (!myFork) return res.status(403).json({ error: 'You have no version of this session' });
    targetForkId = myFork.id;
  }
  await db.prepare('UPDATE session_forks SET player_access_status=? WHERE id=?').run(status, targetForkId);
  res.json({ success: true, player_access_status: status });
});

// PUT a per-version notes scratchpad. The DM owns the canonical transcript
// (DM-only elsewhere); THIS endpoint lets a player tweak the notes on their
// OWN version without touching anyone else's.
router.put('/:id/fork-notes', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT id FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  let forkId;
  if (req.campaignRole === 'dm') {
    forkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id=? AND user_id=?').get(session.id, req.session.userId);
    if (!myFork) return res.status(403).json({ error: 'You have no version of this session' });
    forkId = myFork.id;
  }
  const notes = (req.body && typeof req.body.notes === 'string') ? req.body.notes : '';
  await db.prepare('UPDATE session_forks SET fork_notes=?, edited_at=?, edited_by=? WHERE id=?').run(notes, new Date().toISOString(), req.session.userId, forkId);
  res.json({ success: true });
});

// DELETE session
router.delete('/:id', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT * FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!req.body.confirmed) return res.json({ error: 'Confirmation required' });
  // Deploy 4.0 — delete children before the session (FK order):
  // moments and session_characters reference session_forks(id), and
  // session_forks references sessions(id). Removing the fork row last
  // (before the session) clears the session_forks -> sessions FK.
  const oldMomImgs = await db.prepare('SELECT image FROM moments WHERE session_id=?').all(session.id);
  const oldRefImgs = await db.prepare('SELECT reference_url FROM session_characters WHERE session_id=?').all(session.id);
  await db.prepare('DELETE FROM moments WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM session_characters WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM session_forks WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
  for (let i = 0; i < oldMomImgs.length; i++) { await releaseImage(db, oldMomImgs[i].image); }
  for (let i = 0; i < oldRefImgs.length; i++) { await releaseImage(db, oldRefImgs[i].reference_url); }
  res.json({ success: true });
});

// GET session character snapshots (Stage 2)
router.get('/:id/characters', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const viewForkId = await getViewableForkId(db, req.params.id, req.session.userId, req.query.fork_id);
  if (!viewForkId) return res.status(403).json({ error: 'Fork not viewable' });
  const rows = await db.prepare(
    'SELECT sc.id, sc.character_id, sc.fork_id, sc.prompt, sc.change_note, sc.edited_at, ' +
    'sc.reference_url, sc.change_flag, sc.change_detail, sc.change_status, sc.change_moment_index, ' +
    'ch.name, ch.cls, ch.is_npc, ch.image_portrait, ch.image, ch.image_fullbody, ch.canonical_reference_url, ' +
    'EXISTS(SELECT 1 FROM campaign_archives ca WHERE ca.character_id = sc.character_id AND ca.fork_id = sc.fork_id AND ca.source_url = COALESCE(sc.reference_url, ch.canonical_reference_url) AND ca.archived_by = ?) AS archived ' +
    'FROM session_characters sc JOIN characters ch ON ch.id = sc.character_id ' +
    'WHERE sc.fork_id = ? ORDER BY ch.is_npc ASC, ch.name ASC'
  ).all(req.session.userId, viewForkId);
  res.json(rows);
});

// PUT edit a session character snapshot prompt (Platinum only)
router.put('/:id/characters/:characterId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const fork = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole);
  if (!fork) return res.status(403).json({ error: 'You have no version of this session' });
  // Tier gate applies only to DM canonical editing; a player edits their
  // own version freely (tokens are the meter for forks, not tier).
  if (req.campaignRole === 'dm') {
    const { getTier } = require('../middleware/tiers');
    const user = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tier = getTier(user ? user.tier : 'copper');
    if (!tier.can_edit_prompts) {
      return res.status(403).json({ error: 'Editing session character prompts is a Platinum feature.' });
    }
  }
  const { prompt } = req.body;
  if (typeof prompt !== 'string') return res.json({ error: 'Prompt required' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE session_characters SET prompt = ?, edited_at = ?, edited_by = ? ' +
    'WHERE fork_id = ? AND character_id = ?'
  ).run(prompt, now, req.session.userId, fork, req.params.characterId);

  res.json({ success: true, prompt: prompt });
});

// POST regenerate the reference image for a pending change (draft — not saved).
// Body: { detail } — the (possibly edited) amended-appearance text.
// Returns a new image URL; the DM reviews it, may regenerate again,
// and only Approve commits it.
router.post('/:id/characters/:characterId/regenerate-reference', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const detail = (req.body && req.body.detail) || '';

    const ch = await db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!ch) return res.json({ error: 'Character not found' });

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole);
    if (!fork) return res.status(403).json({ error: 'You have no version of this session' });
    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE fork_id = ? AND character_id = ?'
    ).get(fork, characterId);

    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    if (!falKey) return res.json({ error: 'Image generation not configured.' });

    if (!detail || !detail.trim()) {
      return res.json({ error: 'Describe the change before regenerating.' });
    }

    // Save the amended-appearance text now (save-like-a-normal-save) so it
    // persists and survives a reload. The regenerated image stays a draft
    // until Approve; only the text is committed here.
    if (sc) {
      if (sc.change_status === 'accepted') {
        await db.prepare('UPDATE session_characters SET change_note = ? WHERE fork_id = ? AND character_id = ?').run(detail, fork, characterId);
      } else {
        await db.prepare("UPDATE session_characters SET change_detail = ?, change_status = 'pending', change_flag = true WHERE fork_id = ? AND character_id = ?").run(detail, fork, characterId);
      }
    }

    // Edit FROM the current reference — session first, then canonical,
    // then an uploaded portrait — so amendments accumulate correctly.
    const baseImage = (sc && sc.reference_url) || ch.canonical_reference_url ||
      ch.image_portrait || ch.image_fullbody || ch.image || null;

    const modelKey = await imageHelpers.getSelectedModel(db);

    // Token gate (spend-on-success): regenerating an amended reference image
    // costs one image. Refuse upfront if the user can't afford it.
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' });
    }

    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const sub = await imageHelpers.submitEditReference(falKey, baseImage, detail, ch.name, modelKey, webhookUrl);
    const nowTs = new Date().toISOString();
    // Draft job: the webhook persists + spends + logs, but does NOT write
    // session_characters \u2014 the image stays a draft until the user Approves.
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, fork_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), parseInt(characterId, 10), fork, 'session_ref', 'queued', sub.model, cost, baseImage || null, nowTs, nowTs);
    if (req.campaignRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(req.params.campaignId, req.session.userId); } catch (e) {}
    }
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('regenerate-reference error:', e.message);
    res.json({ error: 'Could not regenerate: ' + e.message });
  }
});

// POST retouch the reference image for a session character (draft - not
// saved). Body: { instruction } - a small "keep it, change one thing" edit.
// Like the canonical retouch it is style-neutral; like regenerate-reference
// the result stays a DRAFT (session_ref) until the user Approves.
router.post('/:id/characters/:characterId/retouch-reference', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const instruction = (req.body && req.body.instruction) || '';

    const ch = await db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!ch) return res.json({ error: 'Character not found' });

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole);
    if (!fork) return res.status(403).json({ error: 'You have no version of this session' });
    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE fork_id = ? AND character_id = ?'
    ).get(fork, characterId);

    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    if (!falKey) return res.json({ error: 'Image generation not configured.' });

    if (!instruction || !instruction.trim()) {
      return res.json({ error: 'Describe the change you want.' });
    }

    // Retouch FROM the current reference - session draft first, then canonical,
    // then an uploaded portrait. There must be something to retouch.
    const baseImage = (sc && sc.reference_url) || ch.canonical_reference_url ||
      ch.image_portrait || ch.image_fullbody || ch.image || null;
    if (!baseImage) return res.json({ error: 'There is no reference image to retouch yet.' });

    const modelKey = await imageHelpers.getSelectedModel(db);

    // Token gate (spend-on-success): refuse upfront if the user can't afford it.
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' });
    }

    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    // Empty style => no style prefix; submitRetouch keeps the existing look and
    // changes only the instruction. A failure throws to the catch -> no spend.
    const sub = await imageHelpers.submitRetouch(baseImage, instruction.trim(), '', falKey, webhookUrl);
    const nowTs = new Date().toISOString();
    // Draft job: the webhook persists + spends + logs, but does NOT write
    // session_characters - the image stays a draft until the user Approves.
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, fork_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), parseInt(characterId, 10), fork, 'session_ref', 'queued', sub.model, cost, baseImage || null, nowTs, nowTs);
    if (req.campaignRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(req.params.campaignId, req.session.userId); } catch (e) {}
    }
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('retouch-reference error:', e.message);
    res.json({ error: 'Could not retouch: ' + e.message });
  }
});

// POST approve a pending change. Body: { detail, image_url }.
// Locks the approved image + text into THIS session, writes the change
// forward into all LATER sessions for this character, clears the flag.
router.post('/:id/characters/:characterId/approve-change', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const detail = (req.body && req.body.detail) || '';
    const imageUrl = (req.body && req.body.image_url) || null;
    // Stage 4: the moment index the change first appears at (DM override).
    let momentIndex = parseInt(req.body && req.body.moment_index, 10);
    if (isNaN(momentIndex) || momentIndex < -1) momentIndex = -1;
    const now = new Date().toISOString();

    const thisSession = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!thisSession) return res.json({ error: 'Session not found' });

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole);
    if (!fork) return res.status(403).json({ error: 'You have no version of this session' });
    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE fork_id = ? AND character_id = ?'
    ).get(fork, characterId);
    if (!sc) return res.json({ error: 'Session character not found' });

    // The amended text = base prompt + the approved change detail.
    // Strip any prior "RECENT CHANGE" block first so re-approving an
    // already-accepted change doesn't stack a second one.
    const baseText = (sc.prompt || '').split('\n\nRECENT CHANGE:')[0];
    const amendedText = detail ? (baseText + '\n\nRECENT CHANGE: ' + detail) : baseText;

    // 1. Lock it into THIS session: approved image + amended text, clear flag.
    await db.prepare(
      'UPDATE session_characters SET prompt = ?, reference_url = ?, change_note = ?, ' +
      'change_moment_index = ?, change_flag = ?, change_status = ?, edited_at = ?, edited_by = ? ' +
      'WHERE fork_id = ? AND character_id = ?'
    ).run(amendedText, imageUrl, detail, momentIndex, 0, 'accepted', now, req.session.userId, fork, characterId);

    // 2. Write the change FORWARD into all later sessions for this character.
    // Self-contained sessions don't auto-chain, so propagation is explicit.
    // Propagate only to LATER sessions' DM (canonical) forks that have a
    // snapshot for this character. Player versions are never touched.
    // The DM's accepted change carries forward into later CANONICAL (DM)
    // versions; a player's change carries forward only into THEIR OWN later
    // versions. Neither ever touches the other's content.
    let laterRows;
    if (req.campaignRole === 'dm') {
      laterRows = await db.prepare(
        "SELECT sf.id AS fork_id FROM session_forks sf " +
        "JOIN sessions s ON s.id = sf.session_id " +
        "WHERE sf.role = 'dm' AND s.campaign_id = ? AND s.session_date > ? " +
        "AND EXISTS (SELECT 1 FROM session_characters scx WHERE scx.fork_id = sf.id AND scx.character_id = ?)"
      ).all(thisSession.campaign_id, thisSession.session_date, characterId);
    } else {
      laterRows = await db.prepare(
        "SELECT sf.id AS fork_id FROM session_forks sf " +
        "JOIN sessions s ON s.id = sf.session_id " +
        "WHERE sf.user_id = ? AND s.campaign_id = ? AND s.session_date > ? " +
        "AND EXISTS (SELECT 1 FROM session_characters scx WHERE scx.fork_id = sf.id AND scx.character_id = ?)"
      ).all(req.session.userId, thisSession.campaign_id, thisSession.session_date, characterId);
    }

    for (const row of laterRows) {
      await db.prepare(
        'UPDATE session_characters SET prompt = ?, reference_url = ?, edited_at = ?, edited_by = ? ' +
        'WHERE fork_id = ? AND character_id = ?'
      ).run(amendedText, imageUrl, now, req.session.userId, row.fork_id, characterId);
    }

    res.json({ success: true, forwarded: laterRows.length });
  } catch(e) {
    console.error('approve-change error:', e.message);
    res.json({ error: 'Could not approve the change.' });
  }
});

// POST reject a pending change. Marks it 'rejected' and clears the badge.
// The rejected detail is kept on the row so re-extraction can tell the AI
// not to re-flag the SAME change (a genuinely different change still flags).
router.post('/:id/characters/:characterId/reject-change', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const fork = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole);
    if (!fork) return res.status(403).json({ error: 'You have no version of this session' });
    await db.prepare(
      'UPDATE session_characters SET change_flag = ?, change_status = ?, edited_at = ?, edited_by = ? ' +
      'WHERE fork_id = ? AND character_id = ?'
    ).run(0, 'rejected', now, req.session.userId, fork, req.params.characterId);
    // change_detail is intentionally left in place — re-extraction reads it.
    res.json({ success: true });
  } catch(e) {
    console.error('reject-change error:', e.message);
    res.json({ error: 'Could not reject the change.' });
  }
});

// GET a review/overview of a session's storyboard plan — the moment
// outline plus which characters and assets WILL be matched into each
// panel. Reuses the exact matching logic from images.js so this preview
// can never drift from what the storyboard actually generates.
// Phase 3: review is read-only — open to any campaign member (DM or
// player). Players need this to see the Review tab populate.
router.get('/:id/review', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const campaignId = req.params.campaignId;

    const viewForkId = await getViewableForkId(db, sessionId, req.session.userId, req.query.fork_id);
    if (!viewForkId) return res.status(403).json({ error: 'Fork not viewable' });
    const moments = await db.prepare(
      'SELECT id, title, description, type, prompt, panel_order, cast_explicit FROM moments WHERE fork_id = ? ORDER BY panel_order ASC'
    ).all(viewForkId);

    // Characters for this campaign, joined to this session's snapshots —
    // identical query shape to the storyboard routes.
    const chars = await db.prepare(
      'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
      'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
      'sc.change_note, sc.change_moment_index, sc.change_status ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(viewForkId, campaignId);
    await imageHelpers.attachPriorReferences(db, chars, sessionId, campaignId);

    const assets = await db.prepare(
      'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
    ).all(campaignId);

    // Pass 2 — explicit per-panel casts for this version (only panels the user
    // has edited have rows; panels without rows fall back to name-match).
    const castCharByMoment = {}, castAssetByMoment = {};
    const mcRows = await db.prepare(
      'SELECT mc.moment_id, ch.id, ch.name FROM moment_characters mc ' +
      'JOIN characters ch ON ch.id = mc.character_id ' +
      'JOIN moments m ON m.id = mc.moment_id WHERE m.fork_id = ?'
    ).all(viewForkId);
    mcRows.forEach(function(r){ (castCharByMoment[r.moment_id] = castCharByMoment[r.moment_id] || []).push({ id: r.id, name: r.name }); });
    const maRows = await db.prepare(
      'SELECT ma.moment_id, a.id, a.name, a.category FROM moment_assets ma ' +
      'JOIN campaign_assets a ON a.id = ma.asset_id ' +
      'JOIN moments m ON m.id = ma.moment_id WHERE m.fork_id = ?'
    ).all(viewForkId);
    maRows.forEach(function(r){ (castAssetByMoment[r.moment_id] = castAssetByMoment[r.moment_id] || []).push({ id: r.id, name: r.name, category: r.category }); });

    // Map inferred names back to ids so every chip carries an id (the UI needs
    // it to edit/remove, which materializes the inferred set into explicit rows).
    const charIdByName = {}, assetIdByName = {};
    chars.forEach(function(c){ if (c.name) charIdByName[c.name.toLowerCase()] = c.character_id; });
    assets.forEach(function(a){ if (a.name) assetIdByName[a.name.toLowerCase()] = a.id; });

    // Change markers (folded-in punch-list item): which panel each ACCEPTED
    // Stage-3 character look-change takes effect at. panel_index -> [names].
    const changeMarkers = {};
    chars.forEach(function(c){
      if (c.change_status === 'accepted' && typeof c.change_moment_index === 'number' && c.change_moment_index >= 0) {
        (changeMarkers[c.change_moment_index] = changeMarkers[c.change_moment_index] || []).push(c.name);
      }
    });

    // Pass 1 — the Review tab previews the per-gap narrative OUTLINE (what the
    // prose WILL say), produced free during extraction and stored on the fork.
    // (Previously this read narrative summaries off the legacy `sessions` row,
    // which went stale after the Phase-4 narrative-on-fork cutover.) Falls back
    // to any generated summaries on the fork for legacy versions.
    const fkRow = await db.prepare(
      'SELECT narrative_intro_summary, narrative_outro_summary, narrative_sections, ' +
      'narrative_outline, narrative_directions FROM session_forks WHERE id = ?'
    ).get(viewForkId);
    let narrativeByPanel = {};
    let narrativeIntro = '';
    let narrativeOutro = '';
    let introSummary = '';
    let outroSummary = '';
    let gapDirections = {};
    if (fkRow) {
      if (fkRow.narrative_directions) {
        try { gapDirections = JSON.parse(fkRow.narrative_directions) || {}; } catch (e) { gapDirections = {}; }
      }
      let usedOutline = false;
      if (fkRow.narrative_outline) {
        try {
          const ol = JSON.parse(fkRow.narrative_outline);
          if (ol) {
            introSummary = ol.intro || '';
            outroSummary = ol.outro || '';
            if (Array.isArray(ol.sections)) {
              ol.sections.forEach(function(s) {
                if (typeof s.panel_index === 'number') {
                  narrativeByPanel[s.panel_index] = { before_summary: s.before || '', after_summary: s.outline || '' };
                }
              });
            }
            usedOutline = true;
          }
        } catch (e) { usedOutline = false; }
      }
      if (!usedOutline) {
        // Legacy fallback: a version whose narrative predates the outline.
        introSummary = fkRow.narrative_intro_summary || '';
        outroSummary = fkRow.narrative_outro_summary || '';
        if (fkRow.narrative_sections) {
          try {
            const secs = JSON.parse(fkRow.narrative_sections);
            if (Array.isArray(secs)) {
              secs.forEach(function(s) {
                if (typeof s.panel_index === 'number') narrativeByPanel[s.panel_index] = s;
              });
            }
          } catch (e) { narrativeByPanel = {}; }
        }
      }
    }

    // Trim a panel description to a short snippet (~10 words) for the
    // Review tab. The narrative is the through-line; panels are quick
    // reference points along it.
    function snippet(text) {
      if (!text) return '';
      var words = String(text).trim().split(/\s+/);
      if (words.length <= 10) return words.join(' ');
      return words.slice(0, 10).join(' ') + '\u2026';
    }

    // Per moment, run the SAME matching the storyboard uses.
    // Narrative sections are keyed by panel_index = the moment's 0-based
    // position in panel_order sequence (same convention as the PDF layouts).
    const panels = moments.map(function(m, i) {
      const panelText = (m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '');
      const charBlock = imageHelpers.buildCharacterBlock(chars, panelText, m.panel_order);
      const assetBlock = imageHelpers.buildAssetBlock(assets, panelText);
      const combined = imageHelpers.combineRefs(charBlock.refs, assetBlock.refs);
      // Bridge AFTER this panel: prefer the terse summary; fall back to a
      // truncated slice of the prose for sessions generated before the
      // summary field existed.
      const nsec = narrativeByPanel[i];
      let bridge = '';
      if (nsec) {
        if (nsec.after_summary) bridge = nsec.after_summary;
        else if (nsec.after) bridge = snippet(nsec.after);
      }
      let moment = '';
      if (nsec) {
        if (nsec.before_summary) moment = nsec.before_summary;
        else if (nsec.before) moment = snippet(nsec.before);
      }
      // Pass 2 — explicit cast (if this panel has been edited) OR the inferred
      // name-match cast. Either way each entry carries an id so the UI can edit.
      const isExplicit = !!m.cast_explicit;
      let panelChars, panelAssets;
      if (isExplicit) {
        panelChars = castCharByMoment[m.id] || [];
        panelAssets = castAssetByMoment[m.id] || [];
      } else {
        panelChars = charBlock.refs.map(function(r){ return { id: charIdByName[r.name.toLowerCase()], name: r.name }; });
        panelAssets = assetBlock.refs.map(function(r){ return { id: assetIdByName[r.name.toLowerCase()], name: r.name, category: r.category }; });
      }
      return {
        moment_id: m.id,
        panel_order: m.panel_order,
        title: m.title,
        snippet: snippet(m.description),
        type: m.type,
        bridge: bridge,
        moment: moment,
        cast_explicit: isExplicit,
        characters: panelChars,
        assets: panelAssets,
        change_marks: changeMarkers[i] || [],
        total_refs: combined.length
      };
    });

    res.json({
      intro: narrativeIntro,
      intro_summary: introSummary,
      outro: narrativeOutro,
      outro_summary: outroSummary,
      directions: gapDirections,
      panels: panels,
      all_characters: chars.map(function(c){ return { id: c.character_id, name: c.name, cls: c.cls }; })
        .sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }),
      all_assets: assets.map(function(a){ return { id: a.id, name: a.name, category: a.category }; })
        .sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); })
    });
  } catch (e) {
    console.error('session review error:', e.message);
    res.json({ error: 'Could not build the review.' });
  }
});

// ============================================================
// Pass 2 — explicit per-panel casting (Review tab editing)
// ============================================================

// Resolve a moment and confirm the caller OWNS its version (DM on canonical,
// or the player who owns the fork). Returns { id, campaign_id } or null.
async function ownedMoment(db, userId, momentId) {
  const m = await db.prepare(
    'SELECT m.id, m.fork_id, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
    'FROM moments m JOIN sessions s ON m.session_id = s.id ' +
    'JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ?'
  ).get(momentId);
  if (!m) return null;
  if (String(m.fork_owner) !== String(userId)) return null;
  return m;
}

// PUT the explicit cast for a panel. Body: { characterIds:[...], assetIds:[...] }
// Replaces the panel's cast rows and flips cast_explicit = true (materialize).
router.put('/:id/moments/:momentId/cast', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const m = await ownedMoment(db, req.session.userId, req.params.momentId);
  if (!m) return res.status(403).json({ error: 'You can only edit casting on your own version' });

  const characterIds = Array.isArray(req.body && req.body.characterIds) ? req.body.characterIds : [];
  const assetIds = Array.isArray(req.body && req.body.assetIds) ? req.body.assetIds : [];

  // Defense-in-depth: only accept ids that belong to this campaign.
  let validChar = [], validAsset = [];
  if (characterIds.length) {
    const rows = await db.prepare('SELECT id FROM characters WHERE campaign_id = ?').all(m.campaign_id);
    const ok = {}; rows.forEach(function(r){ ok[String(r.id)] = true; });
    validChar = characterIds.filter(function(id){ return ok[String(id)]; });
  }
  if (assetIds.length) {
    const rows = await db.prepare('SELECT id FROM campaign_assets WHERE campaign_id = ?').all(m.campaign_id);
    const ok = {}; rows.forEach(function(r){ ok[String(r.id)] = true; });
    validAsset = assetIds.filter(function(id){ return ok[String(id)]; });
  }

  await db.prepare('DELETE FROM moment_characters WHERE moment_id = ?').run(m.id);
  await db.prepare('DELETE FROM moment_assets WHERE moment_id = ?').run(m.id);
  for (const cid of validChar) {
    await db.prepare('INSERT INTO moment_characters (moment_id, character_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(m.id, cid);
  }
  for (const aid of validAsset) {
    await db.prepare('INSERT INTO moment_assets (moment_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(m.id, aid);
  }
  await db.prepare('UPDATE moments SET cast_explicit = true WHERE id = ?').run(m.id);

  res.json({ success: true, cast_explicit: true, characterIds: validChar, assetIds: validAsset });
});

// DELETE the explicit cast for a panel — reset to auto (name-match inference).
router.delete('/:id/moments/:momentId/cast', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const m = await ownedMoment(db, req.session.userId, req.params.momentId);
  if (!m) return res.status(403).json({ error: 'You can only edit casting on your own version' });
  await db.prepare('DELETE FROM moment_characters WHERE moment_id = ?').run(m.id);
  await db.prepare('DELETE FROM moment_assets WHERE moment_id = ?').run(m.id);
  await db.prepare('UPDATE moments SET cast_explicit = false WHERE id = ?').run(m.id);
  res.json({ success: true, cast_explicit: false });
});

// ============================================================
// PHASE 4 STEP 2 — PLAYER VERSIONS (forks)
// ============================================================

// GET the versions of a session the caller may see: the DM canonical
// fork (always), the caller's own version, and other players' READY
// versions. Returns friendly labels for the member dropdown.
router.get('/:id/forks', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const me = req.session.userId;
  const rows = await db.prepare(
    "SELECT sf.id, sf.user_id, sf.role, sf.player_access_status, u.name AS user_name, u.email AS user_email " +
    "FROM session_forks sf JOIN users u ON u.id = sf.user_id " +
    "WHERE sf.session_id = ? ORDER BY (sf.role = 'dm') DESC, sf.created_at ASC"
  ).all(req.params.id);
  const visible = rows.filter(function(f) {
    return f.role === 'dm' || String(f.user_id) === String(me) || f.player_access_status === 'ready';
  }).map(function(f) {
    const mine = String(f.user_id) === String(me);
    return {
      fork_id: f.id,
      role: f.role,
      status: f.player_access_status,
      is_mine: mine,
      label: f.role === 'dm' ? 'Story Master \u2014 Canonical' : (mine ? 'You (your version)' : (f.user_name || f.user_email || 'Player'))
    };
  });
  res.json(visible);
});

// POST create the caller's own version of a session (lazy — fires only
// when the player clicks "Make My Version"). Requires: caller is a
// PLAYER member, and the DM fork is 'ready'. One version per player per
// session (returns the existing one on re-call). Copies the DM fork's
// moments + character snapshots + narrative; images shared by URL until
// the player regenerates their own.
router.post('/:id/fork', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const sessionId = req.params.id;
  if (req.campaignRole !== 'player') return res.status(403).json({ error: 'Only players make their own version' });
  const dmFork = await db.prepare("SELECT id, player_access_status FROM session_forks WHERE session_id = ? AND role = 'dm'").get(sessionId);
  if (!dmFork) return res.status(404).json({ error: 'Session has no canonical version' });
  if (dmFork.player_access_status !== 'ready') return res.status(423).json({ error: 'This session is not Ready yet' });
  const existing = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ?').get(sessionId, req.session.userId);
  if (existing) return res.json({ fork_id: existing.id, existing: true });
  const now = new Date().toISOString();
  const created = await db.prepare(
    "INSERT INTO session_forks (session_id, user_id, role, player_access_status, narrative_intro, narrative_sections, narrative_outro, narrative_intro_summary, narrative_outro_summary, narrative_style, created_at) " +
    "SELECT ?, ?, 'player', 'draft', narrative_intro, narrative_sections, narrative_outro, narrative_intro_summary, narrative_outro_summary, narrative_style, ? FROM session_forks WHERE id = ?"
  ).run(sessionId, req.session.userId, now, dmFork.id);
  const newForkId = created.lastInsertRowid;
  await db.prepare(
    "INSERT INTO moments (session_id, fork_id, title, description, type, prompt, emphasis, image, panel_order, cast_explicit, created_at, created_by) " +
    "SELECT session_id, ?, title, description, type, prompt, emphasis, image, panel_order, cast_explicit, ?, ? FROM moments WHERE fork_id = ? ORDER BY panel_order ASC"
  ).run(newForkId, now, req.session.userId, dmFork.id);
  await db.prepare(
    "INSERT INTO session_characters (session_id, fork_id, character_id, prompt, change_note, reference_url, change_flag, change_detail, change_moment_index, change_status, created_at) " +
    "SELECT session_id, ?, character_id, prompt, change_note, reference_url, change_flag, change_detail, change_moment_index, change_status, ? FROM session_characters WHERE fork_id = ?"
  ).run(newForkId, now, dmFork.id);
  // Pass 2 — copy explicit per-panel casts, mapping each source moment to the
  // new fork's moment with the same panel_order (unique per fork).
  await db.prepare(
    "INSERT INTO moment_characters (moment_id, character_id) " +
    "SELECT nm.id, mc.character_id FROM moment_characters mc " +
    "JOIN moments om ON om.id = mc.moment_id " +
    "JOIN moments nm ON nm.fork_id = ? AND nm.panel_order = om.panel_order " +
    "WHERE om.fork_id = ? ON CONFLICT DO NOTHING"
  ).run(newForkId, dmFork.id);
  await db.prepare(
    "INSERT INTO moment_assets (moment_id, asset_id) " +
    "SELECT nm.id, ma.asset_id FROM moment_assets ma " +
    "JOIN moments om ON om.id = ma.moment_id " +
    "JOIN moments nm ON nm.fork_id = ? AND nm.panel_order = om.panel_order " +
    "WHERE om.fork_id = ? ON CONFLICT DO NOTHING"
  ).run(newForkId, dmFork.id);
  res.json({ fork_id: newForkId, existing: false });
});

// DELETE a version. Owner may delete their own; DM may delete any
// player version. The DM canonical fork cannot be deleted here.
router.delete('/:id/fork/:forkId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const fork = await db.prepare('SELECT * FROM session_forks WHERE id = ? AND session_id = ?').get(req.params.forkId, req.params.id);
  if (!fork) return res.status(404).json({ error: 'Version not found' });
  if (fork.role === 'dm') return res.status(403).json({ error: 'The canonical version cannot be deleted here' });
  const isOwner = String(fork.user_id) === String(req.session.userId);
  if (!isOwner && req.campaignRole !== 'dm') return res.status(403).json({ error: 'You can only delete your own version' });
  const oldMomImgs = await db.prepare('SELECT image FROM moments WHERE fork_id = ?').all(fork.id);
  const oldRefImgs = await db.prepare('SELECT reference_url FROM session_characters WHERE fork_id = ?').all(fork.id);
  await db.prepare('DELETE FROM moments WHERE fork_id = ?').run(fork.id);
  await db.prepare('DELETE FROM session_characters WHERE fork_id = ?').run(fork.id);
  await db.prepare('DELETE FROM session_forks WHERE id = ?').run(fork.id);
  for (let i = 0; i < oldMomImgs.length; i++) { await releaseImage(db, oldMomImgs[i].image); }
  for (let i = 0; i < oldRefImgs.length; i++) { await releaseImage(db, oldRefImgs[i].reference_url); }
  res.json({ success: true });
});

module.exports = router;
