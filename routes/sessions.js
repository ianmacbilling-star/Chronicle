const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

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
router.post('/', requireAuth, verifyCampaignOwner, async function(req, res) {
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

module.exports = router;
