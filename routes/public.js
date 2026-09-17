// ============================================================
// PUBLIC (UNAUTHENTICATED) ROUTES
// Small, read-only endpoints safe to expose to logged-out visitors.
// ============================================================
const express = require('express');
const genresvc = require('../services/genres');   // v3.0.487 -- Library genre facet
const artstyles = require('../services/artStyleCatalog');   // v3.0.845 -- TD-694, the art-style facet
const router = express.Router();
const { TIERS, getTier, canCreate, tierRank, accessRank, artStyleAllowed, narrativeStyleAllowed, ART_STYLE_MIN_RANK, NARRATIVE_STYLE_MIN_RANK } = require('../middleware/tiers');
const { getDb } = require('../database/db');
const { listPasses } = require('../services/billing/passes');   // v3.0.924 -- TD-780 Push 7
const { sendReportEmail } = require('./email');

// v3.0.845 -- TD-693 / TD-694. MULTI-VALUE FACETS, AND THEY ARE ANY-OF.
//
// Ian, 2026-09-10: "It would be ANY... not all." `&&` is any-of by definition, so a book
// tagged {fantasy,horror} answers to a filter for either. `@>` would be all-of, and across
// up to three genres it would return an empty page for very nearly every visitor -- which
// reads as a broken Library rather than as a precise answer.
//
// ONE PARSER FOR EVERY FACET ON EVERY ROUTE. There are three filter sites in this file and
// they have already produced two incidents by learning a rule one at a time (§5c of the
// working rules). So the split, the validation, the de-duplication, the cap and the
// degrade-to-everything behaviour live here once and every site calls them.
//
// AN UNKNOWN VALUE IS DROPPED RATHER THAN REFUSED -- the v3.0.487 rule, and it matters MORE
// with a list than it did with a single value: a bookmarked three-genre link carrying one
// retired slug should lose that slug, not the whole page.
//
// PLACEHOLDERS ARE BUILT, NEVER INTERPOLATED. db.js rewrites ? into numbered parameters
// POSITIONALLY, so every value gets its own ? and is pushed in the order its clause is
// appended -- an argument out of order here is a wrong page rather than an error, which is
// the v3.0.843 lesson. Nothing from the query string ever reaches the SQL text itself.
var MAX_FACET_VALUES = 24;

function parseFacet(raw, isValid) {
  var out = [];
  String(raw || '').split(',').forEach(function (part) {
    var v = part.trim().toLowerCase();
    if (!v || !isValid(v)) return;
    if (out.indexOf(v) > -1) return;
    if (out.length >= MAX_FACET_VALUES) return;
    out.push(v);
  });
  return out;
}

// An overlap test against a text[] column. Uses the GIN index; a join-and-match on a text
// column would not.
function arrayOverlap(column, values, params) {
  values.forEach(function (v) { params.push(v); });
  return ' AND ' + column + ' && ARRAY[' + values.map(function () { return '?'; }).join(',') + ']::text[]';
}

// THE IMAGE GALLERY IS DELIBERATELY NOT THE SAME SHAPE, because the data genuinely differs:
// an archived image has EXACTLY ONE art style (campaign_archives.art_style, stamped from
// moments.style at archive time and frozen there ever since), while a book can contain
// several. So equality for the presets, and a prefix test for the one Custom bucket -- every
// 'custom:<id>' answers to Custom and the id itself never appears in a public query string.
//
// v3.0.858 -- AND TWO OF THE OPTIONS ARE NOT STYLES AT ALL. Characters and Titles select
// on a.image_type, so a character sheet that DOES carry a real art style answers to both
// its style and to Characters -- which a single-valued art_style column could never do.
// See services/artStyleCatalog.js for why they are not in the style vocabulary.
function archiveStyleClause(slugs, params) {
  var names = [];
  var kinds = [];
  var wantCustom = false;
  slugs.forEach(function (s) {
    if (s === artstyles.CUSTOM_SLUG) { wantCustom = true; return; }
    // Checked BEFORE nameForSlug, which does not know these and would return null.
    var k = artstyles.typeForKindSlug(s);
    if (k) { if (kinds.indexOf(k) < 0) kinds.push(k); return; }
    var n = artstyles.nameForSlug(s);
    if (n) names.push(n);
  });
  var ors = [];
  if (names.length) {
    ors.push('a.art_style IN (' + names.map(function () { return '?'; }).join(',') + ')');
    names.forEach(function (n) { params.push(n); });
  }
  if (wantCustom) ors.push("a.art_style LIKE 'custom:%'");
  // PUSHED LAST, AND THE ORDER IS THE POINT: db.js rewrites ? into numbered parameters
  // positionally, so a value pushed out of step with its placeholder is a WRONG PAGE
  // rather than an error. names above, kinds here, matching the join below.
  if (kinds.length) {
    ors.push('a.image_type IN (' + kinds.map(function () { return '?'; }).join(',') + ')');
    kinds.forEach(function (k) { params.push(k); });
  }
  if (!ors.length) return '';
  return ' AND (' + ors.join(' OR ') + ')';
}

// GET /api/public/pricing -- per-tier monthly price (whole dollars) for the
// landing page. Reads the live tier config (admin overrides + code defaults).
router.get('/pricing', function (req, res) {
  try {
    const pricing = {};
    Object.keys(TIERS).forEach(function (name) {
      const t = getTier(name);
      pricing[name] = (t && typeof t.price === 'number') ? t.price : 0;
    });
    // v3.0.924 -- TD-780 Push 7. THE PASSES, FROM THE SAME CATALOG createPassCheckout CHARGES
    // FROM. listPasses() returns the code defaults merged with app_settings.pass_config, so the
    // storefront cannot quote a figure the checkout will not honour. Sent as cents, formatted by
    // the page, because a price that is not a whole number of dollars must survive the trip.
    let passes = [];
    try {
      passes = listPasses().map(function (p) {
        return { id: p.id, name: p.name, months: p.months, tokens: p.tokens, price_cents: p.price_cents };
      });
    } catch (passErr) {
      // The tier half still ships. A landing page with live tiers and fallback passes beats a
      // landing page with neither.
      console.error('GET public pricing: passes unavailable:', passErr.message);
      passes = [];
    }
    res.json({ pricing: pricing, passes: passes });
  } catch (e) {
    console.error('GET public pricing error:', e.message);
    res.status(500).json({ error: 'pricing unavailable' });
  }
});

// ============================================================================
// GET /api/public/tier-grid -- v3.0.891, TD-767. Everything the landing page's
// "Compare the Tiers" grid draws, per tier, from the LIVE config.
//
// *(Ian, 2026-09-13: "It should use real / live data were possible from the dashboard
// settings.")*
//
// SAME REASON /genres AND /art-styles EXIST. A control built from a second list is a
// control that will eventually disagree with the thing it describes -- and here the
// thing it describes is what the server ENFORCES, so a hand-written grid is how a
// landing page ends up promising five sessions that checkSessionLimit refuses.
// Every value below comes from getTier() (code defaults merged with the admin
// overrides in app_settings.tier_config) or from the very functions the gates call.
//
// THE STYLE COUNTS ARE COUNTED WITH THE GATE ITSELF -- artStyleAllowed /
// narrativeStyleAllowed against accessRank -- not with a second reading of the rank
// maps. Move a style from Gold to Silver and this number moves with it.
//
// THE FREE TRIAL AND COPPER ARE BOTH DELIBERATELY ABSENT, for different reasons. The trial
// has its own row on the landing page with its own explanation. Copper was a column until
// v3.0.894 and almost every cell in it read N/A, a dash or a zero --
//
// *(Ian, 2026-09-13: "Lets get rid of the Copper column. Almost everything in it is N/A or
// 0.")*
//
// -- which is what a tier that creates nothing of its own looks like in a grid of creation
// limits. It is a footnote now, where a sentence can say the true thing a column of N/A
// cannot: Copper is invited, and it inherits.
//
// THE CLIENT'S can_create BRANCHES STAY. They render a tier that cannot create, and they are
// tested; removing them would mean deriving that rule again the day a column like Copper
// comes back. This list is the only place that decides which columns exist.
// ============================================================================
const GRID_TIERS = ['silver', 'gold', 'platinum'];

// null/undefined means NO CAP throughout the tier config (see NULLABLE_TIER_FIELDS),
// so it travels as null and the client renders it as Unlimited. Never coerced to 0.
function gridCap(v) {
  return (v === null || v === undefined || v === '') ? null : Number(v);
}
function gridNum(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}
function gridStyleCount(map, allowed, rank) {
  return Object.keys(map).filter(function (id) { return allowed(rank, id); }).length;
}
// Ian, 2026-09-13: "Put the Highest number there from the settings (i'm really not
// using story length any more... i set all the settings per tier to the same number)".
// Taken as a MAX rather than as any one band, so it stays correct whether or not the
// four are equal, and needs no second decision if he ever separates them again.
function gridMaxPanels(t) {
  var caps = [t.max_moments_short, t.max_moments_medium, t.max_moments_long, t.max_moments_epic];
  var best = null;
  caps.forEach(function (n) {
    if (typeof n === 'number' && isFinite(n) && (best === null || n > best)) best = n;
  });
  return best;
}
router.get('/tier-grid', function (req, res) {
  try {
    const tiers = {};
    const order = GRID_TIERS.filter(function (n) { return !!TIERS[n]; });
    order.forEach(function (name) {
      const t = getTier(name);
      const rank = accessRank(name);
      const utlt = gridNum(t.monthly_utlt);
      const cot = gridNum(t.monthly_cot);
      tiers[name] = {
        key: name,
        label: t.name || name,
        price: gridNum(t.price),
        tokens: { utlt: utlt, cot: cot, total: utlt + cot },
        max_campaigns: gridCap(t.max_campaigns),
        max_sessions: gridCap(t.max_sessions),
        max_characters: gridCap(t.max_characters),
        max_assets: gridCap(t.max_assets),
        max_archives_per_campaign: gridCap(t.max_archives_per_campaign),
        max_panels: gridMaxPanels(t),
        art_styles: gridStyleCount(ART_STYLE_MIN_RANK, artStyleAllowed, rank),
        narrative_styles: gridStyleCount(NARRATIVE_STYLE_MIN_RANK, narrativeStyleAllowed, rank),
        can_create: canCreate(name),
        can_export: !!t.can_export,
        // An extra version is an ENTITLEMENT on your own plan, not a creative capability,
        // so the gate in routes/sessions.js reads tierRank and not accessRank. The
        // threshold is taken from the tier table rather than written as 3.
        multi_version: tierRank(name) >= tierRank('gold'),
        // Both of these ask isTruePlatinum(userId), which is defined as
        // getEffectiveTier(uid, null) === 'platinum' -- your OWN plan, never inherited.
        custom_art_styles: name === 'platinum',
        title_builder: name === 'platinum'
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ order: order, tiers: tiers });
  } catch (e) {
    console.error('GET public tier-grid error:', e.message);
    res.status(500).json({ error: 'tier details unavailable' });
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
    // v3.0.843 -- TD-671. Same rules as the Stories facet (v3.0.487), deliberately: the
    // value is validated against the fixed list so an arbitrary string can never reach the
    // SQL, and an UNKNOWN slug is IGNORED rather than returning nothing -- a bookmarked link
    // carrying a retired genre should degrade to the whole gallery, not to an empty page.
    // SENSITIVE GENRES ARE NOT EXCLUDED. Ian, 2026-09-09: "if someone publishes a family
    // story picture or a skill story picture we show it if someone filters for it." An image
    // its owner deliberately made public is public, and a facet that silently withheld it
    // would be lying about what the Library contains. The consent gate is where that
    // decision belongs (TD-664), not the search box.
    // v3.0.845 -- TD-693 / TD-694. Both facets, both any-of, both applied to BOTH
    // pagination modes below.
    const genres = parseFacet(req.query.genre, genresvc.isGenre);
    // v3.0.858 -- THE GALLERY, AND ONLY THE GALLERY, also accepts the two kind slugs.
    // /stories below deliberately keeps isStyleSlug: a kind arriving there is dropped and
    // the directory degrades to everything, rather than matching nothing and going blank.
    const styles = parseFacet(req.query.style, artstyles.isFacetSlug);
    const filtered = genres.length > 0 || styles.length > 0;
    // v3.0.737 -- TD-536. img_w/img_h added so the page can reserve each image's exact space
    // before the bytes arrive. They are already stored on the row; only the SELECT was short.
    const SELECT = 'SELECT a.id, a.image_url, a.title, a.img_w, a.img_h, a.shape, u.pen_name FROM campaign_archives a LEFT JOIN users u ON u.id = a.archived_by WHERE a.public = TRUE';
    if (all) {
      // Show-all: newest-first, id-cursor pagination, no shuffle (unchanged).
      const beforeId = parseInt(req.query.beforeId, 10) || 0;
      let sql = SELECT;
      const params = [];
      // ARRAY[?] && genres uses the GIN index; a join-and-match on a text column would not.
      if (genres.length) sql += arrayOverlap('a.genres', genres, params);
      if (styles.length) sql += archiveStyleClause(styles, params);
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
    // The genre clause has to land BEFORE the LIMIT, so this branch builds its parameter
    // list rather than passing a fixed pair -- the placeholders are positional once db.js
    // rewrites ? into $n, and an out-of-order argument here is a wrong page, not an error.
    let sql = SELECT + " AND a.created_at >= NOW() - INTERVAL '6 months'";
    const params = [];
    if (genres.length) sql += arrayOverlap('a.genres', genres, params);
    if (styles.length) sql += archiveStyleClause(styles, params);
    sql += ' ORDER BY ' + order + ' DESC LIMIT ? OFFSET ?';
    params.push(limit + 1, offset);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
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

// GET /api/public/art-styles -- v3.0.845, TD-694. The art-style facet list, served from
// services/artStyleCatalog.js: the SAME module the two routes above validate against, for
// exactly the reason /genres exists -- a control built from a second list is a control that
// will eventually disagree with the filter. Every custom style is one option called Custom.
router.get('/art-styles', function (req, res) {
  // v3.0.858 -- kinds ride under their OWN key rather than appended to styles. The gallery
  // control concatenates them; anything else reading this endpoint sees the list it had.
  res.json({ styles: artstyles.facetOptions(), kinds: artstyles.kindOptions() });
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
    // v3.0.845 -- TD-693 / TD-694. Both facets, any-of, same parser as the gallery.
    const genres = parseFacet(req.query.genre, genresvc.isGenre);
    const styles = parseFacet(req.query.style, artstyles.isStyleSlug);
    // v3.0.828 -- TD-673. An unlisted story is published but not browsable, so it is
    // absent from this directory and from the sitemap, and present everywhere a reader
    // who already holds the link needs it -- including the report form below, which is
    // deliberately still `public = TRUE` alone.
    let sql = "SELECT id, author_name, title, cover_url, pdf_url, slug, genres, share_token, created_at FROM public_stories WHERE public = TRUE AND visibility = 'public'";   // share_token v3.0.830 -- TD-675, so the grid can link canonically
    const params = [];
    if (q) { sql += ' AND author_name ILIKE ?'; params.push('%' + q + '%'); }
    // ARRAY[?] && genres uses the GIN index; ILIKE on a joined string would not.
    if (genres.length) sql += arrayOverlap('genres', genres, params);
    if (styles.length) sql += arrayOverlap('art_styles', styles, params);
    if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) {
      return { id: r.id, author: r.author_name || '', title: r.title || 'Untitled', cover_url: r.cover_url || '', pdf_url: r.pdf_url, slug: r.slug || '', share_token: r.share_token || '', genres: genresvc.genreLabels(r.genres), created_at: r.created_at };
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
    try { story = await db.prepare('SELECT id, title, slug, share_token FROM public_stories WHERE id = ? AND public = TRUE').get(storyId); } catch (e) {}   // share_token v3.0.832 -- the report email must link a url that resolves
    if (!story) return res.status(404).json({ error: 'Story not found.' });
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    // v3.0.832 -- whoever reads this email has to be able to OPEN it, and an unlisted
    // story is exactly the kind that gets reported by someone holding its link.
    const storyUrl = story.share_token
      ? (base + '/library/story/s/' + story.share_token + '/' + (story.slug || 'story'))
      : (base + '/library/story/' + story.id + '/' + (story.slug || ''));
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
