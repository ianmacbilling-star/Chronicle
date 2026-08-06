const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork, getDmForkId, getViewableForkId, effectiveIncludeMap, resolveActingFork, requestedForkIdOf, resolveBookVersion, bookForkForSession, prefsVersionId, getOrCreateCanonicalVersion, versionsForCampaign, versionStyleDefaults, versionPriorCharacterLooks } = require('../database/db');
const { releaseImage, deleteFile } = require('../storage/storage');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');
const { checkSessionLimit, getEffectiveTier, tierRank, accessRank, artStyleAllowed } = require('../middleware/tiers');
// v3.0.441 -- Gold is access_rank 3 (TD-194). NOTE the Free Trial carries access_rank 4 by design,
// so a trial member passes this -- deliberate, since trial sits at the TOP of creative access and
// extra versions are a creative feature. Same rule the art styles use.
const GOLD_RANK = 3;
const imageHelpers = require('./images');
const { getTokenCost, canAfford, spendTokens, characterReserveStatus } = require('./tokens');

// GET last used art style and layout style
// Phase 4 Step 3c — resolve which version the caller is acting on: the DM
// acts on the canonical (DM) fork; a player acts on their OWN version.
// Returns null if a player has no version of this session yet.
// v3.0.445 -- delegates to the ONE shared resolver in db.js. This was the first of three private
// copies of the same rule; keeping a local wrapper only so the six call sites below read unchanged.
async function callerForkId(db, sessionId, userId, role, requested) {
  return await resolveActingFork(db, sessionId, userId, role, requested);
}
function requestedForkId(req) { return requestedForkIdOf(req); }

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
  // v3.0.454 -- a named version wins over as_user; see resolveBookVersion in database/db.js.
  const _bv = await resolveBookVersion(db, Number(req.params.campaignId), req);
  const asVersion = _bv ? _bv.versionId : null;
  const asUser = _bv ? _bv.asUser : (req.query.as_user ? Number(req.query.as_user) : null);
  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id=? ORDER BY session_date ASC').all(req.params.campaignId);
  const incMap = await effectiveIncludeMap(db, req.params.campaignId, asUser, prefsVersionId(_bv));
  const asUserRow = asUser ? await db.prepare('SELECT name FROM users WHERE id = ?').get(asUser) : null;
  const asUserName = asUserRow ? asUserRow.name : null;
  const result = await Promise.all(sessions.map(async function(s) {
    // v3.0.454 -- ONE resolver (database/db.js bookForkForSession), the fifth copy of this lookup.
    // usedPlayerFork keeps its meaning: the book is NOT reading the canonical for this session.
    let forkId = await bookForkForSession(db, s.id, { asUser: asUser, versionId: asVersion });
    let usedPlayerFork = false;
    if (forkId) {
      const _dmf = await getDmForkId(db, s.id);
      usedPlayerFork = String(forkId) !== String(_dmf);
    }
    if (!forkId) forkId = await getDmForkId(db, s.id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id=? ORDER BY panel_order ASC').all(forkId);
    const fk = await db.prepare('SELECT player_access_status FROM session_forks WHERE id = ?').get(forkId);
    const _vinfo = await db.prepare(
      'SELECT cv.id, cv.name, cv.is_canonical FROM session_forks sf ' +
      'LEFT JOIN campaign_versions cv ON cv.id = sf.version_id WHERE sf.id = ?'
    ).get(forkId);
    // Card thumbnail: the fork's establishing (title) image, else first panel,
    // else the session-level establishing image. Only ONE image per card.
    let firstMomentImg = null, estImg = null;
    for (let mi = 0; mi < moments.length; mi++) {
      if (moments[mi].image) {
        if (!firstMomentImg) firstMomentImg = moments[mi].image;
        if (moments[mi].kind === 'establishing' && !estImg) estImg = moments[mi].image;
      }
    }
    const first_image_url = firstMomentImg || null;
    const title_image = estImg || s.establishing_image || first_image_url || null;
    return Object.assign({}, s, {
      moments,
      fork_status: fk ? fk.player_access_status : 'draft',
      first_image_url: first_image_url,
      title_image: title_image,
      fork_owner_name: usedPlayerFork ? asUserName : null,
      is_canonical: !usedPlayerFork,
      // v3.0.464 -- NAME THE VERSION THIS TILE IS ACTUALLY READING (TD-263). The owner no longer
      // identifies a book: one person can hold several versions, so "Ian's Version" is true of
      // three different books at once. And because of fallthrough the tiles on one page can come
      // from DIFFERENT versions -- the selected one where it has a fork, the canonical where it
      // does not -- which is exactly the case a reader must be able to see before pressing Order.
      version_id: _vinfo ? _vinfo.id : null,
      version_name: _vinfo ? _vinfo.name : null,
      novel_include: !!incMap[s.id]
    });
  }));
  res.json(result);
});

// GET novel/people - the Story Master + any players who have at least one
// version, for the Graphic Novel page's person picker. Must come before /:id.
router.get('/novel/people', requireAuth, verifyCampaignMember, async function(req, res) {
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
// v3.0.463 -- A NAMED VERSION NEVER WRITES sessions.novel_include (TD-261).
// This route is the STORY MASTER'S CANONICAL curation and it is campaign-wide: it changes what
// every member falls through to. The client used to choose this route by ROLE, so a Story Master
// with "Ian Watercolor" selected in the Publish picker was silently editing the CANONICAL book for
// everyone. The client now chooses by whether the selected version IS the canonical; this refusal
// is the backstop, because a route that can quietly rewrite everyone else's book should not depend
// on the caller getting it right.
router.put('/:id/novel-include', requireAuth, verifyCampaignDM, async function(req, res) {
  {
    const db0 = await getDb();
    const _bv0 = await resolveBookVersion(db0, Number(req.params.campaignId), req);
    if (_bv0 && _bv0.version && !_bv0.version.is_canonical) {
      return res.status(400).json({ error: 'That is a named version, so this choice belongs to it rather than to the canonical book. Use my-novel-include.' });
    }
  }
  const db = await getDb();
  const include = !(req.body && (req.body.include === false || req.body.include === 'false' || req.body.include === 0));
  await db.prepare('UPDATE sessions SET novel_include = ? WHERE id = ? AND campaign_id = ?').run(include, req.params.id, req.params.campaignId);
  res.json({ ok: true, include: include });
});

// Member curation (Phase 2): a player includes/excludes a session for THEIR OWN
// published fork. Keyed to the requester; never affects the SM canonical or other
// members. Absent row = included (members start clean, no SM cascade).
router.put('/:id/my-novel-include', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const include = !(req.body && (req.body.include === false || req.body.include === 'false' || req.body.include === 0));
  const sess = await db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  // v3.0.455 -- the choice belongs to a VERSION. 0 is the base book, which is what every existing
  // row is and what the canonical writes, so an unversioned call behaves exactly as it did.
  // ON CONFLICT names session_includes_scope_key's exact columns -- change one, change both.
  const _ibv = await resolveBookVersion(db, Number(req.params.campaignId), req);
  const _ivid = prefsVersionId(_ibv);
  await db.prepare(
    'INSERT INTO session_includes (user_id, session_id, version_id, include, edited_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ' +
    'ON CONFLICT (user_id, session_id, version_id) DO UPDATE SET include = EXCLUDED.include, edited_at = CURRENT_TIMESTAMP'
  ).run(req.session.userId, req.params.id, _ivid, include);
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
  var listParams = [req.session.userId, req.session.userId, req.params.campaignId];
  if (req.campaignRole !== 'dm') {
    visFilter = " AND ( (SELECT f.player_access_status FROM session_forks f WHERE f.session_id = s.id AND f.role = 'dm' LIMIT 1) = 'ready'" +
      " OR EXISTS (SELECT 1 FROM session_forks fo WHERE fo.session_id = s.id AND fo.user_id = ? AND fo.role = 'player') )";
    listParams.push(req.session.userId);
  }
  const sessions = await db.prepare(
    'SELECT s.*, ' +
    "COALESCE(" +
    "(SELECT m.image FROM moments m WHERE m.fork_id = COALESCE((SELECT pf.id FROM session_forks pf WHERE pf.session_id = s.id AND pf.user_id = ? AND pf.role = 'player' ORDER BY pf.id ASC LIMIT 1),(SELECT df.id FROM session_forks df WHERE df.session_id = s.id AND df.role = 'dm' LIMIT 1)) AND m.kind = 'establishing' AND m.image IS NOT NULL AND m.image <> '' LIMIT 1), " +
    "(SELECT m.image FROM moments m WHERE m.fork_id = COALESCE((SELECT pf.id FROM session_forks pf WHERE pf.session_id = s.id AND pf.user_id = ? AND pf.role = 'player' ORDER BY pf.id ASC LIMIT 1),(SELECT df.id FROM session_forks df WHERE df.session_id = s.id AND df.role = 'dm' LIMIT 1)) AND m.image IS NOT NULL AND m.image <> '' ORDER BY m.panel_order ASC LIMIT 1), " +
    "s.establishing_image) AS title_image_url, " +
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
  const session = await db.prepare(
    'SELECT s.* FROM sessions s WHERE s.id=? AND s.campaign_id=?'
  ).get(req.params.id, req.params.campaignId);
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
  const viewForkRow = await db.prepare('SELECT player_access_status, fork_notes, narrative_intro, narrative_sections, narrative_outro, narrative_outline, narrative_directions, narrative_style, narrative_style_used, narrative_verbosity, art_style_override, version_id FROM session_forks WHERE id=?').get(viewForkId);
  // Set-and-forget defaults: when this user has not chosen a style for THIS session
  // yet, inherit their most recent prior choice in this campaign (per-user; DM forks
  // carry the DM's user_id, so one lookup covers DM and players). Falls back to the
  // generic default only when there is no prior session. Non-destructive -- a default
  // only; it persists once the user picks a style or generates.
  // v3.0.460 -- SCOPED TO THE VERSION, NOT THE USER (TD-252).
  // The old pair keyed on sf.user_id. That was correct while a person held one fork per session;
  // with three versions of session one, all owned by the same person and all carrying the same
  // session date, the ORDER BY had no tiebreak that meant anything and it returned an ARBITRARY
  // row -- then offered that one style to every version alike. Same class as TD-194, third time:
  // a query made correct by a uniqueness assumption we removed.
  //
  // Still a READ-TIME default, still non-destructive: it fills the picker when this fork has made
  // no choice, and the moment someone chooses or generates, the value is stored on the fork and
  // this stops firing. Branch time (above) is what makes it STICK for a new session.
  var _inhNarr = null, _inhArt = null;
  try {
    const _vid = viewForkRow && viewForkRow.version_id;
    if (_vid && (!viewForkRow || !viewForkRow.narrative_style)) {
      const _rn = await db.prepare(
        'SELECT sf.narrative_style FROM session_forks sf JOIN sessions s ON s.id = sf.session_id ' +
        'WHERE sf.version_id = ? AND sf.session_id <> ? ' +
        "AND sf.narrative_style IS NOT NULL AND sf.narrative_style <> '' " +
        'ORDER BY s.session_date DESC, s.created_at DESC, sf.id DESC LIMIT 1'
      ).get(_vid, session.id);
      _inhNarr = _rn ? _rn.narrative_style : null;
    }
    if (_vid && !(viewForkRow && viewForkRow.art_style_override) && !session.art_style) {
      const _ra = await db.prepare(
        'SELECT COALESCE(sf.art_style_override, s.art_style) AS art FROM session_forks sf JOIN sessions s ON s.id = sf.session_id ' +
        'WHERE sf.version_id = ? AND sf.session_id <> ? ' +
        "AND COALESCE(sf.art_style_override, s.art_style) IS NOT NULL AND COALESCE(sf.art_style_override, s.art_style) <> '' " +
        'ORDER BY s.session_date DESC, s.created_at DESC, sf.id DESC LIMIT 1'
      ).get(_vid, session.id);
      _inhArt = _ra ? _ra.art : null;
    }
  } catch (e) { _inhNarr = null; _inhArt = null; }
  // Narrative is per-version now; surface the viewed fork's narrative so the
  // frontend (which reads data.narrative_* from this response) shows the
  // right story for the selected version.
  res.json(Object.assign({}, session, {
    moments,
    fork_id: viewForkId,
    art_style: session.art_style || _inhArt,
    fork_status: viewForkRow ? viewForkRow.player_access_status : (session.player_access_status || 'draft'),
    fork_notes: viewForkRow ? (viewForkRow.fork_notes || '') : '',
    narrative_intro: viewForkRow ? (viewForkRow.narrative_intro || '') : (session.narrative_intro || ''),
    narrative_sections: viewForkRow ? (viewForkRow.narrative_sections || null) : (session.narrative_sections || null),
    narrative_outro: viewForkRow ? (viewForkRow.narrative_outro || '') : (session.narrative_outro || ''),
    narrative_directions: viewForkRow ? (viewForkRow.narrative_directions || null) : null,
    narrative_style: (viewForkRow && viewForkRow.narrative_style) || _inhNarr || 'classic',
    narrative_style_used: viewForkRow ? (viewForkRow.narrative_style_used || null) : null,
    narrative_verbosity: (viewForkRow && viewForkRow.narrative_verbosity) ? viewForkRow.narrative_verbosity : 'med',
    art_style_override: viewForkRow ? (viewForkRow.art_style_override || null) : null
  }));
});

// POST create session
router.post('/', requireAuth, verifyCampaignDM, checkSessionLimit, async function(req, res) {
  const { name, session_date, description } = req.body;
  if (!name || !session_date) return res.json({ error: 'Name and date required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO sessions (campaign_id, name, session_date, description, created_at, created_by) VALUES (?,?,?,?,?,?)'
  ).run(req.params.campaignId, name.trim(), session_date, ((description||'').trim() || null), now, req.session.userId);
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
    'UPDATE sessions SET name=?, session_date=?, description=?, transcript=?, session_notes=?, art_style=?, layout_style=?, edited_at=?, edited_by=? WHERE id=?'
  ).run(
    req.body.name || session.name,
    req.body.session_date || session.session_date,
    req.body.description !== undefined ? req.body.description : session.description,
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
    const effRank = accessRank(await getEffectiveTier(req.session.userId, req.params.campaignId));
    if (!artStyleAllowed(effRank, artStyle)) {
      return res.status(403).json({ error: "That art style isn't available on your current plan. Pick another, or upgrade for more styles.", code: 'STYLE_LOCKED' });
    }
  }
  const now = new Date().toISOString();
  // v3.0.443 -- BRANCH ON THE VERSION, NOT ON THE ROLE (TD-194).
  // This asked "is the caller the Story Master?" and, if so, wrote the CANONICAL session art style.
  // That was the same question as "is this the canonical version?" while a Story Master had exactly
  // one version. It is not any more: a Story Master picking a style on their own second version was
  // writing it to the canonical, changing every version of that session at once.
  // Resolve which version is being acted on FIRST, then let the version decide where the write goes.
  const forkId = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole, requestedForkId(req));
  if (!forkId) return res.status(403).json({ error: 'You have no version of this session' });
  const actRow = await db.prepare('SELECT role FROM session_forks WHERE id = ?').get(forkId);
  if (actRow && actRow.role === 'dm') {
    await db.prepare('UPDATE sessions SET art_style=?, edited_at=?, edited_by=? WHERE id=?')
      .run(artStyle, now, req.session.userId, req.params.id);
    return res.json({ success: true, scope: 'session', art_style: artStyle });
  }
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
  // v3.0.443 -- the version being marked Ready is the one on screen, not "the canonical if you are
  // the Story Master". Those were the same thing with one version each; with several they are not.
  let targetForkId = await callerForkId(db, session.id, req.session.userId, req.campaignRole, requestedForkId(req));
  if (targetForkId) { /* the requested version, already ownership-checked */ }
  else if (req.campaignRole === 'dm') {
    targetForkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id=? AND user_id=? ORDER BY id ASC').get(session.id, req.session.userId);
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
  // v3.0.443 -- notes belong to the version on screen. Same reasoning as access-status above.
  let forkId = await callerForkId(db, session.id, req.session.userId, req.campaignRole, requestedForkId(req));
  if (forkId) { /* the requested version, already ownership-checked */ }
  else if (req.campaignRole === 'dm') {
    forkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id=? AND user_id=? ORDER BY id ASC').get(session.id, req.session.userId);
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
  const fork = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole, requestedForkId(req));
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

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole, requestedForkId(req));
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
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
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

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole, requestedForkId(req));
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
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }

    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    // Empty style => no style prefix; submitRetouch keeps the existing look and
    // changes only the instruction. A failure throws to the catch -> no spend.
    const sub = await imageHelpers.submitRetouch(baseImage, instruction.trim(), '', falKey, webhookUrl, null, 'reference');
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

    const fork = await callerForkId(db, sessionId, req.session.userId, req.campaignRole, requestedForkId(req));
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

    // 2. NOTHING IS WRITTEN FORWARD. (v3.0.467, TD-269.)
    //
    // WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It pushed the accepted look into every LATER
    // session, choosing the forks by req.campaignRole:
    //     dm     -> WHERE sf.role = 'dm'      (every later CANONICAL fork)
    //     player -> WHERE sf.user_id = ?      (every later fork of that person's)
    // Ian is a Story Master, so accepting a change INSIDE his Watercolor version asked "is this
    // person the DM" -- yes -- and wrote the dark Frumble into the CANONICAL's sessions 12 and 16.
    // The comment it replaced said "Neither ever touches the other's content", which was true when
    // a Story Master had exactly one fork per session. The player branch was wrong the same way:
    // a reader with two versions propagated a change into BOTH.
    //
    // AND THE PUSH ITSELF IS THE WRONG MODEL. Ian, 2026-08-06: "If you change a character on
    // session 2 it shouldn't push that character forward to newer sessions 3, 4, etc. If those
    // sessions get regenerated then yes, the character would pull in, but we don't do it
    // automatically." A change belongs to the session it happened in. Later sessions PULL the
    // current look when they are built -- resolveCarryForward at extraction, and the branch-time
    // seeding added in v3.0.466 -- so the continuity still works and it works one way.
    //
    // Retroactively rewriting sessions a reader has already reviewed is the surprising half, and
    // removing it removes a whole class of cross-version accident with it.
    res.json({ success: true, forwarded: 0 });
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
    const fork = await callerForkId(db, req.params.id, req.session.userId, req.campaignRole, requestedForkId(req));
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
      'SELECT id, title, description, type, prompt, panel_order, cast_explicit, kind FROM moments WHERE fork_id = ? ORDER BY panel_order ASC'
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
      'narrative_outline, narrative_directions, narrative_outlines FROM session_forks WHERE id = ?'
    ).get(viewForkId);
    let narrativeByPanel = {};
    let narrativeIntro = '';
    let narrativeOutro = '';
    let introSummary = '';
    let outroSummary = '';
    let gapDirections = {};
    let gapOutlines = {};
    if (fkRow) {
      if (fkRow.narrative_directions) {
        try { gapDirections = JSON.parse(fkRow.narrative_directions) || {}; } catch (e) { gapDirections = {}; }
      }
      if (fkRow.narrative_outlines) {
        try { gapOutlines = JSON.parse(fkRow.narrative_outlines) || {}; } catch (e) { gapOutlines = {}; }
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
      const nsec = narrativeByPanel[m.panel_order];
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
        kind: m.kind,
        title: m.title,
        snippet: snippet(m.description),
        description: m.description || '',
        prompt: m.prompt || '',
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

    var effectiveOutlines = {};
    var _effOut = function(key, fb) {
      var st = gapOutlines[key];
      var ed = (st && typeof st === 'object') ? !!st.edited : (typeof st === 'string' && st.length > 0);
      var tx = (st && typeof st === 'object') ? (st.text || '') : (st || '');
      effectiveOutlines[key] = ed ? tx : (fb || '');
    };
    _effOut('opening', introSummary);
    _effOut('closing', outroSummary);
    panels.forEach(function(p, i) {
      var ns = narrativeByPanel[p.panel_order];
      _effOut('moment:' + i, ns ? (ns.before_summary || '') : '');
      _effOut('between:' + i, ns ? (ns.after_summary || '') : '');
    });
    res.json({
      intro: narrativeIntro,
      intro_summary: introSummary,
      outro: narrativeOutro,
      outro_summary: outroSummary,
      directions: gapDirections,
      outlines: effectiveOutlines,
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
    // v3.0.441 -- sf.name is the reader's own label for this version (TD-194). The id tiebreaker
    // matters now that one user can hold several: two created in the same second would otherwise
    // swap places between page loads.
    // v3.0.458 -- THE NAME COMES FROM THE VERSION, not from the fork. Reading sf.name is what let
    // the Session page and the Publish page disagree: the legacy rename wrote sf.name only, so one
    // screen said "Ian Watercolor" and the other said "Ian Anime" about the same book.
    "SELECT sf.id, sf.user_id, sf.role, sf.player_access_status, sf.version_id, " +
    "COALESCE(cv.name, sf.name) AS name, cv.is_canonical, u.name AS user_name, u.email AS user_email " +
    "FROM session_forks sf JOIN users u ON u.id = sf.user_id " +
    "LEFT JOIN campaign_versions cv ON cv.id = sf.version_id " +
    "WHERE sf.session_id = ? ORDER BY (sf.role = 'dm') DESC, sf.created_at ASC, sf.id ASC"
  ).all(req.params.id);
  const visible = rows.filter(function(f) {
    return f.role === 'dm' || String(f.user_id) === String(me) || f.player_access_status === 'ready';
  }).map(function(f) {
    const mine = String(f.user_id) === String(me);
    return {
      fork_id: f.id,
      version_id: f.version_id || null,
      user_id: f.user_id,
      role: f.role,
      status: f.player_access_status,
      is_mine: mine,
      name: f.name || null,
      // v3.0.441 -- OWNER first, then the version name. With several versions per person the owner
      // alone no longer identifies a row, and a bare version name loses whose it is -- which matters
      // the moment a Story Master is looking down a member's list.
      label: (function () {
        var who = f.role === 'dm' ? 'Story Master' : (mine ? 'You' : (f.user_name || f.user_email || 'Player'));
        return f.name ? (who + ' \u2014 ' + f.name) : (f.role === 'dm' ? (who + ' \u2014 Canonical') : (mine ? 'You (your version)' : who));
      })()
    };
  });
  res.json(visible);
});

// v3.0.456 -- the CAMPAIGN-level version list for the session on screen (TD-242 Model B). Same
// dropdown, one level up: every version the caller may select, each reporting whether it has its
// OWN representation of this session or is borrowing the canonical.
router.get('/:id/versions', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const list = await versionsForCampaign(db, req.params.campaignId, req.session.userId, req.params.id);
  res.json(list);
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
  // v3.0.441 -- MANY VERSIONS PER PERSON (TD-194). Three rules changed here and one did not.
  // GONE: the player-only check. Ian: a Story Master should be able to hold several versions too,
  // and the first fork of a session is the canonical one. Role is decided below by whether this
  // session already HAS a canonical, not by who is asking.
  // GONE: the early return that handed back an existing fork instead of creating one. That single
  // line WAS the one-version-per-player rule -- pressing the button twice returned the same version
  // both times, which is exactly what it would look like if the button were broken.
  // KEPT: the Ready requirement. A session the Story Master has not published still cannot be
  // forked by anyone.
  const dmFork = await db.prepare("SELECT id, player_access_status FROM session_forks WHERE session_id = ? AND role = 'dm' ORDER BY id ASC").get(sessionId);
  const isFirstEver = !dmFork;
  if (!isFirstEver && dmFork.player_access_status !== 'ready' && req.campaignRole !== 'dm') {
    return res.status(423).json({ error: 'This session is not Ready yet' });
  }
  // v3.0.456 -- THE GATE MOVED UP A LEVEL, AND NARROWED, and both changes matter.
  //
  // COUNTS CAMPAIGN VERSIONS, not forks of this session. Under Model B "your first version is free,
  // extras need Gold" is a statement about the campaign: a version spans sessions, so counting this
  // session's forks would charge someone Gold for their SECOND session in their ONLY version.
  //
  // ONLY FIRES ON CREATE. Adding a session to a version you already own is not a new version -- it
  // is that version acquiring a representation of one more session, and gating it would make a
  // free first version unusable past session one. Branching is free; creating is what costs.
  const _wantsBranch = !!(req.body && req.body.version_id);
  const mineRows = await db.prepare('SELECT id FROM campaign_versions WHERE campaign_id = ? AND user_id = ? AND NOT is_canonical ORDER BY id ASC').all(req.params.campaignId, req.session.userId);
  const mineCount = (mineRows || []).length;
  if (mineCount >= 1 && !_wantsBranch) {
    // EFFECTIVE tier, not the account tier: max(own tier, the campaign Story Master's tier), the
    // same call the art styles use. Ian: "the DM has to be gold or they have to be gold". Extra
    // versions are a per-campaign feature, so inheriting the SM's tier is the right rule here --
    // note getEffectiveTier's own warning that ACCOUNT-level limits must not work this way.
    const effRank = accessRank(await getEffectiveTier(req.session.userId, req.campaignId || (req.campaign && req.campaign.id)));
    if (effRank < GOLD_RANK) {
      return res.status(402).json({
        error: 'Extra versions need Gold. You can upgrade your own plan, or the Story Master of this campaign can upgrade theirs -- either one unlocks it for you here.',
        code: 'FORK_TIER'
      });
    }
  }
  // WHICH VERSION IS BEING COPIED. Ian: the currently selected one, whoever owns it -- copying the
  // canonical would be wrong the moment somebody is iterating on their own version. Validated
  // through getViewableForkId so a caller cannot copy a version they are not allowed to READ.
  let sourceForkId = req.body && req.body.source_fork_id ? Number(req.body.source_fork_id) : null;
  if (sourceForkId) {
    const allowed = await getViewableForkId(db, sessionId, req.session.userId, sourceForkId);
    if (!allowed || String(allowed) !== String(sourceForkId)) {
      return res.status(403).json({ error: 'You cannot copy that version' });
    }
  } else {
    sourceForkId = dmFork ? dmFork.id : null;
  }
  if (!sourceForkId) return res.status(404).json({ error: 'Session has no version to copy' });
  // A NAME is required from the second version onward, because two rows both reading "You" in the
  // dropdown is indistinguishable. The first stays unnamed and keeps the label it has today.
  let forkName = (req.body && typeof req.body.name === 'string') ? req.body.name.trim().slice(0, 60) : '';
  // v3.0.456 -- TWO DIFFERENT ACTS, ONE ENDPOINT (TD-242 Model B).
  //   BRANCH  : body.version_id names an EXISTING campaign version -- give it a representation of
  //             this session. Ian: "the fork is just the session's representation of that version
  //             on that session." No name is asked for, because the version already has one.
  //   CREATE  : no version_id -- make a new campaign version and branch this session into it.
  // Blank names are refused outright rather than defaulted, which is how production ended up with
  // a nameless fork in campaign 14 and staging with none.
  let versionId = (req.body && req.body.version_id) ? Number(req.body.version_id) : null;
  if (versionId) {
    const want = await db.prepare('SELECT id, campaign_id, user_id, name, is_canonical FROM campaign_versions WHERE id = ?').get(versionId);
    if (!want || String(want.campaign_id) !== String(req.params.campaignId)) {
      return res.status(404).json({ error: 'That version does not belong to this campaign' });
    }
    if (want.is_canonical || String(want.user_id) !== String(req.session.userId)) {
      return res.status(403).json({ error: 'You can only add a session to your own version' });
    }
    const dupe = await db.prepare('SELECT id FROM session_forks WHERE version_id = ? AND session_id = ?').get(versionId, sessionId);
    if (dupe) return res.json({ success: true, fork_id: dupe.id, version_id: versionId, already: true });
    forkName = want.name;
  } else if (!isFirstEver) {
    // A caller's FIRST version needs no name -- 'Original' is what the v3.0.439 backfill called
    // every pre-existing one, so a Copper member pressing the button once behaves exactly as it
    // does today. From the second onward a name is required, because two rows both reading
    // "You -- Original" in the dropdown are indistinguishable.
    if (!forkName && mineCount === 0) forkName = 'Original';
    if (!forkName) return res.status(400).json({ error: 'Please name this version.' });
    const clash = await db.prepare('SELECT id FROM campaign_versions WHERE campaign_id = ? AND user_id = ? AND name = ? AND NOT is_canonical')
      .get(req.params.campaignId, req.session.userId, forkName);
    if (clash) return res.status(409).json({ error: 'You already have a version of this campaign called that.' });
    const mkv = await db.prepare(
      'INSERT INTO campaign_versions (campaign_id, user_id, name, is_canonical, created_at) VALUES (?, ?, ?, false, CURRENT_TIMESTAMP)'
    ).run(req.params.campaignId, req.session.userId, forkName);
    versionId = mkv.lastInsertRowid;
  }
  // The FIRST fork a session ever gets is the canonical one -- Ian: "his first fork is the dm fork".
  // Decided from the session, not from the caller's role, and backed by the partial unique index on
  // (session_id) WHERE role='dm' so two canonicals are impossible rather than merely unlikely.
  const newRole = isFirstEver ? 'dm' : 'player';
  const now = new Date().toISOString();
  // v3.0.456 -- WHICH VERSION THIS FORK BELONGS TO (TD-246). A canonical fork joins the campaign's
  // canonical version; a named one joins the campaign version created or named just above.
  const _cvId = await getOrCreateCanonicalVersion(db, req.params.campaignId);
  const _newVersionId = (newRole === 'dm') ? _cvId : versionId;
  // v3.0.456 -- SIX MORE COLUMNS COPIED (TD-250). The previous list carried the five narrative
  // fields and narrative_style and stopped there, which meant a new version silently lost:
  //   art_style_override   -- the per-session art style, reverting to the campaign default
  //   narrative_verbosity  -- and this one CHANGES THE OUTPUT: existing rows were backfilled to
  //                           'high', the column default is 'med', so a copy generated SHORTER
  //                           narrative than the version it was copied from, with nothing said
  //   narrative_outline / narrative_outlines / narrative_directions -- the Review tab's planning
  //                           fields, so a copied version lost its Direction notes
  //   fork_notes
  // For a feature whose point is "try different narrative and art options", starting from a copy
  // that quietly drops the art style, the Direction and the verbosity is the wrong default.
  const created = await db.prepare(
    "INSERT INTO session_forks (session_id, user_id, role, name, version_id, player_access_status, narrative_intro, narrative_sections, narrative_outro, narrative_intro_summary, narrative_outro_summary, narrative_style, narrative_verbosity, narrative_outline, narrative_outlines, narrative_directions, art_style_override, fork_notes, created_at) " +
    "SELECT ?, ?, ?, ?, ?, 'draft', narrative_intro, narrative_sections, narrative_outro, narrative_intro_summary, narrative_outro_summary, narrative_style, narrative_verbosity, narrative_outline, narrative_outlines, narrative_directions, art_style_override, fork_notes, ? FROM session_forks WHERE id = ?"
  ).run(sessionId, req.session.userId, newRole, forkName || null, _newVersionId, now, sourceForkId);
  const newForkId = created.lastInsertRowid;
  // v3.0.460 -- CONTENT FROM THE SOURCE, STYLE FROM THE VERSION (TD-252).
  // The INSERT above copies from sourceForkId, which is right for CONTENT: the moments, the
  // narrative prose and the Direction notes for THIS session exist nowhere else. It is wrong for
  // STYLE when adding a session to a version that already has one -- branching session two into
  // "Ian Watercolor" from session two's CANONICAL fork would have taken the canonical's art style,
  // so the version would render half in watercolour and half in whatever the Story Master used.
  // Applied as an UPDATE rather than folded into the INSERT because it is a DIFFERENT SOURCE ROW,
  // and only where the version actually holds a value -- a brand new version has none, and then
  // the copied source style stands, which is the right starting point.
  try {
    const _vs = await versionStyleDefaults(db, _newVersionId);
    const _sets = [], _vals = [];
    ['art_style_override', 'narrative_style', 'narrative_verbosity'].forEach(function (k) {
      if (_vs[k]) { _sets.push(k + ' = ?'); _vals.push(_vs[k]); }
    });
    if (_sets.length) {
      _vals.push(newForkId);
      await db.prepare('UPDATE session_forks SET ' + _sets.join(', ') + ' WHERE id = ?').run(_vals);   // the wrapper flattens its args (db.js run: args.flat()), so the array IS the param list
    }
  } catch (e) {
    console.error('[versions] style defaults not applied to fork ' + newForkId + ': ' + ((e && e.message) || e));
  }
  await db.prepare(
    // v3.0.462 -- img_w AND img_h ADDED. They were missing from the day this copy was written
    // (v3.0.441). The IMAGE came across and its stored pixel dimensions did not, so momentAspect()
    // fell through to the NOMINAL shape ratio: a wide panel that is really 21:9 was packed as
    // though it were the generic wide aspect. A branched version therefore paginated differently
    // from the version it was copied from, using identical pictures -- which reads as a layout
    // engine fault and is not one.
    //
    // `style` too, found by the guard rather than by reading: it is written in the same statement as
    // the image (images.js `UPDATE moments SET image = ?, style = ?, img_w = ?, img_h = ?`) and
    // records WHICH ART STYLE produced that picture. Carrying the image without it leaves a copy
    // holding a watercolour panel with no record of what made it.
    // THIRD SILENT COLUMN OMISSION FOUND TODAY (TD-250 was six on session_forks; this is two on
    // moments). A column-list copy fails SILENTLY when it is incomplete: nothing errors, the row
    // just quietly lacks a field. Hence the build guard that now compares these lists against the
    // table definitions -- the next column anyone adds fails the build instead of shipping.
    "INSERT INTO moments (session_id, fork_id, title, description, type, prompt, emphasis, shape, layout_meta, kind, image, img_w, img_h, style, panel_order, cast_explicit, created_at, created_by) " +
    "SELECT session_id, ?, title, description, type, prompt, emphasis, shape, layout_meta, kind, image, img_w, img_h, style, panel_order, cast_explicit, ?, ? FROM moments WHERE fork_id = ? ORDER BY panel_order ASC"
  ).run(newForkId, now, req.session.userId, sourceForkId);
  await db.prepare(
    "INSERT INTO session_characters (session_id, fork_id, character_id, prompt, change_note, reference_url, change_flag, change_detail, change_moment_index, change_status, created_at) " +
    "SELECT session_id, ?, character_id, prompt, change_note, reference_url, change_flag, change_detail, change_moment_index, change_status, ? FROM session_characters WHERE fork_id = ?"
  ).run(newForkId, now, sourceForkId);
  // v3.0.466 -- SEED THE CHARACTERS FROM THE VERSION, BEFORE ANYTHING CAN BE GENERATED (TD-267).
  // The roster still comes from the SOURCE fork: session two's cast is whoever session two's
  // extraction found, and an earlier session's cast does not decide that. What carries forward is
  // the LOOK -- reference_url and the prompt together, because a description edited to say "broken
  // left horn" has to travel with the picture or the art and the text disagree.
  // Only where the version actually holds that character; everyone else keeps the canonical look
  // already copied above. Done at BRANCH time rather than at generation, deliberately: a reader may
  // go straight from New Version to Generate Images and never run anything that would correct it.
  try {
    const _looks = await versionPriorCharacterLooks(db, _newVersionId, sessionId);
    const _ids = Object.keys(_looks);
    for (let i = 0; i < _ids.length; i++) {
      const _l = _looks[_ids[i]];
      const _sets = [], _vals = [];
      if (_l.reference_url) { _sets.push('reference_url = ?'); _vals.push(_l.reference_url); }
      if (_l.prompt) { _sets.push('prompt = ?'); _vals.push(_l.prompt); }
      if (!_sets.length) continue;
      _vals.push(newForkId, _ids[i]);
      await db.prepare('UPDATE session_characters SET ' + _sets.join(', ') + ' WHERE fork_id = ? AND character_id = ?').run(_vals);
    }
    if (_ids.length) console.log('[versions] fork ' + newForkId + ' seeded ' + _ids.length + ' character look(s) from version ' + _newVersionId);
  } catch (e) {
    console.error('[versions] character seeding failed for fork ' + newForkId + ': ' + ((e && e.message) || e));
  }

  // Pass 2 — copy explicit per-panel casts, mapping each source moment to the
  // new fork's moment with the same panel_order (unique per fork).
  await db.prepare(
    "INSERT INTO moment_characters (moment_id, character_id) " +
    "SELECT nm.id, mc.character_id FROM moment_characters mc " +
    "JOIN moments om ON om.id = mc.moment_id " +
    "JOIN moments nm ON nm.fork_id = ? AND nm.panel_order = om.panel_order " +
    "WHERE om.fork_id = ? ON CONFLICT DO NOTHING"
  ).run(newForkId, sourceForkId);
  await db.prepare(
    "INSERT INTO moment_assets (moment_id, asset_id) " +
    "SELECT nm.id, ma.asset_id FROM moment_assets ma " +
    "JOIN moments om ON om.id = ma.moment_id " +
    "JOIN moments nm ON nm.fork_id = ? AND nm.panel_order = om.panel_order " +
    "WHERE om.fork_id = ? ON CONFLICT DO NOTHING"
  ).run(newForkId, sourceForkId);
  res.json({ fork_id: newForkId, existing: false, name: forkName || null, role: newRole, copied_from: sourceForkId });
});

// v3.0.441 -- RENAME a version (TD-194). Own versions only, including the canonical if the caller
// owns it -- that is how the unnamed originals get names, so no data migration is needed beyond the
// one-off backfill in db.js. A blank name clears back to the default label.
router.patch('/:id/fork/:forkId/name', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const fork = await db.prepare('SELECT id, user_id FROM session_forks WHERE id = ? AND session_id = ?').get(req.params.forkId, req.params.id);
  if (!fork) return res.status(404).json({ error: 'Version not found' });
  if (String(fork.user_id) !== String(req.session.userId)) {
    return res.status(403).json({ error: 'You can only rename your own versions' });
  }
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim().slice(0, 60) : '';
  if (name) {
    const clash = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND name = ? AND id <> ?')
      .get(req.params.id, req.session.userId, name, fork.id);
    if (clash) return res.status(409).json({ error: 'You already have a version of this session called that.' });
  }
  // v3.0.458 -- WRITES THE VERSION, then mirrors. This endpoint is superseded by
  // PATCH /campaigns/:id/versions/:versionId and the client no longer calls it, but it stays
  // reachable, so it must not be able to recreate the split it caused: writing sf.name alone is
  // what made one book carry two names and what the boot backfill then turned into a phantom.
  const _fv = await db.prepare('SELECT version_id FROM session_forks WHERE id = ?').get(fork.id);
  if (_fv && _fv.version_id) {
    await db.prepare('UPDATE campaign_versions SET name = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(name || 'Original', _fv.version_id);
    await db.prepare('UPDATE session_forks SET name = ? WHERE version_id = ?').run(name || 'Original', _fv.version_id);
  } else {
    await db.prepare('UPDATE session_forks SET name = ? WHERE id = ?').run(name || null, fork.id);
  }
  res.json({ success: true, fork_id: fork.id, name: name || null });
});

// v3.0.461 -- REMOVE ONE SESSION FROM A VERSION. This deletes a FORK, never a version: the
// campaign_versions row survives and every other session it holds is untouched. The session simply
// stops having a representation in that version and falls through to the canonical again -- the
// exact inverse of the branch added in v3.0.459.
//
// TWO RULE CHANGES, both Ian's, 2026-08-06:
//   * OWN ONLY. It used to read `if (!isOwner && req.campaignRole !== 'dm')`, so a Story Master
//     could delete any member's version. Ian: "You should only be able to delete your own (UserID)
//     ... not someone else's." NOTE THE COST, deliberately accepted: an SM can no longer clean up
//     a departed member's fork. If that is ever needed it wants its own route and its own warning,
//     not a quiet exception here.
//   * CANONICAL NEVER. Already true via role, and now ALSO checked on the version row -- the
//     canonical is what every other version falls through to, so losing it would strand all of
//     them. Two cheap checks for a failure with no recovery.
//
// ?delete_version=1 additionally removes the campaign version, and is only honoured when this was
// its LAST fork. The client asks first; the server refuses to infer intent from an empty version.
router.delete('/:id/fork/:forkId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const fork = await db.prepare('SELECT * FROM session_forks WHERE id = ? AND session_id = ?').get(req.params.forkId, req.params.id);
  if (!fork) return res.status(404).json({ error: 'Version not found' });
  if (fork.role === 'dm') return res.status(403).json({ error: 'The canonical version cannot be deleted here' });
  if (fork.version_id) {
    const _vrow = await db.prepare('SELECT is_canonical FROM campaign_versions WHERE id = ?').get(fork.version_id);
    if (_vrow && _vrow.is_canonical) return res.status(403).json({ error: 'The canonical version cannot be deleted here' });
  }
  if (String(fork.user_id) !== String(req.session.userId)) {
    return res.status(403).json({ error: 'You can only delete your own versions' });
  }
  const oldMomImgs = await db.prepare('SELECT image FROM moments WHERE fork_id = ?').all(fork.id);
  const oldRefImgs = await db.prepare('SELECT reference_url FROM session_characters WHERE fork_id = ?').all(fork.id);
  await db.prepare('DELETE FROM moments WHERE fork_id = ?').run(fork.id);
  await db.prepare('DELETE FROM session_characters WHERE fork_id = ?').run(fork.id);
  await db.prepare('DELETE FROM session_forks WHERE id = ?').run(fork.id);
  for (let i = 0; i < oldMomImgs.length; i++) { await releaseImage(db, oldMomImgs[i].image); }
  for (let i = 0; i < oldRefImgs.length; i++) { await releaseImage(db, oldRefImgs[i].reference_url); }

  // Was that the version's last session? An empty version is legal -- Ian: "If they keep it then
  // they can still use it later on another session" -- so it is only removed when ASKED for.
  let remaining = null, versionDeleted = false;
  if (fork.version_id) {
    const c = await db.prepare('SELECT COUNT(*)::int AS n FROM session_forks WHERE version_id = ?').get(fork.version_id);
    remaining = c ? Number(c.n) : 0;
    const wantDelete = String((req.query && req.query.delete_version) || '') === '1';
    if (wantDelete && remaining === 0) {
      // Everything else keyed to this version goes with it. Left behind, these become exactly the
      // orphans the v3.0.458 repair had to clean up after -- and fork_book_prefs holds the approved
      // layout and the saved PDF, so an abandoned row also keeps R2 objects alive forever.
      try {
        const pr = await db.prepare('SELECT prefs FROM fork_book_prefs WHERE version_id = ?').all(fork.version_id);
        for (let i = 0; i < pr.length; i++) {
          let lo = null;
          try { lo = (JSON.parse(pr[i].prefs) || {}).lastOptimized || null; } catch (e) {}
          if (!lo) continue;
          for (const k in lo) {
            // Best effort, and LOGGED -- a silent failed delete is TD-120, an orphan nobody sees
            // until a storage bill.
            if (lo[k] && lo[k].pdfUrl) { try { await deleteFile(lo[k].pdfUrl); } catch (e) { console.error('[versions] orphan pdf left in place: ' + ((e && e.message) || e)); } }
            if (lo[k] && lo[k].bodyUrl) { try { await deleteFile(lo[k].bodyUrl); } catch (e) { console.error('[versions] orphan layout left in place: ' + ((e && e.message) || e)); } }
          }
        }
      } catch (e) { console.error('[versions] approved-book cleanup skipped: ' + ((e && e.message) || e)); }
      await db.prepare('DELETE FROM fork_book_prefs WHERE version_id = ?').run(fork.version_id);
      await db.prepare('DELETE FROM session_includes WHERE version_id = ?').run(fork.version_id);
      await db.prepare('DELETE FROM campaign_versions WHERE id = ? AND NOT is_canonical').run(fork.version_id);
      versionDeleted = true;
    }
  }
  res.json({ success: true, version_id: fork.version_id || null, remaining: remaining, version_deleted: versionDeleted });
});

module.exports = router;
