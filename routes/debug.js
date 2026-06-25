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
router.post('/toggle', async function(req, res) {
  try {
    const on = !!(req.body && req.body.on);
    const db = await getDb();
    await db.prepare('UPDATE users SET debug_mode = ? WHERE id = ?').run(on, req.session.userId);
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

module.exports = router;
module.exports.logDebug = logDebug;
