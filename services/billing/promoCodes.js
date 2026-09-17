// =================================================================================================
// v3.0.947 -- TD-799 STAGE 1. PROMO CODES MADE IN ONE PLACE.
//
// Ian, 2026-09-17: "this is a place I will mess up if I have to do it two places." Until now a
// discount code had to be made twice -- a row in the Campaignia Promo Codes tab (which discounted
// nothing: percent_off / amount_off were labels) and, by hand, a coupon plus promotion code in the
// Stripe dashboard. This module makes the Stripe side from the admin form, so there is one place.
// Spec: claude/PROMO_CODES_SPEC.md.
//
// WHAT A CODE CAN CARRY: a % off OR a $ off (Stripe), and/or bonus tokens (ours -- Stripe has no
// such thing). At least one. Products, any combination: token packs, passes, books, subscription
// tiers. A SIGN-UP code is limited to passes and tiers and carries Stripe's first-time-customer
// restriction. Expiry is END OF THAT DAY, EASTERN. Nothing but the label and on/off can change after
// creation, because Stripe cannot change a coupon's discount, products, limits or expiry either.
//
// Pure logic lives here, with Stripe passed in, so the guard can drive every rule against a fake.
// =================================================================================================

const PRODUCT_KEYS = ['token_pack', 'pass', 'book', 'sub:silver', 'sub:gold', 'sub:platinum'];
const SIGNUP_PRODUCT_KEYS = ['pass', 'sub:silver', 'sub:gold', 'sub:platinum'];
const ENV_FOR = { token_pack: 'STRIPE_PRODUCT_TOKENS', pass: 'STRIPE_PRODUCT_PASSES', book: 'STRIPE_PRODUCT_PRINT' };
// Stripe's promotion code alphabet is letters, digits and dashes. The old form also allowed "_",
// which Stripe refuses -- so a new code must fit Stripe's alphabet even when it carries no discount,
// or a bonus-only code could never later be given one under the same name.
const CODE_RE = /^[A-Z0-9-]{2,40}$/;
const NOT_PER_USER = 1000000;   // legacy per_user_limit meaning "no per-customer limit"

function isTier(k) { return k.indexOf('sub:') === 0; }

// 'YYYY-MM-DD' -> the instant 23:59:59 on that date in America/New_York, as a Date. DST-aware by
// construction: try the two offsets New York uses and keep the one that reads back as that date
// and time in New York. Returns null for a malformed or impossible date.
function easternEndOfDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, 23 + off, 59, 59));
    const parts = {};
    fmt.formatToParts(t).forEach(function (p) { parts[p.type] = p.value; });
    if (+parts.year === y && +parts.month === mo && +parts.day === d && +parts.hour === 23 && +parts.minute === 59) return t;
  }
  return null;
}

// Validate and normalise the admin form. Returns { ok:true, v } or { ok:false, error }.
function validate(body, now) {
  body = body || {};
  now = now || new Date();
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Code is required.' };
  if (code.indexOf('_') !== -1) return { ok: false, error: 'Stripe does not allow underscores in codes. Use a dash instead.' };
  if (!CODE_RE.test(code)) return { ok: false, error: 'Code must be 2-40 characters: letters, numbers or dashes.' };

  const label = body.label ? String(body.label).trim().slice(0, 120) : null;

  const discountType = ['none', 'percent', 'amount'].indexOf(body.discount_type) !== -1 ? body.discount_type : 'none';
  let discountValue = null;   // percent: whole number 1-100; amount: CENTS
  if (discountType === 'percent') {
    const p = Number(body.discount_value);
    if (!Number.isInteger(p) || p < 1 || p > 100) return { ok: false, error: 'Percent off must be a whole number from 1 to 100.' };
    discountValue = p;
  } else if (discountType === 'amount') {
    const dollars = Number(body.discount_value);
    if (!Number.isFinite(dollars) || dollars <= 0) return { ok: false, error: 'Dollar discount must be more than $0.' };
    discountValue = Math.round(dollars * 100);
    if (discountValue < 1) return { ok: false, error: 'Dollar discount must be more than $0.' };
  }

  let bonus = parseInt(body.bonus_tokens, 10);
  if (!Number.isFinite(bonus) || bonus < 0) bonus = 0;
  if (discountType === 'none' && bonus === 0) return { ok: false, error: 'A code needs a discount, bonus tokens, or both.' };

  const isSignup = body.is_signup === true || body.is_signup === 'true';
  let products = Array.isArray(body.products) ? body.products.map(String) : [];
  products = PRODUCT_KEYS.filter(function (k) { return products.indexOf(k) !== -1; });   // known, de-duplicated, stable order
  if (!products.length) return { ok: false, error: 'Pick at least one product.' };
  if (isSignup) {
    const bad = products.filter(function (k) { return SIGNUP_PRODUCT_KEYS.indexOf(k) === -1; });
    if (bad.length) return { ok: false, error: 'A sign-up code can only apply to Passes and subscription tiers.' };
  }

  const hasTier = products.some(isTier);
  let subDuration = 'once', subMonths = null;
  if (hasTier && discountType !== 'none') {
    subDuration = ['once', 'repeating', 'forever'].indexOf(body.sub_duration) !== -1 ? body.sub_duration : 'once';
    if (subDuration === 'repeating') {
      const n = Number(body.sub_duration_months);
      if (!Number.isInteger(n) || n < 1 || n > 36) return { ok: false, error: 'Number of payments must be a whole number from 1 to 36.' };
      subMonths = n;
    }
  }

  const oncePerCustomer = body.once_per_customer === true || body.once_per_customer === 'true';

  let maxRedemptions = null;
  if (body.max_redemptions !== undefined && body.max_redemptions !== null && String(body.max_redemptions).trim() !== '') {
    const n = Number(body.max_redemptions);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'Total uses must be a whole number of 1 or more, or left blank.' };
    maxRedemptions = n;
  }

  let expiresAt = null;
  if (body.expires_on) {
    expiresAt = easternEndOfDay(body.expires_on);
    if (!expiresAt) return { ok: false, error: 'Expiry date is not a valid date.' };
    if (expiresAt.getTime() <= now.getTime()) return { ok: false, error: 'Expiry date must be today or later.' };
  }

  return { ok: true, v: {
    code: code, label: label, discountType: discountType, discountValue: discountValue, bonusTokens: bonus,
    products: products, isSignup: isSignup, subDuration: subDuration, subMonths: subMonths,
    oncePerCustomer: oncePerCustomer, maxRedemptions: maxRedemptions, expiresAt: expiresAt
  } };
}

// The old columns, filled so the EXISTING bonus-token grant in routes/tokens.js keeps working for a
// new-style code typed into Stripe's box, unchanged, until stage 3 replaces it.
function legacyFields(v) {
  if (v.bonusTokens > 0) return { action_type: 'token_grant', action_value: v.bonusTokens, per_user_limit: v.oncePerCustomer ? 1 : NOT_PER_USER };
  if (v.discountType === 'percent') return { action_type: 'percent_off', action_value: v.discountValue, per_user_limit: v.oncePerCustomer ? 1 : NOT_PER_USER };
  return { action_type: 'amount_off', action_value: Math.round(v.discountValue / 100), per_user_limit: v.oncePerCustomer ? 1 : NOT_PER_USER };
}

// Product keys -> Stripe product ids. Tiers come from STRIPE_TIER_PRICES (price -> tier), reading
// each price's product from Stripe; a tier may have more than one price. Throws with a message an
// admin can act on when anything is missing.
async function resolveProductIds(products, env, sp) {
  const ids = [];
  const add = function (id) { if (id && ids.indexOf(id) === -1) ids.push(id); };
  let tierMap = null;
  for (const k of products) {
    if (!isTier(k)) {
      const id = env[ENV_FOR[k]];
      if (!id) throw new Error(ENV_FOR[k] + ' is not set on this server, so a discount cannot be limited to that product.');
      add(id);
      continue;
    }
    if (!tierMap) { try { tierMap = JSON.parse(env.STRIPE_TIER_PRICES || '{}') || {}; } catch (e) { tierMap = {}; } }
    const tier = k.slice(4);
    const priceIds = Object.keys(tierMap).filter(function (p) { return tierMap[p] === tier; });
    if (!priceIds.length) throw new Error('No Stripe price is mapped to the ' + tier + ' tier in STRIPE_TIER_PRICES.');
    for (const pid of priceIds) {
      const price = await sp.getPrice(pid);
      const prod = price && (typeof price.product === 'object' ? (price.product && price.product.id) : price.product);
      if (!prod) throw new Error('Could not read the Stripe product for price ' + pid + '.');
      add(prod);
    }
  }
  return ids;
}

// Create the Stripe side for a validated code WITH a discount. Coupon first, then promotion code;
// if the promotion code fails, the coupon is deleted so nothing half-made is left in Stripe.
// Returns { couponId, promotionCodeId, livemode }.
async function createInStripe(v, env, sp) {
  const existing = await sp.findActivePromotionCode(v.code);
  if (existing) throw new Error('Stripe already has an active promotion code ' + v.code + '. Pick another code, or switch that one off in Stripe first.');
  const productIds = await resolveProductIds(v.products, env, sp);
  const couponParams = {
    duration: v.subDuration,
    applies_to: { products: productIds },
    name: String(v.label || v.code).slice(0, 40),
    metadata: { campaignia_code: v.code }
  };
  if (v.subDuration === 'repeating') couponParams.duration_in_months = v.subMonths;
  if (v.discountType === 'percent') couponParams.percent_off = v.discountValue;
  else { couponParams.amount_off = v.discountValue; couponParams.currency = 'usd'; }
  const coupon = await sp.createCoupon(couponParams);

  const promoParams = { promotion: { type: 'coupon', coupon: coupon.id }, code: v.code, metadata: { campaignia_code: v.code } };
  if (v.maxRedemptions) promoParams.max_redemptions = v.maxRedemptions;
  if (v.expiresAt) promoParams.expires_at = Math.floor(v.expiresAt.getTime() / 1000);
  if (v.isSignup) promoParams.restrictions = { first_time_transaction: true };
  let promo;
  try {
    promo = await sp.createPromotionCode(promoParams);
  } catch (e) {
    try { await sp.deleteCoupon(coupon.id); } catch (_) { /* reported below either way */ }
    throw e;
  }
  return { couponId: coupon.id, promotionCodeId: promo.id, livemode: !!(promo.livemode || coupon.livemode) };
}

module.exports = { PRODUCT_KEYS, SIGNUP_PRODUCT_KEYS, easternEndOfDay, validate, legacyFields, resolveProductIds, createInStripe, NOT_PER_USER };
