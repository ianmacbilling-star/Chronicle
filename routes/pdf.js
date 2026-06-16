const express = require('express');
const router = express.Router();
const { getDb, getDmForkId, getViewableForkId } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { getEffectiveTier, accessRank } = require('../middleware/tiers');
const path = require('path');
const { uploadFile, deleteFile } = require('../storage/storage');
const { renderHtmlToPdf } = require('../services/printing/renderPdf');
const { getPrintProvider } = require('../services/printing');
const catalog = require('../services/printing/catalog');

// Count pages in a rendered PDF buffer. Prefers pdf-lib (exact); if that module
// is unavailable or throws, falls back to a structural scan of the PDF bytes
// (Chromium writes an uncompressed page tree). Returns 0 when undeterminable,
// in which case callers fall back to the moment-count estimate.
async function pdfPageCount(buf) {
  if (!buf || !buf.length) return 0;
  try {
    var lib = require('pdf-lib');
    if (lib && lib.PDFDocument) {
      var doc = await lib.PDFDocument.load(buf, { updateMetadata: false });
      var n = doc.getPageCount();
      if (n > 0) return n;
    }
  } catch (e) { /* pdf-lib missing or parse failed -- use structural scan */ }
  try {
    var str = buf.toString('latin1');
    var m = str.match(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/);
    if (m) return parseInt(m[1], 10) || 0;
    var m2 = str.match(/\/Count\s+(\d+)[\s\S]{0,400}?\/Type\s*\/Pages\b/);
    if (m2) return parseInt(m2[1], 10) || 0;
    var c = (str.match(/\/Type\s*\/Page(?![sR\w])/g) || []).length;
    return c || 0;
  } catch (e) { return 0; }
}

// Shared drop shadow for gallery panels AND character portraits (kept in lockstep).
var CO_IMG_SHADOW = '7px 7px 10px -2px rgba(0,0,0,0.5), 18px 18px 30px -10px rgba(0,0,0,0.5)';

// ============================================================
// Date helper - handles both PostgreSQL Date objects and SQLite strings
// ============================================================
function toDate(dateVal) {
  if (!dateVal) return null;
  var dateStr = typeof dateVal === 'string' ? dateVal : (dateVal.toISOString ? dateVal.toISOString() : String(dateVal));
  var datePart = dateStr.split('T')[0];
  var d = new Date(datePart + 'T12:00:00');
  if (isNaN(d.getTime())) d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}
function formatDate(dateVal, options) {
  var d = toDate(dateVal);
  if (!d) return '';
  return d.toLocaleDateString('en-US', options || {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ============================================================
// LAYOUT BUILDERS
// Each takes (moments, sections, intro, outro) and returns panel HTML
// ============================================================

function shapeRatio(shape) {
  switch (shape) {
    case 'panoramic': return [21, 9];
    case 'wide':      return [16, 9];
    case 'square':    return [1, 1];
    case 'tall':      return [2, 3];
    case 'tower':     return [9, 16];
    case 'towerthin': return [2, 5];
    case 'fullpage':  return [3, 4];
    default:          return [4, 3]; // standard
  }
}
function shapeAspect(shape) { var r = shapeRatio(shape); return r[0] / r[1]; }
// True aspect from the stored image pixels (img_w/img_h) when present; otherwise the
// nominal shape-tag aspect. Lets panels size to the real image so they barely crop.
function momentAspect(m) {
  var w = m && Number(m.img_w), h = m && Number(m.img_h);
  if (w > 0 && h > 0) return w / h;
  return shapeAspect(normShape(m));
}
// ---- Layout metadata accessors (Phase 1; consumed in Phase 2) ----
// Read m.layout_meta (JSON string from extraction); default to TODAY'S behavior when absent.
function lmMeta(m) {
  var v = m && m.layout_meta;
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { var o = JSON.parse(v); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}
function lmProminence(m) { var n = Number(lmMeta(m).prominence); return (n >= 1 && n <= 5) ? Math.round(n) : 3; }
// Three-tier size from prominence: Minimize (1-2) / Default (3) / Maximize (4-5).
function lmSizeTier(m) { var p = lmProminence(m); return p >= 4 ? 'max' : (p <= 2 ? 'min' : 'def'); }
function lmFocal(m) { var f = lmMeta(m).focal; return (['center', 'top', 'bottom', 'left', 'right'].indexOf(f) >= 0) ? f : 'center'; }
function lmCropSafe(m) { return lmMeta(m).crop_safe === false ? false : true; }
function lmGroupBreak(m) { return lmMeta(m).group_break === true; }
function shapeRatioCSS(shape) { var r = shapeRatio(shape); return r[0] + ' / ' + r[1]; }
// Display aspect for the IMG box. Towers are GENERATED tall (1:4) but their nominal shape
// ratio is 9:16 (Picture Book's towerthin is 2:5), so a cover-fit box at the nominal ratio
// crops the tall tower. When the real pixel dims are stored, use them for towers so
// object-fit:cover fills the box with NO crop. Every other shape, and any image without
// stored dims, keeps the exact nominal ratio -> byte-identical to before.
function dispRatioCSS(m) {
  var s = normShape(m);
  if (s === 'tower' || s === 'towerthin') {
    var w = m && Number(m.img_w), h = m && Number(m.img_h);
    if (w > 0 && h > 0) return Math.round(w) + ' / ' + Math.round(h);
  }
  return shapeRatioCSS(s);
}
function normShape(m) {
  var s = (m && m.shape) || '';
  return (['wide', 'tall', 'square', 'panoramic', 'tower', 'towerthin', 'fullpage'].indexOf(s) >= 0) ? s : 'standard';
}
function isLandscape(shape) { return shapeAspect(shape) >= 1.15; }

// Row packing: target / floor sums of aspect ratios. A row's height is
// (containerWidth / sumOfAspects), so a larger sum = shorter row. The floor
// caps the height of short trailing rows; panoramic always gets its own band.
var ROW_TARGET = 2.6;
var ROW_MIN = 1.85;

function packRows(items) {
  var rows = [], cur = [], sum = 0;
  function flush() { if (cur.length) { rows.push({ items: cur, sum: sum }); cur = []; sum = 0; } }
  items.forEach(function (it) {
    var sh = normShape(it.m);
    if (sh === 'panoramic') { flush(); rows.push({ items: [it], sum: shapeAspect(sh) }); return; }
    cur.push(it); sum += shapeAspect(sh);
    if (sum >= ROW_TARGET) flush();
  });
  flush();
  return rows;
}

// An uncropped image sized to its shape's true aspect ratio. Because the image
// was generated at this exact ratio, object-fit:cover fills the box with no
// cropping; placeholders use the same ratio so empty panels keep their shape.
function shapedImage(m, border, radius) {
  var ratio = dispRatioCSS(m);
  var b = border || '';
  var rad = (radius == null) ? '3px' : radius;
  if (m.image) {
    return '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;border-radius:' + rad + ';' + b + '" src="' + m.image + '" alt="' + (m.title || '') + '" />';
  }
  return '<div style="width:100%;aspect-ratio:' + ratio + ';background:#f0e8d0;border:1px solid rgba(201,168,76,0.3);border-radius:' + rad + ';display:flex;align-items:center;justify-content:center;"><span style="font-size:24pt;opacity:0.3;">&#128444;</span></div>';
}

function panelCaption(m, i) {
  return '<div style="padding:4px 6px;background:#f9f4e8;border-left:3px solid #c9a84c;margin-top:3px;">' +
    '<span style="font-family:Cinzel,serif;font-size:8pt;color:#8a6a2a;">Panel ' + (i + 1) + '</span>' +
    '<span style="font-family:Cinzel,serif;font-size:9pt;font-weight:600;color:#2c1810;margin-left:8px;">' + (m.title || '') + '</span>' +
  '</div>';
}

function buildNarrativeHTML(text, isIntro) {
  if (!text) return '';
  return '<p style="font-family:Crimson Text,Georgia,serif;font-size:12pt;line-height:1.8;color:#2a1a0e;' +
    (isIntro ? 'font-style:italic;font-size:13pt;' : '') +
    'margin:0.15in 0;text-indent:' + (isIntro ? '0' : '0.3in') + ';">' + text + '</p>';
}

function buildClassicTextPanel(text) {
  return '<div style="background:#f9f4e8;border:1px solid rgba(201,168,76,0.25);border-radius:3px;' +
    'padding:0.18in 0.22in;font-family:Crimson Text,Georgia,serif;font-size:11.5pt;' +
    'line-height:1.7;color:#2a1a0e;text-indent:0.25in;">' + text + '</div>';
}

// ---- COMIC FAMILY ----

// A single comic-style cell: thick black border, optional overlaid caption,
// optional emphasis burst. Width is a percentage so the row tiles at a common
// height (height = containerWidth / rowSum) without cropping any shape.
function comicCell(m, pct, showCaption, showEmphasis) {
  var ratio = dispRatioCSS(m);
  var media = m.image
    ? '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#1a0f06;display:flex;align-items:center;justify-content:center;"><span style="font-size:30pt;opacity:0.25;color:#c9a84c;">&#128444;</span></div>';
  var caption = '';
  if (showCaption && m.title) {
    caption = '<div style="position:absolute;top:0;left:0;max-width:80%;background:#f0e8d0;border:3px solid #0a0806;border-top:none;border-left:none;padding:3px 9px 4px;font-family:Cinzel,serif;font-size:8.5pt;font-weight:600;color:#0a0806;letter-spacing:0.02em;line-height:1.25;">' + m.title + '</div>';
  }
  var panel = '<div style="width:100%;box-sizing:border-box;position:relative;overflow:hidden;border:5px solid #0a0806;background:#160e06;">' + media + caption + '</div>';
  var burst = '';
  if (showEmphasis && m.type === 'combat' && m.emphasis) {
    burst = '<div style="position:absolute;right:-0.12in;bottom:-0.1in;z-index:5;transform:rotate(-7deg);font-family:Cinzel,serif;font-weight:700;font-size:21pt;line-height:0.95;color:#c0392b;-webkit-text-stroke:1.5px #0a0806;text-stroke:1.5px #0a0806;text-shadow:2px 2px 0 #f0e8d0,-1px -1px 0 #f0e8d0,1px -1px 0 #f0e8d0,-1px 1px 0 #f0e8d0;text-transform:uppercase;letter-spacing:0.01em;max-width:2.6in;text-align:right;">' + m.emphasis + '</div>';
  }
  return '<div style="width:' + pct + '%;position:relative;page-break-inside:avoid;">' + panel + burst + '</div>';
}

function comicRow(row, showCaption, showEmphasis) {
  var divisor = Math.max(row.sum, ROW_MIN);
  var cells = row.items.map(function (it) {
    var pct = (shapeAspect(normShape(it.m)) / divisor) * 100;
    return comicCell(it.m, pct, showCaption, showEmphasis);
  }).join('');
  return '<div style="display:flex;gap:6px;margin-bottom:6px;line-height:0;align-items:flex-start;">' + cells + '</div>';
}

// COMIC BOOK — thick black borders, flush-packed justified rows whose panel
// widths follow each panel's shape, captions overlaid comic-style.
// ---- Shared media treatments for the preset family ----

// Clean modern grid cell: thin keyline, rounded, soft shadow (Mosaic).
function mosaicCell(m, pct) {
  var media = shapedImage(m, 'border:1px solid rgba(120,90,30,0.35);box-shadow:0 1px 5px rgba(0,0,0,0.12);', '4px');
  return '<div style="width:' + pct + '%;">' + media + '</div>';
}
function mosaicRow(row) {
  var divisor = Math.max(row.sum, ROW_MIN);
  var cells = row.items.map(function (it) {
    return mosaicCell(it.m, (shapeAspect(normShape(it.m)) / divisor) * 100);
  }).join('');
  return '<div style="display:flex;gap:0.12in;margin-bottom:0.12in;align-items:flex-start;">' + cells + '</div>';
}

function bleedMedia(m) {
  var ratio = dispRatioCSS(m);
  if (m.image) {
    return '<div style="position:relative;width:100%;margin-bottom:0.12in;page-break-inside:avoid;">' +
      '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />' +
      (m.title ? '<div style="position:absolute;left:0;right:0;bottom:0;padding:0.5in 0.3in 0.16in;background:linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.45) 45%,rgba(10,8,6,0));color:#f3e7c8;font-family:Cinzel,serif;font-size:11pt;font-weight:600;letter-spacing:0.03em;">' + m.title + '</div>' : '') +
    '</div>';
  }
  return '<div style="width:100%;aspect-ratio:' + ratio + ';background:#1a0f06;margin-bottom:0.12in;"></div>';
}

function vignetteMedia(m) {
  var shape = normShape(m);
  var ratio = dispRatioCSS(m);
  var widthPct = isLandscape(shape) ? 100 : (shape === 'square' ? 64 : 54);
  if (m.image) {
    return '<div style="position:relative;width:' + widthPct + '%;margin:0.3in auto 0.1in;page-break-inside:avoid;">' +
      '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />' +
      '<div style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0.6in 0.36in #ffffff;"></div>' +
      '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(255,255,255,0) 52%, rgba(255,255,255,0.6) 80%, rgba(255,255,255,1) 100%);"></div>' +
    '</div>';
  }
  return '<div style="width:' + widthPct + '%;margin:0.3in auto 0.1in;aspect-ratio:' + ratio + ';background:#f0e8d0;"></div>';
}

function galleryMedia(m) {
  var shape = normShape(m);
  var ratio = dispRatioCSS(m);
  var widthPct = isLandscape(shape) ? 92 : (shape === 'square' ? 60 : 52);
  var img = m.image
    ? '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;box-shadow:' + CO_IMG_SHADOW + ';" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#f0e8d0;"></div>';
  return '<div style="margin:0.55in auto;width:' + widthPct + '%;page-break-inside:avoid;">' + img +
    (m.title ? '<div style="text-align:center;margin-top:0.14in;font-family:Cinzel,serif;font-size:9.5pt;letter-spacing:0.12em;text-transform:uppercase;color:#8a6a2a;">' + m.title + '</div>' : '') +
  '</div>';
}

// ---- Tall / tower handling, shared by every preset ----
// A tall or towering image never stands alone: it sits to one side with the
// narrative beside it (panel description as fallback). If the NEXT panel is a
// compact shape (standard or square) it is pulled in under the narrative as a
// companion; wide / panoramic / another tall|tower are left for their own role.
function isPortrait(m) { var s = normShape(m); return s === 'tall' || s === 'tower'; }
function companionEligible(m) { var s = normShape(m); return s === 'standard' || s === 'square'; }

// IRONFRAME picture frame: dark bronze/iron face with a gold inlay keyline
// around the image. Used for Ironframe row panels and its portrait asides.
// The bronze picture frame: a gradient frame + black mat + a gold inner line with
// a small diamond node sitting ON the line at each corner. Shared by every layout
// AND the title page / cast portraits so the 'frame' option looks identical
// everywhere. inline=true makes the frame hug a fixed-size image (title/cast);
// the default is a full-width block (interior columns).
function bronzeFrame(inner, inline, scale) {
  // scale (default 1) shrinks the whole frame proportionally. The interior story
  // images are large so the full-size frame reads thin; the title image and the
  // (often small) cast portraits pass a smaller scale so the frame stays in
  // proportion instead of swallowing the picture.
  var sc = scale || 1;
  var padO = Math.max(1, Math.round(8 * sc));
  var padM = Math.max(1, Math.round(2 * sc));
  var gold = Math.max(1, Math.round(2 * sc));
  var dia = Math.max(3, Math.round(6 * sc));
  var _d = function(pos, tr){ return '<i style="position:absolute;' + pos + 'width:' + dia + 'px;height:' + dia + 'px;background:#c9a84c;transform:' + tr + ' rotate(45deg);box-shadow:0 0 0 1px #0a0806;"></i>'; };
  var _dia = _d('top:0;left:0;', 'translate(-50%,-50%)') + _d('top:0;right:0;', 'translate(50%,-50%)') + _d('bottom:0;left:0;', 'translate(-50%,50%)') + _d('bottom:0;right:0;', 'translate(50%,50%)');
  return '<div style="' + (inline ? 'display:inline-block;' : '') + 'padding:' + padO + 'px;background:linear-gradient(135deg,#2c1e10 0%,#0d0a06 52%,#2c1e10 100%);border:1px solid #0a0806;border-radius:2px;box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
    '<div style="padding:' + padM + 'px;background:#0a0806;">' +
    '<div style="position:relative;border:' + gold + 'px solid #c9a84c;line-height:0;">' + inner + _dia + '</div>' +
    '</div>' +
  '</div>';
}
function framedMedia(m) {
  var ratio = dispRatioCSS(m);
  var inner = m.image
    ? '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#160e06;"></div>';
  return bronzeFrame(inner, false);
}
function frameCell(m, pct, showCaption) {
  var cap = '';
  if (showCaption && m.title) {
    cap = '<div style="position:absolute;top:11px;left:11px;max-width:78%;background:#f0e8d0;border:2px solid #0a0806;padding:2px 8px 3px;font-family:Cinzel,serif;font-size:8.5pt;font-weight:600;color:#0a0806;line-height:1.2;">' + m.title + '</div>';
  }
  return '<div style="width:' + pct + '%;position:relative;page-break-inside:avoid;">' + framedMedia(m) + cap + '</div>';
}
function frameRow(row, showCaption) {
  var divisor = Math.max(row.sum, ROW_MIN);
  var cells = row.items.map(function (it) {
    return frameCell(it.m, (shapeAspect(normShape(it.m)) / divisor) * 100, showCaption);
  }).join('');
  return '<div style="display:flex;gap:0.14in;margin-bottom:0.14in;line-height:0;align-items:flex-start;">' + cells + '</div>';
}

function portraitMedia(m, kind) {
  if (kind === 'frame') return framedMedia(m);
  var ratio = dispRatioCSS(m);
  if (!m.image) return '<div style="width:100%;aspect-ratio:' + ratio + ';background:#f0e8d0;border:1px solid rgba(201,168,76,0.3);"></div>';
  var img = '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />';
  if (kind === 'comic') {
    return '<div style="width:100%;box-sizing:border-box;border:5px solid #0a0806;background:#160e06;overflow:hidden;">' + img + '</div>';
  }
  if (kind === 'vignette') {
    return '<div style="position:relative;width:100%;">' + img +
      '<div style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0.5in 0.3in #ffffff;"></div>' +
      '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(255,255,255,0) 50%, rgba(255,255,255,0.5) 82%, rgba(255,255,255,0.95) 100%);"></div>' +
    '</div>';
  }
  if (kind === 'gallery') {
    return '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;box-shadow:' + CO_IMG_SHADOW + ';" src="' + m.image + '" alt="' + (m.title || '') + '" />';
  }
  if (kind === 'bleed') {
    return img;
  }
  return '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;border:1px solid rgba(201,168,76,0.25);border-radius:3px;" src="' + m.image + '" alt="' + (m.title || '') + '" />';
}

function asideText(m, sectionAfter) {
  var t = sectionAfter || m.description || m.title || '';
  return buildClassicTextPanel(t);
}

function asideBlock(mediaHTML, sideHTML, imgLeft) {
  var imgCol = '<div style="flex:0 0 40%;">' + mediaHTML + '</div>';
  var txtCol = '<div style="flex:1;">' + sideHTML + '</div>';
  return '<div style="display:flex;gap:0.22in;align-items:flex-start;margin-bottom:0.24in;page-break-inside:avoid;">' +
    (imgLeft ? (imgCol + txtCol) : (txtCol + imgCol)) + '</div>';
}

// Returns { html, consumed }. consumed === 1 when the next panel was pulled in
// as a companion (so the caller skips it).
function portraitAside(moments, sections, i, kind) {
  var m = moments[i];
  var section = sections.find(function (s) { return s.panel_index === i; }) || {};
  var side = (section.before ? buildClassicTextPanel(section.before) : '') + asideText(m, section.after);
  var consumed = 0;
  var nxt = moments[i + 1];
  if (nxt && companionEligible(nxt)) {
    side += '<div style="margin-top:0.16in;">' + portraitMedia(nxt, kind) + '</div>';
    var nsec = sections.find(function (s) { return s.panel_index === (i + 1); }) || {};
    if (nsec.before) side += '<div style="margin-top:0.1in;">' + buildClassicTextPanel(nsec.before) + '</div>';
    if (nsec.after) side += '<div style="margin-top:0.1in;">' + buildClassicTextPanel(nsec.after) + '</div>';
    consumed = 1;
  }
  return { html: asideBlock(portraitMedia(m, kind), side, (i % 2 === 0)), consumed: consumed };
}

// ---- Shared drivers ----

function gridLayout(moments, sections, intro, outro, rowFn, kind) {
  var html = buildNarrativeHTML(intro, true);
  var buf = [];
  function flush() {
    if (!buf.length) return;
    packRows(buf).forEach(function (r) {
      html += rowFn(r);
      r.items.forEach(function (it) {
        var sec = sections.find(function (s) { return s.panel_index === it.i; }) || {};
        if (sec.before) html += buildNarrativeHTML(sec.before, false);
        if (sec.after) html += buildNarrativeHTML(sec.after, false);
      });
    });
    buf = [];
  }
  for (var i = 0; i < moments.length; i++) {
    if (isPortrait(moments[i])) {
      flush();
      var r = portraitAside(moments, sections, i, kind);
      html += r.html;
      i += r.consumed;
    } else {
      buf.push({ m: moments[i], i: i });
    }
  }
  flush();
  html += buildNarrativeHTML(outro, true);
  return html;
}

function stackLayoutP(moments, sections, intro, outro, mediaFn, kind) {
  var html = buildNarrativeHTML(intro, true);
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    if (isPortrait(m)) {
      var r = portraitAside(moments, sections, i, kind);
      html += r.html;
      i += r.consumed;
      continue;
    }
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    html += mediaFn(m);
    if (section.before) html += buildNarrativeHTML(section.before, false);
    if (section.after) html += buildNarrativeHTML(section.after, false);
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

// ---- THE SEVEN PRESETS ----

function layoutIronframe(moments, sections, intro, outro) {
  return gridLayout(moments, sections, intro, outro, function (row) { return frameRow(row, true); }, 'frame');
}

function layoutMosaic(moments, sections, intro, outro) {
  return gridLayout(moments, sections, intro, outro, mosaicRow, 'keyline');
}

function layoutSpectacle(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);
  var buffer = [];
  function flush() { if (buffer.length) { packRows(buffer).forEach(function (r) { html += comicRow(r, false, false); }); buffer = []; } }
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    if (isPortrait(m)) {
      flush();
      var r = portraitAside(moments, sections, i, 'comic');
      html += r.html;
      i += r.consumed;
      continue;
    }
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var big = m.type === 'combat' || i === 0 || i === moments.length - 1 ||
      ['panoramic', 'wide'].indexOf(normShape(m)) >= 0;
    if (big) {
      flush();
      html += comicRow({ items: [{ m: m, i: i }], sum: shapeAspect(normShape(m)) }, true, true);
    } else {
      buffer.push({ m: m, i: i });
    }
    if (section.before || section.after) { flush(); if (section.before) html += buildNarrativeHTML(section.before, false); if (section.after) html += buildNarrativeHTML(section.after, false); }
  }
  flush();
  html += buildNarrativeHTML(outro, true);
  return html;
}

function layoutEclipse(moments, sections, intro, outro) {
  return stackLayoutP(moments, sections, intro, outro, bleedMedia, 'bleed');
}

function layoutReverie(moments, sections, intro, outro) {
  return stackLayoutP(moments, sections, intro, outro, vignetteMedia, 'vignette');
}

function layoutFolio(moments, sections, intro, outro) {
  return stackLayoutP(moments, sections, intro, outro, galleryMedia, 'gallery');
}

function layoutSaga(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);
  var imgBorder = 'border:1px solid rgba(201,168,76,0.25);';
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    if (isPortrait(m)) {
      var r = portraitAside(moments, sections, i, 'keyline');
      html += r.html;
      i += r.consumed;
      continue;
    }
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var inner = shapedImage(m, imgBorder) + panelCaption(m, i);
    var beforeHtml = section.before ? '<div style="margin-top:0.1in;">' + buildClassicTextPanel(section.before) + '</div>' : '';
    var afterHtml = section.after ? '<div style="margin-top:0.1in;">' + buildClassicTextPanel(section.after) + '</div>' : '';
    html += '<div style="margin-bottom:0.24in;page-break-inside:avoid;">' + inner + beforeHtml + afterHtml + '</div>';
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

// ============================================================
// CUSTOM (A-LA-CARTE) LAYOUT ENGINE
// A single options object drives the render instead of a named preset.
// All visual primitives above are reused; nothing here touches the 7 presets.
// ============================================================
var CO_DEFAULTS = {
  arrange: 'grid',       // grid | stack | splash | paired
  border: 'none',        // none | keyline | frame | comic | vignette | gallery
  caption: 'bar',        // plate | bar | engraved | gradient | none
  gutter: 'normal',      // tight | normal | airy
  density: 'normal',     // busy | normal | roomy
  narr: 'plain',         // plain | box
  dropcap: 0,            // 0 | 1
  paper: 'white',        // white | linen | grey
  condition: 'none',     // none | smoke | dirt | wrinkle | blood
  font: 'classic',
  pano: 1, aside: 1, companion: 1, emphasis: 0,
  cover: 1, cast: 1, toc: 1, header: 1, markers: 1, watermark: 1,
  hidelogo: 0
};

var CO_FONTS = {
  classic:      "'Crimson Text', Georgia, serif",
  garamond:     "'EB Garamond', Georgia, serif",
  lora:         "'Lora', Georgia, serif",
  merriweather: "'Merriweather', Georgia, serif",
  sans:         "'Helvetica Neue', Arial, sans-serif",
  mono:         "'Courier New', Courier, monospace",
  script:       "'Dancing Script', 'Segoe Script', cursive",
  journal:      "'Caveat', 'Bradley Hand', cursive",
  comic:        "'Comic Neue', 'Crimson Text', Georgia, serif"
};
var CO_FONT_IMPORTS = {
  garamond:     'family=EB+Garamond:ital,wght@0,400;0,600;1,400',
  lora:         'family=Lora:ital,wght@0,400;0,600;1,400',
  merriweather: 'family=Merriweather:ital,wght@0,400;1,400',
  script:       'family=Dancing+Script:wght@400;500;600;700',
  journal:      'family=Caveat:wght@400;500;700',
  comic:        'family=Comic+Neue:ital,wght@0,400;0,700;1,400'
};
function coFontFamily(f){ if (!f || f === 'classic') return ''; return CO_FONTS[f] || ''; }
function coFontImport(f){ var q = CO_FONT_IMPORTS[f]; return q ? ("@import url('https://fonts.googleapis.com/css2?" + q + "&display=swap');") : ''; }

function parseCustomOpts(str) {
  var o = {};
  for (var k in CO_DEFAULTS) o[k] = CO_DEFAULTS[k];
  if (!str) return o;
  String(str).split(',').forEach(function (pair) {
    var idx = pair.indexOf(':');
    if (idx < 0) return;
    var k = pair.slice(0, idx).trim();
    var v = pair.slice(idx + 1).trim();
    if (!(k in CO_DEFAULTS)) return;
    if (typeof CO_DEFAULTS[k] === 'number') o[k] = (v === '1' || v === 'true') ? 1 : 0;
    else o[k] = v;
  });
  return o;
}

function coGutter(g) { return g === 'tight' ? '6px' : (g === 'airy' ? '0.22in' : '0.12in'); }
function coRowTarget(d) { return d === 'busy' ? 3.2 : (d === 'roomy' ? 2.0 : ROW_TARGET); }

// packRows variant that honors the density target and the panoramic-band toggle.
function coPackRows(items, opts) {
  var target = coRowTarget(opts.density);
  var rows = [], cur = [], sum = 0;
  function flush() { if (cur.length) { rows.push({ items: cur, sum: sum }); cur = []; sum = 0; } }
  items.forEach(function (it) {
    var sh = normShape(it.m);
    if (sh === 'panoramic' && opts.pano) { flush(); rows.push({ items: [it], sum: shapeAspect(sh) }); return; }
    cur.push(it); sum += shapeAspect(sh);
    if (sum >= target) flush();
  });
  flush();
  return rows;
}

// The chosen border treatment, applied to one image at its true ratio.
function coMedia(m, border) {
  var ratio = dispRatioCSS(m);
  // Overscan the image 1px past a clipping wrapper so a sub-pixel rounding gap at some zoom
  // levels can't show a thin hairline at the edge (covers the dark-bg peek AND a dark image
  // edge row). Applies to the default/comic/vignette border treatments below.
  var img = m.image
    ? '<div style="overflow:hidden;line-height:0;"><img style="width:calc(100% + 2px);aspect-ratio:' + ratio + ';object-fit:cover;display:block;margin:-1px;" src="' + m.image + '" alt="' + (m.title || '') + '" /></div>'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#1a0f06;"></div>';
  switch (border) {
    case 'frame': return framedMedia(m);
    case 'comic': return '<div style="border:5px solid #0a0806;background:#160e06;overflow:hidden;line-height:0;">' + img + '</div>';
    case 'vignette':
      return '<div style="position:relative;line-height:0;">' + img + vignetteOverlayHtml() + '</div>';
    case 'gallery':
      return m.image
        ? '<div style="padding:0 0.26in 0.26in 0;line-height:0;"><img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;border-radius:2px;box-shadow:' + CO_IMG_SHADOW + ';" src="' + m.image + '" alt="' + (m.title || '') + '" /></div>'
        : img;
    case 'keyline':
      return shapedImage(m, 'border:1px solid rgba(120,90,30,0.35);box-shadow:0 1px 5px rgba(0,0,0,0.12);', '4px');
    case 'none':
    default:
      return img;
  }
}

function coCaptionOverlay(m, caption) {
  if (!m.title) return '';
  if (caption === 'plate')
    return '<div style="position:absolute;top:0;left:0;max-width:80%;background:#f0e8d0;border:3px solid #0a0806;border-top:none;border-left:none;padding:3px 9px 4px;font-family:Cinzel,serif;font-size:8.5pt;font-weight:600;color:#0a0806;line-height:1.25;">' + m.title + '</div>';
  if (caption === 'gradient')
    return '<div style="position:absolute;left:0;right:0;bottom:0;padding:0.4in 0.22in 0.12in;background:linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.4) 55%,rgba(10,8,6,0));color:#f3e7c8;font-family:Cinzel,serif;font-size:10pt;font-weight:600;letter-spacing:0.03em;line-height:1.3;">' + m.title + '</div>';
  return '';
}

function coCaptionBelow(m, i, caption) {
  if (!m.title) return '';
  if (caption === 'engraved')
    return '<div style="text-align:center;margin-top:0.12in;font-family:Cinzel,serif;font-size:9.5pt;letter-spacing:0.12em;text-transform:uppercase;color:#8a6a2a;">' + m.title + '</div>';
  if (caption === 'bar') return panelCaption(m, i);
  return '';
}

// Caption for cover-filled cells (Comic / Magazine): every style renders ON the image,
// since there is no 'below the image' room. bar/engraved get their own backgrounds so
// they stay readable on a dark photo.
function coCaptionCover(m, caption) {
  if (!m.title) return '';
  if (caption === 'plate')
    return '<div style="position:absolute;top:0;left:0;max-width:80%;background:#f0e8d0;border:3px solid #0a0806;border-top:none;border-left:none;padding:3px 9px 4px;font-family:Cinzel,serif;font-size:8.5pt;font-weight:600;color:#0a0806;line-height:1.25;">' + m.title + '</div>';
  if (caption === 'gradient')
    return '<div style="position:absolute;left:0;right:0;bottom:0;padding:0.4in 0.22in 0.12in;background:linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.4) 55%,rgba(10,8,6,0));color:#f3e7c8;font-family:Cinzel,serif;font-size:10pt;font-weight:600;letter-spacing:0.03em;line-height:1.3;">' + m.title + '</div>';
  if (caption === 'bar')
    return '<div style="position:absolute;left:0;right:0;bottom:0;background:#f9f4e8;border-top:3px solid #c9a84c;padding:4px 9px;font-family:Cinzel,serif;font-size:9pt;font-weight:600;color:#2c1810;line-height:1.2;">' + m.title + '</div>';
  if (caption === 'engraved')
    return '<div style="position:absolute;left:0;right:0;bottom:0;background:rgba(245,239,225,0.92);padding:4px 6px;text-align:center;font-family:Cinzel,serif;font-size:9pt;letter-spacing:0.12em;text-transform:uppercase;color:#7a5d22;line-height:1.2;">' + m.title + '</div>';
  return '';
}

function coNarr(text, opts, isIntro) {
  if (!text) return '';
  if (opts.narr === 'box' && !isIntro) return '<div style="margin:0.16in 0;">' + buildClassicTextPanel(text) + '</div>';
  return buildNarrativeHTML(text, isIntro);
}

// Drop a large initial on the first narrative paragraph of the page.
function coDropcap(html) {
  if (!html) return html;
  return html.replace(/(<p[^>]*>)(\s*)([A-Za-z])/, function (mm, tag, sp, ch) {
    return tag + '<span style="float:left;font-family:Cinzel,serif;font-size:34pt;line-height:0.8;font-weight:700;color:#7a5418;margin:2px 6px 0 0;">' + ch + '</span>';
  });
}

function coCell(m, i, pct, opts) {
  var overlay = coCaptionOverlay(m, opts.caption);
  var media = '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>';
  return '<div style="width:' + pct + '%;page-break-inside:avoid;">' + media + coCaptionBelow(m, i, opts.caption) + '</div>';
}

function coRow(row, opts) {
  var divisor = Math.max(row.sum, ROW_MIN);
  var g = coGutter(opts.gutter);
  var cells = row.items.map(function (it) {
    return coCell(it.m, it.i, (shapeAspect(normShape(it.m)) / divisor) * 100, opts);
  }).join('');
  return '<div style="display:flex;gap:' + g + ';margin-bottom:' + g + ';align-items:flex-start;line-height:0;">' + cells + '</div>';
}

// Tall/tower aside that honors the companion-pull toggle and the chosen border.
function coPortrait(moments, sections, i, opts) {
  var m = moments[i];
  var section = sections.find(function (s) { return s.panel_index === i; }) || {};
  var side = (section.before ? coNarr(section.before, opts, false) : '') + coNarr(section.after || m.description || m.title || '', opts, false);
  var consumed = 0;
  var nxt = moments[i + 1];
  if (opts.companion && nxt && companionEligible(nxt)) {
    side += '<div style="margin-top:0.16in;">' + coMedia(nxt, opts.border) + '</div>';
    var nsec = sections.find(function (s) { return s.panel_index === (i + 1); }) || {};
    if (nsec.before) side += '<div style="margin-top:0.1in;">' + coNarr(nsec.before, opts, false) + '</div>';
    if (nsec.after) side += '<div style="margin-top:0.1in;">' + coNarr(nsec.after, opts, false) + '</div>';
    consumed = 1;
  }
  return { html: asideBlock(coMedia(m, opts.border), side, (i % 2 === 0)), consumed: consumed };
}

function coIsAsidePortrait(m, opts) { return opts.aside && isPortrait(m); }

function renderGrid(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);
  var buf = [];
  function flush() {
    if (!buf.length) return;
    coPackRows(buf, opts).forEach(function (r) {
      html += coRow(r, opts);
      r.items.forEach(function (it) {
        var sec = sections.find(function (s) { return s.panel_index === it.i; }) || {};
        if (sec.before) html += coNarr(sec.before, opts, false);
        if (sec.after) html += coNarr(sec.after, opts, false);
      });
    });
    buf = [];
  }
  for (var i = 0; i < moments.length; i++) {
    if (coIsAsidePortrait(moments[i], opts)) {
      flush();
      var r = coPortrait(moments, sections, i, opts);
      html += r.html; i += r.consumed;
    } else {
      buf.push({ m: moments[i], i: i });
    }
  }
  flush();
  html += buildNarrativeHTML(outro, true);
  return html;
}

function renderStack(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    if (coIsAsidePortrait(m, opts)) {
      var r = coPortrait(moments, sections, i, opts);
      html += r.html; i += r.consumed; continue;
    }
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var shape = normShape(m);
    var widthPct = isLandscape(shape) ? 100 : (shape === 'square' ? 64 : 54);
    var overlay = coCaptionOverlay(m, opts.caption);
    html += '<div style="width:' + widthPct + '%;margin:0.2in auto 0.1in;page-break-inside:avoid;">' +
      '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
      coCaptionBelow(m, i, opts.caption) + '</div>';
    if (section.before) html += coNarr(section.before, opts, false);
    if (section.after) html += coNarr(section.after, opts, false);
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

function renderSplash(moments, sections, intro, outro, opts) {
  // Splash = a big full-width HERO panel punctuating each spread, with the
  // remaining panels flowing into a denser packed grid (distinct from Stack's
  // single column). Heroes land on a regular cadence plus any natural big shape.
  var html = coDropOrIntro(intro, opts);
  var denseOpts = Object.assign({}, opts, { density: 'busy' });
  var buf = [];
  function panelNarr(idx) {
    var sec = sections.find(function (s) { return s.panel_index === idx; }) || {};
    var out = '';
    if (sec.before) out += coNarr(sec.before, opts, false);
    if (sec.after) out += coNarr(sec.after, opts, false);
    return out;
  }
  function flushGrid() {
    if (!buf.length) return;
    coPackRows(buf, denseOpts).forEach(function (r) { html += coRow(r, opts); });
    buf.forEach(function (it) { html += panelNarr(it.i); });
    buf = [];
  }
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    if (coIsAsidePortrait(m, opts)) {
      flushGrid();
      var r = coPortrait(moments, sections, i, opts);
      html += r.html; i += r.consumed; continue;
    }
    var isHero = (i % 3 === 0) || ['panoramic', 'wide'].indexOf(normShape(m)) >= 0 || (opts.emphasis && m.type === 'combat');
    if (isHero) {
      flushGrid();
      var overlay = coCaptionOverlay(m, opts.caption);
      html += '<div style="width:100%;margin:0.2in 0 0.12in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      html += panelNarr(i);
    } else {
      buf.push({ m: m, i: i });
    }
  }
  flushGrid();
  html += buildNarrativeHTML(outro, true);
  return html;
}

function pbBesidePanel(m, sec, idx, opts) {
  // A small panel rendered to STACK in the column beside a full-height Picture Book tower.
  var ov = coCaptionOverlay(m, opts.caption);
  var img = '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + ov + '</div>' + coCaptionBelow(m, idx, opts.caption);
  var nb = sec.before ? '<div style="margin-top:0.1in;">' + coNarr(sec.before, opts, false) + '</div>' : '';
  var na = sec.after ? '<div style="margin-top:0.1in;">' + coNarr(sec.after, opts, false) + '</div>' : '';
  return '<div style="margin-bottom:0.14in;">' + img + nb + na + '</div>';
}
function renderPaired(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);
  var pbN = 0;
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var overlay = coCaptionOverlay(m, opts.caption);
    var beforeHtml = section.before ? '<div style="margin-top:0.1in;">' + coNarr(section.before, opts, false) + '</div>' : '';
    var afterHtml = section.after ? '<div style="margin-top:0.1in;">' + coNarr(section.after, opts, false) + '</div>' : '';
    if (isPortrait(m)) {
      // Picture Book portraits FLOAT left/right (alternating) with the narrative
      // beside and flowing below them, instead of centered with the text underneath.
      // Towering (narrow) shots go full page height; tall shots stay large but cap
      // their width so a readable narrative column fits alongside. (7.0in tall target
      // sentinel preserved below; tune pbCol to trade image size vs side-text width.)
      var pbTower = (normShape(m) === 'tower');
      var pbCol = 2.6;
      // Towers are generated as a true tall column (1:4); show them at their REAL aspect.
      // coMedia uses dispRatioCSS (the stored pixel ratio for towers), so object-fit:cover
      // fills the box with NO crop. Tower width is derived from the real aspect at a ~9.2in
      // target height so it stands nearly full-page; tall shots keep the 7.0in target below.
      var pbW = pbTower
        ? Math.min(6.8 - pbCol, 9.2 * momentAspect(m))
        : Math.min(6.8 - pbCol, 7.0 * shapeAspect(normShape(m)));
      var pbLeft = (pbN % 2 === 0); pbN += 1;
      var pbFl = pbLeft ? 'float:left;margin:0 0.24in 0.12in 0;' : 'float:right;margin:0 0 0.12in 0.24in;';
      var pbImg = '<div style="' + pbFl + 'width:' + pbW.toFixed(2) + 'in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      if (pbTower) {
        // Fill the wide empty space beside the thin full-height tower: pull up to 3 following
        // SMALL panels (not wide/panoramic/another tower) into a block-formatting-context column
        // that sits alongside the float. The shared flow-root still clears, so document flow after
        // the tower is unchanged -- only the previously-empty side column gets populated.
        var pbBeside = '', pbAdv = 0, pbFill = 0;
        while ((i + 1 + pbAdv) < moments.length && pbFill < 3) {
          var pbNs = normShape(moments[i + 1 + pbAdv]);
          if (pbNs === 'tower' || pbNs === 'panoramic' || pbNs === 'wide') break;
          var pbIdx = i + 1 + pbAdv;
          var pbNsec = sections.find(function (s) { return s.panel_index === pbIdx; }) || {};
          pbBeside += pbBesidePanel(moments[pbIdx], pbNsec, pbIdx, opts);
          pbAdv += 1; pbFill += 1;
        }
        var pbCol = '<div style="display:flow-root;">' + beforeHtml + afterHtml + pbBeside + '</div>';
        html += '<div style="display:flow-root;margin-bottom:0.1in;">' + pbImg + pbCol + '</div>';
        i += pbAdv;
      } else {
        html += '<div style="display:flow-root;margin-bottom:0.1in;">' + pbImg + beforeHtml + afterHtml + '</div>';
      }
    } else {
      // Wide / panoramic / square / standard: keep the image + caption together
      // in the avoid-block, but let the narrative flow BELOW as its own block so
      // a wide shot is never dragged onto the next page by long text. Two wide
      // shots then pack onto one sheet when there is room instead of stranding
      // white space at a page bottom.
      html += '<div style="width:100%;margin:0 auto 0.06in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      html += beforeHtml + afterHtml;
    }
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

function coDropOrIntro(intro, opts) {
  var h = buildNarrativeHTML(intro, true);
  return opts.dropcap ? coDropcap(h) : h;
}

// ---- Comic Page (shape-driven spans) helpers ----
// Each image cell is sized to its shape's aspect so object-fit barely crops, and
// every band fills the full content width -- no holes, no black show-through.
var CG_W = 6.8;     // content column width (inches), used for aspect-based heights
var CG_GAP = 0.12;  // gutter between panels (inches)
var CO_TOWER_H = 9.2; // tower full-page-height target (inches): towers always run this tall
var CG_BORDER = 'border:4px solid #0a0806;overflow:hidden;';
var CG_FRAME  = 'border:12px solid #0a0806;overflow:hidden;'; // bold comic panel frame (Comic only)
function picBorderCss(opts){
  // The picture-border option, applied identically in EVERY layout. Default: none.
  switch (opts && opts.border) {
    case 'keyline':  return 'border:1px solid rgba(120,90,30,0.35);';
    case 'frame':    return 'border:3px solid #2c1e10;box-shadow:inset 0 0 0 1.5px #c9a84c;';
    case 'comic':    return 'border:5px solid #0a0806;';
    case 'gallery':  return 'box-shadow:' + CO_IMG_SHADOW + ';';
    case 'vignette': return '';
    case 'none':
    default:         return '';
  }
}
function cgBorder(opts){ return picBorderCss(opts) + 'overflow:hidden;'; }
function vignetteOverlayHtml(){
  // Strong fade so the rectangular edge is fully gone -- image looks drawn on the page.
  return '<div style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0.45in 0.4in #ffffff;"></div>' +
    '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(255,255,255,0) 46%, rgba(255,255,255,0.7) 76%, rgba(255,255,255,1) 92%);"></div>';
}
function picOverlay(opts){
  var b = opts && opts.border;
  if (b === 'vignette') return vignetteOverlayHtml();
  if (b === 'frame') {
    // Two thin gold lines + a small diamond node tucked into each corner where the
    // lines meet, so the corner reads as part of the frame line. The cell clips,
    // so the diamonds sit just inside the corner rather than centred on the edge.
    var _d = function(pos){ return '<i style="position:absolute;' + pos + 'width:5px;height:5px;background:#c9a84c;transform:rotate(45deg);box-shadow:0 0 0 1px #2c1e10;"></i>'; };
    var _diamonds = _d('top:1px;left:1px;') + _d('top:1px;right:1px;') + _d('bottom:1px;left:1px;') + _d('bottom:1px;right:1px;');
    return '<div style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px #c9a84c, inset 0 0 0 2px #2c1e10, inset 0 0 0 3px #c9a84c;">' + _diamonds + '</div>';
  }
  return '';
}

function cgClass(m) {
  var s = normShape(m);
  if (s === 'wide' || s === 'panoramic') return 'wide';
  if (s === 'tall' || s === 'tower') return 'tall';
  return 'small';
}

function cgFocalPos(focal) {
  if (focal === 'top') return 'center top';
  if (focal === 'bottom') return 'center bottom';
  if (focal === 'left') return 'left center';
  if (focal === 'right') return 'right center';
  return 'center';
}

function cgImgCell(m, opts, heightIn, widthPct) {
  var w = (widthPct != null) ? ('flex:0 0 ' + widthPct + '%;max-width:' + widthPct + '%;') : 'flex:1 1 0;min-width:0;';
  var h = (heightIn != null) ? ('height:' + heightIn.toFixed(2) + 'in;') : 'height:100%;';
  var fit = lmCropSafe(m)
    ? ('object-fit:cover;object-position:' + cgFocalPos(lmFocal(m)) + ';')
    : 'object-fit:contain;';
  var media = m.image
    ? '<img style="width:100%;height:100%;' + fit + 'display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  return '<div style="' + CG_BORDER + w + h + 'position:relative;background:#000;line-height:0;">' + media + coCaptionOverlay(m, opts.caption) + '</div>';
}

function cgTextCell(htmlText, heightIn, widthPct) {
  var w = (widthPct != null) ? ('flex:0 0 ' + widthPct + '%;max-width:' + widthPct + '%;') : 'flex:1 1 0;min-width:0;';
  var h = (heightIn != null) ? ('height:' + heightIn.toFixed(2) + 'in;overflow:hidden;') : '';
  return '<div style="' + CG_BORDER + w + h + 'background:#fbf3cf;padding:0.15in 0.17in;line-height:1.45;">' + htmlText + '</div>';
}

function cgBand(inner) {
  return '<div style="display:flex;gap:' + CG_GAP + 'in;margin-bottom:' + CG_GAP + 'in;align-items:stretch;page-break-inside:avoid;break-inside:avoid;">' + inner + '</div>';
}

// One image cell in a justified comic tier. Width and height are explicit inches:
// width = tierHeight * the image's TRUE aspect, so the cell's aspect matches the
// image and `cover` shows the whole frame with no crop. Honors crop_safe/focal.
function cgGridCell(m, opts, wIn, hIn) {
  var fit = lmCropSafe(m)
    ? ('object-fit:cover;object-position:' + cgFocalPos(lmFocal(m)) + ';')
    : 'object-fit:contain;';
  var media = m.image
    ? '<img style="width:100%;height:100%;' + fit + 'display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  return '<div style="' + CG_BORDER + 'flex:0 0 ' + wIn.toFixed(3) + 'in;width:' + wIn.toFixed(3) + 'in;height:' + hIn.toFixed(3) + 'in;position:relative;background:#000;line-height:0;">' +
    media + coCaptionOverlay(m, opts.caption) + '</div>';
}

// A full-width caption box spanning a tier: narration as an in-grid comic caption
// panel (heavy ink border + caption ground), not floating prose between rows.
function cgCaptionTier(inner) {
  return '<div style="' + CG_BORDER + 'background:#fbf3cf;padding:0.13in 0.16in;line-height:1.4;' +
    'margin-bottom:' + CG_GAP + 'in;page-break-inside:avoid;break-inside:avoid;">' + inner + '</div>';
}

// ---- Comic (intermixed flow): full prose always, images woven INTO the text ----
// The inner media of one comic image: cover-cropped, focal-aware, crop_safe honored.
function cgImgMedia(m, opts) {
  // Cover images OVERSCAN the box by 1px on every side so a sub-pixel rounding gap at certain
  // browser-zoom levels can't reveal the dark box background as a thin black hairline at the
  // edge (the overflow:hidden box clips the overscan). Contain (letterbox) images stay exact.
  var fit = lmCropSafe(m)
    ? ('object-fit:cover;object-position:' + cgFocalPos(lmFocal(m)) + ';width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;')
    : 'object-fit:contain;width:100%;height:100%;';
  return m.image
    ? '<img style="' + fit + 'display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
}

// A floated image with the panel's full narrative flowing around and below it.
function cgFlowFloat(m, opts, narrHtml, sideLeft, small) {
  var asp = Math.max(0.3, momentAspect(m));
  var imgH = small ? ((asp < 0.85) ? 2.2 : 1.7) : ((asp < 0.85) ? 3.5 : 2.7);
  var imgW = imgH * asp;
  var capW = small ? 2.1 : 3.3;
  if (imgW > capW) { imgW = capW; imgH = imgW / asp; }
  var fl = sideLeft ? 'float:left;margin:0.04in 0.20in 0.10in 0;'
                    : 'float:right;margin:0.04in 0 0.10in 0.20in;';
  var box = '<div style="' + fl + cgBorder(opts) + 'width:' + imgW.toFixed(2) + 'in;height:' + imgH.toFixed(2) +
    'in;position:relative;background:transparent;line-height:0;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return '<div style="display:flow-root;margin-bottom:0.10in;">' + box + (narrHtml || '') + '</div>';
}

function cgFlowTower(m, opts, narrHtml, besideHtml, sideLeft) {
  // Tower: full-page-height image flush to a margin. Its narrative PLUS any absorbed small
  // panels (besideHtml) stack in a block that sits BESIDE the tower -- a new block-formatting
  // context is shortened to fit alongside the float -- filling the tall column instead of
  // leaving white space next to the thin tower.
  var ta = momentAspect(m);
  var imgH = CO_TOWER_H;
  var imgW = imgH * ta;
  var fl = sideLeft ? 'float:left;margin:0 0.20in 0.10in 0;'
                    : 'float:right;margin:0 0 0.10in 0.20in;';
  var box = '<div style="' + fl + cgBorder(opts) + 'width:' + imgW.toFixed(2) + 'in;height:' + imgH.toFixed(2) +
    'in;position:relative;background:transparent;line-height:0;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  var col = '<div style="display:flow-root;">' + (narrHtml || '') + (besideHtml || '') + '</div>';
  return '<div style="display:flow-root;margin-bottom:0.10in;">' + box + col + '</div>';
}
function cgBesidePanel(m, opts, narrHtml) {
  // A small panel rendered to STACK in the column beside a full-height tower (NOT floated).
  var box = '<div style="' + cgBorder(opts) + 'width:100%;aspect-ratio:' + dispRatioCSS(m) + ';position:relative;background:transparent;line-height:0;margin-bottom:0.06in;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return '<div style="margin-bottom:0.12in;">' + box + (narrHtml || '') + '</div>';
}

// A wide/panoramic image breaks the column full width; prose flows after it.
function cgFlowWide(m, opts, narrHtml) {
  // Full-width wide image at its NATURAL height -- no fixed-height box, no contain,
  // no #000 fill -- so the frame wraps the art exactly and a black void is impossible
  // even when the stored aspect and the real image disagree.
  var media = m.image
    ? '<img style="width:100%;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + shapeRatioCSS(normShape(m)) + ';background:#1a0f06;"></div>';
  var box = '<div style="' + cgBorder(opts) + 'width:100%;position:relative;line-height:0;' +
    'margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
    media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return box + (narrHtml || '');
}

// Two images side by side (used when a panel has no narrative of its own).
function cgFlowPair(a, b, opts, narrHtml) {
  var aspA = Math.max(0.3, momentAspect(a)), aspB = Math.max(0.3, momentAspect(b));
  var availW = CG_W - CG_GAP;
  var H = Math.min(3.2, availW / (aspA + aspB));
  function cell(m, asp) {
    return '<div style="' + cgBorder(opts) + 'width:' + (asp * H).toFixed(2) + 'in;height:' + H.toFixed(2) +
      'in;position:relative;background:transparent;line-height:0;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  }
  var row = '<div style="display:flex;gap:' + CG_GAP + 'in;margin-bottom:0.10in;justify-content:center;' +
    'page-break-inside:avoid;break-inside:avoid;">' + cell(a, aspA) + cell(b, aspB) + '</div>';
  return row + (narrHtml || '');
}

// A featured (peak-prominence) image. A wide shot fills the width at half-page
// height (cover-cropped via focal); anything else blows up toward full page.
function cgFlowFeature(m, opts, narrHtml) {
  var asp = Math.max(0.3, momentAspect(m));
  if (asp >= 1.5) {
    // Wide feature: full-width at its NATURAL height -- container = image size, so
    // no fixed box, no contain, no #000 void (same fix as cgFlowWide).
    var media = m.image
      ? '<img style="width:100%;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
      : '<div style="width:100%;aspect-ratio:' + shapeRatioCSS(normShape(m)) + ';background:#1a0f06;"></div>';
    var wbox = '<div style="' + cgBorder(opts) + 'width:100%;position:relative;line-height:0;' +
      'margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
      media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
    return wbox + (narrHtml || '');
  }
  // Non-wide feature blows up toward full page; box matches the image aspect and
  // fills via focal cover, so there is no void either.
  var H = Math.min(8.4, CG_W / asp);
  var W = Math.min(CG_W, H * asp);
  var ctr = (W < CG_W - 0.01) ? 'margin-left:auto;margin-right:auto;' : '';
  var img = m.image
    ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  var box = '<div style="' + cgBorder(opts) + 'width:' + W.toFixed(2) + 'in;height:' + H.toFixed(2) + 'in;' + ctr +
    'position:relative;background:transparent;line-height:0;margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
    img + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return box + (narrHtml || '');
}

// Comic will be rebuilt off the magazine flow later; for now it mirrors Magazine.
function cgSplitNarr(text){
  // Break a narrative blob into panel-sized chunks (~2-4 sentences each).
  if (!text) return [];
  var s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return [];
  var sents = s.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [s];
  var chunks = [], buf = '', cnt = 0;
  for (var i = 0; i < sents.length; i++) {
    buf += sents[i]; cnt++;
    if ((cnt >= 2 && buf.length >= 140) || buf.length >= 300) { chunks.push(buf.trim()); buf = ''; cnt = 0; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}
function renderComicPage(moments, sections, intro, outro, opts) {
  // Comic = a tic-tac-toe LATTICE (v4). Two-column base grid of bold-framed cells.
  // ORIENTATION IS KEYED OFF THE IMAGE ASPECT: wide/panoramic art spans BOTH columns
  // (a full-width horizontal band), tall/tower art spans two rows (a tall panel), and
  // square/standard art takes one cell. Panel HEIGHT also comes from the image aspect
  // (capped); panels do NOT stretch to match prose. Narration cells grow to fit their
  // text independently (align:start). Spill/auto-fit comes next.
  var html = coDropOrIntro(intro, opts);

  function comicArt(m, span, h, boxW) {
    var media = m.image
      ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
      : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
    var spanCss = (span === 'tall') ? 'grid-row:span 2;' : ((span === 'wide') ? 'grid-column:span 2;' : '');
    // Tall/tower cells hug the image's TRUE width at this height (boxW) and center in the
    // column, so an extreme (1:4) tower shows in FULL with no crop -- the column gaps stay
    // page-colored, not black. Normal portraits have boxW == colW, so they fill as before.
    var sizeCss = (span === 'tall' && boxW) ? ('width:' + boxW.toFixed(2) + 'in;max-width:100%;justify-self:center;') : '';
    return '<div style="' + cgBorder(opts) + 'background:transparent;position:relative;overflow:hidden;line-height:0;' +
      'height:' + h.toFixed(2) + 'in;align-self:start;break-inside:avoid;page-break-inside:avoid;' +
      spanCss + sizeCss + '">' + media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  }

  var cells = [];
  var towerN = 0;
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    var sec = sections.find(function (s) { return s.panel_index === i; }) || {};
    if (normShape(m) === 'tower') {
      // Towers ALWAYS get a full-page-height panel flush to a margin (alternating sides),
      // with the narration butting right up to the picture border (gap:0). Sized to the
      // true 1:4 aspect so the image is shown in full, never cropped.
      var twTa = momentAspect(m);
      var twW = CO_TOWER_H * twTa;
      var twMedia = m.image
        ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
        : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
      var twBox = '<div style="' + cgBorder(opts) + 'background:transparent;position:relative;line-height:0;flex:0 0 ' + twW.toFixed(2) + 'in;height:' + CO_TOWER_H.toFixed(2) + 'in;">' + twMedia + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
      var twNarr = '';
      if (sec.before) twNarr += buildNarrativeHTML(sec.before, false);
      if (sec.after) twNarr += buildNarrativeHTML(sec.after, false);
      var twText = '<div style="' + picBorderCss(opts) + 'background:#fbf3cf;flex:1 1 auto;min-width:0;padding:0.16in 0.18in;line-height:1.4;overflow:hidden;">' + twNarr + '</div>';
      var twLeft = (towerN % 2 === 0); towerN += 1;
      cells.push({ slots: 2, html: '<div style="grid-column:span 2;display:flex;gap:' + CG_GAP + 'in;align-items:stretch;break-inside:avoid;page-break-inside:avoid;">' + (twLeft ? (twBox + twText) : (twText + twBox)) + '</div>' });
      continue;
    }
    // Maximize (prominence 4-5): break the grid and run a full-width SPLASH that
    // blows up toward full page. Shape-aware (mirrors the Magazine feature): wide
    // art becomes a full-width band; portrait/square art blows up centered,
    // aspect-preserved (no crop), with its narration in a full-width box below.
    var _tier = lmSizeTier(m);
    if (_tier === 'max') {
      var _fAsp = Math.max(0.3, momentAspect(m));
      var _fMedia = m.image
        ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
        : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
      var _fImgBox;
      if (_fAsp >= 1.5) {
        var _fH = CG_W / _fAsp;
        _fImgBox = '<div style="' + cgBorder(opts) + 'width:100%;height:' + _fH.toFixed(2) + 'in;position:relative;background:transparent;line-height:0;break-inside:avoid;page-break-inside:avoid;">' + _fMedia + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
      } else {
        var _fH2 = Math.min(8.4, CG_W / _fAsp);
        var _fW2 = Math.min(CG_W, _fH2 * _fAsp);
        var _fCtr = (_fW2 < CG_W - 0.01) ? 'margin-left:auto;margin-right:auto;' : '';
        _fImgBox = '<div style="' + cgBorder(opts) + 'width:' + _fW2.toFixed(2) + 'in;height:' + _fH2.toFixed(2) + 'in;' + _fCtr + 'position:relative;background:transparent;line-height:0;break-inside:avoid;page-break-inside:avoid;">' + _fMedia + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
      }
      cells.push({ slots: 2, html: '<div style="grid-column:span 2;break-inside:avoid;page-break-inside:avoid;">' + _fImgBox + '</div>' });
      var _fParts = [];
      if (sec.before) _fParts = _fParts.concat(cgSplitNarr(sec.before));
      if (sec.after) _fParts = _fParts.concat(cgSplitNarr(sec.after));
      var _fTxt = _fParts.join(' ');
      if (_fTxt) {
        cells.push({ slots: 2, html: '<div style="' + picBorderCss(opts) + 'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;min-height:1.2in;align-self:start;break-inside:avoid;page-break-inside:avoid;grid-column:span 2;">' + buildNarrativeHTML(_fTxt, false) + '</div>' });
      }
      continue;
    }
    var ta = momentAspect(m);
    var asp = Math.max(0.3, ta);
    var tall = isPortrait(m);
    var wide = (asp >= 1.5);
    var colW = (CG_W - CG_GAP) / 2;
    var span = tall ? 'tall' : (wide ? 'wide' : '');
    var imgH = wide ? (CG_W / asp) : Math.min(7.0, colW / asp);
    // For tall/tower, hug the image's true width at this height so a 1:4 tower isn't cropped.
    var boxW = tall ? Math.min(colW, imgH * ta) : null;
    if (_tier === 'min') { tall = false; wide = false; span = ''; imgH = Math.min(2.6, colW / asp); boxW = null; }
    cells.push({ slots: tall ? 2 : 1, html: comicArt(m, span, imgH, boxW) });
    var nchunks = [];
    if (sec.before) nchunks = nchunks.concat(cgSplitNarr(sec.before));
    if (sec.after) nchunks = nchunks.concat(cgSplitNarr(sec.after));
    // At most TWO narration boxes per moment, each a single combined box -- never a stack
    // of same-width boxes. A tall image leaves a 2-row column beside it, a single image 1
    // row, a full-width image none. Text is budgeted to fill the beside column by the
    // image's height; whatever is left becomes ONE full-width band below.
    var besideRows = tall ? 2 : (wide ? 0 : 1);
    // ~115 chars per inch of column height is what actually fits beside the image; stop
    // BEFORE a chunk would push the box past the picture's bottom (but always keep >=1).
    var besideBudget = Math.round(imgH * 115);
    var besideTxt = '', restTxt = '', acc = 0, qi = 0;
    if (besideRows > 0) {
      for (; qi < nchunks.length; qi++) {
        if (besideTxt !== '' && acc + nchunks[qi].length > besideBudget) break;
        besideTxt += (besideTxt ? ' ' : '') + nchunks[qi]; acc += nchunks[qi].length;
      }
    }
    // Overflow past the picture + everything else become ONE full-width box below.
    for (; qi < nchunks.length; qi++) restTxt += (restTxt ? ' ' : '') + nchunks[qi];
    if (besideTxt) {
      var bspan = (besideRows > 1) ? ('grid-row:span ' + besideRows + ';') : '';
      cells.push({ slots: besideRows, html: '<div style="' + picBorderCss(opts) +
        'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;min-height:' + imgH.toFixed(2) + 'in;align-self:start;break-inside:avoid;page-break-inside:avoid;' + bspan + '">' + buildNarrativeHTML(besideTxt, false) + '</div>' });
    }
    if (restTxt) {
      cells.push({ slots: 2, html: '<div style="' + picBorderCss(opts) +
        'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;min-height:1.2in;align-self:start;break-inside:avoid;page-break-inside:avoid;grid-column:span 2;">' + buildNarrativeHTML(restTxt, false) + '</div>' });
    }
  }

  var cellHtml = cells.map(function (x) { return x.html; }).join('');
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:auto;gap:' +
    CG_GAP + 'in;grid-auto-flow:row dense;align-items:start;">' +
    cellHtml + '</div>';

  html += buildNarrativeHTML(outro, true);
  return html;
}

// Magazine flow: images float and the narrative text wraps around them.
function magFull(shape){ return shape === 'panoramic' || shape === 'wide'; }
function magWidth(shape){ if (shape === 'tall' || shape === 'tower') return 44; if (shape === 'square') return 50; return 54; }
function magSoloWidth(shape){ if (shape === 'tower') return 56; if (shape === 'tall') return 64; if (shape === 'square') return 72; return 100; }
function coNarrLen(s){ return s ? String(s).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length : 0; }
function magWrapMin(shape){ if (shape === 'tall' || shape === 'tower') return 480; if (shape === 'square') return 360; return 300; }
function coFloatImg(m, i, side, opts){
  var media = coMedia(m, opts.border);
  var overlay = coCaptionOverlay(m, opts.caption);
  var cap = coCaptionBelow(m, i, opts.caption);
  var mar = (side === 'left') ? 'margin:0.06in 0.3in 0.2in 0;' : 'margin:0.06in 0 0.2in 0.3in;';
  return '<div style="float:' + side + ';width:' + magWidth(normShape(m)) + '%;' + mar + 'page-break-inside:avoid;">' +
    '<div style="position:relative;line-height:0;">' + media + overlay + '</div>' + cap +
  '</div>';
}
// Short-paragraph beat: image beside text. The less text there is, the wider
// (bigger) the image -- it grows to use the room the narrative doesn't need,
// so the two columns end up roughly balanced in height.
function magAsideWidth(shape, nlen, wmin){
  var maxW, minW;
  if (shape === 'tall' || shape === 'tower') { maxW = 70; minW = 52; }
  else if (shape === 'square') { maxW = 72; minW = 56; }
  else { maxW = 72; minW = 58; }
  var t = Math.max(0, Math.min(1, nlen / wmin));
  return Math.round(maxW - (maxW - minW) * t);
}
function magAside(m, i, opts, narrText, imgW){
  var imgCol = '<div style="flex:0 0 ' + imgW + '%;width:' + imgW + '%;">' +
    '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + coCaptionOverlay(m, opts.caption) + '</div>' +
    coCaptionBelow(m, i, opts.caption) + '</div>';
  var txtCol = '<div style="flex:1 1 auto;min-width:0;">' + coNarr(narrText, opts, false) + '</div>';
  var imgLeft = (i % 2 === 0);
  return '<div style="clear:both;display:flex;align-items:center;gap:0.26in;margin:0.14in 0;page-break-inside:avoid;">' +
    (imgLeft ? (imgCol + txtCol) : (txtCol + imgCol)) + '</div>';
}
function renderMagazine(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);

  // Intermixed flow: walk panels IN ORDER, anchor each image, build the full prose
  // around it. Wide images break the column full-width; others float so narrative
  // wraps around and below them; an image with no narrative pairs with the next one.
  // A FEATURE beat (a genuine prominence peak) blows up to half/full page.
  var panels = [];
  for (var k = 0; k < moments.length; k++) {
    var mm = moments[k];
    var sec = sections.find(function (s) { return s.panel_index === k; }) || {};
    var parts = [];
    if (sec.before) parts.push(coNarr(sec.before, opts, false));
    if (sec.after) parts.push(coNarr(sec.after, opts, false));
    panels.push({ m: mm, asp: Math.max(0.3, momentAspect(mm)), narr: parts.join(''), prom: lmProminence(mm), tier: lmSizeTier(mm), feature: false });
  }
  // Maximize (prominence 4-5) blows the beat up to a feature. This is now a
  // deliberate 3-way control (Minimize / Default / Maximize), so no peak gate.
  for (var h = 0; h < panels.length; h++) {
    panels[h].feature = (panels[h].tier === 'max');
  }

  var i = 0, sideLeft = true;
  while (i < panels.length) {
    var p = panels[i];
    if (normShape(p.m) === 'tower') {
      var mzBeside = '', mzAdv = 1, mzFill = 0;
      while ((i + mzAdv) < panels.length && mzFill < 3) {
        var mzNp = panels[i + mzAdv];
        if (normShape(mzNp.m) === 'tower' || mzNp.feature || mzNp.asp >= 1.5) break;
        mzBeside += cgBesidePanel(mzNp.m, opts, mzNp.narr);
        mzAdv += 1; mzFill += 1;
      }
      html += cgFlowTower(p.m, opts, p.narr, mzBeside, sideLeft); sideLeft = !sideLeft; i += mzAdv;
    } else if (p.feature) {
      html += cgFlowFeature(p.m, opts, p.narr); i += 1;
    } else if (p.tier === 'min') {
      html += cgFlowFloat(p.m, opts, p.narr, sideLeft, true); sideLeft = !sideLeft; i += 1;
    } else if (p.asp >= 1.5) {
      html += cgFlowWide(p.m, opts, p.narr); i += 1;
    } else if (!p.narr && (i + 1) < panels.length && panels[i + 1].asp < 1.5 && normShape(panels[i + 1].m) !== 'tower') {
      html += cgFlowPair(p.m, panels[i + 1].m, opts, panels[i + 1].narr); i += 2;
    } else {
      html += cgFlowFloat(p.m, opts, p.narr, sideLeft); sideLeft = !sideLeft; i += 1;
    }
  }

  html += buildNarrativeHTML(outro, true);
  return html;
}

function renderLayout(opts, moments, sections, intro, outro) {
  if (!moments || !moments.length) return '<p style="color:#6b5f55;font-style:italic;text-align:center;padding:1in;">No panels yet - generate your storyboard first.</p>';
  sections = sections || []; intro = intro || ''; outro = outro || '';
  switch (opts.arrange) {
    case 'stack':  return renderStack(moments, sections, intro, outro, opts);
    case 'splash': return renderSplash(moments, sections, intro, outro, opts);
    case 'paired': return renderPaired(moments, sections, intro, outro, opts);
    case 'comicpage': return renderComicPage(moments, sections, intro, outro, opts);
    case 'magazine': return renderMagazine(moments, sections, intro, outro, opts);
    case 'grid':
    default:       return renderGrid(moments, sections, intro, outro, opts);
  }
}

// ---- Page background (paper) ----
var CO_SMOKE_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 850 1100' preserveAspectRatio='none'>" +
  "<defs><filter id='b' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='9'/></filter></defs>" +
  "<g fill='none' stroke-linecap='round' filter='url(#b)'>" +
  "<path d='M150 1110 C110 960 245 880 160 740 C100 630 225 560 150 440 C112 360 198 300 162 215' stroke='rgba(32,28,26,0.24)' stroke-width='20'/>" +
  "<path d='M255 1110 C330 980 195 905 285 795 C348 705 238 645 305 535 C338 472 288 410 320 350' stroke='rgba(32,28,26,0.16)' stroke-width='14'/>" +
  "<path d='M690 1110 C765 965 635 895 720 775 C785 685 668 615 742 505 C778 445 720 388 752 318' stroke='rgba(32,28,26,0.22)' stroke-width='18'/>" +
  "<path d='M600 1110 C548 985 660 928 596 826 C552 756 642 698 590 606' stroke='rgba(32,28,26,0.14)' stroke-width='12'/>" +
  "</g></svg>";
var CO_SMOKE_ENC = encodeURIComponent(CO_SMOKE_SVG).replace(/\(/g, '%28').replace(/\)/g, '%29');
var CO_SMOKE_URL = 'url("data:image/svg+xml,' + CO_SMOKE_ENC + '")';

var CO_PARCHMENT_CSS =
  'background-color:#f4e8c9;' +
  'background-image:' +
  'radial-gradient(ellipse at 9% 6%, rgba(110,75,28,0.11), transparent 42%),' +
  'radial-gradient(ellipse at 91% 13%, rgba(110,75,28,0.08), transparent 46%),' +
  'radial-gradient(ellipse at 20% 95%, rgba(85,55,18,0.11), transparent 42%),' +
  'radial-gradient(ellipse at 83% 87%, rgba(110,75,28,0.07), transparent 46%);' +
  'box-shadow: inset 0 0 1.5in 0.45in rgba(74,48,16,0.33);';

// Smoke: drifting tendrils that crept across the page (blurred SVG curls rising from
// the lower corners), leaving most of the paper clean - a mark left ON the paper.
var CO_SMOKE_MARKS =
  'background-image:' + CO_SMOKE_URL + ';' +
  'background-repeat:no-repeat;' +
  'background-position:center bottom;' +
  'background-size:100% 100%;';

// Dirt: sparse dark specks (SVG grain, mostly transparent so white shows through) plus
// a few localized smudge smears - dirt that got ON the paper, not a brown tint of it.
var CO_DIRT_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 380' preserveAspectRatio='none'>" +
  "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='8' result='n'/>" +
  "<feColorMatrix in='n' type='matrix' values='0 0 0 0 0.28  0 0 0 0 0.19  0 0 0 0 0.09  0 0 0 1.4 -0.85'/></filter>" +
  "<rect width='300' height='380' filter='url(#g)'/></svg>";
var CO_DIRT_ENC = encodeURIComponent(CO_DIRT_SVG).replace(/\(/g, '%28').replace(/\)/g, '%29');
var CO_DIRT_URL = 'url("data:image/svg+xml,' + CO_DIRT_ENC + '")';
var CO_DIRT_MARKS =
  'background-image:' +
  'radial-gradient(ellipse 22% 13% at 13% 12%, rgba(74,52,24,0.30), transparent 72%),' +
  'radial-gradient(ellipse 18% 11% at 88% 82%, rgba(64,46,22,0.28), transparent 72%),' +
  'radial-gradient(ellipse 15% 10% at 62% 38%, rgba(70,50,24,0.20), transparent 74%),' +
  'radial-gradient(ellipse 12% 9% at 36% 70%, rgba(70,50,24,0.18), transparent 74%),' +
  CO_DIRT_URL + ';' +
  'background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,repeat;' +
  'background-position:0 0,0 0,0 0,0 0,0 0;' +
  'background-size:auto,auto,auto,auto,300px 380px;';

// Wrinkle: creases with a real shadow side and a bright highlight side, plus a soft
// overall bow, so the folds read three-dimensionally.
var CO_WRINKLE_MARKS =
  'background-image:' +
  'linear-gradient(116deg, transparent 34%, rgba(0,0,0,0.12) 38%, rgba(0,0,0,0.17) 39.3%, rgba(255,255,255,0.92) 40.6%, rgba(255,255,255,0.35) 42.5%, transparent 46%),' +
  'linear-gradient(63deg, transparent 55%, rgba(0,0,0,0.10) 59%, rgba(0,0,0,0.15) 60.2%, rgba(255,255,255,0.88) 61.5%, rgba(255,255,255,0.30) 63.5%, transparent 67%),' +
  'linear-gradient(151deg, transparent 67%, rgba(0,0,0,0.09) 71%, rgba(0,0,0,0.14) 72%, rgba(255,255,255,0.82) 73.3%, rgba(255,255,255,0.30) 75.5%, transparent 79%),' +
  'linear-gradient(94deg, transparent 19%, rgba(0,0,0,0.08) 22.5%, rgba(0,0,0,0.11) 23.3%, rgba(255,255,255,0.75) 24.4%, rgba(255,255,255,0.28) 26.5%, transparent 30%),' +
  'linear-gradient(108deg, rgba(0,0,0,0.05), transparent 28%, transparent 72%, rgba(0,0,0,0.06));' +
  'box-shadow: inset 0 0 1.6in 0.25in rgba(0,0,0,0.10);';

// Blood: dark-red splatter spots of varied size on white.
var CO_BLOOD_MARKS =
  'background-image:' +
  'radial-gradient(circle at 22% 18%, rgba(122,12,12,0.55), transparent 6%),' +
  'radial-gradient(circle at 26% 23%, rgba(110,8,8,0.5), transparent 2.5%),' +
  'radial-gradient(circle at 30% 15%, rgba(110,8,8,0.45), transparent 1.6%),' +
  'radial-gradient(circle at 78% 30%, rgba(132,14,14,0.5), transparent 9%),' +
  'radial-gradient(circle at 85% 25%, rgba(110,8,8,0.45), transparent 2%),' +
  'radial-gradient(circle at 60% 70%, rgba(125,12,12,0.5), transparent 7%),' +
  'radial-gradient(circle at 38% 82%, rgba(115,10,10,0.45), transparent 4%),' +
  'radial-gradient(circle at 66% 60%, rgba(110,8,8,0.4), transparent 2%),' +
  'radial-gradient(circle at 50% 46%, rgba(120,10,10,0.4), transparent 3%);';

function coPaperColor(paper) {
  if (paper === 'linen') return '#f3ece0';
  if (paper === 'grey' || paper === 'lightgrey') return '#e9e9e7';
  return '#ffffff';
}
function coConditionMarks(condition) {
  if (condition === 'smoke') return CO_SMOKE_MARKS;
  if (condition === 'dirt') return CO_DIRT_MARKS;
  if (condition === 'wrinkle') return CO_WRINKLE_MARKS;
  if (condition === 'blood') return CO_BLOOD_MARKS;
  return '';
}
// Paper = base colour; condition = wear/marks layered on top. 'parchment' is kept as a
// legacy textured paper for the default (non-custom) novel.
// ---- Page condition textures (uploaded weathering scans) ----
// Real scanned textures (4 per condition) chosen at random per page, laid behind the
// page content as a faded overlay. mix-blend-mode:multiply keeps the paper base clean
// so only the marks/wisps darken; opacity is the transparency dial per condition --
// raise for stronger weathering, lower if it reads too dark.
var COND_SETS = {
  blood:   ['Blood_Splatter_1', 'Blood_Splatter_2', 'Blood_Splatter_3', 'Blood_Splatter_4'],
  dirt:    ['Dirty_Page_1', 'Dirty_Page_2', 'Dirty_Page_3', 'Dirty_Page_4'],
  wrinkle: ['Wrinkled_Paper_1', 'Wrinkled_Paper_2', 'Wrinkled_Paper_3', 'Wrinkled_Paper_4'],
  smoke:   ['Misty_Page_1', 'Misty_Page_2', 'Misty_Page_3', 'Misty_Page_4']
};
var COND_OPACITY = { blood: 0.28, dirt: 0.30, wrinkle: 0.45, smoke: 0.40 };

function coCondTexture(condition) {
  var arr = COND_SETS[condition];
  if (!arr) return null;
  return '/textures/' + arr[Math.floor(Math.random() * arr.length)] + '.jpg';
}

function coCondOverlay(condition) {
  var url = coCondTexture(condition);
  if (!url) return '';
  var op = COND_OPACITY[condition] || 0.3;
  return '<div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:0;' +
    'background-image:url(' + url + ');background-size:cover;background-position:center;background-repeat:no-repeat;' +
    'mix-blend-mode:multiply;opacity:' + op + ';pointer-events:none;' +
    '-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>';
}

function coCondPreload(condition) {
  var arr = COND_SETS[condition];
  if (!arr) return '';
  return '<div aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;">' +
    arr.map(function (n) { return '<img src="/textures/' + n + '.jpg" alt="" width="1" height="1" />'; }).join('') +
    '</div>';
}

function coPaperCSS(paper, condition) {
  if (paper === 'parchment') return CO_PARCHMENT_CSS;
  return 'background-color:' + coPaperColor(paper) + ';';
}

function buildLayout(layoutStyle, moments, sections, intro, outro, opts) {
  if (opts) return renderLayout(opts, moments, sections, intro, outro);
  if (!moments || !moments.length) return '<p style="color:#6b5f55;font-style:italic;text-align:center;padding:1in;">No panels yet - generate your storyboard first.</p>';
  sections = sections || [];
  intro = intro || '';
  outro = outro || '';
  var legacy = {
    Classic: 'Saga', Storybook: 'Saga',
    ComicBook: 'Ironframe', Cinematic: 'Ironframe',
    Action: 'Spectacle', Dramatic: 'Spectacle'
  };
  var key = legacy[layoutStyle] || layoutStyle;
  switch (key) {
    case 'Ironframe': return layoutIronframe(moments, sections, intro, outro);
    case 'Spectacle': return layoutSpectacle(moments, sections, intro, outro);
    case 'Eclipse':   return layoutEclipse(moments, sections, intro, outro);
    case 'Reverie':   return layoutReverie(moments, sections, intro, outro);
    case 'Folio':     return layoutFolio(moments, sections, intro, outro);
    case 'Saga':      return layoutSaga(moments, sections, intro, outro);
    case 'Mosaic':    return layoutMosaic(moments, sections, intro, outro);
    default:          return layoutMosaic(moments, sections, intro, outro);
  }
}

// ============================================================
// Generate PDF HTML for a session
// ============================================================
function buildSessionHTML(session, moments, campaign, characters, narrative, opts, renderOpts) {
  var co = opts || null;
  var fHideLogo = co ? !!co.hideLogo : false;
  var fCover  = (renderOpts && renderOpts.noCover) ? false : (co ? !!co.cover     : true);
  var fHeader = co ? !!co.header    : true;
  var fWmark  = true; // watermark always on
  var paperCSS = co ? coPaperCSS(co.paper, co.condition) : '';
  var fontImp = co ? coFontImport(co.font) : '';
  var fontFam = co ? coFontFamily(co.font) : '';
  var fontRule = fontFam ? ('.content-page p { font-family:' + fontFam + ' !important; }') : '';
  const intro = narrative.intro || '';
  const sections = narrative.sections || [];
  const outro = narrative.outro || '';

  const artStyle = session.art_style || campaign.art_style || 'High fantasy illustration';

  // Character roster for cast page
  const castHTML = characters.map(function(c) {
    var primaryImg = c.canonical_reference_url || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    return '<div class="cast-member">' +
      (primaryImg ? '<img class="cast-portrait" src="' + primaryImg + '" alt="' + c.name + '" />' : '<div class="cast-portrait cast-no-img">' + c.name.charAt(0) + '</div>') +
      '<div class="cast-name">' + c.name + '</div>' +
      '<div class="cast-cls">' + (c.cls || '') + '</div>' +
      (c.player_name ? '<div class="cast-player">Played by ' + c.player_name + '</div>' : '') +
    '</div>';
  }).join('');

  // Build panels using selected layout
  var layoutStyle = narrative.layout_style || 'Classic';
  var panelsHTML = buildLayout(layoutStyle, moments, sections, intro, outro, co);
  // Session title image: the wide establishing shot that sets the scene for the
  // first narrative. Additive block above the session content - does NOT touch
  // buildLayout / renderPaired. (Stage 4.1: Session Preview only.)
  var titleImageHTML = session.establishing_image
    ? '<div class="session-title-image" style="width:100%;margin:0 0 0.28in;page-break-inside:avoid;line-height:0;"><img style="width:100%;display:block;border-radius:3px;" src="' + session.establishing_image + '" alt="" /></div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');
  ${fontImp}
  ${fontRule}

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Crimson Text', Georgia, serif;
    background: #fff;
    color: #1a1410;
    width: 8.5in;
    margin: 0 auto;
  }

  /* ===== COVER PAGE ===== */
  .cover-page {
    width: 8.5in;
    height: 11in;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #1a0f08;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover-bg {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, #3a2010 0%, #0a0604 70%);
  }
  .cover-border {
    position: absolute;
    inset: 0.4in;
    border: 2px solid rgba(201,168,76,0.4);
    pointer-events: none;
  }
  .cover-border-inner {
    position: absolute;
    inset: 0.5in;
    border: 1px solid rgba(201,168,76,0.2);
    pointer-events: none;
  }
  .cover-content {
    position: relative;
    z-index: 1;
    text-align: center;
    padding: 1in;
    width: 100%;
  }
  .cover-logo {
    width: 160px;
    height: auto;
    object-fit: contain;
    margin-bottom: 0.4in;
  }
  .cover-eyebrow {
    font-family: 'Cinzel', serif;
    font-size: 11pt;
    color: rgba(201,168,76,0.5);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-bottom: 0.15in;
  }
  .cover-campaign {
    font-family: 'Cinzel', serif;
    font-size: 28pt;
    font-weight: 700;
    color: #c9a84c;
    letter-spacing: 0.05em;
    line-height: 1.2;
    margin-bottom: 0.15in;
    text-shadow: 0 2px 20px rgba(201,168,76,0.3);
  }
  .cover-divider {
    width: 60px;
    height: 1px;
    background: rgba(201,168,76,0.5);
    margin: 0.2in auto;
  }
  .cover-session {
    font-family: 'Cinzel', serif;
    font-size: 16pt;
    color: rgba(201,168,76,0.8);
    margin-bottom: 0.1in;
  }
  .cover-date {
    font-family: 'Crimson Text', serif;
    font-size: 12pt;
    color: rgba(201,168,76,0.5);
    font-style: italic;
  }
  .cover-watermark {
    position: absolute;
    bottom: 0.5in;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: rgba(201,168,76,0.12);
    letter-spacing: 0.15em;
    z-index: 1;
  }

  /* ===== CONTENT PAGES ===== */
  .content-page {
    width: 8.5in;
    min-height: 11in;
    padding: 0.75in 0.85in;
    page-break-after: always;
    position: relative;
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.15in;
    margin-bottom: 0.25in;
    border-bottom: 1px solid rgba(201,168,76,0.3);
  }
  .page-header-campaign {
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: #8a6a2a;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .page-header-session {
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: #8a6a2a;
    letter-spacing: 0.05em;
  }

  /* ===== NARRATIVE TEXT ===== */
  .narrative-text {
    font-family: 'Crimson Text', serif;
    font-size: 12pt;
    line-height: 1.7;
    color: #2a1a0e;
    margin: 0.2in 0;
    text-indent: 0.3in;
  }
  .intro-text {
    font-size: 13pt;
    font-style: italic;
    text-indent: 0;
    color: #3a2010;
  }
  .outro-text {
    font-size: 12pt;
    font-style: italic;
    text-indent: 0;
    color: #3a2010;
    border-top: 1px solid rgba(201,168,76,0.3);
    padding-top: 0.2in;
    margin-top: 0.3in;
  }

  /* ===== PANEL ===== */
  .panel-block {
    margin: 0.25in 0;
    page-break-inside: avoid;
  }
  .panel-image {
    width: 100%;
    max-height: 4.5in;
    object-fit: cover;
    display: block;
    border-radius: 4px;
    border: 1px solid rgba(201,168,76,0.2);
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  }
  .panel-placeholder {
    width: 100%;
    height: 3in;
    background: #f0e8d0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(201,168,76,0.3);
    border-radius: 4px;
  }
  .panel-placeholder-icon {
    font-size: 48pt;
    opacity: 0.3;
  }
  .panel-caption {
    display: flex;
    align-items: baseline;
    gap: 0.15in;
    margin-top: 0.08in;
    padding: 0.08in 0.12in;
    background: #f9f4e8;
    border-left: 3px solid #c9a84c;
  }
  .panel-num {
    font-family: 'Cinzel', serif;
    font-size: 7pt;
    color: #8a6a2a;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    white-space: nowrap;
  }
  .panel-title {
    font-family: 'Cinzel', serif;
    font-size: 10pt;
    font-weight: 600;
    color: #2c1810;
  }
  .panel-desc {
    font-family: 'Crimson Text', serif;
    font-size: 10pt;
    color: #5c3d2e;
    font-style: italic;
    margin-left: auto;
  }

  /* ===== WATERMARK ===== */
  .page-watermark {
    position: fixed;
    bottom: 0.35in;
    right: 0.5in;
    font-family: 'Cinzel', serif;
    font-size: 7pt;
    color: rgba(201,168,76,0.1);
    letter-spacing: 0.1em;
  }

  /* ===== PAGE NUMBERS ===== */
  .page-num {
    position: fixed;
    bottom: 0.35in;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: rgba(44,24,16,0.4);
  }

  .content-page { ${paperCSS} }
  @media print {
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body { width: 8.5in; }
    .cover-page { height: 11in; }
    .cover-art-frame { flex:none; height:9.6in; }
    .content-page { min-height: 0; padding-top: 0; padding-bottom: 0; }
    @page { size: 8.5in 11in; margin: 0.65in 0; }
    ${fCover ? '@page :first { margin:0; }' : ''}
    @page backcover { size: 8.5in 11in; margin: 0; }
    .content-page + .content-page { margin-top:0.4in; }
  }
  .cover-content.cover-image-layout { position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;padding:0.7in;text-align:center; }
  .cover-art-frame { position:relative;flex:1;width:100%;border:2px solid rgba(201,168,76,0.55);border-radius:8px;overflow:hidden;background:#0a0604;box-shadow:0 4px 24px rgba(0,0,0,0.5); }
  .cover-art-img { width:calc(100% + 2px);height:calc(100% + 2px);object-fit:cover;object-position:center top;display:block;margin:-1px; }
  .cover-art-fade { position:absolute;inset:0;box-shadow:inset 0 0 70px 34px rgba(10,6,4,0.85);pointer-events:none; }
  .cover-art-caption { position:absolute;left:0;right:0;bottom:0;height:52%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 0.4in 0.5in;background:linear-gradient(to top, rgba(10,6,4,0.95) 22%, rgba(10,6,4,0.6) 58%, rgba(10,6,4,0) 100%); }
  .cover-art-title { font-family:'Cinzel',serif;font-size:30pt;font-weight:700;color:#f0d98a;letter-spacing:0.04em;line-height:1.15;text-shadow:0 2px 16px rgba(0,0,0,0.95);margin-bottom:0.12in; }
  .cover-art-dates { font-family:'Cinzel',serif;font-size:11pt;color:rgba(240,217,138,0.78);letter-spacing:0.08em;text-shadow:0 1px 8px rgba(0,0,0,0.9);margin-bottom:0.2in; }
  .cover-art-logo { width:110px;height:auto;object-fit:contain; }
  .backcover-page { width:8.5in;height:11in;background:#1a0f08;page:backcover;page-break-before:always;position:relative;overflow:hidden; }
  .backcover-inner { position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;padding:0.7in; }
  .backcover-default { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center; }
  .bc-title { font-family:'Cinzel',serif;font-size:24pt;font-weight:700;color:#f5e8c8;letter-spacing:0.04em;line-height:1.2; }
  .bc-rule { width:80px;height:2px;background:rgba(201,168,76,0.6);margin:0.3in 0; }
  .bc-tag { font-family:'Crimson Text',serif;font-style:italic;font-size:13pt;color:rgba(245,232,200,0.65); }
</style>
</head>
<body>

${fCover ? `<!-- COVER PAGE -->
<div class="cover-page">
  <div class="cover-bg"></div>
  <div class="cover-border"></div>
  <div class="cover-border-inner"></div>
  ${campaign.cover_image_url ? `<div class="cover-content cover-image-layout">
    <div class="cover-art-frame">
      <img class="cover-art-img" src="${campaign.cover_image_url}" alt="" />
      <div class="cover-art-fade"></div>
      <div class="cover-art-caption">
        <div class="cover-art-title">${campaign.name}</div>
        <div class="cover-art-dates">${session.name}${session.session_date ? ' &middot; ' + formatDate(session.session_date) : ''}</div>
        ${fHideLogo ? '' : '<img class="cover-art-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
      </div>
    </div>
  </div>` : `<div class="cover-content">
    ${fHideLogo ? '' : '<img class="cover-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
    <div class="cover-eyebrow">A Saga of</div>
    <div class="cover-campaign">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-session">${session.name}</div>
    <div class="cover-date">${formatDate(session.session_date)}</div>
  </div>`}
  <div class="cover-watermark">CAMPAIGNIA.COM</div>
</div>` : ''}

<!-- CONTENT PAGE -->
<div class="content-page" style="position:relative;">
  ${co ? coCondOverlay(co.condition) : ''}
  ${co ? coCondPreload(co.condition) : ''}
  <div style="position:relative;z-index:1;">
  ${fHeader ? `<div class="page-header">
    <div class="page-header-campaign">${campaign.name}</div>
    <div class="page-header-session">${session.name}</div>
  </div>` : ''}
  ${titleImageHTML}
  ${panelsHTML}
  </div>
</div>

${fWmark ? '<div class="page-watermark">CAMPAIGNIA.COM</div>' : ''}

${(fCover && campaign.back_cover_image_url) ? `<!-- BACK COVER PAGE -->
<div class="backcover-page"><div class="cover-bg"></div><div class="cover-border"></div><div class="cover-border-inner"></div><div class="backcover-inner"><div class="cover-art-frame"><img class="cover-art-img" src="${campaign.back_cover_image_url}" alt="" /></div></div></div>` : ''}

</body>
</html>`;
}

// ============================================================
// BUILD Graphic Novel HTML (all sessions)
// ============================================================
function buildNovelHTML(campaign, sessions, characters, layoutStyle, pageOpts, opts) {
  layoutStyle = layoutStyle || 'Classic';
  pageOpts = pageOpts || {};
  var co = opts || null;
  var fHideLogo = co ? !!co.hideLogo : false;
  var fPublic = !!(pageOpts && pageOpts.publicMode);
  // Public Library render: each real name is replaced by that person's pen
  // name (members + Story Master); a missing pen name renders blank. Off for
  // every private/preview/print render -- byte-identical when fPublic is false.
  function _pubName(real, pen) { return fPublic ? (pen || '') : (real || ''); }
  var fCover  = (pageOpts && pageOpts.noCover) ? false : (co ? !!co.cover : true);
  var fCast   = co ? !!co.cast      : true;
  var fToc    = co ? !!co.toc       : false;
  var fHeader = co ? !!co.header    : true;
  var fMarkers= co ? !!co.markers   : true;
  var fWmark  = true; // watermark always on
  var paperCSS = coPaperCSS(co ? co.paper : 'parchment', co ? co.condition : 'none');
  var fontImp = coFontImport(co ? co.font : '');
  var fontFam = coFontFamily(co ? co.font : '');
  var fontRule = fontFam ? ('.content-page p { font-family:' + fontFam + ' !important; }') : '';
  // When paginated, render only one session. page is 1-indexed.
  var paginated = (typeof pageOpts.page === 'number' && pageOpts.page > 0);
  var totalSessions = sessions.length;
  var pageIndex = paginated ? (pageOpts.page - 1) : -1;
  // Slice down to a single session when paginated
  var renderSessions = paginated
    ? (sessions[pageIndex] ? [sessions[pageIndex]] : [])
    : sessions;
  // Date range
  const _dts = sessions.map(function(s) { return toDate(s.session_date); }).filter(Boolean).map(function(d){ return d.getTime(); });
  let dateRange = '';
  if (_dts.length) {
    const minDate = new Date(Math.min.apply(null, _dts));
    const maxDate = new Date(Math.max.apply(null, _dts));
    const _df = {year:'numeric', month:'long', day:'numeric'};
    dateRange = minDate.toLocaleDateString('en-US', _df) +
      (minDate.getTime() !== maxDate.getTime() ? ' — ' + maxDate.toLocaleDateString('en-US', _df) : '');
  }
  const coverImg = campaign.cover_image_url || '';

  // Cast page -- "The Company". Density scales with the number of characters so
  // a large cast never spills past one page: portraits shrink + columns grow,
  // then a very large cast falls back to a names-only list. A hard print height
  // cap (see CSS) is the final backstop against any overflow.
  var _castN = characters.length;
  var _castCols, _castPort, _castGap, _castFields;
  if (_castN <= 12)      { _castCols = 3; _castPort = 1.1;  _castGap = 0.25; _castFields = 'full'; }
  else if (_castN <= 30) { _castCols = 4; _castPort = 0.85; _castGap = 0.16; _castFields = 'mid';  }
  else if (_castN <= 60) { _castCols = 6; _castPort = 0.55; _castGap = 0.10; _castFields = 'name'; }
  else                   { _castCols = 0; _castPort = 0;    _castGap = 0;    _castFields = 'list'; }
  var castBlockHTML;
  if (_castFields === 'list') {
    castBlockHTML = '<div class="cast-names">' + characters.map(function(c){
      return '<div class="cast-name-item">' + _fmEsc(c.name) +
        (_pubName(c.player_name, c.player_pen_name) ? ' <span class="cast-name-player">(' + _fmEsc(_pubName(c.player_name, c.player_pen_name)) + ')</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  } else {
    var _noImgFont = Math.max(9, Math.round(_castPort * 21));
    var _members = characters.map(function(c) {
      var primaryImg = c.canonical_reference_url || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
      var _ps = 'width:' + _castPort + 'in;height:' + _castPort + 'in;';
      // Frame scale follows the portrait size, tuned so a portrait's frame is the
      // same proportion of the picture as the (large) interior story frames -- a thin
      // gold line, not a thick dark band. Smaller portrait -> thinner frame.
      var _fsc = Math.max(0.13, Math.min(0.18, _castPort * 0.15));
      return '<div class="cast-member">' +
        ((co && co.border === 'frame' && co.arrange !== 'comicpage')
          ? '<div style="margin-bottom:0.08in;">' + bronzeFrame(
              (primaryImg
                ? '<img style="' + _ps + 'object-fit:cover;object-position:center top;display:block;" src="' + primaryImg + '" alt="" />'
                : '<div style="' + _ps + 'background:#c9a84c;color:#2c1810;display:flex;align-items:center;justify-content:center;font-family:\'Cinzel\',serif;font-weight:700;font-size:' + _noImgFont + 'pt;">' + _fmEsc(String(c.name || '?').charAt(0)) + '</div>'),
              true, _fsc) + '</div>'
          : '<div class="cast-portrait-frame" style="' + _ps + picBorderCss(co) + '">' +
              (primaryImg
                ? '<img class="cast-portrait" src="' + primaryImg + '" alt="" />'
                : '<div class="cast-no-img" style="font-size:' + _noImgFont + 'pt;">' + _fmEsc(String(c.name || '?').charAt(0)) + '</div>') +
              picOverlay(co) +
            '</div>') +
        '<div class="cast-name">' + _fmEsc(c.name) + '</div>' +
        '<div class="cast-cls">' + _fmEsc(c.cls || '') + '</div>' +
        (((_castFields === 'full' || _castFields === 'mid') && _pubName(c.player_name, c.player_pen_name)) ? '<div class="cast-player">Played by ' + _fmEsc(_pubName(c.player_name, c.player_pen_name)) + '</div>' : '') +
      '</div>';
    }).join('');
    castBlockHTML = '<div class="cast-grid" style="grid-template-columns:repeat(' + _castCols + ',1fr);gap:' + _castGap + 'in;">' + _members + '</div>';
  }

  // Get DM name from campaign
  const dmName = campaign.owner_name || campaign.dm_name || 'The Story Master';

  // Build session content. When paginated, only one session is rendered,
  // but it keeps its real session number, and the chapter seam is suppressed
  // so a sequence spanning sessions reads continuously in the preview.
  var allSessionsHTML = renderSessions.map(function(s, localIdx) {
    var si = paginated ? pageIndex : localIdx;
    var moments = s.moments || [];
    var narrative = {
      intro: s.narrative_intro || '',
      sections: s.narrative_sections ? JSON.parse(s.narrative_sections) : [],
      outro: s.narrative_outro || ''
    };

    var panelsHTML = buildLayout(layoutStyle, moments, narrative.sections, narrative.intro, narrative.outro, co);
    // Session title image: the wide establishing shot that opens each session,
    // placed below the session marker and above the narrative. Additive - does
    // NOT touch buildLayout / renderPaired. Flows through preview, print, publish,
    // and the public story page (snapshot carries establishing_image). (Stage 4.2)
    var titleImageHTML = s.establishing_image
      ? '<div class="session-title-image" style="width:100%;margin:0 0 0.28in;page-break-inside:avoid;line-height:0;"><img style="width:100%;display:block;border-radius:3px;" src="' + s.establishing_image + '" alt="" /></div>'
      : '';

    var chapterHeading = (paginated || !fMarkers)
      ? ''
      : '<div class="session-marker">' +
          '<div class="session-marker-ornament">&bull; &bull; &bull;</div>' +
          '<div class="session-marker-label">Session ' + (si+1) + ' &mdash; ' + s.name +
            ' &middot; ' + formatDate(s.session_date) + '</div>' +
        '</div>';

    return '<div class="content-page" style="position:relative;">' +
      (co ? coCondOverlay(co.condition) : '') +
      (co ? coCondPreload(co.condition) : '') +
      '<div style="position:relative;z-index:1;">' +
      (fHeader ? ('<div class="page-header">' +
        '<div class="page-header-campaign">' + campaign.name + '</div>' +
        '<div class="page-header-session">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '</div>') : '') +
      chapterHeading +
      titleImageHTML +
      panelsHTML +
      '</div>' +
    '</div>';
  }).join('');

  var tocRows = sessions.map(function(s, idx){
    return '<div class="toc-row"><span class="toc-name">Session ' + (idx+1) + ' &mdash; ' + s.name + '</span><span class="toc-dots"></span><span class="toc-date">' + formatDate(s.session_date, {year:'numeric',month:'short',day:'numeric'}) + '</span></div>';
  }).join('');
  var _tocCols = sessions.length <= 30 ? 1 : (sessions.length <= 70 ? 2 : 3);
  var tocBlock = '<div class="content-page toc-page"><div class="toc-title">Contents</div><div class="cast-divider"></div><div class="toc-cols" style="column-count:' + _tocCols + ';">' + tocRows + '</div></div>';

  // --- Front matter: interior title page + details / copyright page ----------
  // Conventional book opening (Lulu wants a title page, then a copyright page,
  // before the body). Rendered for the on-screen novel AND the print interior
  // (they are interior content, not the separate wrap cover), so they are NOT
  // gated on fCover -- only on page 1 when the preview is paginated.
  function _fmEsc(s){ return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var titleImg = campaign.title_image_url || '';
  var _pseen = {};
  var playerNames = characters.map(function(c){ return (_pubName(c.player_name, c.player_pen_name) || '').trim(); })
    .filter(function(n){ if (!n) return false; var k = n.toLowerCase(); if (_pseen[k]) return false; _pseen[k] = 1; return true; })
    .join(', ');
  var copyYear = _dts.length ? new Date(Math.max.apply(null, _dts)).getFullYear() : new Date().getFullYear();
  var copyHolder = fPublic ? (campaign.owner_pen_name || '') : (campaign.owner_name || campaign.dm_name || dmName);
  var _castDmLine = fPublic
    ? (copyHolder ? ('Chronicled by ' + _fmEsc(copyHolder) + (dateRange ? ' &nbsp;&nbsp;|&nbsp;&nbsp; ' + dateRange : '')) : (dateRange || ''))
    : ('Story Master: ' + dmName + ' &nbsp;&nbsp;|&nbsp;&nbsp; ' + dateRange);
  var _bookTitleFM = (pageOpts && pageOpts.bookTitle != null && String(pageOpts.bookTitle).trim())
    ? String(pageOpts.bookTitle).trim() : campaign.name;
  var titlePageHTML =
    '<div class="titlepage">' +
      '<div class="tp-title">' + _fmEsc(_bookTitleFM) + '</div>' +
      (titleImg
        ? '<div class="tp-image-wrap">' +
            ((co && co.border === 'frame' && co.arrange !== 'comicpage')
              ? bronzeFrame('<img class="tp-image" src="' + titleImg + '" alt="" />', true, 0.6)
              : '<div class="tp-image-border" style="' + picBorderCss(co) + '">' + '<img class="tp-image" src="' + titleImg + '" alt="" />' + picOverlay(co) + '</div>') +
          '</div>'
        : '') +
    '</div>';
  var detailsPageHTML =
    '<div class="detailspage">' +
      '<div class="dp-title">' + _fmEsc(campaign.name) + '</div>' +
      (dateRange ? '<div class="dp-dates">' + dateRange + '</div>' : '') +
      '<div class="dp-divider"></div>' +
      (playerNames ? '<div class="dp-block"><div class="dp-label">Players</div><div class="dp-value">' + _fmEsc(playerNames) + '</div></div>' : '') +
      (fPublic
        ? (copyHolder ? '<div class="dp-block"><div class="dp-label">Chronicled by</div><div class="dp-value">' + _fmEsc(copyHolder) + '</div></div>' : '')
        : '<div class="dp-block"><div class="dp-label">Story Master</div><div class="dp-value">' + _fmEsc(copyHolder) + '</div></div>') +
      '<div class="dp-copyright">&copy; ' + copyYear + (copyHolder ? ' ' + _fmEsc(copyHolder) : '') + '. All rights reserved.</div>' +
      (fHideLogo ? '' : '<img class="dp-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />') +
      '<div class="dp-disclaimer">Created with Campaignia &middot; campaignia.com.<br/>' +
        'This chronicle was assembled from recorded tabletop role-playing sessions. Narrative text and illustrations were produced with the assistance of AI tools. All characters and original content remain the property of their respective players and creators.</div>' +
    '</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');
  ${fontImp}
  ${fontRule}

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Crimson Text', Georgia, serif; background: #fff; color: #1a1410; width: 8.5in; margin: 0 auto; }

  .cover-page { width:8.5in;height:11in;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a0f08;page-break-after:always;position:relative;overflow:hidden; }
  .cover-bg { position:absolute;inset:0;background:radial-gradient(ellipse at center, #3a2010 0%, #0a0604 70%); }
  .cover-border { position:absolute;inset:0.4in;border:2px solid rgba(201,168,76,0.4);pointer-events:none; }
  .cover-border-inner { position:absolute;inset:0.5in;border:1px solid rgba(201,168,76,0.2);pointer-events:none; }
  .cover-content { position:relative;z-index:1;text-align:center;padding:1in;width:100%; }
  .cover-logo { width:160px;height:auto;object-fit:contain;margin-bottom:0.4in; }
  .cover-eyebrow { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.5);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:0.1in; }
  .cover-title { font-family:'Cinzel',serif;font-size:34pt;font-weight:700;color:#c9a84c;letter-spacing:0.05em;line-height:1.2;margin-bottom:0.15in;text-shadow:0 2px 20px rgba(201,168,76,0.3); }
  .cover-divider { width:80px;height:1px;background:rgba(201,168,76,0.5);margin:0.25in auto; }
  .cover-subtitle { font-family:'Crimson Text',serif;font-size:13pt;color:rgba(201,168,76,0.6);font-style:italic;margin-bottom:0.08in; }
  .cover-dates { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.4);letter-spacing:0.05em; }
  .cover-watermark { position:absolute;bottom:0.5in;left:50%;transform:translateX(-50%);font-family:'Cinzel',serif;font-size:8pt;color:rgba(201,168,76,0.12);letter-spacing:0.15em;z-index:1; }
  /* Cover-art layout: framed cover image fills the page; title, dates, and centered logo overlaid in the lower half. */
  .cover-content.cover-image-layout { position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;padding:0.7in;text-align:center; }
  .cover-art-frame { position:relative;flex:1;width:100%;border:2px solid rgba(201,168,76,0.55);border-radius:8px;overflow:hidden;background:#0a0604;box-shadow:0 4px 24px rgba(0,0,0,0.5); }
  .cover-art-img { width:calc(100% + 2px);height:calc(100% + 2px);object-fit:cover;object-position:center top;display:block;margin:-1px; }
  .cover-art-fade { position:absolute;inset:0;box-shadow:inset 0 0 70px 34px rgba(10,6,4,0.85);pointer-events:none; }
  .cover-art-caption { position:absolute;left:0;right:0;bottom:0;height:52%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:0 0.4in 0.5in;background:linear-gradient(to top, rgba(10,6,4,0.95) 22%, rgba(10,6,4,0.6) 58%, rgba(10,6,4,0) 100%); }
  .cover-art-title { font-family:'Cinzel',serif;font-size:30pt;font-weight:700;color:#f0d98a;letter-spacing:0.04em;line-height:1.15;text-shadow:0 2px 16px rgba(0,0,0,0.95);margin-bottom:0.12in; }
  .cover-art-dates { font-family:'Cinzel',serif;font-size:11pt;color:rgba(240,217,138,0.78);letter-spacing:0.08em;text-shadow:0 1px 8px rgba(0,0,0,0.9);margin-bottom:0.2in; }
  .cover-art-logo { width:110px;height:auto;object-fit:contain; }

  /* CAST PAGE */
  .cast-page { width:8.5in;padding:0.75in 0.85in;page-break-after:always;background:#fdf8f0; }
  .cast-page-title { font-family:'Cinzel',serif;font-size:22pt;font-weight:700;color:#2c1810;text-align:center;margin-bottom:0.1in; }
  .cast-page-subtitle { font-family:'Crimson Text',serif;font-size:12pt;color:#6b5f55;text-align:center;font-style:italic;margin-bottom:0.05in; }
  .cast-page-dm { font-family:'Cinzel',serif;font-size:10pt;color:#8a6a2a;text-align:center;margin-bottom:0.35in;letter-spacing:0.05em; }
  .cast-divider { width:60px;height:1px;background:rgba(201,168,76,0.4);margin:0.2in auto; }
  .cast-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:0.25in;margin-top:0.1in; }
  .cast-member { text-align:center;padding:0.15in;border:1px solid rgba(201,168,76,0.2);border-radius:6px;background:#fff; }
  .cast-portrait-frame { box-sizing:border-box;position:relative;display:block;overflow:hidden;line-height:0;border-radius:4px;margin:0 auto 0.08in; }
  .cast-portrait { width:calc(100% + 2px);height:calc(100% + 2px);object-fit:cover;object-position:center top;display:block;margin:-1px; }
  .cast-no-img { width:100%;height:100%;background:#c9a84c;color:#2c1810;display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-weight:700; }
  .cast-name { font-family:'Cinzel',serif;font-size:11pt;font-weight:600;color:#2c1810;margin-bottom:0.03in; }
  .cast-cls { font-family:'Crimson Text',serif;font-size:10pt;color:#8a6a2a;font-style:italic;margin-bottom:0.03in; }
  .cast-player { font-family:'Cinzel',serif;font-size:8pt;color:#9e9088;letter-spacing:0.05em;margin-bottom:0.05in; }
  .cast-desc { font-family:'Crimson Text',serif;font-size:9pt;color:#6b5f55;line-height:1.4; }
  .cast-names { column-count:4;column-gap:0.3in;text-align:left;margin-top:0.1in; }
  .cast-name-item { break-inside:avoid;font-family:'Cinzel',serif;font-size:9.5pt;color:#2c1810;padding:0.025in 0;line-height:1.3; }
  .cast-name-player { font-family:'Crimson Text',serif;font-size:8.5pt;color:#8a6a2a;font-style:italic; }
  /* The Company page can never spill to a 2nd sheet: cap height + clip. The
     density tiers keep realistic casts well within this height. */
  @media print { .cast-page { box-sizing:border-box;height:9.55in;overflow:hidden; } }

  /* FRONT MATTER — interior title page + details / copyright page */
  .titlepage { width:8.5in;min-height:9.4in;padding:0.85in;page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center; }
  .tp-title { font-family:'Cinzel',serif;font-size:30pt;font-weight:700;color:#2c1810;letter-spacing:0.04em;line-height:1.15;text-transform:uppercase;margin-bottom:0.4in; }
  .tp-image-wrap { margin:0 auto;max-width:100%; }
  .tp-image-border { display:inline-block;position:relative;line-height:0;border-radius:4px;overflow:hidden; }
  .tp-image { display:block;max-width:4.6in;max-height:5in;width:auto;height:auto; }
  .tp-logo { width:0.95in;height:auto;object-fit:contain;margin-top:0.5in;opacity:0.9; }
  .detailspage { width:8.5in;min-height:9.4in;padding:1in 1.1in;page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center; }
  .dp-title { font-family:'Cinzel',serif;font-size:20pt;font-weight:700;color:#2c1810;letter-spacing:0.03em;margin-bottom:0.08in; }
  .dp-dates { font-family:'Crimson Text',serif;font-size:12pt;color:#6b5f55;font-style:italic;margin-bottom:0.15in; }
  .dp-divider { width:60px;height:1px;background:rgba(201,168,76,0.4);margin:0.1in auto 0.3in; }
  .dp-block { margin-bottom:0.22in; }
  .dp-label { font-family:'Cinzel',serif;font-size:8.5pt;color:#8a6a2a;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:0.04in; }
  .dp-value { font-family:'Crimson Text',serif;font-size:12pt;color:#2c1810;line-height:1.5; }
  .dp-copyright { font-family:'Crimson Text',serif;font-size:10.5pt;color:#3a2a1a;margin-top:0.3in; }
  .dp-logo { width:0.85in;height:auto;object-fit:contain;display:block;margin:0.3in auto 0.12in;opacity:0.9; }
  .dp-disclaimer { font-family:'Crimson Text',serif;font-size:8.5pt;color:#8a7a68;line-height:1.5;margin-top:0.2in;max-width:4.6in; }

  /* CONTENT */
  .content-page { width:8.5in;padding:0.5in 0.85in;position:relative; }
  .content-page:last-of-type { page-break-after:avoid; }
  .cast-page, .content-page, .titlepage, .detailspage { ${paperCSS} }
  .toc-page { page-break-after:always; }
  .toc-title { font-family:'Cinzel',serif;font-size:22pt;font-weight:700;color:#2c1810;text-align:center;margin-bottom:0.1in; }
  .toc-cols { column-gap:0.4in; }
  .toc-row { display:flex;align-items:baseline;gap:8px;margin:0.12in 0;font-family:'Cinzel',serif;break-inside:avoid; }
  .toc-name { font-size:11pt;color:#2c1810;white-space:nowrap; }
  .toc-dots { flex:1;border-bottom:1px dotted rgba(110,75,28,0.5);transform:translateY(-3px); }
  .toc-date { font-size:9.5pt;color:#8a6a2a;font-style:italic;white-space:nowrap; }
  .print-bar { position:fixed;top:14px;right:14px;z-index:9999; }
  .print-bar button { font-family:'Cinzel',serif;font-size:11pt;font-weight:600;background:#2c1810;color:#f3e7c8;border:1px solid #c9a84c;border-radius:4px;padding:8px 16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3); }
  .page-header { display:flex;align-items:center;justify-content:space-between;padding-bottom:0.12in;margin-bottom:0.2in;border-bottom:1px solid rgba(201,168,76,0.3); }
  .page-header-campaign { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a;letter-spacing:0.1em;text-transform:uppercase; }
  .page-header-session { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a; }
  .session-chapter-title { font-family:'Cinzel',serif;font-size:18pt;font-weight:700;color:#2c1810;margin-bottom:0.05in; }
  .session-chapter-date { font-family:'Crimson Text',serif;font-size:11pt;color:#8a6a2a;font-style:italic;margin-bottom:0.2in;padding-bottom:0.15in;border-bottom:1px solid rgba(201,168,76,0.2); }
  /* Softened session marker — a quiet signal that a new play session begins,
     without a hard chapter break */
  .session-marker { text-align:center;margin:0.1in 0 0.28in; }
  .session-marker-ornament { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.55);letter-spacing:0.3em;margin-bottom:0.06in; }
  .session-marker-label { font-family:'Cinzel',serif;font-size:8.5pt;font-weight:600;color:#8a6a2a;letter-spacing:0.12em;text-transform:uppercase; }
  .narrative-text { font-family:'Crimson Text',serif;font-size:12pt;line-height:1.7;color:#2a1a0e;margin:0.12in 0;text-indent:0.3in; }
  .intro-text { font-size:13pt;font-style:italic;text-indent:0;color:#3a2010; }
  .outro-text { font-size:12pt;font-style:italic;text-indent:0;color:#3a2010;border-top:1px solid rgba(201,168,76,0.3);padding-top:0.2in;margin-top:0.25in; }
  .panel-block { margin:0.12in 0;page-break-inside:avoid; }
  .panel-image { width:100%;max-height:4.5in;object-fit:cover;object-position:center top;display:block;border-radius:4px;border:1px solid rgba(201,168,76,0.2);box-shadow:0 2px 12px rgba(0,0,0,0.15); }
  .panel-placeholder { width:100%;height:2.5in;background:#f0e8d0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(201,168,76,0.3);border-radius:4px; }
  .panel-placeholder-icon { font-size:36pt;opacity:0.3; }
  .panel-caption { display:flex;align-items:baseline;gap:0.12in;margin-top:0.06in;padding:0.07in 0.1in;background:#f9f4e8;border-left:3px solid #c9a84c; }
  .panel-num { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a;text-transform:uppercase;letter-spacing:0.1em;white-space:nowrap; }
  .panel-title { font-family:'Cinzel',serif;font-size:9pt;font-weight:600;color:#2c1810; }
  .page-watermark { position:fixed;bottom:0.35in;right:0.5in;font-family:'Cinzel',serif;font-size:7pt;color:rgba(201,168,76,0.1);letter-spacing:0.1em; }

  @media print {
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body { width:8.5in; }
    @page { size:8.5in 11in; margin:0.65in 0; }
    ${fCover ? '@page :first { margin:0; }' : ''}
    @page backcover { size:8.5in 11in; margin:0; }
    .print-bar { display:none !important; }
    /* Top/bottom page margins now come from @page, so every physical page --
       including continuation pages of a multi-page session -- gets consistent
       breathing room, while the cover (first page) stays full-bleed. No
       min-height: sessions flow continuously instead of each short session
       being padded out to a whole sheet (the main white-space culprit). */
    .content-page { padding-top:0; padding-bottom:0; }
    .content-page + .content-page { margin-top:0.4in; }
    .cover-art-frame { flex:none; height:9.6in; }
  }
  .backcover-page { width:8.5in;height:11in;background:#1a0f08;page:backcover;page-break-before:always;position:relative;overflow:hidden; }
  .backcover-inner { position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;padding:0.7in; }
  .backcover-default { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center; }
  .bc-title { font-family:'Cinzel',serif;font-size:24pt;font-weight:700;color:#f5e8c8;letter-spacing:0.04em;line-height:1.2; }
  .bc-rule { width:80px;height:2px;background:rgba(201,168,76,0.6);margin:0.3in 0; }
  .bc-tag { font-family:'Crimson Text',serif;font-style:italic;font-size:13pt;color:rgba(245,232,200,0.65); }
</style>
</head>
<body>
<div class="print-bar" id="printBar"><button onclick="window.print()">Save as PDF / Print</button></div>
<script>try{if(window.self!==window.top){var _pb=document.getElementById('printBar');if(_pb)_pb.style.display='none';}}catch(e){}</script>

${(fCover && (!paginated || pageOpts.page === 1)) ? `<!-- COVER PAGE -->
<div class="cover-page">
  <div class="cover-bg"></div>
  <div class="cover-border"></div>
  <div class="cover-border-inner"></div>
  ${coverImg ? `<div class="cover-content cover-image-layout">
    <div class="cover-art-frame">
      <img class="cover-art-img" src="${coverImg}" alt="" />
      <div class="cover-art-fade"></div>
      <div class="cover-art-caption">
        <div class="cover-art-title">${campaign.name}</div>
        <div class="cover-art-dates">${dateRange}</div>
        ${fHideLogo ? '' : '<img class="cover-art-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
      </div>
    </div>
  </div>` : `<div class="cover-content">
    ${fHideLogo ? '' : '<img class="cover-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
    <div class="cover-eyebrow">The Saga of</div>
    <div class="cover-title">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-subtitle">${campaign.description || 'A tale of adventure and legend'}</div>
    <div class="cover-dates">${dateRange}</div>
  </div>`}
  <div class="cover-watermark">CAMPAIGNIA.COM</div>
</div>` : ''}
${(!paginated || pageOpts.page === 1) ? titlePageHTML : ''}
${(!paginated || pageOpts.page === 1) ? detailsPageHTML : ''}
${(fCast && (!paginated || pageOpts.page === 1)) ? `<!-- CAST & CREW PAGE -->
<div class="cast-page">
  <div class="cast-page-title">The Company</div>
  <div class="cast-page-subtitle">${campaign.description || ''}</div>
  <div class="cast-divider"></div>
  <div class="cast-page-dm">${_castDmLine}</div>
  ${castBlockHTML}
</div>` : ''}
${(fToc && (!paginated || pageOpts.page === 1)) ? tocBlock : ''}

<!-- SESSIONS -->
${allSessionsHTML}

${fWmark ? '<div class="page-watermark">CAMPAIGNIA.COM</div>' : ''}

${(fCover && !paginated && (campaign.back_cover_image_url || fPublic)) ? `<!-- BACK COVER PAGE -->
<div class="backcover-page"><div class="cover-bg"></div><div class="cover-border"></div><div class="cover-border-inner"></div><div class="backcover-inner">${campaign.back_cover_image_url ? `<div class="cover-art-frame"><img class="cover-art-img" src="${campaign.back_cover_image_url}" alt="" /></div>` : `<div class="backcover-default"><div class="bc-title">${_fmEsc(_bookTitleFM)}</div><div class="bc-rule"></div><div class="bc-tag">A Campaignia Chronicle</div></div>`}</div></div>` : ''}

</body>
</html>`;
}

// ============================================================
// ROUTES
// ============================================================

// GET session PDF HTML
// TRIAL: tiled "CAMPAIGNIA TRIAL" watermark for free-trial users, shown in the
// session + novel preview and print. Dark tone so it reads on the light
// (parchment/white) PDF pages. Gated on the VIEWER's trial status.
var TRIAL_WM_URI = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22320%22%20height%3D%22200%22%3E%3Ctext%20x%3D%22160%22%20y%3D%22108%22%20fill%3D%22%233a2410%22%20fill-opacity%3D%220.18%22%20stroke%3D%22%23ffffff%22%20stroke-opacity%3D%220.12%22%20stroke-width%3D%220.5%22%20font-family%3D%22Georgia%2Cserif%22%20font-size%3D%2222%22%20font-weight%3D%22700%22%20letter-spacing%3D%223%22%20text-anchor%3D%22middle%22%20transform%3D%22rotate%28-30%20160%20108%29%22%3ECAMPAIGNIA%20TRIAL%3C%2Ftext%3E%3C%2Fsvg%3E';
async function userInFreeTrial(db, userId) {
  try {
    var u = await db.prepare('SELECT tier, trial_started_at FROM users WHERE id = ?').get(userId);
    // Free trial = still on the 'trial' tier and inside the 30-day window. Keyed
    // off tier so a paid subscriber in a Stripe-side trial is never blocked here.
    if (!u || u.tier !== 'trial' || !u.trial_started_at) return false;
    var within = (Date.now() - new Date(u.trial_started_at).getTime()) < 30 * 24 * 60 * 60 * 1000;
    return within;
  } catch (e) { return false; }
}
function injectTrialWatermark(html) {
  var css = '<style>.trial-watermark{position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:9999;background-image:url("' + TRIAL_WM_URI + '");background-repeat:repeat;background-position:center;-webkit-print-color-adjust:exact;print-color-adjust:exact;}@media print{.trial-watermark{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style>';
  var div = '<div class="trial-watermark"></div>';
  if (html.indexOf('</head>') !== -1) html = html.replace('</head>', css + '</head>');
  else html = css + html;
  html = html.replace(/<body([^>]*)>/, function(m){ return m + div; });
  return html;
}

// Render a built HTML document to a PDF and stream it inline. Used by the
// ?format=pdf preview mode so the on-screen preview shows the TRUE paged output
// (same renderer as the print interior) instead of screen-media HTML. Relative
// asset URLs (textures, cover logo) resolve against PUBLIC_BASE_URL because
// Puppeteer's setContent has no document base.
// Build a human, filename-safe base name (campaign / session / member) for the
// inline PDF's Content-Disposition, so the browser viewer's Save uses a real name.
// Bad chars by code: / : * ? " < > | \  -> space; control chars -> space.
var PDF_BAD_CHARS = { 47:1, 58:1, 42:1, 63:1, 34:1, 60:1, 62:1, 124:1, 92:1 };
function pdfFileSafe(s) {
  s = String(s == null ? '' : s);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var cc = s.charCodeAt(i);
    out += (cc < 32 || PDF_BAD_CHARS[cc]) ? ' ' : s.charAt(i);
  }
  return out.split(' ').filter(function (x) { return x.length; }).join(' ');
}
function pdfFileName(parts) {
  var nm = (parts || []).map(pdfFileSafe).filter(Boolean).join(' - ');
  if (nm.length > 120) nm = nm.slice(0, 120).trim();
  return nm || 'preview';
}

async function sendHtmlAsPdf(res, html, name) {
  var baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');
  var buf = await renderHtmlToPdf(html, {});
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="' + (name || 'preview') + '.pdf"');
  res.send(buf);
}

router.get('/session/:campaignId/:sessionId', requireAuth, async function(req, res) {
  try {
    const db = await getDb();

    const session = await db.prepare(
      'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
    ).get(req.params.sessionId, req.session.userId);

    if (!session) return res.status(403).json({ error: 'Access denied' });

    // Phase 4 — preview/export the VIEWED version (DM canonical by default, or
    // a ?fork_id= the caller is allowed to see, e.g. a player's own version).
    const viewForkId = await getViewableForkId(db, session.id, req.session.userId, req.query.fork_id);
    if (!viewForkId) return res.status(403).json({ error: 'Access denied' });

    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(viewForkId);
    const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(session.campaign_id);

    // Narrative lives on the fork; read the viewed version's.
    const nfk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro FROM session_forks WHERE id = ?').get(viewForkId);
    const narrative = {
      intro: nfk && nfk.narrative_intro ? nfk.narrative_intro : '',
      sections: nfk && nfk.narrative_sections ? JSON.parse(nfk.narrative_sections) : [],
      outro: nfk && nfk.narrative_outro ? nfk.narrative_outro : '',
      layout_style: req.query.layout || session.layout_style || 'Classic'
    };

    const co = req.query.co ? parseCustomOpts(req.query.co) : null;
    if (co) co.hideLogo = (accessRank(await getEffectiveTier(req.session.userId, campaign.id)) >= 4) && !!co.hidelogo;
    let html = buildSessionHTML(session, moments, campaign, characters, narrative, co, { noCover: true });
    if (await userInFreeTrial(db, req.session.userId)) html = injectTrialWatermark(html);
    if (req.query.format === 'pdf') {
      var sfo = await db.prepare("SELECT u.name AS uname, sf.role AS srole FROM session_forks sf JOIN users u ON u.id = sf.user_id WHERE sf.id = ?").get(viewForkId);
      var sMember = (sfo && sfo.srole === 'player' && sfo.uname) ? sfo.uname : '';
      return await sendHtmlAsPdf(res, html, pdfFileName([campaign.name, session.name, sMember]));
    }
    res.send(html);
  } catch(e) {
    console.error('PDF session error:', e.message);
    res.status(500).send('<html><body style="background:#1a0f08;color:#c9a84c;font-family:serif;padding:2rem;"><h2>Error generating PDF</h2><p>' + e.message + '</p></body></html>');
  }
});

// GET graphic novel HTML (all sessions)
router.get('/novel/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();

  const campaign = await db.prepare(
    'SELECT c.*, cm.role AS my_role, u.name AS owner_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
  ).get(req.params.campaignId, req.session.userId);

  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  // Graphic novel access: the Story Master (dm) always; a member (player) only
  // when the SM has enabled it for this campaign. No tier gate.
  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? AND (novel_include IS NULL OR novel_include = true) ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaign.id);

  // Sort sessions ascending (oldest first) using a normalized YYYY-MM-DD key.
  // session_date may arrive as a string or a Date depending on the driver;
  // Date.toString() sorts by weekday name, so normalize before comparing.
  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; }
    catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) {
    return sessionDateKey(a).localeCompare(sessionDateKey(b));
  });

  // Optional: assemble a specific player's book (?as_user=). For any session
  // the player hasn't versioned, fall back to the DM canonical fork.
  const asUser = req.query.as_user ? Number(req.query.as_user) : null;
  // Load moments and narrative for each session
  const sessionsWithData = await Promise.all(sessions.map(async function(s) {
    let forkId = null;
    if (asUser) {
      const pf = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player'").get(s.id, asUser);
      if (pf) forkId = pf.id;
    }
    if (!forkId) forkId = await getDmForkId(db, s.id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(forkId);
    // Narrative lives on the fork; pull the resolved version's.
    const nfk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro FROM session_forks WHERE id = ?').get(forkId);
    return Object.assign({}, s, {
      moments: moments,
      narrative_intro: nfk ? (nfk.narrative_intro || '') : '',
      narrative_sections: nfk ? (nfk.narrative_sections || null) : null,
      narrative_outro: nfk ? (nfk.narrative_outro || '') : ''
    });
  }));

  const layoutStyle = req.query.layout || 'Classic';

  // Optional pagination: ?page=N renders only session N (1-indexed).
  // Total session count is returned in a header so the client can build a pager.
  var pageOpts = {};
  var pageNum = parseInt(req.query.page, 10);
  if (!isNaN(pageNum) && pageNum > 0) {
    pageOpts.page = pageNum;
  }
  res.set('X-Total-Sessions', String(sessionsWithData.length));

  const co = req.query.co ? parseCustomOpts(req.query.co) : null;
  if (co) co.hideLogo = (accessRank(await getEffectiveTier(req.session.userId, campaign.id)) >= 4) && !!co.hidelogo;
  let html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  if (await userInFreeTrial(db, req.session.userId)) html = injectTrialWatermark(html);
  if (req.query.format === 'pdf') {
    var nMember = '';
    if (asUser) { var nu = await db.prepare('SELECT name FROM users WHERE id = ?').get(asUser); if (nu && nu.name) nMember = nu.name; }
    try { return await sendHtmlAsPdf(res, html, pdfFileName([campaign.name, nMember])); }
    catch (e) { return res.status(500).json({ error: 'PDF render failed', detail: String(e && e.message || e) }); }
  }
  res.send(html);
});

// ============================================================
// Print-ready INTERIOR PDF  (Phase 1: prove the plumbing)
// ------------------------------------------------------------
// Renders the graphic-novel interior (cover page OFF - the cover is a separate
// Lulu file built in a later phase) to a real PDF via headless Chromium, then:
//   ?download=1  -> streams the PDF inline so you can eyeball it
//   (otherwise)  -> uploads to R2 and returns { url } for a Lulu interior_source_url
// Phase 1 renders at the document's native 8.5x11 trim; Lulu pads bleed. True
// full-bleed 8.75x11.25 geometry + high-res panel regen come in Phase 2.
// ============================================================
router.get('/print-interior/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();

  const campaign = await db.prepare(
    'SELECT c.*, cm.role AS my_role, u.name AS owner_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
  ).get(req.params.campaignId, req.session.userId);

  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? AND (novel_include IS NULL OR novel_include = true) ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaign.id);

  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; }
    catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) { return sessionDateKey(a).localeCompare(sessionDateKey(b)); });

  const asUser = req.query.as_user ? Number(req.query.as_user) : null;
  const sessionsWithData = await Promise.all(sessions.map(async function(s) {
    let forkId = null;
    if (asUser) {
      const pf = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player'").get(s.id, asUser);
      if (pf) forkId = pf.id;
    }
    if (!forkId) forkId = await getDmForkId(db, s.id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(forkId);
    const nfk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro FROM session_forks WHERE id = ?').get(forkId);
    return Object.assign({}, s, {
      moments: moments,
      narrative_intro: nfk ? (nfk.narrative_intro || '') : '',
      narrative_sections: nfk ? (nfk.narrative_sections || null) : null,
      narrative_outro: nfk ? (nfk.narrative_outro || '') : ''
    });
  }));

  if (!sessionsWithData.length) {
    return res.status(400).json({ error: 'No sessions are included in the print. Enable at least one session under "Include in Print".' });
  }

  const layoutStyle = req.query.layout || 'Classic';

  // Interior-only: render EXACTLY what the on-screen novel preview shows -- same
  // layout and same custom options -- just without the cover PAGE. The cover is
  // suppressed via pageOpts.noCover so we never synthesize a co object; doing so
  // would force buildNovelHTML down the a-la-carte engine (renderLayout) and lose
  // the reader's chosen preset / magazine wrap layout.
  var co = req.query.co ? parseCustomOpts(req.query.co) : null;

  var pageOpts = { noCover: true, bookTitle: req.query.bookTitle || '' }; // full book, never paginated for print

  var html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);

  // Resolve any relative decorative asset URLs (textures/logo) against the live
  // site so Chromium can fetch them under setContent (which has no document base).
  // Panel images are absolute R2 URLs and are unaffected by <base>.
  var baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html, {});
  } catch (e) {
    console.error('[print-interior] render failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'PDF render failed', detail: String(e && e.message ? e.message : e) });
  }

  if (req.query.download) {
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="interior-' + campaign.id + '.pdf"');
    return res.send(pdfBuffer);
  }

  try {
    var fname = 'interior-' + campaign.id + (asUser ? ('-u' + asUser) : '') + '-' + Date.now() + '.pdf';
    var url = await uploadFile(pdfBuffer, fname, 'application/pdf', 'print');
    var pages = await pdfPageCount(pdfBuffer);
    return res.json({ url: url, bytes: pdfBuffer.length, pages: pages });
  } catch (e) {
    console.error('[print-interior] upload failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'PDF upload failed', detail: String(e && e.message ? e.message : e) });
  }
});

// ============================================================
// PRINT COVER (Phase 3) -- one-piece wrap PDF: back | spine | front.
// Sized to Lulu's exact cover-dimensions (spine width derives from page
// count + binding). Front reuses the campaign cover art; back uses the
// campaign's chosen back-cover image; the spine carries the campaign name.
// GEOMETRY NOTE: the back|spine|front split below assumes perfect-bound
// bleed geometry (and a 0.75in casewrap allowance for hardcover). The total
// sheet size comes from Lulu; the internal split is computed here and should
// be verified against a Lulu sandbox proof, especially for hardcover.
// ============================================================
// Compute the one-piece cover sheet size locally from binding + interior page
// count. Lulu encodes paper bulk in the SKU (060UW444 = 444 pages/inch), so
// spine = pages / PPI; no network call needed. 8.5x11 trim, 0.125in bleed.
// Hardcover (casewrap) adds a 0.75in wrap allowance + board to the spine; that
// piece is approximate and should be checked against a Lulu casewrap proof.
function computeCoverDims(binding, pageCount, ppi) {
  var trimW = 8.5, trimH = 11, bleed = 0.125;
  ppi = ppi || 444;
  var r3 = function (n) { return Math.round(n * 1000) / 1000; };
  var spine = (binding === 'saddle') ? 0 : (pageCount / ppi);
  if (binding === 'hardcover') {
    var wrap = 0.75, board = 0.125;
    return { widthIn: r3(2 * (trimW + wrap) + spine + board), heightIn: r3(trimH + 2 * wrap), spineIn: r3(spine + board) };
  }
  return { widthIn: r3(2 * (trimW + bleed) + spine), heightIn: r3(trimH + 2 * bleed), spineIn: r3(spine) };
}

function coverGeometry(binding, totalWidthIn) {
  var bleed = 0.125, trimW = 8.5;
  var sideOuter = (binding === 'hardcover') ? (trimW + 0.75) : (trimW + bleed);
  var spineW = Math.max(0, Math.round((totalWidthIn - 2 * sideOuter) * 1000) / 1000);
  var sideW = Math.round(((totalWidthIn - spineW) / 2) * 1000) / 1000;
  return { bleed: bleed, sideW: sideW, spineW: spineW };
}

function buildWrapCoverHTML(campaign, spec, dims, opts) {
  opts = opts || {};
  var hideLogo = !!opts.hideLogo;
  var W = dims.widthIn, H = dims.heightIn;
  var geo = coverGeometry(spec.binding, W);
  var sideW = geo.sideW, spineW = geo.spineW;
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var name = esc(campaign.name || 'Campaignia');
  var rawTitle = (opts.bookTitle != null ? String(opts.bookTitle).trim() : '');
  if (!rawTitle) rawTitle = campaign.name || 'Campaignia';
  var bookTitle = esc(rawTitle);
  var titleColor = (opts.titleColor && /^#[0-9a-fA-F]{3,8}$/.test(opts.titleColor)) ? opts.titleColor : '#f0d98a';
  var frontImg = campaign.cover_image_url || '';
  var backImg = campaign.back_cover_image_url || '';
  var logo = hideLogo ? '' : '<img class="wc-logo" src="/images/Campaignia_Logo.png" alt="" />';
  var spineLogo = hideLogo ? '' : '<img class="wc-spine-logo" src="/images/Campaignia_Logo.png" alt="" />';
  var spineFont = Math.max(7, Math.min(20, Math.round(spineW * 56)));
  var spineLogoW = Math.max(0.12, Math.min(0.5, spineW * 0.78));

  var framing = '<div class="wc-bg"></div><div class="wc-border"></div><div class="wc-border-inner"></div>';
  var mark = '<div class="wc-mark">CAMPAIGNIA</div>';
  var frontInner = frontImg
    ? framing +
      '<div class="wc-frame"><img class="wc-img" src="' + frontImg + '" alt="" />' +
      '<div class="wc-fade"></div>' +
      '<div class="wc-front-cap"><div class="wc-title">' + bookTitle + '</div>' + logo + '</div></div>' + mark
    : framing +
      '<div class="wc-frame"><div class="wc-textfront">' + logo +
      '<div class="wc-eyebrow">The Saga of</div><div class="wc-title">' + bookTitle + '</div></div></div>' + mark;
  var backInner = framing +
    '<div class="wc-frame">' + (backImg ? '<img class="wc-img" src="' + backImg + '" alt="" />' : '') + '</div>' + mark;

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    '@page { size: ' + W + 'in ' + H + 'in; margin: 0; }' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body { width: ' + W + 'in; height: ' + H + 'in; }' +
    "body { font-family: 'Cinzel','Georgia',serif; background:#0a0604; overflow:hidden; -webkit-print-color-adjust:exact; print-color-adjust:exact; }" +
    '.wrap { position:relative; width:' + W + 'in; height:' + H + 'in; background:#0a0604; overflow:hidden; }' +
    '.wc-panel { position:absolute; top:0; height:' + H + 'in; overflow:hidden; }' +
    '.wc-back  { left:0; width:' + sideW + 'in; }' +
    '.wc-front { right:0; width:' + sideW + 'in; }' +
    '.wc-spine { left:' + sideW + 'in; width:' + spineW + 'in; display:flex; align-items:center; justify-content:center; background:#0a0604; border-left:1px solid rgba(201,168,76,0.18); border-right:1px solid rgba(201,168,76,0.18); }' +
    '.wc-img { width:100%; height:100%; object-fit:cover; object-position:center top; display:block; }' +
    '.wc-bg { position:absolute; inset:0; background:radial-gradient(ellipse at center, #3a2010 0%, #0a0604 70%); }' +
    '.wc-border { position:absolute; inset:0.5in; border:2px solid rgba(201,168,76,0.4); pointer-events:none; }' +
    '.wc-border-inner { position:absolute; inset:0.6in; border:1px solid rgba(201,168,76,0.2); pointer-events:none; }' +
    '.wc-frame { position:absolute; inset:0.8in; border:2px solid rgba(201,168,76,0.55); border-radius:8px; overflow:hidden; background:#0a0604; box-shadow:0 4px 24px rgba(0,0,0,0.5); }' +
    '.wc-fade { position:absolute; inset:0; box-shadow:inset 0 0 70px 34px rgba(10,6,4,0.85); pointer-events:none; }' +
    '.wc-mark { position:absolute; left:50%; bottom:0.5in; transform:translate(-50%,50%); background:#0a0604; padding:0 0.14in; font-size:8pt; color:rgba(201,168,76,0.8); letter-spacing:0.2em; z-index:3; }' +
    '.wc-spine-group { transform:rotate(90deg); transform-origin:center; white-space:nowrap; }' +
    '.wc-spine-text { font-size:' + spineFont + 'pt; color:' + titleColor + '; letter-spacing:0.06em; }' +
    '.wc-spine-logo { position:absolute; left:50%; bottom:0.16in; transform:translateX(-50%); width:' + spineLogoW + 'in; height:auto; object-fit:contain; opacity:0.95; }' +
    '.wc-front-cap { position:absolute; left:0; right:0; bottom:0; height:48%; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; padding:0 0.32in 0.4in; background:linear-gradient(to top, rgba(10,6,4,0.96) 24%, rgba(10,6,4,0.55) 60%, rgba(10,6,4,0) 100%); }' +
    '.wc-textfront { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0.6in 0.5in 0.6in 0.45in; text-align:center; }' +
    '.wc-title { font-size:26pt; font-weight:700; color:' + titleColor + '; letter-spacing:0.04em; line-height:1.12; text-align:center; text-transform:uppercase; text-shadow:0 2px 14px rgba(0,0,0,0.95); margin-bottom:0.16in; }' +
    '.wc-eyebrow { font-size:10pt; color:rgba(201,168,76,0.6); letter-spacing:0.2em; text-transform:uppercase; margin-bottom:0.12in; }' +
    '.wc-logo { width:1.05in; height:auto; object-fit:contain; opacity:0.92; }' +
    '</style></head><body>' +
    '<div class="wrap">' +
      '<div class="wc-panel wc-back">' + backInner + '</div>' +
      '<div class="wc-panel wc-spine"><div class="wc-spine-group"><span class="wc-spine-text">' + bookTitle + '</span></div>' + spineLogo + '</div>' +
      '<div class="wc-panel wc-front">' + frontInner + '</div>' +
    '</div></body></html>';
}

// GET print-ready one-piece COVER PDF (R2-hosted, or ?download=1 inline).
router.get('/print-cover/:campaignId', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const campaign = await db.prepare(
      'SELECT c.*, cm.role AS my_role, u.name AS owner_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
    ).get(req.params.campaignId, req.session.userId);
    if (!campaign) return res.status(403).json({ error: 'Access denied' });
    var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
      campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
    if (campaign.my_role !== 'dm' && !_allowNovel) {
      return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
    }

    var selection = {
      binding: req.query.binding || 'paperback',
      colorTier: req.query.color || 'premium',
      coverFinish: req.query.finish || 'matte',
    };
    var pageCount = parseInt(req.query.pageCount, 10);
    if (!(pageCount > 0)) return res.status(400).json({ error: 'pageCount required' });
    var built = catalog.buildSpec(selection, pageCount);
    if (!built.ok) return res.status(400).json({ error: 'Invalid selection', details: built.errors });

    var dims = computeCoverDims(built.spec.binding, built.spec.pageCount);
    if (!(dims.widthIn > 0 && dims.heightIn > 0)) {
      return res.status(500).json({ error: 'Could not compute cover dimensions' });
    }

    var co = req.query.co ? parseCustomOpts(req.query.co) : null;
    if (co) co.hideLogo = (accessRank(await getEffectiveTier(req.session.userId, campaign.id)) >= 4) && !!co.hidelogo;
    var fHideLogo = co ? !!co.hideLogo : false;

    var html = buildWrapCoverHTML(campaign, built.spec, dims, { hideLogo: fHideLogo, bookTitle: req.query.bookTitle || '', titleColor: req.query.titleColor || '' });
    var baseUrl = (process.env.PUBLIC_BASE_URL || '');
    if (baseUrl.charAt(baseUrl.length - 1) === '/') baseUrl = baseUrl.slice(0, -1);
    if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');

    var pdfBuffer;
    try {
      pdfBuffer = await renderHtmlToPdf(html, { widthIn: dims.widthIn, heightIn: dims.heightIn });
    } catch (e) {
      console.error('[print-cover] render failed:', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Cover render failed', detail: String(e && e.message ? e.message : e) });
    }

    if (req.query.download) {
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="cover-' + campaign.id + '.pdf"');
      return res.send(pdfBuffer);
    }
    try {
      var fname = 'cover-' + campaign.id + '-' + Date.now() + '.pdf';
      var url = await uploadFile(pdfBuffer, fname, 'application/pdf', 'print');
      return res.json({ url: url, bytes: pdfBuffer.length, widthIn: dims.widthIn, heightIn: dims.heightIn });
    } catch (e) {
      console.error('[print-cover] upload failed:', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Cover upload failed', detail: String(e && e.message ? e.message : e) });
    }
  } catch (e) {
    console.error('[print-cover] error:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Server error', detail: String(e && e.message ? e.message : e) });
  }
});

// ============================================================
// PUBLISH TO PUBLIC LIBRARY (Stories tab)
// ------------------------------------------------------------
// A fork OWNER publishes their OWN graphic novel to the public Stories
// directory. We render the caller's own book with publicMode ON (real names
// -> pen names, default back cover), snapshot the PDF to R2, capture a cover
// thumbnail, and upsert one public_stories row per (campaign, publisher).
// Owner-only BY CONSTRUCTION: we always render the CALLER's own fork (canonical
// when they are the DM/owner, their player fork otherwise). There is no path to
// publish someone else's fork -- any client as_user is ignored.
// ============================================================
router.post('/publish-story/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();

  // Publishing to the public Library requires a paid plan -- free-trial users
  // are blocked here (server-side enforcement; the client also pre-checks).
  if (await userInFreeTrial(db, req.session.userId)) {
    return res.status(403).json({ error: 'You need to sign up to publish to the library.', code: 'publish_requires_subscription' });
  }

  // Publish-time attestation (client shows a required checkbox; enforced here
  // too). The author confirms they own/have rights to the content and that it
  // is suitable for a general audience.
  if (!(req.body && req.body.attested === true)) {
    return res.status(400).json({ error: 'You must confirm you own this content and that it is suitable for a general audience before publishing.', code: 'publish_requires_attestation' });
  }

  const campaign = await db.prepare(
    'SELECT c.*, cm.role AS my_role, u.name AS owner_name, u.pen_name AS owner_pen_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
  ).get(req.params.campaignId, req.session.userId);
  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  // Always the caller's OWN book: DM/owner -> canonical; player -> their fork.
  const asUser = (campaign.my_role === 'dm') ? null : Number(req.session.userId);

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? AND (novel_include IS NULL OR novel_include = true) ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare(
    'SELECT ch.*, u.pen_name AS player_pen_name FROM characters ch LEFT JOIN users u ON u.id = ch.owner_user_id WHERE ch.campaign_id = ?'
  ).all(campaign.id);

  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; } catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) { return sessionDateKey(a).localeCompare(sessionDateKey(b)); });

  const sessionsWithData = await Promise.all(sessions.map(async function(s) {
    let forkId = null;
    if (asUser) {
      const pf = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? AND role = 'player'").get(s.id, asUser);
      if (pf) forkId = pf.id;
    }
    if (!forkId) forkId = await getDmForkId(db, s.id);
    const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(forkId);
    const nfk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro FROM session_forks WHERE id = ?').get(forkId);
    return Object.assign({}, s, {
      moments: moments,
      narrative_intro: nfk ? (nfk.narrative_intro || '') : '',
      narrative_sections: nfk ? (nfk.narrative_sections || null) : null,
      narrative_outro: nfk ? (nfk.narrative_outro || '') : ''
    });
  }));

  if (!sessionsWithData.length) {
    return res.status(400).json({ error: 'No sessions are included. Enable at least one session under Include in Print before publishing.' });
  }

  const layoutStyle = req.query.layout || 'Classic';
  // Match what the reader sees in Preview & Export: only pass co when they have
  // a custom layout (passing a synthesized co would force the a-la-carte engine
  // and lose their legacy preset). publicMode + default back cover ride on
  // pageOpts, so masking works whether or not co is present.
  var co = req.query.co ? parseCustomOpts(req.query.co) : null;
  if (co) co.cover = 1; // a published book always shows its cover page
  var bookTitle = (req.body && req.body.title && String(req.body.title).trim()) ? String(req.body.title).trim() : '';
  var pageOpts = { publicMode: true, bookTitle: bookTitle };

  var html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  var baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html, {});
  } catch (e) {
    console.error('[publish-story] render failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not render your story PDF. Please try again.' });
  }

  let pdfUrl;
  try {
    var fname = 'story-' + campaign.id + '-u' + req.session.userId + '-' + Date.now() + '.pdf';
    pdfUrl = await uploadFile(pdfBuffer, fname, 'application/pdf', 'story');
  } catch (e) {
    console.error('[publish-story] upload failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not save your story PDF. Please try again.' });
  }

  // Cover thumbnail: campaign cover image, else the first available panel image.
  var coverUrl = campaign.cover_image_url || '';
  if (!coverUrl) {
    for (var si = 0; si < sessionsWithData.length && !coverUrl; si++) {
      var ms = sessionsWithData[si].moments || [];
      for (var mi = 0; mi < ms.length; mi++) { if (ms[mi] && ms[mi].image) { coverUrl = ms[mi].image; break; } }
    }
  }

  var title = bookTitle || campaign.name;
  var authorName = '';
  try {
    var meRow = await db.prepare('SELECT pen_name FROM users WHERE id = ?').get(req.session.userId);
    authorName = (meRow && meRow.pen_name) ? meRow.pen_name : '';
  } catch (e) {}

  try {
    var nowIso = new Date().toISOString();
    var blurb = (req.body && req.body.blurb && String(req.body.blurb).trim()) ? String(req.body.blurb).trim() : '';
    if (blurb.length > 600) blurb = blurb.slice(0, 600);
    var _slugify = function(s){ s = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); if (!s) s = 'story'; if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, ''); return s; };
    var slug = _slugify(title);
    var _firstPara = function(txt){ if (!txt) return ''; var t = String(txt).replace(/\r/g, '').trim(); if (!t) return ''; var idx = t.indexOf('\n\n'); var p = (idx > -1) ? t.slice(0, idx) : t; return p.trim(); };
    var teaser = '';
    for (var _ti = 0; _ti < sessionsWithData.length && !teaser; _ti++) { teaser = _firstPara(sessionsWithData[_ti].narrative_intro); }
    if (teaser.length > 500) teaser = teaser.slice(0, 500);
    var snapshotObj = { v: 1, layoutStyle: layoutStyle, co: co, bookTitle: bookTitle, campaign: campaign, characters: characters, sessions: sessionsWithData };
    var snapshotJson = JSON.stringify(snapshotObj);
    var _ins = await db.prepare(
      'INSERT INTO public_stories (campaign_id, user_id, author_name, title, pdf_url, cover_url, snapshot, slug, blurb, teaser, public, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, TRUE, ?, ?)'
    ).run(campaign.id, req.session.userId, authorName, title, pdfUrl, coverUrl || null, snapshotJson, slug, blurb || null, teaser || null, nowIso, nowIso);
    var _newStoryId = _ins ? _ins.lastInsertRowid : null;
  } catch (e) {
    console.error('[publish-story] db upsert failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not record your published story. Please try again.' });
  }

  try {
    var _storyId = (typeof _newStoryId !== 'undefined') ? _newStoryId : null;
    if (_storyId) {
      var _imgSet = {};
      if (coverUrl) _imgSet[coverUrl] = true;
      for (var _sx = 0; _sx < sessionsWithData.length; _sx++) {
        var _mz = sessionsWithData[_sx].moments || [];
        for (var _mx = 0; _mx < _mz.length; _mx++) { if (_mz[_mx] && _mz[_mx].image) _imgSet[_mz[_mx].image] = true; }
      }
      var _urls = Object.keys(_imgSet);
      await db.prepare('DELETE FROM public_story_images WHERE story_id = ?').run(_storyId);
      for (var _ux = 0; _ux < _urls.length; _ux++) { await db.prepare('INSERT INTO public_story_images (story_id, image_url) VALUES (?, ?)').run(_storyId, _urls[_ux]); }
    }
  } catch (e) {
    console.error('[publish-story] image-index rebuild failed (non-fatal):', e && e.message ? e.message : e);
  }

  return res.json({ success: true, url: pdfUrl, author: authorName });
});

// Unpublish the caller's OWN story for a campaign (admin moderation is separate).
router.post('/unpublish-story/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var row = await db.prepare('SELECT pdf_url FROM public_stories WHERE campaign_id = ? AND user_id = ?').get(req.params.campaignId, req.session.userId);
    await db.prepare('DELETE FROM public_stories WHERE campaign_id = ? AND user_id = ?').run(req.params.campaignId, req.session.userId);
    if (row && row.pdf_url) { try { await deleteFile(row.pdf_url); } catch (e2) { console.error('[unpublish-story] R2 cleanup failed (non-fatal):', e2 && e2.message ? e2.message : e2); } }
    return res.json({ success: true });
  } catch (e) {
    console.error('[unpublish-story] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not unpublish. Please try again.' });
  }
});

// Whether the caller already has a published story for this campaign (button state).
router.get('/story-status/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var row = await db.prepare('SELECT pdf_url, public, updated_at FROM public_stories WHERE campaign_id = ? AND user_id = ?').get(req.params.campaignId, req.session.userId);
    return res.json({ published: !!(row && row.public), url: row ? row.pdf_url : null, updatedAt: row ? row.updated_at : null });
  } catch (e) {
    return res.json({ published: false });
  }
});

// The caller's own published Stories, across all campaigns -- the durable place
// to manage them even after they lose access to a campaign.
router.get('/my-stories', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var rows = await db.prepare('SELECT id, campaign_id, title, author_name, cover_url, pdf_url, slug, blurb, created_at, updated_at FROM public_stories WHERE user_id = ? AND public = TRUE ORDER BY COALESCE(updated_at, created_at) DESC').all(req.session.userId);
    var items = (rows || []).map(function(r){ return { id: r.id, campaign_id: r.campaign_id, title: r.title || 'Untitled', author: r.author_name || '', cover_url: r.cover_url || '', pdf_url: r.pdf_url, slug: r.slug || '', blurb: r.blurb || '', created_at: r.created_at }; });
    return res.json({ items: items });
  } catch (e) {
    console.error('[my-stories] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not load your stories.' });
  }
});

// Update just the blurb on a published story (owner-only via user_id). Lets
// authors manage their Library blurb from the Account page without a full
// republish. Capped at 600 to match publish; bumps updated_at for sitemap lastmod.
router.post('/story-blurb/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var blurb = (req.body && req.body.blurb != null) ? String(req.body.blurb).trim() : '';
    if (blurb.length > 600) blurb = blurb.slice(0, 600);
    await db.prepare('UPDATE public_stories SET blurb = ?, updated_at = ? WHERE campaign_id = ? AND user_id = ?').run(blurb || null, new Date().toISOString(), req.params.campaignId, req.session.userId);
    return res.json({ success: true, blurb: blurb });
  } catch (e) {
    console.error('[story-blurb] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not save your blurb.' });
  }
});

// Remove ONE published story by its id (owner-only). Multiple stories may be
// published from the same campaign, so deletion is per-item, not per-campaign.
router.post('/story/:id/unpublish', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var row = await db.prepare('SELECT pdf_url FROM public_stories WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Story not found.' });
    await db.prepare('DELETE FROM public_stories WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
    if (row.pdf_url) { try { await deleteFile(row.pdf_url); } catch (e2) { console.error('[story unpublish] R2 cleanup failed (non-fatal):', e2 && e2.message ? e2.message : e2); } }
    return res.json({ success: true });
  } catch (e) {
    console.error('[story unpublish] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not remove your story.' });
  }
});

// Update the blurb on ONE published story by its id (owner-only).
router.post('/story/:id/blurb', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var blurb = (req.body && req.body.blurb != null) ? String(req.body.blurb).trim() : '';
    if (blurb.length > 600) blurb = blurb.slice(0, 600);
    await db.prepare('UPDATE public_stories SET blurb = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(blurb || null, new Date().toISOString(), req.params.id, req.session.userId);
    return res.json({ success: true, blurb: blurb });
  } catch (e) {
    console.error('[story blurb] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not save your blurb.' });
  }
});

// Update title and/or blurb on ONE published story by id (owner-only). Blank
// title keeps the existing one (a story always needs a title).
router.post('/story/:id/meta', requireAuth, async function(req, res) {
  const db = await getDb();
  try {
    var title = (req.body && req.body.title != null) ? String(req.body.title).trim() : '';
    if (title.length > 200) title = title.slice(0, 200);
    var blurb = (req.body && req.body.blurb != null) ? String(req.body.blurb).trim() : '';
    if (blurb.length > 600) blurb = blurb.slice(0, 600);
    await db.prepare("UPDATE public_stories SET title = COALESCE(NULLIF(?, ''), title), blurb = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(title, blurb || null, new Date().toISOString(), req.params.id, req.session.userId);
    var row = await db.prepare('SELECT title, blurb FROM public_stories WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
    return res.json({ success: true, title: row ? row.title : title, blurb: row ? (row.blurb || '') : blurb });
  } catch (e) {
    console.error('[story meta] failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not save your changes.' });
  }
});

module.exports = router;
module.exports.buildNovelHTML = buildNovelHTML;
