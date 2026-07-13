'use strict';

// ============================================================
// brief.js  -  Art-direction brief for the AI layout pass.
// ------------------------------------------------------------
// Pure data + a prompt builder. No side effects, no I/O, so it loads and
// `node --check`s cleanly on its own. The dry-run route feeds a rendered book
// PDF plus this brief to LAYOUT_MODEL and asks for SIGNALS ONLY (never geometry).
//
// House rules apply to every layout; STYLE_BRIEFS override per arrangement.
// Editing these strings is the whole knob for tuning the AI's taste -- no other
// code changes needed.
// ============================================================

const HOUSE_RULES =
`Fill the STORY pages. Aim for as little white space as possible -- shoot for ~100% of the live area on story pages; near-full is the goal, not a wall of equal panels.
LEAVE ALONE (mark "full", no fix): the COVER, the credits/legal page, the character roster ("The Company"), and the table of contents ("Contents") -- these are intentionally sparse and meant to breathe. BUT DO WORK THE TITLE PAGE (the book's title page, typically page 2, with its hero image): if it is under-filled, MAXIMIZE / grow its image (size_hint "grow") to fill the page.
REDISTRIBUTE ONLY WHAT ALREADY EXISTS: grow or crop an existing image, or split and flow existing narrative into a gap. Do NOT propose adding new artwork, new panels, or illustrations that are not already in the book. (Adding art may be an option later; not now.)
Give each page one clear focal beat: push the climax's emphasis up, drop supporting beats down.
On story pages, never strand an image beside empty space, and never leave a near-blank page. If a tall image has little text next to it, grow it. If a gap sits next to an image, flag it to be filled.
Text is the filler. Where empty space remains, note where existing narrative could be split (at periods/clauses, or mid-sentence only if it stays contiguous) and flowed into the gap.
Shrink to fit: if a large or full-page image sits at the top of a page and the PREVIOUS page is under-filled, mark that image size_hint "shrink" -- the engine scales it down (up to 50%, aspect locked) so it moves up to fill the prior page's gap while staying as large as possible. Prefer this over leaving a near-blank page above a big image.
DENSITY IS THE OBJECTIVE. Aim for every page to be as full as the layout allows -- fewer TOTAL pages is the natural RESULT of good density, never a target to chase, so never cram, distort, or hurt a composition just to save a page. When a page is under-filled, prefer COLLAPSING the whole beat rather than nudging one line: shrink the next image (size_hint "shrink") AND flow its narrative up (flow:true) TOGETHER on the same gap, so the entire beat packs onto the prior page and the near-empty page disappears on its own. Reach for both levers at once whenever one alone won't close the gap.
Show the whole subject on a character reveal (crop_safe:false); crop-to-fill for environments and action.
Group beats within a scene; break at scene changes.`;

const STYLE_BRIEFS = {
  'Picture Book':
`Calm and premium, but still full. One or two large images per page that breathe -- portraits can go large and centered. Fill leftover space with flowed narrative rather than leaving gutters empty.`,
  'Comic Page':
`Dense with a strong size rhythm. Hero beats go big / full-width; quiet beats go small. Tight gutters, minimal dead space. This style should feel the fullest.`,
  'Magazine':
`Editorial flow: images sized by emphasis, narrative wraps around them. Balance columns; let text fill around images so no corner is left empty.`,
  'Gazette':
`Magazine's flow but enclosed -- each beat boxed in a parchment panel. Reads a touch denser and more contained; keep boxes packed, text filling each enclosure.`
};

// Map the layout query value the client sends to a brief key. The export route
// accepts values like 'Picture Book' / 'Comic' / 'Magazine' / 'Gazette' (and some
// legacy names); normalize loosely so an unknown value still gets the house rules.
function styleKeyFor(layoutStyle) {
  var s = String(layoutStyle || '').toLowerCase();
  if (s.indexOf('comic') >= 0) return 'Comic Page';
  if (s.indexOf('gazette') >= 0) return 'Gazette';
  if (s.indexOf('magazine') >= 0) return 'Magazine';
  if (s.indexOf('picture') >= 0 || s.indexOf('paired') >= 0) return 'Picture Book';
  return 'Picture Book';
}

// Build the text prompt that rides alongside the PDF document block. The model
// sees the rendered pages via the PDF; this tells it what to judge and the exact
// JSON to return. SIGNALS ONLY -- the deterministic engine owns all geometry.
function buildPrompt(layoutStyle, opts) {
  opts = opts || {};
  var key = styleKeyFor(layoutStyle);
  var house = opts.houseRules || HOUSE_RULES;
  var styleBrief = opts.styleBrief || STYLE_BRIEFS[key] || '';
  var manifest = opts.manifest || [];
  var manifestStr = manifest.length ? manifest.map(function (m) { return m.idx + ' | ' + (m.title || '(untitled)') + (m.shape ? ' [' + m.shape + ']' : ''); }).join('\n') : '(none provided)';
  var fills = opts.fills || null;
  var under = [];
  if (fills) { Object.keys(fills).forEach(function (pg) { var v = Number(fills[pg]); if (v < 62 && (Number(pg) === 2 || Number(pg) > 5)) under.push(Number(pg) + ' -> ' + v + '% filled'); }); under.sort(function (a, b) { return parseInt(a) - parseInt(b); }); }
  var measuredStr = under.length ? under.join('\n') : '(none flagged)';
  return (
`You are a print art director reviewing a rendered tabletop-RPG graphic novel in the "${key}" style. The attached PDF is the actual book, one page per page.

HOUSE RULES (apply to every style):
${house}

STYLE BRIEF ("${key}"):
${styleBrief}

HARD RULE: a deterministic engine owns ALL geometry (exact sizes, margins, page breaks, print bleed). You never move or resize anything yourself and you NEVER output coordinates, pixels, or inches. You only recommend per-panel SIGNALS the engine consumes:
- emphasis: integer 1-5 (1 = minor beat, 5 = full-page hero)
- focal: center | top | bottom | left | right
- crop_safe: boolean (true = may crop-to-fill; false = must show the whole image)
- group_break: boolean (true = starts a new visual scene/row)
- size_hint: shrink | keep | grow
- flow: boolean (true = pull the FOLLOWING beat's intro narrative up onto THIS page to fill leftover vertical space below this panel; use on under-filled pages where growing the image can't help, e.g. a short wide image with a gap beneath it)

MEASURED UNDER-FILL (from a pixel scan of the ACTUAL rendered book -- these are the authoritative gaps; a page listed here IS under-filled even if it looks acceptable, so prioritize closing these specific pages):
${measuredStr}

PANEL MANIFEST (reading order -- the panels appear in the PDF in this exact order; match each to what you see by order and by its title caption):
${manifestStr}

DENSITY IS THE PRIORITY. Go page by page. Flag every page that is under-filled or near-blank, and say how to close the gap: grow an undersized image, or split/flow narrative text into the empty space. Judge fullness by eye; do not invent exact percentages.

CRITICAL -- ENCODE YOUR FIX AS A SIGNAL, OR NOTHING HAPPENS: the engine only acts on the structured panel fields, never on your prose. If your fix flows text, set that panel's "flow":true. If it shrinks an image, set "size_hint":"shrink". If it grows one, set "size_hint":"grow". Any page you mark under_filled or near_blank MUST carry at least one panel whose flow/size_hint is NOT the default (flow:true, or size_hint shrink/grow) -- a page flagged as under-filled with only "keep" panels does NOTHING and the gap remains. Never describe a fix you did not encode.

Respond with STRICT JSON only -- no markdown, no prose outside the JSON. Be terse. Identify pages by their 1-based order in the PDF. Every panel you reference MUST include its "idx" from the manifest so the engine can apply your signals. Shape:
{
  "book_assessment": "2-3 sentences on the book overall",
  "pages": [
    {
      "page": 12,
      "verdict": "full" | "under_filled" | "near_blank",
      "problem": "what's wrong or 'none'",
      "fix": "grow which image / split which text into the gap / drop emphasis, etc.",
      "panels": [
        {"idx":7,"label":"panel title or position","emphasis":3,"focal":"center","crop_safe":true,"group_break":false,"size_hint":"keep","flow":false,"why":"terse reason"}
      ]
    }
  ]
}
Only include pages that need a change plus a few well-filled ones as controls; you do not have to list every page.`
  );
}

module.exports = { HOUSE_RULES, STYLE_BRIEFS, styleKeyFor, buildPrompt };
