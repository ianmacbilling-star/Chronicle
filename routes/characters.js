const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember, verifyCampaignDmOrCharacterOwner, isCampaignLocked } = require('../middleware/auth');
const { uploadFile, deleteFile, releaseImage } = require('../storage/storage');
const imageHelpers = require('./images');
const { getTokenCost, canAfford, spendTokens, getBalance, characterReserveStatus } = require('./tokens');
const { checkCharacterLimit } = require('../middleware/tiers');
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

async function handleFileUpload(files, fieldname, oldUrl) {
  if (!files || !files[fieldname] || !files[fieldname][0]) return null;
  const file = files[fieldname][0];
  // Generate unique filename
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = 'char-' + Date.now() + '-' + fieldname + ext;
  return await uploadFile(file.buffer, filename, file.mimetype);
}

// GET all characters
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  // LEFT JOIN to users to resolve owner_user_id → owner_name for the
  // "Played by X" badge on the Characters tab. Owner is NULL for NPCs,
  // unowned PCs, and stub characters still awaiting their invitee.
  const characters = await db.prepare(
    'SELECT c.*, u.name AS owner_name, ' +
    'EXISTS(SELECT 1 FROM campaign_archives ca WHERE ca.character_id = c.id AND ca.fork_id IS NULL AND ca.source_url = c.canonical_reference_url AND ca.archived_by = ?) AS archived ' +
    'FROM characters c ' +
    'LEFT JOIN users u ON u.id = c.owner_user_id ' +
    'WHERE c.campaign_id = ? ORDER BY c.created_at ASC'
  ).all(req.session.userId, req.params.campaignId);
  res.json(characters);
});

// POST create character
router.post('/', requireAuth, verifyCampaignDM, checkCharacterLimit, uploadFields, async function(req, res) {
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
router.put('/:id', requireAuth, verifyCampaignDmOrCharacterOwner, uploadFields, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Phase 3 Deploy 3 — campaign lock check. Players can't canonical-edit
    // once any session is Ready (fork-editing in Phase 4 will replace
    // this path). DM always bypasses the lock.
    if (req.campaignRole === 'player') {
      if (await isCampaignLocked(req.params.campaignId)) {
        return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
      }
    }

    const now = new Date().toISOString();
    const imageFields = ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other'];
    const images = {};
    const oldImages = {};

    for (const field of imageFields) {
      if (req.body['clear_' + field] === 'true') {
        oldImages[field] = char[field];
        images[field] = null;
      } else if (req.files && req.files[field] && req.files[field][0]) {
        oldImages[field] = char[field];
        images[field] = await handleFileUpload(req.files, field);
      } else {
        images[field] = char[field];
      }
    }

    // is_npc toggle stays DM-only — silently preserve the existing value
    // when a player is editing. NPC conversion is a campaign authoring
    // act, not a player one.
    var npcVal = char.is_npc;
    if (req.campaignRole === 'dm' && req.body.is_npc !== undefined) {
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

    // Release replaced/cleared images now that the row points elsewhere
    // (refcounted — a shared reference still in use is spared).
    for (const field of imageFields) {
      if (oldImages[field] && oldImages[field] !== images[field]) await releaseImage(db, oldImages[field]);
    }

    const updated = await db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
    res.json(updated);
  } catch(e) {
    console.error('Character update error:', e.message);
    res.json({ error: e.message });
  }
});

// DELETE character
router.delete('/:id', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // TF-26: clear non-cascading children first so RESTRICT FKs never block the
    // delete. (moment_characters CASCADEs and campaign_archives SET NULLs on their own.)
    await db.prepare('DELETE FROM session_characters WHERE character_id = ?').run(char.id);
    await db.prepare('DELETE FROM campaign_invites WHERE character_id = ?').run(char.id);
    await db.prepare('DELETE FROM characters WHERE id = ?').run(char.id);
    // Release this character's images (refcounted — a generated reference
    // still used by a session snapshot in another fork is spared).
    for (const field of ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other', 'canonical_reference_url']) {
      await releaseImage(db, char[field]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('Character delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST rebuild canonical character prompt — uses vision on uploaded images
router.post('/:id/rebuild-prompt', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Phase 3 Deploy 3 — lock check. Player can't rebuild prompt once
    // any session is Ready. DM bypasses.
    if (req.campaignRole === 'player') {
      if (await isCampaignLocked(req.params.campaignId)) {
        return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
      }
    }
    const key = process.env.ANTHROPIC_API_KEY || req.body.key;
    if (!key) return res.json({ error: 'AI service is not configured.' });

    // Token gate (upfront check): building a character prompt also generates
    // a reference image, which costs tokens. Check affordability BEFORE we
    // call Anthropic or save anything, so a token shortage doesn't leave
    // the user with a half-saved prompt and no image.
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    const modelKey = await imageHelpers.getSelectedModel(db);
    const refCost = await getTokenCost(modelKey);
    if (falKey && !(await canAfford(req.session.userId, refCost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Building a character prompt generates a reference image. Add more tokens to continue.' });
    }
    const _resv = falKey ? await characterReserveStatus(req.session.userId, refCost) : { blocked: false };
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }

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

    // Also generate a canonical REFERENCE IMAGE from the new prompt \u2014 but
    // ASYNC: queue it with our webhook and return the prompt immediately. The
    // webhook attaches the image + spends on success; the client polls for it.
    let imageJobId = null;
    try {
      const webhookUrl = imageHelpers.falWebhookUrl();
      if (falKey && webhookUrl) {
        const portrait = char.image_portrait || char.image_fullbody || char.image || null;
        const sub = await imageHelpers.submitReference(falKey, promptText, portrait, modelKey, webhookUrl);
        const ts = new Date().toISOString();
        const jobIns = await db.prepare(
          'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, refCost, char.canonical_reference_url || null, ts, ts);
        imageJobId = jobIns.lastInsertRowid;
      }
    } catch(imgErr) {
      console.error('Canonical reference image submit failed (non-fatal):', imgErr.message);
    }

    res.json({ success: true, canonical_prompt: promptText, canonical_prompt_at: now, image_job_id: imageJobId });
  } catch(e) {
    console.error('Rebuild prompt error:', e.message);
    res.json({ error: e.message });
  }
});

// PUT update just the canonical prompt. Same access as editing the reference
// image: the DM, or the character's owner (player blocked once a session is Ready).
router.put('/:id/canonical-prompt', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
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

// POST /:id/regenerate-reference — re-roll the canonical reference IMAGE only,
// from the EXISTING canonical prompt. Does NOT rewrite the description (that's
// rebuild-prompt). DM or character owner; player blocked once a session is
// Ready. Costs one image's worth of tokens, spend-on-success.
router.post('/:id/regenerate-reference', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    if (req.campaignRole === 'player' && await isCampaignLocked(req.params.campaignId)) {
      return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
    }
    if (!char.canonical_prompt || !char.canonical_prompt.trim()) {
      return res.json({ error: 'Build the character prompt first, then you can re-roll the reference image.' });
    }
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    if (!falKey) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You’re out of tokens. Re-rolling the reference image costs tokens. Add more to continue.' });
    }
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }
    // Generate from the EXISTING prompt. A failure throws to the catch below,
    // so tokens are never spent on a failed generation.
    const portrait = char.image_portrait || char.image_fullbody || char.image || null;
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const sub = await imageHelpers.submitReference(falKey, char.canonical_prompt, portrait, modelKey, webhookUrl);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, cost, char.canonical_reference_url || null, nowTs, nowTs);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('Regenerate reference error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /:id/retouch-reference — in-context edit of the canonical reference
// image: keep it exactly and change ONLY the typed instruction. Reuses the
// shared retouchImage() helper with NO style prefix (the reference is
// style-neutral). DM or character owner; player blocked once Ready.
router.post('/:id/retouch-reference', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    if (req.campaignRole === 'player' && await isCampaignLocked(req.params.campaignId)) {
      return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
    }
    if (!char.canonical_reference_url) return res.json({ error: 'There is no reference image to retouch yet.' });
    const instruction = req.body.instruction;
    if (!instruction || !String(instruction).trim()) return res.json({ error: 'Describe the change you want.' });
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    if (!falKey) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You’re out of tokens. Add more to keep generating.' });
    }
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }
    // Empty style => no style prefix; retouchImage keeps the existing look and
    // changes only the instruction. Failure throws -> no spend.
    const prevUrl = char.canonical_reference_url;
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const sub = await imageHelpers.submitRetouch(prevUrl, String(instruction).trim(), '', falKey, webhookUrl);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, cost, prevUrl || null, nowTs, nowTs);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('Retouch reference error:', e.message);
    res.json({ error: e.message });
  }
});

module.exports = router;
