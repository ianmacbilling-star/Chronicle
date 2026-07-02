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

module.exports = { friendlyImageError, friendlyError, statusOf, isSafetyBlock, msgOf };
