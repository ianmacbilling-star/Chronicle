const express = require('express');
const path = require('path');
const session = require('express-session');

const app = express();

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session management — memory store
app.use(session({
  secret: process.env.SESSION_SECRET || 'chronicle-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns/:campaignId/characters', require('./routes/characters'));
app.use('/api/campaigns/:campaignId/sessions', require('./routes/sessions'));
app.use('/api/campaigns/:campaignId/sessions/:sessionId/moments', require('./routes/moments'));
app.use('/api/extract', require('./routes/extract'));
app.use('/api/images', require('./routes/images'));
app.use('/api/narrative', require('./routes/narrative'));
app.use('/api/pdf', require('./routes/pdf'));

// Serve app for all non-API routes
app.get('*', function(req, res) {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('');
  console.log('  Chronicle v3 is running!');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
