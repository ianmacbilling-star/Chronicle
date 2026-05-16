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

async function generateImage(prompt, style, falKey) {
  // Configure fal client with user's key
  fal.config({ credentials: falKey });

  const styledPrompt = prompt + ', ' + getStyleSuffix(style);

  const result = await fal.subscribe('fal-ai/flux/schnell', {
    input: {
      prompt: styledPrompt,
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

function getStyleSuffix(style) {
  var suffixes = {
    'High fantasy illustration': 'epic fantasy art, highly detailed, dramatic lighting, painterly style, concept art',
    'Dark gritty comic book': 'dark comic book art, heavy inks, gritty noir, dramatic shadows, Frank Miller style',
    'Watercolor painterly': 'beautiful watercolor illustration, loose brushwork, soft colors, artistic, painterly',
    'Anime manga style': 'anime illustration, manga style, vibrant colors, dynamic composition, studio quality',
    'Classic pen and ink': 'detailed pen and ink illustration, crosshatching, black and white with sepia tones, classic fantasy art'
  };
  return suffixes[style] || suffixes['High fantasy illustration'];
}

// ============================================================
// ROUTES
// ============================================================

// POST /api/images/generate-moment
router.post('/generate-moment', requireAuth, async function(req, res) {
  const { moment_id, session_id, campaign_id, prompt, style, fal_key } = req.body;

  if (!fal_key) return res.json({ error: 'fal.ai API key required. Please add it in Settings.' });
  if (!prompt) return res.json({ error: 'Prompt required' });

  const db = getDb();
  const moment = db.prepare(
    'SELECT m.* FROM moments m ' +
    'JOIN sessions s ON m.session_id = s.id ' +
    'JOIN campaigns c ON s.campaign_id = c.id ' +
    'WHERE m.id = ? AND c.user_id = ?'
  ).get(moment_id, req.session.userId);

  if (!moment) return res.status(403).json({ error: 'Access denied' });

  try {
    const imageUrl = await generateImage(prompt, style, fal_key);
    const now = new Date().toISOString();
    db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
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

  const db = getDb();
  const session = db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'WHERE s.id = ? AND c.user_id = ?'
  ).get(session_id, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  const moments = db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(session_id);
  if (!moments.length) return res.json({ error: 'No moments found for this session' });

  // Generate all images in parallel
  const results = await Promise.allSettled(
    moments.map(async function(m) {
      try {
        const imageUrl = await generateImage(m.prompt, style, fal_key);
        const now = new Date().toISOString();
        db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
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
