const express = require('express');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./database/db');
const { initStorage } = require('./storage/storage');
const { sendAlertEmail } = require('./routes/email');

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

// Service worker: served from root scope with no-cache so updates always
// propagate. Declared before express.static so these headers win.
app.get('/sw.js', function(req, res) {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Explicit page routes
app.get('/login', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/library', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/email', require('./routes/email').router);
app.use('/api/tokens', require('./routes/tokens').router);
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns/:campaignId/characters', require('./routes/characters'));
app.use('/api/campaigns/:campaignId/assets', require('./routes/assets'));
app.use('/api/help', require('./routes/help'));
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
app.use('/api/print', require('./routes/print'));
// Phase 3 — invite endpoints. Mounted at /api so the router can serve
// both /api/campaigns/:campaignId/invites and /api/invites/:token.
app.use('/api', require('./routes/invites'));
app.use('/api/admin', require('./routes/admin'));

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
  app.listen(PORT, function() {
    console.log('');
    console.log('  Campaignia is running!');
    console.log('  Database: ' + (process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'));
    console.log('  Open: http://localhost:' + PORT);
    console.log('');
    startDbHeartbeat();
  });
}).catch(async function(err) {
  console.error('Failed to connect to database:', err.message);
  try {
    await sendAlertEmail('FAILED STARTUP', 'The app failed to start — database init/connection error. Error: ' + ((err && err.message) ? err.message : String(err)));
  } catch (e) {}
  process.exit(1);
});
