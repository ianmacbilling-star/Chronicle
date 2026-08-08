const express = require('express');
const router = express.Router();
const { getDb, getForkBookPrefs, setForkBookPrefs, bookPrefsScope, versionsForCampaign } = require('../database/db');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const genres = require('../services/genres');   // v3.0.485 -- TD-217/TD-189, single source of truth
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
  // v3.0.485 -- genre + campaign prompt. Validation is server-side on purpose:
  // maxlength is a suggestion, and the 3-cap / exclusive-other rules must hold
  // against any client. sanitizeGenres returns null for 'not supplied', so a PUT
  // that omits the field leaves the stored value alone.
  var _genresIn = genres.sanitizeGenres(req.body.genres);
  var _genres = (_genresIn === null) ? campaign.genres : JSON.stringify(_genresIn);
  var _cprompt = (req.body.campaign_prompt !== undefined) ? genres.campaignPrompt(req.body.campaign_prompt) : campaign.campaign_prompt;
  await db.prepare('UPDATE campaigns SET name=?, description=?, lore=?, genres=?, campaign_prompt=?, cover_image_url=?, back_cover_image_url=?, title_image_url=?, campaign_image_url=?, allow_player_novel_access=?, allow_member_assets=?, edited_at=?, edited_by=? WHERE id=?')
    .run(
      req.body.name || campaign.name,
      req.body.description !== undefined ? req.body.description : campaign.description,
      _lore,
      _genres,
      _cprompt,
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
  // v3.0.455 -- version-scoped; bookPrefsScope is the same resolver pdf.js uses.
  const _sc = await bookPrefsScope(db, req, Number(req.params.campaignId));
  const fork = _sc.fork;
  const cur = await getForkBookPrefs(db, req.session.userId, fork, req.params.campaignId, { inherit: true, versionId: _sc.versionId });
  const camp = await db.prepare('SELECT campaign_image_url FROM campaigns WHERE id = ?').get(req.params.campaignId);
  // v3.0.552 -- the session dates, for seeding the subtitle field. Cheap, and read-only.
  const _sdRows = await db.prepare('SELECT session_date FROM sessions WHERE campaign_id = ? AND session_date IS NOT NULL').all(req.params.campaignId);
  const _sdTimes = (_sdRows || []).map(function (r) { return Date.parse(r.session_date); }).filter(function (t) { return !isNaN(t); });
  const _dateRange = require('./pdf').formatDateRange(_sdTimes);
  res.json({
    campaign_id: Number(req.params.campaignId),
    cover_image_url: cur.cover_image_url || (camp ? camp.campaign_image_url : '') || '',
    back_cover_image_url: cur.back_cover_image_url || '',
    title_image_url: cur.title_image_url || '',
    book_title: cur.book_title || '',
    // v3.0.552 -- null is sent as null, NOT coerced to empty. The client needs to tell "never set"
    // from "cleared" so it knows whether to seed the field with the dates.
    subtitle: (cur.subtitle == null ? null : String(cur.subtitle)),
    // The date range the cover would show, computed by the SAME function pdf.js renders with
    // (formatDateRange). The Prep panel seeds the subtitle field from this, so a book that has never
    // had a subtitle opens showing exactly what its cover already says -- and a second copy of a
    // date format, which is the fault this codebase keeps re-finding, does not get created.
    date_range: _dateRange,
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
  // v3.0.552 -- THE EMPTY STRING IS PRESERVED, DELIBERATELY. `b.subtitle || null` would collapse ''
  // back to null, and null and empty are now DIFFERENT states: null means the book has never had a
  // subtitle and shows its dates, empty means someone cleared it and it shows nothing. Collapsing
  // them would make the field settable but never removable, which is the thing Ian asked to fix.
  if (b.subtitle !== undefined) patch.subtitle = (b.subtitle === '' ? '' : (b.subtitle || null));
  if (b.title_color !== undefined) patch.title_color = b.title_color || null;
  // Layout choices (borders, paper, fonts, drop cap, narrative style, arrange...) ride in the SAME
  // per-(chooser, fork, campaign) prefs blob as the cover art, so they follow the book, not the browser.
  if (b.layout_opts !== undefined) patch.layout_opts = b.layout_opts || null;
  const _scP = await bookPrefsScope(db, req, Number(cid));
  // v3.0.481 -- YOU MAY READ ANYONE'S BOOK SETTINGS; YOU MAY ONLY WRITE YOUR OWN (TD-282).
  //
  // Ian: "If I load up someone else's book it should load up their layout too from their version.
  // But if I change something on the layout or on the cover, that change should not change THEIR
  // settings. If it can save my own version that's fine. If not that's fine too."
  //
  // The first two were already true -- v3.0.478/479 made the read follow the version's owner, and
  // the fork check above refuses a cross-fork write. The THIRD was the problem: a member editing
  // while someone else's version was on screen wrote to (them, them, 0) and then READ back from
  // (them, owner, ...), so the change was saved somewhere nothing ever looks. Write-only, silent,
  // and it appeared to work until the page reloaded. That inversion is mine, introduced by the
  // v3.0.478 read fix, and given the choice was open, refusing is better than saving into a hole.
  //
  // The Story Master curating a member's book is untouched -- that is the fork check above, and it
  // is a different permission from this one.
  if (_scP.bookVersionId && req.campaignRole !== 'dm') {
    const _vw = await db.prepare('SELECT user_id, is_canonical FROM campaign_versions WHERE id = ?').get(_scP.bookVersionId);
    const _mine = _vw && !_vw.is_canonical && String(_vw.user_id) === String(uid);
    if (!_mine) {
      return res.status(403).json({ error: 'You are looking at someone else\u2019s version. Switch to your own version to change the cover or the layout.' });
    }
  }
  const merged = await setForkBookPrefs(db, uid, fork, cid, patch, _scP.versionId);
  const camp = await db.prepare('SELECT campaign_image_url FROM campaigns WHERE id = ?').get(cid);
  res.json({
    campaign_id: Number(cid),
    cover_image_url: merged.cover_image_url || (camp ? camp.campaign_image_url : '') || '',
    back_cover_image_url: merged.back_cover_image_url || '',
    title_image_url: merged.title_image_url || '',
    book_title: merged.book_title || '',
    title_color: merged.title_color || '',
    layout_opts: merged.layout_opts || '',
    own_cover: merged.cover_image_url || '', own_back: merged.back_cover_image_url || '', own_title: merged.title_image_url || ''
  });
});

// ---------------------------------------------------------------------------------------------
// CAMPAIGN VERSIONS (TD-242 Model B, v3.0.456)
//
// A version is campaign-level and owns at most one fork per session. These routes are the LIST and
// the RENAME. Creation lives on the session (POST /sessions/:id/fork), because you always create a
// version FROM somewhere -- there is no useful empty version.
//
// DELETE IS DELIBERATELY NOT HERE. Deleting a version means deleting every fork it owns, and the
// per-session delete already does that one at a time with the reference-counted image release.
// Doing it in bulk deserves its own build and its own confirmation, not a route added in passing.
// ---------------------------------------------------------------------------------------------
router.get('/:campaignId/versions', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const list = await versionsForCampaign(db, req.params.campaignId, req.session.userId, null);
  res.json(list);
});

// RENAME acts on the VERSION, so it renames every session at once -- there is one name, not one per
// session. The fork name is mirrored for as long as the Session page still reads it; that mirroring
// is a TRANSITIONAL DUPLICATE and comes out with the client work, because two places holding one
// fact is how TD-194 happened. The version row is the only writer.
router.patch('/:campaignId/versions/:versionId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const v = await db.prepare('SELECT id, campaign_id, user_id, is_canonical FROM campaign_versions WHERE id = ?').get(req.params.versionId);
  if (!v || String(v.campaign_id) !== String(req.params.campaignId)) return res.status(404).json({ error: 'Version not found' });
  if (v.is_canonical) {
    if (req.campaignRole !== 'dm') return res.status(403).json({ error: 'Only the Story Master can rename the canonical version' });
  } else if (String(v.user_id) !== String(req.session.userId)) {
    return res.status(403).json({ error: 'You can only rename your own versions' });
  }
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim().slice(0, 60) : '';
  if (!name) return res.status(400).json({ error: 'Please give this version a name.' });
  const clash = await db.prepare('SELECT id FROM campaign_versions WHERE campaign_id = ? AND user_id = ? AND name = ? AND id <> ? AND NOT is_canonical')
    .get(req.params.campaignId, v.user_id, name, v.id);
  if (clash) return res.status(409).json({ error: 'You already have a version of this campaign called that.' });
  await db.prepare('UPDATE campaign_versions SET name = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, v.id);
  await db.prepare('UPDATE session_forks SET name = ? WHERE version_id = ?').run(name, v.id);
  res.json({ success: true, version_id: v.id, name: name });
});

module.exports = router;
