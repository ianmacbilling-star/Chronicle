const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { getEffectiveTier } = require('../middleware/tiers');
const { canAfford, spendTokens } = require('./tokens');
const { uploadFile } = require('../storage/storage');
const multer = require('multer');
const path = require('path');

// Custom Art Styles are account-wide and owned by the user. CREATE / manage is
// gated on the owner's TRUE account tier being Platinum (their own users.tier),
// NOT effective tier: joining a higher-tier SM's campaign never grants
// account-level allowances. getEffectiveTier(userId, null) returns the user's
// own tier. Free-Trial (tier 'trial') and extended members are excluded.
async function requireTruePlatinum(req, res, next) {
  try {
    const own = await getEffectiveTier(req.session.userId, null);
    if (own !== 'platinum') {
      return res.status(403).json({ error: 'NOT_PLATINUM', message: 'Building your own art style is a Platinum feature.' });
    }
    next();
  } catch (e) {
    console.error('platinum gate error:', e.message);
    res.status(500).json({ error: 'Could not verify your plan.' });
  }
}

function parseSamples(raw) {
  try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}

function rowOut(r) {
  if (!r) return r;
  return {
    id: r.id,
    name: r.name,
    style_prompt: r.style_prompt,
    is_fade: r.is_fade ? 1 : 0,
    sample_urls: parseSamples(r.sample_urls),
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

function fadeFromBody(v, fallback) {
  if (v === undefined) return fallback;
  return (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
}

// GET /api/art-styles/custom -- list the caller's own custom styles.
// Not Platinum-gated for reads: a user who lapses from Platinum keeps seeing
// (and can delete) styles they already built; CREATE/EDIT stay gated.
router.get('/custom', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT * FROM custom_art_styles WHERE owner_id = ? ORDER BY created_at ASC'
    ).all(req.session.userId);
    res.json((rows || []).map(rowOut));
  } catch (e) {
    console.error('list custom styles error:', e.message);
    res.json({ error: 'Could not load your custom styles.' });
  }
});

// POST /api/art-styles/custom -- save a new custom style. Platinum-gated.
router.post('/custom', requireAuth, requireTruePlatinum, async function(req, res) {
  try {
    const name = (req.body && req.body.name || '').trim();
    const stylePrompt = (req.body && req.body.style_prompt || '').trim();
    const isFade = fadeFromBody(req.body && req.body.is_fade, 0);
    const sampleUrls = (req.body && Array.isArray(req.body.sample_urls)) ? req.body.sample_urls : [];
    if (!name) return res.json({ error: 'Please name your style.' });
    if (!stylePrompt) return res.json({ error: 'The style description is empty. Analyze your samples or write one first.' });
    const stylePromptN = /^STYLE:/i.test(stylePrompt) ? stylePrompt : ('STYLE: ' + stylePrompt);
    const db = await getDb();
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO custom_art_styles (owner_id, name, style_prompt, is_fade, sample_urls, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.session.userId, name, stylePromptN, isFade, JSON.stringify(sampleUrls), now, now);
    const row = await db.prepare('SELECT * FROM custom_art_styles WHERE id = ?').get(result.lastInsertRowid);
    res.json(rowOut(row));
  } catch (e) {
    console.error('save custom style error:', e.message);
    res.json({ error: 'Could not save your custom style.' });
  }
});

// PUT /api/art-styles/custom/:id -- edit name / paragraph / fade. Owner + Platinum.
router.put('/custom/:id', requireAuth, requireTruePlatinum, async function(req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare(
      'SELECT * FROM custom_art_styles WHERE id = ? AND owner_id = ?'
    ).get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    const name = (req.body && req.body.name !== undefined) ? String(req.body.name).trim() : row.name;
    const stylePrompt = (req.body && req.body.style_prompt !== undefined) ? String(req.body.style_prompt).trim() : row.style_prompt;
    const isFade = fadeFromBody(req.body && req.body.is_fade, row.is_fade ? 1 : 0);
    if (!name) return res.json({ error: 'Please name your style.' });
    if (!stylePrompt) return res.json({ error: 'The style description is empty.' });
    const stylePromptN = /^STYLE:/i.test(stylePrompt) ? stylePrompt : ('STYLE: ' + stylePrompt);
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE custom_art_styles SET name = ?, style_prompt = ?, is_fade = ?, updated_at = ? WHERE id = ? AND owner_id = ?'
    ).run(name, stylePromptN, isFade, now, row.id, req.session.userId);
    const updated = await db.prepare('SELECT * FROM custom_art_styles WHERE id = ?').get(row.id);
    res.json(rowOut(updated));
  } catch (e) {
    console.error('update custom style error:', e.message);
    res.json({ error: 'Could not update your custom style.' });
  }
});

// DELETE /api/art-styles/custom/:id -- owner only. Sample-image cleanup is
// handled in the analyze/upload pass (step 2) once samples are persisted.
router.delete('/custom/:id', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare(
      'SELECT id FROM custom_art_styles WHERE id = ? AND owner_id = ?'
    ).get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    await db.prepare('DELETE FROM custom_art_styles WHERE id = ? AND owner_id = ?').run(row.id, req.session.userId);
    res.json({ success: true });
  } catch (e) {
    console.error('delete custom style error:', e.message);
    res.json({ error: 'Could not delete your custom style.' });
  }
});

// ---- Sample upload + the analyze vision call (Platinum-gated) ----
const sampleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Images only'));
  }
}).array('images', 4);

// One token covers the analyze vision call (a cheap Claude text call); the style
// is then free on every later panel since it is just text in system_prompt.
const COST_ANALYZE = 1;

const STYLE_ANALYZE_SYSTEM =
  'You are an art director extracting a REUSABLE, CONTENT-FREE art-style ' +
  'directive from reference images. It will be applied to completely different ' +
  'scenes, so it must describe ONLY how the images are rendered, never what they ' +
  'depict. ' +
  'ABSOLUTE RULE: never name or imply any subject, character, figure, body part, ' +
  'clothing, weapon, animal, plant, building, vehicle, or other scene element -- ' +
  'not even as a "framing device." If a shape matters to the composition, ' +
  'describe it abstractly by ROLE and TONE only (e.g. "a large dark foreground ' +
  'mass," "small dark accents framing the edges," "a luminous open upper ' +
  'field"), never by what it actually is. Any named content will wrongly bleed ' +
  'into unrelated panels. ' +
  'Describe the look ONLY along these axes, and only where they define it: ' +
  'medium and technique; line and edge quality; shading and shadow; texture; ' +
  'colour and palette; lighting direction and contrast; and foreground / ' +
  'background composition and negative space. ' +
  'Be concise -- LESS IS MORE. Lead with the 1 to 3 traits that most define the ' +
  'look and keep the whole thing to roughly 2 to 4 sentences. A short, abstract ' +
  'directive outperforms a long descriptive one; do NOT pad it with an ' +
  'exhaustive catalogue or with any scene description. ' +
  '(1) Write ONE paragraph beginning with the literal token "STYLE:". You may ' +
  'name broad artistic traditions, but never instruct imitation of a specific ' +
  'living artist by name without also giving generic descriptors. ' +
  '(2) On a final separate line write "FADE: yes" if the art characteristically ' +
  'fades to a clean pure-white (#ffffff) edge with no frame or border, otherwise ' +
  '"FADE: no". Output ONLY the STYLE paragraph and the FADE line, no preamble. ' +
  'Example of the abstract, content-free voice wanted (do NOT copy its content): ' +
  '"STYLE: Stark backlit silhouette illustration. A single dark, near-black ' +
  'foreground mass reads against a vast, hazy, glowing sky, with backgrounds kept ' +
  'almost empty and detail-free. Warm dusk palette of amber, orange, magenta, ' +
  'crimson and cool blue, in a confident painterly-comic medium with smooth ' +
  'rendering, heavy contrast, and large areas of empty negative space."';

// POST /api/art-styles/custom/analyze (multipart: images[]) -- one Claude vision
// call writes a house-format STYLE: paragraph + fade flag from 2-4 samples.
router.post('/custom/analyze', requireAuth, requireTruePlatinum, function(req, res) {
  sampleUpload(req, res, async function(uploadErr) {
    if (uploadErr) return res.json({ error: uploadErr.message || 'Could not read your images.' });
    try {
      const files = req.files || [];
      let existingUrls = [];
      try { existingUrls = JSON.parse((req.body && req.body.sample_urls) || '[]'); } catch (e) { existingUrls = []; }
      if (!Array.isArray(existingUrls)) existingUrls = [];
      existingUrls = existingUrls.filter(function(u){ return typeof u === 'string' && /^https?:/i.test(u); }).slice(0, 4);
      if ((files.length + existingUrls.length) < 2) return res.json({ error: 'Add at least 2 reference images so the style can be read reliably.' });
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return res.json({ error: 'Style analysis is not configured. Please contact support.' });
      if (!(await canAfford(req.session.userId, COST_ANALYZE))) {
        return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Add more to analyze a style.' });
      }
      const content = [];
      const sampleUrls = [];
      for (const f of files) {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mimetype, data: f.buffer.toString('base64') } });
        try {
          const ext = path.extname(f.originalname) || '.jpg';
          const url = await uploadFile(f.buffer, 'style-sample-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext, f.mimetype);
          if (url) sampleUrls.push(url);
        } catch (e) { console.error('sample upload failed:', e.message); }
      }
      for (const u of existingUrls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          const mt0 = (r.headers.get('content-type') || '').split(';')[0];
          const okTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const mt = okTypes.indexOf(mt0) >= 0 ? mt0 : 'image/jpeg';
          content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } });
          sampleUrls.push(u);
        } catch (e) { console.error('existing sample fetch failed:', e.message); }
      }
      if (content.filter(function(c){ return c.type === 'image'; }).length < 2) {
        return res.json({ error: 'Could not read enough reference images. Try re-uploading them.' });
      }
      content.push({ type: 'text', text: 'Analyze these reference images and define their shared art style.' });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.AI_MODEL || 'claude-sonnet-4-6',
          max_tokens: 1000,
          system: STYLE_ANALYZE_SYSTEM,
          messages: [{ role: 'user', content: content }]
        })
      });
      const data = await response.json();
      if (data.error) return res.json({ error: (data.error.message || 'Style analysis failed.') });
      const raw = (data.content || []).map(function(b) { return b.text || ''; }).join('').trim();
      if (!raw) return res.json({ error: 'The analysis came back empty. Try clearer style samples.' });

      let isFade = 0;
      let stylePrompt = raw;
      const fadeMatch = raw.match(/FADE:\s*(yes|no)/i);
      if (fadeMatch) {
        isFade = /yes/i.test(fadeMatch[1]) ? 1 : 0;
        stylePrompt = raw.slice(0, fadeMatch.index).trim();
      }
      if (!/^STYLE:/i.test(stylePrompt)) stylePrompt = 'STYLE: ' + stylePrompt;

      try { await spendTokens(req.session.userId, COST_ANALYZE, { source: 'custom_style_analyze', event_type: 'generation_spend' }); } catch (e) { console.error('analyze spend failed:', e.message); }

      res.json({ style_prompt: stylePrompt, is_fade: isFade, sample_urls: sampleUrls });
    } catch (e) {
      console.error('analyze custom style error:', e.message);
      res.json({ error: 'Could not analyze the style: ' + e.message });
    }
  });
});

module.exports = router;
