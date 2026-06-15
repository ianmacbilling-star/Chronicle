const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');
const { getTier, isTrialExpired, lapseTrialIfExpired, TIERS } = require('../middleware/tiers');
const { ensureMonthlyGrant } = require('./tokens');
const { sendJoinNotificationEmail, sendPlayerJoinedWelcomeEmail } = require('./email');

// Current Terms of Service / EULA version. Bump when the terms change so we
// can require re-acceptance later. Stored per user at sign-up.
const TOS_VERSION = '1.0';

// Whole years between a YYYY-MM-DD date string and today. Returns null if
// the input is not a valid date.
function ageFromDob(dob) {
  if (!dob) return null;
  var d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  var now = new Date();
  var age = now.getFullYear() - d.getFullYear();
  var m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// Welcome grant for new accounts. We grant the NEW user's tier allotment
// (monthly_utlt + monthly_cot from the tier config -- the Free Trial tier for
// fresh signups) via ensureMonthlyGrant, so the admin Dashboard tier settings
// are the single source of truth and a new account starts identical to a
// 'reset to fresh'. (Previously a hardcoded flat 100 cot, which ignored the
// trial tier config and bypassed the use-it-or-lose-it bucket + session reserve.)

// Pen name: trims, treats blank as null, enforces case-insensitive uniqueness
// across users (DB has a matching unique index). Returns { ok:true, value }
// (value is undefined when the field was not sent, null when cleared) or
// { ok:false, error }.
async function resolvePenName(db, raw, excludeUserId) {
  if (raw === undefined) return { ok: true, value: undefined };
  var pen = (raw == null ? "" : String(raw)).trim();
  if (!pen) return { ok: true, value: null };
  if (pen.length > 40) return { ok: false, error: "Pen name must be 40 characters or fewer" };
  var clash = await db.prepare("SELECT id FROM users WHERE lower(pen_name) = lower(?) AND id <> ?").get(pen, excludeUserId || 0);
  if (clash) return { ok: false, error: "That pen name is already taken" };
  return { ok: true, value: pen };
}

router.post('/register', async function(req, res) {
  try {
    const { name, email, password, invite_token, pen_name, dob, accept_terms, accept_upload } = req.body;
    if (!name || !email || !password) return res.json({ error: 'All fields required' });
    if (password.length < 8) return res.json({ error: 'Password must be at least 8 characters' });

    // Age + consent gate. DOB is required (age verification); under-13 is
    // blocked (COPPA). Both attestations must be checked to create an account.
    const userAge = ageFromDob(dob);
    if (userAge === null) return res.json({ error: 'Please enter a valid date of birth.' });
    if (userAge < 13) return res.json({ error: 'You must be at least 13 years old to create an account.' });
    if (!accept_terms) return res.json({ error: 'You must read and accept the Terms of Service to create an account.' });
    if (!accept_upload) return res.json({ error: 'You must accept the content/copyright agreement to create an account.' });

    const db = await getDb();
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.json({ error: 'An account with this email already exists' });

    const penRes = await resolvePenName(db, pen_name, 0);
    if (!penRes.ok) return res.json({ error: penRes.error });

    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    // New accounts start on the FREE TRIAL tier (rank 0): generous, watermarked,
    // capped (1 campaign / 1 session / a few characters) with a session-token
    // reserve, and a 30-day window. They lapse to Copper at expiry (lazy, on next
    // activity -- see lapseTrialIfExpired). trial_started_at stamps the window.
    const result = await db.prepare(
      'INSERT INTO users (name, email, password, tier, created_at, trial_started_at, pen_name, date_of_birth, tos_accepted_version, tos_accepted_at, upload_terms_accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name.trim(), email.toLowerCase().trim(), hash, 'trial', now, now, penRes.value || null, dob, TOS_VERSION, now, true);

    const newUserId = result.lastInsertRowid;

    // Welcome grant — credit the new account so they can immediately use
    // the product. Wrapped in its own try/catch so a grant failure never
    // breaks registration itself (worst case: user is created with 0
    // tokens, admin can credit later via the testing widget).
    try {
      await ensureMonthlyGrant(newUserId);
    } catch (grantErr) {
      console.error('Signup grant failed (non-fatal):', grantErr.message);
    }

    req.session.userId = newUserId;
    req.session.userName = name.trim();
    req.session.userEmail = email.toLowerCase().trim();

    // Phase 3: if registration came in via an invite link, auto-accept
    // the invite now. Same all-or-nothing semantics as the signup grant:
    // if the auto-accept fails, registration still succeeds — the user
    // can revisit the invite link manually and click Accept.
    let autoJoinedCampaignId = null;
    if (invite_token && typeof invite_token === 'string') {
      try {
        const invite = await db.prepare(
          'SELECT * FROM campaign_invites WHERE token = ?'
        ).get(invite_token);
        if (invite && !invite.used_at && new Date(invite.expires_at) >= new Date()) {
          await db.prepare(
            'INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?, ?, ?) ' +
            'ON CONFLICT (campaign_id, user_id) DO NOTHING'
          ).run(invite.campaign_id, newUserId, invite.role);
          if (invite.character_id) {
            await db.prepare(
              'UPDATE characters SET owner_user_id = ?, is_claimed = true WHERE id = ?'
            ).run(newUserId, invite.character_id);
          }
          await db.prepare(
            'UPDATE campaign_invites SET used_at = ?, used_by = ? WHERE id = ?'
          ).run(new Date().toISOString(), newUserId, invite.id);
          autoJoinedCampaignId = invite.campaign_id;

          // Phase 3 Deploy 3 — fire join-lifecycle emails (DM notification
          // + player welcome). Same pattern as routes/invites.js accept,
          // but here the player has JUST been created so we have their
          // info inline. Non-fatal — failures just log.
          try {
            const ctx = await db.prepare(
              'SELECT c.name AS campaign_name, dm.email AS dm_email, dm.name AS dm_name ' +
              'FROM campaigns c JOIN users dm ON dm.id = ? WHERE c.id = ?'
            ).get(invite.created_by, invite.campaign_id);
            let charInfo = null;
            if (invite.character_id) {
              charInfo = await db.prepare(
                'SELECT name, cls FROM characters WHERE id = ?'
              ).get(invite.character_id);
            }
            if (ctx) {
              const base = process.env.APP_URL || ('https://' + req.get('host'));
              const campaignUrl = base.replace(/\/$/, '') + '/app.html#campaign=' + invite.campaign_id;
              await sendJoinNotificationEmail({
                dm_email: ctx.dm_email,
                dm_name: ctx.dm_name || 'Story Master',
                player_name: name.trim(),
                player_email: email.toLowerCase().trim(),
                campaign_name: ctx.campaign_name,
                character_name: charInfo ? charInfo.name : null,
                character_class: charInfo ? charInfo.cls : null,
                campaign_url: campaignUrl
              });
              await sendPlayerJoinedWelcomeEmail({
                player_email: email.toLowerCase().trim(),
                player_name: name.trim(),
                dm_name: ctx.dm_name || 'your DM',
                campaign_name: ctx.campaign_name,
                character_name: charInfo ? charInfo.name : null,
                character_class: charInfo ? charInfo.cls : null,
                campaign_url: campaignUrl
              });
            }
          } catch (emailErr) {
            console.error('Register-invite emails error:', emailErr.message);
          }
        }
      } catch (inviteErr) {
        console.error('Auto-accept invite on register failed (non-fatal):', inviteErr.message);
      }
    }

    res.json({
      success: true,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      auto_joined_campaign_id: autoJoinedCampaignId
    });
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

    // Account lifecycle: logging in reactivates a suspended account
    // (within the retention window) -- clears the suspend flag + clock.
    let reactivated = false;
    if (user.status === 'suspended') {
      await db.prepare("UPDATE users SET status = 'active', suspended_at = NULL WHERE id = ?").run(user.id);
      reactivated = true;
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;

    res.json({ success: true, name: user.name, email: user.email, reactivated: reactivated });
  } catch(e) {
    console.error('Login error:', e.message);
    res.json({ error: 'Login failed. Please try again.' });
  }
});

router.get('/me', async function(req, res) {
  if (!req.session || !req.session.userId) return res.json({ authenticated: false });
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT id, name, email, tier, trial_started_at, subscription_status, current_period_end, stripe_customer_id, stripe_subscription_id, render_thinking, pen_name FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.json({ authenticated: false });

    await lapseTrialIfExpired(user, db);
    const tier = getTier(user.tier || 'copper');
    const trialExpired = isTrialExpired(user);
    // Free trial = within the 30-day window from trial_started_at and not yet
    // converted to a paid plan. Drives the on-screen trial watermark.
    const _trialMs = 30 * 24 * 60 * 60 * 1000;
    const inFreeTrial = !!user.trial_started_at &&
      (Date.now() - new Date(user.trial_started_at).getTime()) < _trialMs &&
      (user.subscription_status || 'trialing') === 'trialing';

    // Calculate trial days remaining
    let trialDaysLeft = null;
    if (user.tier === 'trial' && user.trial_started_at) {
      const started = new Date(user.trial_started_at);
      const expires = new Date(started.getTime() + 30 * 24 * 60 * 60 * 1000);
      trialDaysLeft = Math.max(0, Math.ceil((expires - new Date()) / (24 * 60 * 60 * 1000)));
    }

    // Is this user an admin? Source of truth = ADMIN_EMAILS env var.
    // Surfaced to the frontend so admin-only UI (e.g. testing widgets)
    // can show/hide cleanly. Backend endpoints still enforce admin
    // gating server-side; this is just for UI.
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    const isAdmin = adminEmails.includes(user.email);

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
      hasBilling: !!user.stripe_customer_id,
      hasSubscription: !!user.stripe_subscription_id,
      renderThinking: !!user.render_thinking,
      penName: user.pen_name || '',
      inFreeTrial: inFreeTrial,
      trialStartedAt: user.trial_started_at || null,
      is_admin: isAdmin,
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

// POST /api/auth/suspend -- self-service account suspension. Holds the
// account + all data; the user reactivates by simply logging back in.
// Stamps suspended_at to start the retention clock the future sweep job
// will act on. Destroys the current session. (Permanent delete is a
// separate, later flow.)
router.post('/suspend', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.prepare("UPDATE users SET status = 'suspended', suspended_at = ? WHERE id = ?").run(now, req.session.userId);
    req.session.destroy();
    res.json({ success: true });
  } catch (e) {
    console.error('Suspend error:', e.message);
    res.status(500).json({ error: 'Could not suspend account. Please try again.' });
  }
});

// POST /api/auth/set-tier -- TESTING ONLY: lets the signed-in user switch
// their OWN tier so we can exercise tier-gated features (style locking,
// archive caps, effective tier). NOT a real upgrade path -- remove before
// production (paid tiers will be Stripe-gated). Grep 'set-tier' to find it.
router.post('/set-tier', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const tier = (req.body && typeof req.body.tier === 'string') ? req.body.tier.trim().toLowerCase() : '';
  if (!TIERS[tier]) return res.status(400).json({ error: 'Unknown tier' });
  try {
    const db = await getDb();
    // Flipping TO the trial tier starts a fresh 30-day window so it won't lapse
    // straight back to copper on the next request (use the Free Trial date control
    // to backdate the start when testing expiry/lapse).
    if (tier === 'trial') {
      await db.prepare('UPDATE users SET tier = ?, trial_started_at = ? WHERE id = ?').run(tier, new Date().toISOString(), req.session.userId);
    } else {
      await db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, req.session.userId);
    }
    res.json({ success: true, tier: tier });
  } catch (e) {
    console.error('set-tier error:', e.message);
    res.status(500).json({ error: 'Could not change tier. Please try again.' });
  }
});

router.put('/profile', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { name, email, pen_name } = req.body;
  const db = await getDb();
  const now = new Date().toISOString();
  const penRes = await resolvePenName(db, pen_name, req.session.userId);
  if (!penRes.ok) return res.json({ error: penRes.error });
  if (penRes.value !== undefined) {
    await db.prepare('UPDATE users SET name=?, email=?, pen_name=?, edited_at=?, edited_by=? WHERE id=?')
      .run(name, email, penRes.value, now, req.session.userId, req.session.userId);
  } else {
    await db.prepare('UPDATE users SET name=?, email=?, edited_at=?, edited_by=? WHERE id=?')
      .run(name, email, now, req.session.userId, req.session.userId);
  }
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

// Per-user image rendering preferences (e.g. AI "thinking").
router.put('/render-settings', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const thinking = (req.body && req.body.thinking) ? 1 : 0;
    await db.prepare('UPDATE users SET render_thinking=?, edited_at=?, edited_by=? WHERE id=?')
      .run(thinking, now, req.session.userId, req.session.userId);
    res.json({ success: true, render_thinking: thinking });
  } catch (e) {
    console.error('render-settings error:', e.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

// TESTING ONLY: put the signed-in account in/out of the free trial so we can
// exercise the trial watermark. Sets subscription_status + trial_started_at.
// Self only. REMOVE with the other testing controls before production.
router.put('/trial-testing', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const inTrial = !!(req.body && req.body.inTrial);
    let startedAt = null;
    if (inTrial) {
      const raw = req.body && req.body.started_at;
      if (raw) { const d = new Date(raw); if (!isNaN(d.getTime())) startedAt = d.toISOString(); }
      if (!startedAt) startedAt = now;
      // Put the account ON the real trial TIER (badge + caps engage, exactly like a
      // fresh signup) and start the window. Persisted in the DB -> survives logins.
      await db.prepare("UPDATE users SET tier = 'trial', subscription_status = 'trialing', trial_started_at = ?, edited_at = ?, edited_by = ? WHERE id = ?")
        .run(startedAt, now, req.session.userId, req.session.userId);
    } else {
      // Out of trial: drop a trial account to copper (the real post-trial tier); leave
      // any non-trial tier untouched so this never clobbers a tier set via the override.
      await db.prepare("UPDATE users SET tier = CASE WHEN tier = 'trial' THEN 'copper' ELSE tier END, subscription_status = 'active', edited_at = ?, edited_by = ? WHERE id = ?")
        .run(now, req.session.userId, req.session.userId);
    }
    const trow = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    res.json({ success: true, inTrial: inTrial, trial_started_at: startedAt, tier: trow ? trow.tier : null });
  } catch (e) {
    console.error('trial-testing error:', e.message);
    res.status(500).json({ error: 'Could not update trial state' });
  }
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
      'SELECT COUNT(*) AS c FROM campaigns WHERE id IN (SELECT campaign_id FROM campaign_members WHERE user_id = ? AND role = \'dm\') AND is_active = true'
    ).get(uid);

    const sessions = await db.prepare(
      'SELECT COUNT(*) AS c FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE cm.user_id = ? AND cm.role = \'dm\''
    ).get(uid);

    const storyboards = await db.prepare(
      'SELECT COUNT(DISTINCT m.session_id) AS c FROM moments m ' +
      'JOIN sessions s ON m.session_id = s.id ' +
      'JOIN campaigns c ON s.campaign_id = c.id ' +
      "JOIN campaign_members cm ON cm.campaign_id = c.id WHERE cm.user_id = ? AND cm.role = 'dm'"
    ).get(uid);

    // Image generation counts. month_key is 'YYYY-MM'.
    // When Stripe lands, swap the monthly count to the billing-cycle range.
    var d = new Date();
    var monthKey = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);

    const imagesAllTime = await db.prepare(
      'SELECT COUNT(*) AS c FROM image_generations WHERE user_id = ?'
    ).get(uid);

    const imagesThisMonth = await db.prepare(
      'SELECT COUNT(*) AS c FROM image_generations WHERE user_id = ? AND month_key = ?'
    ).get(uid, monthKey);

    res.json({
      campaigns: campaigns ? campaigns.c : 0,
      sessions: sessions ? sessions.c : 0,
      storyboards: storyboards ? storyboards.c : 0,
      imagesAllTime: imagesAllTime ? imagesAllTime.c : 0,
      imagesThisMonth: imagesThisMonth ? imagesThisMonth.c : 0
    });
  } catch(e) {
    res.json({ campaigns: 0, sessions: 0, storyboards: 0, imagesAllTime: 0, imagesThisMonth: 0 });
  }
});

// GET /api/auth/image-model - current global image model setting
router.get('/image-model', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'image_model'").get();
    res.json({ model: row && row.value ? row.value : 'nano2' });
  } catch(e) {
    res.json({ model: 'nano2' });
  }
});

// PUT /api/auth/image-model - change the global image model setting
router.put('/image-model', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const validModels = ['schnell', 'nano2'];
  const model = req.body.model;
  if (!validModels.includes(model)) return res.json({ error: 'Invalid model' });
  const _adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(function(e){ return e.trim(); }).filter(Boolean);
  const _adb = await getDb();
  const _au = await _adb.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (!_au || !_adminEmails.includes(_au.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const db = await getDb();
    // Upsert the single 'image_model' row.
    const existing = await db.prepare("SELECT setting_key FROM app_settings WHERE setting_key = 'image_model'").get();
    if (existing) {
      await db.prepare("UPDATE app_settings SET value = ? WHERE setting_key = 'image_model'").run(model);
    } else {
      await db.prepare("INSERT INTO app_settings (setting_key, value) VALUES ('image_model', ?)").run(model);
    }
    res.json({ success: true, model: model });
  } catch(e) {
    console.error('image-model save error:', e.message);
    res.json({ error: 'Could not save setting' });
  }
});

module.exports = router;
