const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, requireCampaignOwner } = require('../middleware/auth');

// GET all campaigns for logged in user
router.get('/', requireAuth, function(req, res) {
  const db = getDb();
  const campaigns = db.prepare(
    'SELECT * FROM campaigns WHERE user_id = ? ORDER BY created_at DESC'
  ).all(req.user.id);
  res.json(campaigns);
});

// GET single campaign
router.get('/:id', requireAuth, requireCampaignOwner, function(req, res) {
  res.json(req.campaign);
});

// POST create campaign
router.post('/', requireAuth, function(req, res) {
  const { name, description, art_style } = req.body;
  if (!name) return res.json({ error: 'Campaign name is required' });

  const db = getDb();
  const now = new Date().toISOString();

  const result = db.prepare(
    'INSERT INTO campaigns (user_id, name, description, art_style, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, name, description || '', art_style || 'High fantasy illustration', now, req.user.id);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);
  res.json(campaign);
});

// PUT update campaign
router.put('/:id', requireAuth, requireCampaignOwner, function(req, res) {
  const { name, description, art_style } = req.body;
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE campaigns SET name = ?, description = ?, art_style = ?, edited_at = ?, edited_by = ? WHERE id = ?'
  ).run(
    name || req.campaign.name,
    description !== undefined ? description : req.campaign.description,
    art_style || req.campaign.art_style,
    now, req.user.id, req.campaign.id
  );

  const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.campaign.id);
  res.json(updated);
});

// DELETE campaign
router.delete('/:id', requireAuth, requireCampaignOwner, function(req, res) {
  const db = getDb();

  // Delete all related data in order
  const sessions = db.prepare('SELECT id FROM sessions WHERE campaign_id = ?').all(req.campaign.id);
  sessions.forEach(function(s) {
    db.prepare('DELETE FROM moments WHERE session_id = ?').run(s.id);
  });
  db.prepare('DELETE FROM sessions WHERE campaign_id = ?').run(req.campaign.id);
  db.prepare('DELETE FROM characters WHERE campaign_id = ?').run(req.campaign.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.campaign.id);

  res.json({ success: true });
});

module.exports = router;
