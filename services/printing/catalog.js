'use strict';

/**
 * Vendor-neutral print product catalog.
 *
 * This is "what Campaignia sells": the binding / color / finish options
 * and the page-count window each binding can physically hold. It never
 * mentions Lulu -- the PrintProvider adapter turns a chosen neutral
 * selection (the BookSpec produced by buildSpec) into a vendor SKU.
 *
 * Only 8.5x11 is offered for now. Adding a trim size later means a new
 * geometry in the PDF generator + its own physical proof, so it is a
 * deliberate product addition, not a config tweak.
 */

const TRIM = { widthIn: 8.5, heightIn: 11 };

/**
 * Page-count windows per binding (INTERIOR pages).
 *
 * Folded-signature bindings need a page count that is a multiple of 4;
 * we round UP and the printer pads blank pages to reach it.
 *
 * Minimums are Lulu-confirmed: paperback 32, hardcover 24, saddle 8.
 * The saddle-stitch MAX is paper-dependent and not yet confirmed against
 * Lulu specifically -- 48 is a conservative industry-safe default. CONFIRM
 * against Lulu's calculator/sandbox and adjust SADDLE_MAX if they allow more.
 */
const SADDLE_MAX = 48; // TODO confirm exact Lulu saddle-stitch ceiling
const BINDINGS = {
  saddle:    { label: 'Comic Book (saddle stitch)', min: 8,  max: SADDLE_MAX, multipleOf: 4, gutter: false },
  paperback: { label: 'Softcover (perfect bound)',  min: 32, max: 800,        multipleOf: 4, gutter: true  },
  hardcover: { label: 'Hardcover (casewrap)',       min: 24, max: 800,        multipleOf: 4, gutter: true  },
};

// Color tier: Premium is the quality-appropriate default for full-color
// art on every page; Standard is the budget option (Lulu describes it as
// for mostly-text books with a few color images).
const COLOR_TIERS = {
  premium:  { label: 'Premium color',  note: 'Best for full-color art on every page', isDefault: true },
  standard: { label: 'Standard color', note: 'Budget option; best for mostly-text books' },
};

const COVER_FINISHES = {
  matte: { label: 'Matte', isDefault: true },
  gloss: { label: 'Gloss' },
};

// Interior paper stock. White is the default (best for full color). Cream is a
// warm stock offered for the aged look; Lulu positions it for B&W, so the UI
// warns. The Lulu interior PDF is always rendered white; cream is the physical
// paper (SKU swaps 060UW444 -> 060UC444).
// v3.0.783 -- TD-579. CREAM IS NOT A PRODUCT WE CAN SELL, SO IT IS NOT OFFERED.
//
// It was in the picker from the start and had never once been bought. The first real attempt,
// 2026-08-24, could not even get a PRICE: the cream SKU is the confirmed white one with the
// paper code swapped, and Lulu rejects it. The comment on PAPER_CODE_CREAM in luluProvider.js
// had said so all along -- "SANDBOX-CONFIRM a cream quote before the first real cream order" --
// and nobody did.
//
// WHY REMOVING IT IS THE FIX RATHER THAN GUESSING A BETTER SKU. Every book this product makes
// is full colour, and Lulu positions cream for black-and-white work; their own documentation
// contradicts itself on whether full-colour cream exists at all, showing an FC cream SKU in an
// example that describes a black-and-white book. Two builds were already spent guessing vendor
// codes (v3.0.376, v3.0.429) and the lesson recorded from those was to read what the vendor
// says rather than try a third string. An option that always fails is worse than an absent one:
// the reader assumes the fault is their book.
//
// TO TURN IT BACK ON, one line: set available:true here, after a real quote has been confirmed
// and a verified SKU has been added to CREAM_SKUS in luluProvider.js. This flag is the single
// source of truth -- optionsForPageCount filters on it so the picker cannot offer what buildSpec
// would refuse, and buildSpec refuses it so a hand-built request cannot get past the picker.
const PAPERS = {
  white: { label: 'White', isDefault: true, available: true },
  cream: { label: 'Cream', note: 'Only recommended for black & white books', available: false,
           unavailableReason: 'Lulu has no confirmed cream stock for a full-colour book of this size.' },
};
function paperIsAvailable(key) {
  var p = PAPERS[key];
  return !!(p && p.available !== false);
}

function roundUpToMultiple(n, m) {
  return Math.ceil(n / m) * m;
}

/** Printed page count for a binding (padded up to its signature multiple). */
function printedPageCount(pageCount, binding) {
  const b = BINDINGS[binding];
  if (!b) return pageCount;
  return b.multipleOf ? roundUpToMultiple(pageCount, b.multipleOf) : pageCount;
}

/** Binding keys that can physically hold a book of this page count. */
function availableBindings(pageCount) {
  return Object.keys(BINDINGS).filter((k) => {
    const b = BINDINGS[k];
    const printed = printedPageCount(pageCount, k);
    return printed >= b.min && printed <= b.max;
  });
}

/**
 * Full menu for a page count: fitting bindings + the color/finish axes +
 * a sensible default selection. This is what the order UI renders.
 */
function optionsForPageCount(pageCount) {
  const bindings = availableBindings(pageCount);
  return {
    trim: TRIM,
    pageCount,
    bindings: bindings.map((k) => ({
      id: k, ...BINDINGS[k], printedPageCount: printedPageCount(pageCount, k),
    })),
    colorTiers: Object.keys(COLOR_TIERS).map((k) => ({ id: k, ...COLOR_TIERS[k] })),
    coverFinishes: Object.keys(COVER_FINISHES).map((k) => ({ id: k, ...COVER_FINISHES[k] })),
    // v3.0.783 -- TD-579. Only papers we can actually sell. The Order tab fills its <select>
    // straight from this array, so an unavailable stock disappears from the UI by construction
    // rather than by a second rule in the client that could drift from this one.
    papers: Object.keys(PAPERS).filter(paperIsAvailable).map((k) => ({ id: k, ...PAPERS[k] })),
    default: {
      binding: bindings.includes('paperback') ? 'paperback' : (bindings[0] || null),
      colorTier: 'premium',
      coverFinish: 'matte',
      paper: 'white',
    },
  };
}

/**
 * Validate a user selection against the catalog + page count and produce
 * the neutral BookSpec the PrintProvider consumes.
 * @returns {{ok:boolean, errors:string[], spec?:Object}}
 */
function buildSpec(sel, pageCount) {
  sel = sel || {};
  const errors = [];
  if (!BINDINGS[sel.binding]) errors.push('Unknown binding: ' + sel.binding);
  if (!COLOR_TIERS[sel.colorTier]) errors.push('Unknown color tier: ' + sel.colorTier);
  if (!COVER_FINISHES[sel.coverFinish]) errors.push('Unknown cover finish: ' + sel.coverFinish);
  if (sel.paper && !PAPERS[sel.paper]) errors.push('Unknown paper: ' + sel.paper);
  // v3.0.783 -- TD-579. A hidden control is not a rule. Anything that reaches buildSpec with an
  // unavailable stock -- a stale form, a restored reorder, a hand-made request -- is refused here
  // with the reason, rather than being quietly downgraded to white further down the path.
  if (sel.paper && PAPERS[sel.paper] && !paperIsAvailable(sel.paper)) {
    errors.push(PAPERS[sel.paper].unavailableReason ||
      ('This paper is not currently available: ' + sel.paper));
  }
  if (!(pageCount > 0)) errors.push('Invalid page count: ' + pageCount);
  if (BINDINGS[sel.binding] && pageCount > 0 && !availableBindings(pageCount).includes(sel.binding)) {
    const b = BINDINGS[sel.binding];
    errors.push(`${b.label} requires ${b.min}-${b.max} pages (book is ${pageCount}).`);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    spec: {
      trimWidthIn: TRIM.widthIn,
      trimHeightIn: TRIM.heightIn,
      pageCount: printedPageCount(pageCount, sel.binding),
      binding: sel.binding,
      ink: 'color',
      quality: sel.colorTier === 'standard' ? 'standard' : 'premium',
      coverFinish: sel.coverFinish === 'gloss' ? 'gloss' : 'matte',
      paper: sel.paper === 'cream' ? 'cream' : 'white',
    },
  };
}

module.exports = {
  TRIM, BINDINGS, COLOR_TIERS, COVER_FINISHES, PAPERS,
  printedPageCount, availableBindings, optionsForPageCount, buildSpec, paperIsAvailable,
};
