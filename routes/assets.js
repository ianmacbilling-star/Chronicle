const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember, verifyCampaignAssetCreator } = require('../middleware/auth');
const { getEffectiveTier, getTier } = require('../middleware/tiers');
const { uploadFile, deleteFile, restoreCopy, releaseImage } = require('../storage/storage');
const multer = require('multer');
const path = require('path');
const imageHelpers = require('./images');
const { getTokenCost, canAfford } = require('./tokens');

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
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
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

// Tier gate: cap assets per campaign by the creating DM's EFFECTIVE tier (max of
// their own tier and the campaign SM's). Returns an error string to send back, or
// null to allow. max_assets === null means unlimited; 0 blocks new assets entirely.
async function assetCapBlock(db, userId, campaignId) {
  try {
    const effName = await getEffectiveTier(userId, campaignId);
    const effTier = getTier(effName);
    const cap = effTier ? effTier.max_assets : null;
    if (cap !== null && cap !== undefined) {
      const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_assets WHERE campaign_id = ?').get(campaignId);
      if (cnt && cnt.c >= cap) {
        return 'This campaign has hit its asset limit of ' + cap + ' on the ' + effTier.name + ' tier. Upgrade for more.';
      }
    }
  } catch (e) {
    console.error('asset cap check error:', e.message);
  }
  return null;
}

// POST create a new asset (with image upload).
router.post('/', requireAuth, verifyCampaignAssetCreator, uploadSingle, async function(req, res) {
  const name = (req.body && req.body.name || '').trim();
  const category = cleanCategory(req.body && req.body.category);
  if (!name) return res.json({ error: 'Asset name is required' });

  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });
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

// POST create an asset FROM an existing archived image. The image is copied to
// a fresh R2 object so the asset owns its bytes independently -- asset deletion
// hard-deletes its image, so it must never share the archive's object.
router.post('/from-archive', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });
    const archiveId = req.body && req.body.archive_id;
    const name = (req.body && req.body.name || '').trim();
    const category = cleanCategory(req.body && req.body.category);
    if (!archiveId) return res.json({ error: 'Missing source image.' });
    if (!name) return res.json({ error: 'Asset name is required' });
    const archive = await db.prepare(
      'SELECT * FROM campaign_archives WHERE id = ? AND campaign_id = ?'
    ).get(archiveId, req.params.campaignId);
    if (!archive || !archive.image_url) return res.status(404).json({ error: 'Source image not found.' });

    let imageUrl;
    try {
      imageUrl = await restoreCopy(archive.image_url);
    } catch (e) {
      console.error('copy-to-asset image copy failed:', e.message);
      return res.json({ error: 'Could not copy the image. Please try again.' });
    }

    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_assets (campaign_id, name, category, image_url, created_at, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name, category, imageUrl, now, req.session.userId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(result.lastInsertRowid);
    res.json(asset);
  } catch (e) {
    console.error('copy-to-asset error:', e.message);
    res.json({ error: 'Could not copy this image to Assets.' });
  }
});

// PUT update an asset's name/category, and optionally replace the image.
// POST generate an asset image FROM a text description ("describe it"). Async:
// create the asset row now (image fills in via the fal webhook), queue a
// text-to-image job, and return immediately. The description is stored so the
// asset can later be Regenerated. Costs 1 token, spent on webhook success.
router.post('/generate', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  const name = (req.body && req.body.name || '').trim();
  const category = cleanCategory(req.body && req.body.category);
  const description = (req.body && req.body.description || '').trim();
  if (!name) return res.json({ error: 'Asset name is required' });
  if (!description) return res.json({ error: 'A description is required to generate an image.' });

  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });

    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });

    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Generating an asset image costs a token. Add more to continue.' });
    }

    // Queue the generation first; only create the asset if the submit succeeds
    // (avoids leaving an image-less orphan asset when fal is unavailable).
    const sub = await imageHelpers.submitAssetReference(falKey, description, category, modelKey, webhookUrl);

    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_assets (campaign_id, name, category, image_url, description, created_at, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name, category, null, description, now, req.session.userId);
    const assetId = result.lastInsertRowid;

    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), assetId, 'asset_ref', 'queued', sub.model, cost, now, now);

    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(assetId);
    res.json({ success: true, queued: true, asset: asset, request_id: sub.request_id, image_job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('generate asset error:', e.message);
    res.json({ error: 'Could not generate the asset image.' });
  }
});

// POST retouch an asset image: apply an instruction to the CURRENT image. Works
// on ANY asset (uploaded, from-archive, or generated). Async; arms one-step
// revert. Costs 1 token, spent on webhook success.
router.post('/:assetId/retouch', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) return res.json({ error: 'Describe the change to make.' });
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.image_url) return res.json({ error: 'This asset has no image to retouch yet.' });
    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Retouching costs a token. Add more to continue.' });
    }
    const sub = await imageHelpers.submitRetouch(asset.image_url, instruction, '', falKey, webhookUrl, null, 'square');
    const now = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), asset.id, 'asset_retouch', 'queued', sub.model, cost, asset.image_url, now, now);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('asset retouch error:', e.message);
    res.json({ error: 'Could not retouch the asset image.' });
  }
});

// POST regenerate an asset image from its stored description (re-roll). Only
// available when the asset has a description. Async; arms one-step revert.
router.post('/:assetId/regenerate', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.description) return res.json({ error: 'This asset has no description to regenerate from.' });
    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Regenerating costs a token. Add more to continue.' });
    }
    const sub = await imageHelpers.submitAssetReference(falKey, asset.description, asset.category, modelKey, webhookUrl);
    const now = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), asset.id, 'asset_ref', 'queued', sub.model, cost, asset.image_url || null, now, now);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('asset regenerate error:', e.message);
    res.json({ error: 'Could not regenerate the asset image.' });
  }
});

// POST revert an asset image: one-deep undo of the last retouch/regenerate.
// Free (no token spend). Restores the retained prior image, releases the current.
router.post('/:assetId/revert', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.revert_image_url) return res.json({ error: 'There is no previous image to revert to.' });
    const current = asset.image_url;
    const now = new Date().toISOString();
    await db.prepare('UPDATE campaign_assets SET image_url = ?, revert_image_url = NULL, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(asset.revert_image_url, now, req.session.userId, asset.id);
    if (current && current !== asset.revert_image_url) await releaseImage(db, current);
    res.json({ success: true, image_url: asset.revert_image_url });
  } catch (e) {
    console.error('asset revert error:', e.message);
    res.json({ error: 'Could not revert the asset image.' });
  }
});

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
