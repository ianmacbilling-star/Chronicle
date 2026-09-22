// middleware/friendlyErrors.js
//
// Central, user-facing error mapper for Chronicle. Pure functions -- no imports,
// no side effects, no DB -- so any route or helper can require it without risk of
// circular dependencies. The rule everywhere: the technical detail stays in the
// logs (console.error / logDebug at the call site); these return ONLY a friendly
// line for the user, and NEVER the raw e.message.

// Best-effort HTTP-ish status off whatever was thrown -- the fal client, fetch,
// the Anthropic SDK, or a bare Error whose message embeds the code (the fal
// client throws 'Unexpected status code: 422').
function statusOf(e) {
  if (!e) return 0;
  var s = e.status || e.statusCode || (e.response && e.response.status) || 0;
  if (!s && typeof e.message === 'string') {
    var m = e.message.match(/\b(4\d\d|5\d\d)\b/);
    if (m) s = parseInt(m[1], 10);
  }
  return s || 0;
}

function msgOf(e) { return (e && e.message) ? String(e.message).toLowerCase() : ''; }

// True when the failure is a content/safety-filter rejection (fal 422, or our
// own blank-image / NSFW signal thrown from the generate helpers).
function isSafetyBlock(e) {
  var m = msgOf(e);
  return m.indexOf('safety filter') !== -1 || m.indexOf('nsfw') !== -1 ||
    m.indexOf('flagged') !== -1 || m.indexOf('content policy') !== -1 ||
    m.indexOf('content filter') !== -1 || m.indexOf('content_policy') !== -1;
}

var IMG_SAFETY = 'This picture could not be created -- the scene was flagged by the image service content filter. Try rewording the prompt (for example, describing characters as fully clothed, or the scene less literally).';
var IMG_BUSY = 'The image service is busy right now. Give it a moment and try again.';
var IMG_AUTH = 'The image service rejected our credentials. This is on our end -- please let us know if it keeps happening.';
var IMG_TEMP = 'The image service had a temporary problem. Please try again in a moment.';
var IMG_GENERIC = 'The image could not be generated right now. Please try again.';

// Map an image-generation failure (fal, sync or via the webhook payload) to a
// friendly line. Accepts a real thrown error OR a synthetic { message, status }.
function friendlyImageError(e) {
  if (isSafetyBlock(e)) return IMG_SAFETY;
  var s = statusOf(e);
  if (s === 422) return IMG_SAFETY;
  if (s === 429) return IMG_BUSY;
  if (s === 401 || s === 403) return IMG_AUTH;
  if (s >= 500) return IMG_TEMP;
  var m = msgOf(e);
  if (m.indexOf('no image') !== -1 || m.indexOf('no edited') !== -1 || m.indexOf('no reference') !== -1) return IMG_TEMP;
  if (!s && (m.indexOf('timeout') !== -1 || m.indexOf('network') !== -1 || m.indexOf('econn') !== -1 || m.indexOf('fetch failed') !== -1 || m.indexOf('socket hang') !== -1)) return IMG_TEMP;
  return IMG_GENERIC;
}

// Generic fallback for everything that is NOT an image or Anthropic error (DB,
// validation, storage, etc.). Recognizes a couple of transient infra shapes but
// otherwise returns the caller-supplied fallback -- never the raw e.message.
function friendlyError(e, fallback) {
  var s = statusOf(e);
  if (s === 429) return 'The service is busy right now. Please try again in a moment.';
  if (s >= 500) return 'Something went wrong on our end. Please try again in a moment.';
  return fallback || 'Something went wrong. Please try again.';
}

// The Anthropic error type, if the caller passed Anthropic's { type, message }
// error object (from a raw fetch's data.error) or an SDK-shaped error.
function anthropicType(e) {
  if (!e) return '';
  var t = e.type || (e.error && e.error.type) || '';
  return String(t).toLowerCase();
}

var AI_BUSY = 'The AI is handling a lot of requests right now. Please wait a moment and try again.';
var AI_OVERLOADED = 'The AI service is temporarily overloaded. Please try again in a minute.';
var AI_AUTH = 'The AI service rejected our credentials. This is on our end -- please let us know if it keeps happening.';
var AI_TOOLONG = 'There was too much text for the AI to handle at once. Try a shorter session, or trim the transcript, and try again.';
var AI_TEMP = 'The AI service had a temporary problem. Please try again in a moment.';
var AI_GENERIC = 'The AI could not complete that right now. Please try again.';

// Map an Anthropic failure to a friendly line. Accepts a thrown error OR the
// Anthropic { type, message } error object passed through from data.error.
function friendlyAnthropicError(e) {
  var t = anthropicType(e);
  var m = msgOf(e);
  var s = statusOf(e);
  if (t === 'rate_limit_error' || s === 429) return AI_BUSY;
  if (t === 'overloaded_error' || s === 529 || m.indexOf('overloaded') !== -1) return AI_OVERLOADED;
  if (t === 'authentication_error' || t === 'permission_error' || s === 401 || s === 403) return AI_AUTH;
  if (t === 'invalid_request_error' || s === 400) {
    if (m.indexOf('too long') !== -1 || m.indexOf('context') !== -1 || m.indexOf('maximum') !== -1 || m.indexOf('token') !== -1) return AI_TOOLONG;
    return AI_GENERIC;
  }
  if (s >= 500) return AI_TEMP;
  if (m.indexOf('rate limit') !== -1 || m.indexOf('rate_limit') !== -1) return AI_BUSY;
  if (m.indexOf('too long') !== -1 || m.indexOf('context length') !== -1) return AI_TOOLONG;
  if (!s && (m.indexOf('timeout') !== -1 || m.indexOf('network') !== -1 || m.indexOf('econn') !== -1 || m.indexOf('fetch failed') !== -1 || m.indexOf('socket hang') !== -1)) return AI_TEMP;
  return AI_GENERIC;
}

// v3.0.877 -- TD-754. A PRINT FAILURE THAT SAYS WHICH FAILURE IT WAS.
//
// Every print route called friendlyError(e, '') -- and an EMPTY fallback is falsy, so it
// fell to the generic line. A rejected product code, a credential failure and a refused
// address all reached the reader as the same eleven words, which is why a real support
// report arrived as "it just said it couldn't get the price".
//
// IT CLASSIFIES ON EXPLICIT FLAGS, NEVER ON MESSAGE TEXT. That is TD-512's rule: a
// runtime classifier built on wording breaks the moment the wording changes or arrives
// in another language. statusOf() above regex-matches any three-digit number in the
// message, which is fine as a last resort and wrong as a first one -- a vendor body
// quoting "400 pages" would classify itself. So e.status is read directly here, and the
// provider now sets authFailure / refused / inconclusive / podPackageId explicitly.
//
// EVERY BRANCH CAN SAY "nothing has been charged" HONESTLY: both callers (/quote and
// /order) sit entirely before the Stripe Checkout redirect, so no card has been touched
// on any path that reaches this function. Do not copy that sentence to a route where it
// is not true.
var PR_AUTH = 'We could not sign in to the print service. That is on our end, not yours -- nothing has been charged, and we would like to know if it keeps happening.';
var PR_SKU = 'The print service did not accept this combination of binding, paper and colour for a book this long. Nothing has been charged. Please try a different format -- and tell us which one you picked, because that is the part we need.';
var PR_NOANSWER = 'The print service did not answer in time. Nothing has been charged. Please wait a minute and try again.';
var PR_BUSY = 'The print service is busy right now. Nothing has been charged. Please wait a moment and try again.';
// v3.0.974 -- TD-879. The opening sentence is gone. The reader is already looking at a
// failure, so a sentence whose whole content is that it failed carries nothing -- and it
// crowded out the part that could have told them what to fix.
var PR_REFUSED = 'The printer would not accept this order and did not say which part. Nothing has been charged. Please check the shipping address and the format, then try again.';

// The fields Lulu names in a validation body, in words a reader can act on. WHITELIST:
// anything not in here is not shown, so no vendor jargon can reach a customer and an
// unrecognised body falls back to the general sentence rather than to a guess.
var PR_FIELD_WORDS = {
  name: 'the full name',
  street1: 'the street address',
  street2: 'the second address line',
  city: 'the city',
  postcode: 'the postal code',
  state_code: 'the state or province',
  country_code: 'the country',
  phone_number: 'the phone number',
  shipping_address: 'the shipping address'
};

// Lulu answers a bad request with {"field":["why"]}, sometimes nested one level under
// shipping_address, and _fetch keeps that body in the message. Depth-limited and
// whitelisted; ANY failure to understand it returns '' and the caller says the general
// thing instead. A parse that throws must never cost a reader their error message.
// v3.0.975 -- TD-880. THE VENDOR'S OWN SENTENCE, WHEN IT IS FIT TO SHOW.
//
// Ian: "those messages look fine to give to the user. That way we don't have to
// interpret it." They are better than ours -- Lulu says which range a postcode should
// fall in, which we have no way of knowing. But a vendor string is not ours to promise,
// so it passes only if it is short, printable ASCII and carries nothing that reads as
// internals. Anything else is dropped and the field name goes out on its own.
function usableReason(msg) {
  var t = String(msg || '').trim();
  if (t.length < 4 || t.length > 200) return '';
  if (/[<>{}]|https?:|pod_package|_id\b|null|undefined|Traceback|Exception/i.test(t)) return '';
  if (!/^[\x20-\x7E]+$/.test(t)) return '';
  return t.replace(/\s+$/, '').replace(/\.$/, '');
}

// v3.0.975 -- TD-880. BOTH SHAPES, BECAUSE ONLY ONE OF THEM WAS EVER MEASURED.
//
// SHAPE A is what the cost endpoint really sends, from Ian's log:
//   {"shipping_address":{"detail":{"errors":[{"code":"INVALID","path":"postcode",
//    "message":"Postal code entered does not match the city or state..."}]}}}
// an errors[] of OBJECTS with a `path` and a human `message`.
//
// SHAPE B is {"field":["reason"]}, which the cover-dimensions endpoint uses. v3.0.974
// implemented ONLY shape B -- copied from a comment about that other endpoint -- so the
// whole feature was dead on arrival and every refusal fell back. Shape B is kept rather
// than replaced: swapping one unverified assumption for another is the same mistake.
//
// Returns an array of { word, why } or null. Never throws: a body we cannot read must
// cost the reader their diagnosis, never their error message.
function refusedFields(e) {
  try {
    var m = String((e && e.message) || '');
    var i = m.indexOf('{');
    if (i < 0) return null;
    var body = JSON.parse(m.slice(i));
    var found = [];
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return;
      // No special case for arrays: Object.keys yields their indices and the generic
      // recursion below already descends into each element. An explicit Array.isArray
      // branch was written here first and deleted -- the mutation harness could not make
      // its removal fail a single check, which is what redundant means.
      if (typeof o.path === 'string' && PR_FIELD_WORDS[o.path]) {          // shape A
        found.push({ word: PR_FIELD_WORDS[o.path], why: usableReason(o.message) });
        return;
      }
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'string') {    // shape B
          // The container is never an answer on its own -- the general sentence says
          // that better -- so it is skipped rather than filtered out afterwards.
          if (PR_FIELD_WORDS[k] && k !== 'shipping_address') found.push({ word: PR_FIELD_WORDS[k], why: usableReason(v[0]) });
        } else if (v && typeof v === 'object') walk(v, depth + 1);
      });
    })(body, 0);
    if (!found.length) return null;
    var seen = {}, uniq = [];
    found.forEach(function (f) { if (!seen[f.word]) { seen[f.word] = 1; uniq.push(f); } });
    return uniq;
  } catch (x) { return null; }
}

function friendlyPrintError(e, what) {
  var noun = (what === 'order') ? 'start your order' : 'get a price from the print service';
  var generic = 'We could not ' + noun + ' just now. Nothing has been charged. Please try again in a moment -- if it keeps happening, turn on Debug Mode in Settings, do it once more, and send us the log.';
  if (!e) return generic;
  if (e.authFailure) return PR_AUTH;
  if (e.podPackageId) return PR_SKU;
  var s = Number(e.status) || 0;
  if (s === 429) return PR_BUSY;
  if (e.inconclusive) return PR_NOANSWER;
  if (e.refused || (s >= 400 && s < 500)) {
    var f = refusedFields(e);
    if (!f) return PR_REFUSED;
    var words = f.map(function (x) { return x.word; }).join(', ').replace(/, ([^,]*)$/, ' and $1');
    // ONE reason, not every reason: two vendor sentences in a row stop being read.
    // The first is the one attached to the first field named, which is the one the
    // reader will look at first.
    var why = f.filter(function (x) { return x.why; }).map(function (x) { return x.why; })[0];
    return 'The printer would not accept ' + words + '.' + (why ? ' It says: ' + why + '.' : '') +
           ' Nothing has been charged. Please correct that and try again.';
  }
  if (s >= 500) return PR_NOANSWER;
  return generic;
}

module.exports = { friendlyImageError, friendlyAnthropicError, friendlyError, friendlyPrintError, statusOf, isSafetyBlock, msgOf };
