// Authoritative token-pack catalog (server-side source of truth). The client
// renders its own copy for display, but checkout NEVER trusts client prices --
// the amount charged and the tokens granted are always read from here by id.
// v3.5.88 -- Ian, 2026-11-12: the tokens and the price of each pack are set on Dashboard > Tiers and Passes.
// CODE DEFAULTS, SHADOWED BY app_settings.pack_config (loaded at boot), the same shape as passes.js. The
// page's TOKEN_PACKS is only a fallback: the Tokens window reads GET /api/tokens/packs. A checkout freezes
// the tokens it quoted into Stripe's metadata, so a change made mid-checkout never changes what was bought.
const PACKS = {
  small:  { id: 'small',  name: 'Small',  tokens: 85,   price_cents: 1500 },
  medium: { id: 'medium', name: 'Medium', tokens: 250,  price_cents: 4000 },
  large:  { id: 'large',  name: 'Large',  tokens: 650,  price_cents: 10000 },
  huge:   { id: 'huge',   name: 'Huge',   tokens: 1700, price_cents: 25000 }
};

const PACK_ORDER = ['small', 'medium', 'large', 'huge'];
const EDITABLE_PACK_FIELDS = ['tokens', 'price_cents'];
// The least each may be. Below it the field falls back to the code default: a pack of no tokens or a price
// under Stripe's 50-cent minimum is a typo, not a product.
const PACK_MIN = { tokens: 1, price_cents: 50 };
let PACK_OVERRIDES = {};

async function loadPackConfig() {
  const { getDb } = require('../../database/db');
  try {
    const db = await getDb();
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'pack_config'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') PACK_OVERRIDES = parsed;
    }
  } catch (e) {
    console.error('loadPackConfig failed (using code defaults):', e.message);
  }
  return PACK_OVERRIDES;
}

function getPack(id) {
  if (!id || !Object.prototype.hasOwnProperty.call(PACKS, id)) return null;
  const ov = PACK_OVERRIDES[id];
  return ov ? Object.assign({}, PACKS[id], ov) : PACKS[id];
}

function listPacks() {
  return PACK_ORDER.map(function (k) { return getPack(k); }).filter(Boolean);
}

// Blank, unreadable or under the minimum deletes the override, so the code default stands.
function mergePackValues(id, values) {
  const clean = Object.assign({}, PACK_OVERRIDES[id] || {});
  EDITABLE_PACK_FIELDS.forEach(function (f) {
    if (!values || !Object.prototype.hasOwnProperty.call(values, f)) return;
    const raw = values[f];
    if (raw === null || raw === '' || raw === undefined) { delete clean[f]; return; }
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < PACK_MIN[f]) { delete clean[f]; return; }
    clean[f] = n;
  });
  return clean;
}

async function savePackConfig(id, values) {
  if (!Object.prototype.hasOwnProperty.call(PACKS, id)) throw new Error('Unknown pack: ' + id);
  const next = Object.assign({}, PACK_OVERRIDES);
  next[id] = mergePackValues(id, values);
  const { getDb } = require('../../database/db');
  const db = await getDb();
  const json = JSON.stringify(next);
  const existing = await db.prepare("SELECT setting_key FROM app_settings WHERE setting_key = 'pack_config'").get();
  if (existing) await db.prepare("UPDATE app_settings SET value = ? WHERE setting_key = 'pack_config'").run(json);
  else await db.prepare("INSERT INTO app_settings (setting_key, value) VALUES ('pack_config', ?)").run(json);
  PACK_OVERRIDES = next;   // only once it is stored, so a failed write sells nothing that is not saved
  return getPack(id);
}

module.exports = { PACKS, PACK_ORDER, EDITABLE_PACK_FIELDS, getPack, listPacks, loadPackConfig, mergePackValues, savePackConfig };
