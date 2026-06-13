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
    res.json(Object.assign({}, bal, { reserve: reserve, spendable: spendable, reserveLow: reserveLow }));
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
      successUrl: base + '/app.html?purchase=success',
      cancelUrl: base + '/app.html?purchase=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    res.status(500).json({ error: 'Could not start checkout' });
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
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT email, stripe_customer_id FROM users WHERE id = ?').get(req.session.userId);
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const session = await stripeProvider.createSubscriptionCheckout({
      priceId: priceId,
      userId: req.session.userId,
      customerId: (u && u.stripe_customer_id) || null,
      customerEmail: (u && u.email) || null,
      successUrl: base + '/app.html?subscribe=success',
      cancelUrl: base + '/app.html?subscribe=cancel'
    });
    res.json({ url: session.url });
  } catch (e) {
    if (e.code === 'BILLING_UNCONFIGURED') return res.status(503).json({ error: 'billing_unconfigured' });
    res.status(500).json({ error: 'Could not start subscription' });
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
  } else if (status === 'canceled' || status === 'incomplete_expired' || status === 'paused') {
    nextTier = 'copper';
  } // past_due / unpaid / incomplete -> keep current tier (grace period)
  await db.prepare(
    "UPDATE users SET stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?, subscription_status = ?, tier = ? WHERE id = ?"
  ).run(customerId, subId, status, nextTier, user.id);
  return { skipped: false, userId: user.id, status: status, tier: nextTier };
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
  // Resolve the user from the subscription id (preferred), else the customer id.
  let user = await db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
  if (!user && invoice.customer) {
    user = await db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(invoice.customer);
  }
  if (!user) return; // subscription not linked to a user yet
  // One grant per invoice id = one grant per billing period. ensureMonthlyGrant reads
  // the user's account tier (users.tier) for the UTOLT + CO amounts and expires any
  // leftover use-it-or-lose-it balance before granting the new period.
  await ensureMonthlyGrant(user.id, invoice.id);
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

module.exports = {
  router,
  getTokenCost,
  getBalance,
  canAfford,
  characterReserveStatus,
  creditTokens,
  spendTokens,
  ensureMonthlyGrant,
  fulfillSubscriptionInvoice,
  applyUpgradeProration,
  fulfillSubscriptionUpdate,
  syncSubscriptionToUser,
  linkSubscriptionCheckout,
  stripeWebhook
};
