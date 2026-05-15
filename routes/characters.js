const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOADS_DIR); },
  filename: function(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, 'char-' + Date.now() + ext);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  }
});

// Verify campaign belongs to user
function verifyCampaignOwner(req, res, next) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  req.campaign = campaign;
  next();
}

// GET all characters for a campaign
router.get('/', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const characters = db.prepare('SELECT * FROM characters WHERE campaign_id = ? ORDER BY created_at ASC').all(req.params.campaignId);
  res.json(characters);
});

// POST create character
router.post('/', requireAuth, verifyCampaignOwner, upload.single('image'), function(req, res) {
  const { name, cls, description } = req.body;
  if (!name) return res.json({ error: 'Character name is required' });

  const db = getDb();
  const now = new Date().toISOString();
  const image = req.file ? '/uploads/' + req.file.filename : null;

  const result = db.prepare(
    'INSERT INTO characters (campaign_id, name, cls, description, image, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.campaignId, name, cls || 'Adventurer', description || '', image, now, req.session.userId);

  const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
  res.json(character);
});

// PUT update character
router.put('/:id', requireAuth, verifyCampaignOwner, upload.single('image'), function(req, res) {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const now = new Date().toISOString();
  let image = char.image;

  if (req.file) {
    if (char.image) {
      const oldPath = path.join(__dirname, '..', char.image);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    image = '/uploads/' + req.file.filename;
  }

  db.prepare(
    'UPDATE characters SET name = ?, cls = ?, description = ?, image = ?, edited_at = ?, edited_by = ? WHERE id = ?'
  ).run(
    req.body.name || char.name,
    req.body.cls || char.cls,
    req.body.description || char.description,
    image, now, req.session.userId, char.id
  );

  const updated = db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
  res.json(updated);
});

// DELETE character
router.delete('/:id', requireAuth, verifyCampaignOwner, function(req, res) {
  const db = getDb();
  const char = db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  if (char.image) {
    const imgPath = path.join(__dirname, '..', char.image);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }

  db.prepare('DELETE FROM characters WHERE id = ?').run(char.id);
  res.json({ success: true });
});

module.exports = router;
