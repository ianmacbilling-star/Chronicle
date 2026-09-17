// =================================================================================================
// v3.0.945 -- TD-791. ONE STRIPE CUSTOMER PER CAMPAIGNIA USER, FOR EVERY KIND OF PURCHASE.
//
// Ian, 2026-09-17: "Can we make it so every user that buys anything gets a customer ID so that all
// future purchases they make are linked to one stripe customer?"
//
// WHAT WAS WRONG. The three one-time checkouts -- token packs, passes, print orders -- all asked
// Stripe for customer_creation 'always' and passed no customer, so every single purchase minted a
// brand new Stripe customer on the same email, and nothing ever wrote that customer back to the
// user. Only a SUBSCRIPTION checkout linked a customer. A buyer's history was scattered across as
// many Stripe customers as they had purchases, and a pass-only buyer had no customer id at all.
//
// WHAT THIS DOES. Before ANY checkout opens, ensureStripeCustomer() makes sure the user has exactly
// one real Stripe customer and returns its id; every checkout then passes that id as customer.
// The customer is created BEFORE money moves and stored BEFORE checkout opens, so no late, lost or
// retried webhook can leave a purchase unlinked.
//
// THE ONE RULE THAT MATTERS ON A LIVE MONEY PATH: THIS NEVER BLOCKS A SALE. Any failure here --
// Stripe unreachable, an idempotency clash, a database hiccup -- returns null, and the caller falls
// back to exactly the pre-v3.0.945 behaviour (Stripe mints a customer at checkout). A tidy ledger is
// not worth a lost purchase. linkPaymentCustomer() below is the safety net that then links THAT
// customer from the webhook, so even the fallback ends up joined up.
//
// WHAT IT DOES NOT DO. It cannot merge customers made before this batch -- Stripe has no merge --
// so a joined-up history starts from here. And it does not put one-time payments into Stripe's
// portal list; that list is invoices only and costs extra (see TD-791). Our own payment history
// page is the plan for that.
// =================================================================================================

const { getDb } = require('../../database/db');
const stripeProvider = require('./stripeProvider');

// A real, portal-capable Stripe customer id. Deliberately NOT a gcus_ guest (TD-539: a guest cannot
// open a billing portal) and not an empty string or a stray value from testing.
function isRealCustomerId(id) {
  return typeof id === 'string' && /^cus_[A-Za-z0-9]+$/.test(id);
}

// Returns the user's one Stripe customer id, creating and storing it if needed. Returns null (never
// throws) when there is nothing sensible to return -- the caller must then fall back.
async function ensureStripeCustomer(userId) {
  const uid = parseInt(userId, 10);
  if (!uid) return null;
  if (!stripeProvider.isConfigured()) return null;
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?').get(uid);
    if (!u) return null;
    const stored = u.stripe_customer_id || null;

    if (isRealCustomerId(stored)) {
      const exists = await stripeProvider.customerExists(stored);
      // true: the normal case. null: Stripe could not be asked -- keep using the stored id, which is
      // exactly what the subscription path has always done, rather than minting a duplicate because
      // of a network blip.
      if (exists !== false) return stored;
      // false: deleted, or not in THIS Stripe account or mode (a live id on a sandbox, say). A checkout
      // on it would fail outright, so it is replaced below.
    }

    // The idempotency key makes a double-click, or two tabs checking out at once, return the SAME
    // customer rather than two. It carries the id being replaced, so replacing a dead id is a new key.
    const created = await stripeProvider.createCustomer({
      userId: uid,
      email: u.email || null,
      name: u.name || null,
      idempotencyKey: 'campaignia-user-customer-' + uid + '-' + (stored || 'none')
    });
    const newId = created && created.id;
    if (!isRealCustomerId(newId)) return null;

    // CONDITIONAL WRITE: only replace what we read. If another request stored a customer in the
    // meantime, that one wins and is what we return.
    if (stored) {
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id = ?').run(newId, uid, stored);
    } else {
      await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL').run(newId, uid);
    }
    const after = await db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(uid);
    const finalId = after && after.stripe_customer_id;
    return isRealCustomerId(finalId) ? finalId : newId;
  } catch (e) {
    console.error('[billing] ensureStripeCustomer failed for user ' + uid + ' (falling back to checkout-created customer):', e && e.message);
    return null;
  }
}

// Webhook safety net for mode 'payment' sessions. If a checkout went out WITHOUT a customer (the
// fallback above), Stripe created one; store it -- but only on a user who has no real customer yet,
// so this can never overwrite a good id with a stray one.
async function linkPaymentCustomer(session) {
  if (!session) return;
  const md = session.metadata || {};
  const uid = parseInt(md.user_id || session.client_reference_id, 10);
  if (!uid) return;
  const customerId = (session.customer && typeof session.customer === 'object') ? session.customer.id : (session.customer || null);
  if (!isRealCustomerId(customerId)) return;
  const db = await getDb();
  await db.prepare(
    "UPDATE users SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id IS NULL OR LEFT(stripe_customer_id, 4) <> 'cus_')"
  ).run(customerId, uid);
}

module.exports = { ensureStripeCustomer, linkPaymentCustomer, isRealCustomerId };
