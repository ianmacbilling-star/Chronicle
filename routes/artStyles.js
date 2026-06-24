const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { getEffectiveTier } = require('../middleware/tiers');

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

module.exports = router;
