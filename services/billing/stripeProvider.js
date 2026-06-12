// Stripe provider -- lazy + boot-safe. The 'stripe' package and the STRIPE_*
// env vars may both be absent until the LLC/account is set up. Nothing here is
// required at boot, and isConfigured() stays false until BOTH the package and
// the secret key are present, so every caller degrades gracefully (the UI shows
// a "coming soon" and the webhook 503s) until go-live.
//
// TODO(stripe): at go-live, run `npm install stripe` (adds the dependency +
// lockfile) and set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET per-env in Railway.

let _client = null;
let _triedRequire = false;

// Lazily build the Stripe client. Returns null (never throws) when the package
// isn't installed or the secret key isn't set.
function getClient() {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (_triedRequire) return _client; // already tried + failed (package missing)
  _triedRequire = true;
  try {
    const Stripe = require('stripe'); // lazy: not installed until go-live
    _client = Stripe(key);
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
  return await stripe.checkout.sessions.create({
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
// The subscription system supplies the mapping at go-live via STRIPE_TIER_PRICES, a
// JSON env like {"price_abc":"silver","price_def":"gold","price_ghi":"platinum"}.
// Returns null until configured (or for an unmapped price), so callers no-op safely.
function tierForPrice(priceId) {
  if (!priceId) return null;
  let map = {};
  try { map = JSON.parse(process.env.STRIPE_TIER_PRICES || '{}'); } catch (e) { map = {}; }
  const t = map && map[priceId];
  return (t && typeof t === 'string') ? t : null;
}

module.exports = { isConfigured, createCheckoutSession, constructEvent, webhookSecret, tierForPrice };
