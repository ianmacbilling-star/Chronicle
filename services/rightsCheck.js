// ============================================================
// UPLOAD RIGHTS CHECK -- v3.1.90, TD-979 (spec claude/UPLOAD_RIGHTS_CHECK_SPEC.md).
// ============================================================
//
// Ian's rules, 2026-10-16: watermarks are REJECTED, signatures WARN. A rejected picture stays in its
// slot with a red note until it is replaced. Pictures already in the system are not checked.
//
// TWO CHECKS, ONE VERDICT PER PICTURE:
//   metadata (services/imageMetadata.js) -- free, every upload path, read from the original bytes;
//   vision (visionCheck below)           -- one small Haiku call, for the paths that have no AI
//                                           analysis of their own (assets, Upload your own on a panel).
//                                           Characters and style samples are looked at inside the
//                                           analysis they already get (v3.1.91).
//
// THE VERDICT IS KEYED ON THE PICTURE'S URL, in image_rights. A replaced picture has a new URL and so
// no verdict -- which is exactly "stays until replaced" with nothing to clear. A copy of a picture
// (archive, restore, crop) inherits its source's verdict (inherit()), so copying a rejected picture
// does not launder it.
//
// FAILS OPEN. A vision call that errors, times out or answers nonsense records nothing and blocks
// nothing: an unanswered question must never refuse a customer's picture. Only 'warn' and 'reject'
// are stored; 'ok' is the absence of a row.
'use strict';
var meta = require('./imageMetadata');

var VISION_TIMEOUT_MS = 20000;
var VISION_MAX_SIDE = 1568;   // the size Haiku looks at anyway; anything larger is shrunk by the API

var VISION_SYSTEM =
  'You check ONE uploaded picture for marks of ownership before it is used in a storybook. ' +
  'Answer ONLY with a JSON object, no prose, no code fence: ' +
  '{"watermark": true|false, "watermark_text": "...", "signature": true|false, "signature_text": "..."}. ' +
  'A WATERMARK is text or a logo laid over the picture to mark who owns it or where it came from: a stock ' +
  'library mark (Shutterstock, Getty Images, iStock, Adobe Stock, Alamy, Dreamstime, Depositphotos, 123RF and ' +
  'similar), a website address or social media handle stamped on the picture, a copyright notice, a ' +
  '"sample", "preview" or "proof" stamp, or a faint logo repeated across the picture. ' +
  'A SIGNATURE is an artist’s signature, initials or monogram drawn into the artwork, usually small and in a corner. ' +
  'NEITHER: writing that belongs to the scene (shop signs, book covers, labels on objects, speech bubbles, ' +
  'captions that are part of a comic page, game interface text), a camera date stamp, and a plain border. ' +
  'If you are not reasonably sure, answer false. Put the words you can read in the _text fields, or "" if none.';

var _fetch = function () { return fetch.apply(null, arguments); };   // replaceable in tests

function normUrl(u) { return String(u || '').split('#')[0].split('?')[0].trim(); }

function worst(a, b) {
  var rank = { ok: 0, unchecked: 0, warn: 1, reject: 2 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

// Combine any number of results ({ verdict, reasons }) into one.
function combine() {
  var out = { verdict: 'ok', reasons: [] };
  for (var i = 0; i < arguments.length; i++) {
    var r = arguments[i];
    if (!r) continue;
    out.verdict = worst(out.verdict, r.verdict || 'ok');
    (r.reasons || []).forEach(function (x) { out.reasons.push(x); });
  }
  return out;
}

function metadataCheck(buf) {
  try { var r = meta.checkBuffer(buf); return { verdict: r.verdict, reasons: r.reasons }; }
  catch (e) { return { verdict: 'ok', reasons: [] }; }
}

// Read a JSON object out of a model reply.
function parseReply(text) {
  var s = String(text || '');
  var a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { var o = JSON.parse(s.slice(a, b + 1)); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; }
}

function truthy(v) { return v === true || v === 'true' || v === 1; }

// A model answer -> a verdict. Exported so the analysis paths (v3.1.91) read answers the same way.
function verdictFromAnswer(o) {
  if (!o) return { verdict: 'unchecked', reasons: [] };
  var reasons = [];
  var wt = String(o.watermark_text || '').trim().slice(0, 120);
  var st = String(o.signature_text || '').trim().slice(0, 120);
  if (truthy(o.watermark)) reasons.push({ source: 'vision', kind: 'watermark', text: 'This picture has a watermark' + (wt ? (' (“' + wt + '”)') : '') + '.' });
  if (truthy(o.signature)) reasons.push({ source: 'vision', kind: 'signature', text: 'This picture looks signed' + (st ? (' (“' + st + '”)') : '') + '.' });
  var verdict = truthy(o.watermark) ? 'reject' : (truthy(o.signature) ? 'warn' : 'ok');
  return { verdict: verdict, reasons: reasons };
}

// One Haiku look at the picture. buf: image bytes. Returns { verdict, reasons } and never throws.
async function visionCheck(buf, ctx) {
  ctx = ctx || {};
  try {
    var key = process.env.ANTHROPIC_API_KEY;
    if (!key || !buf || !buf.length) return { verdict: 'unchecked', reasons: [] };
    var sharp = require('sharp');
    var small = await sharp(buf, { failOn: 'none' }).rotate()
      .resize({ width: VISION_MAX_SIDE, height: VISION_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    // Haiku by default (about 0.2 of a cent a picture). RIGHTS_MODEL in Railway switches it, for example
    // to Sonnet if Haiku misses small signatures, without a deploy.
    var model = process.env.RIGHTS_MODEL || require('../config/models').HELP_MODEL;
    var ac = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { ac.abort(); }, VISION_TIMEOUT_MS) : null;
    var resp;
    try {
      resp = await _fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: model, max_tokens: 200, system: VISION_SYSTEM,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: small.toString('base64') } },
            { type: 'text', text: 'Check this picture.' }
          ] }]
        }),
        signal: ac ? ac.signal : undefined
      });
    } finally { if (timer) clearTimeout(timer); }
    var data = await resp.json();
    if (!data || data.error) { console.warn('[rights] vision check failed: ' + ((data && data.error && data.error.message) || 'no reply')); return { verdict: 'unchecked', reasons: [] }; }
    var text = (data.content || []).map(function (b) { return b.text || ''; }).join('');
    var r = verdictFromAnswer(parseReply(text));
    // Free to the user (Ian, 2026-10-16) but recorded, like the other calls made on the house.
    if (ctx.userId) {
      try {
        await require('../routes/tokens').recordGeneration(ctx.userId, { event_type: 'upload_rights_check', tokens_redeemed: 0, quantity: 1, unit: 'picture', model: model, related_campaign_id: ctx.campaignId || null });
      } catch (e) { /* non-fatal */ }
    }
    return r;
  } catch (e) {
    console.warn('[rights] vision check error: ' + ((e && e.message) || e));
    return { verdict: 'unchecked', reasons: [] };
  }
}

// ---------------------------------------------------------------- storage ---------------------
async function db() { return await require('../database/db').getDb(); }

// Store a verdict for a stored picture. 'ok' and 'unchecked' store nothing.
async function record(url, result, ctx) {
  ctx = ctx || {};
  var u = normUrl(url);
  if (!u || !result || (result.verdict !== 'warn' && result.verdict !== 'reject')) return;
  try {
    var d = await db();
    await d.prepare(
      'INSERT INTO image_rights (image_url, verdict, reasons, user_id, campaign_id, kind, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (image_url) DO UPDATE SET verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons, checked_at = EXCLUDED.checked_at'
    ).run(u, result.verdict, JSON.stringify(result.reasons || []), ctx.userId || null, ctx.campaignId || null, ctx.kind || null, new Date().toISOString());
  } catch (e) { console.error('[rights] could not record verdict for ' + u + ': ' + ((e && e.message) || e)); }
}

// url -> { verdict, reasons } for the ones that have a verdict. Never throws.
async function lookup(urls) {
  var out = {};
  var list = (urls || []).map(normUrl).filter(Boolean);
  if (!list.length) return out;
  var uniq = list.filter(function (u, i) { return list.indexOf(u) === i; }).slice(0, 500);
  try {
    var d = await db();
    var _st = d.prepare(
      'SELECT image_url, verdict, reasons FROM image_rights WHERE image_url IN (' + uniq.map(function () { return '?'; }).join(',') + ')'
    );
    var rows = await _st.all.apply(_st, uniq);
    (rows || []).forEach(function (r) {
      var reasons = [];
      try { reasons = typeof r.reasons === 'string' ? JSON.parse(r.reasons) : (r.reasons || []); } catch (e) { reasons = []; }
      out[r.image_url] = { verdict: r.verdict, reasons: reasons };
    });
  } catch (e) { console.error('[rights] lookup failed: ' + ((e && e.message) || e)); }
  return out;
}

// A copy of a picture carries its source's verdict. Fire and forget; never throws.
async function inherit(srcUrl, dstUrl) {
  try {
    var s = normUrl(srcUrl), t = normUrl(dstUrl);
    if (!s || !t || s === t) return;
    var found = await lookup([s]);
    if (found[s]) await record(t, found[s], { kind: 'copy' });
  } catch (e) { /* non-fatal */ }
}

// The whole upload-time check for one stored picture.
//   file: the multer file (its rightsMeta was read from the ORIGINAL bytes by uploadGuard), or null
//   visionBuf: bytes to look at, or null to skip the vision call
// Returns the combined { verdict, reasons } and records it against url.
async function checkUpload(url, file, visionBuf, ctx) {
  var m = (file && file.rightsMeta) ? file.rightsMeta : (file && file.buffer ? metadataCheck(file.buffer) : null);
  var v = visionBuf ? await visionCheck(visionBuf, ctx) : null;
  var r = combine(m, v);
  if (url) await record(url, r, ctx);
  return { verdict: r.verdict, reasons: r.reasons };
}

// The shape a route adds to its response: only pictures with something to say.
function responseRights(map) {
  var items = [];
  Object.keys(map || {}).forEach(function (u) {
    var r = map[u];
    if (r && (r.verdict === 'warn' || r.verdict === 'reject')) items.push({ url: u, verdict: r.verdict, reasons: r.reasons || [] });
  });
  return items;
}

module.exports = {
  metadataCheck: metadataCheck, visionCheck: visionCheck, verdictFromAnswer: verdictFromAnswer, parseReply: parseReply,
  combine: combine, record: record, lookup: lookup, inherit: inherit, checkUpload: checkUpload,
  responseRights: responseRights, normUrl: normUrl, VISION_SYSTEM: VISION_SYSTEM,
  _setFetch: function (f) { _fetch = f; }
};
