const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork, getViewableForkId } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');

router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const viewForkId = await getViewableForkId(db, req.params.sessionId, req.session.userId, req.query.fork_id);
  if (!viewForkId) return res.status(403).json({ error: 'Fork not viewable' });
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id=? ORDER BY panel_order ASC').all(viewForkId);
  res.json(moments);
});

router.post('/', requireAuth, verifyCampaignDM, async function(req, res) {
  const { title, description, type, prompt, panel_order } = req.body;
  if (!title) return res.json({ error: 'Title required' });
  const db = await getDb();
  const now = new Date().toISOString();
  // Deploy 4.0 — manual moments belong to the DM fork.
  const dmForkId = await getOrCreateDmFork(db, req.params.sessionId, req.session.userId);
  const result = await db.prepare(
    'INSERT INTO moments (session_id, fork_id, title, description, type, prompt, panel_order, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(req.params.sessionId, dmForkId, title, description || '', type || 'drama', prompt || '', panel_order || 0, now, req.session.userId);
  const moment = await db.prepare('SELECT * FROM moments WHERE id=?').get(result.lastInsertRowid);
  res.json(moment);
});

router.delete('/:momentId', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  await db.prepare('DELETE FROM moments WHERE id=? AND session_id=?').run(req.params.momentId, req.params.sessionId);
  res.json({ success: true });
});

// PUT - edit a moment's prompt. DM may edit canonical (Platinum-gated);
// a player may edit prompts freely on their OWN version (tokens are the
// meter for forks, not tier).
router.put('/:momentId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.id, sf.user_id AS fork_owner FROM moments m JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ? AND m.session_id = ?'
  ).get(req.params.momentId, req.params.sessionId);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const isDM = req.campaignRole === 'dm';
  const ownsThisFork = String(moment.fork_owner) === String(req.session.userId);
  if (!ownsThisFork) return res.status(403).json({ error: 'You can only edit your own version' });
  // Tier gate applies only to DM canonical editing.
  if (isDM) {
    const { getTier } = require('../middleware/tiers');
    const user = await db.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
    const tier = getTier(user ? user.tier : 'copper');
    if (!tier.can_edit_prompts) {
      return res.status(403).json({ error: 'Prompt editing is available on the Platinum plan.' });
    }
  }

  const { prompt } = req.body;
  if (typeof prompt !== 'string') return res.json({ error: 'Prompt required' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE moments SET prompt = ?, edited_at = ?, edited_by = ? WHERE id = ? AND session_id = ?'
  ).run(prompt, now, req.session.userId, req.params.momentId, req.params.sessionId);

  const updatedMoment = await db.prepare('SELECT * FROM moments WHERE id = ?').get(req.params.momentId);
  res.json({ success: true, moment: updatedMoment });
});

module.exports = router;
