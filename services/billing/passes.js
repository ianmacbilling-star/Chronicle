// ============================================================================
// PLATINUM PASS CATALOG  (v3.0.920 -- TD-780 Push 4)
//
// Authoritative, server-side. SAME CONTRACT AS packs.js, and it is the one that
// matters: the amount charged and the tokens granted are always read from HERE
// by id, never from the client.
//
// CODE DEFAULTS, SHADOWED BY A DATABASE ROW -- the identical shape as tier_config
// in middleware/tiers.js, because Ian edits these from the dashboard. Overrides
// live in app_settings under 'pass_config' and are loaded once at boot.
//
// WHAT IS EDITABLE, AND WHY THE LIST IS SHORT:
//   tokens       yes -- the allotment granted, one lump, at purchase
//   price_cents  yes -- entered as dollars in the admin form, stored as cents
//   months       NO  -- the duration IS the product. "3 Month Pass" quietly
//                       becoming four months is the kind of edit nobody
//                       remembers making and everybody has to live with.
//   tier         NO  -- Platinum only. Ian, 2026-09-15: "I would do Platinum
//                       passes only."
//   id / name    NO  -- the id is referenced by Stripe metadata on every
//                       purchase ever made; renaming it orphans history.
//
// PRICES AND ALLOTMENTS as settled 2026-09-16. $79 / $149 / $279, and 200 / 375 / 700
// tokens, which puts all three within half a cent of $0.39 per token.
//
// THE COMPARISON THAT MATTERS IS PER TOKEN, and it is Ian's, not the financial model's:
// subscriptions run about 33 cents a token and passes about 39. "You pay a little more
// per token on the passes but not a ton more. But you aren't on the hook as long." That
// is one number a customer already knows how to read; the two-thirds-access split in the
// financial model is a margin tool and was never a sales story.
//
// THESE ARE FALLBACKS, NOT THE LIVE NUMBERS. app_settings.pass_config shadows them, and
// the dashboard writes that. They are kept in step so that losing the row costs nothing.
// ============================================================================

const PASSES = {
  p3:  { id: 'p3',  name: '3 Month Platinum Pass',  tier: 'platinum', months: 3,  tokens: 200, price_cents: 7900 },
  p6:  { id: 'p6',  name: '6 Month Platinum Pass',  tier: 'platinum', months: 6,  tokens: 375, price_cents: 14900 },
  p12: { id: 'p12', name: '12 Month Platinum Pass', tier: 'platinum', months: 12, tokens: 700, price_cents: 27900 }
};

// Display order, top to bottom, in the admin tab and (later) on the pricing page.
const PASS_ORDER = ['p3', 'p6', 'p12'];

// The ONLY two fields the dashboard may write. Anything else in a PUT body is
// discarded rather than merged -- see savePassConfig.
const EDITABLE_PASS_FIELDS = ['tokens', 'price_cents'];

let PASS_OVERRIDES = {};

// Load the DB overrides once at boot. Mirrors loadTierConfig: on ANY failure the
// code defaults stand, because a pass with no price is worse than a stale one.
async function loadPassConfig() {
  const { getDb } = require('../../database/db');
  try {
    const db = await getDb();
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'pass_config'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') PASS_OVERRIDES = parsed;
    }
  } catch (e) {
    console.error('loadPassConfig failed (using code defaults):', e.message);
  }
  return PASS_OVERRIDES;
}

function getPassOverrides() {
  return JSON.parse(JSON.stringify(PASS_OVERRIDES || {}));
}

// The effective pass: code default merged with any override. Returns null for an
// unknown id -- deliberately NOT a fallback to some default pass, because every
// caller of this is about to charge somebody.
function getPass(id) {
  if (!id || !Object.prototype.hasOwnProperty.call(PASSES, id)) return null;
  const base = PASSES[id];
  const ov = PASS_OVERRIDES[id];
  return ov ? Object.assign({}, base, ov) : base;
}

function listPasses() {
  return PASS_ORDER.map(function (k) { return getPass(k); }).filter(Boolean);
}

// THE VALIDATION RULE, PURE AND ON ITS OWN. A blank or unparseable value DELETES
// the override, so the field falls back to the code default rather than becoming
// zero -- a pass priced at $0 by a stray keystroke is the failure this shape
// exists to prevent. Split out from savePassConfig for two reasons: it is
//
// It is split out from savePassConfig for two reasons: it is the part that decides what somebody
// gets charged, so it deserves to be driven directly by the batch guard with no database anywhere
// near it; and running it BEFORE the persistence means the in-memory catalog is updated by the
// same code path whether or not the write lands.
function mergePassValues(id, values) {
  const clean = Object.assign({}, PASS_OVERRIDES[id] || {});
  EDITABLE_PASS_FIELDS.forEach(function (f) {
    if (!values || !Object.prototype.hasOwnProperty.call(values, f)) return;
    const raw = values[f];
    if (raw === null || raw === '' || raw === undefined) { delete clean[f]; return; }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 0) { delete clean[f]; return; }
    clean[f] = n;
  });
  return clean;
}

// Save the editable fields for ONE pass and return its merged effective config.
async function savePassConfig(id, values) {
  if (!Object.prototype.hasOwnProperty.call(PASSES, id)) throw new Error('Unknown pass: ' + id);
  PASS_OVERRIDES[id] = mergePassValues(id, values);
  const { getDb } = require('../../database/db');
  const db = await getDb();
  const json = JSON.stringify(PASS_OVERRIDES);
  // Upsert via existing-check, matching the tier_config and image_model pattern
  // in this repo (avoids the db wrapper's RETURNING handling on ON CONFLICT).
  const existing = await db.prepare("SELECT setting_key FROM app_settings WHERE setting_key = 'pass_config'").get();
  if (existing) {
    await db.prepare("UPDATE app_settings SET value = ? WHERE setting_key = 'pass_config'").run(json);
  } else {
    await db.prepare("INSERT INTO app_settings (setting_key, value) VALUES ('pass_config', ?)").run(json);
  }
  return getPass(id);
}

module.exports = {
  PASSES, PASS_ORDER, EDITABLE_PASS_FIELDS,
  getPass, listPasses, loadPassConfig, getPassOverrides, mergePassValues, savePassConfig
};
