// ============================================================
// ARTIST MARKETPLACE  (mounted at /api/marketplace)
// v3.3.01 -- TD-1037 stage one. Spec: claude/ARTIST_MARKETPLACE_SPEC.md
//
// A directory of people who make things for books -- Artists & Illustrators, Writers & Narrative
// Editors, General Campaignia Editors -- and a Make contact button that emails them. Campaignia
// takes no money and is not a party to anything they agree (Ian, 2026-10-26: "Money: none for now").
//
// THE SWITCH. app_settings.marketplace_enabled ('0' until launch). While it is off every route here
// answers 404 to everyone but an admin, so Ian can preview it and nobody else can find it.
//
// TWO COPIES OF A LISTING. The draft columns are what the owner edits; live_json is the copy Ian
// approved, and it is the only thing the directory ever shows. Editing an approved listing sends the
// draft back for review while the approved copy stays up -- so nothing reaches the public without
// Ian (his decision: "listings appear after Ian approves") and an artist is never taken off the
// Marketplace for fixing a typo.
//
// Nobody's email address is ever sent to a page. Make contact emails the listing owner with the
// sender's account email as the reply-to, and from then on they talk directly.
// ============================================================
'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb } = require('../database/db');
const { requireAuth, isAdminEmail } = require('../middleware/auth');
const { imageFileFilter, guardUpload } = require('../middleware/uploadGuard');

const ROLES = ['artist', 'writer', 'editor'];
const AVAIL = ['open', 'limited', 'closed'];
const KINDS = ['commission', 'campaign', 'question'];
const MAX_SAMPLES = 6;
const MAX_SAMPLE_UPLOADS = 40;          // stored pictures per user, ever (each costs one small rights look)
const CONTACT_PER_LISTING_MS = 24 * 60 * 60 * 1000;
const CONTACT_PER_DAY = 8;
const LIMITS = { display_name: 60, headline: 120, bio: 2000, rates: 200, link: 300, note: 1000, message: 2000 };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter });
const uploadSingle = upload.single('image');

// ---------- small helpers ----------
function clip(v, n) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, n); }
function oneLine(v, n) { return clip(v, n).replace(/\s+/g, ' '); }
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function jparse(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } }
function iso(ms) { return new Date(ms).toISOString(); }
function appUrl() { return (process.env.APP_URL || 'https://campaignia.com').replace(/\/$/, ''); }

function cleanRoles(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  list.forEach(function (r) { r = String(r || '').trim().toLowerCase(); if (ROLES.indexOf(r) >= 0 && out.indexOf(r) < 0) out.push(r); });
  return out;
}
function cleanLinks(v) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  list.forEach(function (u) {
    u = String(u || '').trim().slice(0, LIMITS.link);
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const p = new URL(u);
      if ((p.protocol === 'https:' || p.protocol === 'http:') && p.hostname.indexOf('.') > 0 && out.length < 3) out.push(p.href);
    } catch (e) { /* not a web address: dropped */ }
  });
  return out;
}

async function setting(db, key) {
  try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(key); return r ? r.value : null; }
  catch (e) { return null; }
}
async function putSetting(db, key, value) {
  const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get(key);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(value, key);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(key, value);
}
async function isEnabled(db) { return (await setting(db, 'marketplace_enabled')) === '1'; }

async function viewer(db, req) {
  const uid = req.session && req.session.userId;
  if (!uid) return null;
  try {
    const u = await db.prepare('SELECT id, name, pen_name, email FROM users WHERE id = ?').get(uid);
    if (!u) return null;
    u.admin = isAdminEmail(u.email);
    return u;
  } catch (e) { return null; }
}

// Every route but /status: 404 while the switch is off, unless an admin is looking.
async function gate(req, res, next) {
  try {
    const db = await getDb();
    if (await isEnabled(db)) return next();
    const v = await viewer(db, req);
    if (v && v.admin) return next();
    return res.status(404).json({ error: 'Not found' });
  } catch (e) { return res.status(500).json({ error: 'Server error' }); }
}
async function adminOnly(req, res, next) {
  try {
    const db = await getDb();
    const v = await viewer(db, req);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    if (!v.admin) return res.status(403).json({ error: 'Admin access required' });
    req.mktAdmin = v;
    next();
  } catch (e) { return res.status(500).json({ error: 'Admin check failed' }); }
}

function maskUrl(u) {
  try { return require('../services/rightsCheck').maskUrl(u); } catch (e) { return u; }
}

// The draft as the owner sees it.
function draftOf(row) {
  return {
    display_name: row.display_name || '', headline: row.headline || '', roles: cleanRoles(row.roles),
    bio: row.bio || '', links: jparse(row.links, []), rates: row.rates || '',
    availability: AVAIL.indexOf(row.availability) >= 0 ? row.availability : 'open',
    samples: jparse(row.samples, [])
  };
}
// The public card, built from the approved copy only.
function publicOf(row) {
  const live = jparse(row.live_json, null);
  if (!live) return null;
  return {
    id: row.id, name: live.display_name || '', headline: live.headline || '', roles: cleanRoles(live.roles),
    bio: live.bio || '', links: Array.isArray(live.links) ? live.links : [], rates: live.rates || '',
    availability: AVAIL.indexOf(live.availability) >= 0 ? live.availability : 'open',
    samples: (Array.isArray(live.samples) ? live.samples : []).filter(function (u) { return u && maskUrl(u) === u; }),   // a picture rejected later simply drops out
    approved_at: row.reviewed_at || null
  };
}
function sameContent(a, b) {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
function mineOf(row) {
  if (!row) return null;
  const d = draftOf(row), live = jparse(row.live_json, null);
  return {
    id: row.id, status: row.status, paused: !!row.paused, admin_note: row.admin_note || '',
    has_live: !!live, changed: !!live && !sameContent(d, live), draft: d,
    submitted_at: row.submitted_at || null, reviewed_at: row.reviewed_at || null
  };
}

async function mailSafely(to, subject, html, replyTo) {
  try {
    const email = require('./email');
    if (typeof email.sendMarketplaceEmail !== 'function') return false;
    await email.sendMarketplaceEmail(to, subject, html, replyTo);
    return true;
  } catch (e) { console.error('[marketplace] email failed: ' + ((e && e.message) || e)); return false; }
}
function mailFrame(title, inner) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;line-height:1.5;">' +
    '<h2 style="color:#6b4a12;margin:0 0 12px;">' + esc(title) + '</h2>' + inner +
    '<hr style="border:none;border-top:1px solid #ddd;margin:18px 0 10px;"/>' +
    '<p style="font-size:12px;color:#777;margin:0;">Campaignia Marketplace. Campaignia is not a party to any arrangement you make with another member. ' +
    'You can pause or edit your listing from My Account at <a href="' + esc(appUrl()) + '/app.html">' + esc(appUrl().replace(/^https?:\/\//, '')) + '</a>.</p></div>';
}

// ---------- status ----------
// GET /api/marketplace/status -- always answers, switch on or off; the pages ask this to decide
// whether to show the tab and the links.
router.get('/status', async function (req, res) {
  try {
    const db = await getDb();
    const on = await isEnabled(db);
    const v = await viewer(db, req);
    let mine = null;
    if (v && (on || v.admin)) {
      const row = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(v.id);
      if (row) mine = { status: row.status, paused: !!row.paused, has_live: !!row.live_json };
    }
    let waiting = null;
    if (v && v.admin) {
      try { const c = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'pending'").get(); waiting = Number(c && c.n) || 0; } catch (e) { waiting = null; }
    }
    res.json({ enabled: on, admin: !!(v && v.admin), signedIn: !!v, show: on || !!(v && v.admin), mine: mine, waiting: waiting });
  } catch (e) { res.json({ enabled: false, admin: false, signedIn: false, show: false, mine: null }); }
});

// ---------- the directory ----------
router.get('/listings', gate, async function (req, res) {
  try {
    const db = await getDb();
    const role = ROLES.indexOf(String(req.query.role || '')) >= 0 ? String(req.query.role) : '';
    const rows = await db.prepare(
      "SELECT l.id, l.live_json, l.reviewed_at FROM marketplace_listings l JOIN users u ON u.id = l.user_id " +
      "WHERE l.live_json IS NOT NULL AND l.status <> 'removed' AND l.paused = false AND COALESCE(u.status, 'active') = 'active' " +   // a closed or suspended account is never listed
      "ORDER BY l.reviewed_at DESC NULLS LAST, l.id DESC LIMIT 500"
    ).all();
    const out = [];
    rows.forEach(function (r) { const p = publicOf(r); if (p && (!role || p.roles.indexOf(role) >= 0)) out.push(p); });
    res.json({ listings: out });
  } catch (e) { console.error('[marketplace] listings: ' + (e && e.message)); res.status(500).json({ error: 'Could not load the Marketplace right now.' }); }
});

router.get('/listings/:id', gate, async function (req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare("SELECT l.id, l.user_id, l.live_json, l.reviewed_at, l.status, l.paused, u.status AS user_status FROM marketplace_listings l JOIN users u ON u.id = l.user_id WHERE l.id = ?").get(Number(req.params.id) || 0);
    const p = row && row.status !== 'removed' && !row.paused && (row.user_status || 'active') === 'active' ? publicOf(row) : null;
    if (!p) return res.status(404).json({ error: 'That listing is not on the Marketplace.' });
    const v = await viewer(db, req);
    p.own = !!(v && v.id === row.user_id);
    res.json({ listing: p });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ---------- your own listing ----------
router.get('/mine', requireAuth, gate, async function (req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(req.session.userId);
    const u = await db.prepare('SELECT name, pen_name FROM users WHERE id = ?').get(req.session.userId);
    res.json({ mine: mineOf(row), suggest_name: (u && (u.pen_name || u.name)) || '', limits: LIMITS, max_samples: MAX_SAMPLES });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/mine', requireAuth, gate, async function (req, res) {
  try {
    const db = await getDb();
    const uid = req.session.userId;
    const b = req.body || {};
    const row = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(uid);
    if (row && row.status === 'removed') return res.status(403).json({ error: 'This listing was removed from the Marketplace. Write to support@campaignia.com if you think that was a mistake.' });
    const d = {
      display_name: oneLine(b.display_name, LIMITS.display_name),
      headline: oneLine(b.headline, LIMITS.headline),
      roles: cleanRoles(b.roles),
      bio: clip(b.bio, LIMITS.bio),
      links: cleanLinks(b.links),
      rates: oneLine(b.rates, LIMITS.rates),
      availability: AVAIL.indexOf(b.availability) >= 0 ? b.availability : 'open',
      samples: []
    };
    // Samples: only pictures this user uploaded here, in the order given, at most six.
    const want = Array.isArray(b.samples) ? b.samples.map(String) : [];
    if (want.length) {
      const own = await db.prepare("SELECT url FROM marketplace_samples WHERE user_id = ? AND verdict <> 'reject'").all(uid);
      const ok = {}; own.forEach(function (r) { ok[r.url] = true; });
      want.forEach(function (u) { if (ok[u] && d.samples.indexOf(u) < 0 && d.samples.length < MAX_SAMPLES) d.samples.push(u); });
    }
    const submit = !!b.submit;
    if (submit) {
      const miss = [];
      if (!d.display_name) miss.push('a name');
      if (!d.headline) miss.push('a headline');
      if (!d.roles.length) miss.push('at least one kind of help you offer');
      if (d.bio.length < 40) miss.push('a few sentences about you and your work');
      if (d.roles.indexOf('artist') >= 0 && !d.samples.length) miss.push('at least one sample picture (you offer art)');
      if (miss.length) return res.status(400).json({ error: 'Before it can be reviewed, add ' + miss.join(', ') + '.', missing: miss });
    }
    const now = new Date().toISOString();
    const cols = [d.display_name, d.headline, d.roles.join(','), d.bio, JSON.stringify(d.links), d.rates, d.availability, JSON.stringify(d.samples)];
    let status = row ? row.status : 'draft';
    const live = row ? jparse(row.live_json, null) : null;
    if (submit) status = (live && sameContent(d, live) && row.status === 'approved') ? 'approved' : 'pending';
    if (!row) {
      await db.prepare(
        'INSERT INTO marketplace_listings (user_id, display_name, headline, roles, bio, links, rates, availability, samples, status, paused, submitted_at, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?)'
      ).run(...[uid].concat(cols, [status, submit ? now : null, now, now]));
    } else {
      await db.prepare(
        'UPDATE marketplace_listings SET display_name = ?, headline = ?, roles = ?, bio = ?, links = ?, rates = ?, availability = ?, samples = ?, status = ?, ' +
        'submitted_at = ?, updated_at = ? WHERE user_id = ?'
      ).run(...cols.concat([status, (submit && status === 'pending') ? now : (row.submitted_at || null), now, uid]));
    }
    const fresh = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(uid);
    res.json({ ok: true, mine: mineOf(fresh) });
  } catch (e) { console.error('[marketplace] save: ' + (e && e.message)); res.status(500).json({ error: 'Could not save your listing right now.' }); }
});

router.post('/mine/pause', requireAuth, gate, async function (req, res) {
  try {
    const db = await getDb();
    const paused = !!(req.body && req.body.paused);
    const r = await db.prepare('UPDATE marketplace_listings SET paused = ?, updated_at = ? WHERE user_id = ?').run(paused, new Date().toISOString(), req.session.userId);
    if (!r || !r.changes) return res.status(404).json({ error: 'You have no listing yet.' });
    const fresh = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(req.session.userId);
    res.json({ ok: true, mine: mineOf(fresh) });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/mine', requireAuth, gate, async function (req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare('SELECT id, status FROM marketplace_listings WHERE user_id = ?').get(req.session.userId);
    if (!row) return res.json({ ok: true });
    // A removed listing is kept so it cannot be deleted and re-made to get round Ian's decision.
    if (row.status === 'removed') return res.status(403).json({ error: 'This listing was removed from the Marketplace and stays that way. Write to support@campaignia.com if you think that was a mistake.' });
    await db.prepare('DELETE FROM marketplace_listings WHERE id = ?').run(row.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// One sample picture. Checked for watermarks like every other upload (free to the user); a picture
// with someone else's watermark is refused here and never reaches a listing. An artist's own
// signature is a warning only, which Ian sees in review.
router.post('/mine/samples', requireAuth, gate, guardUpload(uploadSingle, 'marketplace'), async function (req, res) {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Choose a picture to upload.' });
    const db = await getDb();
    const uid = req.session.userId;
    const n = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_samples WHERE user_id = ?').get(uid);
    if (Number(n && n.n) >= MAX_SAMPLE_UPLOADS) return res.status(429).json({ error: 'You have uploaded a lot of sample pictures. Write to support@campaignia.com and we will make room.' });
    const ext = req.file.mimetype === 'image/png' ? '.png' : (req.file.mimetype === 'image/webp' ? '.webp' : '.jpg');
    const name = 'mkt-' + uid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    const storage = require('../storage/storage');
    const url = await storage.uploadFile(req.file.buffer, name, req.file.mimetype, 'marketplace');
    let verdict = 'ok', reasons = [];
    try {
      const r = await require('../services/rightsCheck').checkUpload(url, req.file, req.file.buffer, { kind: 'marketplace', userId: uid });
      verdict = (r && r.verdict) || 'ok'; reasons = (r && r.reasons) || [];
    } catch (e) { verdict = 'unchecked'; }
    await db.prepare('INSERT INTO marketplace_samples (user_id, url, verdict, created_at) VALUES (?, ?, ?, ?)').run(uid, url, verdict, new Date().toISOString());
    if (verdict === 'reject') {
      try { await storage.deleteFile(url); } catch (e) { /* the row keeps the record */ }
      const why = reasons.map(function (x) { return x && x.text; }).filter(Boolean).join(' ');
      return res.status(400).json({ error: (why ? why + ' ' : '') + 'A sample has to be your own work without anyone else\u2019s mark on it. Choose another picture.' });
    }
    res.json({ ok: true, url: url, verdict: verdict });
  } catch (e) { console.error('[marketplace] sample: ' + (e && e.message)); res.status(500).json({ error: 'Could not upload that picture right now.' }); }
});

// ---------- Make contact ----------
router.post('/listings/:id/contact', requireAuth, gate, async function (req, res) {
  try {
    if (req.session.impersonatorId) return res.status(403).json({ error: 'Make contact is switched off while you are signed in as someone else.' });
    const db = await getDb();
    const me = await db.prepare('SELECT id, name, pen_name, email FROM users WHERE id = ?').get(req.session.userId);
    if (!me || !me.email) return res.status(403).json({ error: 'Your account needs an email address first.' });
    const row = await db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(Number(req.params.id) || 0);
    const pub = row && row.status !== 'removed' && !row.paused ? publicOf(row) : null;
    if (!pub) return res.status(404).json({ error: 'That listing is not on the Marketplace any more.' });
    if (row.user_id === me.id) return res.status(400).json({ error: 'This is your own listing.' });
    const message = clip(req.body && req.body.message, LIMITS.message);
    if (message.length < 20) return res.status(400).json({ error: 'Say a little more about what you have in mind (at least 20 characters).' });
    const kind = KINDS.indexOf(req.body && req.body.kind) >= 0 ? req.body.kind : 'question';
    const now = Date.now();
    const same = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_contacts WHERE from_user_id = ? AND listing_id = ? AND created_at > ?').get(me.id, row.id, iso(now - CONTACT_PER_LISTING_MS));
    if (Number(same && same.n) > 0) return res.status(429).json({ error: 'You have already written to ' + pub.name + ' today. Give them a day to reply.' });
    const day = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_contacts WHERE from_user_id = ? AND created_at > ?').get(me.id, iso(now - 24 * 60 * 60 * 1000));
    if (Number(day && day.n) >= CONTACT_PER_DAY) return res.status(429).json({ error: 'That is as many Marketplace messages as you can send in a day. Try again tomorrow.' });
    const owner = await db.prepare('SELECT name, email, status FROM users WHERE id = ?').get(row.user_id);
    if (!owner || !owner.email || (owner.status || 'active') !== 'active') return res.status(404).json({ error: 'That listing is not on the Marketplace any more.' });
    const who = me.pen_name ? (me.name ? me.name + ' (' + me.pen_name + ')' : me.pen_name) : (me.name || 'A Campaignia member');
    const what = kind === 'commission' ? 'would like to commission you' : (kind === 'campaign' ? 'would like you to join a campaign' : 'has a question for you');
    const html = mailFrame('A message from the Campaignia Marketplace',
      '<p>Hi ' + esc(pub.name || owner.name || 'there') + ',</p>' +
      '<p><strong>' + esc(who) + '</strong> ' + esc(what) + '. They found your listing on the Campaignia Marketplace.</p>' +
      '<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #c9a84c;background:#faf6ea;white-space:pre-wrap;">' + esc(message) + '</blockquote>' +
      '<p><strong>Reply to this email</strong> to answer them directly. Your reply goes to their address, not to Campaignia.</p>');
    const ins = await db.prepare('INSERT INTO marketplace_contacts (from_user_id, listing_id, kind, message, emailed, created_at) VALUES (?, ?, ?, ?, false, ?)').run(me.id, row.id, kind, message, iso(now));
    const sent = await mailSafely(owner.email, oneLine(who, 80) + ' would like to work with you \u2014 Campaignia Marketplace', html, me.email);
    if (ins && ins.lastInsertRowid) { try { await db.prepare('UPDATE marketplace_contacts SET emailed = ? WHERE id = ?').run(sent, ins.lastInsertRowid); } catch (e) {} }
    if (!sent) return res.status(502).json({ error: 'Your message could not be sent right now. Please try again in a few minutes.' });
    res.json({ ok: true, message: 'Sent. ' + pub.name + ' will reply to your email address.' });
  } catch (e) { console.error('[marketplace] contact: ' + (e && e.message)); res.status(500).json({ error: 'Could not send your message right now.' }); }
});

// ---------- admin ----------
router.get('/admin/settings', adminOnly, async function (req, res) {
  try { const db = await getDb(); res.json({ enabled: await isEnabled(db) }); }
  catch (e) { res.status(500).json({ error: 'Server error' }); }
});
router.put('/admin/settings', adminOnly, async function (req, res) {
  try {
    const db = await getDb();
    await putSetting(db, 'marketplace_enabled', (req.body && req.body.enabled) ? '1' : '0');
    console.log('[marketplace] switched ' + ((req.body && req.body.enabled) ? 'ON' : 'OFF') + ' by ' + req.mktAdmin.email);
    res.json({ ok: true, enabled: await isEnabled(db) });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/admin/listings', adminOnly, async function (req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT l.*, u.name AS owner_name, u.email AS owner_email, u.pen_name AS owner_pen, ' +
      '(SELECT COUNT(*) FROM marketplace_contacts c WHERE c.listing_id = l.id) AS contacts ' +
      'FROM marketplace_listings l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.updated_at DESC LIMIT 500'
    ).all();
    const urls = [];
    rows.forEach(function (r) { draftOf(r).samples.forEach(function (u) { urls.push(u); }); });
    let verdicts = {};
    try { verdicts = await require('../services/rightsCheck').lookup(urls); } catch (e) { verdicts = {}; }
    res.json({ listings: rows.map(function (r) {
      const m = mineOf(r);
      m.user_id = r.user_id; m.owner = { name: r.owner_name || '', email: r.owner_email || '', pen_name: r.owner_pen || '' };
      m.live = jparse(r.live_json, null); m.contacts = Number(r.contacts) || 0;
      m.reviewed_by = r.reviewed_by || ''; m.updated_at = r.updated_at || null;
      m.sample_rights = {};
      m.draft.samples.forEach(function (u) { const v = verdicts[u] || verdicts[String(u).split('?')[0]]; if (v) m.sample_rights[u] = { verdict: v.verdict, reasons: (v.reasons || []).map(function (x) { return x.text; }) }; });
      return m;
    }) });
  } catch (e) { console.error('[marketplace] admin list: ' + (e && e.message)); res.status(500).json({ error: 'Server error' }); }
});

router.post('/admin/listings/:id/review', adminOnly, async function (req, res) {
  try {
    const db = await getDb();
    const action = String(req.body && req.body.action || '');
    const note = clip(req.body && req.body.note, LIMITS.note);
    const row = await db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(Number(req.params.id) || 0);
    if (!row) return res.status(404).json({ error: 'No such listing.' });
    const now = new Date().toISOString();
    const by = req.mktAdmin.email;
    let subject = '', body = '';
    if (action === 'approve') {
      await db.prepare("UPDATE marketplace_listings SET live_json = ?, status = 'approved', admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(draftOf(row)), note, now, by, now, row.id);
      subject = 'Your Campaignia Marketplace listing is live';
      body = '<p>Good news: your listing is now on the Campaignia Marketplace, and members can find you and make contact.</p>' + (note ? '<p>' + esc(note) + '</p>' : '');
    } else if (action === 'decline') {
      if (!note) return res.status(400).json({ error: 'Say what needs to change, so they can fix it.' });
      await db.prepare("UPDATE marketplace_listings SET status = 'declined', admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(note, now, by, now, row.id);
      subject = 'Your Campaignia Marketplace listing needs a change';
      body = '<p>Thanks for listing yourself on the Campaignia Marketplace. Before ' + (row.live_json ? 'your changes go' : 'it goes') + ' up, one thing needs to change:</p>' +
        '<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #c9a84c;background:#faf6ea;white-space:pre-wrap;">' + esc(note) + '</blockquote>' +
        '<p>Edit your listing in My Account and send it for review again.</p>';
    } else if (action === 'remove') {
      if (!note) return res.status(400).json({ error: 'Give a reason; it is emailed to them.' });
      await db.prepare("UPDATE marketplace_listings SET status = 'removed', admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(note, now, by, now, row.id);
      subject = 'Your Campaignia Marketplace listing was removed';
      body = '<p>Your listing has been removed from the Campaignia Marketplace.</p>' +
        '<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #c9a84c;background:#faf6ea;white-space:pre-wrap;">' + esc(note) + '</blockquote>' +
        '<p>If you think this was a mistake, reply to this email.</p>';
    } else if (action === 'restore') {
      const st = row.live_json ? 'approved' : 'pending';
      await db.prepare('UPDATE marketplace_listings SET status = ?, admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?').run(st, note, now, by, now, row.id);
    } else return res.status(400).json({ error: 'Unknown action.' });
    let emailed = false;
    if (subject) {
      const owner = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(row.user_id);
      if (owner && owner.email) emailed = await mailSafely(owner.email, subject, mailFrame(subject, '<p>Hi ' + esc(owner.name || 'there') + ',</p>' + body), 'support@campaignia.com');
    }
    console.log('[marketplace] listing ' + row.id + ' ' + action + ' by ' + by);
    const fresh = await db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(row.id);
    res.json({ ok: true, emailed: emailed, listing: mineOf(fresh) });
  } catch (e) { console.error('[marketplace] review: ' + (e && e.message)); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
module.exports._test = { cleanRoles: cleanRoles, cleanLinks: cleanLinks, publicOf: publicOf, draftOf: draftOf, mineOf: mineOf, sameContent: sameContent, LIMITS: LIMITS };
