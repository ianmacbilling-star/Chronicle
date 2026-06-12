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
const { getTier } = require('../middleware/tiers');
const { getPack, listPacks } = require('../services/billing/packs');
const stripeProvider = require('../services/billing/stripeProvider');

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
async function ensureMonthlyGrant(userId) {
  if (!userId) return;
  const db = await getDb();
  const cycle = currentCycleKey();
  const got = await db.prepare(
    "SELECT 1 AS x FROM token_ledger WHERE user_id = ? AND event_type = 'monthly_grant' AND source = ? LIMIT 1"
  ).get(userId, cycle);
  if (got) return;
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
}

async function canAfford(userId, cost) {
  const { total } = await getBalance(userId);
  return total >= cost;
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
    res.json(bal);
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
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tokens/dev-grant-monthly -- TESTING. Manually grant THIS user's
// current-tier monthly allotment (UTOLT + CO). The monthly grant no longer
// fires automatically on page load; this button is the manual trigger while
// testing. Session-gated, self only. REMOVE once a production grant trigger
// (cron or login hook) is decided.
router.post('/dev-grant-monthly', async function(req, res) {
  if (!requireSession(req, res)) return;
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tierName = (u && u.tier) || 'copper';
    const tier = getTier(tierName);
    let gUtlt = parseInt(tier && tier.monthly_utlt, 10);
    let gCot = parseInt(tier && tier.monthly_cot, 10);
    if (!Number.isFinite(gUtlt) || gUtlt < 0) gUtlt = 0;
    if (!Number.isFinite(gCot) || gCot < 0) gCot = 0;
    if (gUtlt > 0) await creditTokens(req.session.userId, gUtlt, { bucket: 'utlt', event_type: 'monthly_grant', source: 'manual_test' });
    if (gCot > 0) await creditTokens(req.session.userId, gCot, { bucket: 'cot', event_type: 'monthly_cot_grant', source: 'manual_test' });
    const bal = await getBalance(req.session.userId);
    res.json({ ok: true, tier: tierName, granted: { utlt: gUtlt, cot: gCot }, balance: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
  if (!stripeProvider.isConfigured()) {
    return res.status(503).json({ error: 'billing_unconfigured' });
  }
  try {
    const db = await getDb();
    // last_active_campaign_id drives the DM 10% bonus attribution.
    let attributed = null;
    try {
      const u = await db.prepare('SELECT last_active_campaign_id FROM users WHERE id = ?').get(req.session.userId);
      attributed = (u && u.last_active_campaign_id != null) ? u.last_active_campaign_id : null;
    } catch (e) { attributed = null; }
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createCheckoutSession({
      pack: pack,
      userId: req.session.userId,
      attributedCampaignId: attributed,
      successUrl: base + '/?purchase=success',
      cancelUrl: base + '/?purchase=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

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
      await fulfillCheckout(event.data.object, event.id);
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
module.exports = {
  router,
  getTokenCost,
  getBalance,
  canAfford,
  creditTokens,
  spendTokens,
  ensureMonthlyGrant,
  stripeWebhook
};
