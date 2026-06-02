const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { checkCampaignLimit } = require('../middleware/tiers');
const { deleteFile } = require('../storage/storage');

// List campaigns the user is a member of (any role — DM or player). This
// is the entry point users hit after login, and Phase 2 makes it
// multi-user-aware: a player invited to a campaign sees it here too.
// For existing single-user data, behavior is identical (every campaign's
// creator was backfilled as a 'dm' member at Phase 1).
router.get('/', requireAuth, async function(req, res) {
  const db = await getDb();
  // Phase 3 Deploy 3 — `locked` indicates this campaign has at least
  // one session in 'ready' state, which gates player canonical-editing
  // (until forks land in Phase 4). EXISTS subquery is cheap on the
  // small per-user campaign set.
  const campaigns = await db.prepare(
    'SELECT c.*, cm.role AS my_role, ' +
    "EXISTS (SELECT 1 FROM session_forks f JOIN sessions s ON s.id = f.session_id " +
    "WHERE s.campaign_id = c.id AND f.role = 'dm' AND f.player_access_status = 'ready') AS locked " +
    'FROM campaigns c ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id ' +
    'WHERE cm.user_id = ? ' +
    'ORDER BY c.created_at DESC'
  ).all(req.session.userId);
  res.json(campaigns);
});

router.post('/', requireAuth, checkCampaignLimit, async function(req, res) {
  const { name, description } = req.body;
  if (!name) return res.json({ error: 'Campaign name required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO campaigns (user_id, name, description, created_at, created_by) VALUES (?,?,?,?,?)'
  ).run(req.session.userId, name.trim(), description || '', now, req.session.userId);
  const campaignId = result.lastInsertRowid;

  // Phase 2: the creator is also the initial DM member. The Phase 1
  // backfill only covers EXISTING campaigns; new campaigns need this
  // row written at creation time, or the GET above would never return
  // the campaign to its own creator.
  await db.prepare(
    "INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?, ?, 'dm') ON CONFLICT (campaign_id, user_id) DO NOTHING"
  ).run(campaignId, req.session.userId);

  // Start trial on first campaign creation
  const userCheck = await db.prepare('SELECT trial_started_at FROM users WHERE id = ?').get(req.session.userId);
  if (!userCheck.trial_started_at) {
    await db.prepare('UPDATE users SET trial_started_at = ? WHERE id = ?').run(now, req.session.userId);
  }
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  res.json(campaign);
});

// Edit campaign — DM-only. Authorization now reads campaign_members.
router.put('/:id', requireAuth, async function(req, res) {
  const db = await getDb();
  const role = await db.prepare(
    'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);
  if (!role || role.role !== 'dm') return res.status(403).json({ error: 'DM access required' });
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const now = new Date().toISOString();
  await db.prepare('UPDATE campaigns SET name=?, description=?, cover_image_url=?, edited_at=?, edited_by=? WHERE id=?')
    .run(
      req.body.name || campaign.name,
      req.body.description !== undefined ? req.body.description : campaign.description,
      req.body.cover_image_url !== undefined ? req.body.cover_image_url : campaign.cover_image_url,
      now, req.session.userId, campaign.id
    );
  const updated = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign.id);
  res.json(updated);
});

// Delete campaign — DM-only.
router.delete('/:id', requireAuth, async function(req, res) {
  const db = await getDb();
  const role = await db.prepare(
    'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
  ).get(req.params.id, req.session.userId);
  if (!role || role.role !== 'dm') return res.status(403).json({ error: 'DM access required' });

  // Gather every R2 object this campaign owns BEFORE the cascade wipes the
  // rows; the FK cascade deletes rows, not the R2 bytes. We free them after.
  var urls = [];
  var cid = req.params.id;
  async function grab(sql){ try { (await db.prepare(sql).all(cid)).forEach(function(r){ if (r && r.u) urls.push(r.u); }); } catch(e){ console.error('campaign-delete gather:', e.message); } }
  await grab("SELECT m.image AS u FROM moments m JOIN sessions s ON s.id = m.session_id WHERE s.campaign_id = ?");
  await grab("SELECT sc.reference_url AS u FROM session_characters sc JOIN session_forks sf ON sf.id = sc.fork_id JOIN sessions s ON s.id = sf.session_id WHERE s.campaign_id = ?");
  await grab("SELECT canonical_reference_url AS u FROM characters WHERE campaign_id = ?");
  await grab("SELECT image_url AS u FROM campaign_assets WHERE campaign_id = ?");
  await grab("SELECT image_url AS u FROM campaign_archives WHERE campaign_id = ?");

  await db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);

  // Free the orphaned objects (campaign + all its rows are gone now). Best-
  // effort, fire-and-forget, de-duped; never blocks or fails the response.
  (async function(){ var seen = {}; for (var i=0;i<urls.length;i++){ var u=urls[i]; if(!u||seen[u])continue; seen[u]=true; try{ await deleteFile(u); }catch(e){ console.error('campaign-delete release:', e.message); } } })();

  res.json({ success: true });
});

module.exports = router;
