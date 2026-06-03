const express = require('express');
const path = require('path');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./database/db');
const { initStorage } = require('./storage/storage');

const app = express();

// Railway terminates SSL at a proxy — trust it so secure cookies work
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many requests. Please slow down and try again in a few minutes.' }
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 30,                    // generate-all is ONE request; single regens are one each
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rlUserKey,
  validate: { keyGeneratorIpFallback: false },
  message: { error: "You're generating very quickly. Please wait a moment before generating again." }
});

app.use(express.static(path.join(__dirname, 'public')));

// Explicit page routes
app.get('/login', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Global backstop limiter across all API routes (after session so it can
// key by user). Must precede the route mounts below.
app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/email', require('./routes/email').router);
app.use('/api/tokens', require('./routes/tokens').router);
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns/:campaignId/characters', require('./routes/characters'));
app.use('/api/campaigns/:campaignId/assets', require('./routes/assets'));
app.use('/api/campaigns/:campaignId/archives', require('./routes/archives'));
app.use('/api/campaigns/:campaignId/sessions', require('./routes/sessions'));
app.use('/api/campaigns/:campaignId/sessions/:sessionId/moments', require('./routes/moments'));
app.use('/api/extract', aiLimiter, require('./routes/extract'));
app.use('/api/images', aiLimiter, require('./routes/images'));
app.use('/api/narrative', aiLimiter, require('./routes/narrative'));
app.use('/api/pdf', require('./routes/pdf'));
// Phase 3 — invite endpoints. Mounted at /api so the router can serve
// both /api/campaigns/:campaignId/invites and /api/invites/:token.
app.use('/api', require('./routes/invites'));

// Phase 3 — invite landing page. Standalone HTML served to logged-out
// and logged-in users alike; it fetches metadata client-side and adapts
// the UI based on auth state. Separate file (not the SPA) so unauth'd
// visitors don't load the full app.js.
app.get('/invite/:token', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

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

getDb().then(function() {
  app.listen(PORT, function() {
    console.log('');
    console.log('  Chronicle is running!');
    console.log('  Database: ' + (process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'));
    console.log('  Open: http://localhost:' + PORT);
    console.log('');
  });
}).catch(function(err) {
  console.error('Failed to connect to database:', err.message);
  process.exit(1);
});
