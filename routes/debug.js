const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// Per-user, opt-in Debug Mode capture.
//
// The flag lives on users.debug_mode (server-authoritative) and is reset to false
// on logout (routes/auth.js), so it is intentionally ephemeral. When ON, other
// modules call logDebug(userId, entry) to record diagnostic entries for THAT user
// only. Entries are bounded per user by the retention below.
const RETENTION_DAYS = 30;
const RETENTION_ROWS = 5000;
const DISPLAY_LIMIT = 500;   // most recent N entries returned to the panel
const SUPPORT_EMAIL = 'support@campaignia.com';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Record one debug entry for a user, but ONLY when that user currently has Debug
// Mode on. Fully best-effort: any failure is swallowed so instrumentation can never
// break the request it is observing. `entry` = { level, source, page, fn, message,
// detail }. detail may be an object (stored as pretty JSON) or a string.
async function logDebug(userId, entry) {
  try {
    if (!userId) return;
    const db = await getDb();
    const u = await db.prepare('SELECT debug_mode FROM users WHERE id = ?').get(userId);
    if (!u || !u.debug_mode) return;
    entry = entry || {};
    let detail = entry.detail;
    if (detail != null && typeof detail !== 'string') {
      try { detail = JSON.stringify(detail, null, 2); } catch (e) { detail = String(detail); }
    }
    await db.prepare(
      'INSERT INTO debug_logs (user_id, level, source, page, fn, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, entry.level || 'info', entry.source || 'server', entry.page || '', entry.fn || '', entry.message || '', detail || '');
    // Prune by age, then by per-user row cap.
    await db.prepare("DELETE FROM debug_logs WHERE user_id = ? AND created_at < (CURRENT_TIMESTAMP - INTERVAL '" + RETENTION_DAYS + " days')").run(userId);
    await db.prepare(
      'DELETE FROM debug_logs WHERE user_id = ? AND id NOT IN (SELECT id FROM debug_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?)'
    ).run(userId, userId, RETENTION_ROWS);
  } catch (e) {
    try { console.warn('[logDebug] non-fatal: ' + (e && e.message)); } catch (_e) {}
  }
}

router.use(requireAuth);

// GET /api/debug/status -- the current user's flag (panel reads this on open).
router.get('/status', async function(req, res) {
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT debug_mode FROM users WHERE id = ?').get(req.session.userId);
    res.json({ debug_mode: !!(u && u.debug_mode) });
  } catch (e) {
    res.status(500).json({ error: 'Could not read debug status.' });
  }
});

// POST /api/debug/toggle  body { on: true|false } -- set the current user's flag.
// Turning it ON writes a first entry so the panel immediately shows activity.
router.post('/toggle', async function(req, res) {
  try {
    const on = !!(req.body && req.body.on);
    const db = await getDb();
    await db.prepare('UPDATE users SET debug_mode = ? WHERE id = ?').run(on, req.session.userId);
    if (on) {
      await logDebug(req.session.userId, {
        level: 'info', source: 'server', page: 'Account', fn: 'POST /api/debug/toggle',
        message: 'Debug Mode enabled',
        detail: { userAgent: req.headers['user-agent'] || '', at: new Date().toISOString() }
      });
    }
    res.json({ debug_mode: on });
  } catch (e) {
    res.status(500).json({ error: 'Could not update debug mode.' });
  }
});

// GET /api/debug/logs -- the current user's recent entries, newest first.
router.get('/logs', async function(req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT id, created_at, level, source, page, fn, message, detail FROM debug_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(req.session.userId, DISPLAY_LIMIT);
    res.json({ entries: rows || [] });
  } catch (e) {
    res.status(500).json({ error: 'Could not read debug log.' });
  }
});

// POST /api/debug/clear -- the user clears their own captured log.
router.post('/clear', async function(req, res) {
  try {
    const db = await getDb();
    await db.prepare('DELETE FROM debug_logs WHERE user_id = ?').run(req.session.userId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not clear debug log.' });
  }
});

// POST /api/debug/send -- email the current user's captured log to support.
router.post('/send', async function(req, res) {
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.session.userId);
    const rows = await db.prepare(
      'SELECT id, created_at, level, source, page, fn, message, detail FROM debug_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?'
    ).all(req.session.userId, DISPLAY_LIMIT);
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Email is not configured.' });
    const fromEmail = process.env.FROM_EMAIL || 'noreply@campaignia.com';
    const blocks = (rows || []).map(function(e) {
      return '[' + (e.created_at || '') + '] ' + String(e.level || 'info').toUpperCase() + ' / ' + (e.source || '') +
        '\n  page: ' + (e.page || '-') +
        '\n  fn:   ' + (e.fn || '-') +
        '\n  msg:  ' + (e.message || '-') +
        (e.detail ? ('\n  detail:\n' + String(e.detail).replace(/^/gm, '    ')) : '');
    });
    const bodyText =
      'User: ' + (u ? (u.name + ' <' + u.email + '> (id ' + u.id + ')') : ('id ' + req.session.userId)) +
      '\nEntries: ' + (rows ? rows.length : 0) +
      '\n\n' + (blocks.length ? blocks.join('\n\n') : '(no entries)');
    const who = u ? (u.name + ' <' + u.email + '>') : ('user ' + req.session.userId);
    const html = '<p style="font:14px/1.5 sans-serif;">Debug log attached from ' + escapeHtml(who) + '.</p>' +
      '<p style="font:14px/1.5 sans-serif;">Entries: ' + (rows ? rows.length : 0) + '</p>';
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = 'campaignia-debug-' + (u ? u.id : req.session.userId) + '-' + stamp + '.txt';
    const { Resend } = require('resend');
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: 'Campaignia Debug <' + fromEmail + '>',
      to: SUPPORT_EMAIL,
      subject: 'Debug log from ' + (u ? u.email : ('user ' + req.session.userId)),
      html: html,
      attachments: [{ filename: fileName, content: Buffer.from(bodyText, 'utf8').toString('base64') }]
    });
    if (error) return res.status(502).json({ error: 'Could not send the log.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not send the log.' });
  }
});

module.exports = router;
module.exports.logDebug = logDebug;
