const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { checkCampaignLimit } = require('../middleware/tiers');

router.get('/', requireAuth, async function(req, res) {
  const db = await getDb();
  const campaigns = await db.prepare('SELECT * FROM campaigns WHERE user_id=? ORDER BY created_at DESC').all(req.session.userId);
  res.json(campaigns);
});

router.post('/', requireAuth, checkCampaignLimit, async function(req, res) {
  const { name, description } = req.body;
  if (!name) return res.json({ error: 'Campaign name required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO campaigns (user_id, name, description, created_at, created_by) VALUES (?,?,?,?,?)'
  ).run(req.session.userId, name.trim(), description || '', now, req.session.userId);

  // Start trial on first campaign creation
  const userCheck = await db.prepare('SELECT trial_started_at FROM users WHERE id = ?').get(req.session.userId);
  if (!userCheck.trial_started_at) {
    await db.prepare('UPDATE users SET trial_started_at = ? WHERE id = ?').run(now, req.session.userId);
  }
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(result.lastInsertRowid);
  res.json(campaign);
});

router.put('/:id', requireAuth, async function(req, res) {
  const db = await getDb();
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  const now = new Date().toISOString();
  await db.prepare('UPDATE campaigns SET name=?, description=?, edited_at=?, edited_by=? WHERE id=?')
    .run(req.body.name || campaign.name, req.body.description !== undefined ? req.body.description : campaign.description, now, req.session.userId, campaign.id);
  const updated = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign.id);
  res.json(updated);
});

router.delete('/:id', requireAuth, async function(req, res) {
  const db = await getDb();
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  await db.prepare('DELETE FROM campaigns WHERE id=?').run(campaign.id);
  res.json({ success: true });
});

module.exports = router;
