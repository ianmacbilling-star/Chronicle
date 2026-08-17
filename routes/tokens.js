// ============================================================
// TOKEN SYSTEM — core logic + endpoints (Phase 1)
// ============================================================
// Balance is derived by summing token_ledger (single source of truth).
// Two buckets: 'utlt' (monthly grant, expires) and 'cot' (carry-over,
// never expires). Spend order: utlt first, then cot.
//
// Per-model cost lives in app_settings as token_cost:<model>, default 1.
// Stripe is NOT wired here yet — creditTokens is the seam Stripe will
// call later. For now an admin endpoint credits tokens for testing.

const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { friendlyError } = require('../middleware/friendlyErrors');
const { getTier, saveTierConfig, canPurchaseTokens } = require('../middleware/tiers');
const { getPack, listPacks } = require('../services/billing/packs');
const stripeProvider = require('../services/billing/stripeProvider');
const { logDebug } = require('./debug');
const { isTesterEmail } = require('../middleware/auth');   // v3.0.672 -- TD-475

// Pull the diagnostic fields Stripe hangs off a thrown error so the debug log
// captures WHY a billing call failed (bad price vs. bad customer, mode mismatch,
// archived/one-time price, etc.). Never surfaced to the user -- logs only. Safe on
// non-Stripe errors too. `extra` folds in call-site context (tier, priceId, ...).
function stripeErrDetail(e, extra) {
  const d = {
    message: (e && e.message) || String(e),
    type: (e && e.type) || '',
    code: (e && e.code) || '',
    param: (e && e.param) || '',
    statusCode: (e && (e.statusCode || e.status)) || '',
    requestId: (e && e.requestId) || '',
    docUrl: (e && e.doc_url) || ''
  };
  if (extra) { for (const k in extra) { d[k] = extra[k]; } }
  return d;
}

// ------------------------------------------------------------
// Cost lookup — per model, defaults to 1 if unset.
// ------------------------------------------------------------
async function getTokenCost(model) {
  try {
    const db = await getDb();
    const key = 'token_cost:' + (model || 'nano2');
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get(key);
    const cost = row && row.value != null ? parseInt(row.value, 10) : 1;
    return Number.isFinite(cost) && cost >= 0 ? cost : 1;
  } catch (e) {
    return 1;
  }
}

// ------------------------------------------------------------
// Balance — sum the ledger, per bucket and total.
// ------------------------------------------------------------
async function getBalance(userId) {
  const db = await getDb();
  const rows = await db.prepare(
    "SELECT bucket, COALESCE(SUM(amount),0) AS bal FROM token_ledger WHERE user_id = ? GROUP BY bucket"
  ).all(userId);
  let utlt = 0, cot = 0;
  for (const r of rows) {
    if (r.bucket === 'utlt') utlt = parseInt(r.bal, 10) || 0;
    else if (r.bucket === 'cot') cot = parseInt(r.bal, 10) || 0;
  }
  return { utlt, cot, total: utlt + cot };
}

// ------------------------------------------------------------
// UTOLT monthly grant + expiry (use-it-or-lose-it).
// currentCycleKey is the calendar month for now; TODO(stripe): swap to
// the user's billing-cycle window once subscriptions land.
// ------------------------------------------------------------
function currentCycleKey() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

// Grants this cycle's utlt allotment for the user's ACCOUNT tier exactly once
// per cycle. Before granting, any leftover utlt from a prior cycle is expired
// (zeroed) -- that is the "lose it" half. Idempotent: a marker ledger row
// (event_type 'monthly_grant', source=cycle) short-circuits repeat calls to a
// single SELECT. The cot (carry-over) bucket is never touched here.
// NOTE: not transaction-locked; a rare double-call at a cycle boundary could
// double-grant once. Acceptable for the stub; tighten with a unique index later.
async function ensureMonthlyGrant(userId, cycleKey) {
  if (!userId) return { skipped: true };
  const db = await getDb();
  // cycleKey lets the caller key the grant on the SUBSCRIPTION billing period (the
  // Stripe invoice id) instead of the calendar month, so exactly one grant fires per
  // renewal. Falls back to the calendar month when no key is supplied.
  const cycle = cycleKey || currentCycleKey();
  const got = await db.prepare(
    "SELECT 1 AS x FROM token_ledger WHERE user_id = ? AND event_type = 'monthly_grant' AND source = ? LIMIT 1"
  ).get(userId, cycle);
  if (got) return { skipped: true, cycle: cycle };
  // Account tier's monthly allotments (own tier, not effective campaign tier).
  // UTOLT is use-it-or-lose-it (expires each cycle); CO carries over forever.
  let allotUtlt = 0, allotCot = 0;
  try {
    const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(userId);
    const tier = getTier((u && u.tier) || 'copper');
    allotUtlt = parseInt(tier && tier.monthly_utlt, 10);
    allotCot = parseInt(tier && tier.monthly_cot, 10);
    if (!Number.isFinite(allotUtlt) || allotUtlt < 0) allotUtlt = 0;
    if (!Number.isFinite(allotCot) || allotCot < 0) allotCot = 0;
  } catch (e) { allotUtlt = 0; allotCot = 0; }
  // Expire any leftover utlt from prior cycles (the "lose it" half).
  const bal = await getBalance(userId);
  if (bal.utlt > 0) {
    await db.prepare(
      "INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, ?, 'utlt', 'utlt_expire', ?)"
    ).run(userId, -bal.utlt, cycle);
  }
  // Grant this cycle's utlt (a 0-amount row still serves as the once-per-cycle marker).
  await db.prepare(
    "INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, ?, 'utlt', 'monthly_grant', ?)"
  ).run(userId, allotUtlt, cycle);
  // Grant this cycle's cot (carry-over; accumulates, never expires).
  if (allotCot > 0) {
    await db.prepare(
      "INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, ?, 'cot', 'monthly_cot_grant', ?)"
    ).run(userId, allotCot, cycle);
  }
  return { skipped: false, cycle: cycle, utlt: allotUtlt, cot: allotCot };
}

async function canAfford(userId, cost) {
  const { total } = await getBalance(userId);
  return total >= cost;
}

// Session-reserve gate for CHARACTER generation. A tier may fence off
// `session_reserve` tokens that ONLY session rendering may spend, so a trial
// user can't burn everything on character art and never reach a session.
// blocked = a character spend of `cost` would drop the total below the reserve.
async function characterReserveStatus(userId, cost) {
  const db = await getDb();
  const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(userId);
  const tier = getTier((u && u.tier) || 'copper');
  const reserve = Number(tier.session_reserve) > 0 ? Number(tier.session_reserve) : 0;
  const { total } = await getBalance(userId);
  if (!reserve) return { blocked: false, reserve: 0, balance: total };
  return { blocked: (total - cost) < reserve, reserve: reserve, balance: total };
}

// ------------------------------------------------------------
// Credit tokens. bucket defaults to 'cot' (purchases, bonuses, carry-
// over all land in cot). Monthly grants pass bucket='utlt'.
// Writes a single positive ledger row. This is the seam Stripe calls.
// ------------------------------------------------------------
async function creditTokens(userId, amount, opts = {}) {
  if (!amount || amount <= 0) throw new Error('Credit amount must be positive');
  const db = await getDb();
  const bucket = opts.bucket || 'cot';
  const eventType = opts.event_type || 'manual_credit';
  await db.prepare(
    `INSERT INTO token_ledger
       (user_id, amount, bucket, event_type, source, triggered_by_user_id, related_campaign_id, related_purchase_id, stripe_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, amount, bucket, eventType,
    opts.source || null,
    opts.triggered_by_user_id || null,
    opts.related_campaign_id || null,
    opts.related_purchase_id || null,
    opts.stripe_event_id || null
  );
  return getBalance(userId);
}

// ------------------------------------------------------------
// Spend tokens. Debits utlt first, then cot. Writes one negative
// ledger row per bucket touched. Throws if insufficient balance —
// callers must check canAfford first for batch all-or-nothing.
// ------------------------------------------------------------
async function spendTokens(userId, amount, opts = {}) {
  if (!amount || amount <= 0) throw new Error('Spend amount must be positive');
  const db = await getDb();
  const bal = await getBalance(userId);
  if (bal.total < amount) {
    const err = new Error('Insufficient tokens');
    err.code = 'INSUFFICIENT_TOKENS';
    err.balance = bal;
    throw err;
  }
  const eventType = opts.event_type || 'generation_spend';
  const fromUtlt = Math.min(bal.utlt, amount);
  const fromCot = amount - fromUtlt;

  if (fromUtlt > 0) {
    await db.prepare(
      `INSERT INTO token_ledger (user_id, amount, bucket, event_type, source, related_campaign_id)
       VALUES (?, ?, 'utlt', ?, ?, ?)`
    ).run(userId, -fromUtlt, eventType, opts.source || null, opts.related_campaign_id || null);
  }
  if (fromCot > 0) {
    await db.prepare(
      `INSERT INTO token_ledger (user_id, amount, bucket, event_type, source, related_campaign_id)
       VALUES (?, ?, 'cot', ?, ?, ?)`
    ).run(userId, -fromCot, eventType, opts.source || null, opts.related_campaign_id || null);
  }
  return getBalance(userId);
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------
function requireSession(req, res) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

// v3.0.672 -- TD-475. The tester twin of the local requireAdmin below. Local because this file
// already has its own boolean-returning gate rather than middleware, and one file with two
// calling conventions for the same question is how a gate gets called and its answer ignored.
async function requireAdminOrTesterLocal(req, res) {
  const db = await getDb();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (user && (adminEmails.includes(user.email) || isTesterEmail(user.email))) return true;
  res.status(403).json({ error: 'Admin access required' });
  return false;
}

async function requireAdmin(req, res) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
  const db = await getDb();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !adminEmails.includes(user.email)) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// GET /api/tokens/balance — current user's balance
router.get('/balance', async function(req, res) {
  if (!requireSession(req, res)) return;
  try {
    const bal = await getBalance(req.session.userId);
    const db = await getDb();
    const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tier = getTier((u && u.tier) || 'copper');
    const reserve = Number(tier.session_reserve) > 0 ? Number(tier.session_reserve) : 0;
    const spendable = reserve ? Math.max(0, bal.total - reserve) : bal.total;
    const reserveLow = reserve > 0 && spendable <= reserve;
    const canBuy = await canPurchaseTokens(req.session.userId);   // TF-03 UI hint (mirrors the /checkout gate)
    res.json(Object.assign({}, bal, { reserve: reserve, spendable: spendable, reserveLow: reserveLow, can_purchase_tokens: canBuy }));
  } catch (e) {
    res.status(500).json({ error: 'Could not load balance' });
  }
});

// GET /api/tokens/ledger — current user's recent transactions
router.get('/ledger', async function(req, res) {
  if (!requireSession(req, res)) return;
  try {
    const db = await getDb();
    const rows = await db.prepare(
      "SELECT amount, bucket, event_type, source, created_at FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.session.userId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load ledger' });
  }
});

// POST /api/tokens/dev-credit — TESTING ONLY. Lets the signed-in user top up
// THEIR OWN balance (no admin needed) while we're testing before Stripe.
// Session-gated and self-only (ignores any user_id in the body). REMOVE when
// Stripe billing goes live.
router.post('/dev-credit', async function(req, res) {
  if (!requireSession(req, res)) return;
  // v3.0.672 -- TD-475. ADMIN OR TESTER. Self-only: this route credits req.session.userId and
  // takes no target from the body. /admin/credit and /admin/set-balance, which DO take a
  // user_id, are deliberately left admin-only.
  if (!(await requireAdminOrTesterLocal(req, res))) return;
  const amt = parseInt((req.body || {}).amount, 10);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Provide a positive amount' });
  }
  if (amt > 100000) {
    return res.status(400).json({ error: 'Amount too large (max 100000)' });
  }
  try {
    const bal = await creditTokens(req.session.userId, amt, {
      bucket: 'cot',
      event_type: 'manual_credit',
      source: 'self_test'
    });
    res.json({ ok: true, balance: bal });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e, 'The request could not be completed. Please try again.') });
  }
});

// POST /api/tokens/dev-grant-monthly -- TESTING. Manually grant THIS user's
// current-tier monthly allotment (UTOLT + CO). The monthly grant no longer
// fires automatically on page load; this button is the manual trigger while
// testing. Session-gated, self only. REMOVE once a production grant trigger
// (cron or login hook) is decided.
router.post('/dev-grant-monthly', async function(req, res) {
  if (!requireSession(req, res)) return;
  // v3.0.672 -- TD-475. ADMIN OR TESTER. Self-only: this route credits req.session.userId and
  // takes no target from the body. /admin/credit and /admin/set-balance, which DO take a
  // user_id, are deliberately left admin-only.
  if (!(await requireAdminOrTesterLocal(req, res))) return;
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tierName = (u && u.tier) || 'copper';
    const tier = getTier(tierName);
    let gUtlt = parseInt(tier && tier.monthly_utlt, 10);
    let gCot = parseInt(tier && tier.monthly_cot, 10);
    if (!Number.isFinite(gUtlt) || gUtlt < 0) gUtlt = 0;
    if (!Number.isFinite(gCot) || gCot < 0) gCot = 0;
    // Reset to a fresh state first so repeated clicks reproduce a brand-new
    // account at this tier rather than stacking grants.
    await db.prepare('DELETE FROM token_ledger WHERE user_id = ?').run(req.session.userId);
    await db.prepare("INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, 0, 'cot', 'admin_reset', ?)").run(req.session.userId, 'dev_grant_monthly_reset');
    if (gUtlt > 0) await creditTokens(req.session.userId, gUtlt, { bucket: 'utlt', event_type: 'monthly_grant', source: 'manual_test' });
    if (gCot > 0) await creditTokens(req.session.userId, gCot, { bucket: 'cot', event_type: 'monthly_cot_grant', source: 'manual_test' });
    const bal = await getBalance(req.session.userId);
    res.json({ ok: true, tier: tierName, granted: { utlt: gUtlt, cot: gCot }, balance: bal });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e, 'The request could not be completed. Please try again.') });
  }
});

// POST /api/tokens/dev-set-balance -- TESTING. Self only. Wipes the caller's
// ledger and sets EXACT cot + utlt balances, and (optionally) the session
// reserve on the caller's CURRENT tier (tier config is global). Lets us dial
// in precise trial states. REMOVE with the other testing controls before prod.
router.post('/dev-set-balance', async function(req, res) {
  if (!requireSession(req, res)) return;
  // v3.0.672 -- TD-475. ADMIN OR TESTER. Self-only: this route credits req.session.userId and
  // takes no target from the body. /admin/credit and /admin/set-balance, which DO take a
  // user_id, are deliberately left admin-only.
  if (!(await requireAdminOrTesterLocal(req, res))) return;
  const body = req.body || {};
  const cot = parseInt(body.cot, 10);
  const utlt = parseInt(body.utlt, 10);
  if (!Number.isFinite(cot) || cot < 0 || !Number.isFinite(utlt) || utlt < 0) {
    return res.status(400).json({ error: 'Provide non-negative cot and utlt amounts' });
  }
  if (cot > 100000 || utlt > 100000) {
    return res.status(400).json({ error: 'Amount too large (max 100000)' });
  }
  try {
    const db = await getDb();
    const uid = req.session.userId;
    await db.prepare('DELETE FROM token_ledger WHERE user_id = ?').run(uid);
    await db.prepare("INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, 0, 'cot', 'admin_reset', ?)").run(uid, 'dev_set_balance');
    if (utlt > 0) await creditTokens(uid, utlt, { bucket: 'utlt', event_type: 'manual_credit', source: 'dev_set_balance' });
    if (cot > 0) await creditTokens(uid, cot, { bucket: 'cot', event_type: 'manual_credit', source: 'dev_set_balance' });
    let reserveSet = null;
    if (body.reserve !== undefined && body.reserve !== null && body.reserve !== '') {
      const rv = parseInt(body.reserve, 10);
      if (Number.isFinite(rv) && rv >= 0) {
        const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(uid);
        const tierName = (u && u.tier) || 'copper';
        await saveTierConfig(tierName, { session_reserve: rv });
        reserveSet = { tier: tierName, session_reserve: rv };
      }
    }
    const bal = await getBalance(uid);
    res.json({ ok: true, balance: bal, reserve: reserveSet });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e, 'The request could not be completed. Please try again.') });
  }
});

// POST /api/tokens/admin/credit — admin-only manual credit (testing)
// body: { user_id, amount, bucket?, source? }
router.post('/admin/credit', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!(await requireAdmin(req, res))) return;
  const { user_id, amount, bucket, source } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!user_id || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Provide user_id and a positive amount' });
  }
  if (bucket && bucket !== 'utlt' && bucket !== 'cot') {
    return res.status(400).json({ error: "bucket must be 'utlt' or 'cot'" });
  }
  try {
    const bal = await creditTokens(user_id, amt, {
      bucket: bucket || 'cot',
      event_type: 'manual_credit',
      source: source || 'admin'
    });
    res.json({ ok: true, balance: bal });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e, 'The request could not be completed. Please try again.') });
  }
});

// POST /api/tokens/admin/set-balance — admin-only TESTING helper.
// Wipes the user's ledger and credits a fresh balance in COT. Use ONLY
// in staging for exercising edge cases (exactly N tokens, zero, etc.).
// Writes a marker row in the ledger so the wipe is auditable.
// body: { user_id, amount }   amount >= 0
router.post('/admin/set-balance', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!(await requireAdmin(req, res))) return;
  const { user_id, amount } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!user_id || !Number.isFinite(amt) || amt < 0) {
    return res.status(400).json({ error: 'Provide user_id and a non-negative amount' });
  }
  try {
    const db = await getDb();
    // Wipe existing ledger rows for this user.
    await db.prepare('DELETE FROM token_ledger WHERE user_id = ?').run(user_id);
    // Audit marker: a zero-amount note documenting the wipe.
    await db.prepare(
      "INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, 0, 'cot', 'admin_reset', ?)"
    ).run(user_id, 'set_balance to ' + amt);
    // Credit the requested amount (skip if 0 — the marker is enough).
    let bal;
    if (amt > 0) {
      bal = await creditTokens(user_id, amt, {
        bucket: 'cot',
        event_type: 'manual_credit',
        source: 'admin_set_balance'
      });
    } else {
      bal = await getBalance(user_id);
    }
    res.json({ ok: true, balance: bal });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e, 'The request could not be completed. Please try again.') });
  }
});

// ------------------------------------------------------------
// BILLING -- Stripe token-pack purchases (stub; live at go-live).
// ------------------------------------------------------------

// GET /api/tokens/packs -- server-authoritative catalog (for display/sync).
router.get('/packs', function(req, res) {
  res.json(listPacks());
});

// POST /api/tokens/checkout -- begin a Stripe Checkout for a token pack.
// body: { packId }. Returns { url } to redirect to. Before the LLC/keys exist,
// returns 503 { error:'billing_unconfigured' } so the UI shows "coming soon".
router.post('/checkout', async function(req, res) {
  if (!requireSession(req, res)) return;
  const pack = getPack((req.body || {}).packId);
  if (!pack) return res.status(400).json({ error: 'Unknown pack' });
  // TF-03: only subscribers (or Copper members under a paid SM) may buy token
  // packs. Authoritative gate -- the UI mirrors this but cannot be trusted.
  if (!(await canPurchaseTokens(req.session.userId))) {
    return res.status(403).json({ error: 'Buying token packs requires a paid plan - either your own, or being part of a campaign run by someone on a paid plan. Upgrade to Silver, Gold, or Platinum to purchase tokens.', code: 'TIER_REQUIRED' });
  }
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  try {
    const db = await getDb();
    // last_active_campaign_id drives the DM 10% bonus attribution.
    let attributed = null;
    let buyerEmail = null;
    try {
      const u = await db.prepare('SELECT last_active_campaign_id, email FROM users WHERE id = ?').get(req.session.userId);
      attributed = (u && u.last_active_campaign_id != null) ? u.last_active_campaign_id : null;
      buyerEmail = (u && u.email) || null;
    } catch (e) { attributed = null; }
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createCheckoutSession({
      pack: pack,
      userId: req.session.userId,
      attributedCampaignId: attributed,
      customerEmail: buyerEmail,
      successUrl: base + '/app.html?purchase=success',
      cancelUrl: base + '/app.html?purchase=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    console.error('checkout error:', e && e.message);
    await logDebug(req.session.userId, {
      level: 'error', source: 'stripe',
      page: '/api/tokens/checkout', fn: 'createCheckoutSession',
      message: 'Stripe token-pack checkout failed: ' + ((e && e.message) || 'unknown'),
      detail: stripeErrDetail(e, { packId: (pack && pack.id) || '', tokens: (pack && pack.tokens) || '' })
    });
    res.status(500).json({ error: friendlyError(e, "We couldn't start your token purchase -- this looks like a billing setup issue on our end, not a problem with your card. Please try again shortly, and if it keeps happening, contact support.") });
  }
});

// POST /api/tokens/subscribe -- start a hosted Checkout for a paid-tier subscription.
// body: { tier } (silver|gold|platinum). The recurring Price is resolved SERVER-side
// from STRIPE_TIER_PRICES; the client never supplies a price. Returns { url }.
router.post('/subscribe', async function(req, res) {
  if (!requireSession(req, res)) return;
  const tier = String((req.body || {}).tier || '').toLowerCase();
  if (tier !== 'silver' && tier !== 'gold' && tier !== 'platinum') {
    return res.status(400).json({ error: 'Unknown tier' });
  }
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  const priceId = stripeProvider.priceForTier(tier);
  if (!priceId) return res.status(503).json({ error: 'tier_price_unconfigured' });
  let customerId = null;
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT email, stripe_customer_id FROM users WHERE id = ?').get(req.session.userId);
    customerId = (u && u.stripe_customer_id) || null;
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createSubscriptionCheckout({
      priceId: priceId,
      userId: req.session.userId,
      customerId: customerId,
      customerEmail: (u && u.email) || null,
      successUrl: base + '/app.html?subscribe=success',
      cancelUrl: base + '/app.html?subscribe=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    console.error('subscribe error:', e && e.message);
    await logDebug(req.session.userId, {
      level: 'error', source: 'stripe',
      page: '/api/tokens/subscribe', fn: 'createSubscriptionCheckout',
      message: 'Stripe subscription checkout failed: ' + ((e && e.message) || 'unknown'),
      detail: stripeErrDetail(e, { tier: tier, priceId: priceId, hadCustomerId: !!customerId })
    });
    res.status(500).json({ error: friendlyError(e, "We couldn't start your subscription -- this looks like a billing setup issue on our end, not a problem with your card. Please try again shortly, and if it keeps happening, contact support.") });
  }
});

// POST /api/tokens/change-plan -- switch an EXISTING subscription to another paid
// tier IN PLACE (proration on the next invoice). Users without a live subscription
// use /subscribe (new checkout) instead. The customer.subscription.updated webhook
// reconciles the tier afterward.
router.post('/change-plan', async function(req, res) {
  if (!requireSession(req, res)) return;
  const tier = String((req.body || {}).tier || '').toLowerCase();
  if (tier !== 'silver' && tier !== 'gold' && tier !== 'platinum') {
    return res.status(400).json({ error: 'Unknown tier' });
  }
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  const priceId = stripeProvider.priceForTier(tier);
  if (!priceId) return res.status(503).json({ error: 'tier_price_unconfigured' });
  let customerId = null;
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT email, stripe_customer_id, stripe_subscription_id FROM users WHERE id = ?').get(req.session.userId);
    customerId = (u && u.stripe_customer_id) || null;

    // Is there a LIVE subscription to modify in place? Stripe is the source of
    // truth: the stored sub can be stale (e.g. canceled by a prior suspend) while
    // our DB hasn't caught up. A canceled sub can't be re-priced.
    let live = false;
    if (u && u.stripe_subscription_id) {
      try {
        const sub = await stripeProvider.getSubscription(u.stripe_subscription_id);
        live = !!(sub && ['active','trialing','past_due','unpaid'].indexOf(sub.status) !== -1);
      } catch (e) { live = false; }
    }

    if (live) {
      await stripeProvider.changeSubscriptionPrice(u.stripe_subscription_id, priceId);
      return res.json({ success: true });
    }

    // No live subscription -> start a fresh subscription checkout for this tier.
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createSubscriptionCheckout({
      priceId: priceId,
      userId: req.session.userId,
      customerId: (u && u.stripe_customer_id) || null,
      customerEmail: (u && u.email) || null,
      successUrl: base + '/app.html?subscribe=success',
      cancelUrl: base + '/app.html?subscribe=cancel'
    });
    return res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    console.error('change-plan error:', e && e.message);
    await logDebug(req.session.userId, {
      level: 'error', source: 'stripe',
      page: '/api/tokens/change-plan', fn: 'changeSubscriptionPrice/createSubscriptionCheckout',
      message: 'Stripe plan change failed: ' + ((e && e.message) || 'unknown'),
      detail: stripeErrDetail(e, { tier: tier, priceId: priceId, hadCustomerId: !!customerId })
    });
    res.status(500).json({ error: friendlyError(e, "We couldn't update your subscription -- this looks like a billing setup issue on our end, not a problem with your card. Please try again shortly, and if it keeps happening, contact support.") });
  }
});

// POST /api/tokens/portal -- open the Stripe Billing Portal (hosted manage page:
// upgrade / downgrade / cancel / update card). Requires an existing Stripe customer.
// Whatever the user changes there returns to us as a customer.subscription.* webhook.
router.post('/portal', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.session.userId);
    if (!u || !u.stripe_customer_id) {
      return res.status(400).json({ error: 'no_customer' });
    }
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createBillingPortalSession({
      customerId: u.stripe_customer_id,
      returnUrl: base + '/app.html?portal=return'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    res.status(500).json({ error: 'Could not open billing portal' });
  }
});

// POST /api/tokens/sync-subscription -- pull the user's live subscription straight
// from Stripe and reconcile it onto the user NOW (tier / status / current_period_end /
// cancel_at_period_end) without waiting for the async webhook. Called right after a
// Billing Portal return so the account page reflects a just-made change (e.g. a pending
// cancel) immediately. Reuses syncSubscriptionToUser, so the rules stay in one place.
// No-ops cleanly if the user has no subscription on file.
router.post('/sync-subscription', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT stripe_subscription_id FROM users WHERE id = ?').get(req.session.userId);
    if (!u || !u.stripe_subscription_id) {
      return res.json({ ok: true, synced: false });
    }
    const sub = await stripeProvider.getSubscription(u.stripe_subscription_id);
    const result = await syncSubscriptionToUser(sub);
    let itemPeriodEnd = null;
    try { itemPeriodEnd = sub.items.data[0].current_period_end || null; } catch (e) {}
    const debug = {
      lookedUpSubId: u.stripe_subscription_id,
      stripe_status: sub.status,
      stripe_cancel_at_period_end: sub.cancel_at_period_end,
      stripe_cancel_at: sub.cancel_at || null,
      stripe_current_period_end_top: sub.current_period_end || null,
      stripe_current_period_end_item: itemPeriodEnd,
      wrote: result
    };
    try {
      await logDebug(req.session.userId, {
        level: 'info', source: 'billing', page: 'Account / billing',
        fn: 'POST /sync-subscription',
        message: 'Reconciled subscription from Stripe (status ' + (sub.status || '?') + ', pending-cancel ' + ((result && result.cancelAtPeriodEnd) ? 'yes' : 'no') + ')',
        detail: debug
      });
    } catch (_le) {}
    res.json({ ok: true, synced: !(result && result.skipped), debug: debug });
  } catch (e) {
    res.status(500).json({ error: 'Could not sync subscription' });
  }
});

// Promo redemption on a completed purchase: read the applied code, record it (the
// attribution/metrics spine), and -- for token_grant codes -- credit CO tokens.
// Idempotent per (user, session): a prior row means this checkout was already
// processed, so Stripe retries never double-grant. Fully guarded; never blocks
// fulfillment (the caller wraps it in try/catch too).
async function recordAndGrantPromo(session, eventId) {
  if (!session || !session.id) return;
  const db = await getDb();
  const uid = parseInt(session.client_reference_id || (session.metadata && session.metadata.user_id), 10);
  if (!Number.isFinite(uid)) return;
  const code = await stripeProvider.getSessionPromoCode(session);
  if (!code) return;
  const norm = String(code).trim().toUpperCase();
  const existing = await db.prepare('SELECT id FROM promo_redemptions WHERE user_id = ? AND stripe_session_id = ?').get(uid, session.id);
  if (existing) return;
  const promo = await db.prepare('SELECT id, action_type, action_value, active, expires_at, per_user_limit FROM promo_codes WHERE code = ?').get(norm);
  let grant = 0;
  if (promo && promo.active && (!promo.expires_at || new Date(promo.expires_at) >= new Date()) && promo.action_type === 'token_grant' && promo.action_value > 0) {
    grant = promo.action_value;
    // Per-user limit: how many times THIS user may receive this code's grant across
    // all their purchases. Count prior redemptions of this code by this user; at/over
    // the limit we still log the redemption (attribution) but skip the token grant.
    const _limit = (promo.per_user_limit && promo.per_user_limit > 0) ? promo.per_user_limit : 1;
    const _prior = await db.prepare('SELECT COUNT(*)::int AS n FROM promo_redemptions WHERE user_id = ? AND promo_code_id = ?').get(uid, promo.id);
    if (_prior && Number(_prior.n) >= _limit) grant = 0;
  }
  // Insert the redemption row FIRST. The unique (user_id, stripe_session_id) index
  // makes a concurrent retry throw here, so only the winning call proceeds to grant.
  try {
    await db.prepare(
      'INSERT INTO promo_redemptions (promo_code_id, code, user_id, context, applied, stripe_session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(promo ? promo.id : null, norm, uid, 'purchase', grant ? JSON.stringify({ granted_tokens: grant }) : null, session.id);
  } catch (e) {
    return; // duplicate from a concurrent retry -- do not grant twice
  }
  if (grant > 0) {
    try {
      await creditTokens(uid, grant, { bucket: 'cot', event_type: 'promo_grant', source: 'promo:' + norm, stripe_event_id: eventId });
    } catch (e) { console.error('promo token grant failed:', e.message); }
  }
  if (promo) {
    try { await db.prepare('UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE id = ?').run(promo.id); } catch (e) {}
  }
}

// Stripe webhook handler. Mounted in server.js BEFORE the API rate limiter and
// WITHOUT session auth (Stripe authenticates via signature). Verifies against
// req.rawBody (captured by express.json's verify hook). Idempotent per checkout
// session id. Exported, not attached to the session-gated router.
async function stripeWebhook(req, res) {
  if (!stripeProvider.isConfigured()) return res.status(503).send('billing_unconfigured');
  let event;
  try {
    event = stripeProvider.constructEvent(req.rawBody, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(400).send('Webhook signature verification failed');
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s && s.mode === 'subscription') {
        // Tier subscription started: link the user; tier/status follow via
        // customer.subscription.created. (Token packs are mode:payment, below.)
        await linkSubscriptionCheckout(s);
      } else if (s && s.metadata && s.metadata.kind === 'print_order') {
        // Paid book order: submit the job to the print vendor now (payment-first).
        await require('./print').fulfillPrintOrder(s, event.id);
      } else {
        await fulfillCheckout(s, event.id);
      }
      try { await recordAndGrantPromo(s, event.id); } catch (promoErr) { console.error('promo grant failed (non-fatal):', promoErr.message); }
    } else if (event.type === 'invoice.payment_failed') {
      // v3.0.669 -- TD-473. WRITE DOWN THAT A CARD FAILED, at the moment it failed.
      // Fires on EVERY attempt, not once per subscription, which is the point: attempt 3 of 4 with
      // a next_attempt date is a different support conversation from attempt 1.
      await recordPaymentFailure(event.data.object, event.id);
    } else if (event.type === 'checkout.session.expired') {
      // v3.0.669 -- TD-473. THE ONLY RELIABLE SIGNAL THAT A BOOK CHECKOUT WAS ABANDONED.
      // ?order=cancel fires only if the reader clicks back from Stripe; closing the tab, switching
      // apps or simply walking away produces nothing at all. This one always arrives.
      await markCheckoutExpired(event.data.object);
    } else if (event.type === 'invoice.paid') {
      // Subscription renewal (and first charge): disseminate the monthly tokens.
      await fulfillSubscriptionInvoice(event.data.object, event.id);
    } else if (event.type === 'customer.subscription.created') {
      await syncSubscriptionToUser(event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      // Proration FIRST (reads previous_attributes; falls back to the still-current
      // users.tier as the OLD tier), THEN sync the new tier/status onto the user.
      await fulfillSubscriptionUpdate(event.data.object, event.data.previous_attributes || {}, event.id);
      await syncSubscriptionToUser(event.data.object);
    } else if (event.type === 'customer.subscription.deleted' ||
               event.type === 'customer.subscription.paused' ||
               event.type === 'customer.subscription.resumed') {
      await syncSubscriptionToUser(event.data.object);
    }
    res.json({ received: true });
  } catch (e) {
    res.status(500).send('Webhook handler error');
  }
}

// Grant tokens for a completed checkout. Idempotent: one token_purchases row per
// Stripe session id. Re-derives tokens from the server pack (never trusts the
// session for amounts). Credits the buyer's cot bucket, then a 10% cot DM bonus
// to the attributed campaign's owner (if it isn't the buyer).
async function fulfillCheckout(session, eventId) {
  const db = await getDb();
  const sessionId = session.id;
  const existing = await db.prepare('SELECT id FROM token_purchases WHERE stripe_session_id = ?').get(sessionId);
  if (existing) return; // already fulfilled
  const md = session.metadata || {};
  const userId = parseInt(md.user_id, 10);
  const pack = getPack(md.pack_id);
  if (!userId || !pack) return;
  const attributed = md.attributed_campaign_id ? parseInt(md.attributed_campaign_id, 10) : null;
  const paid = (session.amount_total != null) ? session.amount_total : pack.price_cents;
  const insRes = await db.prepare(
    `INSERT INTO token_purchases
       (user_id, pack_tier, price_paid_cents, tokens_granted, stripe_session_id, stripe_payment_id, attributed_campaign_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, pack.id, paid, pack.tokens, sessionId, session.payment_intent || null, attributed);
  const purchaseId = (insRes && insRes.lastInsertRowid) ? insRes.lastInsertRowid : null;
  await creditTokens(userId, pack.tokens, {
    bucket: 'cot', event_type: 'purchase', source: 'stripe',
    related_purchase_id: purchaseId, stripe_event_id: eventId
  });
  // Account-lifecycle: a real purchase resets the lone-copper idle clock.
  try { await db.prepare('UPDATE users SET last_purchase_at = ? WHERE id = ?').run(new Date().toISOString(), userId); } catch (e) {}
  if (attributed) {
    try {
      const camp = await db.prepare('SELECT user_id FROM campaigns WHERE id = ?').get(attributed);
      const dmId = (camp && camp.user_id) ? camp.user_id : null;
      const bonus = Math.floor(pack.tokens * 0.10);
      if (dmId && dmId !== userId && bonus > 0) {
        await creditTokens(dmId, bonus, {
          bucket: 'cot', event_type: 'dm_bonus', source: 'stripe',
          related_purchase_id: purchaseId, related_campaign_id: attributed,
          stripe_event_id: eventId, triggered_by_user_id: userId
        });
      }
    } catch (e) { /* DM bonus is best-effort */ }
  }
}
// ------------------------------------------------------------
// ------------------------------------------------------------
// Subscription helpers + webhook-driven state sync.
// ------------------------------------------------------------
// Resolve the subscription id from an invoice across Stripe API versions. As of
// 2025-03-31.basil (and the 2026-05-27.dahlia our webhook is pinned to) the flat
// invoice.subscription field was removed in favor of
// invoice.parent.subscription_details.subscription. We check the new path first and
// fall back to the legacy field so a mixed/older payload still resolves. Returns a
// string id or null. (A field may arrive as an id string or an expanded object.)
function invoiceSubscriptionId(invoice) {
  if (!invoice) return null;
  const asId = function (v) { return (v && typeof v === 'object') ? (v.id || null) : (v || null); };
  try {
    if (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription) {
      return asId(invoice.parent.subscription_details.subscription);
    }
  } catch (e) {}
  if (invoice.subscription) return asId(invoice.subscription); // legacy (<= acacia)
  try {
    if (invoice.subscription_details && invoice.subscription_details.subscription) {
      return asId(invoice.subscription_details.subscription);
    }
  } catch (e) {}
  return null;
}

// First price id off a subscription object (webhook payload).
function subscriptionPriceId(subscription) {
  try { return subscription.items.data[0].price.id || null; } catch (e) { return null; }
}

// Period-end (renewal/cycle date) off a subscription payload, defensive against
// Stripe API drift: as of 2025-03-31.basil+ the billing-period fields moved OFF
// the subscription object onto each subscription ITEM. Read the item-level field
// first, fall back to the legacy top-level field. Stripe gives epoch SECONDS;
// we return an ISO timestamp string (or null).
function subscriptionPeriodEnd(subscription) {
  let epoch = null;
  try { epoch = subscription.items.data[0].current_period_end || null; } catch (e) {}
  if (!epoch && subscription && subscription.current_period_end) epoch = subscription.current_period_end;
  if (!epoch) return null;
  try { return new Date(epoch * 1000).toISOString(); } catch (e) { return null; }
}

// Is a cancel scheduled at period end? Read BOTH representations: the legacy
// boolean `cancel_at_period_end`, and the newer `cancel_at` (epoch seconds) that
// recent API versions use. Either one in the future, on a still-active sub, means
// 'cancels at the end of the cycle'. Returns a boolean.
function subscriptionPendingCancel(subscription) {
  if (!subscription) return false;
  if (subscription.cancel_at_period_end === true) return true;
  if (subscription.cancel_at && (subscription.cancel_at * 1000) > Date.now()) return true;
  return false;
}

// Subscription-mode checkout completed: establish the user<->customer<->subscription
// link right away so the Billing Portal works immediately. The customer.subscription
// .created event also lands and sets tier + status via syncSubscriptionToUser. We
// resolve the user from the session metadata / client_reference_id.
async function linkSubscriptionCheckout(session) {
  if (!session) return;
  const md = session.metadata || {};
  const userId = parseInt(md.user_id || session.client_reference_id, 10);
  if (!userId) return;
  const customerId = (session.customer && typeof session.customer === 'object') ? session.customer.id : (session.customer || null);
  const subId = (session.subscription && typeof session.subscription === 'object') ? session.subscription.id : (session.subscription || null);
  if (!customerId && !subId) return;
  const db = await getDb();
  await db.prepare(
    "UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?"
  ).run(customerId, subId, userId);
}

// Webhook-driven state sync: STRIPE IS THE SOURCE OF TRUTH for paid tier + status.
// On any customer.subscription.* event we resolve the user (by stored subscription
// id, else the subscription metadata.user_id, else the customer id) and write
// stripe_customer_id / stripe_subscription_id / subscription_status, deriving
// users.tier from the subscribed price via STRIPE_TIER_PRICES. Naturally idempotent
// (last-write-wins state). The monthly token GRANT is NOT done here -- it rides on
// invoice.paid so tokens only land on a real successful charge.
//
// Tier policy by status:
//   active / trialing                      -> paid tier from the price (access on)
//   past_due / unpaid / incomplete         -> keep current tier (grace; Stripe retries)
//   canceled / incomplete_expired / paused -> revert to copper (no paid access)
async function syncSubscriptionToUser(subscription) {
  if (!subscription || !subscription.id) return { skipped: true };
  const db = await getDb();
  const subId = subscription.id;
  const customerId = (subscription.customer && typeof subscription.customer === 'object') ? subscription.customer.id : (subscription.customer || null);
  const status = subscription.status || '';
  const metaUserId = (subscription.metadata && subscription.metadata.user_id) ? parseInt(subscription.metadata.user_id, 10) : null;
  let user = await db.prepare('SELECT id, tier FROM users WHERE stripe_subscription_id = ?').get(subId);
  if (!user && metaUserId) user = await db.prepare('SELECT id, tier FROM users WHERE id = ?').get(metaUserId);
  if (!user && customerId) user = await db.prepare('SELECT id, tier FROM users WHERE stripe_customer_id = ?').get(customerId);
  if (!user) return { skipped: true, reason: 'no_user' };
  const priceTier = stripeProvider.tierForPrice(subscriptionPriceId(subscription));
  let nextTier = user.tier; // default: leave unchanged
  if (status === 'active' || status === 'trialing') {
    if (priceTier) nextTier = priceTier;
  } else if (status === 'canceled' || status === 'incomplete_expired' || status === 'paused' || status === 'unpaid') {
    nextTier = 'copper';
  } // past_due / incomplete -> keep current tier (grace period)
  //
  // v3.0.669 -- TD-473. `unpaid` MOVED FROM THE GRACE BRANCH TO THE DOWNGRADE BRANCH.
  //
  // past_due means Stripe is still trying: the retry schedule is running and the reader has a card
  // to fix. That is a grace period and Ian set it at two weeks, which is Stripe's default retry
  // window -- decided rather than implied, 2026-08-17.
  //
  // `unpaid` is the OPPOSITE state. It is where Stripe parks a subscription once every retry has
  // been exhausted, IF the dashboard is configured to mark rather than cancel. It was sitting in the
  // grace branch, so a subscription that had definitively stopped paying kept its paid tier forever.
  // Whether anyone was exposed depended entirely on one dashboard setting (TD-472), which is a
  // dependency on a toggle staying where it was left -- the same pairing fault as any two numbers
  // written down twice. Setting the dashboard to CANCEL is still right; this makes it not matter.
  let periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAtEnd = subscriptionPendingCancel(subscription);
  // If the renewal date wasn't on the object but a cancel_at is, use it as the
  // 'cancels on' date so the notice still has something to show.
  if (!periodEnd && subscription.cancel_at) {
    try { periodEnd = new Date(subscription.cancel_at * 1000).toISOString(); } catch (e) {}
  }
  await db.prepare(
    "UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?, subscription_status = ?, current_period_end = ?, cancel_at_period_end = ?, tier = ? WHERE id = ?"
  ).run(customerId, subId, status, periodEnd, cancelAtEnd, nextTier, user.id);
  return { skipped: false, userId: user.id, status: status, tier: nextTier, cancelAtPeriodEnd: cancelAtEnd, currentPeriodEnd: periodEnd };
}

// ------------------------------------------------------------
// v3.0.669 -- TD-473. Failed subscription payments, and abandoned book checkouts.
// ------------------------------------------------------------
// recordPaymentFailure: one row per Stripe EVENT id.
//
// IDEMPOTENT ON THE EVENT, NOT THE INVOICE. Stripe delivers at least once and retries on any
// non-2xx, so a duplicate delivery must not become a duplicate row -- but a SECOND genuine failure
// on the same invoice is a different event and must be recorded, because the attempt count is the
// whole value of the record. Keying on the invoice would collapse a four-attempt dunning sequence
// into one row and lose exactly the history this exists to keep.
//
// IT DOES NOT TOUCH THE TIER. The subscription's own status transition does that, through
// customer.subscription.updated -> syncSubscriptionToUser, which is the authority on access.
// Downgrading from here would be a second opinion about the same question, arriving in a different
// order depending on which webhook Stripe delivered first.
//
// NON-FATAL BY DESIGN: a failure to record a failure must not 500 the webhook, because Stripe would
// then retry the whole event and re-run everything else in the dispatcher alongside it.
async function recordPaymentFailure(invoice, eventId) {
  if (!invoice) return;
  try {
    const db = await getDb();
    const subId = invoiceSubscriptionId(invoice);
    const customerId = (invoice.customer && typeof invoice.customer === 'object')
      ? invoice.customer.id : (invoice.customer || null);
    let user = null;
    if (subId) user = await db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
    if (!user && customerId) user = await db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId);
    // The decline reason lives on the payment intent's last error, not on the invoice itself.
    let code = null, message = null;
    try {
      const pi = invoice.payment_intent;
      const err = (pi && typeof pi === 'object') ? pi.last_payment_error : null;
      if (err) { code = err.code || err.decline_code || null; message = err.message || null; }
    } catch (e) {}
    let nextAt = null;
    try { if (invoice.next_payment_attempt) nextAt = new Date(invoice.next_payment_attempt * 1000).toISOString(); } catch (e) {}
    await db.prepare(
      `INSERT INTO billing_failures
         (user_id, stripe_event_id, stripe_invoice_id, stripe_subscription_id, stripe_customer_id,
          amount_due, currency, attempt_count, next_attempt_at, failure_code, failure_message, billing_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (stripe_event_id) DO NOTHING`
    ).run(
      user ? user.id : null, eventId || null, invoice.id || null, subId, customerId,
      (invoice.amount_due != null ? invoice.amount_due / 100 : null), invoice.currency || null,
      (invoice.attempt_count != null ? invoice.attempt_count : null), nextAt,
      code, message, invoice.billing_reason || null
    );
  } catch (e) {
    console.error('recordPaymentFailure failed (non-fatal):', e && e.message);
  }
}

// markCheckoutExpired: a book order whose Checkout session timed out was never paid and never will
// be. Say so on the row, so My Orders can stop calling it 'pending_payment' -- which reads like
// something still in progress that might complete on its own.
//
// GUARDED ON THE PAYMENT, NOT THE STATUS. A paid order must never be relabelled by a late or
// re-delivered expiry event, and webhook ordering is not guaranteed.
async function markCheckoutExpired(session) {
  if (!session) return;
  try {
    const md = session.metadata || {};
    if (md.kind !== 'print_order') return;   // token packs and subscriptions have no order row
    const orderId = parseInt(md.order_id, 10);
    if (!Number.isFinite(orderId)) return;
    const db = await getDb();
    await db.prepare(
      "UPDATE print_orders SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP " +
      "WHERE id = ? AND payment_status NOT IN ('paid','refunded')"
    ).run(orderId);
  } catch (e) {
    console.error('markCheckoutExpired failed (non-fatal):', e && e.message);
  }
}

// ------------------------------------------------------------
// Subscription renewal -> monthly token grant.
// ------------------------------------------------------------
// Stripe charges the card on the renewal date and fires invoice.paid; this hands
// the user their tier's monthly tokens for that billing period. Because the grant
// is keyed on the invoice id, it lands exactly ONCE per period even if Stripe
// re-delivers the webhook, and it only ever fires on a SUCCESSFUL charge (no money,
// no tokens). Covers both the first subscription invoice and every renewal.
//
// PREREQUISITE (subscription management, built separately): users.stripe_subscription_id
// must be set so we can resolve the buyer from the invoice, and users.tier must reflect
// the subscribed plan so the amounts are right. Until that wiring exists, this no-ops
// safely (it just won't find a matching user).
async function fulfillSubscriptionInvoice(invoice, eventId) {
  const subId = invoiceSubscriptionId(invoice);
  if (!subId) return; // ignore one-off (non-subscription) invoices
  // Grant on the first subscription invoice and on each renewal cycle only. Proration /
  // mid-cycle update invoices are not a new token period, so they're skipped.
  const reason = invoice.billing_reason || '';
  if (reason && reason !== 'subscription_create' && reason !== 'subscription_cycle') return;
  const db = await getDb();
  // Webhook ordering is NOT guaranteed: invoice.paid can arrive before the
  // customer.subscription.created event that sets users.tier + links the sub. Sync the
  // subscription FIRST so the tier and sub->user link are current before we grant --
  // otherwise ensureMonthlyGrant reads a stale tier (e.g. still copper right after an
  // upgrade) and grants the wrong allotment, which the once-per-cycle marker then locks
  // in for the whole billing period. Non-fatal if the retrieve fails.
  try {
    const sub = await stripeProvider.getSubscription(subId);
    if (sub) await syncSubscriptionToUser(sub);
  } catch (e) { console.error('invoice pre-grant sync failed (non-fatal):', e.message); }
  // Resolve the user from the subscription id (preferred), else the customer id.
  let user = await db.prepare('SELECT id, tier FROM users WHERE stripe_subscription_id = ?').get(subId);
  if (!user && invoice.customer) {
    user = await db.prepare('SELECT id, tier FROM users WHERE stripe_customer_id = ?').get(invoice.customer);
  }
  if (!user) return; // subscription not linked to a user yet
  // One grant per invoice id = one grant per billing period. ensureMonthlyGrant reads
  // the user's account tier (users.tier) for the UTOLT + CO amounts and expires any
  // leftover use-it-or-lose-it balance before granting the new period.
  await ensureMonthlyGrant(user.id, invoice.id);
  try { await grantTierSignupBonus(user.id, user.tier); } catch (e) {}
}

// ------------------------------------------------------------
// Mid-cycle UPGRADE proration.
// ------------------------------------------------------------
// When a subscriber moves to a richer plan partway through a billing period, hand
// them the DIFFERENCE in monthly allotment right away (Stripe prorates the money
// separately). This is ADDITIVE -- unlike a renewal it does NOT expire the current
// cycle's use-it-or-lose-it balance; it only adds the extra the upgrade entitles them
// to. Downgrades grant nothing (the smaller allotment just takes effect next renewal).
// Idempotent per opts.key.
//
// Proration model: grants the FULL monthly difference immediately (new - old, per
// bucket), not a day-weighted fraction -- cleanest with whole tokens and the more
// generous, common choice. To day-weight instead, multiply dUtlt/dCot by
// (secondsLeftInPeriod / periodLengthSeconds) and round before crediting.
async function applyUpgradeProration(userId, oldTierName, newTierName, opts = {}) {
  if (!userId) return { skipped: true };
  const pos = function (v) { const x = parseInt(v, 10); return (Number.isFinite(x) && x > 0) ? x : 0; };
  const oldT = getTier(oldTierName) || {};
  const newT = getTier(newTierName) || {};
  const dUtlt = Math.max(0, pos(newT.monthly_utlt) - pos(oldT.monthly_utlt));
  const dCot  = Math.max(0, pos(newT.monthly_cot)  - pos(oldT.monthly_cot));
  if (dUtlt === 0 && dCot === 0) return { skipped: true, reason: 'no_increase' };
  const db = await getDb();
  // Idempotency: one upgrade top-up per key (the Stripe event id). Matches either
  // bucket's marker so a utlt-only or cot-only top-up still short-circuits a retry.
  if (opts.key) {
    const got = await db.prepare(
      "SELECT 1 AS x FROM token_ledger WHERE user_id = ? AND source = ? AND event_type IN ('upgrade_grant','upgrade_cot_grant') LIMIT 1"
    ).get(userId, opts.key);
    if (got) return { skipped: true, reason: 'already_applied' };
  }
  if (dUtlt > 0) await creditTokens(userId, dUtlt, { bucket: 'utlt', event_type: 'upgrade_grant', source: opts.key || 'upgrade', stripe_event_id: opts.eventId || null });
  if (dCot > 0)  await creditTokens(userId, dCot,  { bucket: 'cot', event_type: 'upgrade_cot_grant', source: opts.key || 'upgrade', stripe_event_id: opts.eventId || null });
  return { skipped: false, from: oldTierName, to: newTierName, utlt: dUtlt, cot: dCot };
}

// Mid-cycle plan change -> upgrade proration. Stripe fires customer.subscription.updated
// with previous_attributes describing the change. We map the NEW price (current first
// item) and the OLD price (from previous_attributes, falling back to the user's stored
// tier) to tier names; if the user moved up, the difference is granted immediately.
// Safely no-ops until STRIPE_TIER_PRICES is configured (tierForPrice returns null), and
// skips downgrades / non-plan updates.
//
// More robust once the subscription-management flow exists: call applyUpgradeProration
// directly from the upgrade handler with the tiers it already knows, instead of
// re-deriving them from the event here.
async function fulfillSubscriptionUpdate(subscription, previousAttributes, eventId) {
  if (!subscription || !subscription.id) return;
  let newPriceId = null, oldPriceId = null;
  try { newPriceId = subscription.items.data[0].price.id; } catch (e) { newPriceId = null; }
  try { oldPriceId = previousAttributes.items.data[0].price.id; } catch (e) { oldPriceId = null; }
  const newTier = stripeProvider.tierForPrice(newPriceId);
  if (!newTier) return; // price not mapped to a tier yet -> nothing to do
  const db = await getDb();
  const user = await db.prepare('SELECT id, tier FROM users WHERE stripe_subscription_id = ?').get(subscription.id);
  if (!user) return;
  let oldTier = oldPriceId ? stripeProvider.tierForPrice(oldPriceId) : null;
  if (!oldTier) oldTier = user.tier || null;
  if (!oldTier || oldTier === newTier) return; // no actionable change
  await applyUpgradeProration(user.id, oldTier, newTier, { key: eventId, eventId: eventId });
}

// ------------------------------------------------------------
// Signup bonus: credit the Story Master (campaign owner / invite creator)
// N carry-over (cot) tokens when a UNIQUE person joins one of their
// campaigns -- brand-new signup or existing subscriber accepting an invite.
// One bonus per unique (SM, joiner) pair, ever: the same person re-joining
// another of that SM's campaigns does not pay again. Configured on the admin
// Dashboard -> Settings (signup_bonus_cot, default 0 = off). Returns the
// number of tokens granted (0 if off or already paid).
// ------------------------------------------------------------
// One-time subscription/signup welcome bonus to the SUBSCRIBER, in carry-over
// tokens. HIGH-WATER MARK: a tier's bonus is granted only when it outranks EVERY
// tier the user has already claimed -- rewards moving UP, never a downgrade or a
// re-claim. Tracked in token_ledger so it cannot be re-farmed. DISTINCT from
// grantSignupBonus (the referral bonus paid to a Story Master).
// Analytics record of a generation (charged OR free), parallel to token_ledger.
// Best-effort: NEVER throws into the caller -- the money ledger stays authoritative,
// and a missed analytics row must never block a spend or a user's generation.
async function recordGeneration(userId, opts = {}) {
  try {
    if (!userId) return;
    const db = await getDb();
    await db.prepare(
      'INSERT INTO generation_events (user_id, event_type, tokens_redeemed, quantity, unit, model, related_campaign_id, related_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      userId,
      String(opts.event_type || 'unknown'),
      parseInt(opts.tokens_redeemed, 10) || 0,
      (opts.quantity == null ? null : (parseInt(opts.quantity, 10) || 0)),
      (opts.unit || null),
      (opts.model || null),
      (opts.related_campaign_id || null),
      (opts.related_session_id || null)
    );
  } catch (e) { try { console.warn('recordGeneration non-fatal:', e.message); } catch (_e) {} }
}

async function grantTierSignupBonus(userId, tierName) {
  if (!userId || !tierName) return 0;
  try {
    const tier = getTier(tierName);
    const amount = parseInt((tier && tier.signup_bonus) || 0, 10);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const rank = parseInt((tier && tier.rank), 10);
    if (!Number.isFinite(rank)) return 0;
    const db = await getDb();
    // High-water mark: grant only when this tier outranks EVERY tier the user has
    // already claimed a sign-up bonus for. A downgrade to a lower (or already-
    // claimed) tier grants nothing; this also subsumes the per-tier de-dupe.
    const claimed = await db.prepare("SELECT source FROM token_ledger WHERE user_id = ? AND event_type = 'tier_signup_bonus'").all(userId);
    let highWater = -1;
    (claimed || []).forEach(function (r) {
      const nm = (r && r.source && r.source.indexOf('tier:') === 0) ? r.source.slice(5) : '';
      if (!nm) return;
      const cr = parseInt((getTier(nm) || {}).rank, 10);
      if (Number.isFinite(cr) && cr > highWater) highWater = cr;
    });
    if (rank <= highWater) return 0;
    await creditTokens(userId, amount, { bucket: 'cot', event_type: 'tier_signup_bonus', source: 'tier:' + tierName });
    return amount;
  } catch (e) { try { console.error('grantTierSignupBonus failed (non-fatal):', e.message); } catch (_e) {} return 0; }
}

async function grantSignupBonus(smUserId, joinerUserId, opts = {}) {
  if (!smUserId || !joinerUserId || smUserId === joinerUserId) return 0;
  const db = await getDb();
  const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'signup_bonus_cot'").get();
  const n = row && row.value != null ? parseInt(row.value, 10) : 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Unique-person dedupe: skip if this SM was already paid a signup bonus
  // triggered by this same joiner.
  const prior = await db.prepare(
    "SELECT 1 FROM token_ledger WHERE user_id = ? AND triggered_by_user_id = ? AND event_type = 'signup_bonus' LIMIT 1"
  ).get(smUserId, joinerUserId);
  if (prior) return 0;
  await creditTokens(smUserId, n, {
    bucket: 'cot',
    event_type: 'signup_bonus',
    source: opts.source || 'signup_bonus',
    triggered_by_user_id: joinerUserId,
    related_campaign_id: opts.campaignId || null
  });
  return n;
}

// Size-scaled charge for a generation action. rateKey = units (words/panels)
// per token; floorKey = minimum tokens. Returns max(floor, floor(size/rate));
// rate 0 disables the scaled term, and 0/0 charges nothing.
async function computeGenCharge(size, rateKey, floorKey) {
  const db = await getDb();
  async function g(k){ const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(k); const n = r ? parseInt(r.value, 10) : 0; return (Number.isFinite(n) && n >= 0) ? n : 0; }
  const rate = await g(rateKey);
  const floor = await g(floorKey);
  const sz = (Number.isFinite(size) && size > 0) ? size : 0;
  const scaled = (rate > 0) ? Math.floor(sz / rate) : 0;
  const charge = Math.max(floor, scaled);
  return charge > 0 ? charge : 0;
}

module.exports = {
  computeGenCharge,
  router,
  getTokenCost,
  getBalance,
  canAfford,
  characterReserveStatus,
  creditTokens,
  grantSignupBonus,
  grantTierSignupBonus,
  recordGeneration,
  spendTokens,
  ensureMonthlyGrant,
  fulfillSubscriptionInvoice,
  applyUpgradeProration,
  fulfillSubscriptionUpdate,
  syncSubscriptionToUser,
  linkSubscriptionCheckout,
  stripeWebhook
};
