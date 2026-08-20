// ============================================================
// PUBLIC (UNAUTHENTICATED) ROUTES
// Small, read-only endpoints safe to expose to logged-out visitors.
// ============================================================
const express = require('express');
const genresvc = require('../services/genres');   // v3.0.487 -- Library genre facet
const router = express.Router();
const { TIERS, getTier } = require('../middleware/tiers');
const { getDb } = require('../database/db');
const { sendReportEmail } = require('./email');

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
    const all = req.query.window === 'all';
    // v3.0.737 -- TD-536. img_w/img_h added so the page can reserve each image's exact space
    // before the bytes arrive. They are already stored on the row; only the SELECT was short.
    const SELECT = 'SELECT a.id, a.image_url, a.title, a.img_w, a.img_h, a.shape, u.pen_name FROM campaign_archives a LEFT JOIN users u ON u.id = a.archived_by WHERE a.public = TRUE';
    if (all) {
      // Show-all: newest-first, id-cursor pagination, no shuffle (unchanged).
      const beforeId = parseInt(req.query.beforeId, 10) || 0;
      let sql = SELECT;
      const params = [];
      if (beforeId > 0) { sql += ' AND a.id < ?'; params.push(beforeId); }
      sql += ' ORDER BY a.id DESC LIMIT ?';
      params.push(limit + 1);
      const stmt = db.prepare(sql);
      const rows = await stmt.all.apply(stmt, params);
      const hasMore = rows.length > limit;
      const slice = rows.slice(0, limit);
      const items = slice.map(function (r) { return { image_url: r.image_url, caption: r.title || '', author: r.pen_name || '', w: r.img_w || 0, h: r.img_h || 0, shape: r.shape || '' }; });
      const nextCursor = slice.length ? slice[slice.length - 1].id : null;
      return res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
    }
    // Default 6-month view: recency-weighted shuffle (newer higher, same-era shuffled),
    // stable per visit via seed, offset-paginated. JITTER = +/- ~30 days of random nudge.
    const JITTER_SECONDS = 30 * 24 * 60 * 60;
    let seed = parseInt(req.query.seed, 10);
    if (!Number.isFinite(seed)) seed = 0;
    seed = ((seed % 2147483647) + 2147483647) % 2147483647;
    let offset = parseInt(req.query.offset, 10) || 0;
    if (offset < 0) offset = 0;
    const order = "(EXTRACT(EPOCH FROM a.created_at) + " + JITTER_SECONDS + " * ((('x' || substr(md5(a.id::text || '_" + seed + "'), 1, 8))::bit(32)::int)::float8 / 2147483647.0))";
    const sql = SELECT + " AND a.created_at >= NOW() - INTERVAL '6 months' ORDER BY " + order + ' DESC LIMIT ? OFFSET ?';
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, [limit + 1, offset]);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) { return { image_url: r.image_url, caption: r.title || '', author: r.pen_name || '', w: r.img_w || 0, h: r.img_h || 0, shape: r.shape || '' }; });
    const nextOffset = offset + slice.length;
    return res.json({ items: items, hasMore: hasMore, nextOffset: nextOffset });
  } catch (e) {
    console.error('GET public library error:', e.message);
    res.status(500).json({ error: 'library unavailable' });
  }
});

// GET /api/public/stories -- anonymous Stories directory. Each item is a
// published graphic novel: pen-name author, title, cover thumbnail, and the
// public PDF url. ?q= filters by author name (substring, case-insensitive).
// Newest first, keyset-paginated by id (beforeId cursor + nextCursor token).
// GET /api/public/genres -- the fixed genre list, so the Library filter is built
// from the SAME source the server validates against and the two cannot drift.
router.get('/genres', function (req, res) {
  res.json({ genres: genresvc.GENRES.filter(function (g) { return g.slug !== 'other'; }).map(function (g) { return { slug: g.slug, label: g.label }; }) });
});

router.get('/stories', async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 36;
    if (limit < 1) limit = 1;
    if (limit > 60) limit = 60;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    const q = (req.query.q || '').trim();
    // v3.0.487 -- genre facet. The value is validated against the fixed list, so an
    // arbitrary string can never reach the query; an unknown genre is simply ignored
    // rather than returning nothing, because a bookmarked link with a retired slug
    // should degrade to the full Library, not to an empty page.
    const genreRaw = String(req.query.genre || '').trim().toLowerCase();
    const genre = genresvc.isGenre(genreRaw) ? genreRaw : '';
    let sql = 'SELECT id, author_name, title, cover_url, pdf_url, slug, genres, created_at FROM public_stories WHERE public = TRUE';
    const params = [];
    if (q) { sql += ' AND author_name ILIKE ?'; params.push('%' + q + '%'); }
    // ARRAY[?] && genres uses the GIN index; ILIKE on a joined string would not.
    if (genre) { sql += ' AND genres && ARRAY[?]::text[]'; params.push(genre); }
    if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) {
      return { id: r.id, author: r.author_name || '', title: r.title || 'Untitled', cover_url: r.cover_url || '', pdf_url: r.pdf_url, slug: r.slug || '', genres: genresvc.genreLabels(r.genres), created_at: r.created_at };
    });
    const nextCursor = slice.length ? slice[slice.length - 1].id : null;
    res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
  } catch (e) {
    console.error('GET public stories error:', e.message);
    res.status(500).json({ error: 'stories unavailable' });
  }
});

// POST /api/public/report -- a reader flags a published story (or an image in
// it) as infringing or inappropriate. Emails the support inbox in the
// background. Always returns success so we never leak mailer state; the email
// send itself is best-effort.
router.post('/report', async function (req, res) {
  try {
    const storyId = parseInt((req.body && req.body.story_id), 10);
    let reason = (req.body && req.body.reason ? String(req.body.reason) : '').trim();
    let reporterEmail = (req.body && req.body.email ? String(req.body.email) : '').trim();
    if (!storyId) return res.status(400).json({ error: 'A story is required.' });
    if (!reason) return res.status(400).json({ error: 'Please tell us what is wrong.' });
    if (reason.length > 2000) reason = reason.slice(0, 2000);
    if (reporterEmail.length > 200) reporterEmail = reporterEmail.slice(0, 200);
    const db = await getDb();
    let story = null;
    try { story = await db.prepare('SELECT id, title, slug FROM public_stories WHERE id = ? AND public = TRUE').get(storyId); } catch (e) {}
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const storyUrl = base + '/library/story/' + story.id + '/' + (story.slug || '');
    // Fire-and-forget; do not block the response on the mailer.
    sendReportEmail({ storyId: story.id, storyTitle: story.title, storyUrl: storyUrl, reason: reason, reporterEmail: reporterEmail })
      .catch(function (e) { console.error('[report] mail error:', e && e.message ? e.message : e); });
    res.json({ ok: true });
  } catch (e) {
    console.error('POST public report error:', e.message);
    res.status(500).json({ error: 'Could not submit report.' });
  }
});

module.exports = router;
