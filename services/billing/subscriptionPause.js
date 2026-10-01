// ============================================================================
// A PASS ON TOP OF A SUBSCRIPTION  (v3.1.45 -- TD-938)
// Spec: claude/GIFT_CERTIFICATES_SPEC.md section 11.
//
// Ian, 2026-10-01: "I really don't like passes ending existing subscriptions."
//
// ONE RULE FOR BOUGHT AND GIFTED PASSES, decided here and nowhere else:
//
//   Platinum subscriber   bought: the subscription stops renewing (what it always did) and the
//                         pass starts when the paid-up period ends. They confirm this first.
//                         gifted: refused earlier -- they take the tokens (services/gifts.js).
//   Silver / Gold         Platinum starts NOW (after any pass they already hold), and Stripe
//                         pauses their billing until the pass ends; it restarts by itself. No
//                         choice: Ian, 2026-10-01, "I can't see anyone wanting to [keep paying]...
//                         They only get the tokens out of the deal and they can always buy more
//                         cheaper." Already paused for an earlier pass: the pause is extended.
//   anyone else           The pass stacks after any paid-up period. A bought pass still stops a
//                         stray billing subscription exactly as before; a gift never touches one.
//
// THE SAFETY ORDER IS THE CALLER'S, AND IT NEVER CHANGES: the pass and its tokens are written FIRST,
// and Stripe is asked to pause AFTER. If Stripe refuses, the customer has their pass and is still
// billed -- visible, reversible, and Ian is emailed. Pausing first could stop billing and grant nothing.
// ============================================================================
'use strict';

function isFuture(v, nowMs) {
  if (!v) return false;
  const t = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
  return isFinite(t) && t > (nowMs || Date.now());
}

// row: users columns tier, stripe_subscription_id, subscription_status, cancel_at_period_end,
// current_period_end, sub_paused_until. Pure, so the guard can drive it.
// Returns { sub, action, stackPeriodEnd, alreadyPaused }:
//   action: 'cancel' | 'pause' | 'none'   (choice is accepted for old callers and ignored)
//   stackPeriodEnd: what to pass as the third argument of passStackFrom (null = start now)
function planForPass(row, choice, opts) {
  opts = opts || {};
  const subscriptionState = require('../gifts').subscriptionState;
  const sub = subscriptionState(row);
  const alreadyPaused = isFuture(row && row.sub_paused_until, opts.nowMs);
  if (sub === 'platinum') {
    return { sub: sub, action: opts.gift ? 'none' : 'cancel', stackPeriodEnd: row.current_period_end || null, alreadyPaused: alreadyPaused };
  }
  if (sub === 'silver' || sub === 'gold') {
    return { sub: sub, action: 'pause', stackPeriodEnd: null, alreadyPaused: alreadyPaused };
  }
  // No subscription we would keep. A bought pass still stops one that can bill and is not already
  // stopping (the pre-3.1.45 behaviour, for odd states such as a billing sub on a Copper tier row).
  const SUB_CAN_BILL = require('../gifts').SUB_CAN_BILL;
  const canBill = !!(row && row.stripe_subscription_id) && SUB_CAN_BILL.indexOf(String(row.subscription_status || '')) >= 0 && row.cancel_at_period_end !== true;
  return { sub: 'none', action: (!opts.gift && canBill) ? 'cancel' : 'none', stackPeriodEnd: (row && row.current_period_end) || null, alreadyPaused: alreadyPaused };
}

// Ask Stripe to pause until the pass ends, then record the date. Throws on failure: the CALLER
// decides how loudly to fail, and must never let this undo a pass that was already granted.
async function pauseForPass(db, userId, subId, untilIso, deps) {
  deps = deps || {};
  const provider = deps.stripeProvider || require('./stripeProvider');
  const resumesAt = Math.floor(new Date(untilIso).getTime() / 1000);
  await provider.pauseSubscriptionCollection(subId, resumesAt);
  await db.prepare('UPDATE users SET sub_paused_until = ? WHERE id = ?').run(new Date(resumesAt * 1000).toISOString(), userId);
  return resumesAt;
}

// One sentence for the receipt and the success screen. tierName: 'Gold' etc.
function describePlan(plan, tierName, untilIso) {
  const nice = function (iso) {
    try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }); } catch (e) { return String(iso).slice(0, 10); }
  };
  if (!plan) return '';
  if (plan.action === 'pause') return tierName + ' paused until ' + nice(untilIso) + ', then it restarts by itself';
  if (plan.action === 'cancel' && plan.sub === 'platinum') return 'Platinum subscription stops renewing at the end of this period';
  return '';
}

module.exports = { planForPass, pauseForPass, describePlan, isFuture };
