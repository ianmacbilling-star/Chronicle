// ============================================================================
// FRAME FIDELITY PROBE  --  TD-351
// ----------------------------------------------------------------------------
// WHY THIS EXISTS. On 2026-08-08 a rendered book showed two decorative CSS
// features degrading in the PDF while looking correct in the browser:
//
//   * the plaque's scalloped corners vanished entirely -- four mask layers
//     combined with `mask-composite: intersect`, dropped by the print path
//     (TD-347);
//   * the moulding's five HARD-STOP planes came out as a smooth ramp.
//     Measured off a 7x screenshot: not one flat plateau anywhere in the rail,
//     while vector text on the same page was pixel-sharp. The colours and their
//     order were right; the plane BREAKS were gone -- and the breaks are the
//     entire basis of v3.0.528, because the eye reads the breaks, not the
//     shading within them.
//
// A bitmap hypothesis was raised and DISPROVED by measurement: the frame's
// outer edge transitions in 3px, identical to vector type on the same page. It
// is not a resolution problem. It is interpolation across gradient stops.
//
// WHAT THIS ROUTE ANSWERS, and it is deliberately a question rather than a fix.
// Four ways of drawing the same profile, on one page, at two rail widths:
//
//   A  CSS gradients        the code as it ships today, calling the REAL emitter
//   B  solid <div> planes   flat fills; nothing for a shading function to ramp
//   C  inline SVG rects     flat fills as vector shapes
//   D  raster border-image  a 4x nine-slice PNG, downsampled by the renderer
//
// If B and C step cleanly and A ramps, the cause is confirmed and the rebuild
// has evidence behind it. If everything ramps, the cause is elsewhere and no
// rebuild was wasted on a guess -- which is the point of spending one page
// before committing to any of the three routes.
//
// A CALLS THE SHIPPING EMITTER ON PURPOSE. bronzeMouldingHtml is imported from
// routes/pdf.js rather than reimplemented, so the control arm cannot drift from
// what books actually render. B, C and D are local to this file and reach
// nothing.
//
// THIS IS A DEV ROUTE. Admin-gated, mounted at /api/frameprobe, touches no
// render path, and is listed for removal with the other dev endpoints at
// TF-02 / GL-11.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { renderHtmlToPdf } = require('../services/printing/renderPdf');
const { baseFontCss } = require('../services/printing/fonts');
const pdfRoutes = require('./pdf');

// The profile, kept here as DATA so all four variants are provably drawing the
// same thing. These values mirror _lit / _shad in pdf.js; the guard in the apply
// script asserts they still match, because a probe whose control arm has drifted
// from the code answers a question nobody asked.
var LIT = [[0, 20, '#f4e6b8'], [20, 34, '#e0c77c'], [34, 66, '#a8862f'], [66, 86, '#7a5d22'], [86, 100, '#3d2d0c']];
var SHAD = [[0, 20, '#241708'], [20, 34, '#5f4715'], [34, 66, '#8a6a2a'], [66, 86, '#e0c77c'], [86, 100, '#3d2d0c']];
var MAT_SH = ['#c9c1af', '#dcd5c6'];   // top and left  -- the shadowed bevel
var MAT_LT = ['#ece7d9', '#f8f5ec'];   // bottom and right -- the lit bevel
var BORD_TL = '#4a3418', BORD_BR = '#150e04', BORD_W = 3;

var PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAJAAAACQCAYAAADnRuK4AAAE70lEQVR42u2dTUgVURTHZ2Q2hbkxyxZ9QErQNyVBlr' +
  'UrkKCiwKBFtkzogyCCWhaB1a42uRJEqCijchFGRNk3ERKVUYa5CcznIj/K4oGtIj9mzn33zcx17rzfbyX3PufMPe/P' +
  'OffeOXOf6zjOuKPByLd7Yn+m74lv+4uHd518eds9LPZ3dn0P7Lt4ucW3vXTufN/2ihXVoq2x0Yy/X4YGfdt3b1sfeK' +
  '2WpmOirestbXn77P2XAd/2p12yL3v6x7TsFDkAIUBAgIBg5vCmNtRWlcdiqO5ws9h/7VJ9IhwS1/ij5kRjq9hfv3db' +
  'XtctK/HE/oGhLBEISGGAgAABAQLCBYCAAAGBnXiqZ1tRkZR9HhXX7zRbcZ8XTu6P5bq9H9uJQEAKAwQECAgAAQECAg' +
  'QE6cQLqmEOYu7izXkZsqUeSOWP8tVVibjPuOqBdPVABAJSGCAgQECAgAB0V2FT3xhVrZZGh/vF/sUr94S6IT/7dRP+' +
  'Pt0gX//xs06x/9Wbr6Hu/7fi/kuLf4r3s6W6Jmf7Jxqn30uuT+Gbb3T4tldWbAw1/qmrZSIQhItApg3aUheUdIIikW' +
  'p/iDkQMIkGBASAgAABwQzjXj23RuuEsh31jWK/7SeUvb59SLS16+gD3/a0nFB29ugyIhCYw9g+kC31QLYQVz0QcyBg' +
  'Eg0ICBAQQA6TaNUSedoyPuUOUfljV4GPnwgEpDBIUAozZYh9nmiJ63wgIhAgIEBAgIAAcphES6UQhUih+0N3/EQgII' +
  'XBDKYwU4aoB4oW6oGAFAaAgCAU7stHt8ZNGNqwbonYrzo1I2qC3soYzMinj6yp8j9dI+itjC+fPqTan0QgQECAgMBS' +
  'jO0DmZ7jpJ2k+JMIBOEiUNBqJC2oVlW5rs6iXu0xBwJAQICAAAEBAoICxXUcZ9KzsNqqcvEfVL+rHnRCme4J6BMxeU' +
  'JZxYpqV7I1NprxfXZo+oSyfOuBVCeU/fiVFfsHhrJEICCFAQICBAQICBcAAgIEBHbiBu1rgB5B+0DFJaVEIAAEBAgI' +
  'EBAgIID/eEGrB3AiWVWl3b9EIAgXgUwZKi3+KfYPjszm27DQn0QgQECAgMBS3JpVxUaehT1+1in2b6muicWubk30wX' +
  '3y2YL3X3zVWm3ZVhO9YJ7etJgIBKQwQEBgKcb2geKa4xQq/F4YkMIAPNVS0nb6/+h9Pu3+iHr8RCAghQECAgQEBTmJ' +
  'NmVIdT5Q37ubfBsa8HthQAoD8KSSgWhDrpzC4rqPrXXrtT6vuo8jF46lWhC63wMRCEhhgIAAAUFBTqJNGUpK/UpaoB' +
  '4IUoF7vmH5+OTldmso5Sf9///90l/QWxlLF80S//930ULf9n9vZajeGJ1YmelXOqHasQ87/sqKjWL/557nWvaJQEAK' +
  'AwQECAgQEIAmnmmDQasE9omi8SMRCKzCPbC9zMjpHM03OsT+uCroGk41+bYH7QOdOb5TvN6Vtm7f9rSczrFp7RwiEJ' +
  'DCAAEBAgJAQBAnnmpWHhWqp8Bx0aD5eVP+CEtc+2a64ycCASkMEBAgIEBAAAgIEBBYg9fTPzapoaxELhHq/dgu9mf6' +
  'nvi2q942uHapPrDvbbe8N9HZ9T0yh/z4lbXii4vrfCDV+AeGskQgIIUBAgIEBAgIFwACAgQEduKp1vlRIe3zJIm4xh' +
  '81cdUD6Y6fCASkMEBAYCl/ATwtla3OWcJ0AAAAAElFTkSuQmCC';

// ---------------------------------------------------------------- B: solid divs
// Five flat planes per rail as absolutely positioned elements. No gradient, so
// there are no stops to interpolate between. Beads are deliberately OMITTED --
// this arm tests one thing only: whether a flat fill keeps its edges.
function variantSolid(rail, mat) {
  var out = '';
  function plane(css, col) { return '<i style="position:absolute;' + css + 'background:' + col + ';"></i>'; }
  LIT.forEach(function (p) {
    var a = rail * p[0] / 100, b = rail * p[1] / 100;
    out += plane('left:0;right:0;top:' + (BORD_W + a) + 'px;height:' + (b - a) + 'px;', p[2]);
    out += plane('top:0;bottom:0;left:' + (BORD_W + a) + 'px;width:' + (b - a) + 'px;', p[2]);
  });
  SHAD.forEach(function (p) {
    var a = rail * p[0] / 100, b = rail * p[1] / 100;
    out += plane('left:0;right:0;bottom:' + (BORD_W + a) + 'px;height:' + (b - a) + 'px;', p[2]);
    out += plane('top:0;bottom:0;right:' + (BORD_W + a) + 'px;width:' + (b - a) + 'px;', p[2]);
  });
  var h = mat / 2;
  out += plane('left:0;right:0;top:' + (BORD_W + rail) + 'px;height:' + h + 'px;', MAT_SH[0]);
  out += plane('left:0;right:0;top:' + (BORD_W + rail + h) + 'px;height:' + h + 'px;', MAT_SH[1]);
  out += plane('top:0;bottom:0;left:' + (BORD_W + rail) + 'px;width:' + h + 'px;', MAT_SH[0]);
  out += plane('top:0;bottom:0;left:' + (BORD_W + rail + h) + 'px;width:' + h + 'px;', MAT_SH[1]);
  out += plane('left:0;right:0;bottom:' + (BORD_W + rail) + 'px;height:' + h + 'px;', MAT_LT[1]);
  out += plane('left:0;right:0;bottom:' + (BORD_W + rail + h) + 'px;height:' + h + 'px;', MAT_LT[0]);
  out += plane('top:0;bottom:0;right:' + (BORD_W + rail) + 'px;width:' + h + 'px;', MAT_LT[1]);
  out += plane('top:0;bottom:0;right:' + (BORD_W + rail + h) + 'px;width:' + h + 'px;', MAT_LT[0]);
  return '<div style="position:absolute;inset:0;pointer-events:none;">' + out + '</div>';
}

// ---------------------------------------------------------------- C: inline SVG
// The same planes as <rect> elements. Drawn at the box's exact pixel size with
// no scaling, so a rect edge lands on a whole pixel and any softness is the
// renderer's rather than ours.
function variantSvg(rail, mat, w, h) {
  var r = '';
  function rect(x, y, ww, hh, col) {
    return '<rect x="' + x + '" y="' + y + '" width="' + ww + '" height="' + hh + '" fill="' + col + '" shape-rendering="crispEdges"/>';
  }
  r += rect(0, 0, w, BORD_W, BORD_TL) + rect(0, 0, BORD_W, h, BORD_TL);
  r += rect(0, h - BORD_W, w, BORD_W, BORD_BR) + rect(w - BORD_W, 0, BORD_W, h, BORD_BR);
  LIT.forEach(function (p) {
    var a = rail * p[0] / 100, b = rail * p[1] / 100;
    r += rect(0, BORD_W + a, w, b - a, p[2]) + rect(BORD_W + a, 0, b - a, h, p[2]);
  });
  SHAD.forEach(function (p) {
    var a = rail * p[0] / 100, b = rail * p[1] / 100;
    r += rect(0, h - BORD_W - b, w, b - a, p[2]) + rect(w - BORD_W - b, 0, b - a, h, p[2]);
  });
  var hm = mat / 2;
  r += rect(0, BORD_W + rail, w, hm, MAT_SH[0]) + rect(0, BORD_W + rail + hm, w, hm, MAT_SH[1]);
  r += rect(BORD_W + rail, 0, hm, h, MAT_SH[0]) + rect(BORD_W + rail + hm, 0, hm, h, MAT_SH[1]);
  r += rect(0, h - BORD_W - rail - mat, w, hm, MAT_LT[1]) + rect(0, h - BORD_W - rail - hm, w, hm, MAT_LT[0]);
  r += rect(w - BORD_W - rail - mat, 0, hm, h, MAT_LT[1]) + rect(w - BORD_W - rail - hm, 0, hm, h, MAT_LT[0]);
  return '<svg style="position:absolute;inset:0;pointer-events:none;" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' + r + '</svg>';
}

// ---------------------------------------------------------------- D: raster
// A 4x nine-slice PNG. 1.3KB, so the v3.0.522 objection to the SVG moulding
// (12.1KB per picture inlined, 710KB a book) does not apply -- and in the real
// thing this would be one cached file, not a data URI.
var PROBE_SLICE = 68;
function variantRaster(rail, mat) {
  var d = rail + mat + BORD_W;
  return '<div style="position:absolute;inset:0;pointer-events:none;box-sizing:border-box;' +
    'border:' + d + 'px solid transparent;' +
    'border-image-source:url(data:image/png;base64,' + PROBE_PNG + ');' +
    'border-image-slice:' + PROBE_SLICE + ' fill;border-image-repeat:stretch;"></div>';
}

// ---------------------------------------------------------------- the page
function cell(label, inner, w, h) {
  return '<div class="cell">' +
    '<div class="lab">' + label + '</div>' +
    '<div class="box" style="width:' + w + 'px;height:' + h + 'px;">' +
      '<div class="art"></div>' + inner +
    '</div>' +
  '</div>';
}

function buildProbeHtml() {
  var W = 250, H = 170;
  var rows = '';
  [[11, 3], [8, 2]].forEach(function (rm) {
    var rail = rm[0], mat = rm[1];
    var tag = ' &mdash; rail ' + rail + 'px, mat ' + mat + 'px';
    rows += '<div class="row">' +
      cell('A &nbsp; CSS gradients (shipping)' + tag, pdfRoutes.bronzeMouldingHtml(rail, mat), W, H) +
      cell('B &nbsp; solid divs' + tag, variantSolid(rail, mat), W, H) +
      '</div>' +
      '<div class="row">' +
      cell('C &nbsp; inline SVG rects' + tag, variantSvg(rail, mat, W, H), W, H) +
      cell('D &nbsp; raster border-image 4x' + tag, variantRaster(rail, mat), W, H) +
      '</div>';
  });
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    baseFontCss() +
    '@page{size:8.5in 11in;margin:0;}' +
    'body{margin:0;padding:0.4in;font-family:Cinzel,serif;background:#fff;}' +
    'h1{font-size:13pt;margin:0 0 2pt;}' +
    '.note{font-family:"Crimson Text",serif;font-size:8.5pt;color:#555;margin:0 0 10pt;line-height:1.35;}' +
    '.row{display:flex;gap:14px;margin-bottom:12px;}' +
    '.cell{flex:0 0 auto;}' +
    '.lab{font-size:7pt;letter-spacing:0.04em;margin-bottom:3px;color:#2c1810;}' +
    '.box{position:relative;line-height:0;background:#0a0806;}' +
    '.art{position:absolute;inset:0;background:#6b6f74;}' +
    '</style></head><body>' +
    '<h1>FRAME FIDELITY PROBE &mdash; TD-351</h1>' +
    '<p class="note">Same profile, four ways. <b>Look at the rails under magnification and ask one question: are there FLAT BANDS with visible steps between them, or a continuous ramp?</b> ' +
    'A is the shipping code. B and C use flat fills, which have no stops to interpolate. D is a 4x raster downsampled by the renderer. ' +
    'The grey centre is deliberate &mdash; a flat ground makes the rail edges maximally readable, where a picture would camouflage them.</p>' +
    rows +
    '</body></html>';
}

router.get('/frame', requireAuth, requireAdmin, async function (req, res) {
  try {
    const pdf = await renderHtmlToPdf(buildProbeHtml(), { printBackground: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="frame-probe.pdf"');
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// The same page as HTML, so the browser and the PDF can be compared side by side.
// That comparison IS the finding: if A steps here and ramps in the PDF, the print
// path is the variable and nothing about the CSS needs defending.
router.get('/frame.html', requireAuth, requireAdmin, function (req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildProbeHtml());
});

module.exports = router;
