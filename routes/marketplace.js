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
// v3.3.10 -- HOW THE ART IS MADE (Ian, 2026-10-27: "a Medium field... including AI art"). Tick boxes, any that apply,
// so the labels stay the same everywhere and AI work is always called AI; plus "medium", a line in their own words.
// Asked only of listings that offer art.
const MEDIA = ['traditional', 'digital', '3d', 'ai-generated', 'ai-assisted'];
const MEDIA_NAMES = { traditional: 'Traditional', digital: 'Digital', '3d': '3D', 'ai-generated': 'AI-generated', 'ai-assisted': 'AI-assisted' };
function cleanMedia(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  list.forEach(function (x) { x = String(x || '').trim().toLowerCase(); if (MEDIA.indexOf(x) >= 0 && out.indexOf(x) < 0) out.push(x); });
  return MEDIA.filter(function (x) { return out.indexOf(x) >= 0; });   // always in the same order
}
const MAX_SAMPLES = 10;                // v3.3.04: was 6 (Ian, 2026-10-27)
// v3.3.07 -- the Marketplace Terms (public/marketplace-terms.html) and the version a listing must have accepted to be
// sent for review or updated. Change it together with the version line on that page; everyone then ticks again.
const MKT_TERMS_VERSION = '1.0';
const MIN_SAMPLE_SIDE = 800;           // v3.3.05: a sample's longer side, in pixels (Ian: small ones look bad shown big)
const MAX_SAMPLE_UPLOADS = 60;          // stored pictures per user, ever (each costs one small rights look); v3.3.04: was 40
const CONTACT_PER_LISTING_MS = 24 * 60 * 60 * 1000;
const CONTACT_PER_DAY = 8;
const LIMITS = { medium: 80, display_name: 60, headline: 120, bio: 2000, rates: 200, link: 300, note: 1000, message: 2000 };

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
    samples: jparse(row.samples, []),
    media: cleanMedia(row.media), medium: row.medium || ''   // v3.3.10
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
    media: cleanMedia(live.media), medium: live.medium || '',   // v3.3.10
    approved_at: row.reviewed_at || null,
    path: listingPath(row.id, live.display_name)   // v3.3.08 -- its own page, /marketplace/<name>-<id>
  };
}
// v3.3.08 -- A LISTING'S OWN ADDRESS. The name is only for people and search engines; the number at the end is what
// finds the listing, so a rename never breaks a link (the old address 301s to the new one).
function slugify(t) {
  return String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'listing';
}
function listingPath(id, name) { return '/marketplace/' + slugify(name) + '-' + id; }
function sameContent(a, b) {
  if (!a || !b) return false;
  // v3.3.10 -- a copy saved before media/medium existed compares as "none ticked, nothing written"
  const n = function (o) { return Object.assign({}, o, { media: o.media || [], medium: o.medium || '' }); };
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
}
function mineOf(row) {
  if (!row) return null;
  const d = draftOf(row), live = jparse(row.live_json, null);
  return {
    id: row.id, status: row.status, paused: !!row.paused, admin_note: row.admin_note || '',
    has_live: !!live, changed: !!live && !sameContent(d, live), draft: d,
    // v3.3.06 -- an approved listing's edits go live at once (Ian); "altered" = live now differs from what was approved
    terms_ok: row.terms_version === MKT_TERMS_VERSION,   // v3.3.07
    has_reviewed: !!row.reviewed_json, altered: !!live && !!row.reviewed_json && !sameContent(live, jparse(row.reviewed_json, null)),
    path: row.live_json ? listingPath(row.id, (jparse(row.live_json, {}) || {}).display_name) : null,   // v3.3.08
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
function mailFrame(title, inner, staff) {
  if (staff) return '<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;line-height:1.5;">' +
    '<h2 style="color:#6b4a12;margin:0 0 12px;">' + esc(title) + '</h2>' + inner + '</div>';   // v3.3.03: no member footer on a note to support
  return '<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;line-height:1.5;">' +
    '<h2 style="color:#6b4a12;margin:0 0 12px;">' + esc(title) + '</h2>' + inner +
    '<hr style="border:none;border-top:1px solid #ddd;margin:18px 0 10px;"/>' +
    '<p style="font-size:12px;color:#777;margin:0;">Campaignia Marketplace. Campaignia is not a party to any arrangement you make with another member. ' +
    'You can pause or edit your listing from My Account at <a href="' + esc(appUrl()) + '/app.html">' + esc(appUrl().replace(/^https?:\/\//, '')) + '</a>.</p></div>';
}

// v3.3.03 -- TD-1037. SOMETHING TO REVIEW: email support (Ian, 2026-10-27: "it should email support email
// when there is something to review"). Sent each time a listing goes to 'pending' -- a new listing or changes to
// a live one -- to SUPPORT_EMAIL (the address every other support email uses), with the owner as reply-to.
// Never throws and is never awaited by the save.
async function notifySupport(db, uid, row, isChange, isLive) {
  try {
    const to = String(process.env.SUPPORT_EMAIL || 'support@campaignia.com').trim();
    const u = await db.prepare('SELECT name, pen_name, email FROM users WHERE id = ?').get(uid);
    let waiting = 0;
    try { const c = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'pending'").get(); waiting = Number(c && c.n) || 0; } catch (e) {}
    const d = draftOf(row || {});
    const name = d.display_name || '(no name)';
    const who = u ? ((u.name || '') + (u.pen_name ? ' (' + u.pen_name + ')' : '') + ' <' + (u.email || '') + '>') : ('user ' + uid);
    const html = mailFrame(isLive ? 'A live Marketplace listing was changed' : 'A Marketplace listing to review',
      '<p><strong>' + esc(name) + '</strong> ' + (isLive ? 'changed their listing. <strong>The changes are already live</strong>; it is marked Altered in the review window until you look at it.' : (isChange ? 'changed their live listing' : 'sent a new listing') + ' for review.') + '</p>' +
      '<p style="margin:4px 0;"><strong>Account:</strong> ' + esc(who) + '</p>' +
      '<p style="margin:4px 0;"><strong>Headline:</strong> ' + esc(d.headline) + '</p>' +
      '<p style="margin:4px 0;"><strong>Offers:</strong> ' + esc(d.roles.join(', ')) + ' &middot; ' + esc(String(d.samples.length)) + ' sample picture' + (d.samples.length === 1 ? '' : 's') + '</p>' +
      '<p>' + esc(String(waiting)) + ' listing' + (waiting === 1 ? '' : 's') + ' waiting in all. Review them on the Dashboard: Settings &rsaquo; Marketplace &rsaquo; Review listings, at ' +
      '<a href="' + esc(appUrl()) + '/app.html">' + esc(appUrl().replace(/^https?:\/\//, '')) + '</a>.</p>', true);
    await mailSafely(to, 'Marketplace: ' + oneLine(name, 60) + (isLive ? ' changed their live listing \u2014 already live, please look' : ((isChange ? ' changed their listing' : ' wants to be listed') + ' \u2014 review needed')), html, u && u.email ? u.email : undefined);
  } catch (e) { console.error('[marketplace] support notice failed: ' + ((e && e.message) || e)); }
}

// v3.3.06 -- CONFIRMED EMAIL (Ian: "It should use the email on file with Campaignia"). Make contact sends to and
// replies to the account email, so both people must have confirmed theirs. Sign-in already refuses an unconfirmed
// account and an email change only takes effect from its link, so this is a second lock, not the only one.
const CONFIRM_FIRST = 'Please confirm your email address first: use the link we emailed when you signed up.';
async function emailConfirmed(db, uid) {
  try { const r = await db.prepare('SELECT email_verified FROM users WHERE id = ?').get(uid); return !!r && r.email_verified !== false; }
  catch (e) { return true; }   // a database without the column predates confirmation; sign-in is the gate there
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
    let waiting = null, altered = null;
    if (v && v.admin) {
      try { const c = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status = 'pending'").get(); waiting = Number(c && c.n) || 0; } catch (e) { waiting = null; }
      try { const a = await db.prepare("SELECT COUNT(*) AS n FROM marketplace_listings WHERE status <> 'removed' AND live_json IS NOT NULL AND reviewed_json IS NOT NULL AND live_json <> reviewed_json").get(); altered = Number(a && a.n) || 0; } catch (e) { altered = null; }   // v3.3.06
    }
    res.json({ enabled: on, admin: !!(v && v.admin), signedIn: !!v, show: on || !!(v && v.admin), mine: mine, waiting: waiting, altered: altered });
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
    res.json({ mine: mineOf(row), suggest_name: (u && (u.pen_name || u.name)) || '', limits: LIMITS, max_samples: MAX_SAMPLES, terms_version: MKT_TERMS_VERSION });
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
      samples: [],
      media: cleanMedia(b.media), medium: oneLine(b.medium, LIMITS.medium)   // v3.3.10
    };
    if (d.roles.indexOf('artist') < 0) { d.media = []; d.medium = ''; }   // only asked of people offering art
    // Samples: only pictures this user uploaded here, in the order given, at most six.
    const want = Array.isArray(b.samples) ? b.samples.map(String) : [];
    if (want.length) {
      const own = await db.prepare('SELECT url FROM marketplace_samples WHERE user_id = ?').all(uid);   // v3.3.10: marked pictures are no longer refused
      const ok = {}; own.forEach(function (r) { ok[r.url] = true; });
      want.forEach(function (u) { if (ok[u] && d.samples.indexOf(u) < 0 && d.samples.length < MAX_SAMPLES) d.samples.push(u); });
    }
    const submit = !!b.submit;
    if (submit && !(await emailConfirmed(db, uid))) return res.status(403).json({ error: CONFIRM_FIRST });   // v3.3.06
    if (submit) {
      const miss = [];
      if (!d.display_name) miss.push('a name');
      if (!d.headline) miss.push('a headline');
      if (!d.roles.length) miss.push('at least one kind of help you offer');
      if (d.bio.length < 40) miss.push('a few sentences about you and your work');
      if (d.roles.indexOf('artist') >= 0 && !d.samples.length) miss.push('at least one sample picture (you offer art)');
      if (d.roles.indexOf('artist') >= 0 && !d.media.length) miss.push('how you make your art (tick at least one)');   // v3.3.10
      if (miss.length) return res.status(400).json({ error: 'Before it can be reviewed, add ' + miss.join(', ') + '.', missing: miss });
      // v3.3.07 -- the tick box (Ian: "A terms check box that says they read it"). Once ticked for this version it stays ticked.
      if (b.accept_terms !== true && !(row && row.terms_version === MKT_TERMS_VERSION)) return res.status(400).json({ error: 'Tick the box to say you have read the Marketplace Terms.', terms: true });
    }
    const now = new Date().toISOString();
    const cols = [d.display_name, d.headline, d.roles.join(','), d.bio, JSON.stringify(d.links), d.rates, d.availability, JSON.stringify(d.samples)];
    let status = row ? row.status : 'draft';
    const live = row ? jparse(row.live_json, null) : null;
    // v3.3.06 -- EDITS TO AN APPROVED LISTING GO LIVE AT ONCE (Ian, 2026-10-27: "they can go live right away for now.
    // Maybe they show up on the review list as altered"). Once Ian has approved a listing (reviewed_json), Send for
    // review publishes the new copy straight away; the review window marks it Altered until Ian looks at it again.
    // A listing never approved still waits for him.
    const goLive = submit && !!(row && row.reviewed_json);
    if (submit) status = goLive ? 'approved' : 'pending';
    if (!row) {
      await db.prepare(
        'INSERT INTO marketplace_listings (user_id, display_name, headline, roles, bio, links, rates, availability, samples, status, paused, submitted_at, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?)'
      ).run(...[uid].concat(cols, [status, submit ? now : null, now, now]));
    } else {
      await db.prepare(
        'UPDATE marketplace_listings SET display_name = ?, headline = ?, roles = ?, bio = ?, links = ?, rates = ?, availability = ?, samples = ?, status = ?, ' +
        'submitted_at = ?, updated_at = ? WHERE user_id = ?'
      ).run(...cols.concat([status, submit ? now : (row.submitted_at || null), now, uid]));
    }
    await db.prepare('UPDATE marketplace_listings SET media = ?, medium = ? WHERE user_id = ?').run(d.media.join(','), d.medium, uid);   // v3.3.10
    if (goLive) await db.prepare('UPDATE marketplace_listings SET live_json = ?, admin_note = NULL WHERE user_id = ?').run(JSON.stringify(d), uid);
    if (submit && b.accept_terms === true) await db.prepare('UPDATE marketplace_listings SET terms_version = ?, terms_accepted_at = ? WHERE user_id = ?').run(MKT_TERMS_VERSION, now, uid);   // v3.3.07
    const fresh = await db.prepare('SELECT * FROM marketplace_listings WHERE user_id = ?').get(uid);
    if (submit && status === 'pending') notifySupport(db, uid, fresh, !!live);   // v3.3.03 -- not awaited: the save never waits on email
    else if (goLive && !sameContent(d, live)) notifySupport(db, uid, fresh, true, true);   // v3.3.06 -- already live: support is told it is Altered
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
    // v3.3.05 -- TOO SMALL TO SHOW YOUR WORK. Checked before anything is stored or looked at, so a refused picture
    // costs nothing. HEIC has already been converted by guardUpload, so this reads the real picture. If its size
    // cannot be read, the upload goes on as before (the watermark check still runs).
    const dims = await sampleSize(req.file.buffer);
    if (dims && Math.max(dims.w, dims.h) < MIN_SAMPLE_SIDE) {
      return res.status(400).json({ error: 'This picture is too small to show your work well (' + dims.w + ' \u00d7 ' + dims.h + '). Upload one at least ' + MIN_SAMPLE_SIDE + ' pixels wide or tall.', too_small: true });
    }
    const db = await getDb();
    const uid = req.session.userId;
    const n = await db.prepare('SELECT COUNT(*) AS n FROM marketplace_samples WHERE user_id = ?').get(uid);
    if (Number(n && n.n) >= MAX_SAMPLE_UPLOADS) return res.status(429).json({ error: 'You have uploaded a lot of sample pictures. Write to support@campaignia.com and we will make room.' });
    const ext = req.file.mimetype === 'image/png' ? '.png' : (req.file.mimetype === 'image/webp' ? '.webp' : '.jpg');
    const name = 'mkt-' + uid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    const storage = require('../storage/storage');
    const url = await storage.uploadFile(req.file.buffer, name, req.file.mimetype, 'marketplace');
    // v3.3.10 -- MARKS ARE SHOWN TO IAN, NEVER REFUSED HERE (Ian, 2026-10-27). Artists often watermark or sign their own
    // portfolio, so a watermark, a signature or a stock library named in the file is information for the review window,
    // not a reason to turn the picture away. The same free check runs, but its answer is kept on marketplace_samples
    // only: passing no url to checkUpload means it is not recorded as a rejected picture for the rest of Campaignia,
    // which would hide it from the listing.
    let verdict = 'ok', reasons = [];
    try {
      const r = await require('../services/rightsCheck').checkUpload(null, req.file, req.file.buffer, { kind: 'marketplace', userId: uid });
      verdict = (r && r.verdict) || 'ok'; reasons = ((r && r.reasons) || []).map(function (x) { return x && x.text; }).filter(Boolean);
    } catch (e) { verdict = 'unchecked'; }
    await db.prepare('INSERT INTO marketplace_samples (user_id, url, verdict, reasons, created_at) VALUES (?, ?, ?, ?, ?)').run(uid, url, verdict, JSON.stringify(reasons), new Date().toISOString());
    res.json({ ok: true, url: url, verdict: verdict, reasons: reasons });
  } catch (e) { console.error('[marketplace] sample: ' + (e && e.message)); res.status(500).json({ error: 'Could not upload that picture right now.' }); }
});

// v3.3.05 -- a picture's width and height, or null. sharp is already a dependency; required here so a missing
// or broken sharp never stops the route loading.
async function sampleSize(buf) {
  try {
    const m = await require('sharp')(buf, { failOn: 'none' }).metadata();
    if (!m || !m.width || !m.height) return null;
    const turned = m.orientation && m.orientation >= 5;   // a phone photo stored on its side
    return turned ? { w: m.height, h: m.width } : { w: m.width, h: m.height };
  } catch (e) { return null; }
}

// ---------- Make contact ----------
router.post('/listings/:id/contact', requireAuth, gate, async function (req, res) {
  try {
    if (req.session.impersonatorId) return res.status(403).json({ error: 'Make contact is switched off while you are signed in as someone else.' });
    const db = await getDb();
    const me = await db.prepare('SELECT id, name, pen_name, email FROM users WHERE id = ?').get(req.session.userId);
    if (!me || !me.email) return res.status(403).json({ error: 'Your account needs an email address first.' });
    if (!(await emailConfirmed(db, me.id))) return res.status(403).json({ error: CONFIRM_FIRST });   // v3.3.06
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
    // v3.3.10 -- what the check said at upload, kept with the sample (pictures uploaded before this release use the lookup above)
    try {
      const srows = await db.prepare('SELECT url, verdict, reasons FROM marketplace_samples').all();
      srows.forEach(function (x) { if (x.reasons != null) verdicts[x.url] = { verdict: x.verdict, reasons: jparse(x.reasons, []).map(function (t) { return { text: t }; }) }; });
    } catch (e) { /* the lookup above stands */ }
    res.json({ listings: rows.map(function (r) {
      const m = mineOf(r);
      m.user_id = r.user_id; m.owner = { name: r.owner_name || '', email: r.owner_email || '', pen_name: r.owner_pen || '' };
      m.live = jparse(r.live_json, null); m.reviewed = jparse(r.reviewed_json, null); m.contacts = Number(r.contacts) || 0;   // v3.3.06
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
      const wasAltered = !!row.reviewed_json;   // approving an altered listing just accepts the changes: no "you're live" email
      await db.prepare("UPDATE marketplace_listings SET live_json = ?, reviewed_json = ?, status = 'approved', admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(draftOf(row)), JSON.stringify(draftOf(row)), note, now, by, now, row.id);
      if (wasAltered && !note) { const f0 = await db.prepare('SELECT * FROM marketplace_listings WHERE id = ?').get(row.id); return res.json({ ok: true, emailed: false, listing: mineOf(f0) }); }
      subject = 'Your Campaignia Marketplace listing is live';
      body = '<p>Good news: your listing is now on the Campaignia Marketplace, and members can find you and make contact.</p>' + (note ? '<p>' + esc(note) + '</p>' : '');
    } else if (action === 'decline') {
      if (!note) return res.status(400).json({ error: 'Say what needs to change, so they can fix it.' });
      // v3.3.06 -- on a listing approved before, Send back also puts the live copy back to what was approved
      await db.prepare("UPDATE marketplace_listings SET status = 'declined', live_json = COALESCE(reviewed_json, live_json), admin_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(note, now, by, now, row.id);
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
    } else if (action === 'unapprove') {
      // v3.3.04 -- BACK TO REVIEW (Ian, 2026-10-27: "a way for me to unapprove a listing so I can test the approval
      // process over and over"). The listing goes back to 'pending' as if just sent: the approved copy is dropped,
      // so it leaves the directory, and nobody is emailed (neither the person nor support).
      await db.prepare("UPDATE marketplace_listings SET status = 'pending', live_json = NULL, reviewed_json = NULL, admin_note = ?, submitted_at = ?, reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?")
        .run(note, now, now, row.id);
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

// =====================================================================================================
// v3.3.08 -- TD-1037. THE MARKETPLACE'S OWN PAGES, BUILT ON THE SERVER (Ian, 2026-10-27: "can you build this now?").
// The Library tab draws listings with JavaScript, so a search engine saw an empty page. These pages arrive complete:
//   /marketplace                 every live listing, as links (the page search engines start from)
//   /marketplace/<name>-<id>     one listing: title, description, share preview, structured data, pictures
//   /sitemap-marketplace.xml     both of the above, listed in the sitemap index (routes/story-pages.js)
// While the switch is off they answer 404 to everyone but an admin, who sees them marked noindex with the preview line.
// Make contact and the picture viewer on these pages are the same window as the Library's (public/js/marketplace.js).
// =====================================================================================================
const pages = express.Router();
function siteBase() { return String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || 'https://campaignia.com').replace(/\/+$/, ''); }
function absUrl(u) { u = String(u || ''); return /^https?:\/\//i.test(u) ? u : siteBase() + (u.charAt(0) === '/' ? '' : '/') + u; }
function jsonLd(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }
function clipWords(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); if (t.length <= n) return t; t = t.slice(0, n - 1); const sp = t.lastIndexOf(' '); return (sp > n * 0.6 ? t.slice(0, sp) : t) + '\u2026'; }
const ROLE_ONE_SRV = { artist: 'Artist / Illustrator', writer: 'Writer / Narrative Editor', editor: 'Campaignia Editor' };
const ROLE_SEO = { artist: 'illustrator for hire', writer: 'writer and narrative editor for hire', editor: 'Campaignia book editor for hire' };
const AVAIL_SRV = { open: 'Taking work', limited: 'Limited availability', closed: 'Not taking work right now' };

async function pageAccess(req) {
  const db = await getDb();
  const on = await isEnabled(db);
  if (on) return { db: db, on: true, preview: false };
  const v = await viewer(db, req);
  return { db: db, on: false, preview: !!(v && v.admin), ok: !!(v && v.admin) };
}
function pageShell(o) {
  // o: title, description, canonical, robots, ogImage, jsonld, body, preview
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    '<link rel="stylesheet" href="/css/fonts.css">\n<link rel="stylesheet" href="/css/marketplace.css?v=' + PAGE_ASSET_V + '">\n' +
    '<title>' + esc(o.title) + '</title>\n<meta name="description" content="' + esc(o.description) + '" />\n' +
    (o.robots ? '<meta name="robots" content="' + esc(o.robots) + '" />\n' : '') +
    (o.canonical ? '<link rel="canonical" href="' + esc(o.canonical) + '" />\n' : '') +
    '<meta property="og:site_name" content="Campaignia" />\n<meta property="og:type" content="' + esc(o.ogType || 'website') + '" />\n' +
    '<meta property="og:title" content="' + esc(o.title) + '" />\n<meta property="og:description" content="' + esc(o.description) + '" />\n' +
    (o.canonical ? '<meta property="og:url" content="' + esc(o.canonical) + '" />\n' : '') +
    (o.ogImage ? '<meta property="og:image" content="' + esc(o.ogImage) + '" />\n<meta name="twitter:card" content="summary_large_image" />\n<meta name="twitter:image" content="' + esc(o.ogImage) + '" />\n' : '<meta name="twitter:card" content="summary" />\n') +
    '<meta name="twitter:title" content="' + esc(o.title) + '" />\n<meta name="twitter:description" content="' + esc(o.description) + '" />\n' +
    '<link rel="icon" type="image/png" href="/images/Campaignia_Favicon.png" />\n' +
    (o.jsonld ? '<script type="application/ld+json">' + jsonLd(o.jsonld) + '</script>\n' : '') +
    '</head>\n<body class="mkt-page">\n' +
    '<nav class="mkt-page-nav"><a href="/" class="mkt-page-logo"><img src="/images/Campaignia_Logo.png" alt="Campaignia" /><span>Campaignia</span></a>' +
      '<span class="mkt-page-navlinks"><a href="/marketplace">Marketplace</a><a href="/library">Library</a><a class="mkt-page-cta" href="/login">Create your own</a></span></nav>\n' +
    '<main class="mkt-wrap mkt-page-main">' + (o.preview ? '<div class="mkt-preview-line">The Marketplace is switched off. Only admins can see this page, and search engines are told not to list it.</div>' : '') + o.body + '</main>\n' +
    '<footer class="mkt-page-foot">&copy; ' + new Date().getFullYear() + ' So It Begins, LLC &middot; Campaignia &middot; <a href="/">Home</a> &middot; <a href="/library">Library</a> &middot; <a href="/marketplace-terms.html">Marketplace Terms</a> &middot; <a href="/terms.html">Terms</a> &middot; <a href="/privacy.html">Privacy</a></footer>\n' +
    '<script src="/js/marketplace.js?v=' + PAGE_ASSET_V + '" defer></script>\n</body>\n</html>\n';
}
const PAGE_ASSET_V = '3.3.12';   // the marketplace.css / marketplace.js version these pages ask for; bump with them
// v3.3.10 -- how the art is made, on the cards and the page
function mediaTagsSrv(p) {
  if (!p.media || !p.media.length) return '';
  return '<div class="mkt-media">' + p.media.map(function (m) { return '<span class="mkt-medium-tag' + (/^ai-/.test(m) ? ' mkt-medium-ai' : '') + '">' + esc(MEDIA_NAMES[m] || m) + '</span>'; }).join('') + '</div>';
}
function mediaHtmlSrv(p) {
  if ((!p.media || !p.media.length) && !p.medium) return '';
  return '<div class="mkt-label">Medium</div>' + mediaTagsSrv(p) + (p.medium ? '<div class="mkt-medium-text">' + esc(p.medium) + '</div>' : '');
}
function notFound(res, on) {
  res.status(404).set('Cache-Control', 'no-store').type('html').send(pageShell({
    title: 'Not on the Marketplace | Campaignia', description: 'This listing is not on the Campaignia Marketplace.', robots: 'noindex',
    body: '<h1 class="mkt-page-h1">This listing isn\u2019t on the Marketplace</h1><p class="mkt-intro">It may have been paused or taken down.' +
      (on ? ' <a href="/marketplace">See everyone on the Marketplace</a>.' : '') + '</p>' }));
}

pages.get('/marketplace', async function (req, res) {
  try {
    const a = await pageAccess(req);
    if (!a.on && !a.ok) return notFound(res, false);
    const rows = await a.db.prepare(
      "SELECT l.id, l.live_json, l.reviewed_at FROM marketplace_listings l JOIN users u ON u.id = l.user_id " +
      "WHERE l.live_json IS NOT NULL AND l.status <> 'removed' AND l.paused = false AND COALESCE(u.status, 'active') = 'active' " +
      "ORDER BY l.reviewed_at DESC NULLS LAST, l.id DESC LIMIT 1000").all();
    const list = rows.map(publicOf).filter(Boolean);
    const cards = list.map(function (p) {
      const pic = p.samples[0] ? '<img class="mkt-card-img" src="' + esc(p.samples[0]) + '" alt="Sample of ' + esc(p.name) + '\u2019s work" loading="lazy">' : '<div class="mkt-card-img mkt-card-ph">' + esc((p.name || '?').charAt(0).toUpperCase()) + '</div>';
      return '<a class="mkt-card" href="' + esc(p.path) + '">' + pic + '<div class="mkt-card-body"><h2 class="mkt-card-name">' + esc(p.name) + '</h2><div class="mkt-card-head">' + esc(p.headline) + '</div>' +
        '<div class="mkt-pills">' + p.roles.map(function (r) { return '<span class="mkt-pill mkt-pill-' + esc(r) + '">' + esc(ROLE_ONE_SRV[r] || r) + '</span>'; }).join('') + '</div>' +
        mediaTagsSrv(p) + '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_SRV[p.availability] || '') + '</div></div></a>';
    }).join('');
    const canonical = siteBase() + '/marketplace';
    res.set('Cache-Control', a.preview ? 'no-store' : 'public, max-age=300').type('html').send(pageShell({
      title: 'Hire artists, illustrators, writers and editors for your book | Campaignia Marketplace',
      description: 'Find an illustrator to draw your story, a writer or editor to polish it, or a Campaignia editor to put your book together. Contact them directly; Campaignia takes no fee.',
      canonical: canonical, robots: a.preview ? 'noindex' : null, preview: a.preview,
      jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Campaignia Marketplace', url: canonical,
        mainEntity: { '@type': 'ItemList', itemListElement: list.slice(0, 100).map(function (p, i) { return { '@type': 'ListItem', position: i + 1, url: siteBase() + p.path, name: p.name }; }) } },
      body: '<h1 class="mkt-page-h1">The Campaignia Marketplace</h1>' +
        '<p class="mkt-intro">Find people to help make your book: artists and illustrators to draw it, writers and narrative editors to polish the words, and Campaignia editors to put it together. ' +
        'Press <b>Make contact</b> on a listing and they reply to your email. Campaignia takes no fee and is not part of any arrangement you make.</p>' +
        '<div class="mkt-bar"><a class="mkt-btn" href="/library#marketplace">Filter by kind of help</a><a class="mkt-btn mkt-list-me" href="/library#marketplace">List yourself</a></div>' +
        (list.length ? '<div class="mkt-grid">' + cards + '</div>' : '<div class="mkt-empty">Nobody is listed yet.</div>') }));
  } catch (e) { console.error('[marketplace] index page: ' + (e && e.message)); res.status(500).set('Cache-Control', 'no-store').send('Server error'); }
});

pages.get('/marketplace/:slug', async function (req, res) {
  try {
    const a = await pageAccess(req);
    if (!a.on && !a.ok) return notFound(res, false);
    const m = /-(\d+)$/.exec(String(req.params.slug || ''));
    if (!m) return notFound(res, a.on);
    const row = await a.db.prepare("SELECT l.id, l.live_json, l.reviewed_at, l.updated_at, l.status, l.paused, u.status AS user_status FROM marketplace_listings l JOIN users u ON u.id = l.user_id WHERE l.id = ?").get(Number(m[1]));
    const p = row && row.status !== 'removed' && !row.paused && (row.user_status || 'active') === 'active' ? publicOf(row) : null;
    if (!p) return notFound(res, a.on);
    if ('/marketplace/' + req.params.slug !== p.path) return res.redirect(301, p.path);   // renamed: the old address keeps working
    const canonical = siteBase() + p.path;
    const roleWords = p.roles.map(function (r) { return ROLE_SEO[r]; }).filter(Boolean);
    const title = clipWords(p.name + ' \u2014 ' + (p.headline || roleWords[0] || 'on the Campaignia Marketplace'), 70) + ' | Campaignia Marketplace';
    const description = clipWords((p.headline ? p.headline + '. ' : '') + p.bio, 158);
    const pics = p.samples.map(function (u, i) {
      return '<button type="button" class="mkt-page-pic" data-zoom="' + esc(u) + '" title="Click to see it bigger"><img src="' + esc(u) + '" alt="Sample of ' + esc(p.name) + '\u2019s work (' + (i + 1) + ' of ' + p.samples.length + ')"' + (i > 1 ? ' loading="lazy"' : '') + '></button>';
    }).join('');
    const links = p.links.map(function (u) { const label = u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''); return '<a href="' + esc(u) + '" target="_blank" rel="nofollow noopener noreferrer ugc">' + esc(label) + '</a>'; }).join('');
    res.set('Cache-Control', a.preview ? 'no-store' : 'public, max-age=300').type('html').send(pageShell({
      title: title, description: description, canonical: canonical, robots: a.preview ? 'noindex' : null, preview: a.preview,
      ogType: 'profile', ogImage: p.samples[0] ? absUrl(p.samples[0]) : null,
      jsonld: { '@context': 'https://schema.org', '@type': 'ProfilePage', url: canonical, dateModified: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
        mainEntity: { '@type': 'Person', name: p.name, description: p.headline || undefined, jobTitle: p.roles.map(function (r) { return ROLE_ONE_SRV[r]; }).join(', ') || undefined,
          image: p.samples[0] ? absUrl(p.samples[0]) : undefined, sameAs: p.links.length ? p.links : undefined } },
      // v3.3.12 -- Back (Ian): to wherever they came from on this site -- the app, the Library tab, the Marketplace page --
      // and to the Marketplace page when they arrived from outside (a search result, a shared link). marketplace.js decides.
      body: '<div class="mkt-page-crumb"><a class="mkt-back" href="/marketplace" data-back="1">&larr; Back to the Marketplace</a>' +
        '<span class="mkt-crumb-trail"><a href="/marketplace">Marketplace</a> &rsaquo; ' + esc(p.name) + '</span></div>' +
        '<div class="mkt-detail mkt-page-detail">' +
          '<div class="mkt-detail-pics"><div class="mkt-page-pics">' + (pics || '<div class="mkt-empty">No sample pictures.</div>') + '</div></div>' +
          '<div class="mkt-detail-text">' +
            '<h1 class="mkt-page-h1 mkt-title">' + esc(p.name) + '</h1>' +
            '<div class="mkt-head">' + esc(p.headline) + '</div>' +
            '<div class="mkt-pills">' + p.roles.map(function (r) { return '<span class="mkt-pill mkt-pill-' + esc(r) + '">' + esc(ROLE_ONE_SRV[r] || r) + '</span>'; }).join('') + '</div>' +
            '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_SRV[p.availability] || '') + '</div>' +
            mediaHtmlSrv(p) +
            '<div class="mkt-bio">' + esc(p.bio) + '</div>' +
            (p.rates ? '<div class="mkt-label">Rates</div><div>' + esc(p.rates) + '</div>' : '') +
            (links ? '<div class="mkt-label">Links</div><div class="mkt-links">' + links + '</div>' : '') +
            // v3.3.09 -- the Make contact form sits on the page itself (Ian). Filled in by marketplace.js, because whether
            // you are signed in, or this is your own listing, is per visitor and this page is cached for everyone.
            '<div class="mkt-page-contact" id="mkt-page-contact" data-listing="' + esc(p.id) + '"><span class="mkt-spin"></span></div>' +
            '<div class="mkt-row" style="margin-top:10px;"><button type="button" class="mkt-linkbtn" data-copy="' + esc(canonical) + '">Copy link to this page</button></div>' +
          '</div></div>' }));
  } catch (e) { console.error('[marketplace] listing page: ' + (e && e.message)); res.status(500).set('Cache-Control', 'no-store').send('Server error'); }
});

pages.get('/sitemap-marketplace.xml', async function (req, res) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  try {
    const db = await getDb();
    if (await isEnabled(db)) {   // nothing is listed while the switch is off
      const x = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
      parts.push('<url><loc>' + x(siteBase() + '/marketplace') + '</loc></url>');
      const rows = await db.prepare(
        "SELECT l.id, l.live_json, l.updated_at FROM marketplace_listings l JOIN users u ON u.id = l.user_id " +
        "WHERE l.live_json IS NOT NULL AND l.status <> 'removed' AND l.paused = false AND COALESCE(u.status, 'active') = 'active' ORDER BY l.id LIMIT 10000").all();
      rows.forEach(function (r) {
        const live = jparse(r.live_json, null); if (!live) return;
        let lm = ''; try { lm = r.updated_at ? new Date(r.updated_at).toISOString() : ''; } catch (e) { lm = ''; }
        parts.push('<url><loc>' + x(siteBase() + listingPath(r.id, live.display_name)) + '</loc>' + (lm ? '<lastmod>' + lm + '</lastmod>' : '') + '</url>');
      });
    }
  } catch (e) { console.error('[marketplace] sitemap: ' + (e && e.message)); }
  parts.push('</urlset>');
  res.set('Content-Type', 'application/xml; charset=utf-8').send(parts.join('\n'));
});

module.exports = router;
module.exports.pages = pages;
module.exports._test = { cleanMedia: cleanMedia, MEDIA: MEDIA, slugify: slugify, listingPath: listingPath, pageShell: pageShell, jsonLd: jsonLd, MKT_TERMS_VERSION: MKT_TERMS_VERSION, sampleSize: sampleSize, MIN_SAMPLE_SIDE: MIN_SAMPLE_SIDE, cleanRoles: cleanRoles, cleanLinks: cleanLinks, publicOf: publicOf, draftOf: draftOf, mineOf: mineOf, sameContent: sameContent, LIMITS: LIMITS };
