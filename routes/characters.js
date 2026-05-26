const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { uploadFile, deleteFile } = require('../storage/storage');
const imageHelpers = require('./images');
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
  const { name, player_name, cls, description, is_npc } = req.body;
  if (!name) return res.json({ error: 'Character name is required' });

  try {
    const db = await getDb();
    const now = new Date().toISOString();

    const image = await handleFileUpload(req.files, 'image', null);
    const image_portrait = await handleFileUpload(req.files, 'image_portrait', null);
    const image_fullbody = await handleFileUpload(req.files, 'image_fullbody', null);
    const image_action = await handleFileUpload(req.files, 'image_action', null);
    const image_other = await handleFileUpload(req.files, 'image_other', null);

    const npcFlag = (is_npc === true || is_npc === 'true' || is_npc === 1 || is_npc === '1');
    const result = await db.prepare(
      'INSERT INTO characters (campaign_id, name, player_name, cls, description, image, image_portrait, image_fullbody, image_action, image_other, is_npc, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name.trim(), player_name || '', cls || 'Adventurer', description || '', image, image_portrait, image_fullbody, image_action, image_other, npcFlag, now, req.session.userId);

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

    var npcVal = char.is_npc;
    if (req.body.is_npc !== undefined) {
      npcVal = (req.body.is_npc === true || req.body.is_npc === 'true' || req.body.is_npc === 1 || req.body.is_npc === '1');
    }
    await db.prepare(
      'UPDATE characters SET name=?, player_name=?, cls=?, description=?, image=?, image_portrait=?, image_fullbody=?, image_action=?, image_other=?, is_npc=?, edited_at=?, edited_by=? WHERE id=?'
    ).run(
      req.body.name ? req.body.name.trim() : char.name,
      req.body.player_name !== undefined ? req.body.player_name.trim() : (char.player_name || ''),
      req.body.cls ? req.body.cls.trim() : char.cls,
      req.body.description !== undefined ? req.body.description.trim() : (char.description || ''),
      images.image, images.image_portrait, images.image_fullbody, images.image_action, images.image_other,
      npcVal, now, req.session.userId, char.id
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

// POST rebuild canonical character prompt — uses vision on uploaded images
router.post('/:id/rebuild-prompt', requireAuth, verifyCampaignOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    const key = process.env.ANTHROPIC_API_KEY || req.body.key;
    if (!key) return res.json({ error: 'AI service is not configured.' });

    // Collect any uploaded reference images (public R2 URLs) for vision input
    const imageUrls = [char.image_portrait, char.image_fullbody, char.image_action, char.image_other, char.image]
      .filter(function(u) { return u && /^https?:\/\//.test(u); });

    // Build the message content: the images first, then the instruction
    const content = [];
    imageUrls.forEach(function(url) {
      content.push({ type: 'image', source: { type: 'url', url: url } });
    });

    const textInfo =
      'Character name: ' + char.name + '\n' +
      'Class/role: ' + (char.cls || 'Adventurer') + '\n' +
      'Player-written description: ' + (char.description || '(none)') + '\n\n' +
      (imageUrls.length
        ? 'Above are reference image(s) of this character. Study them carefully.'
        : 'No reference images were provided — work from the text description only.') +
      '\n\nWrite a single, tight CANONICAL APPEARANCE PROMPT for this character: a ' +
      'style-neutral physical description used to keep them visually consistent across ' +
      'comic panels. Lead with the most distinctive feature. Include hair, face/build, ' +
      'skin tone, signature outfit and its colors, and any notable gear or markings. ' +
      'Do NOT describe personality, backstory, pose, background, or art style — physical ' +
      'appearance only. 2-4 sentences, dense with concrete visual detail. ' +
      'Return ONLY the description text, no preamble or labels.';

    content.push({ type: 'text', text: textInfo });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: content }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const promptText = data.content.map(function(b) { return b.text || ''; }).join('').trim();
    if (!promptText) return res.json({ error: 'No description was generated.' });

    const now = new Date().toISOString();
    await db.prepare('UPDATE characters SET canonical_prompt = ?, canonical_prompt_at = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(promptText, now, now, req.session.userId, char.id);

    // Also generate a canonical REFERENCE IMAGE from the new prompt.
    // This becomes the character's thumbnail and the Lever 3 anchor.
    // Image failure must NOT fail the whole rebuild — the prompt is saved.
    let referenceUrl = char.canonical_reference_url || null;
    try {
      const falKey = process.env.FAL_API_KEY || req.body.fal_key;
      if (falKey) {
        const modelKey = await imageHelpers.getSelectedModel(db);
        const portrait = char.image_portrait || char.image_fullbody || char.image || null;
        referenceUrl = await imageHelpers.generateReferenceImage(falKey, promptText, portrait, modelKey);
        await db.prepare('UPDATE characters SET canonical_reference_url = ? WHERE id = ?')
          .run(referenceUrl, char.id);
        await imageHelpers.logImageGeneration(db, req.session.userId, 'character_reference', char.id);
      }
    } catch(imgErr) {
      console.error('Canonical reference image failed (non-fatal):', imgErr.message);
    }

    res.json({ success: true, canonical_prompt: promptText, canonical_prompt_at: now, canonical_reference_url: referenceUrl });
  } catch(e) {
    console.error('Rebuild prompt error:', e.message);
    res.json({ error: e.message });
  }
});

// PUT update just the canonical prompt (Platinum manual edit)
router.put('/:id/canonical-prompt', requireAuth, verifyCampaignOwner, async function(req, res) {
  try {
    const { getTier } = require('../middleware/tiers');
    const db = await getDb();
    const user = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tier = getTier(user ? user.tier : 'copper');
    if (!tier.can_edit_prompts) {
      return res.status(403).json({ error: 'Editing character prompts is a Platinum feature.' });
    }
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    const { canonical_prompt } = req.body;
    if (typeof canonical_prompt !== 'string') return res.json({ error: 'Prompt required' });

    const now = new Date().toISOString();
    await db.prepare('UPDATE characters SET canonical_prompt = ?, canonical_prompt_at = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(canonical_prompt, now, now, req.session.userId, char.id);

    res.json({ success: true, canonical_prompt: canonical_prompt, canonical_prompt_at: now });
  } catch(e) {
    res.json({ error: e.message });
  }
});

module.exports = router;
