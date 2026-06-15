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
      '<div style="background:#0a0806;border-bottom:3px solid #c9a84c;">' +
      '<div style="max-width:880px;margin:0 auto;padding:22px 18px;font-family:Georgia,serif;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">' +
          '<a href="/library#stories" style="color:#c9a84c;text-decoration:none;font-size:13px;">&larr; Back to Stories</a>' +
          '<a href="/?ref=story" style="color:rgba(201,168,76,0.85);text-decoration:none;font-size:12px;letter-spacing:0.04em;">Made with <strong style="color:#e8d5a3;">Campaignia</strong></a>' +
        '</div>' +
        '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;margin-top:14px;">' +
          (cover ? '<img src="' + esc(cover) + '" alt="' + esc(title) + ' cover" style="width:160px;aspect-ratio:17/22;object-fit:cover;border-radius:4px;background:#160e06;flex-shrink:0;" />' : '') +
          '<div style="flex:1;min-width:220px;">' +
            '<h1 style="font-family:Cinzel,Georgia,serif;color:#e8d5a3;font-size:26px;margin:0 0 6px;">' + esc(title) + '</h1>' +
            (author ? '<div style="color:#c9a84c;font-size:14px;margin-bottom:12px;">Chronicled by ' + esc(author) + '</div>' : '') +
            (blurb ? '<p style="color:#f0e8d0;font-size:15px;line-height:1.5;margin:0 0 10px;">' + esc(blurb) + '</p>' : '') +
            (teaser ? '<p style="color:rgba(240,232,208,0.7);font-size:14px;line-height:1.5;font-style:italic;margin:0 0 14px;">' + esc(teaser) + '</p>' : '') +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">' +
              '<a href="/?ref=story" style="display:inline-block;background:#c9a84c;color:#160e06;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:700;font-size:13px;">Make your own &rarr;</a>' +
              (row.pdf_url ? '<a href="' + esc(row.pdf_url) + '" target="_blank" rel="noopener" style="display:inline-block;background:transparent;color:#c9a84c;border:1px solid rgba(201,168,76,0.5);padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Download PDF</a>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '</div>';

    var legalReportBar =
      '<div style="background:#0a0806;border-top:1px solid rgba(201,168,76,0.18);">' +
      '<div style="max-width:880px;margin:0 auto;padding:20px 18px;font-family:Georgia,serif;text-align:center;">' +
        '<a href="javascript:void(0)" id="cmpReportToggle" style="color:rgba(201,168,76,0.7);font-size:12px;text-decoration:underline;cursor:pointer;">Report this story or an image</a>' +
        '<div id="cmpReport" style="display:none;max-width:460px;margin:14px auto 0;text-align:left;">' +
          '<textarea id="cmpReportReason" maxlength="2000" placeholder="What is wrong with this story or one of its images? (for example: it uses copyrighted characters, or contains inappropriate content)" style="width:100%;min-height:80px;background:#140f08;color:#f0e8d0;border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit;box-sizing:border-box;"></textarea>' +
          '<input id="cmpReportEmail" type="email" maxlength="200" placeholder="Your email (optional, so we can follow up)" style="width:100%;margin-top:8px;background:#140f08;color:#f0e8d0;border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:8px 10px;font-size:13px;font-family:inherit;box-sizing:border-box;" />' +
          '<button id="cmpReportBtn" style="margin-top:8px;background:#c9a84c;color:#160e06;border:none;padding:8px 16px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;">Submit report</button>' +
          '<span id="cmpReportMsg" style="margin-left:10px;font-size:12px;color:rgba(240,232,208,0.75);"></span>' +
        '</div>' +
      '</div>' +
      '<div style="max-width:880px;margin:0 auto;padding:0 18px 24px;font-family:Georgia,serif;text-align:center;color:rgba(201,168,76,0.4);font-size:11px;line-height:1.6;">' +
        '&copy; ' + (new Date().getFullYear()) + ' So It Begins, LLC &middot; Campaignia. Game systems, settings, and characters are the property of their respective publishers. Campaignia is not affiliated with any game publisher. ' +
        '<a href="/terms.html" style="color:rgba(201,168,76,0.6);">Terms</a>' +
      '</div>' +
      '<script>(function(){var t=document.getElementById("cmpReportToggle");var box=document.getElementById("cmpReport");if(t&&box){t.addEventListener("click",function(){box.style.display=(box.style.display==="block"?"none":"block");});}var b=document.getElementById("cmpReportBtn");if(!b)return;b.addEventListener("click",function(){var r=document.getElementById("cmpReportReason").value.trim();var e=document.getElementById("cmpReportEmail").value.trim();var m=document.getElementById("cmpReportMsg");if(!r){m.textContent="Please describe the problem.";return;}b.disabled=true;m.textContent="Sending...";fetch("/api/public/report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({story_id:' + row.id + ',reason:r,email:e})}).then(function(x){return x.json();}).then(function(d){if(d&&d.ok){m.textContent="Thank you. Your report has been sent.";document.getElementById("cmpReportReason").value="";document.getElementById("cmpReportEmail").value="";}else{b.disabled=false;m.textContent=(d&&d.error)||"Could not send. Please try again.";}}).catch(function(){b.disabled=false;m.textContent="Could not send. Please try again.";});});})();</script>' +
      '</div>';

    const footerCta =
      '<div style="background:#0a0806;border-top:3px solid #c9a84c;">' +
      '<div style="max-width:880px;margin:0 auto;padding:34px 18px;text-align:center;font-family:Georgia,serif;">' +
        '<div style="color:rgba(201,168,76,0.85);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">Made with Campaignia</div>' +
        '<h2 style="font-family:Cinzel,Georgia,serif;color:#e8d5a3;font-size:24px;margin:0 0 10px;">Turn your campaign into a book</h2>' +
        '<p style="color:#f0e8d0;font-size:15px;line-height:1.5;margin:0 auto 18px;max-width:520px;">Campaignia turns your tabletop RPG sessions into a styled graphic novel you can read online or hold in print.</p>' +
        '<a href="/?ref=story" style="display:inline-block;background:#c9a84c;color:#160e06;padding:11px 26px;border-radius:6px;text-decoration:none;font-weight:700;font-size:15px;">Make your own &rarr;</a>' +
      '</div>' +
      '</div>' + legalReportBar;

    const snap = row.snapshot || null;
    let html;
    if (snap && snap.sessions) {
      const pageOpts = { publicMode: true, bookTitle: snap.bookTitle || title };
      html = buildNovelHTML(snap.campaign, snap.sessions, snap.characters, snap.layoutStyle || 'Classic', pageOpts, snap.co || null);
      html = html.replace('<head>', '<head>' + seo);
      html = html.replace('<body>', '<body>' + header);
      html = html.split('<div class="print-bar" id="printBar"><button onclick="window.print()">Save as PDF / Print</button></div>').join('');
      html = html.replace('</body>', footerCta + '</body>');
    } else {
      // Legacy entry without a snapshot -- still a valid SEO page (cover + meta +
      // download), just no inline reading view until the author republishes.
      html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' + seo +
        '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text&display=swap" rel="stylesheet" />' +
        '</head><body style="margin:0;background:#0a0806;color:#f0e8d0;min-height:100vh;">' + header +
        '<div style="max-width:880px;margin:0 auto;padding:20px 18px;color:rgba(240,232,208,0.6);font-family:Georgia,serif;">Open the PDF to read this chronicle.</div>' +
        footerCta + '</body></html>';
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[story-page] failed:', e && e.message ? e.message : e);
    return notFound();
  }
});

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function baseUrl() { return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''); }
var SITEMAP_CHUNK = 10000;

// sitemap.xml is a sitemap INDEX. It stays tiny no matter how many stories
// exist -- it points to a static-pages sitemap and one or more story sitemaps,
// each capped at SITEMAP_CHUNK urls (well under the 50k-per-file limit). This
// scales to millions of entries without bloating robots.txt or any one file.
router.get('/sitemap.xml', async function (req, res) {
  try {
    const db = await getDb();
    var base = baseUrl();
    var cnt = await db.prepare('SELECT COUNT(*) AS n FROM public_stories WHERE public = TRUE').get();
    var n = cnt ? Number(cnt.n) : 0;
    var chunks = Math.max(1, Math.ceil(n / SITEMAP_CHUNK));
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<sitemap><loc>' + xmlEsc(base + '/sitemap-pages.xml') + '</loc></sitemap>'];
    for (var i = 1; i <= chunks; i++) {
      parts.push('<sitemap><loc>' + xmlEsc(base + '/sitemap-stories.xml?page=' + i) + '</loc></sitemap>');
    }
    parts.push('</sitemapindex>');
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(parts.join('\n'));
  } catch (e) {
    console.error('[sitemap index] failed:', e && e.message ? e.message : e);
    res.status(500).send('');
  }
});

router.get('/sitemap-pages.xml', function (req, res) {
  var base = baseUrl();
  var parts = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '<url><loc>' + xmlEsc(base + '/') + '</loc></url>',
    '<url><loc>' + xmlEsc(base + '/library') + '</loc></url>',
    '</urlset>'];
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(parts.join('\n'));
});

router.get('/sitemap-stories.xml', async function (req, res) {
  try {
    const db = await getDb();
    var base = baseUrl();
    var page = parseInt(req.query.page, 10); if (!page || page < 1) page = 1;
    var offset = (page - 1) * SITEMAP_CHUNK;
    var rows = await db.prepare('SELECT id, slug, title, created_at, updated_at FROM public_stories WHERE public = TRUE ORDER BY id ASC LIMIT ? OFFSET ?').all(SITEMAP_CHUNK, offset);
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
    (rows || []).forEach(function (r) {
      var slug = r.slug || slugify(r.title);
      var loc = base + '/library/story/' + r.id + '/' + slug;
      var when = r.updated_at || r.created_at;
      var lm = '';
      if (when) { try { lm = new Date(when).toISOString(); } catch (e) { lm = ''; } }
      parts.push('<url><loc>' + xmlEsc(loc) + '</loc>' + (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '</url>');
    });
    parts.push('</urlset>');
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(parts.join('\n'));
  } catch (e) {
    console.error('[sitemap stories] failed:', e && e.message ? e.message : e);
    res.status(500).send('');
  }
});

module.exports = router;
