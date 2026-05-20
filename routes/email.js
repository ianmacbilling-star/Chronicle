const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const crypto = require('crypto');

// ============================================================
// EMAIL SERVICE
// ============================================================

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY not set');
    throw new Error('Email service not configured');
  }

  const { Resend } = require('resend');
  const resend = new Resend(apiKey);

  const fromEmail = process.env.FROM_EMAIL || 'chronicle@chroniclemygame.com';

  const { data, error } = await resend.emails.send({
    from: 'Chronicle <' + fromEmail + '>',
    to: to,
    subject: subject,
    html: html
  });

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
      <div class="logo">CHRONICLE</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">YOUR ADVENTURE AWAITS</div>
    </div>
    <div class="body">
      <div class="title">Password Reset Request</div>
      <div class="text">Greetings, ${name}.</div>
      <div class="text">We received a request to reset the password for your Chronicle account. Click the button below to choose a new password. This link expires in 1 hour.</div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resetUrl}" class="btn">Reset My Password</a>
      </div>
      <div class="text" style="font-size:12px;color:rgba(201,168,76,0.5);">If you didn't request this, you can safely ignore this email. Your password won't change.</div>
    </div>
    <div class="footer">
      chroniclemygame.com &nbsp;·&nbsp; The Chronicle of Your Campaign
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
      <div class="logo">CHRONICLE</div>
      <div class="divider"></div>
      <div style="font-size:12px;color:rgba(201,168,76,0.5);letter-spacing:2px;">YOUR ADVENTURE AWAITS</div>
    </div>
    <div class="body">
      <div class="title">Welcome to Chronicle, ${name}!</div>
      <div class="text">Your 30-day free trial has begun. Here's what you can do with your Copper account:</div>
      <div class="feature">📜 Create 1 campaign and up to 5 sessions</div>
      <div class="feature">✨ AI-powered moment extraction from transcripts</div>
      <div class="feature">🎨 AI image generation for every storyboard panel</div>
      <div class="feature">📖 Graphic novel preview with multiple layouts</div>
      <div style="margin: 24px 0; padding: 14px; background: rgba(201,168,76,0.08); border: 1px solid rgba(201,168,76,0.2); border-radius: 8px; font-size: 13px; color: rgba(201,168,76,0.7);">
        ⏳ Your trial runs for 30 days. Upgrade anytime to unlock unlimited campaigns, full export, and no watermarks.
      </div>
      <div style="text-align:center;margin:24px 0;">
        <a href="https://chroniclemygame.com" class="btn">Start Your Chronicle</a>
      </div>
    </div>
    <div class="footer">
      chroniclemygame.com &nbsp;·&nbsp; The Chronicle of Your Campaign
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

    const resetUrl = (process.env.APP_URL || 'https://chroniclemygame.com') + '/reset-password.html?token=' + token;

    await sendEmail(user.email, 'Reset your Chronicle password', passwordResetHTML(user.name, resetUrl));

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
    await sendEmail(email, 'Welcome to Chronicle — Your adventure begins!', welcomeHTML(name));
  } catch(e) {
    console.error('Welcome email error:', e.message); // Non-fatal
  }
}

module.exports = { router, sendWelcomeEmail };
