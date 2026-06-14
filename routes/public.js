// ============================================================
// PUBLIC (UNAUTHENTICATED) ROUTES
// Small, read-only endpoints safe to expose to logged-out visitors.
// ============================================================
const express = require('express');
const router = express.Router();
const { TIERS, getTier } = require('../middleware/tiers');
const { getDb } = require('../database/db');

// GET /api/public/pricing -- per-tier monthly price (whole dollars) for the
// landing page. Reads the live tier config (admin overrides + code defaults).
router.get('/pricing', function (req, res) {
  try {
    const pricing = {};
    Object.keys(TIERS).forEach(function (name) {
      const t = getTier(name);
      pricing[name] = (t && typeof t.price === 'number') ? t.price : 0;
    });
    res.json({ pricing: pricing });
  } catch (e) {
    console.error('GET public pricing error:', e.message);
    res.status(500).json({ error: 'pricing unavailable' });
  }
});


// GET /api/public/library -- anonymous gallery of archived images whose owners
// opted them in. Returns ONLY image + caption per item (nothing identifying).
// Newest first, keyset-paginated; defaults to the last 6 months, ?window=all
// includes older entries. The cursor is a separate token, not per-image.
router.get('/library', async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 48;
    if (limit < 1) limit = 1;
    if (limit > 60) limit = 60;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    const all = req.query.window === 'all';
    let sql = 'SELECT a.id, a.image_url, a.title, u.pen_name FROM campaign_archives a LEFT JOIN users u ON u.id = a.archived_by WHERE a.public = TRUE';
    const params = [];
    if (!all) sql += " AND a.created_at >= NOW() - INTERVAL '6 months'";
    if (beforeId > 0) { sql += ' AND a.id < ?'; params.push(beforeId); }
    sql += ' ORDER BY a.id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) { return { image_url: r.image_url, caption: r.title || '', author: r.pen_name || '' }; });
    const nextCursor = slice.length ? slice[slice.length - 1].id : null;
    res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
  } catch (e) {
    console.error('GET public library error:', e.message);
    res.status(500).json({ error: 'library unavailable' });
  }
});

// GET /api/public/stories -- anonymous Stories directory. Each item is a
// published graphic novel: pen-name author, title, cover thumbnail, and the
// public PDF url. ?q= filters by author name (substring, case-insensitive).
// Newest first, keyset-paginated by id (beforeId cursor + nextCursor token).
router.get('/stories', async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 36;
    if (limit < 1) limit = 1;
    if (limit > 60) limit = 60;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    const q = (req.query.q || '').trim();
    let sql = 'SELECT id, author_name, title, cover_url, pdf_url FROM public_stories WHERE public = TRUE';
    const params = [];
    if (q) { sql += ' AND author_name ILIKE ?'; params.push('%' + q + '%'); }
    if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) {
      return { id: r.id, author: r.author_name || '', title: r.title || 'Untitled', cover_url: r.cover_url || '', pdf_url: r.pdf_url };
    });
    const nextCursor = slice.length ? slice[slice.length - 1].id : null;
    res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
  } catch (e) {
    console.error('GET public stories error:', e.message);
    res.status(500).json({ error: 'stories unavailable' });
  }
});

module.exports = router;
