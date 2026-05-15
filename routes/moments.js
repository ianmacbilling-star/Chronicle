const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

function verifySessionOwner(req, res, next) {
  const db = getDb();
  const session = db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id WHERE s.id = ? AND c.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);
  if (!session) return res.status(403).json({ error: 'Access denied' });
  req.session_record = session;
  next();
}

// GET all moments for a session
router.get('/', requireAuth, verifySessionOwner, function(req, res) {
  const db = getDb();
  const moments = db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(req.params.sessionId);
  res.json(moments);
});

// POST save moments (replaces all existing moments for session)
router.post('/save', requireAuth, verifySessionOwner, function(req, res) {
  const { moments } = req.body;
  if (!moments || !Array.isArray(moments)) return res.json({ error: 'Moments array required' });

  const db = getDb();
  const now = new Date().toISOString();

  // Delete existing moments and replace
  db.prepare('DELETE FROM moments WHERE session_id = ?').run(req.params.sessionId);

  const insert = db.prepare(
    'INSERT INTO moments (session_id, title, description, type, prompt, image, panel_order, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  moments.forEach(function(m, i) {
    insert.run(req.params.sessionId, m.title, m.description, m.type, m.prompt, m.image || null, i, now, req.session.userId);
  });

  const saved = db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(req.params.sessionId);
  res.json(saved);
});

module.exports = router;
