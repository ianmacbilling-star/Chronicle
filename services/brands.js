'use strict';
// v3.4.69 -- TWO BRANDS: the brand list, and how each page's brand is chosen (TD-1105; Ian, 2026-11-06).
//
// One code base, one database, one domain for now. Brand 2 is named Story (Ian, 2026-11-06); its key stays brand2. A brand is presentation only: its theme sheet today,
// later its name, words, emails and genre line-up. Each brand has a fixed internal KEY that customers never
// see; accounts remember the key (users.home_brand), so renaming a brand never touches stored data.
//
// HOW A PAGE'S BRAND IS CHOSEN, first match wins:
//   1. the staging switch: ?brand=<key> on any page, remembered by that browser (cmp_brand_switch);
//      ?brand=clear forgets it. Never on production.
//   2. the BRAND Railway variable (staging only): the whole staging site shows that brand.
//   3. a brand's own web address (BRANDS[k].hosts), once a brand has one.
//   4. the signed-in person's brand (users.home_brand, cached in the session).
//   5. the landing page the visitor last came through (cmp_entry; /story is brand 2's).
//   6. Campaignia.
// A brand that is not LIVE is never chosen on production, whatever the rest says. Brand 2 starts not live,
// so production keeps Campaignia everywhere until Ian switches it on here.
//
// THE PAGE DOES THE DRAWING. The server only names the brand, in the cmp_brand cookie (readable by the page,
// never set for Campaignia). Each page's head reads it and, for any brand but Campaignia, lays that brand's
// theme sheet over Campaignia's before the first paint. Static files stay the same for everyone, so the
// Cloudflare cache never mixes brands up.

const BRANDS = {
  campaignia: { key: 'campaignia', name: 'Campaignia', live: true, hosts: ['campaignia.com', 'www.campaignia.com'], landing: ['/game-masters'], sheet: '/css/themes/campaignia.css' },
  brand2:     { key: 'brand2',     name: 'Story',      live: false, hosts: [],                                       landing: ['/story'],        sheet: '/css/themes/brand2.css' }
};
const DEFAULT_BRAND = 'campaignia';
const PROD_HOSTS = ['campaignia.com', 'www.campaignia.com'];   // the same list as server.js PROD_HOSTS

const COOKIE_BRAND = 'cmp_brand';          // what this page should show (read by the page)
const COOKIE_SWITCH = 'cmp_brand_switch';  // the staging switch
const COOKIE_ENTRY = 'cmp_entry';          // the landing page the visitor came through
const DAY = 24 * 60 * 60 * 1000;

function isKnown(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(BRANDS, k); }
function isProdHost(host) { return PROD_HOSTS.indexOf(String(host || '').toLowerCase()) !== -1; }
function allowed(k, prod) { return isKnown(k) && (BRANDS[k].live || !prod); }
function anyOtherLive() { return Object.keys(BRANDS).some(function (k) { return k !== DEFAULT_BRAND && BRANDS[k].live; }); }

function readCookie(req, name) {
  var raw = (req && req.headers && req.headers.cookie) || '';
  var parts = raw.split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim(); var eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq) === name) { try { return decodeURIComponent(p.slice(eq + 1)); } catch (e) { return null; } }
  }
  return null;
}

function landingBrand(path) {
  var p = String(path || '').toLowerCase().replace(/\/+$/, '') || '/';
  var keys = Object.keys(BRANDS);
  for (var i = 0; i < keys.length; i++) if (BRANDS[keys[i]].landing.indexOf(p) !== -1) return keys[i];
  return null;
}

function hostBrand(host) {
  var h = String(host || '').toLowerCase(); var keys = Object.keys(BRANDS);
  for (var i = 0; i < keys.length; i++) if (BRANDS[keys[i]].hosts.indexOf(h) !== -1) return keys[i];
  return null;
}

// The rule above, as a pure function: { brand, why }.
function pick(o) {
  var prod = !!o.prod;
  if (!prod && allowed(o.sw, prod)) return { brand: o.sw, why: 'switch' };
  var env = o.env ? String(o.env).trim().toLowerCase() : '';
  if (!prod && allowed(env, prod)) return { brand: env, why: 'variable' };
  var hb = hostBrand(o.host);
  if (allowed(hb, prod)) return { brand: hb, why: 'address' };
  if (allowed(o.userBrand, prod)) return { brand: o.userBrand, why: 'account' };
  if (allowed(o.entry, prod)) return { brand: o.entry, why: 'landing' };
  return { brand: DEFAULT_BRAND, why: 'default' };
}

// The brand a new account is given at sign-up: the same rule without step 4 (nobody is signed in yet).
function forSignup(req) {
  try {
    var host = req.hostname; var prod = isProdHost(host);
    return pick({ prod: prod, host: host, sw: readCookie(req, COOKIE_SWITCH), env: process.env.BRAND, userBrand: null, entry: readCookie(req, COOKIE_ENTRY) }).brand;
  } catch (e) { return DEFAULT_BRAND; }
}

// v3.4.75 -- the Brand Theme choice on the Account page (Ian, 2026-11-06: everyone may switch; customers switch themselves).
// The brands a person may pick here: every live brand, plus the not-yet-live ones off production. With only one
// to pick from (production today), the Account page hides the choice. `override` names a staging switch or the
// BRAND variable when one of them outranks the account, so the page can say why a change does not show.
function choicesFor(req, userBrand) {
  var host = req.hostname; var prod = isProdHost(host);
  var list = Object.keys(BRANDS).filter(function (k) { return allowed(k, prod); }).map(function (k) { return { key: k, name: BRANDS[k].name }; });
  var current = allowed(userBrand, prod) ? userBrand : DEFAULT_BRAND;
  var r = pick({ prod: prod, host: host, sw: readCookie(req, COOKIE_SWITCH), env: process.env.BRAND, userBrand: current, entry: readCookie(req, COOKIE_ENTRY) });
  var override = ((r.why === 'switch' || r.why === 'variable' || r.why === 'address') && r.brand !== current) ? r.why : null;
  return { show: list.length > 1, current: current, brands: list, override: override, showing: r.brand };
}
function canChoose(req, key) { return allowed(key, isProdHost(req.hostname)); }

// v3.4.79 -- TD-1105. BRAND WORDS ON THE SERVER: emails and the help assistant (Ian, 2026-11-06: "Just swap...
// Campaign for Story and Session for Chapter in the emails and in the brain"). The product is still called
// Campaignia on every brand, and the logo stays. The same lists as public/js/brand-words.js (the page's swap).
const WORDS = {
  brand2: [['campaign', 'campaigns', 'story', 'stories'], ['session', 'sessions', 'chapter', 'chapters']]
};
function wordsOn(key) { return (isKnown(key) && Object.prototype.hasOwnProperty.call(WORDS, key) && WORDS[key].length) ? WORDS[key] : null; }
// People's own words (a campaign's name, a book title, a gift message) are wrapped by keep() where an email puts
// them in; the swap skips what is between the markers, and sendEmail strips every marker on every brand.
const KEEP_OPEN = '\u0001', KEEP_CLOSE = '\u0002';
function keep(v) { return (v == null || v === '') ? v : KEEP_OPEN + String(v) + KEEP_CLOSE; }
function stripKeep(s) { return (s == null) ? s : String(s).replace(/[\u0001\u0002]/g, ''); }
function swapPlain(key, s) {
  var list = wordsOn(key); if (!list || !s) return s;
  var map = {}, keys = [];
  list.forEach(function (w) { map[w[0]] = w[2]; map[w[1]] = w[3]; keys.push(w[1], w[0]); });
  // Whole words only, and never inside a web address or a file path (/sessions/12, campaign-url, .session).
  var rx = new RegExp('(?<![\\w/.?&=#-])(' + keys.join('|') + ')(?![\\w/=-])', 'gi');
  // A web address written out as text (https://... or www....) is left exactly as it is.
  return String(s).split(/((?:https?:\/\/|www\.)\S+)/i).map(function (part, i) {
    if (i % 2 === 1) return part;
    return part.replace(rx, function (hit) {
      var to = map[hit.toLowerCase()];
      if (hit === hit.toUpperCase()) return to.toUpperCase();
      if (hit.charAt(0) === hit.charAt(0).toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1);
      return to;
    });
  }).join('').replace(new RegExp('\\b(' + list.map(function (w) { return w[3] + '|' + w[2]; }).join('|') + ')(?:\\s*/\\s*|\\s+)\\1\\b', 'gi'), '$1');   // v3.4.80 -- "chapter/chapter" -> "chapter"
}
// A subject line or other plain text: swap everything outside the kept parts.
function swapText(key, s) {
  if (s == null || !wordsOn(key)) return s;
  return String(s).split(/(\u0001[\s\S]*?\u0002)/).map(function (part) { return part.charAt(0) === KEEP_OPEN ? part : swapPlain(key, part); }).join('');
}
// An email's HTML: only the words between tags; never a tag (links, class names), a <style> block, or a kept part.
function swapHtml(key, html) {
  if (html == null || !wordsOn(key)) return html;
  return String(html).split(/(<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>|<[^>]*>|\u0001[\s\S]*?\u0002)/i).map(function (part) {
    if (!part || part.charAt(0) === '<' || part.charAt(0) === KEEP_OPEN) return part;
    return swapPlain(key, part);
  }).join('');
}
// Which brand's words an email to this address gets: the account's home brand, if that brand has words and is
// allowed where this server runs. Production with only Campaignia live: no database read at all.
function appHost() { try { return new URL(process.env.APP_URL || 'https://campaignia.com').hostname; } catch (e) { return 'campaignia.com'; } }
async function emailBrand(getDb, to) {
  if (typeof to !== 'string' || !to.trim() || to.indexOf(',') !== -1) return null;
  var prod = isProdHost(appHost());
  if (prod && !anyOtherLive()) return null;
  var db = await getDb();
  var u = await db.prepare('SELECT home_brand FROM users WHERE LOWER(email) = LOWER(?)').get(to.trim());
  var k = u && u.home_brand;
  return (allowed(k, prod) && wordsOn(k)) ? k : null;
}
// The help assistant: the brand the person is looking at right now (the page's cmp_brand cookie, checked
// against this host), so its answers match the screen. Returns the instruction line, or '' for Campaignia.
function helpWordsLine(req) {
  var host = req && req.hostname; var prod = isProdHost(host);
  if (prod && !anyOtherLive()) return '';
  var k = readCookie(req, COOKIE_BRAND);
  var list = (allowed(k, prod) && wordsOn(k)) ? WORDS[k] : null;
  if (!list) return '';
  var pairs = list.map(function (w) { return 'a ' + w[0] + ' is called a ' + w[2] + ' (' + w[1] + ' are ' + w[3] + ')'; }).join(', and ');
  return 'BRAND WORDS: this person uses Campaignia with some words changed on every screen: ' + pairs + '. ' +
    'Use those words in every reply, for things and for screen and button names alike (so "+ New story", "My Stories", "+ New chapter"), ' +
    'even where the Brain says the other word. Buttons that already say Story, such as Generate Story, keep their names. ' +
    'The product is still called Campaignia; never call it anything else.';
}

function isPagePath(path) {
  var p = String(path || '');
  if (/^\/(api|css|js|images|fonts|uploads)\//i.test(p)) return false;
  if (/^\/(health|version)\/?$/i.test(p)) return false;
  var last = p.slice(p.lastIndexOf('/') + 1);
  return last.indexOf('.') === -1 || /\.html$/i.test(last);
}

function setCookie(res, req, name, value, maxAge) {
  res.cookie(name, value, { path: '/', sameSite: 'lax', secure: !!req.secure, httpOnly: false, maxAge: maxAge });
}
function clearCookie(res, req, name) { res.clearCookie(name, { path: '/', sameSite: 'lax', secure: !!req.secure }); }

// Express middleware for page requests. Mounted after the session, before the static files and page routes.
function middleware(getDb) {
  return async function brandForPage(req, res, next) {
    try {
      if (req.method !== 'GET' || !isPagePath(req.path)) return next();
      var host = req.hostname; var prod = isProdHost(host);
      // Production with only Campaignia live: there is nothing to decide. No database read, no cookie.
      if (prod && !anyOtherLive()) {
        if (readCookie(req, COOKIE_BRAND)) clearCookie(res, req, COOKIE_BRAND);
        return next();
      }
      var sw = readCookie(req, COOKIE_SWITCH);
      if (!prod && typeof req.query.brand === 'string') {
        var q = req.query.brand.trim().toLowerCase();
        if (q === 'clear' || q === 'off' || q === '') { clearCookie(res, req, COOKIE_SWITCH); sw = null; }
        else if (isKnown(q)) { setCookie(res, req, COOKIE_SWITCH, q, 30 * DAY); sw = q; }
      }
      var entry = readCookie(req, COOKIE_ENTRY);
      var lb = landingBrand(req.path);
      if (lb && allowed(lb, prod)) { if (entry !== lb) setCookie(res, req, COOKIE_ENTRY, lb, 180 * DAY); entry = lb; }
      var userBrand = null;
      if (req.session && req.session.userId) {
        if (req.session.brandUid !== req.session.userId) {
          var db = await getDb();
          var u = await db.prepare('SELECT home_brand FROM users WHERE id = ?').get(req.session.userId);
          req.session.brand = (u && isKnown(u.home_brand)) ? u.home_brand : DEFAULT_BRAND;
          req.session.brandUid = req.session.userId;
        }
        userBrand = req.session.brand;
      }
      var r = pick({ prod: prod, host: host, sw: sw, env: process.env.BRAND, userBrand: userBrand, entry: entry });
      req.brand = r.brand;
      var cur = readCookie(req, COOKIE_BRAND);
      if (r.brand === DEFAULT_BRAND) { if (cur) clearCookie(res, req, COOKIE_BRAND); }
      else if (cur !== r.brand) setCookie(res, req, COOKIE_BRAND, r.brand, 30 * DAY);
    } catch (e) {
      console.error('[brand] ' + (e && e.message || e));
    }
    next();
  };
}

module.exports = { BRANDS: BRANDS, DEFAULT_BRAND: DEFAULT_BRAND, isKnown: isKnown, isProdHost: isProdHost, pick: pick, forSignup: forSignup, isPagePath: isPagePath, landingBrand: landingBrand, middleware: middleware, choicesFor: choicesFor, canChoose: canChoose,
  WORDS: WORDS, wordsOn: wordsOn, keep: keep, stripKeep: stripKeep, swapText: swapText, swapHtml: swapHtml, emailBrand: emailBrand, helpWordsLine: helpWordsLine };
