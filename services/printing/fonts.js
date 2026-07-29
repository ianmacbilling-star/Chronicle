// SELF-HOSTED BOOK FONTS
// =====================================================================================================
// The book CSS used to pull its typefaces from Google:
//     @import url('https://fonts.googleapis.com/css2?family=Cinzel...&display=swap');
// which means every render AND every measure had to reach fonts.googleapis.com and then
// fonts.gstatic.com. From the Railway container those requests do not complete, so
// document.fonts.ready never resolved -- the measure pass hung forever, took its browser with it, and
// produced a run that stalled mid-loop with no stack and nothing in the log. That was the "stuck pack"
// we chased for two days. Bounding fonts.ready in v3.0.278 turned an infinite hang into a 15 second
// wait per measure, roughly twelve minutes a run, and left every measurement taken with FALLBACK
// metrics -- different wrapping, different line counts, wrong estimates downstream.
//
// The fonts are now shipped with the app (@fontsource/*) and inlined as base64 data URIs, so a rendered
// document makes NO network request for type at all. That is deliberately stronger than serving them
// from our own origin: a data URI cannot be affected by a base href, a redirect, an egress rule or a
// slow first byte, and it behaves identically in the measure pass and the PDF render -- which is the
// property that actually matters, because those two disagreeing is what causes clipped pages.
//
// Only the faces a document actually uses are inlined: Cinzel and Crimson Text always (display and
// body), plus the one optional body font selected. About 120KB, or 270KB with the largest option --
// negligible beside the images, and paid once per document.
const fs = require('fs');
const path = require('path');

// family key -> { pkg, family, faces: [ [weight, style] ] }
const FACES = {
  cinzel:          { pkg: 'cinzel',         family: 'Cinzel',         faces: [['400','normal'], ['600','normal'], ['700','normal'], ['900','normal']] },   // 900 is used by the marketing page
  'crimson-text':  { pkg: 'crimson-text',   family: 'Crimson Text',   faces: [['400','normal'], ['600','normal'], ['400','italic']] },
  bangers:         { pkg: 'bangers',        family: 'Bangers',        faces: [['400','normal']] },
  garamond:        { pkg: 'eb-garamond',    family: 'EB Garamond',    faces: [['400','normal'], ['600','normal'], ['400','italic']] },
  lora:            { pkg: 'lora',           family: 'Lora',           faces: [['400','normal'], ['600','normal'], ['400','italic']] },
  merriweather:    { pkg: 'merriweather',   family: 'Merriweather',   faces: [['400','normal'], ['400','italic']] },
  script:          { pkg: 'dancing-script', family: 'Dancing Script', faces: [['400','normal'], ['500','normal'], ['600','normal'], ['700','normal']] },
  journal:         { pkg: 'caveat',         family: 'Caveat',         faces: [['400','normal'], ['500','normal'], ['700','normal']] },
  comic:           { pkg: 'comic-neue',     family: 'Comic Neue',     faces: [['400','normal'], ['700','normal'], ['400','italic']] }
};

const _cache = new Map();       // family key -> css string (built once, reused for every document)
let _warned = false;

function faceCss(key) {
  if (_cache.has(key)) return _cache.get(key);
  const def = FACES[key];
  if (!def) { _cache.set(key, ''); return ''; }
  let css = '';
  let missing = 0;
  def.faces.forEach(function (f) {
    const weight = f[0], style = f[1];
    const file = def.pkg + '-latin-' + weight + '-' + style + '.woff2';
    const p = path.join(__dirname, '..', '..', 'node_modules', '@fontsource', def.pkg, 'files', file);
    let b64 = '';
    try { b64 = fs.readFileSync(p).toString('base64'); } catch (e) { missing++; return; }
    css += "@font-face{font-family:'" + def.family + "';font-style:" + style +
           ";font-weight:" + weight + ";font-display:block;" +
           "src:url(data:font/woff2;charset=utf-8;base64," + b64 + ") format('woff2');}";
  });
  if (missing && !_warned) {
    _warned = true;
    // Loud, once. A missing face silently falls back to a system typeface, which measures differently
    // from what the PDF renders -- exactly the divergence this module exists to remove.
    try { console.error('[fonts] ' + missing + ' face(s) missing for ' + key + ' -- is @fontsource/' + def.pkg + ' installed? Text metrics will be wrong.'); } catch (e) {}
  }
  _cache.set(key, css);
  return css;
}

// Always-on display + body pair, used by every layout.
function baseFontCss() {
  // Cinzel (display), Crimson Text (body) and Bangers (comic display) are referenced by every
  // layout's CSS, so all three ship in every document. Bangers is one small face.
  return faceCss('cinzel') + faceCss('crimson-text') + faceCss('bangers');
}

// The optional body font a book has chosen ('classic' means none -- Crimson Text is already loaded).
function bookFontCss(key) {
  if (!key || key === 'classic') return '';
  return faceCss(key);
}

// Everything a document needs, in one string.
function fontCss(key) {
  return baseFontCss() + bookFontCss(key);
}

// True when every face of every family resolved. Used by a startup check so a packaging mistake is
// found at boot rather than as mysteriously wrong line counts weeks later.
function fontsPresent() {
  const missing = [];
  let total = 0;
  Object.keys(FACES).forEach(function (k) {
    const def = FACES[k];
    def.faces.forEach(function (f) {
      const file = def.pkg + '-latin-' + f[0] + '-' + f[1] + '.woff2';
      const p = path.join(__dirname, '..', '..', 'node_modules', '@fontsource', def.pkg, 'files', file);
      total++;
      if (!fs.existsSync(p)) missing.push(def.pkg + '/' + file);
    });
  });
  return { ok: missing.length === 0, missing: missing, total: total };
}

// The stylesheet browser-served pages use. Generated from the SAME table the renderer inlines from, so
// the two can never drift: one list of families and weights, two consumers. Served at /css/fonts.css.
function browserFontCss() {
  let css = '/* self-hosted; generated from services/printing/fonts.js */\n';
  Object.keys(FACES).forEach(function (k) {
    const def = FACES[k];
    def.faces.forEach(function (f) {
      css += "@font-face{font-family:'" + def.family + "';font-style:" + f[1] + ";font-weight:" + f[0] +
             ";font-display:swap;src:url('/fonts/" + def.pkg + '-latin-' + f[0] + '-' + f[1] +
             ".woff2') format('woff2');}\n";
    });
  });
  return css;
}

module.exports = { fontCss, baseFontCss, bookFontCss, browserFontCss, fontsPresent, FACES };
