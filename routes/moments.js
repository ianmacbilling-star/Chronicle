const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

async function verifyCampaignOwner(req, res, next) {
  const db = await getDb();
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  next();
}

router.get('/', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(req.params.sessionId);
  res.json(moments);
});

router.post('/', requireAuth, verifyCampaignOwner, async function(req, res) {
  const { title, description, type, prompt, panel_order } = req.body;
  if (!title) return res.json({ error: 'Title required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO moments (session_id, title, description, type, prompt, panel_order, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).run(req.params.sessionId, title, description || '', type || 'drama', prompt || '', panel_order || 0, now, req.session.userId);
  const moment = await db.prepare('SELECT * FROM moments WHERE id=?').get(result.lastInsertRowid);
  res.json(moment);
});

router.delete('/:momentId', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  await db.prepare('DELETE FROM moments WHERE id=? AND session_id=?').run(req.params.momentId, req.params.sessionId);
  res.json({ success: true });
});

module.exports = router;
