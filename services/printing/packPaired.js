'use strict';

// ============================================================
// packPaired.js  -  pure page packer for the PAIRED (Picture Book) layout.
// ------------------------------------------------------------
// Input: beats in reading order, each:
//   { idx, shape, hasImage, imageH (analytic full display height, in),
//     textBeforeH, textAfterH (measured narration heights, in) }
// Walks beats onto fixed-height pages, placing [before-text, image, after-text].
// Fills gaps DETERMINISTICALLY:
//   - an image that would overflow the current page SHRINKS (within its
//     aspect-locked cap) to fit the remaining space, rather than pushing to the
//     next page and stranding white space,
//   - text flows continuously (splitting across pages when needed).
// Output: a page plan with per-placement heights + image scale factors, plus
// white-space accounting. No browser, no I/O -- fully unit-testable.
// ============================================================

function shrinkFloor(shape) {
  shape = String(shape || '').toLowerCase();
  if (/full|tall|tower/.test(shape)) return 0.60;            // big/full-page: down to 40%
  if (/wide|panoram|square|half/.test(shape)) return 0.70;   // half-page: down to 30%
  return 0.80;                                               // standard/small: down to 20%
}
function round3(n) { return Math.round(n * 1000) / 1000; }

function packPaired(beats, opts) {
  opts = opts || {};
  var pageH = opts.pageHeightIn || 9.7;
  var gap = (opts.gapIn != null) ? opts.gapIn : 0.1;
  var maxPages = opts.maxPages || 400;
  var minLeftForText = (opts.minLeftForTextIn != null) ? opts.minLeftForTextIn : 0.4;

  var pages = [];
  function newPage() { pages.push({ index: pages.length, usedIn: 0, hasImage: false, placements: [] }); return pages[pages.length - 1]; }
  function cur() { return pages[pages.length - 1] || newPage(); }
  function remaining() { return round3(pageH - cur().usedIn); }
  function place(kind, beatIdx, h, extra) {
    var p = cur();
    var pl = { beat: beatIdx, kind: kind, heightIn: round3(h) };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) pl[k] = extra[k]; } }
    p.placements.push(pl);
    p.usedIn = round3(p.usedIn + h + gap);
    if (kind === 'image' || kind === 'tower') p.hasImage = true;
  }

  // Text flows: fill the remaining space, then continue on fresh pages.
  function placeText(beatIdx, part, h, lines, lineChars, textLen) {
    if (!(h > 0)) return;
    var nLines = (lines && lines.length) || 0;
    var canSplit = !opts.noSplit && nLines >= 2 && lineChars && lineChars.length >= 2;
    if (!canSplit) {
      // Whole block: won't fit? start a fresh page and place it there.
      if (h > remaining() + 1e-6 && cur().usedIn > 1e-6) newPage();
      place('narr', beatIdx, h, { part: part, split: false });
      return;
    }
    // Split at whole measured lines; each slice carries the exact character range so the
    // composer renders it as a normal paragraph (no clip tricks).
    var lineIdx = 0;
    while (lineIdx < nLines) {
      var rem = remaining();
      if (rem < minLeftForText && cur().usedIn > 1e-6) { newPage(); rem = remaining(); }
      var startY = lineIdx > 0 ? lines[lineIdx - 1] : 0;
      var endLine = -1;
      for (var k = lineIdx; k < nLines; k++) { if ((lines[k] - startY) <= rem + 0.03) endLine = k; else break; }
      if (endLine < lineIdx) { newPage(); continue; }   // not even one line fits here
      var segH = round3(lines[endLine] - startY);
      var cStart = (lineChars[lineIdx] != null) ? lineChars[lineIdx] : 0;
      var cEnd = (endLine + 1 < nLines && lineChars[endLine + 1] != null) ? lineChars[endLine + 1] : textLen;
      place('narr', beatIdx, segH, { part: part, split: (lineIdx > 0 || endLine + 1 < nLines), charStart: cStart, charEnd: cEnd });
      lineIdx = endLine + 1;
      if (lineIdx < nLines) newPage();
    }
  }

  // Image: fit full if it can; else shrink to fill the remaining gap (within cap);
  // else move to a fresh page (shrinking only if taller than a whole page).
  function placeImage(beatIdx, fullH, shape) {
    if (!(fullH > 0)) return;
    var floor = shrinkFloor(shape);
    var minH = round3(fullH * floor);
    var rem = remaining();
    if (fullH <= rem + 1e-6) { place('image', beatIdx, fullH, { scale: 1, fullH: round3(fullH) }); return; }
    if (cur().usedIn > 1e-6 && rem >= minH) {
      var scale = round3(rem / fullH);
      place('image', beatIdx, round3(fullH * scale), { scale: scale, shrunk: true, fullH: round3(fullH) });
      return;
    }
    if (cur().usedIn > 1e-6) newPage();
    var pageScale = fullH > pageH ? round3(pageH / fullH) : 1;
    place('image', beatIdx, round3(fullH * pageScale), { scale: pageScale, shrunk: pageScale < 1, fullH: round3(fullH) });
  }

  // JOINT sizing: place an image AND leave room for its own following text on the same page,
  // so a beat's image + narration are considered together (not image-first, discover-text-doesn't-fit).
  function placeImageWithText(beatIdx, fullH, shape, afterH) {
    if (!(fullH > 0)) return;
    var floor = shrinkFloor(shape);
    var minH = round3(fullH * floor);
    var rem = remaining();
    var need = afterH > 0 ? (afterH + gap) : 0;   // room the following text wants
    var avail = rem - need;                        // room for the image if the text shares the page
    if (fullH <= avail + 1e-6) { place('image', beatIdx, fullH, { scale: 1, fullH: round3(fullH) }); return; }
    if (avail >= minH) {
      // Shrink the image (within its cap) just enough that its text fits beneath it -- no stranded
      // white -- whether the page already has content or the image+text start a fresh page.
      var scale = round3(avail / fullH);
      place('image', beatIdx, round3(fullH * scale), { scale: scale, shrunk: true, fullH: round3(fullH) });
      return;
    }
    // Can't fit both -> size the image on its own; the text flows to the next page.
    placeImage(beatIdx, fullH, shape);
  }

  newPage();
  (beats || []).forEach(function (b) {
    if (b.isTower && b.hasImage && b.imageH > 0) {
      // Tower: image floats with text BESIDE it, so the beat's footprint is the taller of
      // the image or its narration -- not the sum. Place it as one block.
      var textH = (b.textBeforeH || 0) + (b.textAfterH || 0);
      var blockH = Math.max(b.imageH, textH);
      if (blockH > remaining() + 1e-6 && cur().usedIn > 1e-6) newPage();
      place('tower', b.idx, blockH, { imageH: round3(b.imageH), textH: round3(textH) });
      return;
    }
    // Keep a TALL image with its intro text: if the intro + a meaningfully-sized image won't
    // both fit on the current page, start fresh so the text stays WITH its image (rather than the
    // intro getting pulled up to the prior page and the tall image stranded alone on the next).
    if (b.hasImage && b.imageH >= 6.0 && cur().usedIn > 1e-6) {
      var _minImg = b.imageH * shrinkFloor(b.shape);
      var _needTogether = (b.textBeforeH || 0) + (b.textBeforeH ? gap : 0) + _minImg;
      if (_needTogether > remaining() + 1e-6) newPage();
    }
    if (b.textBeforeH > 0) placeText(b.idx, 'before', b.textBeforeH, b.beforeLines, b.beforeLineChars, b.beforeLen);
    if (b.hasImage && b.imageH > 0) {
      placeImageWithText(b.idx, b.imageH, b.shape, b.textAfterH || 0);
      if (b.textAfterH > 0) placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen);
    } else if (b.textAfterH > 0) {
      placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen);
    }
  });

  var whiteByPage = pages.map(function (p) { return round3(Math.max(0, pageH - p.usedIn)); });
  var pictureless = pages.filter(function (p) { return p.placements.length && !p.hasImage; }).map(function (p) { return p.index; });
  var shrunkCount = pages.reduce(function (n, p) { return n + p.placements.filter(function (pl) { return pl.shrunk; }).length; }, 0);
  return {
    pageCount: pages.length,
    overLimit: pages.length > maxPages,
    pageHeightIn: pageH,
    beatCount: (beats || []).length,
    picturelessPages: pictureless,
    imagesShrunk: shrunkCount,
    totalWhiteIn: round3(whiteByPage.reduce(function (a, w) { return a + w; }, 0)),
    whiteByPage: whiteByPage,
    pages: pages
  };
}

module.exports = { packPaired };
