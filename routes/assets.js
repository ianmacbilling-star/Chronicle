const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM } = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../storage/storage');
const multer = require('multer');
const path = require('path');

// Memory storage — we push to the R2 storage layer ourselves.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  }
});
const uploadSingle = upload.single('image');

// Valid asset categories for v1.
const CATEGORIES = ['location', 'npc', 'item'];
function cleanCategory(c) {
  c = String(c || '').toLowerCase().trim();
  return CATEGORIES.indexOf(c) !== -1 ? c : 'location';
}

async function handleAssetUpload(file, oldUrl) {
  if (!file) return null;
  if (oldUrl) {
    try { await deleteFile(oldUrl); } catch (e) { /* non-fatal */ }
  }
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = 'asset-' + Date.now() + ext;
  return await uploadFile(file.buffer, filename, file.mimetype);
}

// GET all assets for a campaign.
router.get('/', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const assets = await db.prepare(
      'SELECT * FROM campaign_assets WHERE campaign_id = ? ORDER BY created_at ASC'
    ).all(req.params.campaignId);
    res.json(assets);
  } catch (e) {
    console.error('list assets error:', e.message);
    res.json({ error: 'Could not load assets.' });
  }
});

// POST create a new asset (with image upload).
router.post('/', requireAuth, verifyCampaignDM, uploadSingle, async function(req, res) {
  const name = (req.body && req.body.name || '').trim();
  const category = cleanCategory(req.body && req.body.category);
  if (!name) return res.json({ error: 'Asset name is required' });

  try {
    const db = await getDb();
    let imageUrl = null;
    if (req.file) imageUrl = await handleAssetUpload(req.file, null);
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_assets (campaign_id, name, category, image_url, created_at, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name, category, imageUrl, now, req.session.userId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(result.lastInsertRowid);
    res.json(asset);
  } catch (e) {
    console.error('create asset error:', e.message);
    res.json({ error: 'Could not create the asset.' });
  }
});

// PUT update an asset's name/category, and optionally replace the image.
router.put('/:assetId', requireAuth, verifyCampaignDM, uploadSingle, async function(req, res) {
  try {
    const db = await getDb();
    const existing = await db.prepare(
      'SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?'
    ).get(req.params.assetId, req.params.campaignId);
    if (!existing) return res.status(404).json({ error: 'Asset not found' });

    const name = (req.body && req.body.name || '').trim() || existing.name;
    const category = req.body && req.body.category
      ? cleanCategory(req.body.category)
      : existing.category;
    let imageUrl = existing.image_url;
    if (req.file) imageUrl = await handleAssetUpload(req.file, existing.image_url);

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE campaign_assets SET name = ?, category = ?, image_url = ?, edited_at = ?, edited_by = ? ' +
      'WHERE id = ?'
    ).run(name, category, imageUrl, now, req.session.userId, req.params.assetId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(req.params.assetId);
    res.json(asset);
  } catch (e) {
    console.error('update asset error:', e.message);
    res.json({ error: 'Could not update the asset.' });
  }
});

// DELETE an asset (and its image from storage).
router.delete('/:assetId', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const existing = await db.prepare(
      'SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?'
    ).get(req.params.assetId, req.params.campaignId);
    if (!existing) return res.status(404).json({ error: 'Asset not found' });

    if (existing.image_url) {
      try { await deleteFile(existing.image_url); } catch (e) { /* non-fatal */ }
    }
    await db.prepare('DELETE FROM campaign_assets WHERE id = ?').run(req.params.assetId);
    res.json({ success: true });
  } catch (e) {
    console.error('delete asset error:', e.message);
    res.json({ error: 'Could not delete the asset.' });
  }
});

module.exports = router;
