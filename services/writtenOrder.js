// ============================================================================
// ALREADY WRITTEN -- PICTURES IN THE ORDER OF THE TEXT  (v3.2.77)
//
// Ian, 2026-10-25, after a test on "Salmon River Trip": big narrative blocks with no picture and
// pictures with no text. The cause: Generate Story put the pictures in the order the EVENTS
// happened (on the water on day one, then the tent that night), while the author wrote the camping
// before the rafting. Every other narrative style writes its own prose, so it simply tells the
// events in whatever order the pictures come and nobody ever sees the difference. Already Written
// cannot move a word (services/writtenSlices.js), so a picture only gets text when it sits where
// its passage sits. Four pictures got nothing, and their text piled up under the picture before.
//
// Two halves, both only for a version whose narrative style is 'written':
//   1. PROMPT_BLOCK asks Generate Story for the pictures in the order of the TEXT, spread across
//      it, and for each one the first words of the passage it draws on ("text_start").
//   2. sortByText() puts the pictures in the order those passages appear in the transcript, so a
//      reply that ignores the request is still put right. A picture whose words cannot be found
//      stays straight after the picture it followed in the reply.
// ============================================================================
'use strict';

const PROMPT_BLOCK =
  '## ALREADY WRITTEN -- PICTURES IN THE ORDER OF THE TEXT\n' +
  'This version keeps the author\'s own words, word for word. After this step the text is cut, unchanged, into one passage per panel, ' +
  'in the order the author wrote it, and no sentence can be moved. So for this story:\n' +
  '- Put the panels in the order their passages APPEAR IN THE TEXT, not the order the events happened. If the author describes something ' +
  'before an event that happened earlier, the panel for it still comes first.\n' +
  '- Each panel shows something its own passage describes, and no two panels draw on the same passage.\n' +
  '- Spread the panels across the whole text, from the beginning to the end, so that no long stretch of text is left without a picture ' +
  'and several panels are not crowded into one short passage. Choose moments the text describes well, not only the most dramatic ones.\n' +
  '- In each moment, add a field "text_start": the first 8 to 12 words of the passage that panel illustrates, copied EXACTLY from the text, ' +
  'in the text\'s own language and spelling.\n' +
  '- The narrative_outline panels follow the same order as the moments.\n\n';

// Letters and digits only, lower case, single spaces: curly and straight quotes, dashes and line
// breaks all compare equal, which is what a copied phrase needs.
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[‘’‚‛'`]/g, '')
    .replace(/[^a-z0-9À-ɏ]+/g, ' ')
    .trim();
}

// Where in the (normalised) text a phrase starts, or -1. The whole phrase first; then shorter
// beginnings of it, down to five words, in case the model changed a word near the end.
function findPhrase(normText, phrase) {
  const words = norm(phrase).split(' ').filter(Boolean);
  if (words.length < 3) return -1;
  for (let n = words.length; n >= Math.min(5, words.length); n--) {
    const at = (' ' + normText + ' ').indexOf(' ' + words.slice(0, n).join(' ') + ' ');
    if (at >= 0) return at;
  }
  return -1;
}

// moments: the reply's moments, in the reply's order. panels: narrative_outline.panels (may be
// missing or a different length). Returns new arrays; the inputs are not changed.
function sortByText(moments, panels, transcript) {
  const list = Array.isArray(moments) ? moments : [];
  const outl = Array.isArray(panels) ? panels : null;
  const normText = norm(transcript);
  let found = 0;
  let prev = -1;
  const keyed = list.map(function (m, i) {
    const at = findPhrase(normText, m && m.text_start);
    if (at >= 0) { found++; prev = at; }
    // Not found: keep it straight after the picture it followed.
    return { m: m, p: outl ? outl[i] : undefined, pos: at >= 0 ? at : prev, i: i };
  });
  const sorted = keyed.slice().sort(function (a, b) { return (a.pos - b.pos) || (a.i - b.i); });
  const moved = sorted.some(function (k, j) { return k.i !== j; });
  const outMoments = sorted.map(function (k) {
    const c = Object.assign({}, k.m);
    delete c.text_start;
    return c;
  });
  let outPanels = outl;
  if (outl) {
    outPanels = sorted.map(function (k) {
      const p = Object.assign({}, k.p || {});
      // A bridge leads to the NEXT picture; after a reorder that is a different picture.
      if (moved) p.bridge = '';
      return p;
    });
    for (let x = list.length; x < outl.length; x++) outPanels.push(outl[x]);
  }
  return { moments: outMoments, panels: outPanels, found: found, total: list.length, moved: moved, order: sorted.map(function (k) { return k.i; }) };
}

module.exports = { PROMPT_BLOCK, sortByText, findPhrase, norm };
