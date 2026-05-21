const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getTier } = require('../middleware/tiers');
const { getDb } = require('../database/db');
const { fal } = require('@fal-ai/client');

// ============================================================
// PROVIDER ABSTRACTION LAYER
// To switch providers, only change the generateImage function.
// Everything else in the app stays the same.
// ============================================================

async function generateImage(prompt, style, falKey, charList, seed) {
  fal.config({ credentials: falKey });

  // Style goes FIRST so Flux treats it as primary instruction
  const stylePrefix = getStylePrefix(style);
  const charSection = charList
    ? '\n\n--- RECURRING CHARACTERS (keep their appearance recognizable from panel to panel) ---\n' + charList +
      '\nKeep these characters recognizably consistent — similar faces, hair, and signature outfits — while still letting each panel be its own dynamic scene.'
    : '';
  const fullPrompt = stylePrefix + '\n\n' + prompt + charSection;

  const input = {
    prompt: fullPrompt,
    image_size: 'landscape_4_3',
    num_inference_steps: 4,
    num_images: 1,
    enable_safety_checker: true
  };
  // A stable per-campaign seed keeps the overall look/palette consistent
  // across panels. Different prompts still vary, but the base is anchored.
  if (typeof seed === 'number' && !isNaN(seed)) {
    input.seed = seed;
  }

  const result = await fal.subscribe(process.env.IMAGE_MODEL || 'fal-ai/flux/schnell', {
    input: input
  });

  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }

  return result.data.images[0].url;
}

// Deterministic seed from a campaign id — same campaign, same seed every time.
function campaignSeed(campaignId) {
  var n = parseInt(campaignId, 10);
  if (isNaN(n)) return 12345;
  // Spread the id across the seed space so small ids aren't all clustered.
  return ((n * 2654435761) % 2147483647 + 2147483647) % 2147483647;
}

// Build a structured, emphatic character block. Repeating a tightly
// structured description identically in every panel is the cheapest
// lever for reducing character drift.
function buildCharacterBlock(chars) {
  if (!chars || !chars.length) return '';
  return chars.map(function(c) {
    var parts = [];
    parts.push('• ' + c.name);
    if (c.cls) parts.push('role: ' + c.cls);
    if (c.description) parts.push('appearance: ' + c.description);
    return parts.join(' | ');
  }).join('\n');
}

function getStylePrefix(style) {
  var prefixes = {
    'High fantasy illustration': 'STYLE: Epic high fantasy illustration. Painterly, highly detailed, dramatic cinematic lighting, rich colors, in the style of fantasy concept art and book covers. Detailed backgrounds, heroic compositions.',
    'Dark gritty comic book': 'STYLE: Dark gritty comic book art. Heavy ink lines, deep shadows, high contrast black and white with selective color, noir atmosphere, Frank Miller and Mike Mignola inspired. Gritty textures, dramatic angles.',
    'Watercolor painterly': 'STYLE: Beautiful loose watercolor illustration. Soft wet-on-wet washes, organic flowing color, artistic brushwork, warm earthy tones, delicate linework. Painterly and expressive, like a fantasy storybook.',
    'Anime manga style': 'STYLE: High quality anime illustration. Clean bold linework, vibrant flat colors, dynamic composition, expressive characters, detailed backgrounds, studio Ghibli and JRPG inspired. Cinematic anime framing.',
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework, old parchment tones, reminiscent of vintage fantasy book illustrations and Tolkien-era artwork. Intricate detail.'
  };
  return prefixes[style] || prefixes['High fantasy illustration'];
}

// ============================================================
// ROUTES
// ============================================================

// POST /api/images/generate-moment
router.post('/generate-moment', requireAuth, async function(req, res) {
  const { moment_id, session_id, campaign_id, prompt, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });
  if (!prompt) return res.json({ error: 'Prompt required' });

  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.* FROM moments m ' +
    'JOIN sessions s ON m.session_id = s.id ' +
    'JOIN campaigns c ON s.campaign_id = c.id ' +
    'WHERE m.id = ? AND c.user_id = ?'
  ).get(moment_id, req.session.userId);

  if (!moment) return res.status(403).json({ error: 'Access denied' });

  try {
    // Get characters for this campaign for consistency
    const campRow = await db.prepare('SELECT campaign_id FROM sessions WHERE id = ?').get(moment.session_id);
    const campId = campRow ? campRow.campaign_id : campaign_id;
    const chars = await db.prepare('SELECT name, cls, description FROM characters WHERE campaign_id = ?').all(campId);
    const charList = buildCharacterBlock(chars);

    // Single regenerate = user wants a different take, so use a fresh
    // random seed each time rather than the fixed campaign seed.
    const randomSeed = Math.floor(Math.random() * 2147483647);
    const imageUrl = await generateImage(prompt, style, fal_key, charList, randomSeed);
    const now = new Date().toISOString();
    await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(imageUrl, now, req.session.userId, moment_id);
    res.json({ success: true, image_url: imageUrl, moment_id: moment_id });
  } catch(e) {
    console.error('Image generation error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /api/images/generate-all
router.post('/generate-all', requireAuth, async function(req, res) {
  const { session_id, campaign_id, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });

  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'WHERE s.id = ? AND c.user_id = ?'
  ).get(session_id, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  const moments = await db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(session_id);
  if (!moments.length) return res.json({ error: 'No moments found for this session' });

  // Get characters for consistency across all panels
  const chars = await db.prepare('SELECT name, cls, description FROM characters WHERE campaign_id = ?').all(campaign_id);
  const charList = buildCharacterBlock(chars);

  // Campaign base seed, varied per run: every "Generate all" produces a
  // fresh set of images, but all panels within ONE run share the base
  // (offset per panel) so they stay consistent with each other.
  const baseSeed = (campaignSeed(campaign_id) + Math.floor(Math.random() * 1000000)) % 2147483647;

  // Generate all images in parallel
  const results = await Promise.allSettled(
    moments.map(async function(m) {
      try {
        const panelSeed = (baseSeed + (m.panel_order || 0)) % 2147483647;
        const imageUrl = await generateImage(m.prompt, style, fal_key, charList, panelSeed);
        const now = new Date().toISOString();
        await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
          .run(imageUrl, now, req.session.userId, m.id);
        return { moment_id: m.id, image_url: imageUrl, success: true };
      } catch(e) {
        console.error('Error generating image for moment', m.id, e.message);
        return { moment_id: m.id, error: e.message, success: false };
      }
    })
  );

  const generated = results.map(function(r) { return r.value || { success: false, error: r.reason }; });
  const successCount = generated.filter(function(r) { return r.success; }).length;

  res.json({ success: true, generated: generated, count: successCount, total: moments.length });
});

module.exports = router;
