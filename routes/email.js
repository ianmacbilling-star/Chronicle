const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const crypto = require('crypto');

// ============================================================
// EMAIL SERVICE
// ============================================================

async function sendEmail(to, subject, html, opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const fromEmail = process.env.FROM_EMAIL || 'noreply@campaignia.com';

  const payload = {
    from: 'Campaignia <' + fromEmail + '>',
    to: to,
    subject: subject,
    html: html
  };
  if (opts && opts.bcc) payload.bcc = opts.bcc;
  if (opts && opts.replyTo) payload.reply_to = opts.replyTo;
  const { data, error } = await resend.emails.send(payload);

  if (error) throw new Error(error.message);
  return data;
}

function passwordResetHTML(name, resetUrl) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Georgia, serif; background: #0a0806; color: #e8d5a3; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: rgba(20,15,8,0.95); border: 1px solid rgba(201,168,76,0.25); border-radius: 12px; overflow: hidden; }
    .header { background: #1a0f08; padding: 32px; text-align: center; border-bottom: 1px solid rgba(201,168,76,0.2); }
    .logo { font-family: Georgia, serif; font-size: 28px; font-weight: 700; color: #c9a84c; letter-spacing: 4px; }
    .body { padding: 32px; }
    .title { font-size: 20px; color: #c9a84c; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.7; color: #e8d5a3; margin-bottom: 20px; }
    .btn { display: inline-block; padding: 14px 32px; background: #c9a84c; color: #1a0f08; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 1px; }
    .footer { padding: 20px 32px; border-top: 1px solid rgba(201,168,76,0.15); font-size: 12px; color: rgba(201,168,76,0.4); text-align: center; }
    .divider { width: 40px; height: 1px; background: rgba(201,168,76,0.4); margin: 16px auto; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">CAMPAIGNIA</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">YOUR ADVENTURE AWAITS</div>
    </div>
    <div class="body">
      <div class="title">Password Reset Request</div>
      <div class="text">Greetings, ${name}.</div>
      <div class="text">We received a request to reset the password for your Campaignia account. Click the button below to choose a new password. This link expires in 1 hour.</div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resetUrl}" class="btn">Reset My Password</a>
      </div>
      <div class="text" style="font-size:12px;color:rgba(201,168,76,0.5);">If you didn't request this, you can safely ignore this email. Your password won't change.</div>
    </div>
    <div class="footer">
      campaignia.com &nbsp;·&nbsp; You make it legendary. Campaignia makes it forever.
    </div>
  </div>
</body>
</html>`;
}

function welcomeHTML(name) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Georgia, serif; background: #0a0806; color: #e8d5a3; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: rgba(20,15,8,0.95); border: 1px solid rgba(201,168,76,0.25); border-radius: 12px; overflow: hidden; }
    .header { background: #1a0f08; padding: 32px; text-align: center; border-bottom: 1px solid rgba(201,168,76,0.2); }
    .logo { font-family: Georgia, serif; font-size: 28px; font-weight: 700; color: #c9a84c; letter-spacing: 4px; }
    .body { padding: 32px; }
    .title { font-size: 22px; color: #c9a84c; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.7; color: #e8d5a3; margin-bottom: 16px; }
    .feature { padding: 10px 14px; background: rgba(201,168,76,0.06); border-left: 3px solid #c9a84c; margin-bottom: 8px; font-size: 13px; }
    .btn { display: inline-block; padding: 14px 32px; background: #c9a84c; color: #1a0f08; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 1px; }
    .divider { width: 40px; height: 1px; background: rgba(201,168,76,0.4); margin: 16px auto; }
    .footer { padding: 20px 32px; border-top: 1px solid rgba(201,168,76,0.15); font-size: 12px; color: rgba(201,168,76,0.4); text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">CAMPAIGNIA</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">YOUR ADVENTURE AWAITS</div>
    </div>
    <div class="body">
      <div class="title">Welcome to Campaignia, ${name}!</div>
      <div class="text">Your 30-day free trial has begun. Here's what you can do with your Copper account:</div>
      <div class="feature">📜 Create 1 campaign and up to 5 sessions</div>
      <div class="feature">✨ AI-powered moment extraction from transcripts</div>
      <div class="feature">🎨 AI image generation for every storyboard panel</div>
      <div class="feature">📖 Graphic novel preview with multiple layouts</div>
      <div style="margin: 24px 0; padding: 14px; background: rgba(201,168,76,0.08); border: 1px solid rgba(201,168,76,0.2); border-radius: 8px; font-size: 13px; color: rgba(201,168,76,0.7);">
        ⏳ Your trial runs for 30 days. Upgrade anytime to unlock unlimited campaigns, full export, and no watermarks.
      </div>
      <div style="text-align:center;margin:24px 0;">
        <a href="https://campaignia.com" class="btn">Start Your Campaign</a>
      </div>
    </div>
    <div class="footer">
      campaignia.com &nbsp;·&nbsp; You make it legendary. Campaignia makes it forever.
    </div>
  </div>
</body>
</html>`;
}

// ============================================================
// ROUTES
// ============================================================

// POST /api/email/forgot-password
router.post('/forgot-password', async function(req, res) {
  const { email } = req.body;
  if (!email) return res.json({ error: 'Email required' });

  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());

    // Always return success to prevent email enumeration
    if (!user) return res.json({ success: true });

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    await db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
      .run(token, expires, user.id);

    const resetUrl = (process.env.APP_URL || 'https://campaignia.com') + '/reset-password.html?token=' + token;

    await sendEmail(user.email, 'Reset your Campaignia password', passwordResetHTML(user.name, resetUrl));

    res.json({ success: true });
  } catch(e) {
    console.error('Forgot password error:', e.message);
    res.json({ success: true }); // Don't reveal errors
  }
});

// POST /api/email/reset-password
router.post('/reset-password', async function(req, res) {
  const { token, password } = req.body;
  if (!token || !password) return res.json({ error: 'Token and password required' });
  if (password.length < 8) return res.json({ error: 'Password must be at least 8 characters' });

  try {
    const db = await getDb();
    const user = await db.prepare(
      'SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?'
    ).get(token, new Date().toISOString());

    if (!user) return res.json({ error: 'This reset link has expired or is invalid. Please request a new one.' });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();

    await db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL, edited_at = ? WHERE id = ?')
      .run(hash, now, user.id);

    res.json({ success: true });
  } catch(e) {
    console.error('Reset password error:', e.message);
    res.json({ error: 'Something went wrong. Please try again.' });
  }
});

// Internal function to send welcome email (called from auth route)
async function sendWelcomeEmail(name, email) {
  try {
    await sendEmail(email, 'Welcome to Campaignia — Your adventure begins!', welcomeHTML(name));
  } catch(e) {
    console.error('Welcome email error:', e.message); // Non-fatal
  }
}

// ============================================================
// PHASE 3 DEPLOY 3 — Invite/join lifecycle emails
// ============================================================
// Three email types, all triggered by the invite flow:
// - inviteEmail: to the invitee when DM creates (or reactivates) an invite
// - joinNotificationEmail: to the DM when the invitee accepts
// - playerJoinedWelcomeEmail: to the new player after accepting
//
// All three are wrapped at the call site in try/catch so an email
// failure never breaks the underlying action (create-invite, accept,
// register-with-invite). Logged for debugging.

function inviteEmailHTML(invitee_hint, dm_name, campaign_name, character_name, character_class, invite_url, expires_at) {
  const charLine = character_name
    ? (character_class ? character_name + ' &mdash; ' + character_class : character_name)
    : 'your character';
  const expiresDate = expires_at ? new Date(expires_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  // Inline styles: strict mail clients strip <head><style>, so style every element directly.
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0806;">
  <div style="max-width:520px;margin:0 auto;background:#140f08;border:1px solid rgba(201,168,76,0.25);border-radius:12px;overflow:hidden;font-family:Georgia,serif;color:#e8d5a3;">
    <div style="background:#1a0f08;padding:32px;text-align:center;border-bottom:1px solid rgba(201,168,76,0.2);">
      <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#c9a84c;letter-spacing:4px;">CAMPAIGNIA</div>
      <div style="width:40px;height:1px;background:rgba(201,168,76,0.4);margin:16px auto;"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">YOU'VE BEEN INVITED</div>
    </div>
    <div style="padding:32px;">
      <div style="font-size:20px;color:#c9a84c;margin-bottom:12px;">${dm_name} invited you to a campaign</div>
      <div style="font-size:14px;line-height:1.7;color:#e8d5a3;margin-bottom:20px;">A seat awaits you at the table.</div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(201,168,76,0.18);border-radius:8px;padding:16px 18px;margin:16px 0;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);">Campaign</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${campaign_name}</div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">Playing as</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${charLine}</div>
        ${expiresDate ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">Invitation expires</div><div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${expiresDate}</div>` : ''}
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${invite_url}" style="display:inline-block;padding:14px 32px;background:#c9a84c;color:#1a0f08;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">Accept Invitation</a>
      </div>
      <div style="font-size:12px;line-height:1.7;color:rgba(201,168,76,0.55);margin-bottom:20px;">If you don't have a Campaignia account yet, the link will let you create one and join in the same step.</div>
      <div style="font-size:12px;line-height:1.7;color:rgba(201,168,76,0.55);margin-bottom:20px;">If the button doesn't work, paste this link into your browser:<br/><span style="color:#c9a84c;word-break:break-all;">${invite_url}</span></div>
    </div>
    <div style="padding:20px 32px;border-top:1px solid rgba(201,168,76,0.15);font-size:12px;color:rgba(201,168,76,0.4);text-align:center;">
      campaignia.com &nbsp;&middot;&nbsp; You make it legendary. Campaignia makes it forever.
    </div>
  </div>
</body>
</html>`;
}

function joinNotificationHTML(dm_name, player_name, player_email, campaign_name, character_name, character_class, campaign_url) {
  const charLine = character_name
    ? (character_class ? character_name + ' &mdash; ' + character_class : character_name)
    : 'a character';
  // NOTE: styles are INLINE on purpose. Several mail clients (Gmail, Outlook)
  // strip <head><style> blocks, which left this email rendering as unstyled
  // text on white. Inline styles survive everywhere.
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0806;">
  <div style="max-width:520px;margin:0 auto;background:#140f08;border:1px solid rgba(201,168,76,0.25);border-radius:12px;overflow:hidden;font-family:Georgia,serif;color:#e8d5a3;">
    <div style="background:#1a0f08;padding:32px;text-align:center;border-bottom:1px solid rgba(201,168,76,0.2);">
      <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#c9a84c;letter-spacing:4px;">CAMPAIGNIA</div>
      <div style="width:40px;height:1px;background:rgba(201,168,76,0.4);margin:16px auto;"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">A NEW PLAYER HAS JOINED</div>
    </div>
    <div style="padding:32px;">
      <div style="font-size:20px;color:#c9a84c;margin-bottom:12px;">${player_name} joined ${campaign_name}</div>
      <div style="font-size:14px;line-height:1.7;color:#e8d5a3;margin-bottom:20px;">Greetings, ${dm_name}.</div>
      <div style="font-size:14px;line-height:1.7;color:#e8d5a3;margin-bottom:20px;">Your invitation has been accepted. The party grows.</div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(201,168,76,0.18);border-radius:8px;padding:16px 18px;margin:16px 0;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);">Player</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${player_name} <span style="color:rgba(201,168,76,0.6);font-size:13px;">&nbsp;${player_email}</span></div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">Now playing</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${charLine}</div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">In campaign</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${campaign_name}</div>
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${campaign_url}" style="display:inline-block;padding:14px 32px;background:#c9a84c;color:#1a0f08;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">Open Campaign</a>
      </div>
    </div>
    <div style="padding:20px 32px;border-top:1px solid rgba(201,168,76,0.15);font-size:12px;color:rgba(201,168,76,0.4);text-align:center;">
      campaignia.com &nbsp;&middot;&nbsp; You make it legendary. Campaignia makes it forever.
    </div>
  </div>
</body>
</html>`;
}

function playerJoinedWelcomeHTML(player_name, dm_name, campaign_name, character_name, character_class, campaign_url) {
  const charLine = character_name
    ? (character_class ? character_name + ' &mdash; ' + character_class : character_name)
    : 'your character';
  // Inline styles: strict mail clients strip <head><style>, so style every element directly.
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0806;">
  <div style="max-width:520px;margin:0 auto;background:#140f08;border:1px solid rgba(201,168,76,0.25);border-radius:12px;overflow:hidden;font-family:Georgia,serif;color:#e8d5a3;">
    <div style="background:#1a0f08;padding:32px;text-align:center;border-bottom:1px solid rgba(201,168,76,0.2);">
      <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#c9a84c;letter-spacing:4px;">CAMPAIGNIA</div>
      <div style="width:40px;height:1px;background:rgba(201,168,76,0.4);margin:16px auto;"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">WELCOME TO THE TABLE</div>
    </div>
    <div style="padding:32px;">
      <div style="font-size:20px;color:#c9a84c;margin-bottom:12px;">Welcome to ${campaign_name}</div>
      <div style="font-size:14px;line-height:1.7;color:#e8d5a3;margin-bottom:20px;">Greetings, ${player_name}.</div>
      <div style="font-size:14px;line-height:1.7;color:#e8d5a3;margin-bottom:20px;">You've successfully joined ${dm_name}'s campaign. Your seat at the table is secured.</div>
      <div style="background:rgba(0,0,0,0.3);border:1px solid rgba(201,168,76,0.18);border-radius:8px;padding:16px 18px;margin:16px 0;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);">Campaign</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${campaign_name}</div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">Your character</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${charLine}</div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(201,168,76,0.7);margin-top:10px;">Run by</div>
        <div style="font-size:15px;color:#e8d5a3;margin-top:2px;">${dm_name}</div>
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${campaign_url}" style="display:inline-block;padding:14px 32px;background:#c9a84c;color:#1a0f08;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:1px;">Enter the Campaign</a>
      </div>
      <div style="font-size:12px;line-height:1.7;color:rgba(201,168,76,0.55);margin-bottom:20px;">From here you can view storyboards, see your fellow adventurers, and follow the story as it unfolds. When your character isn't locked, you can edit its appearance and identity.</div>
    </div>
    <div style="padding:20px 32px;border-top:1px solid rgba(201,168,76,0.15);font-size:12px;color:rgba(201,168,76,0.4);text-align:center;">
      campaignia.com &nbsp;&middot;&nbsp; You make it legendary. Campaignia makes it forever.
    </div>
  </div>
</body>
</html>`;
}

// Send an invite email. Used when a DM creates a new invite AND when
// they reactivate an existing one.
async function sendInviteEmail(opts) {
  // opts: { to_email, dm_name, campaign_name, character_name, character_class, invite_url, expires_at }
  try {
    const subject = `${opts.dm_name} invited you to ${opts.campaign_name}`;
    const html = inviteEmailHTML(opts.to_email, opts.dm_name, opts.campaign_name, opts.character_name, opts.character_class, opts.invite_url, opts.expires_at);
    await sendEmail(opts.to_email, subject, html);
  } catch (e) {
    console.error('Invite email error:', e.message); // Non-fatal
  }
}

// Send a join-notification email to the DM when an invitee accepts.
async function sendJoinNotificationEmail(opts) {
  // opts: { dm_email, dm_name, player_name, player_email, campaign_name, character_name, character_class, campaign_url }
  try {
    const subject = `${opts.player_name} joined ${opts.campaign_name}`;
    const html = joinNotificationHTML(opts.dm_name, opts.player_name, opts.player_email, opts.campaign_name, opts.character_name, opts.character_class, opts.campaign_url);
    await sendEmail(opts.dm_email, subject, html);
  } catch (e) {
    console.error('Join notification email error:', e.message); // Non-fatal
  }
}

// Send a welcome email to the new player after they accept an invite.
async function sendPlayerJoinedWelcomeEmail(opts) {
  // opts: { player_email, player_name, dm_name, campaign_name, character_name, character_class, campaign_url }
  try {
    const subject = `Welcome to ${opts.campaign_name}`;
    const html = playerJoinedWelcomeHTML(opts.player_name, opts.dm_name, opts.campaign_name, opts.character_name, opts.character_class, opts.campaign_url);
    await sendEmail(opts.player_email, subject, html);
  } catch (e) {
    console.error('Player welcome email error:', e.message); // Non-fatal
  }
}

// ============================================================
// MONITORING ALERTS
// Major-event notifications (failed startup, DB down/recovered,
// app crash) sent to monitoring@. Production-only: gated behind
// ALERTS_ENABLED so staging restarts don't generate noise.
// NEVER throws — safe to call from crash/shutdown handlers.
// ============================================================
// Report from the public Library -- a reader flagging a story/image. Sends to
// the support inbox. Best-effort: never throws back to the caller (the route
// returns success regardless so we do not leak whether mail is configured).
async function sendReportEmail(opts) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.error('[report] RESEND_API_KEY not set'); return false; }
    const to = process.env.SUPPORT_EMAIL || 'support@campaignia.com';
    const from = process.env.FROM_EMAIL || 'noreply@campaignia.com';
    function esc(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    const ts = new Date().toISOString();
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222;">' +
      '<h2 style="margin:0 0 12px;">Library content report</h2>' +
      '<p><strong>Story:</strong> ' + esc(opts.storyTitle || '(unknown)') + '</p>' +
      '<p><strong>Story ID:</strong> ' + esc(opts.storyId) + '</p>' +
      '<p><strong>Story URL:</strong> ' + esc(opts.storyUrl || '') + '</p>' +
      '<p><strong>Reporter email:</strong> ' + esc(opts.reporterEmail || '(not provided)') + '</p>' +
      '<p><strong>Reason:</strong></p>' +
      '<pre style="white-space:pre-wrap;background:#f4f4f4;border:1px solid #ddd;border-radius:6px;padding:12px;">' + esc(opts.reason || '') + '</pre>' +
      '<p style="color:#888;font-size:12px;">Received ' + esc(ts) + '</p>' +
      '</div>';
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const payload = {
      from: 'Campaignia Reports <' + from + '>',
      to: to,
      subject: '[Campaignia] Content report: ' + (opts.storyTitle || ('story #' + opts.storyId)),
      html: html
    };
    if (opts.reporterEmail) payload.reply_to = opts.reporterEmail;
    const { error } = await resend.emails.send(payload);
    if (error) { console.error('[report] send failed:', error.message); return false; }
    return true;
  } catch (e) {
    console.error('[report] unexpected error:', (e && e.message) ? e.message : e);
    return false;
  }
}

async function sendAlertEmail(subject, message) {
  try {
    if (process.env.ALERTS_ENABLED !== 'true') {
      console.log('[alert suppressed: ALERTS_ENABLED!=true] ' + subject);
      return false;
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.error('[alert] RESEND_API_KEY not set'); return false; }
    const to = process.env.ALERT_EMAIL || 'monitoring@campaignia.com';
    const from = process.env.ALERT_FROM || 'monitoring@campaignia.com';
    const env = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'production';
    const appUrl = process.env.APP_URL || '(APP_URL not set)';
    const ts = new Date().toISOString();
    const safe = String(message == null ? '' : message)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#0a0806;color:#e8d5a3;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#140f08;border:1px solid rgba(201,168,76,0.25);border-radius:10px;overflow:hidden;">
    <div style="background:#1a0f08;padding:18px 24px;border-bottom:1px solid rgba(201,168,76,0.2);font-weight:700;letter-spacing:1px;color:#c9a84c;">CAMPAIGNIA MONITOR</div>
    <div style="padding:24px;">
      <div style="font-size:18px;color:#f0e8d0;margin-bottom:14px;">${subject}</div>
      <pre style="white-space:pre-wrap;font-family:Consolas,monospace;font-size:13px;line-height:1.6;color:#e8d5a3;background:rgba(0,0,0,0.25);border:1px solid rgba(201,168,76,0.15);border-radius:6px;padding:14px;margin:0 0 18px;">${safe}</pre>
      <div style="font-size:12px;color:rgba(201,168,76,0.55);line-height:1.8;">
        Environment: ${env}<br>App: ${appUrl}<br>Time: ${ts}
      </div>
    </div>
  </div>
</body></html>`;
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: 'Campaignia Monitor <' + from + '>',
      to: to,
      subject: '[Campaignia] ' + subject,
      html: html
    });
    if (error) { console.error('[alert] send failed:', error.message); return false; }
    console.log('[alert sent] ' + subject);
    return true;
  } catch (e) {
    console.error('[alert] unexpected error:', (e && e.message) ? e.message : e);
    return false;
  }
}

function orderConfirmationHTML(name, order) {
  order = order || {};
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function row(label, value) {
    if (value == null || value === '') return '';
    return '<tr><td style="padding:6px 0;color:rgba(201,168,76,0.6);font-size:13px;">' + esc(label) +
      '</td><td style="padding:6px 0;color:#e8d5a3;font-size:13px;text-align:right;">' + esc(value) + '</td></tr>';
  }
  var fmt = [order.binding, order.colorTier, order.coverFinish].filter(Boolean).join(', ');
  var total = (order.total != null) ? ('$' + Number(order.total).toFixed(2) + ' ' + (order.currency || 'USD')) : '';
  var card = (order.cardBrand && order.cardLast4) ? (order.cardBrand + ' ****' + order.cardLast4) : '';
  var sh = order.shipTo || {};
  var addr = [sh.name, sh.street1, sh.street2, [sh.city, sh.stateCode, sh.postcode].filter(Boolean).join(' '), sh.countryCode].filter(Boolean).join(', ');
  var bookTitle = order.bookTitle || order.orderName || order.campaignName || 'Your book';
  var rows = '';
  rows += row('Order number', order.orderNo);
  rows += row('Book title', order.bookTitle);
  rows += row('Campaign', order.campaignName);
  rows += row('Format', fmt);
  rows += row('Pages', order.pageCount);
  rows += row('Quantity', order.quantity);
  rows += row('Total', total);
  rows += row('Paid with', card);
  rows += row('Ship to', addr);
  rows += row('Tracking', order.trackingNumber || 'Sent to Printer, Awaiting Tracking');
  var trackBtn = order.trackingUrl ? ('<div style="text-align:center;margin:24px 0;"><a href="' + esc(order.trackingUrl) + '" class="btn">Track your shipment</a></div>') : '';
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Georgia, serif; background: #0a0806; color: #e8d5a3; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: rgba(20,15,8,0.95); border: 1px solid rgba(201,168,76,0.25); border-radius: 12px; overflow: hidden; }
    .header { background: #1a0f08; padding: 32px; text-align: center; border-bottom: 1px solid rgba(201,168,76,0.2); }
    .logo { font-family: Georgia, serif; font-size: 28px; font-weight: 700; color: #c9a84c; letter-spacing: 4px; }
    .body { padding: 32px; }
    .title { font-size: 22px; color: #c9a84c; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.7; color: #e8d5a3; margin-bottom: 16px; }
    .btn { display: inline-block; padding: 14px 32px; background: #c9a84c; color: #1a0f08; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 1px; }
    .divider { width: 40px; height: 1px; background: rgba(201,168,76,0.4); margin: 16px auto; }
    .footer { padding: 20px 32px; border-top: 1px solid rgba(201,168,76,0.15); font-size: 12px; color: rgba(201,168,76,0.4); text-align: center; }
    table { width: 100%; border-collapse: collapse; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">CAMPAIGNIA</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">ORDER CONFIRMED</div>
    </div>
    <div class="body">
      <div class="title">Thank you${name ? ', ' + esc(name) : ''}!</div>
      <div class="text">Your print order for <strong>${esc(bookTitle)}</strong> has been received and sent to print. Here are the details:</div>
      <div style="margin:18px 0;padding:14px 16px;background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.2);border-radius:8px;">
        <table>${rows}</table>
      </div>
      ${trackBtn}
      <div class="text" style="font-size:13px;color:rgba(201,168,76,0.6);">You can view this order any time on your My Orders page.</div>
    </div>
    <div class="footer">Campaignia &middot; Order confirmation for your print purchase.</div>
  </div>
</body>
</html>`;
}

async function sendOrderConfirmationEmail(opts) {
  // opts: { to_email, name, order }
  try {
    var order = opts.order || {};
    var subject = 'Your Campaignia order is confirmed' + (order.orderNo ? ' (' + order.orderNo + ')' : '');
    var html = orderConfirmationHTML(opts.name, order);
    await sendEmail(opts.to_email, subject, html);
  } catch (e) {
    console.error('Order confirmation email error:', e.message); // Non-fatal
  }
}

function orderProblemHTML(name, order) {
  order = order || {};
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function row(label, value) {
    if (value == null || value === '') return '';
    return '<tr><td style="padding:6px 0;color:rgba(201,168,76,0.6);font-size:13px;">' + esc(label) +
      '</td><td style="padding:6px 0;color:#e8d5a3;font-size:13px;text-align:right;">' + esc(value) + '</td></tr>';
  }
  var fmt = [order.binding, order.colorTier, order.coverFinish].filter(Boolean).join(', ');
  var bookTitle = order.bookTitle || order.orderName || order.campaignName || 'your book';
  var rows = '';
  rows += row('Order number', order.orderNo);
  rows += row('Book title', order.bookTitle);
  rows += row('Campaign', order.campaignName);
  rows += row('Format', fmt);
  rows += row('Pages', order.pageCount);
  rows += row('Quantity', order.quantity);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Georgia, serif; background: #0a0806; color: #e8d5a3; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background: rgba(20,15,8,0.95); border: 1px solid rgba(201,168,76,0.25); border-radius: 12px; overflow: hidden; }
    .header { background: #1a0f08; padding: 32px; text-align: center; border-bottom: 1px solid rgba(201,168,76,0.2); }
    .logo { font-family: Georgia, serif; font-size: 28px; font-weight: 700; color: #c9a84c; letter-spacing: 4px; }
    .body { padding: 32px; }
    .title { font-size: 22px; color: #c9a84c; margin-bottom: 12px; }
    .text { font-size: 14px; line-height: 1.7; color: #e8d5a3; margin-bottom: 16px; }
    .divider { width: 40px; height: 1px; background: rgba(201,168,76,0.4); margin: 16px auto; }
    .footer { padding: 20px 32px; border-top: 1px solid rgba(201,168,76,0.15); font-size: 12px; color: rgba(201,168,76,0.4); text-align: center; }
    table { width: 100%; border-collapse: collapse; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">CAMPAIGNIA</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">ORDER ISSUE</div>
    </div>
    <div class="body">
      <div class="title">There was a problem with your order</div>
      <div class="text">${name ? esc(name) + ', we' : 'We'} ran into a problem while placing your print order for <strong>${esc(bookTitle)}</strong>, so it has not been sent to print.</div>
      <div class="text">If your card was charged, that charge will be reversed. Our team has been notified and will look into it &mdash; you can also reply to this email and we&rsquo;ll help sort it out.</div>
      ${rows ? '<div style="margin:18px 0;padding:14px 16px;background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.2);border-radius:8px;"><table>' + rows + '</table></div>' : ''}
      <div class="text" style="font-size:13px;color:rgba(201,168,76,0.6);">Sorry for the inconvenience.</div>
    </div>
    <div class="footer">Campaignia &middot; Support@campaignia.com</div>
  </div>
</body>
</html>`;
}

async function sendOrderProblemEmail(opts) {
  // opts: { to_email, name, order }. Sends to the customer and BCCs support.
  try {
    var order = opts.order || {};
    var subject = 'There was a problem with your Campaignia order' + (order.orderNo ? ' (' + order.orderNo + ')' : '');
    var html = orderProblemHTML(opts.name, order);
    await sendEmail(opts.to_email, subject, html, { bcc: 'Support@campaignia.com' });
  } catch (e) {
    console.error('Order problem email error:', e.message); // Non-fatal
  }
}

function feedbackHTML(opts) {
  function esc(v){ return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  return '<div style="font-family:Arial,sans-serif;max-width:600px;color:#222;">' +
    '<h2 style="color:#2d6a4f;margin:0 0 12px;">New Campaignia feedback</h2>' +
    '<p style="margin:4px 0;"><strong>Category:</strong> ' + esc(opts.category || 'Other') + '</p>' +
    (opts.subject ? '<p style="margin:4px 0;"><strong>Subject:</strong> ' + esc(opts.subject) + '</p>' : '') +
    '<p style="margin:4px 0;"><strong>From:</strong> ' + esc(opts.from_name || '') + ' (' + esc(opts.from_email || '') + ')</p>' +
    '<p style="margin:4px 0;"><strong>Plan:</strong> ' + esc(opts.tier || '') + '</p>' +
    '<hr style="border:none;border-top:1px solid #ddd;margin:14px 0;"/>' +
    '<p style="white-space:pre-wrap;line-height:1.5;">' + esc(opts.message || '') + '</p>' +
  '</div>';
}

async function sendFeedbackEmail(opts) {
  const subject = '[Campaignia Feedback] ' + (opts.category || 'Other') + (opts.subject ? ' - ' + opts.subject : '');
  await sendEmail('support@campaignia.com', subject, feedbackHTML(opts), { replyTo: opts.from_email });
}

module.exports = { router, sendWelcomeEmail, sendInviteEmail, sendJoinNotificationEmail, sendPlayerJoinedWelcomeEmail, sendAlertEmail, sendOrderConfirmationEmail, sendOrderProblemEmail, sendReportEmail, sendFeedbackEmail };
