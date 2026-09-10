// ============================================================
// ART STYLE CATALOG -- the facet vocabulary for art styles.
// v3.0.845 -- TD-694.
// ============================================================
//
// WHY THIS FILE EXISTS, AND WHY IT IS DELIBERATELY THIN.
//
// The preset art styles have only ever existed as the KEY SET of the `prefixes`
// object inside getStylePrefix() in routes/images.js. That is the right home for
// the paragraphs -- they are generation instructions and nothing else should own
// them -- but it means the only list of "what art styles exist" lives inside a
// 198KB route file, keyed by display name, next to the prompts.
//
// The public Library filter needs that list. It must NOT get it by re-typing the
// names: that is exactly the drift TD-528 and TD-529 closed on, where Brain text
// disagreed with code for months. So this module names them once, and the batch
// guard EXTRACTS the keys of getStylePrefix's `prefixes` object and requires this
// list to match byte-for-byte, in the module's own order. Adding a preset to
// images.js without adding it here fails the build. That is the whole point.
//
// AND getStylePrefix IS NOT TOUCHED. Routing the live generation path through a
// new module for a filter's benefit is a refactor of working code for no
// user-visible gain -- the same trade the genre spec's step 1 turned out to be
// (v3.0.827). This file is read by the public routes and by the publish snapshot;
// generation never calls it.
//
// SLUGS ARE THE FACET VOCABULARY. The stored value on a moment is the DISPLAY
// NAME ('Watercolor painterly') or 'custom:<id>'. The slug is what appears in a
// url and in public_stories.art_styles: it is short, it survives url encoding,
// and -- the part that matters -- 'custom:<id>' collapses to the bare token
// 'custom' so that one account's custom-style id can never be read off, or
// enumerated through, a public query string.

// EXACTLY the keys of getStylePrefix's `prefixes` map, in its order. The guard
// checks this against routes/images.js on every build.
var PRESET_NAMES = [
  'High fantasy illustration',
  'Everyday life illustration',
  'Dark gritty comic book',
  'Watercolor painterly',
  'Anime manga style',
  'Classic pen and ink',
  'Fantasy oil painting',
  'Comic book cel-shaded',
  'Fantasy pastel',
  'Charcoal drawing',
  'Dark Fantasy'
];

// The bucket every custom style shares. Ian, 2026-09-10: "anything custom just
// call Custom." One bucket is also the only version that is safe to publish --
// see the note above.
var CUSTOM_SLUG = 'custom';
var CUSTOM_LABEL = 'Custom';

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

var BY_SLUG = {};
var PRESETS = PRESET_NAMES.map(function (n) {
  var s = slugify(n);
  BY_SLUG[s] = n;
  return { slug: s, label: n, name: n };
});

// The list the filter control is built from: every preset, then Custom.
function facetOptions() {
  var out = PRESETS.map(function (p) { return { slug: p.slug, label: p.label }; });
  out.push({ slug: CUSTOM_SLUG, label: CUSTOM_LABEL });
  return out;
}

// Is this a slug the facet knows? 'custom' counts.
function isStyleSlug(slug) {
  var s = String(slug || '').trim().toLowerCase();
  return s === CUSTOM_SLUG || !!BY_SLUG[s];
}

// slug -> the DISPLAY NAME stored on moments.style / campaign_archives.art_style.
// Returns null for 'custom' and for anything unknown, because neither can be
// matched by equality -- custom is matched by prefix, unknown is dropped.
function nameForSlug(slug) {
  var s = String(slug || '').trim().toLowerCase();
  if (s === CUSTOM_SLUG) return null;
  return BY_SLUG[s] || null;
}

// A stored style value -> its facet slug. 'custom:17' -> 'custom'. An unknown
// preset name (a retired style still sitting on old rows) -> '' , so it lands in
// no bucket rather than in a wrong one.
function styleSlug(stored) {
  var v = String(stored || '').trim();
  if (!v) return '';
  if (/^custom:/i.test(v)) return CUSTOM_SLUG;
  var s = slugify(v);
  return BY_SLUG[s] ? s : '';
}

module.exports = {
  PRESET_NAMES: PRESET_NAMES,
  PRESETS: PRESETS,
  CUSTOM_SLUG: CUSTOM_SLUG,
  CUSTOM_LABEL: CUSTOM_LABEL,
  facetOptions: facetOptions,
  isStyleSlug: isStyleSlug,
  nameForSlug: nameForSlug,
  styleSlug: styleSlug,
  slugify: slugify
};
