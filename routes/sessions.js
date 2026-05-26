const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { checkSessionLimit } = require('../middleware/tiers');
const imageHelpers = require('./images');

async function verifyCampaignOwner(req, res, next) {
  const db = await getDb();
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  req.campaign = campaign;
  next();
}

// GET last used art style and layout style
router.get('/last-style', requireAuth, verifyCampaignOwner, async function(req, res) {
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
router.get('/novel/all', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id=? ORDER BY session_date ASC').all(req.params.campaignId);
  const result = await Promise.all(sessions.map(async function(s) {
    const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(s.id);
    return Object.assign({}, s, { moments });
  }));
  res.json(result);
});

// GET all sessions
router.get('/', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id=? ORDER BY session_date ASC').all(req.params.campaignId);
  res.json(sessions);
});

// GET single session
router.get('/:id', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT * FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(session.id);
  res.json(Object.assign({}, session, { moments }));
});

// POST create session
router.post('/', requireAuth, verifyCampaignOwner, checkSessionLimit, async function(req, res) {
  const { name, session_date } = req.body;
  if (!name || !session_date) return res.json({ error: 'Name and date required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO sessions (campaign_id, name, session_date, created_at, created_by) VALUES (?,?,?,?,?)'
  ).run(req.params.campaignId, name.trim(), session_date, now, req.session.userId);
  const session = await db.prepare('SELECT * FROM sessions WHERE id=?').get(result.lastInsertRowid);
  res.json(session);
});

// PUT update session
router.put('/:id', requireAuth, verifyCampaignOwner, async function(req, res) {
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

// DELETE session
router.delete('/:id', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare('SELECT * FROM sessions WHERE id=? AND campaign_id=?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!req.body.confirmed) return res.json({ error: 'Confirmation required' });
  await db.prepare('DELETE FROM moments WHERE session_id=?').run(session.id);
  await db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
  res.json({ success: true });
});

// GET session character snapshots (Stage 2)
router.get('/:id/characters', requireAuth, verifyCampaignOwner, async function(req, res) {
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
router.put('/:id/characters/:characterId', requireAuth, verifyCampaignOwner, async function(req, res) {
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
router.post('/:id/characters/:characterId/regenerate-reference', requireAuth, verifyCampaignOwner, async function(req, res) {
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
    const newUrl = await imageHelpers.editReferenceImage(falKey, baseImage, detail, ch.name, modelKey);

    await imageHelpers.logImageGeneration(db, req.session.userId, 'session_reference', characterId);

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
router.post('/:id/characters/:characterId/approve-change', requireAuth, verifyCampaignOwner, async function(req, res) {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const characterId = req.params.characterId;
    const detail = (req.body && req.body.detail) || '';
    const imageUrl = (req.body && req.body.image_url) || null;
    const now = new Date().toISOString();

    const thisSession = await db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    if (!thisSession) return res.json({ error: 'Session not found' });

    const sc = await db.prepare(
      'SELECT * FROM session_characters WHERE session_id = ? AND character_id = ?'
    ).get(sessionId, characterId);
    if (!sc) return res.json({ error: 'Session character not found' });

    // The amended text = current prompt + the approved change detail.
    const baseText = sc.prompt || '';
    const amendedText = detail ? (baseText + '\n\nRECENT CHANGE: ' + detail) : baseText;

    // 1. Lock it into THIS session: approved image + amended text, clear flag.
    await db.prepare(
      'UPDATE session_characters SET prompt = ?, reference_url = ?, change_note = ?, ' +
      'change_flag = ?, change_status = ?, edited_at = ?, edited_by = ? ' +
      'WHERE session_id = ? AND character_id = ?'
    ).run(amendedText, imageUrl, detail, 0, 'accepted', now, req.session.userId, sessionId, characterId);

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
router.post('/:id/characters/:characterId/reject-change', requireAuth, verifyCampaignOwner, async function(req, res) {
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

module.exports = router;
