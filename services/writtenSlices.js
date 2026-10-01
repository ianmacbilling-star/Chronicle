// ============================================================================
// ALREADY WRITTEN  (v3.1.49 -- TD-941)
//
// Ian, 2026-10-01: a narrative style that "just takes pretty much exactly what is written... and
// slices it into the appropriate narrative and image panels... doing its best to keep it word for
// word."
//
// WORD FOR WORD BY CONSTRUCTION, NOT BY ASKING. The model never retypes the author's text. The
// server cuts the text into numbered sentences (units), the model answers only with unit NUMBERS
// -- where each block starts -- and the server copies the author's own characters between those
// cuts. So the words cannot change, nothing can be added, nothing can be dropped or repeated, and
// every cut falls between sentences. A bad answer can only put a cut in the wrong place.
//
// The blocks are the same chain every narrative style fills:
//   intro -> panel 1 before -> panel 1 after -> panel 2 before -> ... -> outro
// Each block runs from its start unit up to the next block's start. Two equal starts make the
// first block EMPTY, which is allowed here (Ian: "Ok on empty blocks").
// ============================================================================
'use strict';

// Where a new unit may start: after sentence-ending punctuation (and any closing quotes or
// brackets) followed by whitespace, or after a line break. Offsets are into the ORIGINAL text,
// so slicing between them returns the author's exact characters, line breaks included.
const CLOSERS = '"\'”’)]»';
function isEnder(ch) { return ch === '.' || ch === '!' || ch === '?' || ch === '…'; }
const ABBREV = ['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'mt', 'vs', 'prof', 'rev', 'capt', 'sgt', 'lt', 'col', 'gen', 'no', 'etc', 'e.g', 'i.e'];
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' '; }

function splitUnits(text) {
  const s = String(text == null ? '' : text);
  const starts = [];
  let i = 0;
  while (i < s.length && isSpace(s[i])) i++;
  if (i >= s.length) return [];
  starts.push(i);
  while (i < s.length) {
    const ch = s[i];
    let boundary = -1;
    if (ch === '\n') {
      boundary = i + 1;
    } else if (isEnder(ch)) {
      let j = i + 1;
      while (j < s.length && (isEnder(s[j]) || CLOSERS.indexOf(s[j]) >= 0)) j++;
      if (j >= s.length || isSpace(s[j])) {
        // Not a sentence end: a lowercase word follows ("frozen... mostly"), or the word before the
        // full stop is a short title or abbreviation ("Dr. Smith", "Mrs. Hale", "St. Ives").
        let k2 = j; while (k2 < s.length && isSpace(s[k2]) && s[k2] !== '\n') k2++;
        const nextLower = k2 < s.length && s[k2] !== '\n' && s[k2] !== s[k2].toUpperCase() && s[k2] === s[k2].toLowerCase();
        let w0 = i; while (w0 > 0 && /[A-Za-z]/.test(s[w0 - 1])) w0--;
        const abbrev = ch === '.' && ABBREV.indexOf(s.slice(w0, i).toLowerCase()) >= 0 && !(k2 < s.length && s[k2] === '\n');
        if (!nextLower && !abbrev) boundary = j;
      }
      i = j - 1;
    }
    if (boundary >= 0) {
      let k = boundary;
      while (k < s.length && isSpace(s[k])) k++;
      if (k < s.length && k > starts[starts.length - 1]) starts.push(k);
      i = Math.max(i, k - 1);
    }
    i++;
  }
  return starts.map(function (st, n) {
    const end = (n + 1 < starts.length) ? starts[n + 1] : s.length;
    return { start: st, end: end, text: s.slice(st, end) };
  });
}

// The text as the model sees it: every unit led by its number in square brackets. Line breaks
// are kept so paragraphs are visible, and the numbers are what the model answers with.
function numberedText(units) {
  return units.map(function (u, n) { return '[' + (n + 1) + '] ' + u.text.replace(/\s+$/, '') + (/\n\s*\n\s*$/.test(u.text) ? '\n\n' : /\n\s*$/.test(u.text) ? '\n' : ' '); }).join('').replace(/\s+$/, '');
}

// Turn the model's start numbers into the blocks. `parsed` is the model's JSON:
//   { sections: [{ before_start, after_start }, ...], outro_start }
// The intro always starts at unit 1. Any start that is missing, not a whole number, out of range
// or earlier than the block before it is treated as "the same as the block before" -- i.e. that
// block is empty and its text stays with the previous one. Nothing is ever lost or doubled.
// Returns { intro, sections: [{ panel_index, before, after }], outro, fixed } where `fixed` counts
// the starts that had to be corrected (for the log).
function buildBlocks(text, units, parsed, nMoments) {
  const s = String(text == null ? '' : text);
  const n = units.length;
  const END = n + 1;
  let fixed = 0;
  const secs = (parsed && Array.isArray(parsed.sections)) ? parsed.sections : [];
  const wanted = [1];
  for (let p = 0; p < nMoments; p++) {
    const sec = secs[p] || {};
    wanted.push(sec.before_start, sec.after_start);
  }
  wanted.push(parsed ? parsed.outro_start : undefined);
  // Pass 1: which answers can be used -- whole numbers from 1 to END that never go backwards.
  const val = [];
  let last = 1;
  wanted.forEach(function (w) {
    let v = (typeof w === 'number') ? w : (typeof w === 'string' && /^\s*\d+\s*$/.test(w)) ? parseInt(w, 10) : NaN;
    if (Number.isInteger(v) && v >= last && v <= END) { val.push(v); last = v; }
    else { val.push(null); fixed++; }
  });
  // Pass 2: an unusable start becomes the NEXT usable one, so that block is empty and the block before
  // it keeps its text. (Taking the previous start instead would empty the block before.)
  const starts = val.slice();
  let next = END;
  for (let k = starts.length - 1; k >= 0; k--) { if (starts[k] === null) starts[k] = next; else next = starts[k]; }
  function offsetOf(unitNo) { return (unitNo >= END || !n) ? s.length : units[unitNo - 1].start; }
  function block(k) {
    const a = offsetOf(starts[k]);
    const b = (k + 1 < starts.length) ? offsetOf(starts[k + 1]) : s.length;
    return s.slice(a, b).trim();
  }
  const out = { intro: block(0), sections: [], outro: block(starts.length - 1), fixed: fixed };
  for (let p = 0; p < nMoments; p++) {
    out.sections.push({ panel_index: p, before: block(1 + 2 * p), after: block(2 + 2 * p) });
  }
  return out;
}

module.exports = { splitUnits, numberedText, buildBlocks };
