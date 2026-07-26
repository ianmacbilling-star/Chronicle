const express = require('express');
const router = express.Router();
const { getDb, getDmForkId, getViewableForkId, effectiveIncludeMap, effectiveBookMeta, getForkBookPrefs, getAppSettingInt } = require('../database/db');
const { friendlyError } = require('../middleware/friendlyErrors');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getEffectiveTier, accessRank, isPaidTier } = require('../middleware/tiers');
const { canAfford, spendTokens } = require('./tokens');
const path = require('path');
const { uploadFile, deleteFile } = require('../storage/storage');
const { renderHtmlToPdf } = require('../services/printing/renderPdf');
const { measureDocument } = require('../services/printing/measureLayout');
const { packPaired } = require('../services/printing/packPaired');
const { decoSumHeight, decoHeight, DEFAULT_LH } = require('../services/printing/decorationRegistry');
var HEADER_BAND_IN = 0.24;   // top band reserved on each composed page for the per-page running header (keeps body clear)
const { packComic } = require('../services/printing/packComic');
const { planComic } = require('../services/printing/comicEngine');
const { getPrintProvider } = require('../services/printing');
const catalog = require('../services/printing/catalog');
const { logDebug } = require('./debug');

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
// Count pages in a rendered PDF buffer (pdf-lib). Enforces the global
// Max Pages Per Print limit across all layouts.
async function countPdfPages(buffer) {
  var lib = require('pdf-lib');
  var doc = await lib.PDFDocument.load(buffer, { updateMetadata: false });
  return doc.getPageCount();
}
function momentAspect(m) {
  var w = m && Number(m.img_w), h = m && Number(m.img_h);
  if (w > 0 && h > 0) return w / h;
  // No stored pixel dims: towers are GENERATED at 1:4 but their nominal shape ratio is
  // 9:16, so packing/width math would reserve a 9:16 column for a 1:4 image. Fall back to
  // the true generation aspect for towers; every other shape keeps its nominal aspect.
  var s = normShape(m);
  if (s === 'tower' || s === 'towerthin') return 1 / 4;
  return shapeAspect(s);
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
function lmFlow(m) { return lmMeta(m).flow === true; }   // text-flow: pull next beat's intro up
function lmScale(m) { var n = Number(lmMeta(m).scale); return (n >= 0.3 && n <= 1) ? n : 1; }   // measured shrink-to-fit
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
    return '1 / 4';   // no stored dims: true 1:4 generation ratio, not the nominal 9:16 box
  }
  return shapeRatioCSS(s);
}
// Numeric aspect (w/h) matching dispRatioCSS -- the ratio coMedia's aspect-box actually renders
// with. The composer must size images with THIS (not momentAspect, the raw pixel ratio) or its
// width->height math disagrees with the rendered box and the page clips.
function dispAspect(m) {
  var s = normShape(m);
  if (s === 'tower' || s === 'towerthin') {
    var w = m && Number(m.img_w), h = m && Number(m.img_h);
    if (w > 0 && h > 0) return w / h;
    return 0.25;
  }
  return shapeAspect(s);
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
    return momentImgAspectBox(m, ratio, 'border-radius:' + rad + ';' + b, '');
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
  // Script-formatted narrative (Comic Dialogue) arrives as newline-separated speaker
  // lines (NAME: "..."). HTML collapses newlines, so detect that shape and convert the
  // breaks to <br> with no first-line indent. Flowing prose (no NAME: speaker lines) is
  // returned unchanged, byte-for-byte.
  var isScript = false;
  var inner = text;
  if (text.indexOf('\n') >= 0) {
    var _lines = text.split('\n');
    var _hits = 0;
    for (var _i = 0; _i < _lines.length; _i++) {
      if (/^\s*[A-Za-z][A-Za-z0-9 ._'\-]{0,24}:\s+["\u201c\u2018']/.test(_lines[_i])) _hits++;
    }
    if (_hits >= 1) {
      isScript = true;
      inner = _lines.map(function (l) { return l.trim(); }).filter(function (l) { return l.length; }).join('<br>');
    }
  }
  return '<p style="font-family:Crimson Text,Georgia,serif;font-size:12pt;line-height:1.8;color:#2a1a0e;' +
    (isIntro ? 'font-style:italic;font-size:13pt;' : '') +
    'margin:0.15in 0;text-indent:' + (isScript ? '0' : (isIntro ? '0' : '0.3in')) + ';">' + inner + '</p>';
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
      momentImgAspectBox(m, ratio, '', '') +
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
      momentImgAspectBox(m, ratio, '', '') +
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
    ? momentImgAspectBox(m, ratio, 'box-shadow:' + CO_IMG_SHADOW + ';', '')
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
function bronzeFrame(inner, inline, scale, ratio) {
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
  if (ratio) {
    // INSET frame: the outer box IS the image box (fixed to the image aspect ratio); all the
    // frame padding is drawn INWARD via border-box, so the frame adds zero height/width -- it
    // just covers the outermost sliver of the image. Keeps the packer's geometry exact.
    return '<div style="' + (inline ? 'display:inline-block;' : '') + 'width:100%;aspect-ratio:' + ratio + ';box-sizing:border-box;padding:' + padO + 'px;background:linear-gradient(135deg,#2c1e10 0%,#0d0a06 52%,#2c1e10 100%);border:1px solid #0a0806;border-radius:2px;box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
      '<div style="width:100%;height:100%;box-sizing:border-box;padding:' + padM + 'px;background:#0a0806;">' +
      '<div style="position:relative;width:100%;height:100%;box-sizing:border-box;border:' + gold + 'px solid #c9a84c;line-height:0;">' + inner + _dia + '</div>' +
      '</div>' +
    '</div>';
  }
  return '<div style="' + (inline ? 'display:inline-block;' : '') + 'padding:' + padO + 'px;background:linear-gradient(135deg,#2c1e10 0%,#0d0a06 52%,#2c1e10 100%);border:1px solid #0a0806;border-radius:2px;box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
    '<div style="padding:' + padM + 'px;background:#0a0806;">' +
    '<div style="position:relative;border:' + gold + 'px solid #c9a84c;line-height:0;">' + inner + _dia + '</div>' +
    '</div>' +
  '</div>';
}
function framedMedia(m) {
  var ratio = dispRatioCSS(m);
  // NOTE: bronzeFrame has no overflow:hidden, so the primitive's 1px overscan would bleed past the
  // gold border. This emitter keeps its own exact height:100% cover img (no overscan) -- a genuine
  // special case left out of the primitive on purpose.
  var inner = m.image
    ? '<img style="width:100%;height:100%;object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#160e06;"></div>';
  return bronzeFrame(inner, false, 1, ratio);
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
  // Base media through the primitive: crop-safe cover+focal, non-crop-safe contain. (Step 3)
  var img = momentImgAspectBox(m, ratio, '', '');
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
    return momentImgAspectBox(m, ratio, 'box-shadow:' + CO_IMG_SHADOW + ';', '');
  }
  if (kind === 'bleed') {
    return img;
  }
  return momentImgAspectBox(m, ratio, 'border:1px solid rgba(201,168,76,0.25);border-radius:3px;', '');
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
  paper: 'white',        // white | cream
  condition: 'none',     // none | smoke | dirt | wrinkle | blood
  font: 'classic',
  pano: 1, aside: 1, companion: 1, emphasis: 0,
  cover: 1, cast: 1, toc: 1, header: 1, markers: 1, markerbreak: 0, watermark: 1,
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
  // Through the primitive now: crop-safe images cover+overscan (as before), non-crop-safe get
  // contain instead of being force-cropped, and focal position is honored. (roadmap #1, Step 3)
  var img = momentImgAspectBox(m, ratio, '', '');
  switch (border) {
    case 'frame': return '<div style="padding:2px 0;line-height:0;">' + framedMedia(m) + '</div>';
    case 'comic': return '<div style="position:relative;line-height:0;">' + img + '<div style="position:absolute;inset:0;border:5px solid #0a0806;pointer-events:none;"></div></div>';   // B: full-size image + INSET border (was 'border:5px solid' on the wrapper, which carved ~0.1in of width)
    case 'vignette':
      return '<div style="position:relative;line-height:0;">' + img + vignetteOverlayHtml() + '</div>';
    case 'gallery':
      // B: full-size image; drop-shadow bleeds outward (was 'padding:0 0.26in 0.26in 0', which carved ~0.26in of width -> ~1in short on towers)
      return '<div style="line-height:0;padding-bottom:0.14in;">' +
        momentImgAspectBox(m, ratio, 'border-radius:2px;box-shadow:' + CO_IMG_SHADOW + ';', '') + '</div>';
    case 'keyline':
      return '<div style="padding:2px 0;line-height:0;">' + shapedImage(m, 'border:1px solid rgba(120,90,30,0.35);box-shadow:0 1px 5px rgba(0,0,0,0.12);', '4px') + '</div>';
    case 'none':
    default:
      return img;
  }
}

// pdf.js 3.11.174 (the Finalize preview viewer) can't render fade-to-transparent gradient shadings
// and falls back to a pink placeholder. In the preview PANES ONLY, swap those gradients for pdf.js-safe
// solids: the caption fade -> a flat semi-transparent dark bar; the vignette edge-fade -> dropped.
// The downloaded book keeps the true gradients -- this never runs for print (gated on ?pane=1).
function paneSafeHtml(html) {
  if (!html) return html;
  return html
    .split('linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.4) 55%,rgba(10,8,6,0))').join('rgba(10,8,6,0.82)')
    .split('linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.45) 45%,rgba(10,8,6,0))').join('rgba(10,8,6,0.82)')
    .split('radial-gradient(ellipse at center, rgba(255,255,255,0) 46%, rgba(255,255,255,0.7) 76%, rgba(255,255,255,1) 92%)').join('transparent');
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
// PHASE 1 (page-packer): text-only measure body for the PAIRED layout. Tags each beat's
// narration so measureDocument returns its TRUE rendered height at the page width. Image
// heights are analytic (aspect x width) so only text -- the genuinely unknown height -- is
// measured. Wrapped in the real novel shell by buildNovelHTML, so fonts/CSS match exactly.
// Fires only when opts.measurePaired is set; normal rendering untouched.
function buildPairedMeasureBody(moments, sections, intro, outro, opts) {
  var out = '';
  if (intro) out += '<div data-mblk="mintro" data-mkind="narr" data-mmoment="-1" data-mpart="before" data-mchars="' + String(intro).length + '">' + coNarr(intro, opts || {}, false).replace('margin:0.15in 0', 'margin:0') + '</div>';
  for (var i = 0; i < moments.length; i++) {
    var sec = (sections || []).find(function (s) { return s.panel_index === i; }) || {};
    ['before', 'after'].forEach(function (part) {
      var txt = sec[part];
      if (!txt) return;
      var inner = coNarr(txt, opts || {}, false).replace('margin:0.15in 0', 'margin:0');
      out += '<div data-mblk="p' + i + '_' + part + '" data-mkind="narr" data-mmoment="' + i + '" data-mpart="' + part + '" data-mchars="' + String(txt).length + '">' + inner + '</div>';
    });
  }
  if (outro) out += '<div data-mblk="moutro" data-mkind="narr" data-mmoment="-2" data-mpart="before" data-mchars="' + String(outro).length + '">' + coNarr(outro, opts || {}, false).replace('margin:0.15in 0', 'margin:0') + '</div>';
  return out || '<div data-mblk="empty" data-mkind="narr"></div>';
}

function renderPaired(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);
  var pbN = 0;
  var _pulled = {};   // beats whose intro was pulled up by a flow-flagged prior beat
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var overlay = coCaptionOverlay(m, opts.caption);
    // Text-flow (initial phase): a beat flagged `flow` pulls the NEXT beat's intro up to
    // fill its page; that next beat then skips the intro (already shown here). Only fires
    // when the flow signal is set (optimize preview), so normal books are untouched.
    var _beforeTxt = _pulled[i] ? '' : (section.before || '');
    var beforeHtml = _beforeTxt ? '<div style="margin-top:0.1in;">' + coNarr(_beforeTxt, opts, false) + '</div>' : '';
    var afterHtml = section.after ? '<div style="margin-top:0.1in;">' + coNarr(section.after, opts, false) + '</div>' : '';
    if (lmFlow(m) && (i + 1) < moments.length) {
      var _nsec = sections.find(function (s) { return s.panel_index === (i + 1); }) || {};
      if (_nsec.before) { afterHtml += '<div style="margin-top:0.1in;">' + coNarr(_nsec.before, opts, false) + '</div>'; _pulled[i + 1] = true; }
    }
    var _sc = lmScale(m);   // measured shrink factor (1 = unchanged); applied to image widths below
    if (opts.packStacked) {
      // Stacked page-by-page render (the "arrived" state -- good density): every image
      // centered, text above/below, no floats. Tower-split handling is layered separately
      // so it can never regress this density again.
      var _isP = isPortrait(m);
      var _dispW = (_isP ? 4.6 : 6.8) * _sc;
      var _imgHtml = m.image
        ? '<div style="margin:0 auto 0.1in;width:' + _dispW.toFixed(2) + 'in;page-break-inside:avoid;">' +
            '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
            coCaptionBelow(m, i, opts.caption) + '</div>'
        : '';
      html += beforeHtml + _imgHtml + afterHtml;
      continue;
    }
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
        ? Math.min(6.8 - pbCol, 9.5 * momentAspect(m))
        : Math.min(6.8 - pbCol, 7.0 * shapeAspect(normShape(m)));
      pbW = pbW * _sc;
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
      } else if (lmSizeTier(m) !== 'min') {
        // Picture Book maximizes portraits BY DEFAULT (Default & Maximize) -> center it big.
        // Size it to fill the page WITH its narrative when the bridge is short/medium (so the
        // text never orphans); when the narrative is long enough to carry its own page, go
        // near-full-page and let the text flow after. Minimize (below) is the only dial-down.
        var _sideLen = ((section.before || '') + ' ' + (section.after || '')).replace(/\s+/g, ' ').trim().length;
        var _textIn = (_sideLen / 62) * 0.30 + (_sideLen ? 0.25 : 0);   // rough narrative block height (in)
        var pbBigH = (_textIn > 2.6) ? 9.3 : Math.max(6.4, Math.min(9.3, 9.5 - _textIn - 0.35));
        var pbBigMax = 6.6;
        var pbBigW = Math.min(pbBigMax, pbBigH * shapeAspect(normShape(m)));
        pbBigW = pbBigW * _sc;
        html += '<div style="margin:0 auto 0.12in;width:' + pbBigW.toFixed(2) + 'in;page-break-inside:avoid;">' +
          '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
          coCaptionBelow(m, i, opts.caption) + '</div>' +
          '<div style="break-before:avoid;page-break-before:avoid;">' + beforeHtml + afterHtml + '</div>';
      } else {
        html += '<div style="display:flow-root;margin-bottom:0.1in;">' + pbImg + beforeHtml + afterHtml + '</div>';
      }
    } else {
      // Wide / panoramic / square / standard: keep the image + caption together
      // in the avoid-block, but let the narrative flow BELOW as its own block so
      // a wide shot is never dragged onto the next page by long text. Two wide
      // shots then pack onto one sheet when there is room instead of stranding
      // white space at a page bottom.
      html += '<div style="width:' + Math.round(_sc * 100) + '%;margin:0 auto 0.06in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      // Keep the narrative glued to the image above it: a short bridge must not be
      // able to start a fresh page alone (the near-blank "orphan" pages). break-before:avoid
      // makes Chromium move the image+bridge together instead of stranding the text.
      html += '<div style="break-before:avoid;page-break-before:avoid;">' + beforeHtml + afterHtml + '</div>';
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
var MZ_SHRINK = 1.0;  // was 0.9 -- global shrink backfired (smaller pics = more white on image pages); reactive shrink-to-fit replaces it
var MZ_FLOAT_MIN = 2.0;  // legibility floor (in): a small float's larger dimension never renders below this
var MZ_MIN_TEXT_COL = 1.9;  // (in) keep at least this much text column beside a floated image -- caps image width
var MZ_MIN_SLICE_LINES = 2;  // anti-sliver: a split slice must carry at least this many lines (classic orphan rule -- never one lonely line)
var MZ_MIN_TAIL_CHARS = 60;  // anti-fragment: a split TAIL must carry at least this many characters. The line-count rule above cannot see that a "line" holds a single full stop -- this can. Below it the cut steps back a whole line; if none survives, the band is not split at all.
var MZ_TAIL_DEADZONE = 24;   // (chars) fillMissingMagazineLines stops synthesizing line boundaries this close to the end of the text. snapWord returns the RAW offset once it is within one character of the end, which is exactly how a cut point landed between a word and its closing full stop.
var MZ_SPLIT_PAD = 0.25;    // (in) headroom reserved on a split slice for the paragraph's own top/bottom margin, so a cut band never overflows the page and clips
var MZ_GAPFIT_FLOOR = 0.5;  // shrink-to-fit-the-gap won't shrink a stranded float's image below this (keeps the wrap legible; bigger shrinks are skipped, leaving the white)
var MZ_PAGE_GROW = true;      // iterative optimizer: grow the image on an underfull page so the text re-wraps around it and fills the white (nothing leaves the page)
var MZ_GROW_MIN_WHITE = 0.6;  // (in) only grow a page with at least this much white
var MZ_GROW_MAX_MUL = 3.0;    // hard ceiling on how much an image may be enlarged to fill a page
var MZ_GROW_ROUNDS = 3;       // refinement rounds (each costs one measure): aim at the analytic target, then bisect
var MZ_LOOKBACK_PULLUP = true; // iterative optimizer: an underfull page pulls up a following single movable band that fits (gated on the real re-measure)
var MZ_TOWER_MERGE = true;    // iterative optimizer: fold a stranded text-only tail into the following tower's beside-column (gated on the real re-measure)
var MZ_TOWER_MERGE_MAX_IN = 9.16; // a merged/grown page must fit the composed CONTENT area, and
// that area is the 9.65in box MINUS the 0.24in header padding-top AND a further ~0.25in bottom
// safety (the header band is carved from the top with padding, so usable height is ~9.17in, not
// 9.41). The old 9.40 let a page measuring 9.2-9.4 pass the gate and then clip its last line under
// overflow:hidden -- the tower-lead beside-column overflow. 9.16 matches the packer's own body
// budget (pageHeightIn 9.4 - HEADER_BAND_IN), so the merge gate and the packer now agree.
var MZ_SPILL_MIN_GAP = 1.8;   // leading-text spill fires when the wasted gap is at least this tall
var MZ_SPILL_MIN_LINES = 2;   // and only if at least this many lines of the before-paragraph fill it
var MZ_GROW_TO_FILL = false; // OFF: growing images to hide white bloats pictures (against the wrap guardrail) AND pre-empts collapse. Collapse-to-fit is the density lever now.
var MZ_OPT_SHRINK_FEATURES = true;   // Optimize caps + floats portrait features (milder than before). Ian: keep the wrap, just don't shrink as hard as 5.5.
var MZ_FEATURE_MAX_H = 6.0;       // OPTIMIZE-ONLY portrait-feature cap (applied only when opts.mzCapFeatures). 6.0 keeps portraits clearly big (65% of the page) while still enabling the margin-float wrap on all of them. Tunable.
var MZ_FEATURE_MAX_H_FLOW = 8.4;  // the flow (Before) render keeps the ORIGINAL cap, so the reference book never moves under us.
var CO_TOWER_H = 9.2; // tower full-page-height target (inches): towers always run this tall
// GAZETTE ONLY: the enclose panel wraps the tower in parchment (padding 0.13in x2) plus margin and
// borders, so the measured BAND runs 0.48in taller than the image -- 9.68in against a 9.40in composed
// body. That overflowed the page AND, because the tower-merge is gated on the real re-measure fitting
// under MZ_TOWER_MERGE_MAX_IN, it rejected the very first merge candidate and broke the loop, so the
// merge could never fire on any book. Trim the Gazette tower image by this much so the band fits.
// Magazine towers are unaffected: gzPanelCss adds no padding when !enclose (band ~9.32in, already fits).
var CO_TOWER_ENCLOSE_TRIM = 0.56;   // Gazette enclose overhead trim. With the header-band trim now in towerImgTargetH, the enclose band is 9.2-0.56-0.24+0.48 = 8.88in, under the 9.16 content area and merge ceiling.
// The tower image's target height, AFTER every reservation carved out of the page box. Towers are
// sized to fill a page, but the composed page reserves HEADER_BAND_IN at the top for the running
// head (padding-top) -- so a full 9.2in tower on a header-bearing page runs 0.24in past the content
// area and clips its own bottom AND the last line of the prose column beside it. (This is exactly
// the lone-line-clip seen on Magazine tower pages: the page's FLOW height measured fine, because a
// float's height is taken from its own top, not from the padded page top.) Subtract the band here,
// once, so both the renderer and the beside-column budget agree. Gazette's enclose trim still
// applies on top. header defaults ON (matches the composer), so a book with headers off keeps the
// full-height tower.
function towerImgTargetH(opts) {
  var _encl = (opts && opts.enclose) ? CO_TOWER_ENCLOSE_TRIM : 0;
  var _hdr  = (opts && opts.header === false) ? 0 : HEADER_BAND_IN;   // header on unless explicitly false
  return CO_TOWER_H - _encl - _hdr;
}
// Two-pass / measure cap: in the paginated path NO single image may exceed the
// printable page height, or it overflows its page container (and the measure pass
// would mis-budget it). Normal single-pass render is untouched (returns h as-is).
function _coCapH(h, opts) {
  if (!(opts && (opts.twoPass || opts.measureTag))) return h;
  var cap = ((opts.pageHeightIn || 9.7)) - 0.5;
  return (h > cap) ? cap : h;
}
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
// Gazette PROSE panels take a fixed hairline, never the picture-frame option. The border choice is
// about pictures: a 5px comic edge or a 3px gold frame drawn around a block of body text reads as a
// mistake, and it was showing up on the parchment boxes in the Preview, the Before and the After.
// Every IMAGE box still goes through cgBorder(), so the user's frame choice is untouched there.
var GZ_TEXT_BORDER = 'border:1px solid rgba(120,90,30,0.35);';   // same hairline as the 'keyline' preset
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

// ============================================================================================
// IMAGE-PANEL PRIMITIVE (roadmap #1). The SINGLE place the moment-image fit decision is made.
// Every layout's image emitter should route its inner <img> through here so cover-vs-contain,
// focal position, and the sub-pixel overscan are decided once, consistently, instead of in 23
// hand-written copies that drift and produce the crop / cut-border / letterbox bugs.
//
// This is the INNER MEDIA only (the <img> that fills a box the CALLER sizes and borders). Box
// sizing and edge treatment stay with the caller/adapter for now; later migration steps fold the
// box concerns in too. The fit contract:
//   - not crop-safe  -> object-fit:contain, exact (caller must let the box HUG the image so there
//                        is no framed letterbox void -- INV-2).
//   - crop-safe       -> object-fit:cover with focal position, OVERSCANNED 1px each side so a
//                        sub-pixel rounding gap can't reveal the box background as a hairline.
// mopts.forceContain forces contain regardless of crop_safe (rarely needed: a caller that already
// sized its box to auto-height for a non-crop-safe image emits its own <img> and skips this).
function momentImgMedia(m, mopts) {
  mopts = mopts || {};
  if (!m || !m.image) return '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  var _cropSafe = (mopts.forceContain === true) ? false : lmCropSafe(m);
  var _fit = _cropSafe
    ? ('object-fit:cover;object-position:' + cgFocalPos(lmFocal(m)) + ';width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;')
    : 'object-fit:contain;width:100%;height:100%;';
  return '<img style="' + _fit + 'display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />';
}

// Aspect-ratio box wrapper around momentImgMedia, for layouts that size images by ASPECT rather
// than a fixed pixel box (Picture Book). The box owns overflow:hidden so a crop-safe cover image
// clips to the aspect; a non-crop-safe image gets contain and the box background stays dark. This
// gives Picture Book the crop-safe + focal handling it never had (it hard-cropped everything).
// extraImgCss is appended to the media wrapper (e.g. a shadow); boxCss to the outer box (border).
function momentImgAspectBox(m, ratio, boxCss, extraImgCss) {
  if (!m || !m.image) return '<div style="width:100%;aspect-ratio:' + ratio + ';background:#1a0f06;' + (boxCss || '') + '"></div>';
  return '<div style="width:100%;aspect-ratio:' + ratio + ';overflow:hidden;line-height:0;position:relative;' + (boxCss || '') + (extraImgCss || '') + '">' +
    momentImgMedia(m, {}) + '</div>';
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
  // Now a thin wrapper over the shared primitive (roadmap #1). Output is byte-identical to the
  // former inline version -- same cover/contain/focal/overscan decision, just centralized.
  return momentImgMedia(m, {});
}

// A floated image with the panel's full narrative flowing around and below it.
// Gazette enclosure helpers. When opts.enclose is set (Gazette), a beat is wrapped
// as a parchment panel (border + parchment bg + padding); box-decoration-break:clone
// gives each fragment a clean closed border when a tall panel crosses a page break.
// No-op for Magazine (enclose falsy) -> those code paths stay byte-identical.
function gzPanelCss(opts) {
  return (opts && opts.enclose) ? (GZ_TEXT_BORDER + 'background:#fbf3cf;padding:0.13in 0.15in;-webkit-box-decoration-break:clone;box-decoration-break:clone;') : '';
}
function gzNarrBox(narrHtml, opts) {
  if (!narrHtml) return '';
  if (!(opts && opts.enclose)) return narrHtml;
  return '<div style="' + GZ_TEXT_BORDER + 'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;margin-bottom:0.10in;-webkit-box-decoration-break:clone;box-decoration-break:clone;">' + narrHtml + '</div>';
}

// Gazette shared builder: an image floated INSIDE a parchment panel at an explicit
// size, narrative wrapping beside/below it. Used to pull wide & feature images into
// their text panel (shrunk just enough to leave a wrap column).
// Gazette image box. Crop-safe images fill a fixed w x h box (cover). Images that
// are NOT crop-safe would otherwise be letterboxed inside a fixed box sized from the
// stored aspect -- leaving a thin parchment strip when the stored aspect is slightly
// off (the "border bigger than the picture"). For those, the frame HUGS the image's
// true height (width fixed, height:auto) so the border can never exceed the picture.
function gzImgBox(m, opts, fl, w, h) {
  // A non-crop-safe image renders object-fit:contain, which LETTERBOXES inside a fixed-height box.
  // The box background is transparent, so those bands showed the page through and the border stood
  // off the picture ("the border should come down to meet the picture's edge"). Letting the box hug
  // the image removes the bands entirely. This was already the Gazette behaviour; it now applies in
  // every layout, since the letterbox gap was never Gazette-specific.
  if (!lmCropSafe(m) && m.image) {
    // Full uncropped image (height:auto). min-height reserves the computed height so the box
    // does NOT collapse when image loads are aborted during the magazine measure pass -- without
    // this the band measures short and the deterministic composer clips its overflow. When the
    // image loads (compose/flow render) it renders at its natural height (>= the floor).
    return '<div style="' + fl + cgBorder(opts) + 'width:' + w.toFixed(2) + 'in;min-height:' + h.toFixed(2) + 'in;position:relative;background:transparent;line-height:0;">' +
      '<img style="width:100%;height:auto;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />' + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  }
  return '<div style="' + fl + cgBorder(opts) + 'width:' + w.toFixed(2) + 'in;height:' + h.toFixed(2) +
    'in;position:relative;background:transparent;line-height:0;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
}
function gzFloatPanel(m, opts, narrHtml, iw, ih, sideLeft) {
  var fl = sideLeft ? 'float:left;margin:0.02in 0.22in 0.10in 0;' : 'float:right;margin:0.02in 0 0.10in 0.22in;';
  var box = gzImgBox(m, opts, fl, iw, ih);
  return '<div style="display:flow-root;margin-bottom:0.10in;' + gzPanelCss(opts) + '">' + box + (narrHtml || '') + '</div>';
}
function cgFloatDims(m, opts, small, mul) {
  mul = mul || 1;
  var asp = Math.max(0.3, momentAspect(m));
  var imgH, capW;
  if (opts && opts.enclose) {
    // Gazette: pictures are the show -> noticeably bigger floated images.
    imgH = small ? ((asp < 0.85) ? 3.6 : 2.7) : ((asp < 0.85) ? 4.6 : 3.4);
    capW = small ? 3.3 : 4.2;
  } else {
    imgH = small ? ((asp < 0.85) ? 2.5 : 2.0) : ((asp < 0.85) ? 3.5 : 2.7);   // minimized tier raised (was 2.2/1.7) so low-prominence pics stay reasonable
    capW = small ? 2.5 : 3.3;
  }
  imgH *= MZ_SHRINK; capW *= MZ_SHRINK;   // base density shrink (grow-to-fill can still enlarge from here)
  if (mul !== 1) { imgH *= mul; capW = Math.min(6.4, capW * mul); }   // size multiplier: >1 grow-to-fill (enlarge toward the column), <1 pull-up shrink (fit a prior page's white)
  var imgW = imgH * asp;
  if (imgW > capW) { imgW = capW; imgH = imgW / asp; }
  // Legibility floor: a minimized square (or any small float) was landing tiny because the
  // small-tier height + density shrink + width cap stack up. Ensure the larger dimension of a
  // small float is at least MZ_FLOAT_MIN in -- bumps squares most (both dims small), leaves
  // landscapes (wide enough) and portraits (already tall enough) essentially untouched.
  if (small && Math.max(imgW, imgH) < MZ_FLOAT_MIN) { var _fl = MZ_FLOAT_MIN / Math.max(imgW, imgH); imgW *= _fl; imgH *= _fl; }
  // Keep a legible text column beside the float: cap the image width so wrapped text is never crushed
  // into a sliver (worst with grown landscapes). Wides (asp >= 1.5) render full-width elsewhere.
  var _maxW = CG_W - MZ_MIN_TEXT_COL;
  if (imgW > _maxW) { imgW = _maxW; imgH = imgW / asp; }
  return { imgW: imgW, imgH: imgH, asp: asp };
}
// Align the first line of a WRAPPED narrative with the TOP of the picture it sits beside.
// A narrative <p> carries margin:0.15in 0, but a floated image box starts at 0 - 0.04in, so the
// text sat 0.11 - 0.15in lower than the picture. Invisible with no border; obvious against a hard
// comic/bronze edge, and it differed per band type (hence the "sometimes" reports). Strip ONLY the
// first paragraph's TOP margin -- its bottom spacing and every later paragraph are untouched -- so
// picture and prose share one origin AND the reclaimed 0.15in goes back to the page.
// Only used for side-by-side (float/tower) layouts; text BELOW an image keeps its top margin.
function cgAlignFirstPara(html) {
  if (!html) return html;
  return html.replace('margin:0.15in 0;', 'margin:0 0 0.15in;');
}
function cgFlowFloat(m, opts, narrHtml, sideLeft, small, mul) {
  var d = cgFloatDims(m, opts, small, mul);
  var fl = sideLeft ? 'float:left;margin:0.04in 0.20in 0.10in 0;'
                    : 'float:right;margin:0.04in 0 0.10in 0.20in;';
  var box = gzImgBox(m, opts, fl, d.imgW, d.imgH);
  return '<div style="display:flow-root;margin-bottom:0.10in;' + gzPanelCss(opts) + '">' + box + cgAlignFirstPara(narrHtml || '') + '</div>';
}

// shrink: 0..0.20, trims the tower image as an absolute LAST resort when absorbing a stranded page.
// wrapBelow: drop the beside-column's flow-root so the prose wraps alongside the image AND continues
// full width beneath it. That is a large capacity gain at NO cost to the picture, which is why it is
// tried before any shrinking. Only safe when nothing was absorbed into the column (besideHtml), since
// those panels are meant to stack beside the tower, not run under it.
function cgFlowTower(m, opts, narrHtml, besideHtml, sideLeft, shrink, wrapBelow) {
  // Tower: full-page-height image flush to a margin. Its narrative PLUS any absorbed small
  // panels (besideHtml) stack in a block that sits BESIDE the tower -- a new block-formatting
  // context is shortened to fit alongside the float -- filling the tall column instead of
  // leaving white space next to the thin tower.
  var ta = momentAspect(m);
  var _shr = Math.max(0, Math.min(0.20, shrink || 0));   // hard cap: never trim a tower by more than 20%
  var imgH = towerImgTargetH(opts) * (1 - _shr);   // see towerImgTargetH: page box minus header band (and enclose trim)
  var imgW = imgH * ta;
  // CLAMP: a tower sizes by HEIGHT and derives width from the aspect, so a portrait-ish moment can
  // come out wider than the column (9.2in x 0.75 = 6.9in against a 6.8in column). The float then
  // takes the full width, the narrative cannot sit beside it and wraps BELOW, and the band runs off
  // the page -- clipping the prose mid-line in the printed book. Keep the image narrow enough to
  // leave a legible text column, trading height for width exactly as the Gazette float clamp does.
  var _maxTW = CG_W - MZ_MIN_TEXT_COL;
  if (imgW > _maxTW) { imgW = _maxTW; imgH = imgW / Math.max(0.3, ta); }
  var fl = sideLeft ? 'float:left;margin:0 0.20in 0.10in 0;'
                    : 'float:right;margin:0 0 0.10in 0.20in;';
  // Same letterbox fix as gzImgBox: a contain image would leave transparent bands inside the border.
  var box = (!lmCropSafe(m) && m.image)
    // NO min-height here: the image is sized by WIDTH with height:auto, so if its real aspect makes
    // it shorter than the reserved height, a min-height would hold the border open and leave a band
    // of dead space between the picture and the frame. Letting the box hug the image keeps the
    // frame tight to the art; the packer's estimate stays on the high side, which is the safe way
    // to be wrong (a slightly short page, never a clipped one).
    ? ('<div style="' + fl + cgBorder(opts) + 'width:' + imgW.toFixed(2) +
       'in;position:relative;background:transparent;line-height:0;">' +
       // Tower box is WIDTH-driven with no fixed height, so the image must use height:auto (the box
       // grows to the image). The primitive's contain path uses height:100%, which behaves
       // differently in an auto-height box -- so the tower keeps its own emit here. (Its cover
       // branch below DOES go through the primitive via cgImgMedia.)
       '<img style="width:100%;height:auto;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />' +
       picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>')
    : ('<div style="' + fl + cgBorder(opts) + 'width:' + imgW.toFixed(2) + 'in;height:' + imgH.toFixed(2) +
       'in;position:relative;background:transparent;line-height:0;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>');
  var col = (wrapBelow && !besideHtml)
    ? cgAlignFirstPara(narrHtml || '')                                      // wraps beside the float, then continues below it
    : '<div style="display:flow-root;">' + cgAlignFirstPara(narrHtml || '') + (besideHtml || '') + '</div>';
  // Keep the tower + its beside-column narrative as ONE unbreakable unit. Without this the
  // short narrative fills the scrap at a page bottom while the 9.2in tower bumps to the next
  // page, stranding the text and leaving the tower's side column empty. (Rollback: remove
  // `break-inside:avoid;page-break-inside:avoid;` from the wrapper below.)
  return '<div style="display:flow-root;margin-bottom:0.10in;break-inside:avoid;page-break-inside:avoid;' + gzPanelCss(opts) + '">' + box + col + '</div>';
}
// Rough height of prose set in a narrow column, for band-build-time budgeting only (no measurement
// is available this early). About 11 characters per inch at the body size, 0.19in per line.
function mzColTextH(html, colW) {
  var txt = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!txt) return 0;
  var perLine = Math.max(8, colW * 11);
  return Math.ceil(txt.length / perLine) * 0.19;
}
function cgBesidePanel(m, opts, narrHtml) {
  // A small panel rendered to STACK in the column beside a full-height tower (NOT floated).
  var box = '<div style="' + cgBorder(opts) + 'width:100%;aspect-ratio:' + dispRatioCSS(m) + ';position:relative;background:transparent;line-height:0;margin-bottom:0.06in;">' + cgImgMedia(m, opts) + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return '<div style="margin-bottom:0.12in;">' + box + gzNarrBox(narrHtml, opts) + '</div>';
}

// A wide/panoramic image breaks the column full width; prose flows after it.
function cgFlowWide(m, opts, narrHtml, sideLeft, mul) {
  mul = mul || 1;
  if (opts && opts.enclose) {
    // Gazette: wide image floated INSIDE its parchment panel (shrunk a little so the
    // narrative wraps beside it) -- the picture is the show, just enclosed.
    var aspW = Math.max(0.3, momentAspect(m));
    var iwW = 4.4 * mul, ihW = iwW / aspW;
    // CLAMP: grow-to-fill (mul>1) must never push the floated image past the column, or it
    // bleeds over the margin. Cap width to CG_W - MZ_MIN_TEXT_COL and recompute height to keep aspect.
    var _maxWe = CG_W - MZ_MIN_TEXT_COL;
    if (iwW > _maxWe) { iwW = _maxWe; ihW = iwW / aspW; }
    return gzFloatPanel(m, opts, narrHtml, iwW, ihW, sideLeft);
  }
  // Full-width wide image at its NATURAL height -- no fixed-height box, no contain,
  // no #000 fill -- so the frame wraps the art exactly and a black void is impossible
  // even when the stored aspect and the real image disagree.
  var aspW = Math.max(0.3, momentAspect(m));
  var media = m.image
    ? '<img style="width:100%;aspect-ratio:' + aspW.toFixed(4) + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + shapeRatioCSS(normShape(m)) + ';background:#1a0f06;"></div>';
  var _ww = (mul < 0.999) ? (mul * 100).toFixed(1) + '%' : '100%';
  var _wc = (mul < 0.999) ? 'margin-left:auto;margin-right:auto;' : '';
  var box = '<div style="' + cgBorder(opts) + 'width:' + _ww + ';' + _wc + 'position:relative;line-height:0;' +
    'margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
    media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return box + gzNarrBox(narrHtml, opts);
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
  if (opts && opts.enclose) return '<div style="display:flow-root;margin-bottom:0.10in;' + gzPanelCss(opts) + '">' + row + (narrHtml || '') + '</div>';
  return row + gzNarrBox(narrHtml, opts);
}

// A featured (peak-prominence) image. A wide shot fills the width at half-page
// height (cover-cropped via focal); anything else blows up toward full page.
// Feature image height at mul=1 (for the pull-up image-dominance test).
function cgFeatureImgH(m, opts) {
  var asp = Math.max(0.3, momentAspect(m));
  if (opts && opts.enclose) {
    if (asp >= 1.5) return 4.8 / asp;
    var ihE = Math.min(5.0, 3.8 / asp); if (ihE * asp > 4.4) ihE = 4.4 / asp; return ihE;
  }
  if (asp >= 1.5) return CG_W / asp;
  return Math.min((opts && opts.mzCapFeatures) ? MZ_FEATURE_MAX_H : MZ_FEATURE_MAX_H_FLOW, CG_W / asp);
}
function cgFlowFeature(m, opts, narrHtml, sideLeft, mul) {
  mul = mul || 1;
  var asp = Math.max(0.3, momentAspect(m));
  if (opts && opts.enclose) {
    // Gazette: feature (peak) image floated inside its panel, kept large; text wraps.
    var iwF, ihF;
    if (asp >= 1.5) { iwF = 4.8; ihF = iwF / asp; }
    else { ihF = Math.min(5.0, 3.8 / asp); iwF = ihF * asp; if (iwF > 4.4) { iwF = 4.4; ihF = iwF / asp; } }
    iwF *= mul; ihF *= mul;
    // CLAMP: same as cgFlowWide -- a grown feature image must stay inside the column, never bleed.
    var _maxWe = CG_W - MZ_MIN_TEXT_COL;
    if (iwF > _maxWe) { iwF = _maxWe; ihF = iwF / asp; }
    return gzFloatPanel(m, opts, narrHtml, iwF, ihF, sideLeft);
  }
  if (asp >= 1.5) {
    // Wide feature: full-width at its NATURAL height -- container = image size, so
    // no fixed box, no contain, no #000 void (same fix as cgFlowWide).
    var media = m.image
      ? '<img style="width:100%;aspect-ratio:' + asp.toFixed(4) + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
      : '<div style="width:100%;aspect-ratio:' + shapeRatioCSS(normShape(m)) + ';background:#1a0f06;"></div>';
    var _fw = (mul < 0.999) ? (mul * 100).toFixed(1) + '%' : '100%';
    var _fc = (mul < 0.999) ? 'margin-left:auto;margin-right:auto;' : '';
    var wbox = '<div style="' + cgBorder(opts) + 'width:' + _fw + ';' + _fc + 'position:relative;line-height:0;' +
      'margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
      media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
    return wbox + gzNarrBox(narrHtml, opts);
  }
  // Non-wide feature blows up toward full page; box matches the image aspect and
  // fills via focal cover, so there is no void either.
  var H = Math.min((opts && opts.mzCapFeatures) ? MZ_FEATURE_MAX_H : MZ_FEATURE_MAX_H_FLOW, CG_W / asp) * mul;
  var W = Math.min(CG_W, H * asp);
  var ctr = (W < CG_W - 0.01) ? 'margin-left:auto;margin-right:auto;' : '';
  var img = m.image
    ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  // OPTIMIZE: a shrunk portrait that leaves room beside it floats to a margin so the narrative wraps
  // alongside (fills the side-white the centered version wastes, and shortens the band). Split infra
  // already handles floated images. sideLeft alternates L/R per panel. Flow (Before) never sets the flag.
  if (opts && opts.mzFloatShrunk && W <= CG_W - 2.0) {
    var _fside = sideLeft ? 'left' : 'right';
    var _fmar = sideLeft ? '0 0.26in 0.06in 0' : '0 0 0.06in 0.26in';
    var fbox = '<div style="' + cgBorder(opts) + 'float:' + _fside + ';margin:' + _fmar + ';width:' + W.toFixed(2) + 'in;height:' + H.toFixed(2) +
      'in;position:relative;background:transparent;line-height:0;page-break-inside:avoid;break-inside:avoid;">' +
      img + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
    return '<div style="display:flow-root;margin-bottom:0.10in;">' + fbox + gzNarrBox(cgAlignFirstPara(narrHtml), opts) + '</div>';
  }
  var box = '<div style="' + cgBorder(opts) + 'width:' + W.toFixed(2) + 'in;height:' + H.toFixed(2) + 'in;' + ctr +
    'position:relative;background:transparent;line-height:0;margin-bottom:0.10in;page-break-inside:avoid;break-inside:avoid;">' +
    img + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
  return box + gzNarrBox(narrHtml, opts);
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
  if (buf.trim()) {
    var _tail = buf.trim();
    // Don't let a tiny trailing sentence become its own panel cell -- a runt chunk lands as a
    // lone cell that strands on a near-blank page. Merge a short tail into the previous chunk;
    // it only stands alone when there is no previous chunk. (Rollback: restore the single line
    // `if (buf.trim()) chunks.push(buf.trim());`.)
    if (chunks.length && _tail.length < 140) chunks[chunks.length - 1] += ' ' + _tail;
    else chunks.push(_tail);
  }
  return chunks;
}
// Split narrative into `cols` roughly-equal parts, PRESERVING reading order
// (col 1 = first sentences, col 2 = next, ...). Uses the existing sentence
// chunker; falls back to a word split if there aren't enough sentence chunks.
function cgBalanceCols(text, cols) {
  var chunks = cgSplitNarr(text);
  if (chunks.length < cols) {
    var words = String(text || '').split(/\s+/).filter(function(w){ return w.length; });
    chunks = [];
    var per = Math.max(1, Math.ceil(words.length / cols));
    for (var w = 0; w < words.length; w += per) chunks.push(words.slice(w, w + per).join(' '));
  }
  var total = 0;
  for (var c = 0; c < chunks.length; c++) total += chunks[c].length;
  var target = total / cols;
  var buckets = [], cur = '', curLen = 0, made = 0;
  for (var i = 0; i < chunks.length; i++) {
    cur += (cur ? ' ' : '') + chunks[i];
    curLen += chunks[i].length;
    var remainingChunks = chunks.length - 1 - i;
    var remainingCols = cols - made - 1;
    if (made < cols - 1 && curLen >= target && remainingChunks >= remainingCols) {
      buckets.push(cur); cur = ''; curLen = 0; made++;
    }
  }
  if (cur) buckets.push(cur);
  return buckets;
}
// Full-width narrative under the comic grid. Long narrative becomes a ROW of
// SEPARATE bordered parchment boxes (2-3, renderer-chosen by length), each its
// own comic panel, balanced by length and in reading order -- compact under a
// full-width image with far less stranded whitespace. Short narrative stays a
// single full-width box, unchanged.
function cgFullWidthNarr(text, opts) {
  var n = (text || '').length;
  var cols = (n >= 640) ? 3 : ((n >= 300) ? 2 : 1);
  var oneBox = function () {
    return '<div style="' + GZ_TEXT_BORDER + 'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;min-height:1.2in;align-self:start;break-inside:avoid;page-break-inside:avoid;grid-column:span 2;">' + buildNarrativeHTML(text, false) + '</div>';
  };
  if (cols <= 1) return oneBox();
  var parts = cgBalanceCols(text, cols);
  if (parts.length <= 1) return oneBox();
  var boxes = parts.map(function (pt) {
    return '<div style="' + GZ_TEXT_BORDER + 'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;flex:1 1 0;min-width:0;">' + buildNarrativeHTML(pt, false) + '</div>';
  }).join('');
  return '<div style="grid-column:span 2;display:flex;gap:' + CG_GAP + 'in;align-items:stretch;break-inside:avoid;page-break-inside:avoid;">' + boxes + '</div>';
}
// Shared parchment narration box used by BOTH the exact-measure pass and the
// one-engine two-pass renderer, so a measured box height EQUALS its rendered
// height (this is what makes spill impossible). Width is set by the parent cell;
// the box fills it. No min-height / flex / grid here -- that is layout context.
function cgNarrBox(text, opts) {
  return '<div style="' + GZ_TEXT_BORDER + 'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;break-inside:avoid;page-break-inside:avoid;">' + buildNarrativeHTML(text, false) + '</div>';
}

// Column widths the renderer can choose from (inches): 1-col full, 2-col half,
// 3-col third. Beside-a-small-image narration also uses the half (2-col) width.
function cgColWidths() {
  return [CG_W, (CG_W - CG_GAP) / 2, (CG_W - 2 * CG_GAP) / 3];
}

// Exact-measure scaffold: render EVERY narration chunk of EVERY moment at EACH
// candidate column width, individually tagged, so measureDocument returns the
// real height of each chunk at each width. The packer then knows exactly how
// tall any narration will be in any column layout -> no estimation, no spill.
function buildChunkMeasureBody(moments, sections, opts) {
  var widths = cgColWidths();
  var out = '';
  for (var i = 0; i < moments.length; i++) {
    var sec = (sections || []).find(function (s) { return s.panel_index === i; }) || {};
    var text = [sec.before, sec.after].filter(Boolean).join(' ');
    var chunks = cgSplitNarr(text);
    for (var c = 0; c < chunks.length; c++) {
      for (var wi = 0; wi < widths.length; wi++) {
        var box = cgNarrBox(chunks[c], opts);
        var tagged = box.replace('<div ', '<div data-mblk="m' + i + '_c' + c + '_w' + wi + '" data-mmoment="' + i + '" data-mchunk="' + c + '" data-mwidth="' + wi + '" data-mchars="' + chunks[c].length + '" ');
        out += '<div style="width:' + widths[wi].toFixed(3) + 'in;margin-bottom:0.1in;">' + tagged + '</div>';
      }
    }
  }
  return out;
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

  var _MT = !!(opts && opts.measureTag);
  function _mKindH(h) { if (h.indexOf('<img ') !== -1) return 'image'; if (h.indexOf('#fbf3cf') !== -1) return 'narr'; return 'cell'; }
  function _itag(h, kind, mom, split) { if (!_MT) return h; return h.replace('<div ', '<div data-mblk="' + mom + kind.charAt(0) + '" data-mkind="' + kind + '" data-mmoment="' + mom + '"' + (split ? ' data-msplit="1"' : '') + ' '); }
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
      var twText = '<div style="' + GZ_TEXT_BORDER + 'background:#fbf3cf;flex:1 1 auto;min-width:0;padding:0.16in 0.18in;line-height:1.4;overflow:hidden;">' + twNarr + '</div>';
      var twLeft = (towerN % 2 === 0); towerN += 1;
      cells.push({ kind: 'block', slots: 2, moment: i, mkind: 'image', html: '<div style="display:flex;gap:' + CG_GAP + 'in;align-items:stretch;break-inside:avoid;page-break-inside:avoid;margin-bottom:' + CG_GAP + 'in;">' + (twLeft ? (twBox + twText) : (twText + twBox)) + '</div>' });
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
        var _fH = _coCapH(CG_W / _fAsp, opts);
        _fImgBox = '<div style="' + cgBorder(opts) + 'width:100%;height:' + _fH.toFixed(2) + 'in;position:relative;background:transparent;line-height:0;break-inside:avoid;page-break-inside:avoid;">' + _fMedia + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
      } else {
        var _fH2 = _coCapH(Math.min(8.4, CG_W / _fAsp), opts);
        var _fW2 = Math.min(CG_W, _fH2 * _fAsp);
        var _fCtr = (_fW2 < CG_W - 0.01) ? 'margin-left:auto;margin-right:auto;' : '';
        _fImgBox = '<div style="' + cgBorder(opts) + 'width:' + _fW2.toFixed(2) + 'in;height:' + _fH2.toFixed(2) + 'in;' + _fCtr + 'position:relative;background:transparent;line-height:0;break-inside:avoid;page-break-inside:avoid;">' + _fMedia + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
      }
      var _fParts = [];
      if (sec.before) _fParts = _fParts.concat(cgSplitNarr(sec.before));
      if (sec.after) _fParts = _fParts.concat(cgSplitNarr(sec.after));
      var _fTxt = _fParts.join(' ');
      // Keep the full-width image and its narrative columns TOGETHER as ONE
      // unbreakable unit. Chromium's grid pagination will otherwise bump the
      // narrative cell to the next page, stranding the picture alone above a
      // big gap. Wrapping both in a single break-inside:avoid cell forbids that
      // break; dense flow can still backfill any gap left when the unit moves.
      var _fNarr = _fTxt ? cgFullWidthNarr(_fTxt, opts) : '';
      var _fImgT = _itag(_fImgBox, 'image', i, false);
      if (_fNarr) _fNarr = _itag(_fNarr, 'narr', i, true);
      var _fNarrHtml = _fNarr ? ('<div style="margin-top:' + CG_GAP + 'in;">' + _fNarr + '</div>') : '';
      cells.push({ kind: 'block', innerTagged: true, slots: 2, html: '<div style="break-inside:avoid;page-break-inside:avoid;margin-bottom:' + CG_GAP + 'in;">' + _fImgT + _fNarrHtml + '</div>' });
      continue;
    }
    var ta = momentAspect(m);
    var asp = Math.max(0.3, ta);
    var tall = isPortrait(m);
    var wide = (asp >= 1.5);
    var colW = (CG_W - CG_GAP) / 2;
    var span = tall ? 'tall' : (wide ? 'wide' : '');
    var imgH = wide ? (CG_W / asp) : Math.min(7.0, colW / asp);
    imgH = _coCapH(imgH, opts);
    // For tall/tower, hug the image's true width at this height so a 1:4 tower isn't cropped.
    var boxW = tall ? Math.min(colW, imgH * ta) : null;
    if (_tier === 'min') { tall = false; wide = false; span = ''; imgH = Math.min(2.6, colW / asp); boxW = null; }
    if (wide) {
      // Full-width image: bind it with its full-width narrative as ONE standalone
      // block (OUTSIDE the grid) so Chromium keeps them on the same page instead of
      // stranding the picture above a blank gap. Grid items ignore break-inside under
      // print fragmentation; block-level elements honor it. Same as the splash branch.
      var _wParts = [];
      if (sec.before) _wParts = _wParts.concat(cgSplitNarr(sec.before));
      if (sec.after) _wParts = _wParts.concat(cgSplitNarr(sec.after));
      var _wTxt = _wParts.join(' ');
      var _wNarr = _wTxt ? cgFullWidthNarr(_wTxt, opts) : '';
      var _wImgT = _itag(comicArt(m, 'wide', imgH, null), 'image', i, false);
      if (_wNarr) _wNarr = _itag(_wNarr, 'narr', i, true);
      var _wNarrHtml = _wNarr ? ('<div style="margin-top:' + CG_GAP + 'in;">' + _wNarr + '</div>') : '';
      cells.push({ kind: 'block', innerTagged: true, slots: 2, html: '<div style="break-inside:avoid;page-break-inside:avoid;margin-bottom:' + CG_GAP + 'in;">' + _wImgT + _wNarrHtml + '</div>' });
      continue;
    }
    cells.push({ slots: tall ? 2 : 1, moment: i, mkind: 'image', html: comicArt(m, span, imgH, boxW) });
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
      cells.push({ slots: besideRows, moment: i, mkind: 'narr', split: true, html: '<div style="' + GZ_TEXT_BORDER +
        'background:#fbf3cf;padding:0.13in 0.15in;line-height:1.4;min-height:' + imgH.toFixed(2) + 'in;align-self:start;break-inside:avoid;page-break-inside:avoid;' + bspan + '">' + buildNarrativeHTML(besideTxt, false) + '</div>' });
    }
    if (restTxt) {
      cells.push({ slots: 2, moment: i, mkind: 'narr', split: true, html: cgFullWidthNarr(restTxt, opts) });
    }
  }

  // Assemble in segments: runs of normal cells form a 2-column dense grid; any
  // full-width 'block' cell (tower, splash, wide image + its narrative) is emitted
  // STANDALONE between grids. Grid items ignore break-inside:avoid under Chromium's
  // print fragmentation, but block-level elements honor it -- so pulling full-width
  // units out of the grid is what actually keeps each picture with its text.
  var _segOpen = '<div style="display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:auto;gap:' + CG_GAP + 'in;grid-auto-flow:row dense;align-items:start;margin-bottom:' + CG_GAP + 'in;">';
  // Measurement tagging (opts.measureTag): stamp data-mblk/mkind/mmoment/msplit
  // onto each measurable block so the text-only pass can read real geometry and
  // the packer can group rows + know what may split. Full-width units are tagged
  // INNER (image vs narration) at build time. NORMAL output is byte-identical.
  function _cellTag(cell, seq) {
    if (!_MT || cell.innerTagged) return cell.html;
    var kind = cell.mkind || _mKindH(cell.html);
    var attrs = ' data-mblk="' + seq + '" data-mkind="' + kind + '" data-mmoment="' + (cell.moment == null ? '' : cell.moment) + '"' + (cell.split ? ' data-msplit="1"' : '');
    return cell.html.replace('<div ', '<div' + attrs + ' ');
  }
  var cellHtml = '', _gridBuf = '', _seq = 0;
  function _flushGrid() { if (_gridBuf) { cellHtml += _segOpen + _gridBuf + '</div>'; _gridBuf = ''; } }
  for (var _ci = 0; _ci < cells.length; _ci++) {
    var _h = _cellTag(cells[_ci], _seq++);
    if (cells[_ci].kind === 'block') { _flushGrid(); cellHtml += _h; }
    else _gridBuf += _h;
  }
  _flushGrid();
  html += cellHtml;

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
// Returns the raw text if it is flowing prose (line-splittable), or null for script-formatted
// narrative (NAME: "..." speaker lines joined by single newlines) whose <br> structure would
// break char-offset slicing. Prose may still contain blank-line paragraph breaks.
function mzProseText(t) {
  if (!t) return null;
  if (t.indexOf('\n') < 0) return t;
  return (t.split('\n\n').join(' ').indexOf('\n') < 0) ? t : null;
}
// A float band that carries a regrow(mul) closure so the deterministic packer can re-render
// the SAME floated image larger to fill leftover page white (grow-to-fill). The closure
// captures this panel's moment/side/small so it re-renders identically apart from size.
// CUT-POINT SANITIZER. Every magazine/gazette text cut is passed through this before it is used.
// A cut offset is the index where the TAIL begins, so a good cut sits on a word boundary with a
// real word after it. Two rules, both learned from real books: never cut inside a word, and never
// cut between a word and the punctuation that closes it -- that is what stranded a lone full stop
// in its own parchment box on a Gazette page. The offsets cannot be trusted to be boundaries: for
// a float band the `after` paragraph is usually unmeasured, so its line starts are SYNTHESIZED
// arithmetically and snapWord hands back the raw offset near the end of the text.
var MZ_CUT_PUNCT = '.,;:!?)]}\u2019\u201d';   // CLOSING punctuation only -- a tail may legitimately open on a quote or a dash, never on a comma or a full stop
function mzSafeCut(text, idx) {
  if (!text || idx == null) return idx;
  var n = text.length;
  if (idx <= 0 || idx >= n) return idx;
  var i = idx;
  // A cut already sitting on whitespace is a clean boundary (the sentence snap below produces
  // exactly that) -- open the tail at the next word rather than retreating into the word before
  // the gap, which would undo the snap. Anything else is mid-word: retreat to this word's start.
  if (/\s/.test(text.charAt(i))) { while (i < n && /\s/.test(text.charAt(i))) i++; }
  else { while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--; }
  var guard = 0;
  while (i > 0 && guard++ < 200) {
    var ch = text.charAt(i);
    // Accept once the tail opens on a real word AND still contains one. Reject a tail that opens on
    // a stranded closer, or that is nothing but punctuation and space (the lone-full-stop case).
    if (MZ_CUT_PUNCT.indexOf(ch) < 0 && /[A-Za-z0-9]/.test(text.slice(i))) return i;
    i--;                                                   // step off onto the gap
    while (i > 0 && /\s/.test(text.charAt(i))) i--;         // consume the gap
    while (i > 0 && !/\s/.test(text.charAt(i - 1))) i--;    // land on the previous word's start
  }
  return i;
}
// Pull a cut back to the nearest sentence end so a slice finishes a whole sentence. Applies only
// PAST `mbound` -- the second paragraph, whose line positions are synthesized estimates. Line starts
// before mbound are real browser measurements, and cutting mid-sentence there is ordinary
// typography. This used to be gated on `cEnd < stext.length - 2`, which excluded the one case that
// needed it most: a cut one character from the end of the text.
function mzSnapSentence(stext, mbound, lo, cEnd) {
  if (stext == null || mbound == null || !(cEnd > mbound + 8)) return cEnd;
  for (var d = 2; d < 160 && (cEnd - d) > lo + 45; d++) {
    var ch = stext.charAt(cEnd - d);
    if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(stext.charAt(cEnd - d + 1))) {
      var s = cEnd - d + 1;
      return (s > lo + 45 && s < cEnd) ? s : cEnd;
    }
  }
  return cEnd;
}
// Render text.slice(cs,ce) as narrative <p>(s), preserving the before|after paragraph break at
// `bound` (a char offset into the concatenated panel text) and dropping the first-line indent when
// the slice opens mid-paragraph (a continuation). bound==null => a single-paragraph panel.
function renderMzSlice(text, bound, cs, ce, opts) {
  var segs = [];
  if (bound != null && bound > cs && bound < ce) {
    segs.push({ s: cs, e: bound, cont: cs > 0 });          // (tail of) the FIRST paragraph
    segs.push({ s: bound, e: ce, cont: false });           // SECOND paragraph opens fresh
  } else {
    segs.push({ s: cs, e: ce, cont: (cs > 0 && cs !== bound) });   // one paragraph; continuation unless it opens exactly at the boundary
  }
  var out = '';
  for (var si = 0; si < segs.length; si++) {
    var g = segs[si];
    var h = coNarr(text.slice(g.s, g.e), opts, false);
    if (g.cont) h = h.replace('text-indent:0.3in', 'text-indent:0');
    out += h;
  }
  return out;
}
function mzFloatBand(m, opts, narr, sideLeft, small, mtext, mbound) {
  function build(mul) {
    var band = { kind: 'float', html: cgFlowFloat(m, opts, narr, sideLeft, small, mul),
      regrow: function (mm) { return cgFlowFloat(m, opts, narr, sideLeft, small, mm); },
      remeta: function (mm) { return build(mm); } };   // re-render at a new size AND carry the split metadata (sImgH / renderHead track that size)
    band.sImgH = cgFloatDims(m, opts, small, mul).imgH;   // image height at THIS size: split cut point + pull-up / gap-fit tests
    band.sTitle = (m && m.title) || ''; band.sAsp = Math.round(momentAspect(m) * 100) / 100;
    if (mtext) {
      // Splittable panel: image + one or two (before/after) prose paragraphs. The packer may cut the
      // text BELOW the image (sImgH) and continue it full-width on the next page; renderHead re-draws
      // the panel with the text truncated to the head slice at this image size.
      band.stext = mtext; band.mbound = (mbound != null ? mbound : null); band.sOpts = opts;
      band.sIntro = false; band.sDrop = false; band.simg = true;
      band.renderHead = function (cStart, cEnd) { return cgFlowFloat(m, opts, renderMzSlice(mtext, band.mbound, cStart, cEnd, opts), sideLeft, small, mul); };
    }
    return band;
  }
  return build(1);
}
// Non-enclose WIDE: full-width image with the narrative entirely BELOW it -> splittable like a
// float, but any narrative line is a valid cut (all lines sit under the picture, so sImgH=0).
function mzWideBand(m, opts, narr, sideLeft, mtext, mbound) {
  function build(mul) {
    var band = { kind: 'wide', html: cgFlowWide(m, opts, narr, sideLeft, mul),
      regrow: function (mm) { return cgFlowWide(m, opts, narr, sideLeft, mm); },
      remeta: function (mm) { return build(mm); } };
    var _aspW = Math.max(0.3, momentAspect(m));
    band.sImgH = mul * ((opts && opts.enclose) ? (4.4 / _aspW) : (CG_W / _aspW));   // full-width image height (narrative sits below): split cut point + pull-up / gap-fit
    band.sTitle = (m && m.title) || ''; band.sAsp = Math.round(_aspW * 100) / 100;
    if (mtext && (_mzFlowSim || !(opts && opts.enclose))) {
      band.stext = mtext; band.mbound = (mbound != null ? mbound : null); band.sOpts = opts;
      band.sIntro = false; band.sDrop = false; band.simg = true;
      band.renderHead = function (cStart, cEnd) { return cgFlowWide(m, opts, renderMzSlice(mtext, band.mbound, cStart, cEnd, opts), sideLeft, mul); };
    }
    return band;
  }
  return build(1);
}
// A feature (Maximize) band: big image + narrative below. The image is kept big -- but the NARRATIVE
// can split across a page break (image + text that fits on this page, the rest flows on), exactly like
// the flow render does. That fills white WITHOUT shrinking the picture. Separately, regrow lets the
// GENTLE pull-up nudge an image-dominated feature up when it nearly fits (a small shrink, not a hard one).
function mzFeatureBand(m, opts, narr, sideLeft, mtext, mbound) {
  function build(mul) {
    var band = { kind: 'feature', html: cgFlowFeature(m, opts, narr, sideLeft, mul),
      regrow: function (mm) { return cgFlowFeature(m, opts, narr, sideLeft, mm); },
      remeta: function (mm) { return build(mm); } };
    band.sImgH = mul * cgFeatureImgH(m, opts);
    band.sTitle = (m && m.title) || ''; band.sAsp = Math.round(momentAspect(m) * 100) / 100;
    if (mtext && (_mzFlowSim || !(opts && opts.enclose))) {
      band.stext = mtext; band.mbound = (mbound != null ? mbound : null); band.sOpts = opts;
      band.sIntro = false; band.sDrop = false; band.simg = true;
      band.renderHead = function (cStart, cEnd) { return cgFlowFeature(m, opts, renderMzSlice(mtext, band.mbound, cStart, cEnd, opts), sideLeft, mul); };
    }
    return band;
  }
  return build(1);
}
// Magazine band generator (shared by the flow render AND the deterministic packer).
// Returns an ORDERED array of { kind, html } bands: an intro band, one band per panel
// group (tower / feature / float / wide / pair), and an outro band. renderMagazine just
// joins them (output byte-identical to before); the packer measures + paginates them.
function magazineBands(moments, sections, intro, outro, opts) {
  var bands = [];
  bands.push({ kind: 'intro', html: coDropOrIntro(intro, opts), stext: mzProseText(intro), sIntro: true, sDrop: !!(opts && opts.dropcap) });

  // Intermixed flow: walk panels IN ORDER, anchor each image, build the full prose
  // around it. Wide images break the column full-width; others float so narrative
  // wraps around and below them; an image with no narrative pairs with the next one.
  // A FEATURE beat (a genuine prominence peak) blows up to half/full page.
  var panels = [];
  for (var k = 0; k < moments.length; k++) {
    var mm = moments[k];
    var sec = sections.find(function (s) { return s.panel_index === k; }) || {};
    var parts = [], rawParts = [];
    if (sec.before) { parts.push(coNarr(sec.before, opts, false)); rawParts.push(sec.before); }
    if (sec.after) { parts.push(coNarr(sec.after, opts, false)); rawParts.push(sec.after); }
    var _pt0 = rawParts.length >= 1 ? mzProseText(rawParts[0]) : null;
    var _pt1 = rawParts.length >= 2 ? mzProseText(rawParts[1]) : null;
    var _mtext = null, _mbound = null;
    if (rawParts.length === 1 && _pt0 != null) { _mtext = _pt0; }
    else if (rawParts.length === 2 && _pt0 != null && _pt1 != null) { _mtext = _pt0 + _pt1; _mbound = _pt0.length; }   // before|after boundary
    panels.push({ m: mm, asp: Math.max(0.3, momentAspect(mm)), narr: parts.join(''), mtext: _mtext, mbound: _mbound, prom: lmProminence(mm), tier: lmSizeTier(mm), feature: false });
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
      // BUDGET the tower's beside-column. This used to absorb up to three panels with no height
      // check at all, so image + prose + panel + prose could stack to 13.7in on a 9.16in page and
      // the overflow was silently clipped -- cutting a line of the book in half. Absorb only while
      // the column stays inside the tower image's own height, which is what keeps the band on one
      // page. Estimates are deliberately conservative: erring high costs a page, erring low loses text.
      var _tta = Math.max(0.3, momentAspect(p.m));
      var _ttImgH = towerImgTargetH(opts);   // MUST match cgFlowTower's imgH, or the column budget over-estimates the room
      var _ttImgW = _ttImgH * _tta;
      var _ttMaxW = CG_W - MZ_MIN_TEXT_COL;
      if (_ttImgW > _ttMaxW) { _ttImgW = _ttMaxW; _ttImgH = _ttImgW / _tta; }
      var _ttColW = Math.max(1.2, CG_W - _ttImgW - 0.20);
      var _ttUsed = mzColTextH(p.narr, _ttColW);   // the tower's own prose is already in the column
      while ((i + mzAdv) < panels.length && mzFill < 3) {
        var mzNp = panels[i + mzAdv];
        if (normShape(mzNp.m) === 'tower' || mzNp.feature || mzNp.asp >= 1.5) break;
        var _ttCost = (_ttColW / Math.max(0.3, mzNp.asp || 1)) + mzColTextH(mzNp.narr, _ttColW) + 0.18;
        if (_ttUsed + _ttCost > _ttImgH) break;   // absorbing this would push the band off the page
        _ttUsed += _ttCost;
        mzBeside += cgBesidePanel(mzNp.m, opts, mzNp.narr);
        mzAdv += 1; mzFill += 1;
      }
      bands.push({ kind: 'tower', html: cgFlowTower(p.m, opts, p.narr, mzBeside, sideLeft),
        renderTowerLead: (function (mm, oo, nn, bside, sl) { return function (leadHtml, shrink, wrapBelow) { return cgFlowTower(mm, oo, (leadHtml || '') + (nn || ''), bside, sl, shrink, wrapBelow); }; })(p.m, opts, p.narr, mzBeside, sideLeft) }); sideLeft = !sideLeft; i += mzAdv;
    } else if (p.feature) {
      bands.push(mzFeatureBand(p.m, opts, p.narr, sideLeft, p.mtext, p.mbound)); if (opts && opts.enclose) sideLeft = !sideLeft; i += 1;
    } else if (p.tier === 'min') {
      bands.push(mzFloatBand(p.m, opts, p.narr, sideLeft, true, p.mtext, p.mbound)); sideLeft = !sideLeft; i += 1;
    } else if (p.asp >= 1.5) {
      bands.push(mzWideBand(p.m, opts, p.narr, sideLeft, p.mtext, p.mbound)); if (opts && opts.enclose) sideLeft = !sideLeft; i += 1;
    } else if (!p.narr && (i + 1) < panels.length && panels[i + 1].asp < 1.5 && normShape(panels[i + 1].m) !== 'tower') {
      bands.push({ kind: 'pair', html: cgFlowPair(p.m, panels[i + 1].m, opts, panels[i + 1].narr) }); i += 2;
    } else {
      bands.push(mzFloatBand(p.m, opts, p.narr, sideLeft, false, p.mtext, p.mbound)); sideLeft = !sideLeft; i += 1;
    }
  }

  bands.push({ kind: 'outro', html: buildNarrativeHTML(outro, true), stext: mzProseText(outro), sIntro: true, sDrop: false });
  return bands;
}
function renderMagazine(moments, sections, intro, outro, opts) {
  if (opts && opts.measureComposed && _mzComposed) return buildComposedMeasureBody(opts);
  if (opts && opts.measureMagazine) return buildMagazineMeasureBody(moments, sections, intro, outro, opts);
  return magazineBands(moments, sections, intro, outro, opts).map(function (b) { return b.html; }).join('');
}
// --- Magazine/Gazette deterministic packer plumbing (Phase 1 groundwork) ---
// Global band accumulator: buildNovelHTML renders each session separately, so band indices
// must be unique ACROSS sessions. computeMagazinePack resets this, runs the measure (which
// fills it via buildMagazineMeasureBody), then reads back the full ordered band list.
// Composed-body cache. Optimize (pack-render) already does the expensive work -- measure, pack,
// transform, compose -- so the print interior reuses that result instead of redoing every measure
// pass. Keyed by campaign + the options that change layout, with a short TTL so an interior built
// after new art or edited narrative recomposes rather than printing something stale. A miss simply
// recomputes, so the cache can never make the interior wrong -- only slower.
var _composedCache = new Map();
var COMPOSED_CACHE_TTL_MS = 30 * 60 * 1000;
var COMPOSED_CACHE_MAX = 24;
function composedCacheKey(campaignId, req) {
  var q = req && req.query ? req.query : {};
  return [campaignId, q.co || '', q.layout || '', q.as_user || '', q.bookTitle || ''].join('|');
}
function composedCachePut(campaignId, req, arrange, body, campaignName) {
  try {
    if (!body) return;
    if (_composedCache.size >= COMPOSED_CACHE_MAX) {   // simple FIFO trim, oldest key first
      var it = _composedCache.keys().next();
      if (!it.done) _composedCache.delete(it.value);
    }
    _composedCache.set(composedCacheKey(campaignId, req), { at: Date.now(), arrange: arrange, body: body, campaignName: campaignName || '' });
  } catch (e) { /* cache is best-effort */ }
}
function composedCacheGet(campaignId, req) {
  try {
    var k = composedCacheKey(campaignId, req);
    var v = _composedCache.get(k);
    if (!v) return null;
    if (Date.now() - v.at > COMPOSED_CACHE_TTL_MS) { _composedCache.delete(k); return null; }
    return v;
  } catch (e) { return null; }
}
var _mzBands = null;
// Iterative-optimizer re-measure state: { plan, bands } of the composed pages to RE-MEASURE (real
// per-page/-line numbers). Set right before the composed measure pass, cleared right after.
var _mzComposed = null;
// Grow-to-fill map for the SECOND measure pass: { globalBandIndex: sizeMultiplier }. Set by
// computeMagazinePack between passes; buildMagazineMeasureBody re-renders the matching float
// bands larger via their regrow() closure so the re-measure captures their true reflowed height.
var _mzGrow = null;
var _mzFlowSim = false;   // when true, band-building makes enclose (Gazette) boxes splittable so the
                          // pack mimics the browser's box-splitting flow (used by the Before dump).
function buildMagazineMeasureBody(moments, sections, intro, outro, opts) {
  var bands = magazineBands(moments, sections, intro, outro, opts);
  var out = '';
  for (var j = 0; j < bands.length; j++) {
    var gi = _mzBands ? _mzBands.length : j;
    var bnd = bands[j];
    if (_mzGrow && bnd.regrow && _mzGrow[gi] && _mzGrow[gi] !== 1) bnd = bnd.remeta ? bnd.remeta(_mzGrow[gi]) : { kind: bnd.kind, html: bnd.regrow(_mzGrow[gi]), regrow: bnd.regrow };
    if (_mzBands) _mzBands.push(bnd);
    // display:flow-root contains each band's float so the measured height is complete.
    out += '<div data-mblk="mzb:' + gi + '" data-mkind="' + bnd.kind + '" style="display:flow-root;">' + bnd.html + '</div>';
  }
  return out;
}
// RE-MEASURE body: the SAME composed pages, but each page's inner content is un-clipped, auto-height,
// and wrapped in a [data-mblk="cp:N"] marker -- so measureDocument reports each page's TRUE content
// height (and real line positions) instead of the synthesized estimates the band measure produced.
function buildComposedMeasureBody(opts) {
  var plan = _mzComposed && _mzComposed.plan, bands = _mzComposed && _mzComposed.bands;
  if (!plan || !plan.pages || _mzComposed._emitted) return '';   // renderMagazine is called per session; emit the WHOLE composed body exactly once
  _mzComposed._emitted = true;
  var out = '';
  plan.pages.forEach(function (pg, pi) {
    // Per-CELL markers (cc:pi:ci) in addition to the per-page cp:N. composePageInner emits its
    // cells in order, each as a top-level <div style="display:flow-root;">, so we can tag each one
    // from outside by walking the same page array and stamping data-mblk onto the Nth flow-root.
    var _cellHtml = pg.map(function (cell, ci) {
      var _one = composePageInner([cell], bands, opts);   // render this ONE cell exactly as the page composer would
      return _one.replace('<div style="display:flow-root;">',
        '<div data-mblk="cc:' + pi + ':' + ci + '" data-mkind="ccell" style="display:flow-root;">');
    }).join('');
    // This whole body is emitted INSIDE buildNovelHTML's <div class="content-page"> (width:8.5in,
    // padding:0.5in 0.85in => a 6.8in text column), exactly like the band measure. So the cell
    // markers already wrap text at the true column width; the page marker just needs to be a plain
    // flow-root that sums them. Adding width/padding here double-counts the content-page box and
    // inflates the height by ~1in (the v3.0.168 regression). Keep it bare.
    out += '<div data-mblk="cp:' + pi + '" data-mkind="cpage" style="display:flow-root;margin-bottom:0.5in;">' + _cellHtml + '</div>';
  });
  return out;
}

function _twoPassChildOpts(opts) {
  var o = {};
  for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k]; }
  o.measureTag = false; o.twoPass = false; o._twoPassMeasured = null;
  return o;
}

// Two-pass Comic render (Stage 4). Uses the measured packComic plan to lay the
// comic out into explicit print pages: each page re-renders its STARTING moments
// (image lands here) through the real renderComicPage grid with narration trimmed
// to this page's portion, and prints CONTINUATION narration (overflow from a moment
// whose image was on an earlier page) as a full-width box above them. Gated: only
// reached when opts.twoPass + opts._twoPassMeasured are set.
function renderComicTwoPass(moments, sections, intro, outro, opts) {
  var measured = opts && opts._twoPassMeasured;
  if (!measured || !measured.plan || !measured.plan.pages || !measured.plan.pages.length) {
    return renderComicPage(moments, sections, intro, outro, _twoPassChildOpts(opts));
  }
  var p2p = require('../services/printing/planToPages');
  var blocks = measured.blocks || [];
  var plan = measured.plan;
  var childOpts = _twoPassChildOpts(opts);
  sections = sections || [];

  function secFor(i) { return sections.find(function (s) { return s.panel_index === i; }) || {}; }
  function narrTextFor(i) { var s = secFor(i); return [s.before, s.after].filter(Boolean).join(' '); }

  var narrH = {};
  for (var bi = 0; bi < blocks.length; bi++) {
    var b = blocks[bi];
    if (b && typeof b.kind === 'string' && b.kind.indexOf('image') === -1) {
      narrH[b.moment] = (narrH[b.moment] || 0) + (b.heightIn || 0);
    }
  }
  var perMoment = {};
  for (var i = 0; i < moments.length; i++) {
    perMoment[i] = { narrText: narrTextFor(i), narrHeightIn: narrH[i] || 0 };
  }

  var pageContent = p2p.planToPageContent(plan, perMoment);
  var PAGE_H = (opts && opts.pageHeightIn) ? opts.pageHeightIn : 9.7;

  var html = coDropOrIntro(intro, opts);
  for (var pgi = 0; pgi < pageContent.length; pgi++) {
    var pc = pageContent[pgi];
    var inner = '';
    for (var ci = 0; ci < pc.continuations.length; ci++) {
      if (pc.continuations[ci].text) inner += cgFullWidthNarr(pc.continuations[ci].text, childOpts);
    }
    if (pc.starts.length) {
      var subMoments = pc.starts.map(function (st) { return moments[st.moment]; });
      var subSections = pc.starts.map(function (st, idx) { return { panel_index: idx, before: '', after: st.text }; });
      inner += renderComicPage(subMoments, subSections, '', '', childOpts);
    }
    var brk = (pgi === pageContent.length - 1) ? '' : 'page-break-after:always;break-after:page;';
    html += '<div style="min-height:' + PAGE_H.toFixed(2) + 'in;' + brk + '">' + inner + '</div>';
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

// Module-scope image box for the one-engine renderer: a bordered panel drawn at
// an EXACT width x height the planner chose. fullWidth => width:100% (top band).
function cgImageBox(m, wIn, hIn, opts, fullWidth) {
  var media = m.image
    ? '<img style="object-fit:cover;width:calc(100% + 2px);height:calc(100% + 2px);margin:-1px;object-position:' + cgFocalPos(lmFocal(m)) + ';display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;height:100%;background:#1a0f06;"></div>';
  var wCss = fullWidth ? 'width:100%;' : ('width:' + wIn.toFixed(2) + 'in;');
  return '<div style="' + cgBorder(opts) + 'background:transparent;position:relative;overflow:hidden;line-height:0;' + wCss + 'height:' + hIn.toFixed(2) + 'in;break-inside:avoid;page-break-inside:avoid;">' + media + picOverlay(opts) + coCaptionCover(m, opts.caption) + '</div>';
}
function _engineRow(cellsHtml) {
  return '<div style="display:flex;gap:' + CG_GAP + 'in;align-items:flex-start;break-inside:avoid;page-break-inside:avoid;margin-bottom:' + CG_GAP + 'in;">' + cellsHtml + '</div>';
}

// ONE-ENGINE renderer: draws exactly the plan from comicEngine.planComic. Because
// the planner used the SAME measured boxes (cgNarrBox) at the SAME column widths,
// rendered height == planned height -> nothing spills. Image rows carry their text
// (beside, alternating sides; or full-width on top); narration uses the planned
// column count. Gated behind opts.engine + opts._enginePlan.
function renderComicEngine(moments, sections, intro, outro, opts) {
  var plan = opts && opts._enginePlan;
  if (!plan || !plan.pages) return renderComicPage(moments, sections, intro, outro, _twoPassChildOpts(opts));
  var co = _twoPassChildOpts(opts);
  sections = sections || [];
  function chunksFor(i) {
    var sec = sections.find(function (s) { return s.panel_index === i; }) || {};
    return cgSplitNarr([sec.before, sec.after].filter(Boolean).join(' '));
  }
  var pageH = (opts && opts.pageHeightIn) ? opts.pageHeightIn : 9.7;
  var html = coDropOrIntro(intro, opts);
  for (var pi = 0; pi < plan.pages.length; pi++) {
    var page = plan.pages[pi];
    var inner = '';
    for (var ii = 0; ii < page.items.length; ii++) {
      var it = page.items[ii];
      var m = moments[it.moment];
      if (it.type === 'image-top') {
        inner += '<div style="margin-bottom:' + CG_GAP + 'in;">' + cgImageBox(m, it.img.wIn, it.img.hIn, co, true) + '</div>';
      } else if (it.type === 'image-beside') {
        var chunks = chunksFor(it.moment);
        var bt = (it.besideChunks || []).map(function (c) { return chunks[c]; }).filter(Boolean).join(' ');
        if (!bt) {
          // lone image (no text beside) -> center it (this is where growth applies)
          inner += '<div style="display:flex;justify-content:center;margin-bottom:' + CG_GAP + 'in;break-inside:avoid;page-break-inside:avoid;"><div style="width:' + it.img.wIn.toFixed(2) + 'in;">' + cgImageBox(m, it.img.wIn, it.img.hIn, co, false) + '</div></div>';
        } else {
          var imgCell = '<div style="flex:0 0 ' + it.img.wIn.toFixed(2) + 'in;">' + cgImageBox(m, it.img.wIn, it.img.hIn, co, false) + '</div>';
          var narrCell = '<div style="flex:1 1 0;min-width:0;">' + cgNarrBox(bt, co) + '</div>';
          inner += _engineRow((it.side === 'right') ? (narrCell + imgCell) : (imgCell + narrCell));
        }
      } else if (it.type === 'narr') {
        var ch = chunksFor(it.moment);
        if (it.cols <= 1) {
          var t = it.colChunks[0].map(function (c) { return ch[c]; }).filter(Boolean).join(' ');
          inner += '<div style="margin-bottom:' + CG_GAP + 'in;">' + cgNarrBox(t, co) + '</div>';
        } else {
          var boxes = it.colChunks.map(function (col) {
            var tt = col.map(function (c) { return ch[c]; }).filter(Boolean).join(' ');
            return '<div style="flex:1 1 0;min-width:0;">' + (tt ? cgNarrBox(tt, co) : '') + '</div>';
          }).join('');
          inner += _engineRow(boxes);
        }
      }
    }
    var brk = (pi === plan.pages.length - 1) ? '' : 'page-break-after:always;break-after:page;';
    html += '<div style="min-height:' + pageH.toFixed(2) + 'in;' + brk + '">' + inner + '</div>';
  }
  html += buildNarrativeHTML(outro, true);
  return html;
}

// Gazette: the Magazine flow, ENCLOSED. Each beat is wrapped in a parchment panel
// (image bordered + floated inside, text wrapping within the box). Inherits
// Magazine's prominence-aware flow (towers, wide bands, feature blow-ups) so big
// images stay big -- it just adds the panel enclosure via opts.enclose.
function renderGazette(moments, sections, intro, outro, opts) {
  var gopts = {};
  for (var k in opts) { if (Object.prototype.hasOwnProperty.call(opts, k)) gopts[k] = opts[k]; }
  gopts.enclose = true;
  return renderMagazine(moments, sections, intro, outro, gopts);
}

function renderLayout(opts, moments, sections, intro, outro) {
  if (!moments || !moments.length) return '<p style="color:#6b5f55;font-style:italic;text-align:center;padding:1in;">No panels yet - generate your storyboard first.</p>';
  sections = sections || []; intro = intro || ''; outro = outro || '';
  switch (opts.arrange) {
    case 'stack':  return renderStack(moments, sections, intro, outro, opts);
    case 'splash': return renderSplash(moments, sections, intro, outro, opts);
    case 'paired': return (opts && opts.measurePaired) ? buildPairedMeasureBody(moments, sections, intro, outro, opts) : renderPaired(moments, sections, intro, outro, opts);
    case 'comicpage': return (opts && opts.measureChunks) ? buildChunkMeasureBody(moments, sections, opts) : ((opts && opts.engine && opts._enginePlan) ? renderComicEngine(moments, sections, intro, outro, opts) : ((opts && opts.twoPass && opts._twoPassMeasured) ? renderComicTwoPass(moments, sections, intro, outro, opts) : renderComicPage(moments, sections, intro, outro, opts)));
    case 'magazine': return renderMagazine(moments, sections, intro, outro, opts);
    case 'gazette': return renderGazette(moments, sections, intro, outro, opts);
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
  if (paper === 'cream' || paper === 'linen') return '#f3ece0';
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
  var fWmark  = false; // OFF for now; set to (user is on free trial) later. Under-fill scan samples the paper background, so the watermark never affects optimization even when on.
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
  // Approach B: lift the establishing/title-image moment OUT of the panel flow
  // (it becomes the session title image below, above the intro). Story panels
  // and their narrative sections are re-keyed so nothing shifts by one.
  var _estMoment = null, _storyMoments = [], _idxMap = {};
  for (var _k = 0; _k < moments.length; _k++) {
    if (moments[_k].kind === 'establishing') { _estMoment = moments[_k]; }
    else { _idxMap[_k] = _storyMoments.length; _storyMoments.push(moments[_k]); }
  }
  var _storySections = (sections || []).filter(function(_s){ return Object.prototype.hasOwnProperty.call(_idxMap, _s.panel_index); }).map(function(_s){ var _c = Object.assign({}, _s); _c.panel_index = _idxMap[_s.panel_index]; return _c; });
  var panelsHTML = buildLayout(layoutStyle, _storyMoments, _storySections, intro, outro, co);
  // Session title image: the wide establishing shot that sets the scene for the
  // first narrative. Additive block above the session content - does NOT touch
  // buildLayout / renderPaired. (Stage 4.1: Session Preview only.)
  var _estImg = (_estMoment && _estMoment.image) ? _estMoment.image : session.establishing_image;
  var _estM = { image: _estImg, title: '', shape: (_estMoment && _estMoment.shape) ? _estMoment.shape : (session.establishing_shape || 'wide'), img_w: (_estMoment && _estMoment.img_w) || session.establishing_img_w || null, img_h: (_estMoment && _estMoment.img_h) || session.establishing_img_h || null };
  var titleImageHTML = _estImg
    ? '<div class="session-title-image" style="margin:0 0 0.28in;">' + coCell(_estM, 0, 100, co || {}) + '</div>'
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
    transform: translate(-50%, 50%);
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    line-height: 1;
    color: rgba(201,168,76,0.4);
    background: #0a0604;
    padding: 0 0.12in;
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
<div class="backcover-page"><div class="cover-bg"></div><div class="cover-border"></div><div class="cover-border-inner"></div><div class="backcover-inner"><div class="cover-art-frame"><img class="cover-art-img" src="${campaign.back_cover_image_url}" alt="" /></div></div><div class="cover-watermark">CAMPAIGNIA.COM</div></div>` : ''}

</body>
</html>`;
}

// ============================================================
// BUILD Graphic Novel HTML (all sessions)
// ============================================================
// Session divider ("Session N - Name - Date") at each session boundary. Shared by the flow
// render (buildNovelHTML) and the deterministic composer (composeBook) so both look identical.
// Gated by the `markers` layout option upstream.
function sessionMarkerHTML(num, name, date) {
  return '<div class="session-marker">' +
    '<div class="session-marker-ornament">&bull; &bull; &bull;</div>' +
    '<div class="session-marker-label">Session ' + num + ' &mdash; ' + (name || '') +
      ' &middot; ' + formatDate(date) + '</div>' +
  '</div>';
}
// Per-page running head for the composed book: campaign name + current session, tucked just
// inside the top margin, repeated on every page. Absolutely positioned so it never consumes
// packed body space (the packer's page plan stays exact). Suppressed on session-opening pages.
function runningHeaderHTML(campaignName, num, name) {
  return '<div class="page-header" style="position:absolute;top:0.02in;left:0.85in;right:0.85in;margin:0;padding-bottom:0.03in;z-index:6;">' +
    '<div class="page-header-campaign">' + (campaignName || '') + '</div>' +
    '<div class="page-header-session">Session ' + num + ' &mdash; ' + (name || '') + '</div>' +
  '</div>';
}
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
  var fMarkerBreak = fMarkers && !!(co && co.markerbreak);   // start each session on a fresh page
  var fWmark  = false; // OFF for now; set to (user is on free trial) later. Under-fill scan samples the paper background, so the watermark never affects optimization even when on.
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
  var _isNpc = function (c) { return c.is_npc === true || c.is_npc === 1 || c.is_npc === '1' || c.is_npc === 'true'; };
  // The Company page lists player characters only -- NPCs still appear in panels.
  var castChars = characters.filter(function (c) { return !_isNpc(c); });
  var _castN = castChars.length;
  var _castCols, _castPort, _castGap, _castFields;
  if (_castN <= 12)      { _castCols = 3; _castPort = 1.1;  _castGap = 0.25; _castFields = 'full'; }
  else if (_castN <= 30) { _castCols = 4; _castPort = 0.85; _castGap = 0.16; _castFields = 'mid';  }
  else if (_castN <= 60) { _castCols = 6; _castPort = 0.55; _castGap = 0.10; _castFields = 'name'; }
  else                   { _castCols = 0; _castPort = 0;    _castGap = 0;    _castFields = 'list'; }
  var castBlockHTML;
  if (_castFields === 'list') {
    castBlockHTML = '<div class="cast-names">' + castChars.map(function(c){
      return '<div class="cast-name-item">' + _fmEsc(c.name) +
        (_pubName(c.player_name, c.player_pen_name) ? ' <span class="cast-name-player">(' + _fmEsc(_pubName(c.player_name, c.player_pen_name)) + ')</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  } else {
    var _noImgFont = Math.max(9, Math.round(_castPort * 21));
    var _members = castChars.map(function(c) {
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
  var allSessionsHTML = (co && co.packComposedBody) ? co.packComposedBody : renderSessions.map(function(s, localIdx) {
    var si = paginated ? pageIndex : localIdx;
    var moments = s.moments || [];
    var narrative = {
      intro: s.narrative_intro || '',
      sections: s.narrative_sections ? JSON.parse(s.narrative_sections) : [],
      outro: s.narrative_outro || ''
    };

    // Approach B: lift the establishing/title-image moment OUT of the panel flow
    // (it becomes the session title image below, above the intro). Story panels
    // and their narrative sections are re-keyed so nothing shifts by one.
    var _estMoment = null, _storyMoments = [], _idxMap = {};
    for (var _k = 0; _k < moments.length; _k++) {
      if (moments[_k].kind === 'establishing') { _estMoment = moments[_k]; }
      else { _idxMap[_k] = _storyMoments.length; _storyMoments.push(moments[_k]); }
    }
    var _storySections = (narrative.sections || []).filter(function(_s){ return Object.prototype.hasOwnProperty.call(_idxMap, _s.panel_index); }).map(function(_s){ var _c = Object.assign({}, _s); _c.panel_index = _idxMap[_s.panel_index]; return _c; });
    // Session title image: the wide establishing shot that opens each session,
    // placed below the session marker and above the narrative. Additive - does
    // NOT touch buildLayout / renderPaired. Flows through preview, print, publish,
    // and the public story page (snapshot carries establishing_image). (Stage 4.2)
    var _estImg = (_estMoment && _estMoment.image) ? _estMoment.image : s.establishing_image;
    var _estM = { image: _estImg, title: '', shape: (_estMoment && _estMoment.shape) ? _estMoment.shape : (s.establishing_shape || 'wide'), img_w: (_estMoment && _estMoment.img_w) || s.establishing_img_w || null, img_h: (_estMoment && _estMoment.img_h) || s.establishing_img_h || null };
    var titleImageHTML = _estImg
      ? '<div class="session-title-image" style="margin:0 0 0.28in;">' + coCell(_estM, 0, 100, co || {}) + '</div>'
      : '';

    // Session dividers now also show in Quick View (removed the `paginated` suppression) so
    // decorations are visible in the fast preview -- gated only on the markers option.
    var chapterHeading = !fMarkers ? '' : sessionMarkerHTML(si + 1, s.name, s.session_date);

    // Magazine/Gazette Optimize measure: the session marker + title image live OUTSIDE
    // buildLayout, so capture them as this session's LEADING bands (pushed before the panel
    // bands) or the deterministic composer drops them. Order: session-header, title-image,
    // then intro/panels/outro from buildLayout below.
    if (co && co.measureMagazine && _mzBands) {
      if (chapterHeading) { var _mzhI = _mzBands.length; _mzBands.push({ kind: 'session-header', html: chapterHeading, sNum: (si + 1), sName: (s && s.name) || '', sCamp: (campaign && campaign.name) || '' }); chapterHeading = '<div data-mblk="mzb:' + _mzhI + '" data-mkind="session-header" style="display:flow-root;">' + chapterHeading + '</div>'; }
      if (titleImageHTML) { var _mztI = _mzBands.length; _mzBands.push({ kind: 'title-image', html: titleImageHTML }); titleImageHTML = '<div data-mblk="mzb:' + _mztI + '" data-mkind="title-image" style="display:flow-root;">' + titleImageHTML + '</div>'; }
    }
    var panelsHTML = buildLayout(layoutStyle, _storyMoments, _storySections, narrative.intro, narrative.outro, co);

    var _sessBreak = (fMarkerBreak && si > 0 && !paginated) ? 'page-break-before:always;' : '';
    return '<div class="content-page" style="' + _sessBreak + 'position:relative;">' +
      (co ? coCondOverlay(co.condition) : '') +
      (co ? coCondPreload(co.condition) : '') +
      '<div style="position:relative;z-index:1;">' +
      (fHeader ? ('<div class="page-header">' +
        '<div class="page-header-campaign">' + campaign.name + '</div>' +
        '<div class="page-header-session">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '</div>') : '') +
      '<div style="break-inside:avoid;">' + chapterHeading + titleImageHTML + '</div>' +   // keep the session marker glued to its establishing image across ALL layouts
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
    ? String(pageOpts.bookTitle).trim() : (campaign._memberBookTitle || campaign.name);
  // Cover title color picker (Prep to Publish). Applied inline to whichever cover
  // title actually renders so the picker always wins over the CSS default. Cover
  // only -- interior title/details pages keep their dark parchment color. Output
  // is byte-identical when no valid color is supplied.
  var _coverTitleColor = (pageOpts && pageOpts.titleColor && /^#[0-9a-fA-F]{3,8}$/.test(pageOpts.titleColor)) ? pageOpts.titleColor : '';
  var _coverTitleStyle = _coverTitleColor ? (' style="color:' + _coverTitleColor + '"') : '';
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
      '<div class="dp-title">' + _fmEsc(_bookTitleFM) + '</div>' +
      ((_bookTitleFM && _bookTitleFM !== campaign.name) ? '<div class="dp-campaign">' + _fmEsc(campaign.name) + '</div>' : '') +
      (dateRange ? '<div class="dp-dates">' + dateRange + '</div>' : '') +
      '<div class="dp-divider"></div>' +
      (playerNames ? '<div class="dp-block"><div class="dp-label">Players</div><div class="dp-value">' + _fmEsc(playerNames) + '</div></div>' : '') +
      (fPublic
        ? (copyHolder ? '<div class="dp-block"><div class="dp-label">Chronicled by</div><div class="dp-value">' + _fmEsc(copyHolder) + '</div></div>' : '')
        : '<div class="dp-block"><div class="dp-label">Story Master</div><div class="dp-value">' + _fmEsc(copyHolder) + '</div></div>') +
      '<div class="dp-copyright">&copy; ' + copyYear + (copyHolder ? ' ' + _fmEsc(copyHolder) : '') + '. All rights reserved.</div>' +
      '<div class="dp-footer">' +
        (fHideLogo ? '' : '<img class="dp-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />') +
        '<div class="dp-disclaimer">Created with Campaignia &middot; campaignia.com.<br/>' +
          'This chronicle was assembled from recorded tabletop role-playing sessions. Narrative text and illustrations were produced with the assistance of AI tools. All characters and original content remain the property of their respective players and creators.</div>' +
      '</div>' +
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
  body { font-family: 'Crimson Text', Georgia, serif; background: #fff; color: #1a1410; width: 8.5in; margin: 0 auto;  orphans: 2; widows: 2; }

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
  .cover-watermark { position:absolute;bottom:0.5in;left:50%;transform:translate(-50%,50%);font-family:'Cinzel',serif;font-size:8pt;line-height:1;color:rgba(201,168,76,0.4);background:#0a0604;padding:0 0.12in;letter-spacing:0.15em;z-index:1; }
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
  .tp-image { display:block;max-width:6.5in;max-height:6.5in;width:auto;height:auto;margin:0 auto; }
  .tp-logo { width:0.95in;height:auto;object-fit:contain;margin-top:0.5in;opacity:0.9; }
  .detailspage { width:8.5in;min-height:9.4in;padding:1in 1.1in;page-break-after:always;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center; }
  .dp-title { font-family:'Cinzel',serif;font-size:20pt;font-weight:700;color:#2c1810;letter-spacing:0.03em;margin-bottom:0.08in; }
  .dp-campaign { font-family:'Crimson Text',serif;font-size:16pt;font-style:italic;color:#6b5f55;margin:-0.02in 0 0.12in; }
  .dp-dates { font-family:'Crimson Text',serif;font-size:12pt;color:#6b5f55;font-style:italic;margin-bottom:0.15in; }
  .dp-divider { width:60px;height:1px;background:rgba(201,168,76,0.4);margin:0.1in auto 0.3in; }
  .dp-block { margin-bottom:0.22in; }
  .dp-label { font-family:'Cinzel',serif;font-size:8.5pt;color:#8a6a2a;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:0.04in; }
  .dp-value { font-family:'Crimson Text',serif;font-size:12pt;color:#2c1810;line-height:1.5; }
  .dp-copyright { font-family:'Crimson Text',serif;font-size:10.5pt;color:#3a2a1a;margin-top:0.3in; }
  .dp-logo { width:0.85in;height:auto;object-fit:contain;display:block;margin:0.3in auto 0.12in;opacity:0.9; }
  .dp-disclaimer { font-family:'Crimson Text',serif;font-size:8.5pt;color:#8a7a68;line-height:1.5;margin-top:0.2in;max-width:6in; }
  .dp-footer { margin-top:auto;display:flex;flex-direction:column;align-items:center;width:100%; }

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
        <div class="cover-art-title"${_coverTitleStyle}>${_fmEsc(_bookTitleFM)}</div>
        <div class="cover-art-dates">${dateRange}</div>
        ${fHideLogo ? '' : '<img class="cover-art-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
      </div>
    </div>
  </div>` : `<div class="cover-content">
    ${fHideLogo ? '' : '<img class="cover-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />'}
    <div class="cover-eyebrow">The Saga of</div>
    <div class="cover-title"${_coverTitleStyle}>${_fmEsc(_bookTitleFM)}</div>
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
  <div class="cast-divider"></div>
  ${castBlockHTML}
</div>` : ''}
${(fToc && (!paginated || pageOpts.page === 1)) ? tocBlock : ''}

<!-- SESSIONS -->
${allSessionsHTML}

${fWmark ? '<div class="page-watermark">CAMPAIGNIA.COM</div>' : ''}

${(fCover && (!paginated || pageOpts.page === totalSessions) && (campaign.back_cover_image_url || fPublic)) ? `<!-- BACK COVER PAGE -->
<div class="backcover-page"><div class="cover-bg"></div><div class="cover-border"></div><div class="cover-border-inner"></div><div class="backcover-inner">${campaign.back_cover_image_url ? `<div class="cover-art-frame"><img class="cover-art-img" src="${campaign.back_cover_image_url}" alt="" /></div>` : `<div class="backcover-default"><div class="bc-title">${_fmEsc(_bookTitleFM)}</div><div class="bc-rule"></div><div class="bc-tag">A Campaignia Chronicle</div></div>`}</div><div class="cover-watermark">CAMPAIGNIA.COM</div></div>` : ''}

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

async function sendHtmlAsPdf(res, html, name, pdfOpts) {
  var baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');
  var buf = await renderHtmlToPdf(html, pdfOpts || {});
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
    if (campaign && !campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;
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
    // Stage 1 verification: ?measure=1 returns the text-only measured block
    // geometry for the COMIC layout (images blocked) instead of the PDF/HTML.
    if (req.query.measure === '1' || req.query.measure === 'true') {
      var _mco = co || {};
      _mco.arrange = 'comicpage';
      _mco.measureTag = true;
      var _mhtml = buildSessionHTML(session, moments, campaign, characters, narrative, _mco, { noCover: true });
      var _measured = await measureDocument(_mhtml, {});
      try {
        var _maxPP = await getAppSettingInt('max_pages_per_print', 250);
        _measured.plan = packComic(_measured.blocks, { pageHeightIn: 9.7, gapIn: 0.12, maxPages: _maxPP });
      } catch (e) { _measured.planError = friendlyError(e, ''); }
      _measured.layout = 'comicpage';
      _measured.sessionId = String(req.params.sessionId);
      return res.json(_measured);
    }
    // Exact chunk measurement (one-engine foundation): every narration chunk at
    // every column width, plus per-moment image aspect/prominence. Build data.
    if (req.query.measure2 === '1' || req.query.measure2 === 'true') {
      var _c2 = co || {}; _c2.arrange = 'comicpage'; _c2.measureChunks = true; _c2.twoPass = false; _c2.measureTag = false;
      var _h2 = buildSessionHTML(session, moments, campaign, characters, narrative, _c2, { noCover: true });
      var _m2 = await measureDocument(_h2, {});
      var _imgInfo = moments.map(function (m, idx) {
        return { moment: idx, aspect: Math.round(momentAspect(m) * 1000) / 1000, prominence: lmProminence(m), tier: lmSizeTier(m), hasImage: !!m.image };
      });
      _m2.imageInfo = _imgInfo;
      _m2.colWidths = cgColWidths().map(function (w) { return Math.round(w * 1000) / 1000; });
      _m2.layout = 'comicpage-chunks';
      _m2.sessionId = String(req.params.sessionId);
      return res.json(_m2);
    }
    // ONE-ENGINE paginated Comic render (gated). Exact chunk measure -> comicEngine
    // plan -> draw exactly the plan. ?twopass=1 (kept name) routes here.
    if (req.query.twopass === '1' || req.query.twopass === 'true') {
      var _eco = co || {}; _eco.arrange = 'comicpage';
      var _emco = {}; for (var _ek in _eco) { if (Object.prototype.hasOwnProperty.call(_eco, _ek)) _emco[_ek] = _eco[_ek]; }
      _emco.measureChunks = true; _emco.engine = false; _emco.twoPass = false; _emco.measureTag = false;
      var _emhtml = buildSessionHTML(session, moments, campaign, characters, narrative, _emco, { noCover: true });
      var _em = await measureDocument(_emhtml, {});
      var _byM = {};
      (_em.blocks || []).forEach(function (b) {
        var mm = /^m(\d+)_c(\d+)_w(\d+)$/.exec(b.id || '');
        if (!mm) return;
        var mi = +mm[1], ci = +mm[2], wi = +mm[3];
        _byM[mi] = _byM[mi] || []; _byM[mi][ci] = _byM[mi][ci] || []; _byM[mi][ci][wi] = b.heightIn;
      });
      // Align with the renderer: buildSessionHTML lifts the establishing/title moment
      // OUT of the panel flow and reindexes the rest into _storyMoments. The chunk
      // measurement and renderComicEngine both operate on that stripped+reindexed list,
      // so the plan must be built over the SAME list or indices drift by one.
      var _storyM = moments.filter(function (mm) { return mm.kind !== 'establishing'; });
      var _engMoments = _storyM.map(function (mo, idx) {
        return { image: { aspect: momentAspect(mo), prominence: lmProminence(mo), tier: lmSizeTier(mo), hasImage: !!mo.image }, chunks: _byM[idx] || [] };
      });
      var _emax = await getAppSettingInt('max_pages_per_print', 250);
      var _eplan = planComic(_engMoments, { pageHeightIn: 9.7, overflowCols: 2, maxPages: _emax });
      _eco.measureChunks = false; _eco.engine = true; _eco._enginePlan = _eplan;
      var _ehtml = buildSessionHTML(session, moments, campaign, characters, narrative, _eco, { noCover: true });
      if (await userInFreeTrial(db, req.session.userId)) _ehtml = injectTrialWatermark(_ehtml);
      if (req.query.format === 'pdf') {
        return await sendHtmlAsPdf(res, _ehtml, pdfFileName([campaign.name, session.name, 'comic']));
      }
      return res.send(_ehtml);
    }
    if (req.query.format === 'pdf') {
      var sfo = await db.prepare("SELECT u.name AS uname, sf.role AS srole FROM session_forks sf JOIN users u ON u.id = sf.user_id WHERE sf.id = ?").get(viewForkId);
      var sMember = (sfo && sfo.srole === 'player' && sfo.uname) ? sfo.uname : '';
      return await sendHtmlAsPdf(res, html, pdfFileName([campaign.name, session.name, sMember]));
    }
    res.send(html);
  } catch(e) {
    console.error('PDF session error:', e.message);
    res.status(500).send('<html><body style="background:#1a0f08;color:#c9a84c;font-family:serif;padding:2rem;"><h2>Error generating PDF</h2><p>' + friendlyError(e, 'The PDF could not be generated. Please try again.') + '</p></body></html>');
  }
});

// GET graphic novel HTML (all sessions)
router.get('/novel/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();

  const campaign = await db.prepare(
    'SELECT c.*, cm.role AS my_role, u.name AS owner_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
  ).get(req.params.campaignId, req.session.userId);
  if (campaign && !campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;

  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  // Graphic novel access: the Story Master (dm) always; a member (player) only
  // when the SM has enabled it for this campaign. No tier gate.
  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(campaign.id);
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
  const _incMap = await effectiveIncludeMap(db, campaign.id, asUser);
  var _bmFork = asUser || (req.session && req.session.userId) || null;
  var _bmChooser = (req.session && req.session.userId) || _bmFork;
  if (_bmFork) {
    const _bm = await getForkBookPrefs(db, _bmChooser, _bmFork, campaign.id, { inherit: true });
    {
      // Resolve covers from the fork's own meta, else the campaign tile (the campaign
      // record cover_image_url is vestigial after the per-fork move -- never use it).
      var _fbm = _bm || {};
      campaign.cover_image_url = _fbm.cover_image_url || campaign.campaign_image_url || '';
      campaign.back_cover_image_url = _fbm.back_cover_image_url || '';
      campaign.title_image_url = _fbm.title_image_url || '';
      if (_fbm.book_title) campaign._memberBookTitle = _fbm.book_title;
    }
  }
  const sessionsWithData = await Promise.all(sessions.filter(function(s) { return _incMap[s.id]; }).map(async function(s) {
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
  if (req.query.nocover === '1') pageOpts.noCover = true;   // Finalize preview: interior only (covers are a publish-time artifact)
  var pageNum = parseInt(req.query.page, 10);
  if (!isNaN(pageNum) && pageNum > 0) {
    pageOpts.page = pageNum;
  }
  if (req.query.bookTitle != null && String(req.query.bookTitle).trim()) pageOpts.bookTitle = req.query.bookTitle;
  if (req.query.titleColor != null && /^#[0-9a-fA-F]{3,8}$/.test(String(req.query.titleColor))) pageOpts.titleColor = String(req.query.titleColor);
  res.set('X-Total-Sessions', String(sessionsWithData.length));

  const co = req.query.co ? parseCustomOpts(req.query.co) : null;
  if (co) co.hideLogo = (accessRank(await getEffectiveTier(req.session.userId, campaign.id)) >= 4) && !!co.hidelogo;
  let html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  if (req.query.pane === '1') html = paneSafeHtml(html);   // preview-safe gradients in the Finalize panes only
  if (await userInFreeTrial(db, req.session.userId)) html = injectTrialWatermark(html);
  if (req.query.format === 'pdf') {
    var nMember = '';
    if (asUser) { var nu = await db.prepare('SELECT name FROM users WHERE id = ?').get(asUser); if (nu && nu.name) nMember = nu.name; }
    // Flow render: Chromium's native running head is the only way to repeat a header on pages whose
    // breaks CSS decides. The composed routes draw their own, so they never pass this.
    // The running head belongs on INTERIOR pages only. Front matter is emitted in this order (see
    // the assembly below): [cover?] title, details, [cast?], [toc?]; a back cover, when present,
    // is the final page. Tell the renderer how many pages at each end are matter so it can leave
    // the head off them. Defaults mirror fCover/fCast/fToc exactly.
    var _rhPublic = !!(pageOpts && pageOpts.publicMode);
    var _rhCover = (pageOpts && pageOpts.noCover) ? false : (co ? !!co.cover : true);
    var _rhCast  = (co ? !!co.cast : true);
    var _rhToc   = (co ? !!co.toc  : false);
    var _rhFront = (_rhCover ? 1 : 0) + 1 + 1 + (_rhCast ? 1 : 0) + (_rhToc ? 1 : 0);   // cover? + title + details + cast? + toc?
    var _rhBack  = (_rhCover && (campaign.back_cover_image_url || _rhPublic)) ? 1 : 0;
    var _rh = (co && co.header === false) ? null : { campaign: campaign.name, skipPages: _rhFront, skipLastPages: _rhBack };
    try { return await sendHtmlAsPdf(res, html, pdfFileName([campaign.name, nMember]), { runningHeader: _rh }); }
    catch (e) { return res.status(500).json({ error: 'PDF render failed', detail: friendlyError(e, '') }); }
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
  if (campaign && !campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;

  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaign.id);

  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; }
    catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) { return sessionDateKey(a).localeCompare(sessionDateKey(b)); });

  const asUser = req.query.as_user ? Number(req.query.as_user) : null;
  const _incMap = await effectiveIncludeMap(db, campaign.id, asUser);
  var _bmFork = asUser || (req.session && req.session.userId) || null;
  var _bmChooser = (req.session && req.session.userId) || _bmFork;
  if (_bmFork) {
    const _bm = await getForkBookPrefs(db, _bmChooser, _bmFork, campaign.id, { inherit: true });
    {
      // Resolve covers from the fork's own meta, else the campaign tile (the campaign
      // record cover_image_url is vestigial after the per-fork move -- never use it).
      var _fbm = _bm || {};
      campaign.cover_image_url = _fbm.cover_image_url || campaign.campaign_image_url || '';
      campaign.back_cover_image_url = _fbm.back_cover_image_url || '';
      campaign.title_image_url = _fbm.title_image_url || '';
      if (_fbm.book_title) campaign._memberBookTitle = _fbm.book_title;
    }
  }
  const sessionsWithData = await Promise.all(sessions.filter(function(s) { return _incMap[s.id]; }).map(async function(s) {
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
  if (co) co.paper = 'white'; // Lulu interior PDF is ALWAYS white; the physical cream paper stock (chosen at order time) supplies the warmth. Preview/library renders keep the tint.

  var pageOpts = { noCover: true, bookTitle: req.query.bookTitle || '' }; // full book, never paginated for print

  // PRINT INTERIOR = THE OPTIMIZED ("After") BOOK, minus the covers.
  // The Finalize After pane and the Lulu interior must be the same artifact, so this runs the exact
  // same pack + compose the After pane runs, then assembles it with nocover=1 (which suppresses BOTH
  // the front cover and the back cover -- they are a publish-time artifact produced separately).
  // Paper is forced to white here as always: the physical cream stock supplies the warmth.
  // No token is charged -- the reader already paid to Optimize; printing must not re-charge.
  var html = null;
  if (co && (co.arrange === 'magazine' || co.arrange === 'gazette' || co.arrange === 'paired')) {
    try {
      var _pco = Object.assign({}, co, { paper: 'white' });
      var _extra = { paper: 'white', arrange: co.arrange };
      req.query.nocover = '1';
      var _hit = composedCacheGet(req.params.campaignId, req);
      if (_hit && _hit.arrange === co.arrange && _hit.body) {
        // Optimize already measured, packed and composed this exact book -- reuse it verbatim so the
        // interior is byte-identical to the After pane and no measure pass runs again.
        _extra.campaignName = _hit.campaignName || '';
        _extra.packComposedBody = _hit.body;
      } else if (co.arrange === 'paired') {
        var _packP = await computePairedPack(req, req.params.campaignId, { pageHeightIn: 9.4 });
        _pco.campaignName = (_packP.campaign && _packP.campaign.name) || '';
        _extra.campaignName = _pco.campaignName;
        _extra.packComposedBody = composeBook(_packP.plan, _packP.beats, _pco);
      } else {
        var _packM = await computeMagazinePack(req, req.params.campaignId, { pageHeightIn: 9.4 });
        _pco.campaignName = (_packM.campaign && _packM.campaign.name) || '';
        _extra.campaignName = _pco.campaignName;
        _extra.packComposedBody = composeMagazine(_packM.plan, _packM.bands, _pco);
      }
      var _builtP = await assembleNovelHtml(req, req.params.campaignId, null, _extra);
      html = _builtP && _builtP.html;
    } catch (e) {
      console.error('[print-interior] composed build failed, falling back to flow render:', (e && e.message) || e);
      html = null;
    }
  }
  // Fallback: any layout without a composer (or a compose failure) prints the flow render as before.
  if (!html) html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);

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
    return res.status(500).json({ error: 'PDF render failed', detail: friendlyError(e, '') });
  }

  try {
    var _maxPP = await getAppSettingInt('max_pages_per_print', 250);
    var _ppCount = await countPdfPages(pdfBuffer);
    if (_ppCount > _maxPP) {
      return res.status(413).json({ error: 'PAGE_LIMIT', pages: _ppCount, maxPages: _maxPP, message: 'This book is ' + _ppCount + ' pages, which is over the current ' + _maxPP + '-page limit for a single book. To make it fit, open your Sessions list and uncheck some sessions using the "Include in Print" checkbox, then try again, or split it into multiple smaller books.' });
    }
  } catch (e) { console.error('[page-limit] count failed:', e && e.message ? e.message : e); }

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
    return res.status(500).json({ error: 'PDF upload failed', detail: friendlyError(e, '') });
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
    if (campaign && !campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;
    if (!campaign) return res.status(403).json({ error: 'Access denied' });
    var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
      campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
    if (campaign.my_role !== 'dm' && !_allowNovel) {
      return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
    }

    // Per-member wrap cover: use the viewed fork's own cover/back/title images.
    const asUser = req.query.as_user ? Number(req.query.as_user) : null;
    var _bmFork = asUser || (req.session && req.session.userId) || null;
    var _bmChooser = (req.session && req.session.userId) || _bmFork;
    if (_bmFork) {
      const _bm = await getForkBookPrefs(db, _bmChooser, _bmFork, campaign.id, { inherit: true });
      {
        var _fbm = _bm || {};
        campaign.cover_image_url = _fbm.cover_image_url || campaign.campaign_image_url || '';
        campaign.back_cover_image_url = _fbm.back_cover_image_url || '';
        campaign.title_image_url = _fbm.title_image_url || '';
        if (_fbm.book_title) campaign._memberBookTitle = _fbm.book_title;
      }
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

    var html = buildWrapCoverHTML(campaign, built.spec, dims, { hideLogo: fHideLogo, bookTitle: req.query.bookTitle || campaign._memberBookTitle || '', titleColor: req.query.titleColor || '' });
    var baseUrl = (process.env.PUBLIC_BASE_URL || '');
    if (baseUrl.charAt(baseUrl.length - 1) === '/') baseUrl = baseUrl.slice(0, -1);
    if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');

    var pdfBuffer;
    try {
      pdfBuffer = await renderHtmlToPdf(html, { widthIn: dims.widthIn, heightIn: dims.heightIn });
    } catch (e) {
      console.error('[print-cover] render failed:', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Cover render failed', detail: friendlyError(e, '') });
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
      return res.status(500).json({ error: 'Cover upload failed', detail: friendlyError(e, '') });
    }
  } catch (e) {
    console.error('[print-cover] error:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Server error', detail: friendlyError(e, '') });
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
  if (campaign && !campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;
  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  var _allowNovel = campaign.allow_player_novel_access === true || campaign.allow_player_novel_access === 1 ||
    campaign.allow_player_novel_access === 't' || campaign.allow_player_novel_access === 'true';
  if (campaign.my_role !== 'dm' && !_allowNovel) {
    return res.status(403).json({ error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
  }

  // Per-campaign publishing gate: the EFFECTIVE tier for this campaign must be
  // paid. A Copper player in a campaign run by a subscribing Story Master clears
  // this (the SM's paid tier flows down via getEffectiveTier); a Copper user not
  // under a paid SM is blocked. Trial is already rejected above (watermark).
  const _pubTier = await getEffectiveTier(req.session.userId, campaign.id);
  if (!isPaidTier(_pubTier)) {
    return res.status(403).json({ error: 'Publishing to the Library requires a paid plan, or playing in a campaign run by a subscriber.', code: 'publish_requires_subscription' });
  }

  // Always the caller's OWN book: DM/owner -> canonical; player -> their fork.
  const asUser = (campaign.my_role === 'dm') ? null : Number(req.session.userId);

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare(
    'SELECT ch.*, u.pen_name AS player_pen_name FROM characters ch LEFT JOIN users u ON u.id = ch.owner_user_id WHERE ch.campaign_id = ?'
  ).all(campaign.id);

  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; } catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) { return sessionDateKey(a).localeCompare(sessionDateKey(b)); });

  const _incMap = await effectiveIncludeMap(db, campaign.id, asUser);
  var _bmFork = asUser || (req.session && req.session.userId) || null;
  var _bmChooser = (req.session && req.session.userId) || _bmFork;
  if (_bmFork) {
    const _bm = await getForkBookPrefs(db, _bmChooser, _bmFork, campaign.id, { inherit: true });
    {
      // Resolve covers from the fork's own meta, else the campaign tile (the campaign
      // record cover_image_url is vestigial after the per-fork move -- never use it).
      var _fbm = _bm || {};
      campaign.cover_image_url = _fbm.cover_image_url || campaign.campaign_image_url || '';
      campaign.back_cover_image_url = _fbm.back_cover_image_url || '';
      campaign.title_image_url = _fbm.title_image_url || '';
      if (_fbm.book_title) campaign._memberBookTitle = _fbm.book_title;
    }
  }
  const sessionsWithData = await Promise.all(sessions.filter(function(s) { return _incMap[s.id]; }).map(async function(s) {
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
  var bookTitle = (req.body && req.body.title && String(req.body.title).trim()) ? String(req.body.title).trim() : '';
  // Cover pages are a SEPARATE artifact (the print order needs its own cover PDF, and the Library
  // listing carries its own cover image), so the published book is interior-only -- same stripping
  // the print interior does via nocover.
  var pageOpts = { publicMode: true, bookTitle: bookTitle, noCover: true };

  // Which render the reader chose on the Optimize tab: 'composed' = the optimized (After) book,
  // anything else = the original flow (Before) book. The optimized option is only offered once
  // Optimize has run, so its composed body is already cached -- we reuse it verbatim (byte-identical
  // to the After pane, no re-pack, no extra token) rather than recomputing it here.
  var _pubSrc = String((req.body && req.body.source) || req.query.source || 'flow');
  var html = null;
  if (_pubSrc === 'composed') {
    req.query.nocover = '1';
    req.query.publicMode = '1';
    if (bookTitle) req.query.bookTitle = bookTitle;
    var _pubHit = composedCacheGet(req.params.campaignId, req);
    if (!(_pubHit && _pubHit.body)) {
      return res.status(409).json({ error: 'optimize_required', message: 'Run Optimize on this book first, then publish the optimized layout.' });
    }
    try {
      var _pubBuilt = await assembleNovelHtml(req, req.params.campaignId, null, {
        arrange: _pubHit.arrange, packComposedBody: _pubHit.body, campaignName: _pubHit.campaignName || ''
      });
      html = _pubBuilt && _pubBuilt.html;
    } catch (e) {
      console.error('[publish-story] composed build failed:', (e && e.message) || e);
      html = null;
    }
    if (!html) return res.status(500).json({ error: 'Could not build the optimized layout. Re-run Optimize and try again.' });
  } else {
    html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  }
  var baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (baseUrl) html = html.replace('<head>', '<head><base href="' + baseUrl + '/">');

  let pdfBuffer;
  try {
    pdfBuffer = await renderHtmlToPdf(html, {});
  } catch (e) {
    console.error('[publish-story] render failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Could not render your story PDF. Please try again.' });
  }

  try {
    var _maxPP = await getAppSettingInt('max_pages_per_print', 250);
    var _ppCount = await countPdfPages(pdfBuffer);
    if (_ppCount > _maxPP) {
      return res.status(413).json({ error: 'PAGE_LIMIT', pages: _ppCount, maxPages: _maxPP, message: 'This book is ' + _ppCount + ' pages, which is over the current ' + _maxPP + '-page limit for a single book. To make it fit, open your Sessions list and uncheck some sessions using the "Include in Print" checkbox, then try again, or split it into multiple smaller books.' });
    }
  } catch (e) { console.error('[page-limit] count failed:', e && e.message ? e.message : e); }

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

  var title = bookTitle || campaign._memberBookTitle || campaign.name;
  var authorName = '';
  try {
    var meRow = await db.prepare('SELECT pen_name FROM users WHERE id = ?').get(req.session.userId);
    authorName = (meRow && meRow.pen_name) ? meRow.pen_name : '';
  } catch (e) {
    try { await logDebug(req.session.userId, { level: 'error', source: 'api', page: 'Publish to library', fn: 'POST /publish-story', message: 'Publish pen_name lookup failed (author blank): ' + (e && e.message), detail: { campaign_id: campaign.id } }); } catch (_le) {}
  }

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
      try { await logDebug(req.session.userId, { level: 'info', source: 'api', page: 'Publish to library', fn: 'POST /publish-story', message: 'Published story ' + _storyId + ': indexed ' + _urls.length + ' images', detail: { story_id: _storyId, campaign_id: campaign.id, images: _urls.length, has_cover: !!coverUrl } }); } catch (_le) {}
    }
  } catch (e) {
    console.error('[publish-story] image-index rebuild failed (non-fatal):', e && e.message ? e.message : e);
    try { await logDebug(req.session.userId, { level: 'error', source: 'api', page: 'Publish to library', fn: 'POST /publish-story', message: 'Publish image-index rebuild failed (non-fatal): ' + (e && e.message), detail: { campaign_id: campaign.id, note: 'story published but public page may be missing panel images' } }); } catch (_le) {}
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

// Assemble the same novel HTML the /novel export produces, for a campaign + request.
// Used by the isolated Layout-AI dry run so it critiques the REAL book, not a
// re-derivation. Deliberately mirrors the /novel route's gathering and is kept as a
// SEPARATE function (the live export route is left untouched) so the export path
// carries zero risk from this feature. Reuses buildNovelHTML, so the HTML is identical.
async function assembleNovelHtml(req, campaignId, overrides, extraCo) {
  const db = await getDb();
  const campaign = await db.prepare(
    'SELECT c.*, cm.role AS my_role, u.name AS owner_name FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id JOIN users u ON u.id = c.user_id WHERE c.id = ? AND cm.user_id = ?'
  ).get(campaignId, req.session.userId);
  if (!campaign) { const e = new Error('Access denied'); e.status = 403; throw e; }
  if (!campaign.cover_image_url && campaign.campaign_image_url) campaign.cover_image_url = campaign.campaign_image_url;

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaign.id);
  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; } catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) { return sessionDateKey(a).localeCompare(sessionDateKey(b)); });

  const asUser = req.query.as_user ? Number(req.query.as_user) : null;
  const _incMap = await effectiveIncludeMap(db, campaign.id, asUser);
  var _bmFork = asUser || (req.session && req.session.userId) || null;
  var _bmChooser = (req.session && req.session.userId) || _bmFork;
  if (_bmFork) {
    const _bm = await getForkBookPrefs(db, _bmChooser, _bmFork, campaign.id, { inherit: true });
    {
      // Resolve covers from the fork's own meta, else the campaign tile (the campaign
      // record cover_image_url is vestigial after the per-fork move -- never use it).
      var _fbm = _bm || {};
      campaign.cover_image_url = _fbm.cover_image_url || campaign.campaign_image_url || '';
      campaign.back_cover_image_url = _fbm.back_cover_image_url || '';
      campaign.title_image_url = _fbm.title_image_url || '';
      if (_fbm.book_title) campaign._memberBookTitle = _fbm.book_title;
    }
  }
  const sessionsWithData = await Promise.all(sessions.filter(function(s) { return _incMap[s.id]; }).map(async function(s) {
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

  const layoutStyle = req.query.layout || 'Classic';
  var pageOpts = {};
  if (req.query.nocover === '1') pageOpts.noCover = true;   // optimize/interior renders never include covers
  if (req.query.publicMode === '1') pageOpts.publicMode = true;   // published books mask real names to pen names
  if (req.query.bookTitle != null && String(req.query.bookTitle).trim()) pageOpts.bookTitle = req.query.bookTitle;
  if (req.query.titleColor != null && /^#[0-9a-fA-F]{3,8}$/.test(String(req.query.titleColor))) pageOpts.titleColor = String(req.query.titleColor);

  // Book-wide panel index (reading order): a manifest the AI keys its signals to, and the
  // hook for applying in-memory layout_meta overrides for the optimize PREVIEW. NOTHING here
  // is persisted -- overrides patch the in-memory moment objects for this one render only.
  var manifest = [];
  var beats = [];
  var _pidx = 0;
  var _ioIdx = 900000;   // separate id range for intro/outro text beats (keeps moment indices stable)
  var _coEarly = req.query.co ? parseCustomOpts(req.query.co) : null;
  var _wantMarkers = _coEarly ? !!_coEarly.markers : true;   // session dividers default on
  var _wantHeader = _coEarly ? !!_coEarly.header : true;     // running page header default on
  var _wantMarkerBreak = _wantMarkers && !!(_coEarly && _coEarly.markerbreak);
  sessionsWithData.forEach(function (sd, _sIdx) {
    if (_wantMarkers || _wantHeader) {
      // One boundary beat per session: the composer draws the divider when markers is on, and
      // always uses it to track which session each page belongs to (for the per-page running
      // header) and to suppress that header on the session-opening page.
      beats.push({ idx: ++_ioIdx, kind: 'section-header', title: (sd.name || ''), num: (_sIdx + 1), date: sd.session_date, showDivider: _wantMarkers, pageBreak: (_wantMarkerBreak && _sIdx > 0), shape: '', aspect: 1, hasImage: false, before: '', after: '' });
    }
    var _secs = [];
    try { _secs = sd.narrative_sections ? JSON.parse(sd.narrative_sections) : []; } catch (e) { _secs = []; }
    var _est = (sd.moments || []).find(function (m) { return m && m.kind === 'establishing'; });
    var _estImg = (_est && _est.image) ? _est.image : sd.establishing_image;
    if (_estImg) {
      var _tm = { image: _estImg, title: '', shape: (_est && _est.shape) || sd.establishing_shape || 'wide', img_w: (_est && _est.img_w) || sd.establishing_img_w || null, img_h: (_est && _est.img_h) || sd.establishing_img_h || null };
      beats.push({ idx: ++_ioIdx, kind: 'title', moment: _tm, shape: _tm.shape, aspect: (typeof momentAspect === 'function' ? (momentAspect(_tm) || 1) : 1), hasImage: true, before: '', after: '' });
    }
    if (sd.narrative_intro) beats.push({ idx: ++_ioIdx, kind: 'intro', shape: '', aspect: 1, hasImage: false, before: sd.narrative_intro, after: '' });
    (sd.moments || []).forEach(function (m, _j) {
      _pidx++;
      manifest.push({ idx: _pidx, title: String(m.title || '').slice(0, 60), shape: String(m.shape || '') });
      var _sec = (_secs || []).find(function (s) { return s.panel_index === _j; }) || {};
      if (m.kind !== 'establishing') beats.push({ idx: _pidx, moment: m, shape: String(m.shape || ''), aspect: (typeof momentAspect === 'function' ? (momentAspect(m) || 1) : 1), hasImage: !!m.image, before: _sec.before || '', after: _sec.after || '' });
      if (overrides && overrides[_pidx]) {
        var meta = lmMeta(m);
        meta = (meta && typeof meta === 'object') ? Object.assign({}, meta) : {};
        var ov = overrides[_pidx];
        if (ov.prominence != null) meta.prominence = ov.prominence;
        if (ov.focal != null) meta.focal = ov.focal;
        if (ov.crop_safe != null) meta.crop_safe = ov.crop_safe;
        if (ov.group_break != null) meta.group_break = ov.group_break;
        if (ov.flow != null) meta.flow = ov.flow;
        if (ov.scale != null) meta.scale = ov.scale;
        m.layout_meta = JSON.stringify(meta);
      }
    });
    if (sd.narrative_outro) beats.push({ idx: ++_ioIdx, kind: 'outro', shape: '', aspect: 1, hasImage: false, before: sd.narrative_outro, after: '' });
  });

  var co = req.query.co ? parseCustomOpts(req.query.co) : null;
  if (req.query.measurePaired === '1' || req.query.measurePaired === 'true') { co = co || {}; co.arrange = 'paired'; co.measurePaired = true; }
  if (req.query.measureMagazine === '1') { co = co || {}; co.measureMagazine = true; if (co.arrange !== 'magazine' && co.arrange !== 'gazette') co.arrange = 'magazine'; }
  if (req.query.measureComposed === '1') { co = co || {}; co.measureComposed = true; if (co.arrange !== 'magazine' && co.arrange !== 'gazette') co.arrange = 'magazine'; }
  if (req.query.mzCapFeatures === '1') { co = co || {}; co.mzCapFeatures = true; }
  if (req.query.mzFloatShrunk === '1') { co = co || {}; co.mzFloatShrunk = true; }
  else if (req.query.packRender === '1' || req.query.packRender === 'true') { co = co || {}; co.arrange = 'paired'; co.packStacked = true; }
  if (co) co.hideLogo = (accessRank(await getEffectiveTier(req.session.userId, campaign.id)) >= 4) && !!co.hidelogo;
  if (extraCo) { co = co || {}; for (var _k in extraCo) { if (Object.prototype.hasOwnProperty.call(extraCo, _k)) co[_k] = extraCo[_k]; } }
  const html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  return { campaign: campaign, html: html, layoutStyle: layoutStyle, sessionCount: sessionsWithData.length, manifest: manifest, co: co, beats: beats };
}

// PHASE 3 (page-packer) v1: render the packed book. Measure -> pack -> feed the packer's
// per-beat image shrink factors into the SAME override apply path the optimize uses, then
// render normally. Deterministic (no AI, no missed gaps). Isolated route; the live export is
// untouched. (v1 applies shrinks + lets the engine reflow; exact page-break pagination is next.)
router.get('/novel-packed/:campaignId', requireAuth, async function (req, res) {
  try {
    // 1) measure narration heights
    req.query.measurePaired = '1';
    var measBuilt = await assembleNovelHtml(req, req.params.campaignId, null);
    var measured = await measureDocument(measBuilt.html, {});
    delete req.query.measurePaired;
    var blocks = measured.blocks || [];
    var pageH = 9.7;
    // 2) align measured text to beats, add analytic image heights, pack
    var bi = 0;
    var packBeats = (measBuilt.beats || []).map(function (beat) {
      var tb = 0, ta = 0;
      if (beat.before) { tb = (blocks[bi] && blocks[bi].heightIn) || 0; bi++; }
      if (beat.after) { ta = (blocks[bi] && blocks[bi].heightIn) || 0; bi++; }
      return { idx: beat.idx, shape: beat.shape, hasImage: beat.hasImage, imageH: beat.hasImage ? beatImageHeight(beat, pageH) : 0, textBeforeH: tb, textAfterH: ta, isTower: ((beat.aspect || 1) <= 0.42) };
    });
    var plan = packPaired(packBeats, { pageHeightIn: pageH });
    // 3) per-beat shrink factors -> overrides (same shape the optimize builds)
    var overrides = {};
    plan.pages.forEach(function (pg) {
      (pg.placements || []).forEach(function (pl) {
        if (pl.kind === 'image' && pl.scale && pl.scale < 0.999) overrides[pl.beat] = { scale: Math.round(pl.scale * 1000) / 1000 };
      });
    });
    // 4) render normally with the packer's deterministic shrinks applied
    var built = await assembleNovelHtml(req, req.params.campaignId, overrides);
    if (req.query.debug === '1') { return res.json({ plan_pages: plan.pageCount, images_shrunk: plan.imagesShrunk, overrides_applied: Object.keys(overrides).length, total_white_in: plan.totalWhiteIn }); }
    var buf = await renderHtmlToPdf(built.html, {});
    res.set('Content-Type', 'application/pdf');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'novel-packed failed' });
  }
});

// PHASE 2 (page-packer): analytic image display height for a beat in the paired layout.
// Portraits float narrow (~4.6in wide); non-portraits sit ~full content width. Height is
// width / aspect, capped to a page. (Float text-beside footprint is a Phase 3 refinement.)
function beatImageHeight(beat, pageH) {
  // Use the DISPLAY aspect (the ratio the image is actually rendered with by coMedia), not the
  // raw pixel aspect. The composer sizes the rendered box by dispAspect; if the packer computed
  // height from a different (pixel) aspect, the two disagree and the page clips. Prefer the
  // moment's display aspect; fall back to the stored beat.aspect only when no moment is present.
  var aspect = (beat && beat.moment) ? dispAspect(beat.moment) : ((beat && beat.aspect) || 1);   // width / height (display)
  // Picture Book MAXIMIZES: the biggest the image can be while fitting the content width
  // (6.8in) and one page. The height cap must be the USABLE box, never taller -- a full-height
  // image at the old 9.3/9.5 caps already exceeded the 9.16in content box (header band eats the
  // rest) and clipped on its own. Cap at the passed page budget (pageH is the packer's usable
  // height ~9.16) so no single image can be taller than the box. Falls back to 9.16 if unknown.
  var h = 6.8 / (aspect || 1);
  var _box = (pageH && pageH > 1) ? pageH : 9.16;
  var cap = Math.min((aspect <= 0.42) ? 9.5 : 9.3, _box);
  return Math.min(cap, Math.max(1.2, h));
}
// PHASE 3 (page-packer): measure a paired book's text, compute image heights, run the
// packer, and return { plan, overrides }. Overrides carry the per-beat image scale the
// packer chose, ready to apply through the normal override render path.
async function computePairedPack(req, campaignId, packOpts) {
  req.query.measurePaired = '1';
  var mbuilt = await assembleNovelHtml(req, campaignId, null);
  var blocks = (await measureDocument(mbuilt.html, {})).blocks || [];
  delete req.query.measurePaired;
  var pageH = 9.7;
  // Decoration costs from the registry. Line height is taken from the measure pass so any
  // font-relative decoration costs scale with font size automatically. Per-image overhead =
  // the active frame + the image margins; captions/etc. will add to this per beat later.
  var _dco = req.query.co ? parseCustomOpts(req.query.co) : {};
  var _border = _dco.border || 'frame';
  var _lh = DEFAULT_LH;
  for (var _li = 0; _li < blocks.length; _li++) { if (blocks[_li].lines && blocks[_li].lines.length >= 2) { _lh = Math.round((blocks[_li].lines[1] - blocks[_li].lines[0]) * 1000) / 1000; break; } }
  var _imgOver = decoSumHeight(['frame:' + _border, 'image-margin'], _lh);
  var _caption = _dco.caption || 'bar';
  var _capBelowH = (_caption === 'bar' || _caption === 'engraved') ? decoHeight('caption:below', _lh) : 0;   // below-image title reserves height; on-image (plate/gradient) captions are inside/free
  // Lockstep alignment (measured blocks are in reading order, as are the beats). If the
  // index runs past the measured blocks (a slight section-set mismatch), fall back to an
  // estimated height from the text length -- NEVER zero, so a beat can't be packed weightless
  // and then clipped (which dropped the last page).
  function estTextH(len) { return Math.max(0.3, 0.28 + (Number(len) || 0) / 360 * 1.9); }
  var bi = 0;
  function takeBlock(expectedLen) {
    // Match this beat's text to the measured block with the same char count, scanning a small
    // window forward to resync if the sets drift. Returns null (-> height estimate, whole block,
    // NO split) rather than consuming a wrong block -- so a split can never land on wrong offsets.
    for (var k = bi; k < Math.min(bi + 6, blocks.length); k++) {
      if (Math.abs((blocks[k].chars || 0) - expectedLen) <= 2) { bi = k + 1; return blocks[k]; }
    }
    return null;
  }
  var packBeats = (mbuilt.beats || []).map(function (beat, _mi) {
    if (beat.kind === 'section-header') {
      var _nb = (mbuilt.beats || [])[_mi + 1];   // the session's opening image beat (title / establishing)
      var _nih = (_nb && _nb.hasImage) ? beatImageHeight(_nb, pageH) : 0;
      return { idx: beat.idx, kind: 'section-header', headerH: beat.showDivider ? decoHeight('section-header', _lh) : 0, showDivider: !!beat.showDivider, pageBreak: !!beat.pageBreak, hasImage: false, nextImageH: _nih };
    }
    var tb = 0, ta = 0, bl = null, al = null, blc = null, alc = null;
    if (beat.before) { var _b1 = takeBlock(String(beat.before).length); tb = (_b1 && _b1.heightIn) || estTextH(String(beat.before).length); bl = _b1 && _b1.lines; blc = _b1 && _b1.lineChars; }
    if (beat.after) { var _b2 = takeBlock(String(beat.after).length); ta = (_b2 && _b2.heightIn) || estTextH(String(beat.after).length); al = _b2 && _b2.lines; alc = _b2 && _b2.lineChars; }
    return { idx: beat.idx, shape: beat.shape, aspect: (beat.aspect || 1), hasImage: beat.hasImage, imageH: beat.hasImage ? beatImageHeight(beat, pageH) : 0, imgOver: beat.hasImage ? (_imgOver + ((beat.moment && beat.moment.title) ? _capBelowH : 0)) : 0, capBelowH: (beat.hasImage && ((beat.aspect || 1) <= 0.42) && beat.moment && beat.moment.title) ? _capBelowH : 0, textBeforeH: tb, textAfterH: ta, beforeLines: bl, afterLines: al, beforeLineChars: blc, afterLineChars: alc, beforeLen: (beat.before || '').length, afterLen: (beat.after || '').length, isTower: ((beat.aspect || 1) <= 0.42) };
  });
  // Reserve a top band for the per-page running header (when on) by lowering the packer's usable
  // page height, leaving the existing bottom safety buffer intact so nothing clips. The header
  // renders inside the reserved band, never over the body.
  var _hdrOn = (_dco.header == null) ? true : !!_dco.header;
  var _basePackH = (packOpts && packOpts.pageHeightIn != null) ? packOpts.pageHeightIn : pageH;
  var plan = packPaired(packBeats, Object.assign({}, packOpts || {}, { pageHeightIn: _basePackH - (_hdrOn ? HEADER_BAND_IN : 0) }));
  var overrides = {};
  plan.pages.forEach(function (pg) { pg.placements.forEach(function (pl) {
    if (pl.kind === 'image' && pl.scale != null && pl.scale < 0.999) overrides[pl.beat] = { scale: pl.scale };
  }); });
  // Optional diagnostics: re-measure the composed paired book for real per-page heights + the
  // never-clip check (parallel to the magazine dbg). Only when debug is requested, so normal
  // renders pay nothing.
  var _pdbg = null;
  if (packOpts && packOpts.debug) {
    var _pco = Object.assign({}, _dco, { paper: 'white', campaignName: (mbuilt.campaign && mbuilt.campaign.name) || '' });
    var _realP = await remeasureComposedPaired(req, campaignId, plan, mbuilt.beats, _pco);
    _pdbg = { pages: [], overflows: [], atRisk: [], remeasured: !_realP._error, remeasureError: _realP._error || null, beatText: [] };
    // Per-beat text measurement diagnostic: shows whether the split-slice heights have real line
    // data or fell back to estTextH, and the measured lines-per-char, so a compressed/bad measure
    // is visible directly.
    packBeats.forEach(function (bt) {
      if (!bt || (!bt.beforeLen && !bt.afterLen)) return;
      var _bl = bt.beforeLines || null, _al = bt.afterLines || null;
      var _blc = bt.beforeLineChars || null, _alc = bt.afterLineChars || null;
      _pdbg.beatText.push({ idx: bt.idx,
        beforeLen: bt.beforeLen || 0, beforeLines: (_bl ? _bl.length : 0), beforeH: Math.round((bt.textBeforeH || 0) * 100) / 100, beforeSpan: (_bl && _bl.length ? Math.round(_bl[_bl.length - 1] * 100) / 100 : null), beforeFallback: !_bl,
        beforeYs: (_bl ? _bl.map(function (y) { return Math.round(y * 100) / 100; }) : null), beforeChars: (_blc ? _blc.slice() : null),
        afterLen: bt.afterLen || 0, afterLines: (_al ? _al.length : 0), afterH: Math.round((bt.textAfterH || 0) * 100) / 100, afterSpan: (_al && _al.length ? Math.round(_al[_al.length - 1] * 100) / 100 : null), afterFallback: !_al,
        afterYs: (_al ? _al.map(function (y) { return Math.round(y * 100) / 100; }) : null), afterChars: (_alc ? _alc.slice() : null) });
    });
    (plan.pages || []).forEach(function (pg, pi) {
      var est = 0;
      (pg.placements || []).forEach(function (pl) {
        var b = null; for (var _bi = 0; _bi < packBeats.length; _bi++) { if (packBeats[_bi].idx === pl.beat) { b = packBeats[_bi]; break; } }
        if (!b) return;
        if (pl.kind === 'image' || pl.kind === 'tower') est += (b.imageH || 0) + (b.imgOver || 0) + (b.capBelowH || 0);
        else if (pl.kind === 'narr') est += (pl.part === 'after') ? (b.textAfterH || 0) : (b.textBeforeH || 0);
        else if (pl.kind === 'section-header') est += (b.headerH || 0);
      });
      var real = (_realP[pi] != null) ? _realP[pi] : null;
      _pdbg.pages.push({ page: pi, used: Math.round(est * 100) / 100, realUsed: real,
        placements: (pg.placements || []).map(function (pl, _ci) { var _rc = (_realP._cells && _realP._cells[pi + ':' + _ci] != null) ? _realP._cells[pi + ':' + _ci] : null; return { kind: pl.kind, beat: pl.beat, part: pl.part || null, scale: (pl.scale != null ? pl.scale : null), charStart: (pl.charStart != null ? pl.charStart : null), charEnd: (pl.charEnd != null ? pl.charEnd : null), heightIn: (pl.heightIn != null ? pl.heightIn : null), realH: _rc, fullH: (pl.fullH != null ? pl.fullH : null) }; }) });
    });
    _pdbg.overflows = _realP._overflows || [];
    var _riskGap = 0.4;
    _pdbg.pages.forEach(function (pg) {
      if (pg.realUsed == null) return;
      var gap = pg.realUsed - pg.used;
      var over = _pdbg.overflows.some(function (o) { return o.page === pg.page; });
      if (!over && gap > _riskGap) _pdbg.atRisk.push({ page: pg.page, realIn: pg.realUsed, estIn: pg.used, gapIn: Math.round(gap * 1000) / 1000 });
    });
  }
  return { plan: plan, overrides: overrides, campaign: mbuilt.campaign, beatCount: packBeats.length, beats: mbuilt.beats, dbg: _pdbg };
}
// PHASE 3 (page-packer) render: apply the packer's chosen image scales through the normal
// override render path and return the packed PDF. Chromium flows text + splits paragraphs;
// the packer only decides image sizes. Body-only preview (default styling) for judging density.
// ROAD B (page-packer) LITERAL COMPOSER: build the page body from the packer's plan, one
// page at a time. Each plan page becomes a content-page div with a hard break after it, so
// the browser never re-paginates -- towers can't split, gaps are exactly what the packer set.
// Increment 1: whole text blocks (noSplit); paragraph-level split is the next increment.
function composeBook(plan, beats, opts) {
  opts = opts || {};
  var byIdx = {};
  (beats || []).forEach(function (b) { byIdx[b.idx] = b; });
  var out = '';
  var pages = (plan && plan.pages) || [];
  var headerOn = (opts && opts.header != null) ? !!opts.header : true;   // running page header default on
  var bandCss = headerOn ? ('padding-top:' + HEADER_BAND_IN + 'in;') : '';   // reserved header band (matches packer target)
  var campName = (opts && opts.campaignName) || '';
  var curNum = null, curTitle = '';   // running session context for the per-page header
  var panelN = 0;   // per-session panel counter for the 'bar' caption's "Panel N" label
  pages.forEach(function (pg, pi) {
    // A session-opening page carries a section-header placement; advance the running session
    // context here and suppress the per-page running header on this page.
    var openBeat = null, hasDivider = false;
    (pg.placements || []).forEach(function (pl) {
      if (pl.kind === 'section-header') { var hb = byIdx[pl.beat]; if (hb) { openBeat = hb; if (hb.showDivider) hasDivider = true; } }
    });
    if (openBeat) { curNum = openBeat.num; curTitle = openBeat.title; panelN = 0; }
    var inner = '';
    // Suppress the running header only where a visible divider already announces the session.
    if (headerOn && !hasDivider && curNum != null) inner += runningHeaderHTML(campName, curNum, curTitle);
    var _ci = -1;
    (pg.placements || []).forEach(function (pl) {
      _ci += 1;
      var b = byIdx[pl.beat];
      if (!b) return;
      var m = b.moment;
      var _phStart = inner.length;   // remember where this placement's html begins (to wrap it when measuring)
      if (pl.kind === 'section-header') {
        if (b.showDivider) inner += sessionMarkerHTML(b.num, b.title, b.date);
      } else if (pl.kind === 'tower' && m && m.image) {
        var asp = momentAspect(m) || 1;
        var _twCap = (m.title && (opts.caption === 'bar' || opts.caption === 'engraved')) ? 8.8 : 9.3;   // titled tower: shrink ~0.5in so the below title bar isn't clipped
        var tw = Math.min(6.8 - 2.6, Math.min(9.2, _twCap) * asp);
        if ((tw / asp) > _twCap) tw = _twCap * asp;
        var _tpi = panelN; panelN += 1;
        inner += '<div style="display:flow-root;margin-bottom:0.1in;break-inside:avoid;page-break-inside:avoid;">' +
          '<div style="float:left;margin:0 0.24in 0.12in 0;width:' + tw.toFixed(2) + 'in;">' +
            '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + coCaptionOverlay(m, opts.caption) + '</div>' + coCaptionBelow(m, _tpi, opts.caption) + '</div>' +
          '<div style="display:flow-root;">' +
            (b.before ? '<div style="margin-bottom:0.1in;">' + coNarr(b.before, opts, false) + '</div>' : '') +
            (b.after ? '<div>' + coNarr(b.after, opts, false) + '</div>' : '') +
          '</div></div>';
      } else if (pl.kind === 'image' && m && m.image) {
        // Size with the DISPLAY aspect (what coMedia's aspect-box actually renders with), so the
        // width we set produces exactly the packer's intended height. Using momentAspect (raw pixel
        // ratio) here diverged from the rendered dispRatioCSS box and the page clipped by 1-3in.
        var asp = dispAspect(m) || 1;
        // Honor the PACKER'S height (fullH*scale). coMedia derives height from width via aspect, so
        // setting width = height*asp yields the intended height; the column cap can only make it
        // SHORTER (never taller), so the page can never clip.
        var _visH = (pl.fullH != null ? pl.fullH : beatImageHeight(b, 9.16)) * (pl.scale != null ? pl.scale : 1);
        var w = Math.min(6.8, Math.round(_visH * asp * 1000) / 1000);   // inline round (round3 is not in this scope)
        var _ipi = panelN; panelN += 1;
        inner += '<div style="margin:0.05in auto 0.13in;width:' + w.toFixed(2) + 'in;break-inside:avoid;page-break-inside:avoid;">' +
          '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + coCaptionOverlay(m, opts.caption) + '</div>' + coCaptionBelow(m, _ipi, opts.caption) + '</div>';
      } else if (pl.kind === 'narr') {
        var full = (pl.part === 'after') ? b.after : b.before;
        if (full) {
          var seg = full;
          var isCont = false;
          if (pl.charStart != null || pl.charEnd != null) {
            var cs = Math.max(0, Math.min(pl.charStart || 0, full.length));
            var ce = (pl.charEnd != null) ? Math.max(cs, Math.min(pl.charEnd, full.length)) : full.length;
            seg = full.slice(cs, ce);
            isCont = cs > 0;
          }
          if (seg) {
            var rendered = coNarr(seg, opts, (b.kind === 'intro' || b.kind === 'outro')).replace('margin:0.15in 0', 'margin:0');   // intro & outro italic (matches flow render); gives the drop cap a clean line
            if (isCont) rendered = rendered.replace('text-indent:0.3in', 'text-indent:0');   // continuation of a split paragraph: no indent
            if (opts.dropcap && b.kind === 'intro' && !isCont) rendered = coDropcap(rendered.replace('text-indent:0.3in', 'text-indent:0'));   // drop cap replaces the first-line indent on each session's opening paragraph
            inner += '<div style="margin-top:0.1in;">' + rendered + '</div>';
          }
        }
      }
      // Per-placement cc: marker (measure pass only): wrap exactly the html this placement added,
      // so the re-measure reports each cell's true rendered height -- the definitive per-slice data.
      if (opts && opts.measureComposed && inner.length > _phStart) {
        var _phHtml = inner.slice(_phStart);
        inner = inner.slice(0, _phStart) + '<div data-mblk="cc:' + pi + ':' + _ci + '" data-mkind="ccell">' + _phHtml + '</div>';
      }
    });
    var brk = (pi < pages.length - 1) ? 'page-break-after:always;' : '';
    // When measuring the composed output, tag each page's content with a cp: marker so the shared
    // re-measure can read true paired page heights (same mechanism the magazine composer uses).
    var _pgInner = (opts && opts.measureComposed)
      ? '<div data-mblk="cp:' + pi + '" data-mkind="cpage" style="display:flow-root;">' + inner + '</div>'
      : inner;
    out += '<div class="content-page" style="height:9.65in;' + bandCss + 'overflow:hidden;margin:0;' + brk + 'position:relative;">' + _pgInner + '</div>';
  });
  return out;
}

// Magazine/Gazette deterministic pack (Phase 1: whole-band greedy pagination; no split/resize
// yet). Measures every band's rendered height, then fills fixed-height pages in order -- a band
// that would overflow the current page starts a new one. Isolated behind ?compose=1 + arrange,
// so the flow render stays the safe fallback. NOTE: _mzBands is module-level, so two concurrent
// magazine composes could interleave; acceptable for the deliberate one-shot Optimize action.
// Extract band heights (keyed by global index) from a measureDocument() result.
function magazineMeasure(blocks) {
  var m = { h: {}, lines: {}, lineChars: {} };
  (blocks || []).forEach(function (bk) {
    var id = bk.id || '';
    if (id.indexOf('mzb:') !== 0) return;
    var idx = parseInt(id.slice(4), 10);
    m.h[idx] = bk.heightIn || 0;
    if (bk.lines && bk.lines.length) m.lines[idx] = bk.lines;
    if (bk.lineChars && bk.lineChars.length) m.lineChars[idx] = bk.lineChars;
  });
  return m;
}
// Greedy pagination with the marker+title keep-together rule AND line-level splitting for pure-text
// (intro/outro) bands: when such a band overflows the room left on a page, it is cut at the last
// whole measured line that fits and the remainder continues -- full width, re-wrapping identically,
// so the measured line data stays exact -- on the next page (and may split again). Placements carry
// a char range {cStart,cEnd} that composeMagazine slices out of the band's raw text (b.stext).
function packMagazineBands(bands, meas, pageH, markerBreak, growMap, splitAllow) {
  var bandH = meas.h;
  var pages = [], cur = [], used = 0;
  var round3 = function (n) { return Math.round(n * 1000) / 1000; };
  function flush() { if (cur.length) { pages.push(cur); cur = []; used = 0; } }
  function placeWhole(it) {
    cur.push({ band: it.band, heightIn: it.height, cStart: it.cStart, cEnd: it.cEnd, split: (it.cStart > 0 || it.cEnd != null), imgBody: !!it.imgBody });
    used += it.height;
  }
  // Worklist so a split tail can be re-processed (and split again if it is still too tall).
  var work = [];
  for (var i = 0; i < bands.length; i++) {
    var h0 = bandH[i] || 0;
    if (h0 <= 0.001) continue;   // empty intro/outro band -- skip
    var bd = bands[i];
    var lc = meas.lineChars[i] || null, ln = meas.lines[i] || null;
    // Alignment guard: char offsets must index within the band's raw text -- if a stray <p> ever
    // slipped into the measure, drop the line data so the band stays atomic (never corrupt text).
    if (bd.stext != null && lc && lc.length && lc[lc.length - 1] > bd.stext.length + 4) { lc = null; ln = null; }
    work.push({ band: i, cStart: 0, cEnd: null, height: h0, lines: ln, lineChars: lc, simg: !!bd.simg, sImgH: bd.sImgH || 0, stextLen: (bd.stext != null ? bd.stext.length : 0) });
  }
  // Leading-text spill: when a panel's IMAGE can't fit the leftover gap on the current page, the whole
  // panel normally jumps to the next page and leaves that gap white. Instead, drop the panel's BEFORE
  // paragraph into the gap as standalone text and let the image lead the next page at FULL size (Ian:
  // a beat's text may sit right before its image). Estimates are full-width (widest measured line) and
  // conservative -- if the before won't cleanly fit the gap, or image+after won't fit one page, we bail
  // and fall back to today's behavior. No image is ever shrunk here.
  function trySpill(it, R) {
    if (!it.simg || it.cStart !== 0 || !it.lines || !it.lineChars || it.lines.length < 2) return false;
    var bb = bands[it.band];
    if (!bb || bb.mbound == null || R < MZ_SPILL_MIN_GAP) return false;
    var wideC = 0; for (var q = 1; q < it.lineChars.length; q++) { var dd = it.lineChars[q] - it.lineChars[q - 1]; if (dd > wideC) wideC = dd; }
    var lh = (it.lines[it.lines.length - 1] - it.lines[0]) / (it.lines.length - 1);
    if (!(wideC > 8) || !(lh > 0.05)) return false;
    // Consolidating spill: the panel's WHOLE before-paragraph drops into the gap, and image + after go
    // on ONE next page (no fragmenting). Only fires when the before fits the gap AND image+after fits a
    // page; otherwise bail to today's behavior. The picture is never shrunk.
    var beforeLines = Math.ceil(bb.mbound / wideC);
    if (beforeLines < MZ_SPILL_MIN_LINES) return false;
    var leadH = round3(beforeLines * lh + MZ_SPLIT_PAD);
    if (leadH > R - 0.2) return false;
    var afterLines = Math.ceil(Math.max(0, it.stextLen - bb.mbound) / wideC);
    var bodyH = round3(it.sImgH + afterLines * lh + 0.2);
    if (bodyH > pageH - 0.2) return false;
    cur.push({ band: it.band, heightIn: leadH, cStart: 0, cEnd: bb.mbound, split: true, textLead: true });
    used += leadH; flush();
    cur.push({ band: it.band, heightIn: bodyH, cStart: bb.mbound, cEnd: null, split: true, imgBody: true });
    used += bodyH;
    return true;
  }
  for (var w = 0; w < work.length; w++) {
    var it = work[w];
    var b = bands[it.band];
    var kind = b.kind;
    var keepWith = (kind === 'session-header' && bands[it.band + 1] && bands[it.band + 1].kind === 'title-image') ? (bandH[it.band + 1] || 0) : 0;
    if (markerBreak && kind === 'session-header' && cur.length) flush();
    var canSplit = b.stext != null && it.lines && it.lineChars && it.lines.length >= 2 &&
      it.lineChars.length === it.lines.length && (kind === 'intro' || kind === 'outro' || kind === 'float' || kind === 'wide' || kind === 'feature') &&
      !(growMap && growMap[it.band] && !(splitAllow && splitAllow[it.band]));   // sized bands stay whole EXCEPT gap-fit shrinks, which were shrunk precisely so they CAN split into a gap
    // A float head must clear the floated image (sImgH) so the continuation re-wraps clean full-width;
    // pure text (intro/outro or a float TAIL, simg=false) can cut at any line past a small minimum.
    var minB = it.simg ? (it.sImgH + (((kind === 'wide' || kind === 'feature') || (splitAllow && splitAllow[it.band])) ? 0.05 : 0.4)) : 0.5;   // wide/feature narrative sits ENTIRELY below the image -> cut just under it (a full-page-tall image can still split instead of clipping); floats keep 0.4in clearance for their beside-text   // gap-fit shrinks cut right below the (now-small) image; normal floats keep 0.4in clearance
    // ANTI-SLIVER: never leave a single lonely line on a page. A cut is only allowed if BOTH the head
    // and the tail carry >= MZ_MIN_SLICE_LINES lines; a sliver TAIL pulls the cut back (free -- same
    // pages, just a better boundary), and a sliver HEAD rejects the cut entirely (-1), which makes the
    // caller flush and move the whole band to the next page. A band TALLER than a page must still split
    // (else it would clip), so the guard is skipped there.
    // The synthesized line array ends with a TERMINAL MARKER at stextLen -- pushed by
    // fillMissingMagazineLines so a head can claim the whole text when it fits. It is not a line
    // of type. Counting it as one is what let a tail carrying a single real line slip past the
    // anti-sliver rule below, and cutting AT the marker leaves an empty tail cell.
    // NOTE: this runs for EVERY band, including image-only ones (session headers, title images,
    // towers) whose line data is null -- so it must not dereference it.lines unguarded.
    var _lineN = (it.lines && it.lines.length) ? it.lines.length : 0;
    var _termIdx = (it.lineChars && it.lineChars.length && it.stextLen &&
      (it.cStart + it.lineChars[it.lineChars.length - 1]) >= it.stextLen) ? (it.lineChars.length - 1) : -1;
    var _realTotal = (_termIdx >= 0) ? _lineN - 1 : _lineN;
    function splitAt(room) {
      var Lx = -1;
      for (var q = 0; q < _realTotal - 1; q++) { if (it.lines[q] <= room - MZ_SPLIT_PAD && it.lines[q] >= minB) Lx = q; }
      if (Lx < 0) return Lx;
      var total = _realTotal;
      // A band taller than a page MUST split (a refusal would clip it), but that is no reason to
      // accept a bad boundary: this used to return immediately, so the last cut of a long text band
      // could strand a single line -- famously just the closing full stop, which then rendered as a
      // whole empty parchment box of its own. Still always return a cut; just prefer one that leaves
      // the tail at least MZ_MIN_SLICE_LINES lines when the geometry allows it.
      if (it.height > pageH - 0.05) {
        if (total - (Lx + 1) < MZ_MIN_SLICE_LINES) {
          var _Lb = Math.min(Lx, total - MZ_MIN_SLICE_LINES - 1);
          if (_Lb >= 0 && it.lines[_Lb] >= minB) Lx = _Lb;   // pull back only if the head still clears its image
        }
        return Lx;
      }
      if (total - (Lx + 1) < MZ_MIN_SLICE_LINES) {                    // sliver TAIL -> pull the cut back
        Lx = Math.min(Lx, total - MZ_MIN_SLICE_LINES - 1);
        if (Lx < 0 || it.lines[Lx] < minB) return -1;
      }
      if (Lx + 1 < MZ_MIN_SLICE_LINES) return -1;                     // sliver HEAD -> don't split at all
      return Lx;
    }
    // Pick a cut for `room`, then SANITIZE it: never mid-word, never between a word and the
    // punctuation that closes it, and never leaving a tail too small to deserve a page of its own
    // (in Gazette, a parchment box of its own). Steps the cut back a whole line at a time until
    // the tail is substantial, and returns null when nothing acceptable exists -- the caller then
    // moves the band whole. Used as BOTH the can-we-split predicate and the actual cut, so the
    // two can never disagree. A band taller than a page must still split (refusing would clip
    // it), so it falls back to the best sanitized cut available.
    function chooseCut(room) {
      var _must = (it.height > pageH - 0.05);
      var _fb = null, _L = splitAt(room);
      while (_L >= 0) {
        var _c = mzSnapSentence(b.stext, b.mbound, it.cStart, it.cStart + it.lineChars[_L + 1]);
        _c = mzSafeCut(b.stext, _c);
        if (_c > it.cStart + 45 && _c < it.stextLen) {
          if (_fb == null) _fb = { L: _L, cEnd: _c };
          if ((it.stextLen - _c) >= MZ_MIN_TAIL_CHARS) return { L: _L, cEnd: _c };
        }
        _L--;
        if (_L >= 0 && (it.lines[_L] < minB || _L + 1 < MZ_MIN_SLICE_LINES)) break;   // stepping back further would leave the head below its image, or a sliver head
      }
      return _must ? _fb : null;
    }
    var R = pageH - used;
    // If it overflows the room left and can neither split into that room nor sit here, move to a fresh page first.
    if (cur.length && (it.height + keepWith) > R + 1e-6) {
      if (!(canSplit && chooseCut(R))) {
        if (trySpill(it, R)) continue;   // dropped the before-text into the gap; image + after queued on the next page
        flush(); R = pageH;
      }
    }
    if ((it.height + keepWith) <= R + 1e-6) { placeWhole(it); continue; }   // fits
    if (canSplit) {
      var _cut = chooseCut(R);
      var L = _cut ? _cut.L : -1;
      if (L >= 0) {
        var cEnd = _cut.cEnd;
        var headH = round3(it.lines[L] + MZ_SPLIT_PAD);   // the rendered slice carries the paragraph's bottom margin beyond the last line
        // The sentence snap and the word/punctuation sanitizer both ran inside chooseCut above, so
        // cEnd is already a clean boundary here. Head keeps its reserved height (a little extra
        // white is fine); the tail gets the pulled-back text and re-derives its lines.
        cur.push({ band: it.band, heightIn: headH, cStart: it.cStart, cEnd: cEnd, split: true, imgBody: !!it.imgBody });
        used += headH; flush();
        var _rel = cEnd - it.cStart;
        var tLines = [], tChars = [];
        for (var lj = 0; lj < it.lineChars.length; lj++) {
          if (it.lineChars[lj] >= _rel) { tChars.push(it.lineChars[lj] - _rel); tLines.push(round3(it.lines[lj] - it.lines[L])); }
        }
        if (!tChars.length || tChars[0] > 0) { tChars.unshift(0); tLines.unshift(0); }
        work.splice(w + 1, 0, { band: it.band, cStart: cEnd, cEnd: null, height: round3(it.height - it.lines[L] + MZ_SPLIT_PAD + 0.32), lines: tLines, lineChars: tChars, simg: false, sImgH: 0, stextLen: it.stextLen });
        continue;
      }
    }
    placeWhole(it);   // not splittable (or not even one line fits) and taller than a page -> place whole (rare; may clip)
  }
  flush();
  return pages;
}

// The browser measure sometimes captures only a panel's FIRST narrative paragraph (the `before`),
// leaving the `after` half with no line positions -- so the packer can't cut there and the whole
// `after` is stranded on the next page (big white). If a splittable band's line data stops well
// short of its text, extend it: reuse the measured line-height and chars-per-line to lay out the
// remaining characters below the last measured line, up to the band's true measured height. The
// positions are an estimate, but SPLIT_PAD buffers them and it turns "can't cut" into "can cut".
function fillMissingMagazineLines(meas, bands) {
  if (!meas || !meas.lines || !meas.lineChars) return;
  function snapWord(t, c) {
    if (c <= 1 || c >= t.length - 1) return c;
    for (var d = 0; d <= 20; d++) {
      if (/\s/.test(t.charAt(c + d))) return c + d;
      if (/\s/.test(t.charAt(c - d))) return c - d;
    }
    return c;
  }
  for (var i = 0; i < bands.length; i++) {
    var b = bands[i]; if (!b || b.stext == null) continue;
    var ln = meas.lines[i], lc = meas.lineChars[i];
    if (!ln || !lc || ln.length < 2 || ln.length !== lc.length) continue;
    var S = b.stext.length;
    if (lc[lc.length - 1] >= S - 24) continue;                       // already reaches the text end
    var span = (ln[ln.length - 1] - ln[0]) / (ln.length - 1);        // in/line (measured)
    // FULL-WIDTH chars/line = the WIDEST measured line. The unmeasured `after` wraps full-width below
    // the image, so its lines are this wide; using the widest measured line makes the synthesized line
    // boundaries land on REAL line ends (not mid-line), so cuts never chop a line short.
    var wide = 0; for (var q = 1; q < lc.length; q++) { var d = lc[q] - lc[q - 1]; if (d > wide) wide = d; }
    if (!(span > 0.05) || !(wide > 8)) continue;
    // Start the `after` at the true paragraph boundary (mbound). Push mbound itself UN-snapped as the
    // first synthesized line-start, so a split between the before and the after cuts cleanly ON the
    // boundary -- never snapping forward past the after's first word and orphaning it onto the head.
    var y = ln[ln.length - 1];
    var atMB = (b.mbound != null && b.mbound > lc[lc.length - 1] + 2 && b.mbound < S);
    var c;
    if (atMB) {
      y = Math.round((y + span) * 1000) / 1000;
      ln.push(y); lc.push(b.mbound);
      c = b.mbound + wide;
    } else {
      c = lc[lc.length - 1] + wide;
    }
    var guard = 0;
    while (c < S && guard++ < 400) {
      var cs = snapWord(b.stext, Math.min(S, c));
      if (cs <= lc[lc.length - 1]) cs = Math.min(S, lc[lc.length - 1] + 1);
      // END DEAD ZONE: a synthesized boundary this close to the end of the text is never a
      // useful cut -- it can only strand a word or a lone full stop in a box of its own. It is
      // also the one place snapWord gives up and returns the offset unsnapped (its own
      // `c >= t.length - 1` early return), so these were the only boundaries in the array that
      // could sit mid-word. Stop short and let the terminal marker below be the sole end entry.
      if (cs > S - MZ_TAIL_DEADZONE) break;
      y = Math.round((y + span) * 1000) / 1000;
      ln.push(y); lc.push(cs);
      if (cs >= S) break;
      c = cs + wide;
    }
    // ensure a cut point exists at the very end so the head can take the whole `after` when it fits
    if (lc[lc.length - 1] < S) { ln.push(Math.round((y + span) * 1000) / 1000); lc.push(S); }
  }
}

// Re-measure the REAL composed pages: returns { pageIndex: realHeightIn } (plus ._error on failure).
// Same machinery as the band measure, aimed at the composed output (measureComposed -> cp:N markers).
async function remeasureComposedPages(req, campaignId, pgs, bnds) {
  var realH = {};
  try {
    _mzComposed = { plan: { pages: pgs }, bands: bnds };
    req.query.measureComposed = '1';
    var cbuilt = await assembleNovelHtml(req, campaignId, null);
    var cblocks = (await measureDocument(cbuilt.html, {})).blocks || [];
    cblocks.forEach(function (bl) {
      var mm = /^cp:(\d+)$/.exec(bl.id || '');
      if (mm) { realH[+mm[1]] = bl.heightIn; return; }
      var mc = /^cc:(\d+):(\d+)$/.exec(bl.id || '');
      if (mc) { (realH._cells || (realH._cells = {}))[mc[1] + ':' + mc[2]] = bl.heightIn; }
    });
    // NEVER-CLIP instrumentation (step 1): flag any page whose REAL measured height exceeds the
    // clip box, for every layout. This is the exact condition that causes overflow:hidden to chop
    // an image or a line of text. Instrumentation only -- records the overflows so we can see
    // which pages/books clip and by how much, before the composer is made fit-verified. The box is
    // the composed content area: 9.65in minus the header band; a small tolerance absorbs sub-pixel
    // rounding so only a REAL overflow (a line/image genuinely past the edge) is flagged.
    // The composed page box is 9.65in with padding-top:HEADER_BAND_IN, so the USABLE content area
    // (what the cp: marker measures against) is 9.65 - 2*header-ish; empirically the content clips
    // at ~9.16in (the same figure the tower-merge ceiling uses). Use that as the clip line so the
    // instrument agrees with the real overflow:hidden behavior rather than the raw box height.
    var _clipBox = MZ_TOWER_MERGE_MAX_IN;   // 9.16in usable content area (validated via the tower fix)
    var _clipTol = 0.03;                    // ~3 hundredths of an inch of rounding slack
    realH._overflows = [];
    Object.keys(realH).forEach(function (k) {
      if (k[0] === '_') return;             // skip _cells / _error / _overflows
      var over = realH[k] - _clipBox;
      if (over > _clipTol) realH._overflows.push({ page: +k, realIn: realH[k], boxIn: _clipBox, overIn: Math.round(over * 1000) / 1000, kind: 'over-box' });
    });
    if (realH._overflows.length) {
      try { console.warn('[NEVER-CLIP] ' + realH._overflows.length + ' page(s) over box (' + _clipBox.toFixed(2) + 'in) for campaign ' + campaignId + ': ' +
        realH._overflows.map(function (o) { return 'p' + o.page + ' +' + o.overIn + 'in'; }).join(', ')); } catch (_e) {}
    }
  } catch (e) { realH._error = String((e && e.message) || e); }
  delete req.query.measureComposed; _mzComposed = null;
  return realH;
}

// Re-measure a composed PAIRED (Picture Book) book, so it gets the same real per-page heights and
// never-clip check magazine/gazette have. composeBook emits cp: markers under measureComposed; we
// inject that body via packComposedBody and read the cp: heights back. Mirrors the magazine path's
// overflow detection (same 9.16in usable box, same tolerance).
async function remeasureComposedPaired(req, campaignId, plan, beats, cOpts) {
  var realH = {};
  try {
    var _body = composeBook(plan, beats, Object.assign({}, cOpts || {}, { measureComposed: true }));
        var _extra = { packComposedBody: _body, arrange: 'paired' };
    var cbuilt = await assembleNovelHtml(req, campaignId, null, _extra);
    var cblocks = (await measureDocument(cbuilt.html, {})).blocks || [];
    cblocks.forEach(function (bl) {
      var mm = /^cp:(\d+)$/.exec(bl.id || '');
      if (mm) { realH[+mm[1]] = bl.heightIn; return; }
      var mc = /^cc:(\d+):(\d+)$/.exec(bl.id || '');
      if (mc) { (realH._cells || (realH._cells = {}))[mc[1] + ':' + mc[2]] = bl.heightIn; }
    });
    var _clipBox = MZ_TOWER_MERGE_MAX_IN;   // 9.16in usable content area (same as magazine)
    var _clipTol = 0.03;
    realH._overflows = [];
    Object.keys(realH).forEach(function (k) {
      if (k[0] === '_') return;
      var over = realH[k] - _clipBox;
      if (over > _clipTol) realH._overflows.push({ page: +k, realIn: realH[k], boxIn: _clipBox, overIn: Math.round(over * 1000) / 1000, kind: 'over-box' });
    });
    if (realH._overflows.length) {
      try { console.warn('[NEVER-CLIP] (paired) ' + realH._overflows.length + ' page(s) over box (' + _clipBox.toFixed(2) + 'in) for campaign ' + campaignId + ': ' +
        realH._overflows.map(function (o) { return 'p' + o.page + ' +' + o.overIn + 'in'; }).join(', ')); } catch (_e) {}
    }
  } catch (e) { realH._error = String((e && e.message) || e); }
  return realH;
}

// Tower-column merge candidate: find the FIRST page that is a single text-only TAIL immediately
// before a tower, and fold that tail into the tower's beside-column (which usually has room). Returns
// a NEW pages array with the stranded page removed and the tower cell carrying the lead, plus the new
// index of the merged tower page -- or null if there's nothing to merge.
function towerMergeCandidate(pgs, bnds, skip) {
  for (var pi = 0; pi + 1 < pgs.length; pi++) {
    var pg = pgs[pi];
    if (pg.length !== 1) continue;
    var c = pg[0];
    if (!c.split || (c.cStart || 0) === 0 || c.imgBody || c.textLead) continue;   // must be a text-only tail
    // Skip tails a previous round already proved will not fit. Keyed by band + start offset rather
    // than page index, because accepting a merge shifts every later page up by one.
    var _key = c.band + ':' + (c.cStart || 0);
    if (skip && skip[_key]) continue;
    var nb = pgs[pi + 1];
    if (!nb.length) continue;
    var tc = nb[0];
    var tband = bnds[tc.band];
    if (!tband || tband.kind !== 'tower' || !tband.renderTowerLead || tc.towerLead) continue;
    var out = [];
    for (var k = 0; k < pgs.length; k++) {
      if (k === pi) continue;                                  // drop the stranded page
      if (k === pi + 1) {
        var cells = nb.slice();
        cells[0] = { band: tc.band, kind: 'tower', split: false, cStart: 0, cEnd: null,
          towerLead: { band: c.band, cStart: (c.cStart || 0), cEnd: (c.cEnd != null ? c.cEnd : null) } };
        out.push(cells);
      } else out.push(pgs[k]);
    }
    return { pages: out, mergedIndex: (pi + 1) - 1, key: _key, srcPage: pi };   // the tower page shifts up by one (the removed page precedes it)
  }
  return null;
}

// Stamp a merge attempt's settings onto the merged tower cell without disturbing the other pages.
function towerApplyRung(pgs, mi, rung) {
  var out = pgs.slice();
  var pg = out[mi].slice();
  pg[0] = Object.assign({}, pg[0], { towerShrink: rung.s, towerWrap: rung.w });
  out[mi] = pg;
  return out;
}

// Look-back pull-up candidate: find the FIRST underfull page whose NEXT page is a single WHOLE movable
// band (feature/float/wide/pair -- not a split continuation, tower, or matter) that fits the underfull
// page's room. Pull it up and drop the now-empty next page. Returns a NEW pages array or null.
function lookBackPullUpCandidate(pgs, bnds, pageH, estH) {
  function cellH(c) { return (c.heightIn != null ? c.heightIn : (estH[c.band] || 0)); }
  var MOVABLE = { feature: 1, float: 1, wide: 1, pair: 1 };
  for (var pi = 0; pi + 1 < pgs.length; pi++) {
    var pg = pgs[pi];
    var used = 0; pg.forEach(function (c) { used += cellH(c); });
    var room = pageH - used;
    if (room < 1.6) continue;                                  // not underfull enough to bother
    var nb = pgs[pi + 1];
    if (nb.length !== 1) continue;                             // must be a single-band page so pulling it up EMPTIES the page
    var c = nb[0];
    if (c.split || c.towerLead) continue;                      // whole band only (no continuation / no merged tower)
    var b = bnds[c.band];
    if (!b || !MOVABLE[b.kind]) continue;                      // movable image+text band only
    if (cellH(c) > room - 0.12) continue;                      // must fit the real room
    var out = [];
    for (var k = 0; k < pgs.length; k++) {
      if (k === pi + 1) continue;                              // drop the emptied page
      if (k === pi) out.push(pg.concat([c]));                  // append the pulled band to the underfull page
      else out.push(pgs[k]);
    }
    return { pages: out, filledIndex: pi };
  }
  return null;
}

async function computeMagazinePack(req, campaignId, packOpts) {
  var _co = req.query.co ? parseCustomOpts(req.query.co) : {};
  var _hdrOn = (_co.header == null) ? true : !!_co.header;
  var pageH = ((packOpts && packOpts.pageHeightIn != null) ? packOpts.pageHeightIn : 9.4) - (_hdrOn ? HEADER_BAND_IN : 0);
  var _markerBreak = !!_co.markerbreak;   // each session starts a fresh page when set

  // Pass 1 -- default image sizes.
  _mzGrow = null; _mzBands = [];
  // GAZETTE: the flow (Before) beats the packer precisely because it splits bordered boxes cleanly
  // via box-decoration-break:clone -- 36 pages at 86 percent fill vs the packer's 41 at 73 percent.
  // So for Gazette we pack FLOW-STYLE (enclose boxes splittable) and then run ONLY the tower-column
  // merge, skipping the rest of the optimizer. That is the one transform Gazette actually needs:
  // it folds a stranded text-only tail into the following tower's near-empty beside column.
  var _gzOnly = (_co.arrange === 'gazette');
  _mzFlowSim = !!(packOpts && packOpts.flowSim) || _gzOnly;   // split enclose boxes like the flow does
  req.query.measureMagazine = '1';
  // Feature shrinking is OFF: Ian wants full-size hero images in Optimize (same as the flow), not
  // smaller-image-more-white. Set MZ_OPT_SHRINK_FEATURES=true to re-enable the 5.5in cap + float.
  if (MZ_OPT_SHRINK_FEATURES) { req.query.mzCapFeatures = '1'; req.query.mzFloatShrunk = '1'; }
  var mbuilt = await assembleNovelHtml(req, campaignId, null);
  _mzFlowSim = false;   // bands are built; do not leak the flag past band construction
  var meas = magazineMeasure((await measureDocument(mbuilt.html, {})).blocks || []);
  var bandH = meas.h;
  var bands = _mzBands || [];
  fillMissingMagazineLines(meas, bands);
  var pages = packMagazineBands(bands, meas, pageH, _markerBreak, null, null);
  if (!(packOpts && packOpts.flowSim)) {   // FLOW-SIM (Before dump): skip ALL optimization transforms; keep the raw greedy pack

  // Grow-to-fill: for each page left noticeably under-full, enlarge its LAST growable floated
  // image toward the leftover white. Only floats carry regrow() (full-width bands are already at
  // column width). We aim high (85% of slack) because the SECOND pass re-measures the grown,
  // reflowed bands and RE-PACKS with their true heights -- so a picture that grows past its page
  // simply moves to the next page instead of clipping at the break.
  var grow = {}, splitAllow = {};
  if (!_gzOnly) {   // Gazette runs tower-merge ONLY: no de-widow, no grow-to-fill, no gap-fit
  // De-widow: a band only slightly taller than one page splits into a full head + a tiny orphan tail
  // stranded on its own near-blank page (worst when a tower/full-page band follows and can't backfill).
  // Shrink that band's image just enough to fit a single page, removing the split (and the blank) entirely.
  pages.forEach(function (pg) {
    if (pg.length !== 1) return;
    var cell = pg[0];
    if (!cell.split || cell.cEnd != null) return;                 // must be the tail (end) of a split
    var u = (cell.heightIn != null) ? cell.heightIn : 0;
    if (u > 2.0) return;                                          // only a TINY orphan tail
    var bi = cell.band, band = bands[bi];
    if (!band || !band.regrow || !band.sImgH || grow[bi]) return;
    var full = bandH[bi] || 0;
    if (full <= pageH || full > pageH + 1.3) return;             // only bands JUST over a page
    var mul = 1 - (full - pageH + 0.1) / band.sImgH;             // shrink image so image+text fits one page
    if (mul >= 0.7 && mul < 0.995) grow[bi] = Math.round(mul * 100) / 100;
  });
  pages.forEach(function (pg) {
    var u = 0, floats = [];
    for (var c = 0; c < pg.length; c++) { u += (pg[c].heightIn != null ? pg[c].heightIn : (bandH[pg[c].band] || 0)); if (!pg[c].split && bands[pg[c].band] && bands[pg[c].band].regrow) floats.push(pg[c].band); }
    var slack = pageH - u;
    if (!MZ_GROW_TO_FILL || slack < 0.6 || !floats.length) return;
    // Share the growth across EVERY floated image on the page (proportional to size) so several
    // pictures keep wrapping text instead of one ballooning to fill the white. Modest per-image
    // grows also keep each text reflow small, so pass 2's re-measure lands them cleanly (no clip).
    var sumH = 0; floats.forEach(function (bi) { sumH += (bandH[bi] || 0.001); });
    var fill = slack * 0.9;
    floats.forEach(function (bi) {
      var h = bandH[bi] || 1;
      var target = h + fill * (h / sumH);
      if (target > pageH - 0.15) target = pageH - 0.15;   // a lone grown band must still fit its own page
      var mul = target / h;
      if (mul > 1.8) mul = 1.8;
      if (mul > 1.03) grow[bi] = Math.round(mul * 100) / 100;
    });
  });

  // Pull-up (shrink-to-fit): a page still left with white but with NO float of its own to grow can
  // instead pull the NEXT page's opening image UP, shrinking it to fit the gap. Image-dominated bands
  // only (float, wide, or feature) -- if text runs well below the picture the band wouldn't shorten
  // enough and the gap-fit splitter handles it instead. Features get a gentler floor (kept big). Skips
  // a picture already growing elsewhere and continuations (a split tail is text, not a pullable image).
  pages.forEach(function (pg, pi) {
    var u = 0, growsHere = false;
    for (var c = 0; c < pg.length; c++) {
      u += (pg[c].heightIn != null ? pg[c].heightIn : (bandH[pg[c].band] || 0));
      if (grow[pg[c].band]) growsHere = true;
    }
    var slack = pageH - u;
    if (slack < 0.6 || growsHere) return;
    var nxt = pages[pi + 1];
    if (!nxt || !nxt.length || nxt[0].split) return;
    var nbi = nxt[0].band, band = bands[nbi];
    if (!band || !band.regrow || grow[nbi]) return;
    var h = bandH[nbi] || 0;
    if (!band.sImgH || band.sImgH < h - 0.35) return;   // text extends below the image -> text-dominated, leave to the splitter
    if (h <= slack + 1e-6) return;                       // already fits (the packer would have placed it here)
    var mul = (slack - 0.1) / band.sImgH;
    var _pfloor = (band.kind === 'feature') ? 0.72 : 0.65;   // collapse-to-fit: let a near-fitting image give a little to drop into the gap (features stay a touch bigger)
    if (mul >= _pfloor && mul < 0.98) grow[nbi] = Math.round(mul * 100) / 100;   // pull it up onto this page
  });

  // Shrink-to-fit-the-gap: a page still under-full whose NEXT band is a splittable FLOAT whose image
  // is too tall to cut into that gap -- shrink the image just enough that image + a couple text lines
  // fit, then let the splitter flow the rest. This fills white while KEEPING the wrap (a smaller
  // wrapped picture, its text continuing) instead of growing anything. Modest shrink only; if it would
  // need to go below MZ_GAPFIT_FLOOR we leave the white and keep the picture full-size -- err toward
  // the magazine wrap, never toward a Picture-Book blowup.
  pages.forEach(function (pg, pi) {
    var u = 0, sizedHere = false;
    for (var c = 0; c < pg.length; c++) { u += (pg[c].heightIn != null ? pg[c].heightIn : (bandH[pg[c].band] || 0)); if (grow[pg[c].band]) sizedHere = true; }
    var slack = pageH - u;
    if (slack < 1.0 || sizedHere) return;
    var nxt = pages[pi + 1];
    if (!nxt || !nxt.length || nxt[0].split) return;
    var nbi = nxt[0].band, band = bands[nbi];
    if (!band || !band.remeta || !band.stext || !band.simg || grow[nbi]) return;   // a splittable FLOAT (image + prose), not already sized
    var full = bandH[nbi] || 0;
    if (full <= slack + 1e-6) return;                              // already fits whole -> packer would place it here
    if (band.sImgH <= slack - MZ_SPLIT_PAD - 0.7) return;         // normal splitter already cuts this into the gap (line fits below the image) -> no shrink
    var targetImgH = slack - MZ_SPLIT_PAD - 0.5;                  // shrink so image + a whole cut line clear the gap (window >= one line)
    if (targetImgH < 1.2) return;                                 // gap too small to hold a legible image + text
    var mul = targetImgH / band.sImgH;
    if (mul >= MZ_GAPFIT_FLOOR && mul < 0.98) { grow[nbi] = Math.round(mul * 100) / 100; splitAllow[nbi] = true; }
  });
  }   // end de-widow / grow-to-fill / gap-fit (skipped for Gazette; grow stays empty so Pass 2 self-skips)

  // Pass 2 -- re-render grown/shrunk floats, re-measure true heights, re-pack (exact pagination).
  if (Object.keys(grow).length) {
    _mzGrow = grow; _mzBands = [];
    var mbuilt2 = await assembleNovelHtml(req, campaignId, null);
    var meas2 = magazineMeasure((await measureDocument(mbuilt2.html, {})).blocks || []);
    var bands2 = _mzBands || [];
    fillMissingMagazineLines(meas2, bands2);
    bands = bands2; pages = packMagazineBands(bands2, meas2, pageH, _markerBreak, grow, splitAllow);
  }
  delete req.query.measureMagazine;
  delete req.query.mzCapFeatures;
  delete req.query.mzFloatShrunk;
  _mzBands = null; _mzGrow = null;

  // ITERATIVE OPTIMIZER, step 2: tower-column merge. Fold each stranded text-only tail into the
  // following tower's beside-column, but ACCEPT only if the real re-measure confirms the merged page
  // still fits (no clip). Gated + monotone: it can only remove pages, never overflow. One token.
  var _tmLog = [];   // admin dump: what the tower-column merge tried, and why each attempt landed
  if (MZ_TOWER_MERGE && (_co.arrange === 'magazine' || _co.arrange === 'gazette' || !_co.arrange)) {
    // Absorb a stranded page cheapest-first. The tower keeps its full height for as long as possible:
    // first the neat beside-column, then letting the prose also run under the image (free, no shrink),
    // and only then trimming the picture -- 10%, and 20% as the absolute last resort.
    var _RUNGS = [ { s: 0, w: false, n: 'beside column' }, { s: 0, w: true, n: 'wrapping below' },
                   { s: 0.10, w: true, n: 'tower -10%' }, { s: 0.20, w: true, n: 'tower -20%' } ];
    var _tmGuard = 0, _tmSkip = {};
    while (_tmGuard < 24) {
      var _cand = towerMergeCandidate(pages, bands, _tmSkip);
      if (!_cand) break;
      var _accepted = false, _err = false;
      for (var _r = 0; _r < _RUNGS.length; _r++) {
        if (_tmGuard++ >= 24) break;
        var _try = towerApplyRung(_cand.pages, _cand.mergedIndex, _RUNGS[_r]);
        var _rc = await remeasureComposedPages(req, campaignId, _try, bands);
        if (_rc._error) { _err = true; break; }
        // Judge ONLY the page this merge produced. This used to scan EVERY page in the book, so a page
        // that was already over the ceiling before we touched anything -- a malformed band somewhere
        // else entirely -- vetoed the very first candidate and broke the loop, meaning no merge could
        // ever succeed anywhere in that book. Seen on a 49-page Gazette: four textbook candidates, each
        // with 3.5-7.7in of white before a tower, and zero merges, because one unrelated page measured
        // over. Pre-existing oversize elsewhere is not this merge's doing and must not block it.
        var _mh = (_cand.mergedIndex != null) ? _rc[_cand.mergedIndex] : null;
        var _fits = (_mh != null && _mh <= MZ_TOWER_MERGE_MAX_IN);
        _tmLog.push('page ' + _cand.srcPage + ' -> tower (' + _RUNGS[_r].n + '): ' +
          (_mh != null ? _mh.toFixed(2) + 'in' : '?') + ' vs ceiling ' + MZ_TOWER_MERGE_MAX_IN + 'in -- ' + (_fits ? 'MERGED' : 'too tall'));
        if (_fits) { pages = _try; _tmSkip = {}; _accepted = true; break; }
      }
      if (_err) break;
      // A tail that will not fit even at the last rung must not stop the ones that would. This used to
      // break out entirely, so one fat tail early in the book blocked every later candidate --
      // including one-line tails that fit trivially.
      if (!_accepted) _tmSkip[_cand.key] = 1;
    }
  }

  if (!_gzOnly) {   // Gazette: stop after the tower-merge -- no pull-up, no page-local grow
  // ITERATIVE OPTIMIZER, step 3: look-back pull-up. An underfull page pulls up a following single
  // movable band that fits, removing the emptied page. Gated on the real re-measure (accept only if it
  // fits, no clip); monotone -- can only remove pages. One token. (No-op on books without the pattern.)
  if (MZ_LOOKBACK_PULLUP && (_co.arrange === 'magazine' || _co.arrange === 'gazette' || !_co.arrange)) {
    var _lbGuard = 0;
    while (_lbGuard++ < 12) {
      var _lcand = lookBackPullUpCandidate(pages, bands, pageH, bandH);
      if (!_lcand) break;
      var _lrc = await remeasureComposedPages(req, campaignId, _lcand.pages, bands);
      if (_lrc._error) break;
      var _lfits = true;
      for (var _lk in _lrc) { if (_lk !== '_error' && _lrc[_lk] > MZ_TOWER_MERGE_MAX_IN) { _lfits = false; break; } }
      if (_lfits) pages = _lcand.pages; else break;
    }
  }

  // ITERATIVE OPTIMIZER, step 4: PAGE-LOCAL IMAGE GROW. For every underfull page, grow that page's
  // image so the text re-wraps around a bigger picture and fills the white. NOTHING leaves the page --
  // the text slice is untouched, only the image multiplier changes. Escalating ladder, each rung
  // verified against the REAL re-measure: a page keeps the largest multiplier that still fits the
  // physical content page. Monotone (a page can only end at a size that measured OK) and page-count
  // neutral by construction. One token for the whole run.
  if (MZ_PAGE_GROW && (_co.arrange === 'magazine' || _co.arrange === 'gazette' || !_co.arrange)) {
    var _growCell = function (pg) {
      for (var ci = 0; ci < pg.length; ci++) {
        var c = pg[ci], bb = bands[c.band];
        // A band is growable if it can be re-rendered at a new size AND actually carries a picture.
        // NOTE: bb.simg means "splittable image band WITH prose text" -- it is FALSE for script/dialogue
        // panels, which still have images. Testing simg here skipped every image on a Comic-Dialogue book.
        if (!bb || !bb.remeta || !(bb.sImgH > 0)) continue;
        if (c.textLead || c.towerLead) continue;                          // text-only cells
        if (c.split && (c.cStart || 0) > 0 && !c.imgBody) continue;       // text-only continuation tail
        return ci;
      }
      return -1;
    };
    var _applyGrow = function (pgs, fmap) {
      return pgs.map(function (pg, pi) {
        var f = fmap[pi];
        if (!f || f === 1) return pg;
        var ci = _growCell(pg);
        if (ci < 0) return pg;
        var np = pg.slice();
        np[ci] = Object.assign({}, np[ci], { growMul: f });
        return np;
      });
    };
    try {
      var _gr0 = await remeasureComposedPages(req, campaignId, pages, bands);
      if (!_gr0._error) {
        // Aim straight at the white instead of climbing a fixed ladder: the extra height an image
        // contributes is roughly proportional to its own height, so target = 1 + white/imgHeight. Then
        // refine by bisection -- an overshoot pulls back, a comfortable fit reaches higher. Far more
        // accurate than a ladder for pages whose image is small relative to the white (a 1.9x cap could
        // never fill a 4in gap left by a 1.9in image).
        var _fac = {}, _lo = {}, _hi = {}, _try = {}, _act = [];
        pages.forEach(function (pg, pi) {
          if (_gr0[pi] == null || _gr0[pi] > pageH - MZ_GROW_MIN_WHITE) return;   // not underfull enough to bother
          var ci = _growCell(pg);
          if (ci < 0) return;                                                     // no growable image on this page
          var _bb = bands[pg[ci].band];
          var _ih = Math.max(0.5, (_bb && _bb.sImgH) || 0.5);
          var _t = 1 + (pageH - _gr0[pi]) / _ih;
          if (_t > MZ_GROW_MAX_MUL) _t = MZ_GROW_MAX_MUL;
          if (_t < 1.05) return;
          _fac[pi] = 1; _lo[pi] = 1; _hi[pi] = _t; _try[pi] = _t; _act.push(pi);
        });
        for (var _rd = 0; _rd < MZ_GROW_ROUNDS && _act.length; _rd++) {
          var _trial = _applyGrow(pages, (function () {
            var m = {}; for (var k in _fac) m[k] = _fac[k];
            _act.forEach(function (pi) { m[pi] = _try[pi]; });
            return m;
          })());
          var _grc = await remeasureComposedPages(req, campaignId, _trial, bands);
          if (_grc._error) break;
          var _next = [];
          _act.forEach(function (pi) {
            if (_grc[pi] != null && _grc[pi] <= MZ_TOWER_MERGE_MAX_IN) {
              _fac[pi] = _try[pi]; _lo[pi] = _try[pi];
              if (_hi[pi] <= _try[pi] + 1e-6) _hi[pi] = Math.min(MZ_GROW_MAX_MUL, _try[pi] * 1.5);   // it fit -- reach higher
            } else {
              _hi[pi] = _try[pi];                                                                    // overshoot -- pull back
            }
            var _nt = (_lo[pi] + _hi[pi]) / 2;
            if (_hi[pi] - _lo[pi] > 0.12 && _nt > 1.02) { _try[pi] = _nt; _next.push(pi); }
          });
          _act = _next;
        }
        pages = _applyGrow(pages, _fac);
      }
    } catch (e) { /* grow is best-effort: on any failure keep the ungrown pages */ }
  }

  }   // end look-back pull-up + page-local grow (skipped for Gazette)
  }   // end optimization transforms (skipped for the Before flow-sim dump)
  var _dbg = null;
  if (packOpts && packOpts.debug) {
    var _fm = (typeof meas2 !== 'undefined' && meas2) ? meas2 : meas;
    _dbg = {
      arrange: (_co.arrange || 'magazine'), pageH: pageH, markerBreak: _markerBreak, grow: grow || {},
      towerMerge: _tmLog,   // per-attempt record of the tower-column merge (printed under the header)
      co: _co,   // the FULL layout option set this plan was built from -- printed at the top of the dump
                 // so two dumps can be compared with certainty (a font change silently made two dumps
                 // describe different books once, and nothing on the page said so).
      campaign: (mbuilt.campaign && mbuilt.campaign.name) || '',
      bands: bands.map(function (b, bi) {
        return { i: bi, kind: b.kind, h: Math.round((_fm.h[bi] || 0) * 1000) / 1000, simg: !!b.simg,
          sImgH: Math.round((b.sImgH || 0) * 100) / 100, asp: (b.sAsp || 0), title: (b.sTitle || ''),
          stext: (b.stext != null), slen: (b.stext != null ? b.stext.length : 0),
          preview: (b.stext != null ? b.stext.slice(0, 60).split('\n').join(' ') : ''),
          nlines: ((_fm.lines && _fm.lines[bi]) || []).length,
          lines: ((_fm.lines && _fm.lines[bi]) || []), lineChars: ((_fm.lineChars && _fm.lineChars[bi]) || []),
          mbound: (b.mbound != null ? b.mbound : null) };
      }),
      pages: pages.map(function (pg, pi) {
        var u = 0; pg.forEach(function (c) { u += (c.heightIn != null ? c.heightIn : (_fm.h[c.band] || 0)); });
        return { page: pi, used: Math.round(u * 1000) / 1000,
          cells: pg.map(function (c) { return { band: c.band, kind: (bands[c.band] || {}).kind, split: !!c.split, cStart: c.cStart || 0, cEnd: (c.cEnd != null ? c.cEnd : null), h: c.heightIn, growMul: (c.growMul || null), towerLead: (c.towerLead || null) }; }) };
      })
    };
    // Re-measure the REAL composed output (after any tower-merge) so the dump shows true per-page
    // fills next to the estimates. Same request => still one token.
    try {
      var realH = await remeasureComposedPages(req, campaignId, pages, bands);
      if (realH._error) { _dbg.remeasureError = realH._error; }
      else {
        _dbg.pages.forEach(function (pg, _pi) {
          if (realH[pg.page] != null) pg.realUsed = realH[pg.page];
          if (realH._cells) pg.cells.forEach(function (c, _ci) {
            var rv = realH._cells[_pi + ':' + _ci];
            if (rv != null) c.realH = rv;
          });
        });
        _dbg.overflows = realH._overflows || [];   // NEVER-CLIP: pages whose real height clips the box
        // NEVER-CLIP (at-risk): also flag pages that fit the box TOTAL but render much taller than
        // the packer estimated (large est->real gap). These are where a tower beside-column or a
        // stacked cell overflows INSIDE the page even though the page total squeaks under box -- the
        // page-24 case (est 8.13, real 8.86) the page-total check alone misses. Threshold 0.4in.
        var _riskGap = 0.4;
        _dbg.atRisk = [];
        _dbg.pages.forEach(function (pg) {
          if (pg.realUsed == null) return;
          var gap = pg.realUsed - pg.used;
          var alreadyOver = _dbg.overflows.some(function (o) { return o.page === pg.page; });
          if (!alreadyOver && gap > _riskGap) _dbg.atRisk.push({ page: pg.page, realIn: pg.realUsed, estIn: pg.used, gapIn: Math.round(gap * 1000) / 1000 });
        });
        _dbg.remeasured = true;
      }
    } catch (e) { _dbg.remeasureError = String((e && e.message) || e); }
  }

  return { plan: { pages: pages, pageCount: pages.length }, bands: bands, campaign: mbuilt.campaign, dbg: _dbg };
}
// Literal composer: one fixed-height content-page per plan page, hard break after, so the
// browser can't re-paginate. Mirrors composeBook's page shell.
// Build ONE composed page's inner cells (shared by the final render and the re-measure body).
function composePageInner(pg, bands, opts) {
  var inner = '';
  pg.forEach(function (cell) {
    var b = bands[cell.band];
    if (!b) return;
    // PAGE-LOCAL GROW: re-render this band with a bigger image; the SAME text slice re-wraps around it.
    if (cell.growMul && cell.growMul !== 1 && b.remeta) { try { b = b.remeta(cell.growMul) || b; } catch (e) { /* keep original */ } }
    var html;
    if (cell.split && b.stext != null) {
      var cs = cell.cStart || 0;
      var ce = (cell.cEnd != null) ? cell.cEnd : b.stext.length;
      if (b.simg) {
        if (cell.textLead) html = gzNarrBox(renderMzSlice(b.stext, b.mbound, cs, ce, b.sOpts || opts), b.sOpts || opts);   // SPILL lead: leading text ONLY (image leads the next page)
        else if (cell.imgBody && b.renderHead) html = b.renderHead(cs, ce);   // SPILL body: image + the text AFTER the spilled lead
        else if (cs === 0 && b.renderHead) html = b.renderHead(0, ce);   // panel HEAD: image + text up to the cut
        else html = gzNarrBox(renderMzSlice(b.stext, b.mbound, cs, ce, b.sOpts || opts), b.sOpts || opts);   // continuation: full-width, boundary-aware. gzNarrBox re-boxes the slice for Gazette (no-op for Magazine) so a split panel's TAIL keeps its parchment border -- matching what box-decoration-break:clone does in the flow.
      } else {
        html = buildNarrativeHTML(b.stext.slice(cs, ce), b.sIntro);
        if (cs > 0) html = html.replace('text-indent:0.3in', 'text-indent:0');   // intro/outro continuation: no first-line indent
        if (cs === 0 && b.sDrop) html = coDropcap(html);   // drop cap only on the opening slice
      }
    } else if (b.kind === 'tower' && cell.towerLead && b.renderTowerLead) {
      var _lb = bands[cell.towerLead.band];
      var _lead = (_lb && _lb.stext != null) ? renderMzSlice(_lb.stext, _lb.mbound, cell.towerLead.cStart || 0, (cell.towerLead.cEnd != null ? cell.towerLead.cEnd : _lb.stext.length), _lb.sOpts || opts) : '';
      html = b.renderTowerLead(_lead ? ('<div style="margin-bottom:0.16in;">' + _lead + '</div>') : '', cell.towerShrink, cell.towerWrap);
    } else {
      html = b.html;
    }
    inner += '<div style="display:flow-root;">' + html + '</div>';
  });
  return inner;
}
function composeMagazine(plan, bands, opts) {
  var out = '';
  var pages = (plan && plan.pages) || [];
  // Running page header: the packer already reserves HEADER_BAND_IN on every page, but nothing was
  // being drawn there -- the band was reserved and wasted. Emit the same running head the paired
  // composer uses, tracking the current session as we walk the pages and suppressing it on a
  // session-opening page (the chapter heading already announces the session there).
  var _hdrOn = (opts && opts.header != null) ? !!opts.header : true;
  // Carve the running-head band OUT of the page box rather than adding to it: total stays 9.65in, so
  // the composed page still fits the printable area and never spills a blank page. The packer already
  // budgeted for this band (its pageH is 9.4 - HEADER_BAND_IN), so the body plan is unchanged.
  var _bandCss = _hdrOn ? ('padding-top:' + HEADER_BAND_IN + 'in;') : '';
  var _boxH = (9.65 - (_hdrOn ? HEADER_BAND_IN : 0)).toFixed(3);
  var _cNum = null, _cName = '', _cCamp = '';
  pages.forEach(function (pg, pi) {
    var opensSession = false;
    pg.forEach(function (cell) {
      var b = bands[cell.band];
      if (b && b.kind === 'session-header') {
        opensSession = true;
        if (b.sNum != null) { _cNum = b.sNum; _cName = b.sName || ''; _cCamp = b.sCamp || _cCamp; }
      }
    });
    var head = (_hdrOn && !opensSession && _cNum != null) ? runningHeaderHTML(_cCamp, _cNum, _cName) : '';
    var inner = composePageInner(pg, bands, opts);
    var brk = (pi < pages.length - 1) ? 'page-break-after:always;' : '';
    out += '<div class="content-page" style="height:' + _boxH + 'in;' + _bandCss + 'overflow:hidden;margin:0;' + brk + 'position:relative;">' + head + inner + '</div>';
  });
  return out;
}
// Plain-text pack-plan dump for the admin easter egg (double-click the After page count). Everything
// needed to debug a magazine/gazette layout: per-band kind/height/image/splittable/line-count, and
// each page's fill with UNDERFULL flags and split char-ranges.
function pairedPlanText(packed) {
  var plan = (packed && packed.plan) || {};
  var pages = (plan.pages) || [];
  var d = packed.dbg || {};
  var beats = {};
  (packed.beats || []).forEach(function (b) { beats[b.idx] = b; });
  var L = [];
  L.push('PACK PLAN (paired / Picture Book)  -  ' + ((packed.campaign && packed.campaign.name) || 'campaign'));
  L.push('arrange=paired  content-pages=' + pages.length + '  (the PDF also adds front/back matter, so viewer page numbers are higher)');
  // Front matter offset: cover + title + details + (cast) -- paired always has title+details.
  var _fm = 4;
  var _viewer = function (contentPage) { return contentPage + _fm + 1; };
  L.push('front-matter offset: ~' + _fm + ' page(s) before content -> a dump PAGE n is ~viewer page n+' + (_fm + 1) + ' (approximate)');
  var _ovf = (d.overflows || []);
  if (_ovf.length) {
    L.push('');
    L.push('!!! NEVER-CLIP: ' + _ovf.length + ' PAGE(S) OVERFLOW THE BOX (content is clipped here) !!!');
    _ovf.forEach(function (o) {
      L.push('    PAGE ' + o.page + ' (viewer ~p.' + _viewer(o.page) + ')  real ' + o.realIn.toFixed(2) + 'in  vs box ' + o.boxIn.toFixed(2) + 'in  -> OVER by ' + o.overIn.toFixed(2) + 'in');
    });
  }
  var _risk = (d.atRisk || []);
  if (_risk.length) {
    L.push('');
    L.push('!! NEVER-CLIP AT-RISK: ' + _risk.length + ' page(s) fit the box TOTAL but render far taller than planned:');
    _risk.forEach(function (o) {
      L.push('    PAGE ' + o.page + ' (viewer ~p.' + _viewer(o.page) + ')  real ' + o.realIn.toFixed(2) + 'in  est ' + o.estIn.toFixed(2) + 'in  -> under-planned by ' + o.gapIn.toFixed(2) + 'in');
    });
  }
  if (!_ovf.length && !_risk.length && d.remeasured) L.push('NEVER-CLIP: no page overflows or at-risk gaps (nothing clipped). [OK]');
  if (d.remeasureError) L.push('(re-measure error: ' + d.remeasureError + ')');
  L.push('');
  L.push('PAGES  (REAL = true composed fill; est = packer estimate)');
  var _byPage = {};
  (d.pages || []).forEach(function (pg) { _byPage[pg.page] = pg; });
  pages.forEach(function (pg, pi) {
    var dp = _byPage[pi] || {};
    var realStr = (dp.realUsed != null) ? ('  REAL ' + dp.realUsed.toFixed(2) + ' (est ' + (dp.used != null ? dp.used.toFixed(2) : '?') + ', ' + ((dp.realUsed - (dp.used || 0)) >= 0 ? '+' : '') + (dp.realUsed - (dp.used || 0)).toFixed(2) + ')') : '';
    L.push('  PAGE ' + pi + '  (viewer ~p.' + _viewer(pi) + ')  est ' + (dp.used != null ? dp.used.toFixed(2) : '?') + ' / 9.16' + realStr);
    // Per-placement heights + running cumulative, so an over-budget stack is visible line by line.
    // Prefer the dbg placements (they carry the packer's real heightIn); fall back to plan order.
    var _pls = (dp.placements && dp.placements.length) ? dp.placements : (pg.placements || []);
    var _cum = 0;
    _pls.forEach(function (pl) {
      var b = beats[pl.beat] || {};
      var lbl = pl.kind;
      if (pl.kind === 'narr') lbl += ' ' + (pl.part || 'before') + (pl.charStart != null ? (' CUT ' + pl.charStart + '..' + (pl.charEnd != null ? pl.charEnd : 'end')) : '');
      if (pl.kind === 'image' || pl.kind === 'tower') { lbl += (pl.scale != null && pl.scale < 0.999) ? (' scale' + pl.scale.toFixed(2)) : ''; if (b.moment && b.moment.title) lbl += '  "' + b.moment.title + '"'; }
      var _h = (pl.heightIn != null) ? pl.heightIn : null;
      if (_h != null) _cum = Math.round((_cum + _h) * 100) / 100;
      var _hstr = (_h != null) ? ('  packed' + _h.toFixed(2) + '  cum' + _cum.toFixed(2)) : '';
      var _rcH = (pl.realH != null) ? pl.realH : null;
      var _rcStr = (_rcH != null) ? ('  REAL-CELL' + _rcH.toFixed(2) + ((_h != null && Math.abs(_rcH - _h) > 0.1) ? ('  (diff ' + ((_rcH - _h) >= 0 ? '+' : '') + (_rcH - _h).toFixed(2) + ')') : '')) : '';
      var _fhStr = (pl.fullH != null) ? ('  fullH' + pl.fullH.toFixed(2)) : '';
      var _flag = (_h != null && _cum > 9.16) ? '  <== OVER 9.16' : '';
      var _dflag = (_rcH != null && _h != null && (_rcH - _h) > 0.3) ? '  <== RENDERS TALLER THAN PACKED' : '';
      L.push('      beat ' + pl.beat + '  ' + lbl + _hstr + _rcStr + _fhStr + _flag + _dflag);
    });
  });
  var _bt = (d.beatText || []);
  if (_bt.length) {
    L.push('');
    L.push('TEXT MEASURE (per beat: len=chars, lines=measured line count, H=packer height, span=last-line Y, FALLBACK=no line data)');
    _bt.forEach(function (t) {
      if (t.beforeLen) { L.push('  beat ' + t.idx + ' before  len' + t.beforeLen + '  lines' + t.beforeLines + '  H' + t.beforeH.toFixed(2) + '  span' + (t.beforeSpan != null ? t.beforeSpan.toFixed(2) : '?') + (t.beforeFallback ? '  <== FALLBACK (estTextH, no line data)' : '') + ((t.beforeLines && t.beforeLen / t.beforeLines > 90) ? '  <== SUSPECT ' + Math.round(t.beforeLen / t.beforeLines) + ' chars/line' : '') + ((t.beforeLines && t.beforeSpan != null && (t.beforeSpan / t.beforeLines) < 0.14) ? '  <== COMPRESSED ' + (t.beforeSpan / t.beforeLines).toFixed(3) + 'in/line' : ''));
        if (t.beforeYs) L.push('       Ys: [' + t.beforeYs.join(', ') + ']');
        if (t.beforeChars) L.push('       chars: [' + t.beforeChars.join(', ') + ']'); }
      if (t.afterLen) { L.push('  beat ' + t.idx + ' after   len' + t.afterLen + '  lines' + t.afterLines + '  H' + t.afterH.toFixed(2) + '  span' + (t.afterSpan != null ? t.afterSpan.toFixed(2) : '?') + (t.afterFallback ? '  <== FALLBACK (estTextH, no line data)' : '') + ((t.afterLines && t.afterLen / t.afterLines > 90) ? '  <== SUSPECT ' + Math.round(t.afterLen / t.afterLines) + ' chars/line' : '') + ((t.afterLines && t.afterSpan != null && (t.afterSpan / t.afterLines) < 0.14) ? '  <== COMPRESSED ' + (t.afterSpan / t.afterLines).toFixed(3) + 'in/line' : ''));
        if (t.afterYs) L.push('       Ys: [' + t.afterYs.join(', ') + ']');
        if (t.afterChars) L.push('       chars: [' + t.afterChars.join(', ') + ']'); }
    });
  }
  return L.join('\n');
}

function magazinePlanText(packed) {
  var d = packed && packed.dbg;
  if (!d) return 'no debug plan available';
  var pad = function (v, n) { var t = String(v); while (t.length < n) t += ' '; return t; };
  var L = [];
  // FRONT-MATTER OFFSET: the pack dump numbers CONTENT pages from 0, but the viewer/PDF renders
  // front matter first, so a viewer page = content page + this offset + 1 (the +1 is the 0->1 shift).
  // Defaults mirror the renderer: cover on, cast on, toc off; title + details pages always present.
  // A viewer number is APPROXIMATE for cast/toc (a long cast list or wrapped TOC can span >1 page),
  // but exact for the fixed cover/title/details -- close enough to map a page at a glance.
  var _co = d.co || {};
  var _has = function (k, dflt) { return (_co && Object.prototype.hasOwnProperty.call(_co, k)) ? !!_co[k] : dflt; };
  var _fm = 0;
  if (_has('cover', true)) _fm += 1;   // cover
  _fm += 1;                            // title page (always)
  _fm += 1;                            // details page (always)
  if (_has('cast', true))  _fm += 1;   // cast / The Company
  if (_has('toc', false))  _fm += 1;   // table of contents
  var _viewer = function (contentPage) { return contentPage + _fm + 1; };   // 0-based content -> 1-based viewer
  var L = [];
  L.push('PACK PLAN  -  ' + (d.campaign || ''));
  L.push('arrange=' + d.arrange + '  pageH=' + d.pageH.toFixed(2) + 'in  markerBreak=' + d.markerBreak + '  bands=' + d.bands.length + '  content-pages=' + d.pages.length + '  (the PDF also adds front/back matter: cover, title, contents, cast -- so the viewer page count is higher)');
  L.push('front-matter offset: ' + _fm + ' page(s) before content -> a dump PAGE n is viewer page n+' + (_fm + 1) + ' (cover=' + _has('cover', true) + ' cast=' + _has('cast', true) + ' toc=' + _has('toc', false) + ', title+details always)');
  // NEVER-CLIP: pages whose REAL measured height exceeds the clip box -- these are the exact pages
  // where overflow:hidden chops an image or a line of text. Printed up top so it is impossible to miss.
  var _ovf = (d.overflows || []);
  if (_ovf.length) {
    L.push('');
    L.push('!!! NEVER-CLIP: ' + _ovf.length + ' PAGE(S) OVERFLOW THE BOX (content is clipped here) !!!');
    _ovf.forEach(function (o) {
      L.push('    PAGE ' + o.page + ' (viewer p.' + _viewer(o.page) + ')  real ' + o.realIn.toFixed(2) + 'in  vs box ' + o.boxIn.toFixed(2) + 'in  -> OVER by ' + o.overIn.toFixed(2) + 'in');
    });
  }
  var _risk = (d.atRisk || []);
  if (_risk.length) {
    L.push('');
    L.push('!! NEVER-CLIP AT-RISK: ' + _risk.length + ' page(s) fit the box TOTAL but render far taller than planned');
    L.push('   (a tower beside-column or stacked cell can clip INSIDE these even though the page total is under box):');
    _risk.forEach(function (o) {
      L.push('    PAGE ' + o.page + ' (viewer p.' + _viewer(o.page) + ')  real ' + o.realIn.toFixed(2) + 'in  est ' + o.estIn.toFixed(2) + 'in  -> under-planned by ' + o.gapIn.toFixed(2) + 'in');
    });
  }
  if (!_ovf.length && !_risk.length && d.remeasured) {
    L.push('NEVER-CLIP: no page overflows or at-risk gaps (nothing clipped). [OK]');
  }
  var gk = Object.keys(d.grow || {});
  L.push('sized (mul>1 grow / <1 shrink): ' + (gk.length ? gk.map(function (k) { return 'b' + k + '=' + d.grow[k]; }).join('  ') : '(none)'));
  // LAYOUT OPTIONS this plan was built from. Compare these FIRST between two dumps: if they differ,
  // the page counts are not comparable no matter how similar the books look.
  if (d.towerMerge && d.towerMerge.length) {
    L.push('tower merge: ' + d.towerMerge.length + ' attempt(s)');
    d.towerMerge.forEach(function (s) { L.push('  ' + s); });
  } else if (d.towerMerge) {
    L.push('tower merge: no candidates (no single text-only tail sits directly before a tower)');
  }
  if (d.co) {
    var _ck = Object.keys(d.co).sort();
    L.push('layout options: ' + (_ck.length ? _ck.map(function (k) { return k + '=' + d.co[k]; }).join('  ') : '(none -- preset defaults, no custom layout active)'));
  }
  if (d.remeasured) L.push('RE-MEASURED composed pages: each PAGE line shows REAL fill vs the single-pass estimate.');
  else if (d.remeasureError) L.push('re-measure error: ' + d.remeasureError);
  L.push('');
  L.push('BANDS');
  d.bands.forEach(function (b) {
    L.push('  ' + pad('b' + b.i, 5) + pad(b.kind, 15) + 'h' + pad(b.h.toFixed(2), 7) +
      (b.simg ? ('img' + pad(b.sImgH.toFixed(2), 6) + 'a' + pad(b.asp, 5)) : pad('', 14)) + (b.stext ? ('S(' + b.slen + ')') : '-') +
      '  L' + b.nlines + (b.mbound != null ? ('  mb' + b.mbound) : '') +
      (b.title ? ('  "' + b.title + '"') : '') + (b.preview ? ('  | ' + b.preview) : ''));
  });
  L.push('');
  L.push('PAGES  (* = underfull, used < ' + (d.pageH - 1).toFixed(1) + 'in)');
  d.pages.forEach(function (pg) {
    var white = Math.round((d.pageH - pg.used) * 100) / 100;
    var flag = (pg.used < d.pageH - 1) ? '  *UNDERFULL' : '';
    var realStr = (pg.realUsed != null) ? ('  REAL ' + pg.realUsed.toFixed(2) + ' (est ' + pg.used.toFixed(2) + ', ' + ((pg.realUsed - pg.used) >= 0 ? '+' : '') + (pg.realUsed - pg.used).toFixed(2) + ')') : '';
    L.push('  PAGE ' + pad(pg.page, 3) + ' (viewer p.' + pad(_viewer(pg.page), 3) + ') used ' + pad(pg.used.toFixed(2), 6) + '/ ' + d.pageH.toFixed(2) + '  white ' + pad(white.toFixed(2), 6) + flag + realStr);
    pg.cells.forEach(function (c) {
      L.push('      ' + pad('b' + c.band, 5) + pad(c.kind || '?', 15) + 'h' + pad((c.h != null ? c.h : '?'), 7) +
        (c.split ? ('CUT ' + c.cStart + '..' + (c.cEnd == null ? 'end' : c.cEnd)) : '') +
        (c.growMul ? ('  GROWN x' + (Math.round(c.growMul * 100) / 100)) : '') +
        (c.towerLead ? ('  +TOWER-LEAD b' + c.towerLead.band) : '') +
        (c.realH != null ? ('  [REAL-CELL ' + c.realH.toFixed(2) + 'in]') : ''));
    });
  });
  L.push('');
  L.push('=== RAW JSON (kitchen sink) ===');
  L.push(JSON.stringify(d, null, 2));
  return L.join('\n');
}

// Admin-only easter egg: dump the pack plan as plain text (double-click the After page count).
// Runs the same pack the compose does but returns the readable plan instead of a PDF -- no token spend.
router.get('/pack-debug/:campaignId', requireAuth, requireAdmin, async function (req, res) {
  try {
    var _cco = req.query.co ? parseCustomOpts(req.query.co) : {};
    var txt, _dlName = 'campaign';
    if (_cco.arrange === 'magazine' || _cco.arrange === 'gazette') {
      var _flow = !!req.query.flow;
      var packedM = await computeMagazinePack(req, req.params.campaignId, { pageHeightIn: 9.4, debug: true, flowSim: _flow });
      txt = (_flow ? ('FLOW SIMULATION (Before): raw greedy pack with boxes split like the browser, optimization transforms OFF.\nApproximates the Chromium flow -- exact page breaks will differ, but bands and density are directional. Compare band-for-band with the After pack.\n\n') : '') + magazinePlanText(packedM);
      _dlName = String((packedM && packedM.campaign && packedM.campaign.name) || 'campaign').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'campaign';
    } else {
      // Paired (Picture Book) now dumps too: compute with debug so it re-measures the composed
      // book and runs the never-clip check, then format with the paired dumper.
      var packedP = await computePairedPack(req, req.params.campaignId, { pageHeightIn: 9.4, debug: true });
      txt = pairedPlanText(packedP);
      _dlName = String((packedP && packedP.campaign && packedP.campaign.name) || 'campaign').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'campaign';
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    // Download rather than open inline: saves the round trip of File > Save in a new tab.
    res.set('Content-Disposition', 'attachment; filename="' + _dlName + (_flow ? '_Before' : '_After') + '_pack.txt"');
    return res.send(txt);
  } catch (e) {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send('pack-debug error:\n' + ((e && e.stack) || (e && e.message) || e));
  }
});
router.get('/pack-render/:campaignId', requireAuth, async function (req, res) {
  try {
    if (req.query.compose === '1' || req.query.compose === 'true') {
      // Optimize costs 1 token. Check up front; charge only after a successful compose (below).
      if (!(await canAfford(req.session.userId, 1))) return res.status(402).json({ error: 'insufficient_tokens' });
      var _cco = req.query.co ? parseCustomOpts(req.query.co) : {};
      if (_cco.arrange === 'magazine' || _cco.arrange === 'gazette') {
        var packedM = await computeMagazinePack(req, req.params.campaignId, { pageHeightIn: 9.4 });
        _cco.campaignName = (packedM.campaign && packedM.campaign.name) || '';
        var bodyM = composeMagazine(packedM.plan, packedM.bands, _cco);
        composedCachePut(req.params.campaignId, req, _cco.arrange, bodyM, _cco.campaignName);   // the print interior reuses this
        var rbuiltM = await assembleNovelHtml(req, req.params.campaignId, null, { arrange: _cco.arrange, packComposedBody: bodyM });
        if (req.query.pane === '1') rbuiltM.html = paneSafeHtml(rbuiltM.html);
        var pdfM = await renderHtmlToPdf(rbuiltM.html, {});
        try { await spendTokens(req.session.userId, 1, { source: 'optimize_layout', event_type: 'generation_spend', related_campaign_id: req.params.campaignId }); }
        catch (e) { if (e && e.code === 'INSUFFICIENT_TOKENS') return res.status(402).json({ error: 'insufficient_tokens' }); console.error('optimize spend failed:', e && e.message); }
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="composed-preview.pdf"');
        return res.send(Buffer.isBuffer(pdfM) ? pdfM : Buffer.from(pdfM));
      }
      // Per-image decoration overhead (frame + margins) is resolved from the decoration
      // registry inside computePairedPack, per beat -- no hand-coded per-style numbers here.
      var packedC = await computePairedPack(req, req.params.campaignId, { pageHeightIn: 9.4 });
      _cco.campaignName = (packedC.campaign && packedC.campaign.name) || '';
      var body = composeBook(packedC.plan, packedC.beats, _cco);
      composedCachePut(req.params.campaignId, req, 'paired', body, _cco.campaignName);   // the print interior reuses this
      var rbuiltC = await assembleNovelHtml(req, req.params.campaignId, null, { arrange: 'paired', packComposedBody: body });
      if (req.query.pane === '1') rbuiltC.html = paneSafeHtml(rbuiltC.html);   // preview-safe gradients in the Finalize After pane only
      var pdfC = await renderHtmlToPdf(rbuiltC.html, {});
      try { await spendTokens(req.session.userId, 1, { source: 'optimize_layout', event_type: 'generation_spend', related_campaign_id: req.params.campaignId }); }
      catch (e) { if (e && e.code === 'INSUFFICIENT_TOKENS') return res.status(402).json({ error: 'insufficient_tokens' }); console.error('optimize spend failed:', e && e.message); }
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'inline; filename="composed-preview.pdf"');
      return res.send(Buffer.isBuffer(pdfC) ? pdfC : Buffer.from(pdfC));
    }
    var packed = await computePairedPack(req, req.params.campaignId);
    req.query.packRender = '1';
    var rbuilt = await assembleNovelHtml(req, req.params.campaignId, packed.overrides);
    var pdf = await renderHtmlToPdf(rbuilt.html, {});
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="packed-preview.pdf"');
    res.send(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf));
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'pack-render failed' });
  }
});

// PHASE 2 (page-packer) inspect: measure text, compute image heights, run packPaired,
// PHASE 2 (page-packer) inspect: measure text, compute image heights, run packPaired,
// and return the deterministic page plan (beat -> page, with image shrink factors) as JSON.
// Pure inspection -- renders nothing, changes nothing. Validate the plan before Phase 3 renders it.
router.get('/pack-paired/:campaignId', requireAuth, async function (req, res) {
  try {
    req.query.measurePaired = '1';
    var built = await assembleNovelHtml(req, req.params.campaignId, null);
    var measured = await measureDocument(built.html, {});
    var blocks = measured.blocks || [];
    var pageH = 9.7;
    var bi = 0;
    var packBeats = (built.beats || []).map(function (beat) {
      var tb = 0, ta = 0;
      if (beat.before) { tb = (blocks[bi] && blocks[bi].heightIn) || 0; bi++; }
      if (beat.after) { ta = (blocks[bi] && blocks[bi].heightIn) || 0; bi++; }
      return { idx: beat.idx, shape: beat.shape, hasImage: beat.hasImage, imageH: beat.hasImage ? beatImageHeight(beat, pageH) : 0, textBeforeH: tb, textAfterH: ta, isTower: ((beat.aspect || 1) <= 0.42) };
    });
    var plan = packPaired(packBeats, { pageHeightIn: pageH });
    res.json({
      campaign: built.campaign ? built.campaign.name : null,
      beatCount: packBeats.length,
      textBlocksMeasured: blocks.length,
      pageCount: plan.pageCount,
      imagesShrunk: plan.imagesShrunk,
      totalWhiteIn: plan.totalWhiteIn,
      whiteByPage: plan.whiteByPage,
      pages: plan.pages
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'pack-paired failed' });
  }
});

// PHASE 1 (page-packer) verification: measure paired-layout narration heights.
// Returns the true rendered height (in inches) of every text block in reading order,
// so the measurement foundation can be validated before the packer is built.
router.get('/measure-paired/:campaignId', requireAuth, async function (req, res) {
  try {
    req.query.measurePaired = '1';
    var built = await assembleNovelHtml(req, req.params.campaignId, null);
    var measured = await measureDocument(built.html, {});
    res.json({
      campaign: built.campaign ? built.campaign.name : null,
      layout: built.layoutStyle,
      blockCount: measured.blockCount,
      totalTextHeightIn: measured.totalBlockHeightIn,
      blocks: measured.blocks
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'measure-paired failed' });
  }
});

module.exports = router;
module.exports.buildNovelHTML = buildNovelHTML;
module.exports.assembleNovelHtml = assembleNovelHtml;
