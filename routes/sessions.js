const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');
const { checkSessionLimit } = require('../middleware/tiers');
const imageHelpers = require('./images');
const { getTokenCost, canAfford, spendTokens } = require('./tokens');

// GET last used art style and layout style
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
  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id=? ORDER BY session_date ASC').all(req.params.campaignId);
  const result = await Promise.all(sessions.map(async function(s) {
    const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(s.id);
    return Object.assign({}, s, { moments });
  }));
  res.json(result);
});

// GET all sessions
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  // Phase 3 polish — include the first generated storyboard image with
  // each session for the session-list thumbnail. Subquery picks the
  // moment with the lowest panel_order that has an image URL set. NULL
  // if no images have been generated yet (the row just shows no thumb).
  const sessions = await db.prepare(
    'SELECT s.*, ' +
    '(SELECT image FROM moments m WHERE m.session_id = s.id AND m.image IS NOT NULL AND m.image <> \'\' ORDER BY m.panel_order ASC LIMIT 1) AS first_image_url, ' +
    // Deploy 4.0 — player_access_status now lives on the DM fork. This
    // aliased column comes AFTER s.* so it wins in the row object,
    // keeping the JSON key identical (frontend session-list untouched).
    "(SELECT f.player_access_status FROM session_forks f WHERE f.session_id = s.id AND f.role = 'dm' LIMIT 1) AS player_access_status " +
    'FROM sessions s ' +
    'WHERE s.campaign_id=? ORDER BY s.session_date ASC'
  ).all(req.params.campaignId);
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
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(session.id);
  res.json(Object.assign({}, session, { moments }));
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
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(session.id);
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
router.put('/:id/access-status', requireAuth, verifyCampaignDM, async function(req, res) {
  const ALLOWED = ['draft', 'ready'];
  const status = (req.body && req.body.status) || '';
  if (ALLOWED.indexOf(status) === -1) {
    return res.status(400).json({ error: 'Invalid status. Must be one of: ' + ALLOWED.join(', ') });
  }
  const db = await getDb();
  const session = await db.prepare('SELECT id, campaign_id FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Deploy 4.0 — status lives on the DM fork now (mint if somehow absent).
  const dmForkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  await db.prepare('UPDATE session_forks SET player_access_status=? WHERE id=?').run(status, dmForkId);
  res.json({ success: true, player_access_status: status });
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
  await db.prepare('DELETE FROM moments WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM session_characters WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM session_forks WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
  res.json({ success: true });
});

// GET session character snapshots (Stage 2)
router.get('/:id/characters', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const rows = await db.prepare(
    'SELECT sc.id, sc.character_id, sc.prompt, sc.change_note, sc.edited_at, ' +
    'sc.reference_url, sc.change_flag, sc.change_detail, sc.change_status, sc.change_moment_index, ' +
    'ch.name, ch.cls, ch.is_npc, ch.image_portrait, ch.image, ch.image_fullbody, ch.canonical_reference_url ' +
    'FROM session_characters sc JOIN characters ch ON ch.id = sc.character_id ' +
    'WHERE sc.session_id = ? ORDER BY ch.is_npc ASC, ch.name ASC'
  ).all(req.params.id);
  res.json(rows);
});

// PUT edit a session character snapshot prompt (Platinum only)
router.put('/:id/characters/:characterId', requireAuth, verifyCampaignDM, async function(req, res) {
  const { getTier } = require('../middleware/tiers');
  const db = await getDb();
  const user = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
  const tier = getTier(user ? user.tier : 'copper');
  if (!tier.can_edit_prompts) {
    return res.status(403).json({ error: 'Editing session character prompts is a Platinum feature.' });
  }
  const { prompt } = req.body;
  if (typeof prompt !== 'string') return res.json({ error: 'Prompt required' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE session_characters SET prompt = ?, edited_at = ?, edited_by = ? ' +
    'WHERE session_id = ? AND character_id = ?'
  ).run(prompt, now, req.session.userId, req.params.id, req.params.characterId);

  res.json({ success: true, prompt: prompt });
});

// POST regenerate the reference image for a pending change (draft — not saved).
// Body: { detail } — the (possibly edited) amended-appearance text.
// Returns a new image URL; the DM reviews it, may regenerate again,
// and only Approve commits it.
router.post('/:id/characters/:characterId/regenerate-reference', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const detail = (req.body && req.body.detail) || '';

    const ch = await db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId);
    if (!ch) return res.json({ error: 'Character not found' });

    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE session_id = ? AND character_id = ?'
    ).get(sessionId, characterId);

    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    if (!falKey) return res.json({ error: 'Image generation not configured.' });

    if (!detail || !detail.trim()) {
      return res.json({ error: 'Describe the change before regenerating.' });
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

    const newUrl = await imageHelpers.editReferenceImage(falKey, baseImage, detail, ch.name, modelKey);

    await imageHelpers.logImageGeneration(db, req.session.userId, 'session_reference', characterId);
    // Spend AFTER success — failed generation never reaches here.
    await spendTokens(req.session.userId, cost, {
      related_campaign_id: req.params.campaignId,
      source: 'amendment_reference',
      event_type: 'generation_spend'
    });

    // Return the draft URL — NOT saved as final until Approve.
    res.json({ success: true, image_url: newUrl });
  } catch(e) {
    console.error('regenerate-reference error:', e.message);
    res.json({ error: 'Could not regenerate: ' + e.message });
  }
});

// POST approve a pending change. Body: { detail, image_url }.
// Locks the approved image + text into THIS session, writes the change
// forward into all LATER sessions for this character, clears the flag.
router.post('/:id/characters/:characterId/approve-change', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const detail = (req.body && req.body.detail) || '';
    const imageUrl = (req.body && req.body.image_url) || null;
    // Stage 4: the moment index the change first appears at (DM override).
    let momentIndex = parseInt(req.body && req.body.moment_index, 10);
    if (isNaN(momentIndex) || momentIndex < 0) momentIndex = 0;
    const now = new Date().toISOString();

    const thisSession = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!thisSession) return res.json({ error: 'Session not found' });

    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE session_id = ? AND character_id = ?'
    ).get(sessionId, characterId);
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
      'WHERE session_id = ? AND character_id = ?'
    ).run(amendedText, imageUrl, detail, momentIndex, 0, 'accepted', now, req.session.userId, sessionId, characterId);

    // 2. Write the change FORWARD into all later sessions for this character.
    // Self-contained sessions don't auto-chain, so propagation is explicit.
    const laterRows = await db.prepare(
      'SELECT sc.session_id FROM session_characters sc ' +
      'JOIN sessions s ON sc.session_id = s.id ' +
      'WHERE sc.character_id = ? AND s.campaign_id = ? AND s.session_date > ?'
    ).all(characterId, thisSession.campaign_id, thisSession.session_date);

    for (const row of laterRows) {
      await db.prepare(
        'UPDATE session_characters SET prompt = ?, reference_url = ?, edited_at = ?, edited_by = ? ' +
        'WHERE session_id = ? AND character_id = ?'
      ).run(amendedText, imageUrl, now, req.session.userId, row.session_id, characterId);
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
router.post('/:id/characters/:characterId/reject-change', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE session_characters SET change_flag = ?, change_status = ?, edited_at = ?, edited_by = ? ' +
      'WHERE session_id = ? AND character_id = ?'
    ).run(0, 'rejected', now, req.session.userId, req.params.id, req.params.characterId);
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

    const moments = await db.prepare(
      'SELECT id, title, description, type, prompt, panel_order FROM moments WHERE session_id = ? ORDER BY panel_order ASC'
    ).all(sessionId);

    // Characters for this campaign, joined to this session's snapshots —
    // identical query shape to the storyboard routes.
    const chars = await db.prepare(
      'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
      'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
      'sc.change_note, sc.change_moment_index, sc.change_status ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.session_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(sessionId, campaignId);
    await imageHelpers.attachPriorReferences(db, chars, sessionId, campaignId);

    const assets = await db.prepare(
      'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
    ).all(campaignId);

    // Narrative prose, if Generate Story has produced it. Stored per-panel
    // as a JSON array of { panel_index, before, after, after_summary } on
    // the session. The Review tab uses summaries (terse outline); the
    // storyboard/PDF use the full prose.
    const sessRow = await db.prepare(
      'SELECT narrative_intro, narrative_intro_summary, narrative_sections, ' +
      'narrative_outro, narrative_outro_summary FROM sessions WHERE id = ?'
    ).get(sessionId);
    let narrativeByPanel = {};
    let narrativeIntro = '';
    let narrativeOutro = '';
    let introSummary = '';
    let outroSummary = '';
    if (sessRow) {
      narrativeIntro = sessRow.narrative_intro || '';
      narrativeOutro = sessRow.narrative_outro || '';
      introSummary = sessRow.narrative_intro_summary || '';
      outroSummary = sessRow.narrative_outro_summary || '';
      if (sessRow.narrative_sections) {
        try {
          const secs = JSON.parse(sessRow.narrative_sections);
          if (Array.isArray(secs)) {
            secs.forEach(function(s) {
              if (typeof s.panel_index === 'number') narrativeByPanel[s.panel_index] = s;
            });
          }
        } catch (e) { narrativeByPanel = {}; }
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
      return {
        panel_order: m.panel_order,
        title: m.title,
        snippet: snippet(m.description),
        type: m.type,
        bridge: bridge,
        characters: charBlock.refs.map(function(r) { return r.name; }),
        assets: assetBlock.refs.map(function(r) {
          return { name: r.name, category: r.category };
        }),
        total_refs: combined.length
      };
    });

    res.json({
      intro: narrativeIntro,
      intro_summary: introSummary,
      outro: narrativeOutro,
      outro_summary: outroSummary,
      panels: panels
    });
  } catch (e) {
    console.error('session review error:', e.message);
    res.json({ error: 'Could not build the review.' });
  }
});

module.exports = router;
