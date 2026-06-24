'use strict';

// ============================================================
// comicEngine.js  -  ONE-ENGINE two-pass Comic planner (pure, testable).
// ------------------------------------------------------------
// Consumes EXACT measured geometry (per-chunk narration heights at 1/2/3-col
// widths + per-moment image aspect/prominence) and produces a page plan whose
// rendered height it knows precisely -- so the renderer can draw exactly this
// and NOTHING spills. Honors: image stays with the start of its text; small
// images alternate sides; fewest columns that fit; tier-max images never shrink.
//
// Input moments: [{ image:{aspect,prominence,tier,hasImage}, chunks:[[h0,h1,h2],...] }]
//   h0 = height at full width, h1 = half (2-col), h2 = third (3-col).
// ============================================================

var PAGE_H = 9.7;
var GAP = 0.12;
var COLW = [6.8, 3.34, 2.187];   // 1-col, 2-col, 3-col widths (inches)

function round3(x) { return Math.round(x * 1000) / 1000; }

// ---- image box from aspect + size tier ----------------------------------
function imagePlan(info) {
  var asp = (info && info.aspect) || 1;
  var tier = (info && info.tier) || 'def';
  var wide = asp >= 1.5;
  var box;
  if (wide) {
    // Landscape -> full-width band on top of its narration.
    box = { layout: 'top', wIn: COLW[0], hIn: COLW[0] / asp };
  } else {
    // Portrait/square -> sits beside its narration in one column.
    var w = COLW[1], h = w / asp;
    box = { layout: 'beside', wIn: w, hIn: h };
  }
  // Tier sizing: min stays small; max may run taller; never below natural for max.
  var capH = PAGE_H - 0.5;
  if (tier === 'min' && box.hIn > 3.2) { box.hIn = 3.2; box.wIn = box.hIn * asp; }
  if (box.hIn > capH) { box.hIn = capH; box.wIn = box.hIn * asp; }   // never exceed page
  if (box.wIn > COLW[0]) { box.wIn = COLW[0]; box.hIn = box.wIn / asp; }
  box.hIn = round3(box.hIn); box.wIn = round3(box.wIn);
  box.tier = tier; box.prominence = (info && info.prominence) || 3; box.aspect = asp;
  return box;
}

// ---- partition an ORDERED chunk list into K contiguous columns, balanced ----
function balanceCols(heights, K) {
  if (K <= 1) return [heights.map(function (_, i) { return i; })];
  var total = 0; for (var t = 0; t < heights.length; t++) total += heights[t];
  var target = total / K;
  var cols = [], cur = [], curSum = 0, made = 0;
  for (var i = 0; i < heights.length; i++) {
    cur.push(i); curSum += heights[i];
    var remaining = heights.length - 1 - i, needCols = K - made - 1;
    if (made < K - 1 && curSum >= target && remaining >= needCols) {
      cols.push(cur); cur = []; curSum = 0; made++;
    }
  }
  if (cur.length) cols.push(cur);
  while (cols.length < K) cols.push([]);
  return cols;
}
function colsHeight(heights, cols) {
  var mx = 0;
  for (var c = 0; c < cols.length; c++) {
    var s = 0; for (var j = 0; j < cols[c].length; j++) s += heights[cols[c][j]];
    if (s > mx) mx = s;
  }
  return mx;
}

// Choose the FEWEST columns in which ALL `chunks` (each [h0,h1,h2]) fit within H.
// Returns {cols, rowH} or null if even 3 columns can't fit them all.
function fitAllCols(chunks, H) {
  for (var K = 1; K <= 3; K++) {
    var hs = chunks.map(function (c) { return c[K - 1]; });
    var cols = balanceCols(hs, K);
    var rowH = colsHeight(hs, cols);
    if (rowH <= H + 1e-6) return { cols: K, layout: cols, rowH: round3(rowH) };
  }
  return null;
}

// Fill a page of height H with as many leading chunks as possible using K columns
// (reading order: column 1 = first chunks). Returns {used, rowH} where used =
// number of chunks placed (>=1 always, to guarantee progress).
function fillPartial(chunks, H, K) {
  var hs = chunks.map(function (c) { return c[K - 1]; });
  // Build the column assignment DIRECTLY as we fill, then derive rowH from that
  // exact assignment -- so the height can never exceed what we budgeted.
  var cols = []; for (var k = 0; k < K; k++) cols.push([]);
  var ci = 0, colSum = 0, used = 0;
  for (var i = 0; i < hs.length; i++) {
    if (colSum + hs[i] <= H + 1e-6) { cols[ci].push(i); colSum += hs[i]; used++; }
    else if (ci < K - 1 && hs[i] <= H + 1e-6) { ci++; colSum = hs[i]; cols[ci].push(i); used++; }
    else break;                                                          // chunk won't fit -> flows on
  }
  if (used === 0) { cols[0].push(0); used = 1; }                        // never stall
  var rowH = colsHeight(hs, cols);                                     // from the SAME assignment
  return { used: used, cols: K, layout: cols, rowH: round3(rowH) };
}

// ---- main: pack moments onto pages --------------------------------------
function planComic(moments, opts) {
  opts = opts || {};
  var pageH = opts.pageHeightIn || PAGE_H;
  var overflowCols = opts.overflowCols || 2;   // columns to use when narration spills
  var pages = [];
  var cur = null;
  function newPage() { cur = { index: pages.length, usedIn: 0, items: [] }; pages.push(cur); return cur; }
  function avail() { return pageH - cur.usedIn; }
  function add(item, h) { cur.items.push(item); cur.usedIn = round3(cur.usedIn + h + (cur.items.length > 1 ? GAP : 0)); }
  newPage();
  var sideLeft = true;

  for (var mi = 0; mi < moments.length; mi++) {
    var m = moments[mi];
    var img = (m.image && m.image.hasImage) ? imagePlan(m.image) : null;
    var chunks = m.chunks || [];
    var idx = 0;   // chunk pointer; may advance via narration-above before the image

    if (img) {
      var minShrink = opts.minShrinkIn || 1.5;
      var aboveMin = opts.narrAboveMinIn || 1.5;
      var canSlide = (cur.usedIn <= 1e-6) || (avail() >= img.hIn - 1e-6);
      if (!canSlide) {
        var lowProm = (img.tier === 'min');
        var slk = avail() - (cur.items.length > 0 ? GAP : 0);
        // 2a: shrink a LOW-prominence image (keep aspect) to backfill the slack.
        if (lowProm && slk >= minShrink) {
          var sh = Math.min(img.hIn, slk), sw = sh * img.aspect;
          if (sw > COLW[0]) { sw = COLW[0]; sh = sw / img.aspect; }
          if (sh >= minShrink) { img.hIn = round3(sh); img.wIn = round3(sw); img.shrunk = true; }
        }
        // 2b: otherwise fill the current page with this moment's leading narration
        // ABOVE the image, then start the image on a fresh page (image stays big).
        if (!img.shrunk && avail() < img.hIn - 1e-6) {
          if (slk >= aboveMin && idx < chunks.length) {
            var pa = fillPartial(chunks.slice(idx), slk, overflowCols);
            add({ type: 'narr', moment: mi, cols: pa.cols, rowH: pa.rowH,
                  colChunks: pa.layout.map(function (col) { return col.map(function (li) { return idx + li; }); }) }, pa.rowH);
            idx += pa.used;
          }
          newPage();
        }
      }

      // beside narration (recompute on the chunks REMAINING after any narration-above)
      var besideUsed = 0;
      if (img.layout === 'beside' && !img.shrunk) {
        var bsum = 0;
        for (var bi = idx; bi < chunks.length; bi++) {
          var bh = chunks[bi][1];
          if (bsum + bh <= img.hIn + 1e-6) { bsum += bh; besideUsed++; } else break;
        }
      }
      var imageItem;
      if (img.layout === 'beside') {
        var side = sideLeft ? 'left' : 'right'; sideLeft = !sideLeft;
        imageItem = { type: 'image-beside', moment: mi, img: img, side: side, besideChunks: range(idx, idx + besideUsed) };
      } else {
        imageItem = { type: 'image-top', moment: mi, img: img };
      }
      if (avail() < img.hIn - 1e-6 && cur.usedIn > 1e-6) newPage();
      add(imageItem, img.hIn);
      idx += besideUsed;
    }

    // ---------- REST NARRATION flows below / onward ----------
    while (idx < chunks.length) {
      var rest = chunks.slice(idx);
      var H = avail() - (cur.items.length > 0 ? GAP : 0);
      var minNext = rest[0][0];
      if (H < Math.max(0.6, minNext) - 1e-6) { newPage(); H = avail(); }
      var all = fitAllCols(rest, H);
      if (all) {
        add({ type: 'narr', moment: mi, cols: all.cols, rowH: all.rowH,
              colChunks: all.layout.map(function (col) { return col.map(function (li) { return idx + li; }); }) }, all.rowH);
        idx += rest.length;
      } else {
        var part = fillPartial(rest, H, overflowCols);
        add({ type: 'narr', moment: mi, cols: part.cols, rowH: part.rowH,
              colChunks: part.layout.map(function (col) { return col.map(function (li) { return idx + li; }); }) }, part.rowH);
        idx += part.used;
        if (idx < chunks.length) newPage();
      }
    }
  }

  // growth-to-fill: enlarge LONE images into leftover page height, keeping aspect.
  if (opts.grow !== false) growImages(pages, pageH, opts.growMaxFactor || 2.0);

  // summarize
  var maxPages = opts.maxPages || 250;
  return {
    pageCount: pages.length,
    overLimit: pages.length > maxPages,
    pages: pages.map(function (p) {
      return { index: p.index, usedIn: round3(p.usedIn), overflow: p.usedIn > pageH + 1e-6,
               items: p.items };
    })
  };
}

function range(a, b) { var r = []; for (var i = a; i < b; i++) r.push(i); return r; }

// Enlarge a LONE image (a beside-image with NO text beside it, sitting as the
// last item on its page) to consume the page's leftover height -- KEEPING ASPECT
// (no crop). Bounded by content width (6.8in), page height, and a max-growth
// factor. These are the only images with room to grow outward without cropping;
// full-width top images are already at max width, so they're left untouched.
function growImages(pages, pageH, capX) {
  for (var pi = 0; pi < pages.length; pi++) {
    var page = pages[pi];
    if (!page.items.length) continue;
    var last = page.items[page.items.length - 1];
    if (last.type !== 'image-beside') continue;
    if (last.img && last.img.shrunk) continue;                // don't re-expand a backfill shrink
    if ((last.besideChunks || []).length !== 0) continue;     // text beside -> don't collide
    var slack = pageH - page.usedIn;
    if (slack < 0.3) continue;
    var asp = last.img.aspect || 1, curH = last.img.hIn;
    var newH = Math.min(curH * capX, curH + slack, COLW[0] / asp);
    if (newH <= curH + 1e-6) continue;
    var newW = newH * asp;
    if (newW > COLW[0]) { newW = COLW[0]; newH = newW / asp; }
    page.usedIn = round3(page.usedIn + (newH - curH));
    last.img.hIn = round3(newH); last.img.wIn = round3(newW); last.grown = true;
  }
}
function smallestChunk(chunks, from) {
  var mn = Infinity; for (var i = from; i < chunks.length; i++) if (chunks[i][0] < mn) mn = chunks[i][0];
  return (mn === Infinity) ? 0 : mn;
}

module.exports = { planComic: planComic, imagePlan: imagePlan, fitAllCols: fitAllCols, balanceCols: balanceCols };
