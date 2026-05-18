const express = require('express');
const path = require('path');
const session = require('express-session');
const { getDb } = require('./database/db');

const app = express();

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
        secure: false,
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns/:campaignId/characters', require('./routes/characters'));
app.use('/api/campaigns/:campaignId/sessions', require('./routes/sessions'));
app.use('/api/campaigns/:campaignId/sessions/:sessionId/moments', require('./routes/moments'));
app.use('/api/extract', require('./routes/extract'));
app.use('/api/images', require('./routes/images'));
app.use('/api/narrative', require('./routes/narrative'));
app.use('/api/pdf', require('./routes/pdf'));

app.get('*', function(req, res) {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Initialize database first, then start server
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
