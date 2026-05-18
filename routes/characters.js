const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../storage/storage');
const multer = require('multer');
const path = require('path');

// Use memory storage - we handle the upload ourselves via storage layer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  }
});

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

async function handleFileUpload(files, fieldname, oldUrl) {
  if (!files || !files[fieldname] || !files[fieldname][0]) return null;
  const file = files[fieldname][0];
  // Delete old file if exists
  if (oldUrl) await deleteFile(oldUrl);
  // Generate unique filename
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = 'char-' + Date.now() + '-' + fieldname + ext;
  return await uploadFile(file.buffer, filename, file.mimetype);
}

// GET all characters
router.get('/', requireAuth, verifyCampaignOwner, async function(req, res) {
  const db = await getDb();
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ? ORDER BY created_at ASC').all(req.params.campaignId);
  res.json(characters);
});

// POST create character
router.post('/', requireAuth, verifyCampaignOwner, uploadFields, async function(req, res) {
  const { name, player_name, cls, description } = req.body;
  if (!name) return res.json({ error: 'Character name is required' });

  try {
    const db = await getDb();
    const now = new Date().toISOString();

    const image = await handleFileUpload(req.files, 'image', null);
    const image_portrait = await handleFileUpload(req.files, 'image_portrait', null);
    const image_fullbody = await handleFileUpload(req.files, 'image_fullbody', null);
    const image_action = await handleFileUpload(req.files, 'image_action', null);
    const image_other = await handleFileUpload(req.files, 'image_other', null);

    const result = await db.prepare(
      'INSERT INTO characters (campaign_id, name, player_name, cls, description, image, image_portrait, image_fullbody, image_action, image_other, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name.trim(), player_name || '', cls || 'Adventurer', description || '', image, image_portrait, image_fullbody, image_action, image_other, now, req.session.userId);

    const character = await db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
    res.json(character);
  } catch(e) {
    console.error('Character create error:', e.message);
    res.json({ error: e.message });
  }
});

// PUT update character
router.put('/:id', requireAuth, verifyCampaignOwner, uploadFields, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    const now = new Date().toISOString();
    const imageFields = ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other'];
    const images = {};

    for (const field of imageFields) {
      if (req.body['clear_' + field] === 'true') {
        await deleteFile(char[field]);
        images[field] = null;
      } else if (req.files && req.files[field] && req.files[field][0]) {
        images[field] = await handleFileUpload(req.files, field, char[field]);
      } else {
        images[field] = char[field];
      }
    }

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
  } catch(e) {
    console.error('Character update error:', e.message);
    res.json({ error: e.message });
  }
});

// DELETE character
router.delete('/:id', requireAuth, verifyCampaignOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Delete all images
    for (const field of ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other']) {
      await deleteFile(char[field]);
    }

    await db.prepare('DELETE FROM characters WHERE id = ?').run(char.id);
    res.json({ success: true });
  } catch(e) {
    res.json({ error: e.message });
  }
});

module.exports = router;
