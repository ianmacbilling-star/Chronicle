const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

function verifyCampaignOwner(req, res, next) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  req.campaign = campaign;
  next();
}

// GET all sessions for a campaign
router.get('/', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date DESC').all(req.params.campaignId);
  res.json(sessions);
});

// GET single session with its moments
router.get('/:id', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const moments = db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(session.id);
  res.json({ ...session, moments });
});

// GET all sessions with moments for graphic novel view
router.get('/novel/all', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(req.params.campaignId);
  const result = sessions.map(function(s) {
    const moments = db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(s.id);
    return { ...s, moments };
  });
  res.json(result);
});

// POST create session
router.post('/', requireAuth, verifyCampaignOwner, function(req, res) {
  const { name, session_date, transcript } = req.body;
  if (!name) return res.json({ error: 'Session name is required' });
  const db = getDb();
  const now = new Date().toISOString();
  const date = session_date || now.split('T')[0];
  const result = db.prepare(
    'INSERT INTO sessions (campaign_id, name, session_date, transcript, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.campaignId, name, date, transcript || '', now, req.session.userId);
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid);
  res.json(session);
});

// PUT update session
router.put('/:id', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE sessions SET name = ?, session_date = ?, transcript = ?, edited_at = ?, edited_by = ? WHERE id = ?'
  ).run(
    req.body.name || session.name,
    req.body.session_date || session.session_date,
    req.body.transcript !== undefined ? req.body.transcript : session.transcript,
    now, req.session.userId, session.id
  );
  const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id);
  res.json(updated);
});

// DELETE session and its moments
router.delete('/:id', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  db.prepare('DELETE FROM moments WHERE session_id = ?').run(session.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  res.json({ success: true });
});

module.exports = router;
