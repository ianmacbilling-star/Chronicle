const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');

// POST /api/auth/register
router.post('/register', async function(req, res) {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ error: 'All fields are required' });
  if (password.length < 8) return res.json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.json({ error: 'An account with that email already exists' });

  try {
    const password_hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(email.toLowerCase(), password_hash, name, now, 0);
    db.prepare('UPDATE users SET created_by = ? WHERE id = ?').run(result.lastInsertRowid, result.lastInsertRowid);
    req.session.userId = result.lastInsertRowid;
    req.session.userName = name;
    res.json({ success: true, name: name });
  } catch(e) {
    res.json({ error: 'Registration failed: ' + e.message });
  }
});

// POST /api/auth/login
router.post('/login', async function(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ error: 'Email and password are required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.json({ error: 'Invalid email or password' });

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.json({ error: 'Invalid email or password' });
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true, name: user.name });
  } catch(e) {
    res.json({ error: 'Login failed: ' + e.message });
  }
});

// POST /api/auth/logout
router.post('/logout', function(req, res) {
  req.session.destroy(function(err) {
    if (err) return res.json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

// GET /api/auth/me
router.get('/me', function(req, res) {
  if (!req.session || !req.session.userId) return res.json({ authenticated: false });
  const db = getDb();
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, name: user.name, email: user.email, userId: user.id });
});

// PUT /api/auth/profile - update name and email
router.put('/profile', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { name, email } = req.body;
  if (!name || !email) return res.json({ error: 'Name and email are required' });

  const db = getDb();
  const now = new Date().toISOString();

  // Check email not taken by another user
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase(), req.session.userId);
  if (existing) return res.json({ error: 'That email is already in use' });

  db.prepare('UPDATE users SET name = ?, email = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(name, email.toLowerCase(), now, req.session.userId, req.session.userId);

  req.session.userName = name;
  res.json({ success: true, name, email });
});

// PUT /api/auth/password - change password
router.put('/password', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.json({ error: 'Both fields are required' });
  if (new_password.length < 8) return res.json({ error: 'New password must be at least 8 characters' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.json({ error: 'Current password is incorrect' });

  const password_hash = await bcrypt.hash(new_password, 12);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(password_hash, now, req.session.userId, req.session.userId);

  res.json({ success: true });
});

// PUT /api/auth/apikey - save API key to account
router.put('/apikey', function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { api_key } = req.body;
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET api_key = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(api_key || null, now, req.session.userId, req.session.userId);
  res.json({ success: true });
});

// GET /api/auth/apikey - get stored API key
router.get('/apikey', function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getDb();
  const user = db.prepare('SELECT api_key FROM users WHERE id = ?').get(req.session.userId);
  res.json({ api_key: user ? (user.api_key || '') : '' });
});

module.exports = router;
