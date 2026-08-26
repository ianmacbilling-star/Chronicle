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

// v3.0.784 -- TD-585. INTERIOR PRINTING: INK AND GRADE, AS ONE CHOICE.
//
// `ink: 'color'` used to be a HARDCODED CONSTANT in buildSpec, so black-and-white was
// unreachable -- _packageId has always carried `spec.ink === 'color' ? 'FC' : 'BW'` and nothing
// could ever make it emit BW. Every order ever placed was a full-colour print, whatever the art
// looked like, and full colour is the most expensive interior Lulu sells: the confirmed print
// costs in luluProvider put standard colour at 7.01 and premium colour at 18.97 for this trim.
// A charcoal book was paying for colour it did not use.
//
// FOUR ENTRIES IN ONE CONTROL, NOT TWO CONTROLS. The reader is answering one question -- how
// should the inside be printed -- and a second control that only sometimes applies is the shape
// TD-498 warns about, where "not shown" and "not chosen" stop being distinguishable. It also
// means the answer rides in the EXISTING color_tier column: the order row, the order_spec
// snapshot, reorder and the fulfilment rebuild all carry it today, with no new field to thread
// through five places and forget in one -- which is precisely how TD-579 (paper dropped at
// fulfilment) happened.
//
// EACH ENTRY DECLARES ITS OWN ink AND quality. buildSpec reads them from here rather than
// parsing the key, so adding a grade is a line in this table and nothing else. The old code
// derived quality with `sel.colorTier === 'standard' ? 'standard' : 'premium'`, which silently
// makes every unknown value premium -- the expensive answer to a question nobody asked.
// v3.0.796 -- TD-605. THE STANDARD GRADES ARE NOT OFFERED, AND THE PRINTER IS WHY.
//
// Ian gets this from Lulu's own upload form, every time, on a book made by this product:
//
//   "Ink Coverage: Your file contains inks with high ink coverage requirements. Using Standard
//    print for content with high ink coverage requirements may result in poor print quality.
//    Please select Premium print or adjust your file to include lower ink coverage.
//    Found on pages 5, 7, 9, 29, 33, and 57."
//
// Six pages of a 104-page book, which makes it the normal case rather than an edge one: every book
// this thing makes is full-bleed art. The VENDOR is saying Standard cannot print it well. That is a
// better reason than any argument from taste, and it is the only kind this file accepts.
//
// UNOFFERED, NOT UNAVAILABLE -- AND THE DIFFERENCE IS LOAD-BEARING.
//
// Cream (below) is filtered by `paperIsAvailable` AND refused by buildSpec, because TD-579 settled
// that a hidden control is not a rule: cream genuinely CANNOT be sold, Lulu rejects the SKU, so
// anything that reaches buildSpec with it must be stopped.
//
// These two are different. `0850X1100FCSTDPB060UW444MXX` is a confirmed product that returned a
// real $7.01 quote -- Lulu will print it. We have simply decided not to sell it. So buildSpec is
// left ALONE and only the picker filters:
//   - every order already placed on a standard tier still prices, fulfils and REORDERS. The answer
//     rides in `color_tier` (TD-585) and rows holding it must stay valid, or a past order becomes
//     unreorderable with no route to a value anything accepts.
//   - bringing them back is `offered: true` and nothing else.
// DO NOT "tidy" this into the cream rule by adding a buildSpec check. Collapsing *unavailable* into
// *unoffered* breaks every historical row; collapsing it the other way makes cream sellable again.
//
// Premium black & white stays, so cream stays with it: `paperIsAvailable` asks only whether the
// chosen tier's ink is 'bw', and bwpremium answers yes.
const COLOR_TIERS = {
  premium:     { label: 'Premium color',  note: 'Best for full-color art on every page', ink: 'color', quality: 'premium', isDefault: true },
  standard:    { label: 'Standard color', note: 'Budget option; best for mostly-text books', ink: 'color', quality: 'standard', offered: false },
  bwpremium:   { label: 'Premium black & white', note: 'Best for detailed line art, charcoal and ink work', ink: 'bw', quality: 'premium' },
  bwstandard:  { label: 'Standard black & white', note: 'Budget option; best for mostly-text books', ink: 'bw', quality: 'standard', offered: false },
};
/** The ink a colour tier prints in ('color' | 'bw'). Unknown tiers report null, never a default. */
function inkForTier(tier) {
  var t = COLOR_TIERS[tier];
  return t ? t.ink : null;
}

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
// v3.0.784 -- TD-585. CREAM IS UNLOCKED BY BLACK AND WHITE, WHICH IS THE PRODUCT LULU SELLS.
//
// v3.0.783 removed cream outright after the first real cream order could not even be priced.
// That was right at the time and the reason turns out to be one layer down: cream is uncoated
// novel stock and Lulu pairs it with BW. We were asking for FULL COLOUR on cream, which is the
// one combination least likely to exist -- so the SKU was not necessarily wrong in its
// characters, the PRODUCT was. With black-and-white reachable, cream becomes an ordinary
// pairing rather than a guess.
//
// AVAILABILITY IS NOW A QUESTION ABOUT A SELECTION, not a standing flag. A static available:false
// cannot express "valid with BW, invalid with colour", and a picker that offers what buildSpec
// would refuse is the fault this whole area keeps producing. One predicate, asked by the options
// list AND by buildSpec, so the control and the rule cannot disagree.
const PAPERS = {
  white: { label: 'White', isDefault: true },
  cream: { label: 'Cream', note: 'Warm stock for black & white books', requiresInk: 'bw',
           unavailableReason: 'Cream paper is only available for black & white interiors.' },
};
function paperIsAvailable(key, sel) {
  var p = PAPERS[key];
  if (!p) return false;
  if (!p.requiresInk) return true;
  // No selection to judge against -> report the paper as unavailable rather than assuming a
  // permissive default. An unknown answer must never be the yes.
  return inkForTier((sel || {}).colorTier) === p.requiresInk;
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
// v3.0.784 -- TD-585. The caller passes the selection so the paper list reflects the ink the
// reader has actually chosen. Omitted (an older caller, a first load) -> cream is absent, which
// is the safe direction: an option that appears late is a smaller surprise than one that
// vanishes at the price.
function optionsForPageCount(pageCount, sel) {
  const bindings = availableBindings(pageCount);
  return {
    trim: TRIM,
    pageCount,
    bindings: bindings.map((k) => ({
      id: k, ...BINDINGS[k], printedPageCount: printedPageCount(pageCount, k),
    })),
    // v3.0.796 -- TD-605. Only the grades we offer. Same shape as the `papers` line below, so the
    // <select> loses them by construction rather than by a second rule in the client that could
    // drift from this one. buildSpec still accepts them -- see the note on COLOR_TIERS.
    colorTiers: Object.keys(COLOR_TIERS).filter((k) => COLOR_TIERS[k].offered !== false).map((k) => ({ id: k, ...COLOR_TIERS[k] })),
    coverFinishes: Object.keys(COVER_FINISHES).map((k) => ({ id: k, ...COVER_FINISHES[k] })),
    // v3.0.783 -- TD-579. Only papers we can actually sell. The Order tab fills its <select>
    // straight from this array, so an unavailable stock disappears from the UI by construction
    // rather than by a second rule in the client that could drift from this one.
    papers: Object.keys(PAPERS).filter((k) => paperIsAvailable(k, sel)).map((k) => ({ id: k, ...PAPERS[k] })),
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
  if (sel.paper && PAPERS[sel.paper] && !paperIsAvailable(sel.paper, sel)) {
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
      // v3.0.784 -- TD-585. Both read from the tier's own declaration. `ink` was the constant
      // 'color'; `quality` was a ternary that resolved every unrecognised value to premium.
      ink: COLOR_TIERS[sel.colorTier].ink,
      quality: COLOR_TIERS[sel.colorTier].quality,
      coverFinish: sel.coverFinish === 'gloss' ? 'gloss' : 'matte',
      paper: sel.paper === 'cream' ? 'cream' : 'white',
    },
  };
}

module.exports = {
  TRIM, BINDINGS, COLOR_TIERS, COVER_FINISHES, PAPERS,
  printedPageCount, availableBindings, optionsForPageCount, buildSpec, paperIsAvailable, inkForTier,
};
