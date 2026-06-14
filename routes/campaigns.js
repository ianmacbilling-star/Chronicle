const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const { checkCampaignLimit, getEffectiveTier, tierRank, accessRank, getTier, ART_STYLE_MIN_RANK, NARRATIVE_STYLE_MIN_RANK } = require('../middleware/tiers');
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
  var _allowNovel = (req.body.allow_player_novel_access !== undefined)
    ? (req.body.allow_player_novel_access === true || req.body.allow_player_novel_access === 'true' || req.body.allow_player_novel_access === 1)
    : campaign.allow_player_novel_access;
  await db.prepare('UPDATE campaigns SET name=?, description=?, cover_image_url=?, back_cover_image_url=?, title_image_url=?, allow_player_novel_access=?, edited_at=?, edited_by=? WHERE id=?')
    .run(
      req.body.name || campaign.name,
      req.body.description !== undefined ? req.body.description : campaign.description,
      req.body.cover_image_url !== undefined ? req.body.cover_image_url : campaign.cover_image_url,
      req.body.back_cover_image_url !== undefined ? req.body.back_cover_image_url : campaign.back_cover_image_url,
      req.body.title_image_url !== undefined ? req.body.title_image_url : campaign.title_image_url,
      _allowNovel,
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

// Per-campaign tier resolution for the client: the caller's EFFECTIVE tier
// (the higher of their own tier and the SM's), plus the style lock tables so
// the style pickers can render locked styles as visible-but-unselectable.
// The server is the source of truth and re-checks on every set/generate; this
// endpoint is only so the UI can show the locks. Fails open (UI-only).
router.get('/:campaignId/tier-info', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const name = await getEffectiveTier(req.session.userId, req.params.campaignId);
    const t = getTier(name);
    res.json({
      effective_tier: name,
      effective_rank: accessRank(name),
      watermark: !!t.watermark,
      can_export: !!t.can_export,
      can_print: !!t.can_print,
      art_locks: ART_STYLE_MIN_RANK,
      narrative_locks: NARRATIVE_STYLE_MIN_RANK
    });
  } catch (e) {
    res.json({ effective_tier: 'copper', effective_rank: 1, watermark: true, can_export: false, can_print: false, art_locks: {}, narrative_locks: {} });
  }
});

// ============================================================
// PER-MEMBER LAYOUT / STYLE PREFERENCES (member_prefs on campaign_members).
// A member's saved Art Style / Narrative Style / Layout (co) bundle, stored at
// the member level so it carries across sessions and switches with the active
// fork. READ: the DM may read ANY member's prefs (so SM book-gen auto-loads a
// member's look); a player reads only their own. WRITE: a member may write ONLY
// their OWN prefs -- you can never save onto another member's fork, even as DM.
// Stored as a JSON string (TEXT), matching the layout_meta precedent; the blob
// is expected to grow with more layout params, so it is round-tripped whole and
// merged (a partial PUT never wipes the untouched fields).
// ============================================================
function safeParsePrefs(v) {
  var empty = { art_style: null, narrative_style: null, layout_opts: {} };
  if (!v) return empty;
  try {
    var o = (typeof v === 'string') ? JSON.parse(v) : v;
    if (!o || typeof o !== 'object') return empty;
    return {
      art_style: (typeof o.art_style === 'string') ? o.art_style : null,
      narrative_style: (typeof o.narrative_style === 'string') ? o.narrative_style : null,
      layout_opts: (o.layout_opts && typeof o.layout_opts === 'object') ? o.layout_opts : {}
    };
  } catch (e) { return empty; }
}

router.get('/:campaignId/members/:userId/prefs', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    var targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Bad user id' });
    // READ: DM may read any member; a player only their own.
    if (req.campaignRole !== 'dm' && targetId !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    var db = await getDb();
    var row = await db.prepare(
      'SELECT member_prefs FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
    ).get(req.params.campaignId, targetId);
    if (!row) return res.status(404).json({ error: 'Not a member of this campaign' });
    res.json(safeParsePrefs(row.member_prefs));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load member prefs' });
  }
});

router.put('/:campaignId/members/:userId/prefs', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    var targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Bad user id' });
    // WRITE: own fork only -- you may save ONLY your own prefs, even as DM.
    if (targetId !== req.session.userId) {
      return res.status(403).json({ error: 'You can only save preferences on your own fork' });
    }
    var db = await getDb();
    var cur0 = await db.prepare(
      'SELECT member_prefs FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
    ).get(req.params.campaignId, targetId);
    if (!cur0) return res.status(404).json({ error: 'Not a member of this campaign' });
    var cur = safeParsePrefs(cur0.member_prefs);
    var body = req.body || {};
    // Merge: a field provided as a string sets it; explicit null clears it;
    // omitted leaves the stored value. layout_opts is replaced whole when given.
    var next = {
      art_style: (typeof body.art_style === 'string') ? body.art_style : (body.art_style === null ? null : cur.art_style),
      narrative_style: (typeof body.narrative_style === 'string') ? body.narrative_style : (body.narrative_style === null ? null : cur.narrative_style),
      layout_opts: (body.layout_opts && typeof body.layout_opts === 'object') ? body.layout_opts : cur.layout_opts
    };
    var json = JSON.stringify(next);
    if (json.length > 20000) return res.status(413).json({ error: 'Preferences too large' });
    await db.prepare(
      'UPDATE campaign_members SET member_prefs = ? WHERE campaign_id = ? AND user_id = ?'
    ).run(json, req.params.campaignId, targetId);
    res.json({ success: true, prefs: next });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save member prefs' });
  }
});


module.exports = router;
