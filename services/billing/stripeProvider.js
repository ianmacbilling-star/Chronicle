// Stripe provider -- lazy + boot-safe. The 'stripe' package and the STRIPE_*
// env vars may both be absent until billing is set up. Nothing here is required
// at boot, and isConfigured() stays false until BOTH the package and the secret
// key are present, so every caller degrades gracefully (the UI shows a "coming
// soon" and the webhook 503s) until go-live.
//
// We pin the API version to the one the webhook event destination is configured
// for (2026-05-27.dahlia) so the objects we read in API calls match the shape of
// the objects Stripe renders into the webhook payloads.

let _client = null;
let _triedRequire = false;

// Webhook event destination + our API calls share this version. If you change the
// event-destination version in the Stripe dashboard, change it here too.
const STRIPE_API_VERSION = '2026-05-27.dahlia';

// Lazily build the Stripe client. Returns null (never throws) when the package
// isn't installed or the secret key isn't set.
function getClient() {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (_triedRequire) return _client; // already tried + failed (package missing)
  _triedRequire = true;
  try {
    const Stripe = require('stripe');
    _client = Stripe(key, { apiVersion: STRIPE_API_VERSION });
    return _client;
  } catch (e) {
    return null;
  }
}

// True only when we can actually talk to Stripe (package + secret key present).
function isConfigured() {
  return !!getClient();
}

function webhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || '';
}

function unconfigured() {
  const e = new Error('billing_unconfigured');
  e.code = 'BILLING_UNCONFIGURED';
  return e;
}

// Build the price_data product reference for one-time (payment-mode) checkouts.
// When the STRIPE_PRODUCT_* env var is set we point the ad-hoc price at that REAL
// Stripe Product, so product-scoped coupons/promo codes can target it (e.g. a code
// valid only on book orders). The amount stays server-computed via unit_amount.
// Falls back to an inline product_data name when the env var is absent, so nothing
// breaks before the Products are configured. Product IDs are account-specific, so the
// value must match whichever Stripe account STRIPE_SECRET_KEY currently points at.
function productRef(envVar, fallbackName) {
  const pid = process.env[envVar];
  return pid ? { product: pid } : { product_data: { name: fallbackName } };
}

// v3.0.945 -- TD-791. WHO IS BUYING, for every one-time (payment-mode) checkout, decided in ONE place.
// With the user's Stripe customer id we pass customer, so every purchase lands on the same customer
// as their subscription and each other. Without one -- ensureStripeCustomer could not produce it --
// we fall back to exactly what v3.0.742 did: customer_creation 'always', so Stripe still makes a REAL
// customer rather than a gcus_ guest (TD-539), and the webhook safety net links it afterwards.
// customer and customer_creation are mutually exclusive in Stripe, and so are customer and
// customer_email, which is why this returns one shape or the other and never a mix.
function buyerRef(opts) {
  if (opts && opts.customerId) return { customer: opts.customerId };
  const ref = { customer_creation: 'always' };
  if (opts && opts.customerEmail) ref.customer_email = opts.customerEmail;
  return ref;
}

// v3.0.946 -- TD-791 / TD-798. AN INVOICE FOR EVERY ONE-TIME PURCHASE, decided in ONE place.
// Ian, 2026-09-17: "I do want it to create an invoice so it can all be viewed in the payment history
// on stripe when someone hits the button." Stripe's customer portal lists INVOICES only. Subscription
// payments already make one; a payment-mode Checkout makes a receipt and no invoice unless asked, so
// packs, passes and books were invisible there. With v3.0.945 putting every purchase on the user's
// one customer, turning invoices on puts EVERYTHING in that one history.
//
// THE COST IS DELIBERATE AND WAS PRICED BEFORE IT WAS BUILT: Stripe charges 0.4% of the sale, capped
// at $2 per invoice, for post-payment invoices on one-time Checkout payments. Subscriptions are
// unaffected -- their invoices are covered by the Billing fee already paid. Ian chose this over
// building our own payment history page (TD-798, parked).
//
// THE WEBHOOK CONSEQUENCE: these invoices fire invoice.paid, the same event that grants a
// subscription's monthly tokens. fulfillSubscriptionInvoice returns at once for an invoice with no
// subscription, so a paid pack cannot be mistaken for a renewal -- and the v3.0.946 guard drives that
// function with a one-time invoice to prove it rather than trusting this comment.
//
// metadata carries the Campaignia user id and what was bought, so any invoice can be traced back from
// the Stripe dashboard. Stripe metadata values must be strings.
function invoiceRef(opts, kind, extraMetadata) {
  const md = Object.assign({}, extraMetadata || {}, { kind: String(kind) });
  if (opts && opts.userId != null) md.user_id = String(opts.userId);
  return { invoice_creation: { enabled: true, invoice_data: { metadata: md } } };
}

// v3.0.945 -- TD-791. Create the one Stripe customer for a Campaignia user. user_id rides in the
// metadata so the customer can always be traced back from the Stripe dashboard.
async function createCustomer(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const params = { metadata: { user_id: String(opts.userId) } };
  if (opts.email) params.email = opts.email;
  if (opts.name) params.name = opts.name;
  const reqOpts = opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined;
  return await stripe.customers.create(params, reqOpts);
}

// v3.0.945 -- TD-791. Does this customer exist, undeleted, in the Stripe account and mode we are
// talking to? THREE ANSWERS, NOT TWO (TD-587): true, false (definitely gone or not ours), and null
// (could not ask). Callers must not treat null as false and mint a duplicate over a network blip.
async function customerExists(customerId) {
  const stripe = getClient();
  if (!stripe || !customerId) return null;
  try {
    const c = await stripe.customers.retrieve(customerId);
    return !!(c && !c.deleted);
  } catch (e) {
    if (e && (e.code === 'resource_missing' || e.statusCode === 404)) return false;
    return null;
  }
}

// Create a hosted Checkout Session for a one-time token-pack purchase. The
// caller redirects the buyer to the returned session.url. Amount + description
// come from the server pack -- never from the client.
async function createCheckoutSession(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const pack = opts.pack;
  const params = {
    mode: 'payment',
    // v3.0.945 -- TD-791. The buyer (customer, or the TD-539 customer_creation fallback) is added
    // by buyerRef below -- one place for all three one-time checkouts.
    allow_promotion_codes: true,
    line_items: [{
      quantity: 1,
      price_data: Object.assign({
        currency: 'usd',
        unit_amount: pack.price_cents
      }, productRef('STRIPE_PRODUCT_TOKENS', 'Campaignia tokens -- ' + pack.name + ' pack (' + pack.tokens + ' tokens)'))
    }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata: {
      user_id: String(opts.userId),
      pack_id: pack.id,
      attributed_campaign_id: opts.attributedCampaignId != null ? String(opts.attributedCampaignId) : ''
    }
  };
  // Prefill the buyer's account email (and set the receipt email) so a browser-cached
  // Stripe Link identity isn't the default. (Link may still be offered by the browser.)
  // v3.0.945 -- TD-791. With a customer id the email comes from that customer instead.
  Object.assign(params, buyerRef(opts), invoiceRef(opts, 'token_pack', { pack_id: String(pack.id) }));   // v3.0.946
  return await stripe.checkout.sessions.create(params);
}

// v3.0.923 -- TD-780 Push 5. A PLATINUM PASS IS A ONE-TIME PAYMENT, so this is the token-pack
// path with a different catalog behind it: mode 'payment', an ad-hoc price whose unit_amount is
// computed on the SERVER, and the real Product attached only when STRIPE_PRODUCT_PASSES is set
// (which is optional, and exists solely so a promo code can be scoped to passes).
//
// THE QUOTE IS FROZEN INTO THE SESSION METADATA. Ian edits pass prices and token counts from the
// dashboard, so the catalog can legitimately change between somebody opening Checkout and paying.
// Stripe already holds the amount they agreed to; stamping the token count beside it means the
// webhook grants WHAT WAS QUOTED rather than whatever the catalog says when it fires.
async function createPassCheckout(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const pass = opts.pass;
  const params = {
    mode: 'payment',
    // v3.0.945 -- TD-791. Buyer added by buyerRef below.
    allow_promotion_codes: true,
    line_items: [{
      quantity: 1,
      price_data: Object.assign({
        currency: 'usd',
        unit_amount: pass.price_cents
      }, productRef('STRIPE_PRODUCT_PASSES', 'Campaignia -- ' + pass.name + ' (' + pass.tokens + ' tokens)'))
    }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata: {
      kind: 'pass',
      user_id: String(opts.userId),
      pass_id: pass.id,
      // the frozen quote -- read back by fulfillPassCheckout, never re-derived
      quoted_tokens: String(pass.tokens),
      quoted_price_cents: String(pass.price_cents),
      quoted_months: String(pass.months),
      quoted_tier: String(pass.tier)
    }
  };
  Object.assign(params, buyerRef(opts), invoiceRef(opts, 'pass', { pass_id: String(pass.id) }));   // v3.0.945 -- TD-791, v3.0.946 invoice
  return await stripe.checkout.sessions.create(params);
}

// v3.0.923 -- TD-780 Push 5. NOT CALLED BY ANYTHING YET, and that is deliberate -- see the note
// on the pass checkout route in routes/tokens.js. cancelSubscription() above ends a subscription
// IMMEDIATELY and would take paid days off somebody who just spent $279; this is the variant that
// lets the period they already bought run out. It is here so the decision is a one-line change
// rather than a new Stripe call written under time pressure.
async function cancelSubscriptionAtPeriodEnd(subId) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  return await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
}

// Create a hosted Checkout Session for a recurring tier SUBSCRIPTION. priceId is a
// recurring Stripe Price (resolved from STRIPE_TIER_PRICES). We stamp user_id onto
// both the session metadata AND the resulting subscription's metadata so the
// webhook lifecycle (customer.subscription.*) can always resolve the user, even
// before the customer<->user link is stored. Reuses an existing customer when we
// have one; otherwise Stripe creates one (seeded with the user's email).
async function createSubscriptionCheckout(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const params = {
    mode: 'subscription',
    line_items: [{ price: opts.priceId, quantity: 1 }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: String(opts.userId),
    metadata: { user_id: String(opts.userId) },
    subscription_data: { metadata: { user_id: String(opts.userId) } },
    allow_promotion_codes: true
  };
  if (opts.customerId) params.customer = opts.customerId;
  else if (opts.customerEmail) params.customer_email = opts.customerEmail;
  return await stripe.checkout.sessions.create(params);
}

// Create a Stripe Billing Portal session -- the hosted, white-labeled page where a
// customer upgrades / downgrades / cancels / updates their card. Requires a saved
// portal configuration in the Stripe dashboard (Settings -> Billing -> Customer
// portal). Whatever the customer does there comes back to us as a
// customer.subscription.* webhook, which is our source of truth.
async function createBillingPortalSession(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  return await stripe.billingPortal.sessions.create({
    customer: opts.customerId,
    return_url: opts.returnUrl
  });
}

// Verify + parse a webhook event from the raw request body. Throws if the
// signature can't be verified (caller returns 400).
function constructEvent(rawBody, signature) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret());
}

// Resolve a Stripe Price id to one of our tier names (copper/silver/gold/platinum).
// STRIPE_TIER_PRICES is a JSON env like
// {"price_abc":"silver","price_def":"gold","price_ghi":"platinum"}.
// Returns null until configured (or for an unmapped price), so callers no-op safely.
function tierForPrice(priceId) {
  if (!priceId) return null;
  let map = {};
  try { map = JSON.parse(process.env.STRIPE_TIER_PRICES || '{}'); } catch (e) { map = {}; }
  const t = map && map[priceId];
  return (t && typeof t === 'string') ? t : null;
}

// Reverse of tierForPrice: the Price id we should subscribe a user to for a tier.
// Returns the first price mapped to that tier, or null if unmapped.
function priceForTier(tierName) {
  if (!tierName) return null;
  let map = {};
  try { map = JSON.parse(process.env.STRIPE_TIER_PRICES || '{}'); } catch (e) { map = {}; }
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length; i++) {
    if (map[keys[i]] === tierName) return keys[i];
  }
  return null;
}

// Create a hosted Checkout Session for a ONE-TIME payment of an arbitrary
// amount (used by book/print orders). The amount is set by the caller from a
// server-side computed total -- never trusted from the client. metadata is
// echoed back on the webhook so the fulfillment can find the order.
async function createOneTimeCheckout(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const params = {
    mode: 'payment',
    // v3.0.945 -- TD-791. A book order is a one-time payment like the other two, so its buyer comes
    // from buyerRef too (customer when we have one; the TD-539 customer_creation fallback otherwise).
    allow_promotion_codes: true,
    line_items: [{
      quantity: 1,
      price_data: Object.assign({
        currency: opts.currency || 'usd',
        unit_amount: opts.amountCents
      }, productRef('STRIPE_PRODUCT_PRINT', opts.description || 'Campaignia order'))
    }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId != null ? String(opts.userId) : undefined,
    metadata: opts.metadata || {}
  };
  // v3.0.946 -- the order id rides on the invoice too, so a book's invoice can be matched to po-N.
  const _om = opts.metadata || {};
  Object.assign(params, buyerRef(opts), invoiceRef(opts, 'print_order', _om.order_id != null ? { order_id: String(_om.order_id) } : {}));
  return await stripe.checkout.sessions.create(params);
}

// Best-effort card brand + last4 from a completed payment, for display only
// (order history). Never throws; returns null when unavailable.
async function cardForPayment(paymentIntentId) {
  const stripe = getClient();
  if (!stripe || !paymentIntentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const ch = pi && pi.latest_charge;
    const card = ch && ch.payment_method_details && ch.payment_method_details.card;
    if (card) return { brand: card.brand || null, last4: card.last4 || null };
  } catch (e) {}
  return null;
}

// Immediately cancel a subscription (self-service account suspension). Stripe
// fires customer.subscription.deleted, which our webhook reconciles to copper.
// Throws unconfigured() when billing isn't set up -- the caller treats that as
// non-fatal (nothing to cancel in dev/sandbox-less environments).
async function cancelSubscription(subId) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  return await stripe.subscriptions.cancel(subId);
}

// Change an existing subscription to a different tier's price, in place, with
// proration applied to the next invoice (used by the in-app plan-change buttons).
// The customer.subscription.updated webhook then reconciles the user's tier.
async function changeSubscriptionPrice(subId, newPriceId) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const sub = await stripe.subscriptions.retrieve(subId);
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  if (!item || !item.id) throw new Error('subscription_item_not_found');
  return await stripe.subscriptions.update(subId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: 'create_prorations'
  });
}

// Retrieve a subscription (used to check whether it's still live before an
// in-place plan change; a canceled sub can only change its metadata).
async function getSubscription(subId) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  return await stripe.subscriptions.retrieve(subId);
}

// Read the human-readable promotion code a customer applied at checkout, from a
// completed Checkout Session. Retrieves the session's discounts if absent, then the
// promotion code object for its `code`. Defensive: any failure returns null so the
// webhook never breaks on a promo read. NOTE: discount field paths are API-version
// sensitive -- verify on the first real redemption.
async function getSessionPromoCode(session) {
  const stripe = getClient();
  if (!stripe || !session) return null;
  try {
    let discounts = session.discounts;
    if (!discounts || !discounts.length) {
      const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ['discounts'] });
      discounts = full && full.discounts;
    }
    if (!discounts || !discounts.length) return null;
    let promoId = null;
    for (let i = 0; i < discounts.length; i++) {
      const pc = discounts[i] && discounts[i].promotion_code;
      if (pc) { promoId = (typeof pc === 'string') ? pc : pc.id; break; }
    }
    if (!promoId) return null;
    const promo = await stripe.promotionCodes.retrieve(promoId);
    return (promo && promo.code) ? String(promo.code) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  createPassCheckout, cancelSubscriptionAtPeriodEnd,
  createCustomer, customerExists,   // v3.0.945 -- TD-791
  isConfigured,
  cancelSubscription,
  changeSubscriptionPrice,
  getSubscription,
  createCheckoutSession,
  createSubscriptionCheckout,
  createBillingPortalSession,
  constructEvent,
  webhookSecret,
  tierForPrice,
  priceForTier,
  createOneTimeCheckout,
  getSessionPromoCode,
  cardForPayment
};
