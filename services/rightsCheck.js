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

// v3.1.91 -- WHAT A WATERMARK AND A SIGNATURE ARE, in one place: the upload check below, the character
// prompt build (routes/characters.js) and style Analyze (routes/artStyles.js) all ask the same question.
var RIGHTS_DEFINITIONS =
  'A WATERMARK is text or a logo laid over the picture to mark who owns it or where it came from: a stock ' +
  'library mark (Shutterstock, Getty Images, iStock, Adobe Stock, Alamy, Dreamstime, Depositphotos, 123RF and ' +
  'similar), a website address or social media handle stamped on the picture, a copyright notice, a ' +
  '"sample", "preview" or "proof" stamp, or a faint logo repeated across the picture. ' +
  'A SIGNATURE is an artist’s signature, initials or monogram drawn into the artwork, usually small and in a corner. ' +
  'NEITHER: writing that belongs to the scene (shop signs, book covers, labels on objects, speech bubbles, ' +
  'captions that are part of a comic page, game interface text), a camera date stamp, and a plain border. ' +
  'If you are not reasonably sure, answer false.';

var VISION_SYSTEM =
  'You check ONE uploaded picture for marks of ownership before it is used in a storybook. ' +
  'Answer ONLY with a JSON object, no prose, no code fence: ' +
  '{"watermark": true|false, "watermark_text": "...", "signature": true|false, "signature_text": "..."}. ' +
  RIGHTS_DEFINITIONS + ' Put the words you can read in the _text fields, or "" if none.';

// v3.1.91 -- the line the character prompt build asks for after its description, one entry per picture.
var RIGHTS_LINE_INSTRUCTION =
  'Then, on ONE final line of its own, write RIGHTS: followed by a JSON array with one object per reference ' +
  'image above, in the order given: {"watermark": true|false, "watermark_text": "", "signature": true|false, ' +
  '"signature_text": ""}. ' + RIGHTS_DEFINITIONS + ' Nothing about this line goes into the description itself.';

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

// v3.2.81 -- TD-1016. A CAMERA DATE STAMP IS NOT A WATERMARK. Ian, 2026-10-25: "Dates don't count." The
// definition above already says so and Haiku still flagged a 2006 snapshot's "11/16/2006" (and misread it as
// 11/15/2006), so asking harder is not the fix -- the same lesson as the AI-tool credits in v3.2.17. A watermark
// whose ONLY readable text is a date and/or time is not counted. One with no text, or any word, name, handle,
// web address or symbol beside the date, still is.
var MONTH_WORDS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(rs(day)?)?|fri(day)?|sat(urday)?|sun(day)?)\.?\b/g;
function isDateStampText(t) {
  var s = String(t || '').toLowerCase().replace(/["\u201c\u201d]/g, '').trim();
  if (!s) return false;
  var hadMonth = MONTH_WORDS.test(s); MONTH_WORDS.lastIndex = 0;
  s = s.replace(MONTH_WORDS, ' ').replace(/\b(a\.?m\.?|p\.?m\.?)(?=\s|$)/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  if (!/^[\d\s\/.\-:,'\u2019]+$/.test(s)) return false;
  var groups = s.match(/\d+/g) || [];
  return groups.length >= 2 || (hadMonth && groups.length >= 1);
}

// A model answer -> a verdict. Exported so the analysis paths (v3.1.91) read answers the same way.
function verdictFromAnswer(o) {
  if (!o) return { verdict: 'unchecked', reasons: [] };
  var reasons = [];
  var wt = String(o.watermark_text || '').trim().slice(0, 120);
  var st = String(o.signature_text || '').trim().slice(0, 120);
  var wm = truthy(o.watermark) && !isDateStampText(wt);   // v3.2.81 -- TD-1016: dates don't count
  if (wm) reasons.push({ source: 'vision', kind: 'watermark', text: 'This picture has a watermark' + (wt ? (' (“' + wt + '”)') : '') + '.' });
  if (truthy(o.signature)) reasons.push({ source: 'vision', kind: 'signature', text: 'This picture looks signed' + (st ? (' (“' + st + '”)') : '') + '.' });
  var verdict = wm ? 'reject' : (truthy(o.signature) ? 'warn' : 'ok');
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
            { type: 'text', text: 'Check this picture.' + (ctx.hint ? ' ' + ctx.hint : '') }   // v3.1.99: a hint for lettering references
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
    if (result.verdict === 'reject') _rejected.add(u); else _rejected.delete(u);   // v3.1.92: the books see it at once
  } catch (e) { console.error('[rights] could not record verdict for ' + u + ': ' + ((e && e.message) || e)); }
}

// ---------------------------------------------------------------- the book ------------------------
// v3.1.92 -- TD-979. A REJECTED PICTURE IS NEVER DRAWN IN A BOOK. Ian, 2026-10-16, choosing between
// blocking Publish and Order or blanking the picture: "Do number 2" -- the preview, the PDF, the print
// interior, the print cover and the public story page all show a plain "Picture removed" box in its
// place, so a book can never carry it, even as a download. The Storyboard still shows the real picture
// with its red mark, so the person who uploaded it knows what to replace.
//
// THE RENDERERS ARE SYNCHRONOUS, so they ask a set held in memory: loaded at boot (server.js), refreshed
// every minute, and updated at once by record() in this process (the upload and the render share it).
// A failed load leaves the last good set, so a database blip shows pictures rather than blanking them.
var REMOVED_PICTURE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
  '<rect width="400" height="300" fill="#e7e5e4"/>' +
  '<text x="200" y="146" font-family="Georgia, serif" font-size="20" fill="#57534e" text-anchor="middle">Picture removed</text>' +
  '<text x="200" y="170" font-family="Georgia, serif" font-size="13" fill="#78716c" text-anchor="middle">watermark or stock picture</text>' +
  '</svg>');
var _rejected = new Set();
var _rejectedTimer = null;
async function refreshRejected() {
  try {
    var d = await db();
    var rows = await d.prepare("SELECT image_url FROM image_rights WHERE verdict = 'reject'").all();
    var s = new Set();
    (rows || []).forEach(function (r) { if (r && r.image_url) s.add(r.image_url); });
    _rejected = s;
  } catch (e) { console.error('[rights] could not load rejected pictures: ' + ((e && e.message) || e)); }
}
// Called once at boot, after the database is ready (server.js).
async function startRejectedCache() {
  await refreshRejected();
  if (!_rejectedTimer) {
    _rejectedTimer = setInterval(refreshRejected, 60000);
    if (_rejectedTimer.unref) _rejectedTimer.unref();
  }
}
function isRejectedSync(u) { return !!u && _rejected.has(normUrl(u)); }
function maskUrl(u) { return isRejectedSync(u) ? REMOVED_PICTURE : u; }
// Each mask returns the SAME object when nothing in it is rejected, and a shallow copy with the
// picture swapped when something is, so a caller's data (a publish snapshot, say) is never changed.
function maskFields(o, fields) {
  if (!o || typeof o !== 'object' || !_rejected.size) return o;
  var out = null;
  fields.forEach(function (f) { if (o[f] && isRejectedSync(o[f])) { out = out || Object.assign({}, o); out[f] = REMOVED_PICTURE; } });
  return out || o;
}
function maskMoments(moments) {
  if (!Array.isArray(moments) || !_rejected.size) return moments;
  var hit = false;
  var out = moments.map(function (m) { var n = maskFields(m, ['image']); if (n !== m) hit = true; return n; });
  return hit ? out : moments;
}
function maskSession(s) {
  if (!s || typeof s !== 'object' || !_rejected.size) return s;
  var mm = maskMoments(s.moments);
  var n = maskFields(s, ['establishing_image']);
  if (mm === s.moments && n === s) return s;
  n = (n === s) ? Object.assign({}, s) : n;
  n.moments = mm;
  return n;
}
function maskSessions(sessions) {
  if (!Array.isArray(sessions) || !_rejected.size) return sessions;
  var hit = false;
  var out = sessions.map(function (s) { var n = maskSession(s); if (n !== s) hit = true; return n; });
  return hit ? out : sessions;
}
// Every picture the cast page can draw for a character (castRefFor in pdf.js). Only uploads are checked,
// but a generated reference can carry a rejection by being a COPY of a rejected picture (inherit()).
var CHARACTER_UPLOAD_FIELDS = ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other',
  'canonical_reference_url', 'version_ref_newest', 'version_ref_oldest', 'version_ref_styled'];
function maskCharacters(chars) {
  if (!Array.isArray(chars) || !_rejected.size) return chars;
  var hit = false;
  var out = chars.map(function (c) { var n = maskFields(c, CHARACTER_UPLOAD_FIELDS); if (n !== c) hit = true; return n; });
  return hit ? out : chars;
}
function maskCampaign(c) { return maskFields(c, ['cover_image_url', 'back_cover_image_url', 'title_image_url', 'campaign_image_url']); }

// url -> { verdict, reasons } for the ones that have a verdict. Never throws.
// v3.2.17 -- A WARNING STORED BEFORE AI TOOL CREDITS WERE EXEMPT. Ian: "clear the warning if it sees it." A
// stored reason whose only complaint is a file credit naming an AI tool (imageMetadata.isAiToolCredit) is dropped;
// a warning left with no reason is not reported and its row is deleted. Anything else is kept exactly as stored.
var COPYRIGHT_PREFIX = 'The picture\u2019s file details name a creator or copyright holder: ';
function isAiCreditReason(x) {
  if (!x || x.source !== 'metadata' || x.kind !== 'copyright') return false;
  var t = String(x.text || '');
  if (t.indexOf(COPYRIGHT_PREFIX) !== 0) return false;
  return meta.isAiToolCredit(t.slice(COPYRIGHT_PREFIX.length).replace(/\.\s*$/, ''));
}
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
    var _cleared = [];   // v3.2.17 -- warnings that only named an AI tool
    (rows || []).forEach(function (r) {
      var reasons = [];
      try { reasons = typeof r.reasons === 'string' ? JSON.parse(r.reasons) : (r.reasons || []); } catch (e) { reasons = []; }
      if (r.verdict === 'warn' && reasons.some(isAiCreditReason)) {   // v3.2.17
        reasons = reasons.filter(function (x) { return !isAiCreditReason(x); });
        if (!reasons.length) {
          _cleared.push(r.image_url);
          return;
        }
      }
      out[r.image_url] = { verdict: r.verdict, reasons: reasons };
    });
    // v3.2.17 -- the cleared rows go, so nothing else reads them either. Best effort.
    for (var _ci = 0; _ci < _cleared.length; _ci++) {
      try { await d.prepare("DELETE FROM image_rights WHERE image_url = ? AND verdict = 'warn'").run(_cleared[_ci]); } catch (e) { /* stays filtered here anyway */ }
    }
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

// v3.1.91 -- TD-979. The first rejection among these pictures, as a sentence, or null. For the routes that
// send an uploaded picture to the image model (a character's prompt build and reference, and the session
// edits that fall back to an uploaded portrait), so a rejected picture is never used.
async function rejectedReason(urls) {
  var list = (urls || []).filter(Boolean);
  if (!list.length) return null;
  var found = await lookup(list);
  for (var i = 0; i < list.length; i++) {
    var r = found[normUrl(list[i])];
    if (r && r.verdict === 'reject') {
      var why = (r.reasons || []).filter(function (x) { return x && x.kind !== 'signature' && x.kind !== 'copyright'; })[0];
      return (why && why.text) || 'This picture has a watermark.';
    }
  }
  return null;
}

// v3.1.93 -- TD-979. Ian, 2026-10-16: "if some of the images are ok it just uses them and rejects the ones
// it can't". Splits pictures into the clean ones (in their order) and the rejected ones, with the first
// rejection as a sentence and the rejected ones in the shape the page marks. A failed lookup counts every
// picture as clean (fails open, like every other part of this check). Never throws.
async function splitRejected(urls) {
  var list = (urls || []).filter(Boolean);
  var out = { clean: [], rejected: [], reason: null, rights: [] };
  if (!list.length) return out;
  var found = await lookup(list);
  list.forEach(function (u) {
    var r = found[normUrl(u)];
    if (r && r.verdict === 'reject') {
      out.rejected.push(u);
      if (!out.reason) {
        var why = (r.reasons || []).filter(function (x) { return x && x.kind !== 'signature' && x.kind !== 'copyright'; })[0];
        out.reason = (why && why.text) || 'This picture has a watermark.';
      }
      out.rights.push({ url: normUrl(u), verdict: 'reject', reasons: r.reasons || [] });
    } else out.clean.push(u);
  });
  return out;
}

// v3.1.96 -- TD-979. Ian, 2026-10-17: "we shouldn't let them archive a flagged image. That way it can't be
// used as a cover. Still stop it on a cover." Answers a request that would archive a rejected picture, or put
// one somewhere (a cover, the campaign picture, a replacement), with the RIGHTS_REJECTED refusal every page
// already shows by the button pressed, and returns true; false when nothing is rejected. Fails open.
async function refuseRejected(res, urls, tail) {
  try {
    var list = (urls || []).filter(function (u) { return typeof u === 'string' && u; });
    if (!list.length) return false;
    var s = await splitRejected(list);
    if (!s.rejected.length) return false;
    res.json({ error: s.reason + ' ' + tail, code: 'RIGHTS_REJECTED', rights: s.rights });
    return true;
  } catch (e) { return false; }
}

// v3.1.99 -- TD-979. A TITLE BUILDER REFERENCE IS A PICTURE OF LETTERING. Ian, 2026-10-17: "These are going to be
// pictures of Lettering. Can AI tell the difference between a watermark and actual Lettering?" Told what it is
// looking at, yes: the lettering to copy is the subject; a watermark is laid over the picture to mark its owner.
var LETTERING_HINT = 'This picture is a LETTERING REFERENCE: its main lettering is the subject the person wants copied, ' +
  'and is never a watermark however large or styled. Only answer watermark true for text or a logo laid over the picture ' +
  'to mark who owns it or where it came from: a stock library name, a web address, a social media handle, a copyright notice, ' +
  'or a sample or preview stamp.';

// v3.1.99 -- TD-979. Ian: the Title Builder looks at its reference "when they hit the button", not at upload. A
// stored picture is looked at ONCE: a verdict already recorded is used as it is; a clean answer is remembered
// for the life of the process; a look that failed (unchecked) is not remembered, so the next press asks again.
// Returns { verdict, reasons } and records warn/reject. Fails open. Never throws.
var _lookedOk = new Set();
async function checkReference(url, ctx) {
  ctx = ctx || {};
  var u = normUrl(url);
  if (!u) return { verdict: 'ok', reasons: [] };
  try {
    var found = (await lookup([u]))[u];
    if (found) return found;
    if (_lookedOk.has(u)) return { verdict: 'ok', reasons: [] };
    var fetchBuf = ctx.fetchBuf || function (x) { return require('../storage/storage').fetchFile(x); };
    var buf = await fetchBuf(u);
    if (!buf || !buf.length) return { verdict: 'unchecked', reasons: [] };
    var v = await visionCheck(buf, ctx);
    var r = combine(metadataCheck(buf), v);
    if (r.verdict === 'warn' || r.verdict === 'reject') await record(u, r, ctx);
    else if (v.verdict === 'ok') _lookedOk.add(u);
    return { verdict: (r.verdict === 'ok' && v.verdict === 'unchecked') ? 'unchecked' : r.verdict, reasons: r.reasons };
  } catch (e) { return { verdict: 'unchecked', reasons: [] }; }
}

// v3.2.00 -- TD-979. THE QUICK LOOK AT A PICTURE NOT STORED YET (a style reference straight from the computer). Ian,
// 2026-10-17: the style refusal took seventeen seconds, inside the full analysis -- "can you do it quicker?". The
// small Haiku look alone takes two or three. Remembered by the picture's bytes (sha256), so the same picture sent
// again is not looked at again; a failed look (unchecked) is not remembered. Vision only: the caller combines it
// with the file details. Never throws.
var _quickCache = new Map();
async function quickLook(buf, ctx) {
  try {
    if (!buf || !buf.length) return { verdict: 'unchecked', reasons: [] };
    var h = require('crypto').createHash('sha256').update(buf).digest('hex');
    if (_quickCache.has(h)) return _quickCache.get(h);
    var v = await visionCheck(buf, ctx);
    if (v.verdict !== 'unchecked') {
      if (_quickCache.size >= 500) _quickCache.delete(_quickCache.keys().next().value);
      _quickCache.set(h, v);
    }
    return v;
  } catch (e) { return { verdict: 'unchecked', reasons: [] }; }
}

// v3.1.91 -- TD-979. Split a reply into its text and its RIGHTS: line (see RIGHTS_LINE_INSTRUCTION). Every
// RIGHTS line is removed from the text, whether or not it parses, so it can never reach a prompt.
function splitRightsLine(reply) {
  var keep = [], arr = null;
  String(reply || '').split(/\r?\n/).forEach(function (l) {
    var m = l.match(/^\s*\**\s*RIGHTS\s*:\s*(.*)$/i);
    if (!m) { keep.push(l); return; }
    try { var v = JSON.parse(m[1].replace(/^[\s*]+/, '').replace(/[\s*]+$/, '')); if (Array.isArray(v)) arr = v; } catch (e) { /* unreadable: unchecked */ }
  });
  return { text: keep.join('\n').trim(), rights: arr };
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
  isDateStampText: isDateStampText,   // v3.2.81 -- TD-1016
  metadataCheck: metadataCheck, visionCheck: visionCheck, verdictFromAnswer: verdictFromAnswer, parseReply: parseReply,
  combine: combine, record: record, lookup: lookup, inherit: inherit, checkUpload: checkUpload,
  responseRights: responseRights, normUrl: normUrl, VISION_SYSTEM: VISION_SYSTEM,
  RIGHTS_DEFINITIONS: RIGHTS_DEFINITIONS, RIGHTS_LINE_INSTRUCTION: RIGHTS_LINE_INSTRUCTION,   // v3.1.91
  rejectedReason: rejectedReason, splitRightsLine: splitRightsLine,                            // v3.1.91
  REMOVED_PICTURE: REMOVED_PICTURE, startRejectedCache: startRejectedCache, refreshRejected: refreshRejected,   // v3.1.92
  isRejectedSync: isRejectedSync, maskUrl: maskUrl, maskMoments: maskMoments, maskSession: maskSession,          // v3.1.92
  splitRejected: splitRejected,                                                                                  // v3.1.93
  refuseRejected: refuseRejected,                                                                                // v3.1.96
  checkReference: checkReference, LETTERING_HINT: LETTERING_HINT,                                                // v3.1.99
  quickLook: quickLook,                                                                                          // v3.2.00
  maskSessions: maskSessions, maskCharacters: maskCharacters, maskCampaign: maskCampaign,                      // v3.1.92
  _setFetch: function (f) { _fetch = f; }
};
