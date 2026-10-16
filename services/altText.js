// ============================================================
// ALT TEXT FOR PUBLIC PICTURES -- v3.1.89, TD-953.
// ============================================================
//
// Ian, 2026-10-16: "Use the scene description for every panel for their alt text on the library.
// As long as we already have it and it doesn't cost us anything. So yes... description + art style
// + genre." And: "Can we retro fix existing images?"
//
// WHAT IT IS FOR. Alt text is read by search engines (Google Images above all) and by screen
// readers; nobody else sees it. A story title says nothing about a picture, and a keyword list
// ("Campaignia, Dragon") reads as stuffing, so the label is a plain description of what the picture
// shows -- the moment's own scene description, the text the picture was drawn from -- followed by
// its art style and the story's genre:
//   "Two adventurers climb a ruined tower as a red dragon coils above them. Dark Fantasy illustration, Fantasy"
//
// NOTHING IS STORED AND NOTHING IS CHARGED. The label is computed when a page or the gallery is
// served, from data every row already carries, so every story and picture published before this
// version gets it too, with no backfill and no AI call.
//
// PRINT NEVER SEES THIS. The public story page adds it AFTER buildNovelHTML returns (story-pages.js);
// the print and PDF routes call buildNovelHTML directly and never come through here.
//
// A CUSTOM STYLE IS JUST "illustration": a custom style's name is the creator's own, and the public
// surfaces already collapse every custom style to one anonymous bucket (artStyleCatalog.js).
'use strict';
var genresvc = require('./genres');
var artstyles = require('./artStyleCatalog');

var MAX_DESC = 150;

function clean(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Cut at a word boundary near MAX_DESC and mark the cut with an ellipsis.
function clip(s, max) {
  max = max || MAX_DESC;
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  var sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.\-]+$/, '') + '…';
}

// A stored style value (moments.style / campaign_archives.art_style) -> words for the label.
function styleText(stored) {
  var v = String(stored || '').trim();
  if (!v || /^custom:/i.test(v)) return 'illustration';
  if (v === artstyles.SELF_NAME) return "the author's own artwork";
  var slug = artstyles.styleSlug(v);
  var name = slug ? (artstyles.nameForSlug(slug) || v) : '';
  if (!name) return 'illustration';
  return /illustration|painting|drawing|painterly|ink|style|comic book/i.test(name) ? name : name + ' illustration';
}

// Genre labels from a campaign's genres (JSON string or array). An empty or missing list gives ''
// rather than the app-wide default, so a picture whose genre was never recorded is not labelled
// with a genre it may not have.
function genreText(raw) {
  var list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch (e) { list = []; } }
  if (!Array.isArray(list) || !list.length) return '';
  var known = list.filter(function (s) { return genresvc.isGenre(s); });
  if (!known.length) return '';
  return genresvc.genreLabels(known).join(', ');
}

// The label itself. description -> title -> fallback, then style, then genre.
function panelAlt(o) {
  o = o || {};
  var desc = clean(o.description) || clean(o.title) || clean(o.fallback);
  desc = clip(desc);
  var tail = styleText(o.style);
  var g = genreText(o.genres);
  if (g) tail += ', ' + g;
  if (!desc) return tail.charAt(0).toUpperCase() + tail.slice(1);
  var sep = /[.!?…]$/.test(desc) ? ' ' : '. ';
  return desc + sep + tail.charAt(0).toUpperCase() + tail.slice(1);
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The key a picture is looked up by: the src as written, unescaped, without query or fragment.
function urlKey(u) {
  return String(u || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').split('#')[0].split('?')[0].trim();
}

// An existing alt attribute, including the renderer's unescaped ones (alt="Mira's "Bargain"" -- the
// value runs to the last quote before the next attribute or the end of the tag).
var ALT_RE = /\salt="[^>]*?"(?=\s*\/?>|\s+[a-zA-Z-]+=")/;

function setAlt(tag, alt) {
  var attr = ' alt="' + escAttr(alt) + '"';
  if (ALT_RE.test(tag)) return tag.replace(ALT_RE, function () { return attr; });
  return tag.replace(/\s*(\/?)>$/, function (m, slash) { return attr + (slash ? ' />' : '>'); });
}

// The public story page. Labels every <img> whose src is a panel picture in the snapshot (and the
// front cover), whatever layout drew it. Returns the html unchanged if there is nothing to do.
function fillStoryAlts(html, snap, bookTitle) {
  if (!html || !snap || !Array.isArray(snap.sessions)) return html;
  var campaign = snap.campaign || {};
  var map = {};
  snap.sessions.forEach(function (s) {
    ((s && s.moments) || []).forEach(function (m) {
      if (!m || !m.image) return;
      var k = urlKey(m.image);
      if (!k || map[k]) return;
      map[k] = panelAlt({
        description: m.description,
        title: m.title,
        fallback: bookTitle,
        style: m.style || (s && s.art_style) || campaign.art_style || '',
        genres: campaign.genres
      });
    });
  });
  if (campaign.cover_image_url) {
    var ck = urlKey(campaign.cover_image_url);
    if (ck && !map[ck]) map[ck] = clean(bookTitle) ? (clean(bookTitle) + ', front cover') : 'Front cover';
  }
  if (!Object.keys(map).length) return html;
  return String(html).replace(/<img\b[^>]*>/g, function (tag) {
    var m = tag.match(/\ssrc="([^"]*)"/);
    if (!m) return tag;
    var alt = map[urlKey(m[1])];
    return alt ? setAlt(tag, alt) : tag;
  });
}

// One Library gallery row (campaign_archives joined to its moment) -> its label.
function galleryAlt(r) {
  r = r || {};
  return panelAlt({
    description: r.moment_description,
    title: r.title || r.moment_title,
    fallback: '',
    style: r.art_style,
    genres: r.genres
  });
}

module.exports = {
  MAX_DESC: MAX_DESC,
  panelAlt: panelAlt,
  styleText: styleText,
  genreText: genreText,
  fillStoryAlts: fillStoryAlts,
  galleryAlt: galleryAlt,
  setAlt: setAlt,
  urlKey: urlKey
};
