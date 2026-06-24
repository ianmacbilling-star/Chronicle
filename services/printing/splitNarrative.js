'use strict';

// ============================================================
// splitNarrative.js  -  paragraph/chunk-level narration splitter (two-pass Stage 3)
// ------------------------------------------------------------
// The packer decides, by HEIGHT, how much of a moment's narration belongs on
// each page it spans. This module turns those heights into actual TEXT: it
// chunks the narration on sentence boundaries (the same way the comic renderer
// already groups narration), then fills each page up to its height budget at a
// clean chunk boundary -- never mid-sentence. Pure, no I/O, fully testable.
//
// charsPerInch is derived by the caller from the MEASURED narration
// (totalChars / totalHeightIn) so the budget reflects this book's real font
// metrics and column width rather than a guess.
// ============================================================

// Group text into ~2-4 sentence chunks (mirrors the renderer's cgSplitNarr).
function chunkNarrative(text, targetChars) {
  targetChars = targetChars || 220;
  var s = String(text == null ? '' : text).trim();
  if (!s) return [];
  var sentences = s.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [s];
  var chunks = [], cur = '';
  for (var i = 0; i < sentences.length; i++) {
    var piece = sentences[i];
    if (cur && (cur.length + piece.length) > targetChars) { chunks.push(cur.trim()); cur = ''; }
    cur += piece;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// Split `text` across pages whose available narration heights are pageHeightsIn.
// Returns an array (same length as pageHeightsIn, trailing empties trimmed) of
// the text assigned to each page. Always advances by at least one chunk per page
// so a single oversized chunk cannot stall the loop.
function splitToPages(text, pageHeightsIn, charsPerInch) {
  var chunks = chunkNarrative(text);
  charsPerInch = (charsPerInch && charsPerInch > 0) ? charsPerInch : 110;
  var out = [];
  var idx = 0;
  for (var p = 0; p < pageHeightsIn.length; p++) {
    var budget = Math.max(0, pageHeightsIn[p]) * charsPerInch;
    var parts = [], acc = 0;
    while (idx < chunks.length) {
      var len = chunks[idx].length;
      if (parts.length > 0 && (acc + len) > budget) break;
      parts.push(chunks[idx]); acc += len; idx++;
    }
    out.push(parts.join(' '));
    if (idx >= chunks.length) break;
  }
  // Any remainder (e.g. budgets undershot) lands on the last page.
  while (idx < chunks.length) {
    if (!out.length) out.push('');
    out[out.length - 1] += (out[out.length - 1] ? ' ' : '') + chunks[idx++];
  }
  // Trim trailing empty pages.
  while (out.length > 1 && !out[out.length - 1]) out.pop();
  return out;
}

module.exports = { chunkNarrative: chunkNarrative, splitToPages: splitToPages };
