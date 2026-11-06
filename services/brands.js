'use strict';
// v3.4.69 -- TWO BRANDS: the brand list, and how each page's brand is chosen (TD-1105; Ian, 2026-11-06).
//
// One code base, one database, one domain for now. A brand is presentation only: its theme sheet today,
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
  brand2:     { key: 'brand2',     name: 'Brand 2',    live: false, hosts: [],                                       landing: ['/story'],        sheet: '/css/themes/brand2.css' }
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

module.exports = { BRANDS: BRANDS, DEFAULT_BRAND: DEFAULT_BRAND, isKnown: isKnown, isProdHost: isProdHost, pick: pick, forSignup: forSignup, isPagePath: isPagePath, landingBrand: landingBrand, middleware: middleware };
