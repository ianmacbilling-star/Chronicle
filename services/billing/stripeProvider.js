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

// Create a hosted Checkout Session for a one-time token-pack purchase. The
// caller redirects the buyer to the returned session.url. Amount + description
// come from the server pack -- never from the client.
async function createCheckoutSession(opts) {
  const stripe = getClient();
  if (!stripe) throw unconfigured();
  const pack = opts.pack;
  const params = {
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: pack.price_cents,
        product_data: { name: 'Campaignia tokens -- ' + pack.name + ' pack (' + pack.tokens + ' tokens)' }
      }
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
  if (opts.customerEmail) params.customer_email = opts.customerEmail;
  return await stripe.checkout.sessions.create(params);
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
  return await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: opts.currency || 'usd',
        unit_amount: opts.amountCents,
        product_data: { name: opts.description || 'Campaignia order' }
      }
    }],
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId != null ? String(opts.userId) : undefined,
    customer_email: opts.customerEmail || undefined,
    metadata: opts.metadata || {}
  });
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

module.exports = {
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
  cardForPayment
};
