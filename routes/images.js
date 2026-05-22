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
    ? '\n\nCHARACTERS IN THIS PANEL (each is a separate, distinct person — do NOT blend their features together; keep each one\'s hair, face, and outfit only on that character):\n' + charList
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

// Build a character block containing ONLY the characters actually present
// in this panel. Sending the full roster to every panel causes the image
// model to merge features between characters ("concept bleed"), so we
// detect presence from the panel text and include just those characters.
function buildCharacterBlock(chars, panelText) {
  if (!chars || !chars.length) return '';
  var text = (panelText || '').toLowerCase();

  // A character is "present" if their name (or first name) appears in the
  // panel's prompt/description text.
  var present = chars.filter(function(c) {
    if (!c.name) return false;
    var full = c.name.toLowerCase();
    var first = full.split(/\s+/)[0];
    return text.indexOf(full) !== -1 || (first.length > 2 && text.indexOf(first) !== -1);
  });

  // If we can't detect anyone (e.g. a scenery panel, or names not mentioned),
  // send nothing rather than the whole roster — an empty block is safer than
  // a bleed-prone one.
  if (!present.length) return '';

  return present.map(function(c) {
    // Keep each character's descriptors tightly bound to their name.
    // Prefer the session snapshot prompt; fall back to the raw description.
    var line = c.name;
    if (c.cls) line += ' (' + c.cls + ')';
    var desc = (c.snapshot_prompt && c.snapshot_prompt.trim())
      ? c.snapshot_prompt
      : (c.canonical_prompt && c.canonical_prompt.trim() ? c.canonical_prompt : c.description);
    if (desc) line += ' — ' + desc;
    return line;
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

// Log one image generation for usage counting. month_key is 'YYYY-MM'.
// source = what kind of image ('moment', 'character_reference', etc).
// refId = id of whatever it was for; interpret it using source.
// Failures here must never break image generation — wrapped in try/catch.
async function logImageGeneration(db, userId, source, refId) {
  try {
    var d = new Date();
    var monthKey = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    await db.prepare(
      'INSERT INTO image_generations (user_id, source, ref_id, month_key, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, source || 'moment', refId || null, monthKey, d.toISOString());
  } catch (e) {
    console.error('logImageGeneration failed (non-fatal):', e.message);
  }
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
    const chars = await db.prepare(
      'SELECT ch.name, ch.cls, ch.description, ch.canonical_prompt, ' +
      'sc.prompt AS snapshot_prompt ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.session_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(moment.session_id, campId);
    // Only include characters actually named in this panel's text
    const panelText = (prompt || '') + ' ' + (moment.description || '') + ' ' + (moment.title || '');
    const charList = buildCharacterBlock(chars, panelText);

    // Single regenerate = user wants a different take, so use a fresh
    // random seed each time rather than the fixed campaign seed.
    const randomSeed = Math.floor(Math.random() * 2147483647);
    const imageUrl = await generateImage(prompt, style, fal_key, charList, randomSeed);
    const now = new Date().toISOString();
    await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(imageUrl, now, req.session.userId, moment_id);
    await logImageGeneration(db, req.session.userId, 'moment', moment_id);
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

  // Load all campaign characters once; the per-panel block is built inside
  // the loop so each panel only includes the characters actually in it.
  const chars = await db.prepare(
    'SELECT ch.name, ch.cls, ch.description, ch.canonical_prompt, ' +
    'sc.prompt AS snapshot_prompt ' +
    'FROM characters ch ' +
    'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.session_id = ? ' +
    'WHERE ch.campaign_id = ?'
  ).all(session_id, campaign_id);

  // Stable campaign base seed — every session of a campaign renders from the
  // same visual DNA, so characters stay consistent across sessions. Each panel
  // offsets from it by panel_order so panels within a session still vary.
  // (Single-panel Regenerate uses a random seed, preserving per-panel variety.)
  const baseSeed = campaignSeed(campaign_id);
  // Offset by session so two sessions don't render panel-for-panel identical,
  // while still sharing the campaign's overall visual DNA.
  const sessionOffset = (parseInt(session_id, 10) || 0) * 1000;

  // Generate all images in parallel
  const results = await Promise.allSettled(
    moments.map(async function(m) {
      try {
        const panelSeed = (baseSeed + sessionOffset + (m.panel_order || 0)) % 2147483647;
        // Only the characters named in THIS panel — prevents feature bleed
        const panelText = (m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '');
        const charList = buildCharacterBlock(chars, panelText);
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

  // Log one usage row per successfully generated image.
  for (var i = 0; i < generated.length; i++) {
    if (generated[i] && generated[i].success) {
      await logImageGeneration(db, req.session.userId, 'moment', generated[i].moment_id);
    }
  }

  res.json({ success: true, generated: generated, count: successCount, total: moments.length });
});

module.exports = router;
