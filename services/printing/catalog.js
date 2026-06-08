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
    default: {
      binding: bindings.includes('paperback') ? 'paperback' : (bindings[0] || null),
      colorTier: 'premium',
      coverFinish: 'matte',
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
    },
  };
}

module.exports = {
  TRIM, BINDINGS, COLOR_TIERS, COVER_FINISHES,
  printedPageCount, availableBindings, optionsForPageCount, buildSpec,
};
