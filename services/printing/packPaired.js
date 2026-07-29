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
  // Hoisted out of placeText so the cohesion arithmetic in the driver uses the SAME number the
  // placement actually costs. It did not, and cohesion under-reserved by exactly one margin per text
  // block -- it trimmed the picture to make room for the after-text and the after-text still would
  // not fit, which is how beat 5 of The Strangers ended up with its picture on one page and its
  // closing paragraph alone on the next.
  var TEXT_MARGIN = 0.1;   // the composer's paragraph top margin, added to EVERY placed slice
  var maxPages = opts.maxPages || 400;
  var minLeftForText = (opts.minLeftForTextIn != null) ? opts.minLeftForTextIn : 0.4;
  // ANTI-SLIVER: no slice of a paragraph may be left with fewer lines than this. Without it the
  // packer filled whatever room remained and cut, however small the remainder -- 31 characters got a
  // page of their own, and a single trailing line landed on a page whose predecessor had 6.7in going
  // spare. The magazine packer has had MZ_MIN_SLICE_LINES for exactly this; paired never got one.
  var MIN_SLICE_LINES = (opts.minSliceLines != null) ? opts.minSliceLines : 2;
  // A split is worth making when it FILLS the page it is on. Below this fraction the page is not
  // being filled by the split, so moving the whole block on is the better trade.
  var SPLIT_MIN_PAGE_FRAC = (opts.splitMinPageFrac != null) ? opts.splitMinPageFrac : 0.55;
  // BEAT COHESION: a beat's before-text, picture and after-text want to live on one page. When they
  // do not all fit, trim the picture rather than separate the text from the art -- but never below
  // this fraction of natural size; past that, a page break is the better trade.
  // 0.75 measured, not guessed: on The Strangers, 12 of 36 picture beats want more than a page, but
  // only 3 of them are within a trim of fitting (0.77-0.79). The other 9 need 0.51-0.65, far below
  // the floor, so they are left alone and span pages exactly as before. The floor is what keeps this
  // rare and self-limiting: it can only ever fire where a SMALL trim buys cohesion, so Picture Book
  // stays big pictures -- 3 trimmed out of 36 on a 44-page book.
  var COHESION_FLOOR = (opts.cohesionFloor != null) ? opts.cohesionFloor : 0.75;
  // How much unused room cohesion may walk away from. Below this a gap is the price of keeping a beat
  // whole; above it the gap is the bigger fault and the beat should split across the page break.
  var COHESION_MAX_WASTE = (opts.cohesionMaxWaste != null) ? opts.cohesionMaxWaste : 1.6;

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
    var lineIdx = 0;
    while (lineIdx < nLines) {
      var rem = remaining() - TEXT_MARGIN;   // the slice's own top margin eats into the room
      if (rem < minLeftForText && cur().usedIn > 1e-6) { newPage(); rem = remaining() - TEXT_MARGIN; }
      var startY = lineIdx > 0 ? lines[lineIdx - 1] : 0;
      var endLine = -1;
      for (var k = lineIdx; k < nLines; k++) { if ((lines[k] - startY) <= rem + 0.03) endLine = k; else break; }
      if (endLine < lineIdx) { newPage(); continue; }   // not even one line fits here
      // SPLIT MAXIMALLY. Take every line that fits, always. The offence is not a small tail -- a
      // sentence carrying over a page break is ordinary typography -- it is leaving USABLE ROOM
      // BEHIND while pushing words forward.
      // v3.0.286 got this backwards: it PULLED THE CUT BACK to avoid a small tail, which deliberately
      // left room on the page and moved lines forward -- manufacturing exactly the fault it was meant
      // to prevent, and costing five pages and nine points of fill.
      // The one case still worth refusing: the page is nearly empty anyway, so this is not a split
      // that fills a page, it is a block being chopped for no gain. Then move the whole block on. And
      // on a page that is ALREADY fresh, accept whatever fits -- a block taller than a page has to
      // split somewhere, and that is also what terminates this loop.
      // Cuts land on word boundaries by construction: lineChars records the offset of each rendered
      // line's FIRST WORD (measureLayout splits on whitespace), so a word cannot be broken and
      // punctuation always travels with its word.
      var _fresh = cur().usedIn <= 1e-6;
      var _usedFrac = _fresh ? 0 : (cur().usedIn / pageH);
      var _tail = nLines - (endLine + 1);
      var _headLines = endLine - lineIdx + 1;
      if (!_fresh && _tail > 0 && _headLines < MIN_SLICE_LINES && _usedFrac < SPLIT_MIN_PAGE_FRAC) {
        newPage(); continue;   // near-empty page: chopping a couple of lines off here gains nothing
      }
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
  function placeImageWithText(beatIdx, fullH, shape, afterH, over, cohScale) {
    if (!(fullH > 0)) return;
    if (over == null) over = IMG_OVER;
    // A cohesion scale means the caller already worked out what keeps this beat on one page and has
    // made room for it. Honour it when it fits, so the picture is not shrunk twice by two different
    // rules arriving at two different answers.
    if (cohScale != null && cohScale > 0 && cohScale < 1) {
      var _ch = round3(fullH * cohScale + over);
      if (_ch <= remaining() + 1e-6) {
        // `cohesion` marks this trim as LOAD-BEARING: the picture is small specifically so this
        // beat's text fits beside it. Growing it back re-orphans the text, which is exactly what the
        // loop did -- growImage on viewer p.10 took beat 5 from 0.83 to 0.96, consumed the room
        // cohesion had reserved, and left the closing paragraph stranded on its own page.
        place('image', beatIdx, _ch, { scale: cohScale, shrunk: true, cohesion: true, fullH: round3(fullH) });
        return;
      }
    }
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
    // BEAT COHESION. The before-text used to be placed first and the picture asked for room
    // afterwards, so a beat could put its paragraph on one page and its picture on the next with
    // inches of white between them -- beat 6 of The Strangers wanted 2.45 + 5.93 + 1.25 = 9.63in
    // against 9.16in available, and the packer chose to separate them. Decide the whole beat up
    // front instead: work out the picture scale that would hold it together on ONE page, and if that
    // is within the floor, break to a fresh page first (if needed) and pass the scale down. If even
    // the floor cannot hold it, place as before and let the beat span pages -- some genuinely must.
    var _cohScale = null;
    if (b.hasImage && b.imageH > 0 && ((b.textBeforeH || 0) + (b.textAfterH || 0)) > 0) {
      var _txt = (b.textBeforeH || 0) + (b.textAfterH || 0);
      // Each text block costs its measured height PLUS a TEXT_MARGIN. Reserving only the measured
      // heights left the beat 0.10in short per block -- so cohesion trimmed the picture, the text it
      // was making room for still did not fit, and the beat was separated anyway with a smaller
      // picture into the bargain. Worst of both.
      var _tm = (((b.textBeforeH || 0) > 0) ? TEXT_MARGIN : 0) + (((b.textAfterH || 0) > 0) ? TEXT_MARGIN : 0);
      var _fixed = _txt + _tm + (b.imgOver || IMG_OVER) + gap;   // everything except the picture
      // TWO QUESTIONS, IN THIS ORDER. The first version of this asked only the second one -- can this
      // beat fit a WHOLE page at some scale -- and if the answer meant it would not fit the room in
      // front of it, it abandoned that room and started a fresh page. On The Strangers page 34 that
      // left a 0.70in fragment alone on a page while beat 26, needing 8.60in against 8.36in free,
      // moved on: a miss of 0.24in. Trimming that picture by five percent would have fitted the whole
      // beat exactly, filled the page, and removed the page after it. So ask about the room actually
      // available FIRST, and only fall back to a fresh page when even a floor-deep trim cannot hold
      // the beat where it stands. This is the per-page fill loop working as intended: keep taking
      // beats, trimming a few percent where a few percent is all that is wanted, and break only when
      // the room genuinely cannot hold the next one.
      var _here = remaining() - _fixed;
      var _needHere = (_here > 0) ? round3(Math.min(1, _here / b.imageH)) : 0;
      if (cur().usedIn > 1e-6 && _needHere >= COHESION_FLOOR) {
        _cohScale = _needHere;          // fits right here -- keep filling this page
      } else {
        var _room = pageH - _fixed;
        var _need = (_room > 0) ? round3(Math.min(1, _room / b.imageH)) : 0;
        if (_need >= COHESION_FLOOR) {
          _cohScale = _need;
          var _total = round3(_fixed + b.imageH * _need);
          // DO NOT ABANDON USABLE ROOM. This broke to a fresh page whenever the WHOLE beat would not
          // fit the space remaining -- and walked away from that space entirely, however much of it
          // there was. On The Strangers viewer p.17 that left 2.75in empty while the very next beat's
          // bridge text, 1.80in, would have slid straight into it. Nothing needed resizing; it simply
          // had to slide. Cohesion is worth a small gap, not a large one: if the bridge text alone can
          // use most of what is left, let it, and the picture starts the next page as it would have
          // anyway. The beat is then split across a page break, which is ordinary in a picture book --
          // bridge text at the foot of one page, its picture at the head of the next reads perfectly.
          var _slideH = (b.textBeforeH > 0) ? round3(b.textBeforeH + TEXT_MARGIN) : 0;
          var _freeNow = round3(remaining());
          var _wouldWaste = (_freeNow > COHESION_MAX_WASTE) && (_slideH > 0) && (_slideH <= _freeNow + 1e-6);
          if (_total > remaining() + 1e-6 && cur().usedIn > 1e-6 && !_wouldWaste) newPage();
        }
      }
    }
    if (b.textBeforeH > 0) placeText(b.idx, 'before', b.textBeforeH, b.beforeLines, b.beforeLineChars, b.beforeLen, b.beforeNoSplit);
    if (b.hasImage && b.imageH > 0) {
      placeImageWithText(b.idx, b.imageH, b.shape, b.textAfterH || 0, b.imgOver, _cohScale);
      if (b.textAfterH > 0) placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen, b.afterNoSplit);
    } else if (b.textAfterH > 0) {
      placeText(b.idx, 'after', b.textAfterH, b.afterLines, b.afterLineChars, b.afterLen, b.afterNoSplit);
    }
  });

  // AN UNUSED COHESION TRIM IS NOT LOAD-BEARING. The picture is trimmed so its beat's text fits
  // beside it -- but if the text ended up on another page anyway, the trim bought nothing and the
  // flag is a lie. It then stops the optimizer growing a picture to protect a reservation nobody is
  // using: The Strangers viewer p.42 sat at 7.84 of 9.24 with its picture held at 0.76, refusing to
  // grow to keep company with text that was already on p.43. Clear the flag wherever the beat did
  // not actually end up whole on one page.
  try {
    var _beatPages = {};
    pages.forEach(function (pg, pi) {
      (pg.placements || []).forEach(function (pl) {
        if (pl.beat == null) return;
        (_beatPages[pl.beat] = _beatPages[pl.beat] || {})[pi] = 1;
      });
    });
    pages.forEach(function (pg) {
      (pg.placements || []).forEach(function (pl) {
        if (pl.cohesion && Object.keys(_beatPages[pl.beat] || {}).length > 1) delete pl.cohesion;
      });
    });
  } catch (e) {}
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
