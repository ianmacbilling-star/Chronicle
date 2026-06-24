'use strict';

// ============================================================
// packComic.js  -  pure pagination packer for the Comic layout (two-pass Stage 2b)
// ------------------------------------------------------------
// Input: measured blocks from measureDocument, each:
//   { id, kind:'image'|'narr'|..., moment, topIn, heightIn, split:bool }
// Groups blocks into visual ROWS (side-by-side blocks share a topIn), then
// re-packs rows onto fixed-height pages:
//   - keeps an image with the START of its narration (keep-group by moment),
//   - splits an over-tall SPLITTABLE narration row across pages (Stage 3 does the
//     real paragraph-level text split; here we model it for page counting),
//   - enforces the Max Pages Per Print ceiling,
//   - reports pictureless pages.
// No browser, no I/O -- fully unit-testable.
// ============================================================

function isImage(b) { return !!(b && typeof b.kind === 'string' && b.kind.indexOf('image') !== -1); }

function packComic(blocks, opts) {
  opts = opts || {};
  var pageH = opts.pageHeightIn || 9.7;
  var gap = (opts.gapIn != null) ? opts.gapIn : 0.12;
  var maxPages = opts.maxPages || 250;
  var eps = opts.rowEpsilonIn || 0.08;   // topIn tolerance for same-row grouping
  var minChunkIn = (opts.minNarrChunkIn != null) ? opts.minNarrChunkIn : 0.6;

  // 1) sort by topIn and group side-by-side blocks into rows
  var sorted = (blocks || []).slice().sort(function (a, b) { return (a.topIn || 0) - (b.topIn || 0); });
  var rows = [];
  var cur = null;
  for (var i = 0; i < sorted.length; i++) {
    var b = sorted[i];
    if (cur && Math.abs((b.topIn || 0) - cur.topIn) <= eps) {
      cur.blocks.push(b);
      cur.heightIn = Math.max(cur.heightIn, b.heightIn || 0);
      if (isImage(b)) cur.hasImage = true;
    } else {
      cur = { topIn: (b.topIn || 0), heightIn: (b.heightIn || 0), hasImage: isImage(b), blocks: [b] };
      rows.push(cur);
    }
  }
  rows.forEach(function (r) {
    r.splittable = (r.blocks.length === 1 && !!r.blocks[0].split && !isImage(r.blocks[0]));
    r.moment = r.blocks[0].moment;
  });

  // 2) pack rows onto pages
  var pages = [];
  function newPage() { pages.push({ index: pages.length, usedIn: 0, hasImage: false, rows: [], splits: [], placements: [] }); return pages[pages.length - 1]; }
  function cur2() { return pages[pages.length - 1] || newPage(); }
  function placeRow(row, h, isSplitPart, partLabel) {
    var p = cur2();
    var img = !!(row.hasImage && !isSplitPart);
    p.rows.push({ moment: row.moment, heightIn: round3(h), hasImage: img, split: !!isSplitPart });
    if (isSplitPart) {
      p.placements.push({ moment: row.moment, kind: 'narr', heightIn: round3(h), split: true, part: partLabel || 'mid' });
    } else if (row.blocks) {
      for (var bi = 0; bi < row.blocks.length; bi++) {
        var blk = row.blocks[bi];
        p.placements.push({ moment: blk.moment, kind: isImage(blk) ? 'image' : 'narr', heightIn: round3(blk.heightIn || 0), split: false, part: 'whole' });
      }
    } else {
      p.placements.push({ moment: row.moment, kind: img ? 'image' : 'narr', heightIn: round3(h), split: false, part: 'whole' });
    }
    p.usedIn = round3(p.usedIn + h + gap);
    if (img) p.hasImage = true;
  }
  newPage();

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var next = rows[r + 1];
    // Keep an image with the START of its narration -- UNLESS the image is so tall
    // it would only leave a sliver, which renders as an empty stretched box. Such a
    // tall image stands alone and its narration flows onto the next page.
    var tallSoloIn = (opts.tallImageSoloIn != null) ? opts.tallImageSoloIn : 6.5;
    var keepNext = !!(row.hasImage && next && next.splittable && next.moment === row.moment && row.heightIn < tallSoloIn);
    // Keep the image with the start of its text: an image row needs room for
    // itself PLUS a minimum first narration chunk, or it moves to the next page.
    var need = row.heightIn + (keepNext ? (gap + minChunkIn) : 0);
    var remaining = pageH - cur2().usedIn;
    if (!row.splittable && need > remaining + 1e-6 && cur2().usedIn > 1e-6) newPage();

    remaining = pageH - cur2().usedIn;
    if (row.heightIn <= remaining + 1e-6) { placeRow(row, row.heightIn, false); continue; }

    if (row.splittable) {
      var left = row.heightIn;
      var firstFit = remaining - gap;
      // Don't fill a sub-meaningful narration SLIVER after an image -- that is what
      // renders as a near-empty box stretched beside a tall panel. If the leftover
      // beneath an image is too small to be worth it, start the narration fresh on
      // the next page instead. (Plain narration-only pages still chunk normally.)
      var headMin = (opts.headMinIn != null) ? opts.headMinIn : 1.6;
      var sliverAfterImage = cur2().hasImage && firstFit < headMin;
      if (firstFit >= minChunkIn && !sliverAfterImage) {
        placeRow({ moment: row.moment, hasImage: false }, firstFit, true, 'head');
        cur2().splits.push({ moment: row.moment, heightIn: round3(firstFit), part: 'head' });
        left = round3(left - firstFit);
      }
      while (left > 1e-6) {
        newPage();
        var chunk = Math.min(left, pageH - gap);
        var part = (left <= pageH - gap + 1e-6) ? 'tail' : 'mid';
        placeRow({ moment: row.moment, hasImage: false }, chunk, true, part);
        cur2().splits.push({ moment: row.moment, heightIn: round3(chunk), part: part });
        left = round3(left - chunk);
      }
      continue;
    }

    // doesn't fit and can't split -> its own page (reuse current page if it is
    // already empty, so an over-tall image never strands a blank page before it).
    if (cur2().usedIn > 1e-6) newPage();
    placeRow(row, row.heightIn, false);
    if (row.heightIn > pageH) cur2().overflow = true;   // taller than a whole page
  }

  var pictureless = pages.filter(function (p) { return p.rows.length && !p.hasImage; }).map(function (p) { return p.index; });
  return {
    pageCount: pages.length,
    overLimit: pages.length > maxPages,
    maxPages: maxPages,
    pageHeightIn: pageH,
    rowCount: rows.length,
    picturelessPages: pictureless,
    splitsNeeded: pages.reduce(function (n, p) { return n + p.splits.length; }, 0),
    pages: pages
  };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { packComic };
