const express = require('express');
const path = require('path');
const fs = require('fs');   // v3.0.679 -- TD-146, for the version-stamped app.html
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./database/db');
const { initStorage } = require('./storage/storage');
const { sendAlertEmail } = require('./routes/email');
const { startScheduler } = require('./scheduler');
const { isTesterEmail } = require('./middleware/auth');   // v3.0.796 -- TD-600, the /version gate

const app = express();

// Railway terminates SSL at a proxy — trust it so secure cookies work
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb', verify: function(req, res, buf) { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ------------------------------------------------------------
// Health check — mounted BEFORE the session middleware so uptime
// pings don't create session rows. 200 when app + DB are reachable,
// 503 if the DB probe fails. Point an external uptime monitor
// (alerting to monitoring@) at /health to catch the one case the
// app-side alerts cannot: a fully-dead process.
// ------------------------------------------------------------
app.get('/health', async function(req, res) {
  try {
    const db = await getDb();
    await db.exec('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', db: 'down', ts: new Date().toISOString() });
  }
});

// Session store — PostgreSQL in production, memory locally
function buildSessionMiddleware() {
  if (process.env.DATABASE_URL) {
    const pgSession = require('connect-pg-simple')(session);
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    return session({
      store: new pgSession({
        pool: pool,
        tableName: 'user_sessions',
        createTableIfMissing: true
      }),
      secret: process.env.SESSION_SECRET || 'chronicle-dev-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: true,
        sameSite: 'lax',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      }
    });
  } else {
    // Local development — memory store is fine
    return session({
      secret: process.env.SESSION_SECRET || 'chronicle-dev-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000
      }
    });
  }
}

app.use(buildSessionMiddleware());

// ------------------------------------------------------------
// Build stamp: lets an ADMIN or a TESTER confirm exactly which deploy is live. The version comes
// from version-info.json (bumped every push); the commit sha is Railway-injected at runtime.
//
// v3.0.796 -- TD-600. RE-GATED, AND MOVED TO WHERE THE GATE CAN WORK.
//
// Ian: "Get rid of the version number at the top banner for all non-admin users and testers."
//
// The gate this restores was written in v3.0.679, commented out, with `var show = true;` above it
// and a note saying re-gate once stable. It could never have worked if it HAD been uncommented,
// for two independent reasons -- and the first is why this block MOVED rather than just changing:
//
//   1. IT SAT ABOVE THE SESSION MIDDLEWARE. The route was mounted at the top of the file beside
//      /health, which is deliberately before `app.use(buildSessionMiddleware())` so uptime pings
//      create no session rows. `req.session` was therefore UNDEFINED here, the guard
//      `if (req.session && req.session.userId)` could never fire, and `show` would have stayed
//      true for everyone -- a gate that reads as working while showing the stamp to the world.
//   2. `is_admin` IS NOT A COLUMN. Admin is the ADMIN_EMAILS env var compared against the user's
//      email (routes/auth.js, and every admin route re-reads it). The commented query selected a
//      column that does not exist, so it would have thrown, the catch would have set show = false,
//      and the stamp would have disappeared for admins as well. Both faults, one line apart.
//
// Moving it below the session middleware costs nothing: `saveUninitialized: false`, so an
// anonymous GET /version still creates no session row -- the /health reasoning does not apply.
//
// WHO SEES IT: admin OR tester. Both come from env vars read fresh on every call, so adding or
// removing someone takes effect on their next request with no row to clean up (TD-475). The list
// and the case-sensitive comparison are the ones in routes/auth.js on purpose -- a different rule
// here would be its own bug the first time an address differed in case. The one difference is that
// the stored address is trimmed before comparing, which routes/auth.js does not do.
//
// `debug_mode` is DELIBERATELY NOT IN THE GATE. Any reader can turn Debug Mode on by tapping the
// version label seven times, so including it would let the stamp unhide itself.
//
// WHAT IS NOT GATED: version, commit and env still go to everybody. `/version` is the deploy
// indicator (`curl https://campaignia.com/version`), and the diagnostics bundle reads `env` and
// `version` off it to name the file (public/js/app.js, v3.0.369). Only `show` is a permission --
// gating the whole response would silently rename every bundle downloaded from now on.
// ------------------------------------------------------------
app.get('/version', async function(req, res) {
  var info = {};
  try { info = require('./version-info.json'); } catch (e) { info = {}; }
  var pkg = {};
  try { pkg = require('./package.json'); } catch (e) { pkg = {}; }
  var version = info.version || pkg.version || '3.0.0';
  var sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT || '';
  // DEFAULT DENY. Failing to answer "may this person see it" is not a yes -- the v3.0.679 version
  // defaulted to true and stayed true for two hundred builds.
  var show = false;
  try {
    if (req.session && req.session.userId) {
      const db = await getDb();
      const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
      const _email = u && u.email ? String(u.email).trim() : '';
      if (_email) {
        const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
        show = adminEmails.includes(_email) || isTesterEmail(_email);
      }
    }
  } catch (e) { show = false; }
  res.set('Cache-Control', 'no-store');
  res.json({
    version: version,
    commit: sha ? String(sha).slice(0, 7) : 'dev',
    env: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local',
    show: show,
    ts: new Date().toISOString()
  });
});

// ------------------------------------------------------------
// Rate limiting (scaling hardening). Two layers:
//   apiLimiter -- a generous backstop on ALL /api traffic, sized so normal
//     SPA navigation never trips it; catches raw floods / runaway loops.
//   aiLimiter  -- a strict per-user cap on the endpoints that call PAID AI
//     APIs (image gen, extraction, narrative). Tokens already bound a paying
//     user's spend; this is defense-in-depth against retry storms, buggy
//     clients, and abuse hammering the costly endpoints.
// Keyed by user id when logged in, else IP. NOTE: the default store is
// in-memory, so limits are PER APP INSTANCE -- fine on one Railway instance
// today, but move to a shared store (Redis/pg) before scaling horizontally
// or the effective limit multiplies by the instance count.
// ------------------------------------------------------------
function rlUserKey(req) {
  return (req.session && req.session.userId) ? ('u' + req.session.userId) : req.ip;
}
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 1500,                  // generous; an active SPA session stays well under this
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlUserKey,
  // endpoints are auth-gated so the IP fallback is rarely hit; skip the
  // library's IPv6-subnet validation rather than pull in its ip key helper.
  validate: false,  // disable express-rate-limit config-validation warnings (version-proof; limiter still fully active)
  message: { error: 'Too many requests. Please slow down and try again in a few minutes.' }
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 30,                    // generate-all is ONE request; single regens are one each
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlUserKey,
  validate: false,  // disable express-rate-limit config-validation warnings (version-proof; limiter still fully active)
  message: { error: "You're generating very quickly. Please wait a moment before generating again." }
});

// ------------------------------------------------------------
// SEO / crawler control. Only the production public domain may be
// indexed. Every other host (staging chroniclemygame.com, *.railway.app,
// preview URLs) is kept out of search engines entirely via a noindex
// header + a disallow-all robots.txt. Production hosts mirror the
// landing-page staging-env allowlist.
// ------------------------------------------------------------
var PROD_HOSTS = ['campaignia.com', 'www.campaignia.com'];
function isProdHost(req) { return PROD_HOSTS.indexOf(String(req.hostname || '').toLowerCase()) !== -1; }

app.use(function(req, res, next) {
  if (!isProdHost(req)) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.get('/robots.txt', function(req, res) {
  res.type('text/plain');
  var body = isProdHost(req)
    ? 'User-agent: *\r\nDisallow: /api/\r\nSitemap: ' + (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') + '/sitemap.xml\r\n'
    : 'User-agent: *\r\nDisallow: /\r\n';
  res.send(body);
});

// v3.0.679 -- TD-146. THE APP BUNDLE MUST NOT BE SERVED STALE.
//
// public/js/app.js was served by express.static under a filename that never changes, so Cloudflare
// could hand out an old bundle indefinitely. The corner version stamp comes from version-info.json,
// a DIFFERENT file -- so a reader could see a new version number while running old code, and a fix
// that shipped correctly would look like it had not worked at all.
//
// TWO LAYERS, because either alone leaves a gap:
//   1. app.html asks for /js/app.js?v=<version>, stamped at serve time from version-info.json. Each
//      push is a URL the edge has never seen, so there is nothing stale to serve.
//   2. no-cache on the path itself, which protects every copy already sitting in a cache from
//      BEFORE this build -- the readers layer 1 cannot reach, because their app.html is the old one.
//
// no-cache does not mean "do not cache"; it means revalidate before use. The ETag express.static
// already sends still makes an unchanged bundle a 304, so this costs a round trip, not a download.
//
// Declared before express.static so these headers win, exactly as the service worker below does.
app.get('/js/app.js', function (req, res) {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'js', 'app.js'));
});

// app.html is rewritten on the way out to stamp the bundle URL. Read from disk each time rather
// than cached in memory: this file is edited by every apply script, and a cached copy would serve
// the previous deploy's markup until a restart -- the same fault this whole block exists to fix.
app.get(['/app.html', '/app'], function (req, res) {
  var _v = '';
  try { _v = String(require('./version-info.json').version || ''); } catch (e) { _v = ''; }
  fs.readFile(path.join(__dirname, 'public', 'app.html'), 'utf8', function (err, html) {
    if (err) return res.status(404).send('Not found');
    if (_v) html = html.replace('src="/js/app.js"', 'src="/js/app.js?v=' + encodeURIComponent(_v) + '"');
    res.set('Cache-Control', 'no-cache');
    res.type('html');
    res.send(html);
  });
});

// Service worker: served from root scope with no-cache so updates always
// propagate. Declared before express.static so these headers win.
app.get('/sw.js', function(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// SELF-HOSTED FONTS, served from the packages that already ship them. The faces are an npm
// dependency (@fontsource/*), so committing 27 copies of the same woff2 files into public/ would be
// pure duplication -- and pushing them through the apply script made it 2.2MB, which Git Bash cannot
// chew through. This maps /fonts/<pkg>-latin-<weight>-<style>.woff2 onto node_modules/@fontsource.
// The filename pattern is validated before it touches the filesystem: only lowercase letters,
// digits and hyphens, and the package must be one we actually depend on -- so this cannot be walked
// out of the fonts directory.
var FONT_PKGS = ['cinzel', 'crimson-text', 'bangers', 'eb-garamond', 'lora', 'merriweather',
                 'dancing-script', 'caveat', 'comic-neue'];
// The browser stylesheet, generated from the same table the renderer inlines from -- one list of
// families and weights, two consumers, so they cannot drift apart.
app.get('/css/fonts.css', function (req, res) {
  res.set('Content-Type', 'text/css');
  res.set('Cache-Control', 'public, max-age=86400');
  try { res.send(require('./services/printing/fonts').browserFontCss()); }
  catch (e) { res.status(500).send('/* font sheet unavailable */'); }
});
app.get('/fonts/:file', function (req, res) {
  var f = String(req.params.file || '');
  if (!/^[a-z0-9-]+\.woff2$/.test(f)) return res.status(404).end();
  var pkg = FONT_PKGS.filter(function (p) { return f.indexOf(p + '-latin-') === 0; })
                     .sort(function (a, b) { return b.length - a.length; })[0];   // longest match wins
  if (!pkg) return res.status(404).end();
  var p = path.join(__dirname, 'node_modules', '@fontsource', pkg, 'files', f);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');   // content-addressed by weight/style
  res.set('Content-Type', 'font/woff2');
  res.sendFile(p, function (err) { if (err && !res.headersSent) res.status(404).end(); });
});
app.use(express.static(path.join(__dirname, 'public')));

// Explicit page routes
app.get('/login', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/library', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});
// v3.0.741 -- TD-537. Extensionless, matching /library and /login. express.static would serve
// /our-story.html on its own, but the nav links to /our-story and a 404 on the founder letter
// is not a thing to discover after launch.
app.get('/our-story', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'our-story.html'));
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Stripe webhook -- mounted BEFORE the rate limiter and the session-gated
// token router. Stripe authenticates via signature (req.rawBody, captured by
// express.json's verify hook above), not a user session, and must not be
// throttled or events could be dropped.
app.post('/api/tokens/stripe-webhook', require('./routes/tokens').stripeWebhook);

// Global backstop limiter across all API routes (after session so it can
// key by user). Must precede the route mounts below.
app.use('/api', apiLimiter);

// Attach the caller's tier/user to every authenticated API request and lapse
// an expired trial promptly (GL-10). attachTier is defined in middleware/tiers
// but was previously never mounted, so trial-lapse enforcement only fired on
// /me + the create-gates. It short-circuits to next() when there's no session,
// so unauthenticated API calls are unaffected. Mounted AFTER the rate limiter
// (floods are rejected before the DB read) and AFTER the Stripe webhook above
// (which has no session and must never be gated).
app.use('/api', require('./middleware/tiers').attachTier);
app.use('/api', require('./routes/debug').captureMiddleware);
// v3.0.589 -- TD-179 STAGE 3. THE IMPERSONATION DENY LIST.
// Mounted HIGH and ONCE, above every protected route group, so a route added later is covered
// without anyone remembering to wire it in. It is a no-op on every ordinary request -- it returns
// immediately unless req.session.impersonatorId is set.
// This is one half of what makes the privacy-policy clause true; the audit table is the other.
// Neither may ship without the other. See middleware/impersonationGuard.js.
app.use('/api', require('./middleware/impersonationGuard'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/email', require('./routes/email').router);
app.use('/api/tokens', require('./routes/tokens').router);
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns/:campaignId/characters', require('./routes/characters'));
app.use('/api/campaigns/:campaignId/assets', require('./routes/assets'));
app.use('/api/help', require('./routes/help'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/art-styles', require('./routes/artStyles'));
app.use('/api/campaigns/:campaignId/archives', require('./routes/archives'));
app.use('/api/campaigns/:campaignId/sessions', require('./routes/sessions'));
app.use('/api/campaigns/:campaignId/sessions/:sessionId/moments', require('./routes/moments'));
app.use('/api/extract', aiLimiter, require('./routes/extract'));
const imagesRoutes = require('./routes/images');
// Webhook + job polling bypass the AI rate limiter (fal calls the webhook, and
// the browser polls job status — neither should be throttled like a generate).
app.use('/api/images', imagesRoutes.webhookRouter);
app.use('/api/images', aiLimiter, imagesRoutes);
app.use('/api/narrative', aiLimiter, require('./routes/narrative'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/frameprobe', require('./routes/frameprobe'));   // TD-351 dev probe -- admin-gated, remove with TF-02 / GL-11
app.use('/api/layout-ai', require('./routes/layoutAI'));  // AI layout-optimization dry run (admin + flag gated; rollback = remove this line)
app.use('/api/print', require('./routes/print'));
// Phase 3 — invite endpoints. Mounted at /api so the router can serve
// both /api/campaigns/:campaignId/invites and /api/invites/:token.
app.use('/api', require('./routes/invites'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/debug', require('./routes/debug'));

// Public, unauthenticated: landing-page pricing (reads live tier config).
app.use('/api/public', require('./routes/public'));

// Phase 3 — invite landing page. Standalone HTML served to logged-out
// and logged-in users alike; it fetches metadata client-side and adapts
// the UI based on auth state. Separate file (not the SPA) so unauth'd
// visitors don't load the full app.js.
app.get('/invite/:token', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

// Public, server-rendered per-story pages (SEO). Mounted before the SPA
// catch-all so /library/story/:id/:slug renders real HTML, not the app shell.
app.use('/', require('./routes/story-pages'));

app.get('*', function(req, res) {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Initialize database first, then start server
initStorage();
// 404 handler
app.use(function(req, res) {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ------------------------------------------------------------
// Monitoring: DB heartbeat + crash handlers (alerts to monitoring@).
// sendAlertEmail is production-gated (ALERTS_ENABLED) and never throws.
// ------------------------------------------------------------
let dbHealthy = true;            // startup success implies the DB was reachable
let heartbeatInFlight = false;
function startDbHeartbeat() {
  setInterval(async function() {
    if (heartbeatInFlight) return;          // don't stack probes if one is slow
    heartbeatInFlight = true;
    try {
      const db = await getDb();
      await db.exec('SELECT 1');
      if (!dbHealthy) {
        dbHealthy = true;
        console.log('[monitor] database recovered');
        sendAlertEmail('DB RECOVERED', 'The production database is responding again.');
      }
    } catch (e) {
      if (dbHealthy) {
        dbHealthy = false;
        const m = (e && e.message) ? e.message : String(e);
        console.error('[monitor] database DOWN:', m);
        sendAlertEmail('DB DOWN', 'The production database is not responding. Error: ' + m);
      }
    } finally {
      heartbeatInFlight = false;
    }
  }, 60 * 1000);                              // probe once a minute
}

// Fatal-error handler: alert once, then exit so Railway restarts cleanly.
let shuttingDown = false;
function handleFatal(kind, err) {
  if (shuttingDown) return;
  shuttingDown = true;
  const m = (err && err.stack) ? err.stack : String(err);
  console.error('[monitor] ' + kind + ':', m);
  Promise.race([
    sendAlertEmail('APP CRASH (' + kind + ')', 'The app is shutting down after an unhandled error. ' + m),
    new Promise(function(resolve) { setTimeout(resolve, 4000); })   // never hang on exit
  ]).then(function() { process.exit(1); });
}
process.on('uncaughtException', function(err) { handleFatal('uncaughtException', err); });
process.on('unhandledRejection', function(reason) { handleFatal('unhandledRejection', reason); });

getDb().then(async function() {
  try { await require('./middleware/tiers').loadTierConfig(); } catch (e) { console.error('tier_config load failed (using code defaults):', e.message); }
  var server = app.listen(PORT, function() {
    console.log('');
    console.log('  Campaignia is running!');
  // A missing face silently falls back to a system typeface that MEASURES DIFFERENTLY from what the
  // PDF renders, which is how pages end up clipped. Say so at boot, not weeks later.
  try {
    var _fp = require('./services/printing/fonts').fontsPresent();
    if (!_fp.ok) console.error('[fonts] MISSING ' + _fp.missing.length + ' face file(s), e.g. ' + _fp.missing.slice(0, 3).join(', ') + ' -- run npm install. Text metrics will be wrong until fixed.');
    else console.log('  Fonts: self-hosted (' + _fp.total + ' faces)');
  } catch (e) { console.error('[fonts] self-hosted font check failed: ' + ((e && e.message) || e)); }

    console.log('  Database: ' + (process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'));
    console.log('  Open: http://localhost:' + PORT);
    console.log('');
    startDbHeartbeat();
    startScheduler();
  });

  // v3.0.779 -- A PDF RENDER IS A PLAIN SYNCHRONOUS GET that holds the socket
  // open while Chromium paints a whole book. Node 18+ defaults requestTimeout
  // to 5 minutes and headersTimeout to 60 seconds, and NOTHING was raising
  // them -- so a large book would die on the server clock however patient
  // Puppeteer was. Sixteen minutes, one longer than the render budget, so a
  // render that overruns reports ITS OWN reason rather than a dropped socket.
  // The real answer is an async render job; this makes the target size work.
  server.requestTimeout = 960000;
  server.headersTimeout = 965000;
  server.keepAliveTimeout = 75000;
  server.setTimeout(0);

  server.on('clientError', function(err, socket) {
    try { console.warn('clientError ' + (err && err.code) + ' from ' + (socket && socket.remoteAddress)); } catch (e) {}
    if (socket && socket.writable) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); }
  });
}).catch(async function(err) {
  console.error('Failed to connect to database:', err.message);
  try {
    await sendAlertEmail('FAILED STARTUP', 'The app failed to start — database init/connection error. Error: ' + ((err && err.message) ? err.message : String(err)));
  } catch (e) {}
  process.exit(1);
});
