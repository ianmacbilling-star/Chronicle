const express = require('express');
const path = require('path');
const { getDb } = require('../database/db');
const { buildNovelHTML } = require('./pdf');

const router = express.Router();

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function slugify(s) {
  s = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'story';
}
// Escape characters that could break out of a <script type="application/ld+json">
// block. fromCharCode(92) is a backslash, so this emits a JSON \\u003c escape.
function ldSafe(json) {
  return json.split('<').join(String.fromCharCode(92) + 'u003c');
}

// Public, server-rendered per-story page. Real HTML (title, author, blurb,
// teaser, and the full reading view) so search engines can index it. Built from
// the frozen snapshot taken at publish, never live campaign data.
router.get('/library/story/:id/:slug?', async function (req, res) {
  function notFound() {
    res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
  }
  try {
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    if (!id) return notFound();
    const row = await db.prepare(
      'SELECT id, title, author_name, cover_url, pdf_url, slug, blurb, teaser, snapshot, created_at FROM public_stories WHERE id = ? AND public = TRUE'
    ).get(id);
    if (!row) return notFound();

    const wantSlug = row.slug || slugify(row.title);
    if (req.params.slug !== wantSlug) {
      return res.redirect(301, '/library/story/' + row.id + '/' + wantSlug);
    }

    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const pageUrl = base + '/library/story/' + row.id + '/' + wantSlug;
    const title = row.title || 'Untitled';
    const author = row.author_name || '';
    const cover = row.cover_url || '';
    const blurb = (row.blurb && String(row.blurb).trim()) ? String(row.blurb).trim() : '';
    const teaser = (row.teaser && String(row.teaser).trim()) ? String(row.teaser).trim() : '';
    let metaDesc = (blurb || teaser || ('A Campaignia chronicle' + (author ? ' by ' + author : ''))).replace(/\s+/g, ' ').trim();
    if (metaDesc.length > 300) metaDesc = metaDesc.slice(0, 297) + '...';

    const ld = {
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      name: title,
      url: pageUrl,
      description: metaDesc
    };
    if (author) ld.author = { '@type': 'Person', name: author };
    if (cover) ld.image = cover;
    if (row.created_at) { try { ld.datePublished = new Date(row.created_at).toISOString(); } catch (e) {} }

    const seo =
      '<title>' + esc(title) + (author ? ' &mdash; by ' + esc(author) : '') + ' | Campaignia</title>' +
      '<meta name="description" content="' + esc(metaDesc) + '" />' +
      '<link rel="canonical" href="' + esc(pageUrl) + '" />' +
      '<meta property="og:type" content="article" />' +
      '<meta property="og:site_name" content="Campaignia" />' +
      '<meta property="og:title" content="' + esc(title) + '" />' +
      '<meta property="og:description" content="' + esc(metaDesc) + '" />' +
      '<meta property="og:url" content="' + esc(pageUrl) + '" />' +
      (cover ? '<meta property="og:image" content="' + esc(cover) + '" />' : '') +
      '<meta name="twitter:card" content="summary_large_image" />' +
      '<meta name="twitter:title" content="' + esc(title) + '" />' +
      '<meta name="twitter:description" content="' + esc(metaDesc) + '" />' +
      (cover ? '<meta name="twitter:image" content="' + esc(cover) + '" />' : '') +
      '<script type="application/ld+json">' + ldSafe(JSON.stringify(ld)) + '</script>';

    const header =
      '<div style="max-width:880px;margin:0 auto;padding:24px 18px 8px;font-family:Georgia,serif;">' +
        '<a href="/library" style="color:#c9a84c;text-decoration:none;font-size:13px;">&larr; Public Library</a>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;margin-top:14px;">' +
          (cover ? '<img src="' + esc(cover) + '" alt="' + esc(title) + ' cover" style="width:160px;aspect-ratio:17/22;object-fit:cover;border-radius:4px;background:#160e06;flex-shrink:0;" />' : '') +
          '<div style="flex:1;min-width:220px;">' +
            '<h1 style="font-family:Cinzel,Georgia,serif;color:#e8d5a3;font-size:26px;margin:0 0 6px;">' + esc(title) + '</h1>' +
            (author ? '<div style="color:#c9a84c;font-size:14px;margin-bottom:12px;">Chronicled by ' + esc(author) + '</div>' : '') +
            (blurb ? '<p style="color:#f0e8d0;font-size:15px;line-height:1.5;margin:0 0 10px;">' + esc(blurb) + '</p>' : '') +
            (teaser ? '<p style="color:rgba(240,232,208,0.7);font-size:14px;line-height:1.5;font-style:italic;margin:0 0 14px;">' + esc(teaser) + '</p>' : '') +
            (row.pdf_url ? '<a href="' + esc(row.pdf_url) + '" target="_blank" rel="noopener" style="display:inline-block;background:#c9a84c;color:#160e06;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;">Download PDF</a>' : '') +
          '</div>' +
        '</div>' +
        '<hr style="border:none;border-top:1px solid rgba(201,168,76,0.25);margin:22px 0 0;" />' +
      '</div>';

    const snap = row.snapshot || null;
    let html;
    if (snap && snap.sessions) {
      const pageOpts = { publicMode: true, bookTitle: snap.bookTitle || title };
      html = buildNovelHTML(snap.campaign, snap.sessions, snap.characters, snap.layoutStyle || 'Classic', pageOpts, snap.co || null);
      html = html.replace('<head>', '<head>' + seo);
      html = html.replace('<body>', '<body>' + header);
    } else {
      // Legacy entry without a snapshot -- still a valid SEO page (cover + meta +
      // download), just no inline reading view until the author republishes.
      html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' + seo +
        '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text&display=swap" rel="stylesheet" />' +
        '</head><body style="margin:0;background:#0a0806;color:#f0e8d0;min-height:100vh;">' + header +
        '<div style="max-width:880px;margin:0 auto;padding:20px 18px;color:rgba(240,232,208,0.6);font-family:Georgia,serif;">Open the PDF to read this chronicle.</div>' +
        '</body></html>';
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[story-page] failed:', e && e.message ? e.message : e);
    return notFound();
  }
});

module.exports = router;
