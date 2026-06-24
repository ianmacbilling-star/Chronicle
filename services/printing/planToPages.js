'use strict';

// ============================================================
// planToPages.js  -  turn a packComic plan into per-page render instructions
// (two-pass Stage 4). PURE: no rendering, no I/O -- fully unit-testable.
// ------------------------------------------------------------
// Input:
//   plan      : output of packComic (pages[].placements present)
//   perMoment : { <momentIndex>: { narrText:String, narrHeightIn:Number } }
//               narrHeightIn is the MEASURED total narration height for that
//               moment (used to derive chars-per-inch for clean text splitting).
// Output: array aligned to plan.pages, each:
//   { index, continuations:[{moment,text}], starts:[{moment,text}] }
//   - starts        = moments whose IMAGE lands on this page (render full panel,
//                     narration trimmed to this page's portion)
//   - continuations = narration of a moment whose image was on an EARLIER page
//                     (render as a standalone narration box, before the starts)
// ============================================================

var splitNarr = require('./splitNarrative');

function planToPageContent(plan, perMoment) {
  perMoment = perMoment || {};
  var pages = (plan && plan.pages) || [];

  // 1) For each moment: the page its image is on, and the ordered list of
  //    (pageIndex, narrHeightIn) where it has narration.
  var imagePage = {};      // moment -> page index
  var narrPages = {};      // moment -> [{page, heightIn}]
  for (var pi = 0; pi < pages.length; pi++) {
    var pl = pages[pi].placements || [];
    for (var k = 0; k < pl.length; k++) {
      var a = pl[k];
      if (a.kind === 'image') {
        if (imagePage[a.moment] == null) imagePage[a.moment] = pi;
      } else {
        if (!narrPages[a.moment]) narrPages[a.moment] = [];
        var arr = narrPages[a.moment];
        var last = arr[arr.length - 1];
        if (last && last.page === pi) last.heightIn += (a.heightIn || 0);
        else arr.push({ page: pi, heightIn: (a.heightIn || 0) });
      }
    }
  }

  // 2) For each moment with narration, split its text across the pages it spans.
  var textByMomentPage = {};   // moment -> { page -> text }
  Object.keys(narrPages).forEach(function (mKey) {
    var m = mKey;
    var spans = narrPages[m];
    var info = perMoment[m] || {};
    var fullText = info.narrText || '';
    var totalH = info.narrHeightIn || 0;
    var heights = spans.map(function (s) { return s.heightIn; });
    var cpi = (totalH > 0 && fullText.length > 0) ? (fullText.length / totalH) : 0;
    var parts;
    if (spans.length <= 1) { parts = [fullText]; }
    else { parts = splitNarr.splitToPages(fullText, heights, cpi); }
    textByMomentPage[m] = {};
    for (var si = 0; si < spans.length; si++) {
      textByMomentPage[m][spans[si].page] = (parts[si] != null ? parts[si] : '');
    }
  });

  // 3) Build per-page instructions.
  var out = [];
  for (var p = 0; p < pages.length; p++) {
    var starts = [], continuations = [];
    var seen = {};
    var pls = pages[p].placements || [];
    for (var j = 0; j < pls.length; j++) {
      var mm = pls[j].moment;
      if (seen[mm]) continue; seen[mm] = true;
      var txt = (textByMomentPage[mm] && textByMomentPage[mm][p] != null) ? textByMomentPage[mm][p] : '';
      if (imagePage[mm] === p) {
        starts.push({ moment: Number(mm), text: txt });
      } else if (txt) {
        continuations.push({ moment: Number(mm), text: txt });
      }
    }
    starts.sort(function (a, b) { return a.moment - b.moment; });
    out.push({ index: p, continuations: continuations, starts: starts });
  }
  return out;
}

module.exports = { planToPageContent: planToPageContent };
