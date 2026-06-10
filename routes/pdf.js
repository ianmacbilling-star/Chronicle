const express = require('express');
const router = express.Router();
const { getDb, getDmForkId, getViewableForkId } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const { uploadFile } = require('../storage/storage');
const { renderHtmlToPdf } = require('../services/printing/renderPdf');

// Shared drop shadow for gallery panels AND character portraits (kept in lockstep).
var CO_IMG_SHADOW = '7px 7px 10px -2px rgba(0,0,0,0.5), 18px 18px 30px -10px rgba(0,0,0,0.5)';

// ============================================================
// Date helper - handles both PostgreSQL Date objects and SQLite strings
// ============================================================
function formatDate(dateVal, options) {
  if (!dateVal) return '';
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', options || {
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
function lmFocal(m) { var f = lmMeta(m).focal; return (['center', 'top', 'bottom', 'left', 'right'].indexOf(f) >= 0) ? f : 'center'; }
function lmCropSafe(m) { return lmMeta(m).crop_safe === false ? false : true; }
function lmGroupBreak(m) { return lmMeta(m).group_break === true; }
function shapeRatioCSS(shape) { var r = shapeRatio(shape); return r[0] + ' / ' + r[1]; }
function normShape(m) {
  var s = (m && m.shape) || '';
  return (['wide', 'tall', 'square', 'panoramic', 'tower', 'fullpage'].indexOf(s) >= 0) ? s : 'standard';
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
  var ratio = shapeRatioCSS(normShape(m));
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
  var ratio = shapeRatioCSS(normShape(m));
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
  var ratio = shapeRatioCSS(normShape(m));
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
  var ratio = shapeRatioCSS(shape);
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
  var ratio = shapeRatioCSS(shape);
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
function framedMedia(m) {
  var ratio = shapeRatioCSS(normShape(m));
  var inner = m.image
    ? '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#160e06;"></div>';
  return '<div style="padding:8px;background:linear-gradient(135deg,#2c1e10 0%,#0d0a06 52%,#2c1e10 100%);border:1px solid #0a0806;border-radius:2px;box-shadow:0 2px 6px rgba(0,0,0,0.4);">' +
    '<div style="padding:2px;background:#0a0806;">' +
    '<div style="border:1.5px solid #c9a84c;line-height:0;">' + inner + '</div>' +
    '</div>' +
  '</div>';
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
  var ratio = shapeRatioCSS(normShape(m));
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
  border: 'keyline',     // none | keyline | frame | comic | vignette | gallery
  caption: 'bar',        // plate | bar | engraved | gradient | none
  gutter: 'normal',      // tight | normal | airy
  density: 'normal',     // busy | normal | roomy
  narr: 'plain',         // plain | box
  dropcap: 0,            // 0 | 1
  paper: 'white',        // white | linen | grey
  condition: 'none',     // none | smoke | dirt | wrinkle | blood
  font: 'classic',
  pano: 1, aside: 1, companion: 1, emphasis: 0,
  cover: 1, cast: 1, toc: 1, header: 1, markers: 1, watermark: 1
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
  var ratio = shapeRatioCSS(normShape(m));
  var img = m.image
    ? '<img style="width:100%;aspect-ratio:' + ratio + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + (m.title || '') + '" />'
    : '<div style="width:100%;aspect-ratio:' + ratio + ';background:#1a0f06;"></div>';
  switch (border) {
    case 'frame': return framedMedia(m);
    case 'comic': return '<div style="border:5px solid #0a0806;background:#160e06;overflow:hidden;line-height:0;">' + img + '</div>';
    case 'vignette':
      return '<div style="position:relative;line-height:0;">' + img +
        '<div style="position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0.5in 0.3in #ffffff;"></div>' +
        '<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at center, rgba(255,255,255,0) 52%, rgba(255,255,255,0.6) 82%, rgba(255,255,255,1) 100%);"></div></div>';
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
    return '<div style="position:absolute;left:0;right:0;bottom:0;padding:0.4in 0.22in 0.12in;background:linear-gradient(to top,rgba(10,8,6,0.88),rgba(10,8,6,0.4) 55%,rgba(10,8,6,0));color:#f3e7c8;font-family:Cinzel,serif;font-size:10pt;font-weight:600;letter-spacing:0.03em;">' + m.title + '</div>';
  return '';
}

function coCaptionBelow(m, i, caption) {
  if (!m.title) return '';
  if (caption === 'engraved')
    return '<div style="text-align:center;margin-top:0.12in;font-family:Cinzel,serif;font-size:9.5pt;letter-spacing:0.12em;text-transform:uppercase;color:#8a6a2a;">' + m.title + '</div>';
  if (caption === 'bar') return panelCaption(m, i);
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

function renderPaired(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var overlay = coCaptionOverlay(m, opts.caption);
    var beforeHtml = section.before ? '<div style="margin-top:0.1in;">' + coNarr(section.before, opts, false) + '</div>' : '';
    var afterHtml = section.after ? '<div style="margin-top:0.1in;">' + coNarr(section.after, opts, false) + '</div>' : '';
    if (isPortrait(m)) {
      // Picture Book signature: tall/tower panels render large but NOT quite full
      // page height. Target height is 7.0in (not 8.5in) so the image leaves ~2.5in
      // and can share a sheet with a paragraph or two above it, instead of being
      // bumped to its own page -- which stranded white space above a near-full-page
      // portrait. Width is derived from the shape (content column ~6.8in). Narrative
      // still flows BELOW the image as its own block, never locked to it.
      // (Tunable: raise 7.0 toward 8.5 for bigger portraits / more page-sharing white.)
      var pw = Math.min(96, Math.round((7.0 * shapeAspect(normShape(m)) / 6.8) * 100));
      html += '<div style="width:' + pw + '%;margin:0 auto 0.06in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      html += beforeHtml + afterHtml;
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
var CG_BORDER = 'border:4px solid #0a0806;overflow:hidden;';

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

function renderComicPage(moments, sections, intro, outro, opts) {
  var html = coDropOrIntro(intro, opts);

  // Connected tier-grid. Panels pack into horizontal tiers; each tier's height is
  // solved so the panels (widthed by their TRUE aspect) justify to the full content
  // width with uniform gutters. Every panel in a tier shares that height, so tiers
  // are clean 90-degree rectangles and nothing is cropped. Narration drops as a
  // full-width caption tier beneath the images it belongs to.
  var panels = [];
  for (var k = 0; k < moments.length; k++) {
    var mm = moments[k];
    var sec = sections.find(function (s) { return s.panel_index === k; }) || {};
    var parts = [];
    if (sec.before) parts.push(coNarr(sec.before, opts, false));
    if (sec.after) parts.push(coNarr(sec.after, opts, false));
    panels.push({ m: mm, asp: Math.max(0.3, momentAspect(mm)), narr: parts.join(''),
      hero: (lmProminence(mm) >= 5), brk: lmGroupBreak(mm) });
  }

  var target = coRowTarget(opts.density);   // aspect-sum per tier (density dial)
  var MAXH = 4.8;                            // height cap for a normal tier (inches)
  var HEROH = 5.6;                           // taller cap for a hero tier

  var i = 0;
  while (i < panels.length) {
    var tier = [panels[i]];
    var sum = panels[i].asp;
    var isHero = panels[i].hero;
    if (isHero) {
      i += 1;                                // a hero stands alone on its own tier
    } else {
      var j = i + 1;
      while (j < panels.length && !panels[j].brk && !panels[j].hero && sum < target) {
        tier.push(panels[j]); sum += panels[j].asp; j += 1;
      }
      i = j;
    }

    var n = tier.length;
    var availW = CG_W - (n - 1) * CG_GAP;
    var H = availW / sum;                    // justify: widths sum to availW
    var capH = isHero ? HEROH : MAXH;
    var fillsWidth = true;
    if (H > capH) { H = capH; fillsWidth = false; }   // too tall -> cap height, center

    var cells = tier.map(function (c) { return cgGridCell(c.m, opts, c.asp * H, H); }).join('');
    var justify = fillsWidth ? '' : 'justify-content:center;';
    html += '<div style="display:flex;gap:' + CG_GAP + 'in;margin-bottom:' + CG_GAP + 'in;' +
      'height:' + H.toFixed(2) + 'in;' + justify +
      'page-break-inside:avoid;break-inside:avoid;">' + cells + '</div>';

    var combined = tier.map(function (c) { return c.narr; }).filter(Boolean).join('');
    if (combined) html += cgCaptionTier(combined);
  }

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
function renderMagazine(moments, sections, intro, outro, opts){
  var html = coDropOrIntro(intro, opts);
  for (var i = 0; i < moments.length; i++) {
    var m = moments[i];
    var shape = normShape(m);
    var section = sections.find(function (s) { return s.panel_index === i; }) || {};
    var nlen = coNarrLen(section.after);
    var wmin = magWrapMin(shape);
    if (section.before) html += '<div style="clear:both;">' + coNarr(section.before, opts, false) + '</div>';
    if (magFull(shape)) {
      html += '<div style="clear:both;"></div>';
      var overlay = coCaptionOverlay(m, opts.caption);
      html += '<div style="width:100%;margin:0.2in 0 0.1in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + overlay + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
      if (section.after) html += coNarr(section.after, opts, false);
    } else if (nlen >= wmin) {
      // Plenty of text: float the image to one consistent side so the narrative
      // always gets the full remaining width on the other side (no opposing
      // floats squeezing it into a gutter).
      html += coFloatImg(m, i, 'right', opts);
      html += coNarr(section.after, opts, false);
    } else if (nlen === 0) {
      // No text at all: center the image big on its own.
      html += '<div style="clear:both;"></div>';
      html += '<div style="width:' + magSoloWidth(shape) + '%;margin:0.22in auto 0.14in;page-break-inside:avoid;">' +
        '<div style="position:relative;line-height:0;">' + coMedia(m, opts.border) + coCaptionOverlay(m, opts.caption) + '</div>' +
        coCaptionBelow(m, i, opts.caption) + '</div>';
    } else {
      // Short paragraph: image beside the text, image sized to balance heights.
      html += magAside(m, i, opts, section.after, magAsideWidth(shape, nlen, wmin));
    }
  }
  html += '<div style="clear:both;"></div>';
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
function buildSessionHTML(session, moments, campaign, characters, narrative, opts) {
  var co = opts || null;
  var fCover  = co ? !!co.cover     : true;
  var fHeader = co ? !!co.header    : true;
  var fWmark  = co ? !!co.watermark : true;
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
    color: rgba(201,168,76,0.25);
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
    color: rgba(201,168,76,0.2);
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
    .content-page { min-height: 0; padding-top: 0; padding-bottom: 0; }
    @page { size: 8.5in 11in; margin: 0.65in 0; }
    ${fCover ? '@page :first { margin:0; }' : ''}
    .content-page + .content-page { margin-top:0.4in; }
  }
</style>
</head>
<body>

${fCover ? `<!-- COVER PAGE -->
<div class="cover-page">
  <div class="cover-bg"></div>
  <div class="cover-border"></div>
  <div class="cover-border-inner"></div>
  <div class="cover-content">
    <img class="cover-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />
    <div class="cover-eyebrow">A Saga of</div>
    <div class="cover-campaign">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-session">${session.name}</div>
    <div class="cover-date">${formatDate(session.session_date)}</div>
  </div>
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
  ${panelsHTML}
  </div>
</div>

${fWmark ? '<div class="page-watermark">CAMPAIGNIA.COM</div>' : ''}

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
  var fCover  = (pageOpts && pageOpts.noCover) ? false : (co ? !!co.cover : true);
  var fCast   = co ? !!co.cast      : true;
  var fToc    = co ? !!co.toc       : false;
  var fHeader = co ? !!co.header    : true;
  var fMarkers= co ? !!co.markers   : true;
  var fWmark  = co ? !!co.watermark : true;
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
  const dates = sessions.map(function(s) { return new Date(s.session_date + 'T12:00:00'); });
  const minDate = new Date(Math.min.apply(null, dates));
  const maxDate = new Date(Math.max.apply(null, dates));
  const dateRange = minDate.toLocaleDateString('en-US', {month:'long', year:'numeric'}) +
    (minDate.getTime() !== maxDate.getTime() ? ' — ' + maxDate.toLocaleDateString('en-US', {month:'long', year:'numeric'}) : '');
  const coverImg = campaign.cover_image_url || '';

  // Cast page
  const castHTML = characters.map(function(c) {
    var primaryImg = c.canonical_reference_url || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    return '<div class="cast-member">' +
      (primaryImg
        ? '<img class="cast-portrait" src="' + primaryImg + '" alt="' + c.name + '" />'
        : '<div class="cast-portrait cast-no-img">' + c.name.charAt(0) + '</div>') +
      '<div class="cast-name">' + c.name + '</div>' +
      '<div class="cast-cls">' + (c.cls || '') + '</div>' +
      (c.player_name ? '<div class="cast-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="cast-desc">' + ((c.description || '').slice(0, 80)) + (c.description && c.description.length > 80 ? '...' : '') + '</div>' +
    '</div>';
  }).join('');

  // Get DM name from campaign
  const dmName = campaign.dm_name || 'The Story Master';

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
      panelsHTML +
      '</div>' +
    '</div>';
  }).join('');

  var tocRows = sessions.map(function(s, idx){
    return '<div class="toc-row"><span class="toc-name">Session ' + (idx+1) + ' &mdash; ' + s.name + '</span><span class="toc-dots"></span><span class="toc-date">' + formatDate(s.session_date, {year:'numeric',month:'short',day:'numeric'}) + '</span></div>';
  }).join('');
  var tocBlock = '<div class="content-page toc-page"><div class="toc-title">Contents</div><div class="cast-divider"></div>' + tocRows + '</div>';

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
  .cover-watermark { position:absolute;bottom:0.5in;left:50%;transform:translateX(-50%);font-family:'Cinzel',serif;font-size:8pt;color:rgba(201,168,76,0.25);letter-spacing:0.15em;z-index:1; }
  /* Cover-art layout: framed cover image fills the page; title, dates, and centered logo overlaid in the lower half. */
  .cover-content.cover-image-layout { position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;padding:0.7in;text-align:center; }
  .cover-art-frame { position:relative;flex:1;width:100%;border:2px solid rgba(201,168,76,0.55);border-radius:8px;overflow:hidden;background:#0a0604;box-shadow:0 4px 24px rgba(0,0,0,0.5); }
  .cover-art-img { width:100%;height:100%;object-fit:cover;object-position:center top;display:block; }
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
  .cast-portrait { width:1.2in;height:1.2in;object-fit:cover;object-position:center top;border-radius:50%;border:2px solid rgba(201,168,76,0.3);margin-bottom:0.1in;box-shadow:${CO_IMG_SHADOW}; }
  .cast-no-img { width:1.2in;height:1.2in;border-radius:50%;border:2px solid rgba(201,168,76,0.3);background:#c9a84c;color:#2c1810;display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-size:24pt;font-weight:700;margin:0 auto 0.1in; }
  .cast-name { font-family:'Cinzel',serif;font-size:11pt;font-weight:600;color:#2c1810;margin-bottom:0.03in; }
  .cast-cls { font-family:'Crimson Text',serif;font-size:10pt;color:#8a6a2a;font-style:italic;margin-bottom:0.03in; }
  .cast-player { font-family:'Cinzel',serif;font-size:8pt;color:#9e9088;letter-spacing:0.05em;margin-bottom:0.05in; }
  .cast-desc { font-family:'Crimson Text',serif;font-size:9pt;color:#6b5f55;line-height:1.4; }

  /* CONTENT */
  .content-page { width:8.5in;padding:0.5in 0.85in;position:relative; }
  .content-page:last-of-type { page-break-after:avoid; }
  .cast-page, .content-page { ${paperCSS} }
  .toc-page { page-break-after:always; }
  .toc-title { font-family:'Cinzel',serif;font-size:22pt;font-weight:700;color:#2c1810;text-align:center;margin-bottom:0.1in; }
  .toc-row { display:flex;align-items:baseline;gap:8px;margin:0.12in 0;font-family:'Cinzel',serif; }
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
  .page-watermark { position:fixed;bottom:0.35in;right:0.5in;font-family:'Cinzel',serif;font-size:7pt;color:rgba(201,168,76,0.2);letter-spacing:0.1em; }

  @media print {
    * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body { width:8.5in; }
    @page { size:8.5in 11in; margin:0.65in 0; }
    ${fCover ? '@page :first { margin:0; }' : ''}
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
        <img class="cover-art-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />
      </div>
    </div>
  </div>` : `<div class="cover-content">
    <img class="cover-logo" src="/images/Campaignia_Logo.png" alt="Campaignia" />
    <div class="cover-eyebrow">The Saga of</div>
    <div class="cover-title">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-subtitle">${campaign.description || 'A tale of adventure and legend'}</div>
    <div class="cover-dates">${dateRange}</div>
  </div>`}
  <div class="cover-watermark">CAMPAIGNIA.COM</div>
</div>` : ''}
${(fCast && (!paginated || pageOpts.page === 1)) ? `<!-- CAST & CREW PAGE -->
<div class="cast-page">
  <div class="cast-page-title">The Company</div>
  <div class="cast-page-subtitle">${campaign.description || ''}</div>
  <div class="cast-divider"></div>
  <div class="cast-page-dm">Story Master: ${dmName} &nbsp;&nbsp;|&nbsp;&nbsp; ${dateRange}</div>
  <div class="cast-grid">${castHTML}</div>
</div>` : ''}
${(fToc && (!paginated || pageOpts.page === 1)) ? tocBlock : ''}

<!-- SESSIONS -->
${allSessionsHTML}

${fWmark ? '<div class="page-watermark">CAMPAIGNIA.COM</div>' : ''}

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
    var u = await db.prepare('SELECT subscription_status, trial_started_at FROM users WHERE id = ?').get(userId);
    if (!u || !u.trial_started_at) return false;
    var within = (Date.now() - new Date(u.trial_started_at).getTime()) < 30 * 24 * 60 * 60 * 1000;
    return within && ((u.subscription_status || 'trialing') === 'trialing');
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
    let html = buildSessionHTML(session, moments, campaign, characters, narrative, co);
    if (await userInFreeTrial(db, req.session.userId)) html = injectTrialWatermark(html);
    if (req.query.format === 'pdf') return await sendHtmlAsPdf(res, html, 'session-' + session.id);
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
    'SELECT c.*, cm.role AS my_role FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id WHERE c.id = ? AND cm.user_id = ?'
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
  let html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts, co);
  if (await userInFreeTrial(db, req.session.userId)) html = injectTrialWatermark(html);
  if (req.query.format === 'pdf') {
    try { return await sendHtmlAsPdf(res, html, 'novel-' + campaign.id); }
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
    'SELECT c.*, cm.role AS my_role FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id WHERE c.id = ? AND cm.user_id = ?'
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

  var pageOpts = { noCover: true }; // full book, never paginated for print

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
    return res.json({ url: url, bytes: pdfBuffer.length });
  } catch (e) {
    console.error('[print-interior] upload failed:', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'PDF upload failed', detail: String(e && e.message ? e.message : e) });
  }
});

module.exports = router;
