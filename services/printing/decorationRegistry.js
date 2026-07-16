'use strict';

// ============================================================
// decorationRegistry.js  -  SINGLE SOURCE OF TRUTH for how much space each
// decoration / chrome element costs the layout.
// ------------------------------------------------------------
// Principle (proven with the packer): beats are PLACED in the stream; their size
// is MEASURED. Content height comes from the measure pass; DECORATION height comes
// from here. Every beat's reserved size = measured content + sum of its active
// decorations resolved through this registry.
//
// Each entry declares its cost in up to four ways so it survives font changes and
// future multi-column layouts without being rewritten:
//   heightIn  - fixed height in inches      (graphics: a drop-shadow offset, a rule line)
//   heightLh  - height in LINE-HEIGHT units  (text-linked: caption text, header title,
//               drop cap) -> scales automatically when font SIZE changes, because the
//               line height is reported by the measure pass, never hardcoded.
//   widthIn   - fixed width cost in inches    (reserved; 0 for single-column Picture Book)
//   widthCol  - width cost in column-fractions (reserved for Comic/Magazine/Gazette 2D layouts)
//   inside    - true = drawn WITHIN the existing box, costs nothing (documentation/intent).
//
// Resolve to inches with the current measured line height:
//     inches = heightIn + heightLh * lineHeightIn
//
// Bias, always: prefer `inside` (zero-cost overlay) designs -- they never clip and
// never need tuning (the inset bronze frame proved this). Only genuinely additive
// things (drop-shadow offset, caption bar BELOW an image, a section header) reserve.
// ============================================================

var REGISTRY = {
  // ---- image frames (keyed frame:<border> from coMedia's border styles) ----
  'frame:none':     { heightIn: 0,    heightLh: 0, widthIn: 0,    widthCol: 0, inside: true },
  'frame:frame':    { heightIn: 0.02, heightLh: 0, widthIn: 0,    widthCol: 0, inside: true  },  // bronze -- INSET, adds ~nothing (2px wrapper)
  'frame:gallery':  { heightIn: 0.14, heightLh: 0, widthIn: 0,    widthCol: 0, inside: false },  // B: image full-size, shadow bleeds outward; small bottom reserve only (was heightIn 0.28 / widthIn 0.28)
  'frame:comic':    { heightIn: 0,    heightLh: 0, widthIn: 0,    widthCol: 0, inside: true  },  // B: 5px border drawn INSET over the image, zero-cost (was heightIn 0.12 / widthIn 0.12)
  'frame:vignette': { heightIn: 0,    heightLh: 0, widthIn: 0,    widthCol: 0, inside: true  },  // overlay gradient, no size
  'frame:keyline':  { heightIn: 0.06, heightLh: 0, widthIn: 0,    widthCol: 0, inside: false },  // 1px hairline + soft shadow

  // ---- per-stacked-image spacing (the margins around a centered image block) ----
  'image-margin':   { heightIn: 0.1,  heightLh: 0, widthIn: 0,    widthCol: 0, inside: false },

  // ---- captions / title bars (auto-fit turns the variable ones into fixed boxes) ----
  'caption:over':   { heightIn: 0,    heightLh: 0,   widthIn: 0,  widthCol: 0, inside: true  },  // overlaid on the image -> free
  'caption:below':  { heightIn: 0.08, heightLh: 1.8, widthIn: 0,  widthCol: 0, inside: false },  // title bar below (box height in line-heights)

  // ---- in-paragraph text decorations ----
  'dropcap':        { heightIn: 0,    heightLh: 0,   widthIn: 0,  widthCol: 0, inside: true  },  // reflows inside the paragraph, ~0 net

  // ---- standalone chrome consulted by content BEATS (e.g. a section-header beat) ----
  'section-header': { heightIn: 0.14, heightLh: 1.7, widthIn: 0,  widthCol: 0, inside: false }   // title (line-heights) + rule + spacing (fixed)
};

var DEFAULT_LH = 0.19;   // fallback line height (in) if the measure pass hasn't supplied one

// Height cost of a single decoration key, in inches, at the current line height.
function decoHeight(key, lineHeightIn) {
  var e = REGISTRY[key];
  if (!e) return 0;
  return (e.heightIn || 0) + (e.heightLh || 0) * (lineHeightIn || DEFAULT_LH);
}

// Width cost of a single decoration key, in inches (widthCol scaled by the column width).
function decoWidth(key, colWidthIn) {
  var e = REGISTRY[key];
  if (!e) return 0;
  return (e.widthIn || 0) + (e.widthCol || 0) * (colWidthIn || 0);
}

// Sum the height cost of a list of active decoration keys.
function decoSumHeight(keys, lineHeightIn) {
  var t = 0;
  (keys || []).forEach(function (k) { t += decoHeight(k, lineHeightIn); });
  return Math.round(t * 1000) / 1000;
}

// Sum the width cost of a list of active decoration keys.
function decoSumWidth(keys, colWidthIn) {
  var t = 0;
  (keys || []).forEach(function (k) { t += decoWidth(k, colWidthIn); });
  return Math.round(t * 1000) / 1000;
}

module.exports = {
  REGISTRY: REGISTRY,
  DEFAULT_LH: DEFAULT_LH,
  decoHeight: decoHeight,
  decoWidth: decoWidth,
  decoSumHeight: decoSumHeight,
  decoSumWidth: decoSumWidth
};
