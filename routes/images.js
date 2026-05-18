const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../database/db');
const { fal } = require('@fal-ai/client');

// ============================================================
// PROVIDER ABSTRACTION LAYER
// To switch providers, only change the generateImage function.
// Everything else in the app stays the same.
// ============================================================

async function generateImage(prompt, style, falKey, charList) {
  fal.config({ credentials: falKey });

  // Style goes FIRST so Flux treats it as primary instruction
  const stylePrefix = getStylePrefix(style);
  const charSection = charList ? '\n\nCHARACTERS (maintain exact appearance throughout): ' + charList : '';
  const fullPrompt = stylePrefix + '\n\n' + prompt + charSection;

  const result = await fal.subscribe('fal-ai/flux/schnell', {
    input: {
      prompt: fullPrompt,
      image_size: 'landscape_4_3',
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true
    }
  });

  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }

  return result.data.images[0].url;
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
  const { moment_id, session_id, campaign_id, prompt, style, fal_key } = req.body;

  if (!fal_key) return res.json({ error: 'fal.ai API key required. Please add it in Settings.' });
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
    const chars = await db.prepare('SELECT name, cls, description FROM characters WHERE campaign_id = (SELECT campaign_id FROM sessions WHERE id = ?)').all(moment.session_id);
    const charList = chars.map(function(c) { return c.name + ' (' + c.cls + '): ' + c.description; }).join('; ');

    const imageUrl = await generateImage(prompt, style, fal_key, charList);
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
  const { session_id, campaign_id, style, fal_key } = req.body;

  if (!fal_key) return res.json({ error: 'fal.ai API key required. Please add it in Settings.' });

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
  const charList = chars.map(function(c) { return c.name + ' (' + c.cls + '): ' + c.description; }).join('; ');

  // Generate all images in parallel
  const results = await Promise.allSettled(
    moments.map(async function(m) {
      try {
        const imageUrl = await generateImage(m.prompt, style, fal_key, charList);
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
