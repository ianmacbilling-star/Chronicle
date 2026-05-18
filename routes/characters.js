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
    cb(null, 'char-' + Date.now() + '-' + file.fieldname + ext);
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

// Accept up to 4 named image fields
const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image_portrait', maxCount: 1 },
  { name: 'image_fullbody', maxCount: 1 },
  { name: 'image_action', maxCount: 1 },
  { name: 'image_other', maxCount: 1 }
]);

async function verifyCampaignOwner(req, res, next) {
  const db = await getDb();
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });
  req.campaign = campaign;
  next();
}

function getUploadedUrl(files, fieldname) {
  if (files && files[fieldname] && files[fieldname][0]) {
    return '/uploads/' + files[fieldname][0].filename;
  }
  return null;
}

function deleteFile(filePath) {
  if (!filePath) return;
  try {
    const full = path.join(__dirname, '..', filePath);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch(e) {}
}

// GET all characters for a campaign
router.get('/', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ? ORDER BY created_at ASC').all(req.params.campaignId);
  res.json(characters);
});

// POST create character
router.post('/', requireAuth, verifyCampaignOwner, uploadFields, async function(req, res) {
  const { name, player_name, cls, description } = req.body;
  if (!name) return res.json({ error: 'Character name is required' });

  const db = await getDb();
  const now = new Date().toISOString();

  // Legacy single image field support
  const image = getUploadedUrl(req.files, 'image');
  const image_portrait = getUploadedUrl(req.files, 'image_portrait');
  const image_fullbody = getUploadedUrl(req.files, 'image_fullbody');
  const image_action = getUploadedUrl(req.files, 'image_action');
  const image_other = getUploadedUrl(req.files, 'image_other');

  const result = await db.prepare(
    'INSERT INTO characters (campaign_id, name, player_name, cls, description, image, image_portrait, image_fullbody, image_action, image_other, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.campaignId, name, player_name || '', cls || 'Adventurer', description || '', image, image_portrait, image_fullbody, image_action, image_other, now, req.session.userId);

  const character = await db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
  res.json(character);
});

// PUT update character
router.put('/:id', requireAuth, verifyCampaignOwner, uploadFields, async function(req, res) {
  const db = await getDb();
  const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  const now = new Date().toISOString();

  // Handle each image field — keep existing if no new upload
  const imageFields = ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  const images = {};
  imageFields.forEach(function(field) {
    const newUrl = getUploadedUrl(req.files, field);
    if (newUrl) {
      deleteFile(char[field]); // Delete old file
      images[field] = newUrl;
    } else {
      images[field] = char[field]; // Keep existing
    }
  });

  // Handle explicit clear requests (e.g. clear_image_portrait=true)
  imageFields.forEach(function(field) {
    if (req.body['clear_' + field] === 'true') {
      deleteFile(char[field]);
      images[field] = null;
    }
  });

  await db.prepare(
    'UPDATE characters SET name=?, player_name=?, cls=?, description=?, image=?, image_portrait=?, image_fullbody=?, image_action=?, image_other=?, edited_at=?, edited_by=? WHERE id=?'
  ).run(
    req.body.name ? req.body.name.trim() : char.name,
    req.body.player_name !== undefined ? req.body.player_name.trim() : (char.player_name || ''),
    req.body.cls ? req.body.cls.trim() : char.cls,
    req.body.description !== undefined ? req.body.description.trim() : (char.description || ''),
    images.image, images.image_portrait, images.image_fullbody, images.image_action, images.image_other,
    now, req.session.userId, char.id
  );

  const updated = await db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
  res.json(updated);
});

// DELETE character
router.delete('/:id', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
  if (!char) return res.status(404).json({ error: 'Character not found' });

  ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other'].forEach(function(f) {
    deleteFile(char[f]);
  });

  await db.prepare('DELETE FROM characters WHERE id = ?').run(char.id);
  res.json({ success: true });
});

module.exports = router;
