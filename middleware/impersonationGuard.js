// =================================================================================================
// IMPERSONATION DENY LIST -- TD-179 STAGE 3, v3.0.589.
// Spec: ADMIN_IMPERSONATION_SPEC.md section 5.
//
// ENFORCED IN MIDDLEWARE, NEVER MERELY HIDDEN IN THE UI. A hidden button is not a control: the
// route is still there, and the whole point of this feature is that a support session is a real
// authenticated session with a real user's id in it.
//
// THIS IS ONE HALF OF WHAT MAKES THE PRIVACY CLAUSE TRUE. The clause promises that staff "cannot
// make purchases, place orders, change your email or password, or delete your account" while
// helping you. That sentence is only honest if this file actually refuses those things, and if the
// audit table records who was in the account. Neither may ship without the other.
//
// -------------------------------------------------------------------------------------------
// WHAT IS ALLOWED, AND WHY -- these are Ian's decisions of 2026-08-09, and they NARROW the spec.
//
//   TOKEN SPEND IS ALLOWED. The spec proposed denying it. Ian: he needs to reproduce the failing
//   thing, and "a user has trouble doing something that costs tokens, I go in there, do what I can
//   to fix it... I want to just be able to give them back the tokens and even more for their
//   trouble." Denying spend would remove most of the point of the feature. The spend lands on the
//   USER's balance because it is their book and their images; when the session closes, the tokens
//   spent during it are totalled FROM token_ledger and written to the audit row (auth.js,
//   endImpersonation) so the admin can hand them back without guessing. Add Tokens works from
//   inside via requireImpersonatorOrAdmin.
//
//   LULU IS ALLOWED UP TO THE PURCHASE STEP. Ian: "I should be able to at least tee up books all
//   the way to the purchase step." Quote, cover, interior and the order form all work; only the
//   placement is refused. That is the narrowest line that still holds the rule -- the irreversible,
//   money-moving, physical-object step is the one that must be blocked, and everything before it is
//   diagnosis.
//
// STRIPE STAYS FULLY DENIED. That is the customer's card, and there is no diagnostic value in
// reaching a checkout that would charge it.
// -------------------------------------------------------------------------------------------
//
// MATCHED ON METHOD + PATH, and deliberately written as explicit entries rather than clever
// patterns: a rule you cannot read is a rule nobody will maintain. The paths below are the mounted
// paths as they appear in server.js, so they are checked against the same string Express routed on.
//
// FAIL CLOSED ON THE UNKNOWN? NO -- AND THAT IS A DELIBERATE CHOICE WORTH DEFENDING.
// A default-deny list would refuse every route nobody thought about, which sounds safer and is not:
// it would break diagnosis constantly, and the failure would be silent-ish and infuriating, so the
// pressure would be to widen it until it meant nothing. The dangerous surface here is SMALL and
// enumerable -- money, credentials, deletion, publication -- and it is enumerated. Anything added
// later that moves money or destroys data must be added here, which is why the list carries this
// note rather than a shrug.

var DENY = [
  // --- Stripe. Real money, on someone else's card. ---
  { m: 'POST', p: '/api/tokens/checkout',           why: 'buy a token pack' },
  { m: 'POST', p: '/api/tokens/subscribe',          why: 'start a subscription' },
  { m: 'POST', p: '/api/tokens/change-plan',        why: 'change a subscription' },
  { m: 'POST', p: '/api/tokens/portal',             why: 'open the billing portal' },
  { m: 'POST', p: '/api/tokens/sync-subscription',  why: 'resync billing' },

  // --- Lulu. Real money AND a physical object shipped to a real address. ---
  // /api/print/quote, /novel-info, /options and the interior and cover renders are ALLOWED: they
  // are how you diagnose a print problem, and none of them buys anything.
  { m: 'POST', p: '/api/print/order',               why: 'place a print order' },

  // --- Credentials. An account-takeover path if this is ever misused. ---
  { m: 'PUT',  p: '/api/auth/password',             why: 'change the password' },
  { m: 'POST', p: '/api/auth/password',             why: 'change the password' },
  { m: 'POST', p: '/api/auth/change-email',         why: 'change the email' },
  { m: 'POST', p: '/api/auth/forgot-password',      why: 'trigger a password reset' },
  { m: 'POST', p: '/api/auth/reset-password',       why: 'reset the password' },

  // --- Irreversible account actions. ---
  { m: 'POST',   p: '/api/auth/suspend',            why: 'suspend the account' },
  { m: 'DELETE', p: '/api/auth/account',            why: 'delete the account' },

  // --- Publication. Putting someone else's work in public, under their name. ---
  // Publishing is a SNAPSHOT and cannot be taken back cleanly, so it is the customer's decision.
  { m: 'POST', p: '/api/pdf/publish-story',         why: 'publish to the Library', prefix: true },
  { m: 'POST', p: '/api/pdf/unpublish-story',       why: 'unpublish from the Library', prefix: true },
  { m: 'POST', p: '/api/pdf/story',                 why: 'unpublish from the Library', prefix: true, suffix: '/unpublish' }
];

function deniedEntry(method, path) {
  var m = String(method || '').toUpperCase();
  var p = String(path || '').split('?')[0].replace(/\/+$/, '');
  for (var i = 0; i < DENY.length; i++) {
    var d = DENY[i];
    if (d.m !== m) continue;
    if (d.suffix) {
      if (p.indexOf(d.p) === 0 && p.slice(-d.suffix.length) === d.suffix) return d;
      continue;
    }
    if (d.prefix) { if (p.indexOf(d.p) === 0) return d; continue; }
    if (p === d.p) return d;
  }
  return null;
}

// Mounted ONCE, high, so a route group added later is covered without anyone remembering to wire it.
// Returns 403 with a message written for the ADMIN, not the user -- nobody else can ever see it.
function impersonationGuard(req, res, next) {
  if (!req.session || !req.session.impersonatorId) return next();
  var hit = deniedEntry(req.method, req.originalUrl || req.url);
  if (!hit) return next();
  try {
    console.warn('[impersonate] refused ' + req.method + ' ' + (req.originalUrl || req.url) +
      ' -- ' + (req.session.impersonatorEmail || 'an admin') + ' is viewing as ' +
      (req.session.impersonateTargetEmail || ('user ' + req.session.userId)));
  } catch (e) {}
  return res.status(403).json({
    error: 'impersonation_denied',
    message: 'Not available while viewing as another user (' + hit.why + '). Exit the support session first.'
  });
}

module.exports = impersonationGuard;
module.exports.deniedEntry = deniedEntry;
module.exports.DENY = DENY;
