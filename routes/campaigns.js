const express = require('express');
const router = express.Router();
const { getDb, getForkBookPrefs, setForkBookPrefs } = require('../database/db');
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
  const { name, description, lore } = req.body;
  if (!name) return res.json({ error: 'Campaign name required' });
  const db = await getDb();
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO campaigns (user_id, name, description, lore, created_at, created_by) VALUES (?,?,?,?,?,?)'
  ).run(req.session.userId, name.trim(), description || '', String(lore || '').slice(0, 6000), now, req.session.userId);
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
  var _allowAssets = (req.body.allow_member_assets !== undefined)
    ? (req.body.allow_member_assets === true || req.body.allow_member_assets === 'true' || req.body.allow_member_assets === 1)
    : campaign.allow_member_assets;
  var _lore = (req.body.lore !== undefined) ? String(req.body.lore || '').slice(0, 6000) : campaign.lore;
  await db.prepare('UPDATE campaigns SET name=?, description=?, lore=?, cover_image_url=?, back_cover_image_url=?, title_image_url=?, campaign_image_url=?, allow_player_novel_access=?, allow_member_assets=?, edited_at=?, edited_by=? WHERE id=?')
    .run(
      req.body.name || campaign.name,
      req.body.description !== undefined ? req.body.description : campaign.description,
      _lore,
      req.body.cover_image_url !== undefined ? req.body.cover_image_url : campaign.cover_image_url,
      req.body.back_cover_image_url !== undefined ? req.body.back_cover_image_url : campaign.back_cover_image_url,
      req.body.title_image_url !== undefined ? req.body.title_image_url : campaign.title_image_url,
      req.body.campaign_image_url !== undefined ? req.body.campaign_image_url : campaign.campaign_image_url,
      _allowNovel,
      _allowAssets,
      now, req.session.userId, campaign.id
    );
  const updated = await db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign.id);
  res.json(updated);
});

// Delete campaign — DM/owner only. Safe by default: refuses while the campaign
// still has content (sessions, characters, assets, archives) or other members.
// Only an otherwise-empty campaign is deleted. Most child tables do NOT cascade
// on the campaign FK, so we clear the non-cascading leftovers (owner membership,
// pending invites, image jobs) first and null out print-order links (kept for
// financial records). campaign_archives / public_stories cascade on their own.
router.delete('/:id', requireAuth, async function(req, res) {
  const db = await getDb();
  const cid = req.params.id;
  const role = await db.prepare(
    'SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
  ).get(cid, req.session.userId);
  if (!role || role.role !== 'dm') return res.status(403).json({ error: 'DM access required' });

  // Count anything that should block the delete.
  async function count(sql){ try { var r = await db.prepare(sql).get(cid); return r ? (Number(r.n) || 0) : 0; } catch(e){ console.error('campaign-delete count:', e.message); return 0; } }
  var counts = {
    sessions:     await count('SELECT COUNT(*) AS n FROM sessions WHERE campaign_id = ?'),
    characters:   await count('SELECT COUNT(*) AS n FROM characters WHERE campaign_id = ?'),
    assets:       await count('SELECT COUNT(*) AS n FROM campaign_assets WHERE campaign_id = ?'),
    archives:     await count('SELECT COUNT(*) AS n FROM campaign_archives WHERE campaign_id = ?'),
    otherMembers: Math.max(0, (await count('SELECT COUNT(*) AS n FROM campaign_members WHERE campaign_id = ?')) - 1)
  };
  if (counts.sessions || counts.characters || counts.assets || counts.archives || counts.otherMembers) {
    return res.status(409).json({ error: 'NOT_EMPTY', counts: counts });
  }

  // Gather any R2 objects to free afterward (empty campaigns usually have none,
  // but a campaign tile/cover image may exist). Best-effort.
  var urls = [];
  async function grab(sql){ try { (await db.prepare(sql).all(cid)).forEach(function(r){ if (r && r.u) urls.push(r.u); }); } catch(e){ console.error('campaign-delete gather:', e.message); } }
  await grab('SELECT campaign_image_url AS u FROM campaigns WHERE id = ?');
  await grab('SELECT cover_image_url AS u FROM campaigns WHERE id = ?');

  // Clear non-cascading children first so the FK never blocks, then the campaign.
  async function wipe(sql){ try { await db.prepare(sql).run(cid); } catch(e){ console.error('campaign-delete wipe:', e.message); } }
  await wipe('DELETE FROM campaign_invites WHERE campaign_id = ?');
  await wipe('DELETE FROM image_jobs WHERE campaign_id = ?');
  await wipe('UPDATE print_orders SET campaign_id = NULL WHERE campaign_id = ?');
  await wipe('DELETE FROM campaign_members WHERE campaign_id = ?');
  try {
    await db.prepare('DELETE FROM campaigns WHERE id = ?').run(cid);
  } catch(e) {
    console.error('campaign-delete final:', e.message);
    return res.status(500).json({ error: 'Could not delete campaign — something still references it.' });
  }

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
      'SELECT user_id FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
    ).get(req.params.campaignId, targetId);
    if (!row) return res.status(404).json({ error: 'Not a member of this campaign' });
    var prefs = await getForkBookPrefs(db, req.session.userId, targetId, req.params.campaignId, { inherit: true });
    res.json({
      art_style: (typeof prefs.art_style === 'string') ? prefs.art_style : null,
      narrative_style: (typeof prefs.narrative_style === 'string') ? prefs.narrative_style : null,
      layout_opts: (prefs.layout_opts && typeof prefs.layout_opts === 'object') ? prefs.layout_opts : {}
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load member prefs' });
  }
});

router.put('/:campaignId/members/:userId/prefs', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    var targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Bad user id' });
    // WRITE: your own fork always; the DM may also curate any member's fork, saved into
    // the DM's OWN overlay slot (chooser = self, fork = target) -- never the member's.
    if (targetId !== req.session.userId && req.campaignRole !== 'dm') {
      return res.status(403).json({ error: 'You can only save preferences on your own fork' });
    }
    var db = await getDb();
    var mrow = await db.prepare(
      'SELECT user_id FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
    ).get(req.params.campaignId, targetId);
    if (!mrow) return res.status(404).json({ error: 'Not a member of this campaign' });
    var body = req.body || {};
    // Merge: a field provided as a string sets it; explicit null clears it;
    // omitted leaves the stored value. layout_opts is replaced whole when given.
    var patch = {};
    if (typeof body.art_style === 'string' || body.art_style === null) patch.art_style = body.art_style;
    if (typeof body.narrative_style === 'string' || body.narrative_style === null) patch.narrative_style = body.narrative_style;
    if (body.layout_opts && typeof body.layout_opts === 'object') patch.layout_opts = body.layout_opts;
    if (JSON.stringify(patch).length > 20000) return res.status(413).json({ error: 'Preferences too large' });
    var merged = await setForkBookPrefs(db, req.session.userId, targetId, req.params.campaignId, patch);
    res.json({ success: true, prefs: {
      art_style: (typeof merged.art_style === 'string') ? merged.art_style : null,
      narrative_style: (typeof merged.narrative_style === 'string') ? merged.narrative_style : null,
      layout_opts: (merged.layout_opts && typeof merged.layout_opts === 'object') ? merged.layout_opts : {}
    } });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save member prefs' });
  }
});


// Per-member book metadata (Phase 2b): a member's own cover / back / title images
// and book title for THEIR published fork. Empty image fields fall back to the SM
// campaign values so every book has a cover. Keyed to the requester.
router.get('/:campaignId/my-book-meta', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const fork = req.query.as_user ? Number(req.query.as_user) : req.session.userId;
  const cur = await getForkBookPrefs(db, req.session.userId, fork, req.params.campaignId, { inherit: true });
  const camp = await db.prepare('SELECT campaign_image_url FROM campaigns WHERE id = ?').get(req.params.campaignId);
  res.json({
    cover_image_url: cur.cover_image_url || (camp ? camp.campaign_image_url : '') || '',
    back_cover_image_url: cur.back_cover_image_url || '',
    title_image_url: cur.title_image_url || '',
    book_title: cur.book_title || '',
    title_color: cur.title_color || '',
    layout_opts: cur.layout_opts || '',   // per (chooser, fork, campaign) layout choices -- stored beside the cover art
    own_cover: cur.cover_image_url || '', own_back: cur.back_cover_image_url || '', own_title: cur.title_image_url || ''
  });
});

router.put('/:campaignId/my-book-meta', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const uid = req.session.userId, cid = req.params.campaignId, b = req.body || {};
  const fork = (b.fork_user != null) ? Number(b.fork_user) : (req.query.as_user ? Number(req.query.as_user) : uid);
  if (fork !== uid && req.campaignRole !== 'dm') return res.status(403).json({ error: 'You can only edit your own fork' });
  const patch = {};
  if (b.cover_image_url !== undefined) patch.cover_image_url = b.cover_image_url || null;
  if (b.back_cover_image_url !== undefined) patch.back_cover_image_url = b.back_cover_image_url || null;
  if (b.title_image_url !== undefined) patch.title_image_url = b.title_image_url || null;
  if (b.book_title !== undefined) patch.book_title = b.book_title || null;
  if (b.title_color !== undefined) patch.title_color = b.title_color || null;
  // Layout choices (borders, paper, fonts, drop cap, narrative style, arrange...) ride in the SAME
  // per-(chooser, fork, campaign) prefs blob as the cover art, so they follow the book, not the browser.
  if (b.layout_opts !== undefined) patch.layout_opts = b.layout_opts || null;
  const merged = await setForkBookPrefs(db, uid, fork, cid, patch);
  const camp = await db.prepare('SELECT campaign_image_url FROM campaigns WHERE id = ?').get(cid);
  res.json({
    cover_image_url: merged.cover_image_url || (camp ? camp.campaign_image_url : '') || '',
    back_cover_image_url: merged.back_cover_image_url || '',
    title_image_url: merged.title_image_url || '',
    book_title: merged.book_title || '',
    title_color: merged.title_color || '',
    layout_opts: merged.layout_opts || '',
    own_cover: merged.cover_image_url || '', own_back: merged.back_cover_image_url || '', own_title: merged.title_image_url || ''
  });
});

module.exports = router;
