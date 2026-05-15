const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');

// POST /api/auth/register
router.post('/register', async function(req, res) {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.json({ error: 'All fields are required' });
  }
  if (password.length < 8) {
    return res.json({ error: 'Password must be at least 8 characters' });
  }

  const db = getDb();

  // Check if email already exists
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return res.json({ error: 'An account with that email already exists' });
  }

  try {
    const password_hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();

    const result = db.prepare(
      'INSERT INTO users (email, password_hash, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(email.toLowerCase(), password_hash, name, now, 0);

    // Update created_by to own id
    db.prepare('UPDATE users SET created_by = ? WHERE id = ?').run(result.lastInsertRowid, result.lastInsertRowid);

    // Log them in
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

  if (!email || !password) {
    return res.json({ error: 'Email and password are required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

  if (!user) {
    return res.json({ error: 'Invalid email or password' });
  }

  try {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.json({ error: 'Invalid email or password' });
    }

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

// GET /api/auth/me - check if logged in
router.get('/me', function(req, res) {
  if (!req.session || !req.session.userId) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, name: req.session.userName, userId: req.session.userId });
});

module.exports = router;
