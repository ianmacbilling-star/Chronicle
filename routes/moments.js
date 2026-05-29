const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM } = require('../middleware/auth');

router.get('/', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id=? ORDER BY panel_order ASC').all(req.params.sessionId);
  res.json(moments);
});

router.post('/', requireAuth, verifyCampaignDM, async function(req, res) {
  const { title, description, type, prompt, panel_order } = req.body;
  if (!title) return res.json({ error: 'Title required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO moments (session_id, title, description, type, prompt, panel_order, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).run(req.params.sessionId, title, description || '', type || 'drama', prompt || '', panel_order || 0, now, req.session.userId);
  const moment = await db.prepare('SELECT * FROM moments WHERE id=?').get(result.lastInsertRowid);
  res.json(moment);
});

router.delete('/:momentId', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  await db.prepare('DELETE FROM moments WHERE id=? AND session_id=?').run(req.params.momentId, req.params.sessionId);
  res.json({ success: true });
});

// PUT - edit a moment's prompt. Prompt editing is a Platinum-tier perk,
// so the tier is enforced here on the server, not just in the UI.
router.put('/:momentId', requireAuth, verifyCampaignDM, async function(req, res) {
  const { getTier } = require('../middleware/tiers');
  const db = await getDb();

  const user = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
  const tier = getTier(user ? user.tier : 'copper');
  if (!tier.can_edit_prompts) {
    return res.status(403).json({ error: 'Prompt editing is available on the Platinum plan.' });
  }

  const { prompt } = req.body;
  if (typeof prompt !== 'string') return res.json({ error: 'Prompt required' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE moments SET prompt = ?, edited_at = ?, edited_by = ? WHERE id = ? AND session_id = ?'
  ).run(prompt, now, req.session.userId, req.params.momentId, req.params.sessionId);

  const moment = await db.prepare('SELECT * FROM moments WHERE id = ?').get(req.params.momentId);
  res.json({ success: true, moment: moment });
});

module.exports = router;
