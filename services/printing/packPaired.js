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
  var IMG_OVER = (opts.imgOverIn != null) ? opts.imgOverIn : 0.1;   // image margins beyond the gap (frame is now inset, adds no height)
  var maxPages = opts.maxPages || 400;
  var minLeftForText = (opts.minLeftForTextIn != null) ? opts.minLeftForTextIn : 0.4;

  var pages = [];
  function newPage() { pages.push({ index: pages.length, usedIn: 0, hasImage: false, placements: [] }); return pages[pages.length - 1]; }
  function cur() { return pages[pages.length - 1] || newPage(); }
  function remaining() { return round3(pageH - cur().usedIn); }
  // HARD PAGE-BUDGET CAP (universal never-clip rule): no page's content may exceed the box. If a
  // piece will not fit the space left on the current page, break to a fresh page BEFORE placing it.
  // A single piece taller than a whole page is the caller's job to split/shrink first (text splits
  // by line; images shrink to a floor); this guard is the final backstop so usedIn can never run
  // past pageH by stacking. Applies to every layout that packs through here.
  function place(kind, beatIdx, h, extra) {
    if (h > remaining() + 1e-6 && cur().usedIn > 1e-6 && h <= pageH + 1e-6) newPage();
    var p = cur();
    var pl = { beat: beatIdx, kind: kind, heightIn: round3(h) };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) pl[k] = extra[k]; } }
    p.placements.push(pl);
    p.usedIn = round3(p.usedIn + h + gap);
    if (kind === 'image' || kind === 'tower') p.hasImage = true;
  }

  // Text flows: fill the remaining space, then continue on fresh pages.
  function placeText(beatIdx, part, h, lines, lineChars, textLen, noSplit) {
    if (!(h > 0)) return;
    var nLines = (lines && lines.length) || 0;
    var canSplit = !opts.noSplit && !noSplit && nLines >= 2 && lineChars && lineChars.length >= 2;
    if (!canSplit) {
      // Whole block: won't fit? start a fresh page and place it there.
      if (h > remaining() + 1e-6 && cur().usedIn > 1e-6) newPage();
      place('narr', beatIdx, h, { part: part, split: false });
      return;
    }
    // Split at whole measured lines; each slice carries the exact character range so the
    // composer renders it as a normal paragraph (no clip tricks).
    // The composer wraps each narr slice in a div with a 0.1in top margin that the measured
    // `lines` (text-only line bottoms) do NOT include. Reserve it so the fit test and the placed
    // height match the real render -- otherwise the packer fits one extra line and the composed
    // page renders ~0.1in taller per slice, slicing the last line horizontally at the box edge.
    var TEXT_MARGIN = 0.1;
    var lineIdx = 0;
    while (lineIdx < nLines) {
      var rem = remaining() - TEXT_MARGIN;   // the slice's own top margin eats into the room
      if (rem < minLeftForText && cur().usedIn > 1e-6) { newPage(); rem = remaining() - TEXT_MARGIN; }
      var startY = lineIdx > 0 ? lines[lineIdx - 1] : 0;
      var endLine = -1;
      for (var k = lineIdx; k < nLines; k++) { if ((lines[k] - startY) <= rem + 0.03) endLine = k; else break; }
      if (endLine < lineIdx) { newPage(); continue; }   // not even one line fits here
      var segH = round3(lines[endLine] - startY + TEXT_MARGIN);   // include the top margin the composer adds
      var cStart = (lineChars[lineIdx] != null) ? lineChars[lineIdx] : 0;
      var cEnd = (endLine + 1 < nLines && lineChars[endLine + 1] != null) ? lineChars[endLine + 1] : textLen;
      place('narr', beatIdx, segH, { part: part, split: (lineIdx > 0 || endLine + 1 < nLines), charStart: cStart, charEnd: cEnd });
      lineIdx = endLine + 1;
      if (lineIdx < nLines) newPage();
    }
  }

  // Image: fit full if it can; else shrink to fill the remaining gap (within cap);
  // else move to a fresh page (shrinking only if taller than a whole page).
  function placeImage(beatIdx, fullH, shape, over) {
    if (!(fullH > 0)) return;
    if (over == null) over = IMG_OVER;
    var floor = shrinkFloor(shape);
    var minH = round3(fullH * floor);
    var rem = remaining() - over;   // visual space for the image, after reserving its decoration overhead
    if (fullH <= rem + 1e-6) { place('image', beatIdx, round3(fullH + over), { scale: 1, fullH: round3(fullH) }); return; }
    if (cur().usedIn > 1e-6 && rem >= minH) {
      var scale = round3(rem / fullH);
      place('image', beatIdx, round3(fullH * scale + over), { scale: scale, shrunk: true, fullH: round3(fullH) });
      return;
    }
    if (cur().usedIn > 1e-6) newPage();
    var freeVis = pageH - over;
    var pageScale = fullH > freeVis ? round3(freeVis / fullH) : 1;
    place('image', beatIdx, round3(fullH * pageScale + over), { scale: pageScale, shrunk: pageScale < 1, fullH: round3(fullH) });
  }

  // JOINT sizing: place an image AND leave room for its own following text on the same page,
  // so a beat's image + narration are considered together (not image-first, discover-text-doesn't-fit).
  function placeImageWithText(beatIdx, fullH, shape, afterH, over) {
    if (!(fullH > 0)) return;
    if (over == null) over = IMG_OVER;
    var floor = shrinkFloor(shape);
    var minH = round3(fullH * floor);
    var rem = remaining();
    var need = afterH > 0 ? (afterH + gap) : 0;   // room the following text wants
    var avail = rem - need - over;                 // visual room for the image, after overhead + text
    if (fullH <= avail + 1e-6) { place('image', beatIdx, round3(fullH + over), { scale: 1, fullH: round3(fullH) }); return; }
    if (avail >= minH) {
      // Shrink the image (within its cap) just enough that its text fits beneath it -- no stranded
      // white -- whether the page already has content or the image+text start a fresh page.
      var scale = round3(avail / fullH);
      place('image', beatIdx, round3(fullH * scale + over), { scale: scale, shrunk: true, fullH: round3(fullH) });
      return;
    }
    // Can't fit both -> size the image on its own; the text flows to the next page.
    placeImage(beatIdx, fullH, shape, over);
  }

  newPage();
  (beats || []).forEach(function (b) {
    if (b.kind === 'section-header') {
      // Session boundary. With a visible divider it reserves its registry height (wrapping to a
      // fresh page if it would not fit); otherwise it is a zero-height marker that only tags the
      // page as a session start so the composer can suppress the running header there.
      if (b.pageBreak && cur().usedIn > 1e-6) newPage();
      var hH = (b.headerH > 0) ? b.headerH : 0;
      if (hH > 0) {
        // Keep the divider glued to the session's opening image: if the divider PLUS that image
        // (down to its shrink floor ~0.72) would not fit here, move BOTH to a fresh page -- there
        // must never be a page break between a session divider and its title picture.
        var needWith = hH + (b.nextImageH || 0) * 0.72;
        if (needWith > remaining() + 1e-6 && cur().usedIn > 1e-6) newPage();
        place('section-header', b.idx, hH);
      } else {
        cur().placements.push({ beat: b.idx, kind: 'section-header', heightIn: 0 });
      }
      return;
    }
    if (b.isTower && b.hasImage && b.imageH > 0) {
      // Tower: image floats with text BESIDE it, so the beat's footprint is the taller of
      // the image or its narration -- not the sum. Place it as one block.
      var textH = (b.textBeforeH || 0) + (b.textAfterH || 0);
      var blockH = Math.max(b.imageH + (b.capBelowH || 0), textH);   // reserve a below-image caption so it can't clip past the page
      if (blockH > pageH) blockH = round3(pageH);   // HARD CAP: a tower block can never exceed the usable box
      if (blockH > remaining() + 1e-6 && cur().usedIn > 1e-6) newPage();
      place('tower', b.idx, blockH, { imageH: round3(b.imageH), textH: round3(textH) });
      return;
    }
    if (b.textBeforeH > 0) placeText(b.idx, 'before', b.textBeforeH, b.beforeLines, b.beforeLineChars, b.beforeLen, b.beforeNoSplit);
    if (b.hasImage && b.imageH > 0) {
      placeImageWithText(b.idx, b.imageH, b.shape, b.textAfterH || 0, b.imgOver);
      if (b.textAfterH > 0) placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen, b.afterNoSplit);
    } else if (b.textAfterH > 0) {
      placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen, b.afterNoSplit);
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
