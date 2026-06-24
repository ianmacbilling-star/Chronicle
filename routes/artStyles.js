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
    const db = await getDb();
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO custom_art_styles (owner_id, name, style_prompt, is_fade, sample_urls, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.session.userId, name, stylePrompt, isFade, JSON.stringify(sampleUrls), now, now);
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
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE custom_art_styles SET name = ?, style_prompt = ?, is_fade = ?, updated_at = ? WHERE id = ? AND owner_id = ?'
    ).run(name, stylePrompt, isFade, now, row.id, req.session.userId);
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
  'You are an art director analyzing reference images to define a reusable ' +
  'illustration style for a graphic-novel image generator. Look ONLY at HOW the ' +
  'images are rendered, never at WHAT they depict. Output exactly two things and ' +
  'nothing else. (1) A single paragraph that begins with the literal token ' +
  '"STYLE:" and names the medium, linework, colour treatment, shading and ' +
  'lighting, texture, and any era or broad tradition it evokes. Describe the ' +
  'rendering style only, never the subjects, characters, or scenes shown. You may ' +
  'reference broad artistic traditions, but do not instruct imitation of a ' +
  'specific living artist by name without also giving generic descriptors. (2) On ' +
  'a final separate line, write "FADE: yes" if the art characteristically fades ' +
  'to a clean pure-white (#ffffff) edge with no frame or border, or "FADE: no" ' +
  'if it fills the frame edge to edge. Output only the STYLE paragraph and the ' +
  'FADE line, with no preamble.';

// POST /api/art-styles/custom/analyze (multipart: images[]) -- one Claude vision
// call writes a house-format STYLE: paragraph + fade flag from 2-4 samples.
router.post('/custom/analyze', requireAuth, requireTruePlatinum, function(req, res) {
  sampleUpload(req, res, async function(uploadErr) {
    if (uploadErr) return res.json({ error: uploadErr.message || 'Could not read your images.' });
    try {
      const files = req.files || [];
      if (files.length < 2) return res.json({ error: 'Add at least 2 reference images so the style can be read reliably.' });
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
