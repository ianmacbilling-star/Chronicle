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
var PR_REFUSED = 'The print service refused this request. Nothing has been charged. Please check the shipping address and the format, then try again.';

function friendlyPrintError(e, what) {
  var noun = (what === 'order') ? 'start your order' : 'get a price from the print service';
  var generic = 'We could not ' + noun + ' just now. Nothing has been charged. Please try again in a moment -- if it keeps happening, turn on Debug Mode in Settings, do it once more, and send us the log.';
  if (!e) return generic;
  if (e.authFailure) return PR_AUTH;
  if (e.podPackageId) return PR_SKU;
  var s = Number(e.status) || 0;
  if (s === 429) return PR_BUSY;
  if (e.inconclusive) return PR_NOANSWER;
  if (e.refused || (s >= 400 && s < 500)) return PR_REFUSED;
  if (s >= 500) return PR_NOANSWER;
  return generic;
}

module.exports = { friendlyImageError, friendlyAnthropicError, friendlyError, friendlyPrintError, statusOf, isSafetyBlock, msgOf };
