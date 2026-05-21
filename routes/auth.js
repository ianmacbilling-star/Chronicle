const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');
const { getTier, isTrialExpired, TIERS } = require('../middleware/tiers');

router.post('/register', async function(req, res) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.json({ error: 'All fields required' });
    if (password.length < 8) return res.json({ error: 'Password must be at least 8 characters' });

    const db = await getDb();
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO users (name, email, password, created_at, trial_started_at) VALUES (?, ?, ?, ?, ?)'
    ).run(name.trim(), email.toLowerCase().trim(), hash, now, now);

    req.session.userId = result.lastInsertRowid;
    req.session.userName = name.trim();
    req.session.userEmail = email.toLowerCase().trim();

    res.json({ success: true, name: name.trim(), email: email.toLowerCase().trim() });
  } catch(e) {
    console.error('Register error:', e.message);
    res.json({ error: 'Registration failed. Please try again.' });
  }
});

router.post('/login', async function(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ error: 'Email and password required' });

    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) return res.json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ error: 'Invalid email or password' });

    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    res.json({ success: true, name: user.name, email: user.email });
  } catch(e) {
    console.error('Login error:', e.message);
    res.json({ error: 'Login failed. Please try again.' });
  }
});

router.get('/me', async function(req, res) {
  if (!req.session || !req.session.userId) return res.json({ authenticated: false });
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT id, name, email, tier, trial_started_at, subscription_status, current_period_end FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.json({ authenticated: false });

    const tier = getTier(user.tier || 'copper');
    const trialExpired = isTrialExpired(user);

    // Calculate trial days remaining
    let trialDaysLeft = null;
    if (user.tier === 'copper' && user.trial_started_at) {
      const started = new Date(user.trial_started_at);
      const expires = new Date(started.getTime() + 30 * 24 * 60 * 60 * 1000);
      trialDaysLeft = Math.max(0, Math.ceil((expires - new Date()) / (24 * 60 * 60 * 1000)));
    }

    res.json({
      authenticated: true,
      name: user.name,
      email: user.email,
      id: user.id,
      tier: user.tier || 'copper',
      tierName: tier.name,
      tierFeatures: tier,
      trialExpired: trialExpired,
      trialDaysLeft: trialDaysLeft,
      subscriptionStatus: user.subscription_status || 'trialing',
      allTiers: TIERS
    });
  } catch(e) {
    res.json({ authenticated: false });
  }
});

router.post('/logout', function(req, res) {
  req.session.destroy();
  res.json({ success: true });
});

router.put('/profile', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { name, email } = req.body;
  const db = await getDb();
  const now = new Date().toISOString();
  await db.prepare('UPDATE users SET name=?, email=?, edited_at=?, edited_by=? WHERE id=?')
    .run(name, email, now, req.session.userId, req.session.userId);
  req.session.userName = name;
  req.session.userEmail = email;
  res.json({ success: true });
});

router.put('/password', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  const db = await getDb();
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.json({ error: 'User not found' });
  const match = await bcrypt.compare(currentPassword, user.password);
  if (!match) return res.json({ error: 'Current password is incorrect' });
  const hash = await bcrypt.hash(newPassword, 10);
  await db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, req.session.userId);
  res.json({ success: true });
});

router.put('/apikey', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { api_key, fal_key } = req.body;
  const db = await getDb();
  const now = new Date().toISOString();
  if (api_key !== undefined) {
    await db.prepare('UPDATE users SET api_key=?, edited_at=?, edited_by=? WHERE id=?')
      .run(api_key || null, now, req.session.userId, req.session.userId);
  }
  if (fal_key !== undefined) {
    await db.prepare('UPDATE users SET fal_key=?, edited_at=?, edited_by=? WHERE id=?')
      .run(fal_key || null, now, req.session.userId, req.session.userId);
  }
  res.json({ success: true });
});

router.get('/apikey', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const db = await getDb();
  const user = await db.prepare('SELECT api_key, fal_key FROM users WHERE id=?').get(req.session.userId);
  res.json({ api_key: user ? (user.api_key || '') : '', fal_key: user ? (user.fal_key || '') : '' });
});

// PUT /api/auth/tier - admin only tier change
router.put('/tier', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { user_id, tier } = req.body;
  const validTiers = ['copper', 'silver', 'gold', 'platinum'];

  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
  const db = await getDb();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !adminEmails.includes(user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!validTiers.includes(tier)) return res.json({ error: 'Invalid tier' });

  const now = new Date().toISOString();
  await db.prepare('UPDATE users SET tier = ?, edited_at = ? WHERE id = ?')
    .run(tier, now, user_id || req.session.userId);

  res.json({ success: true });
});

// GET /api/auth/usage - current usage counts for the account page
router.get('/usage', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const uid = req.session.userId;

    const campaigns = await db.prepare(
      'SELECT COUNT(*) AS c FROM campaigns WHERE user_id = ? AND is_active = true'
    ).get(uid);

    const sessions = await db.prepare(
      'SELECT COUNT(*) AS c FROM sessions s JOIN campaigns c ON s.campaign_id = c.id WHERE c.user_id = ?'
    ).get(uid);

    const storyboards = await db.prepare(
      'SELECT COUNT(DISTINCT m.session_id) AS c FROM moments m ' +
      'JOIN sessions s ON m.session_id = s.id ' +
      'JOIN campaigns c ON s.campaign_id = c.id WHERE c.user_id = ?'
    ).get(uid);

    res.json({
      campaigns: campaigns ? campaigns.c : 0,
      sessions: sessions ? sessions.c : 0,
      storyboards: storyboards ? storyboards.c : 0
    });
  } catch(e) {
    res.json({ campaigns: 0, sessions: 0, storyboards: 0 });
  }
});

module.exports = router;
