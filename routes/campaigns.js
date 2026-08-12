const express = require('express');
const router = express.Router();
const { getDb, getForkBookPrefs, setForkBookPrefs, bookPrefsScope, versionsForCampaign, ownsBookVersion, getVersionRow, versionOwnerUserId } = require('../database/db');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const genres = require('../services/genres');   // v3.0.485 -- TD-217/TD-189, single source of truth
const { checkCampaignLimit, getEffectiveTier, isTruePlatinum, tierRank, accessRank, getTier, ART_STYLE_MIN_RANK, NARRATIVE_STYLE_MIN_RANK } = require('../middleware/tiers');
const { deleteFile, archiveCopy, restoreCopy, uploadFile, releaseImage } = require('../storage/storage');
const { flattenOntoColour } = require('../storage/alpha');
const { resolveTitleTarget, targetFromRequest } = require('../services/titleTarget');   // v3.0.636 -- TD-422

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
    built_title_url: cur.built_title_url || '',
    // v3.0.622 -- TD-357(2). The WORDS the built title actually has drawn on it, recorded at build
    // time. Without them "has the title changed since it was drawn?" cannot be asked at all: the
    // artwork is a URL and a URL does not spell anything. built_title_sub follows subtitle's own
    // three-state convention (null = never set) so the two can be compared like with like.
    // v3.0.622 -- the UNCUT generation. What goes on the cover is built_title_url (cut, transparent);
    // this is the same picture before the ground came off, and it is what Retouch and Reference are
    // handed. Empty for titles built before v3.0.622, which fall back to a repaint (TB_REF_BACK).
    built_title_src: cur.built_title_src || '',
    // The description that drew it, kept so an archived title can show its prompt like every other
    // archived image does, and so reopening the builder is not a blank Description box.
    built_title_prompt: cur.built_title_prompt || '',
    // v3.0.624 -- the one-step undo behind Revert. Same shape as revert_image_url on a moment.
    built_title_prev: cur.built_title_prev || '',
    built_title_prev_src: cur.built_title_prev_src || '',
    built_title_text: cur.built_title_text || '',
    built_title_sub: (cur.built_title_sub == null ? null : String(cur.built_title_sub)),
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

// v3.0.650 -- WHEN MEMBERS CANNOT PUBLISH, THE STORY MASTER BUILDS THE BOOK FOR THEM.
//
// Ian, 2026-08-12: "When the setting is off... This is a feature that the SM then takes control
// over for the Member... and likely charges money for. Then the SM alone can hit the publish
// button change covers, titles etc and still use the other layout selections the member made."
//
// THIS REOPENS SOMETHING v3.0.575 DELIBERATELY CLOSED, and only under the condition that makes it
// coherent. 575 removed a blanket Story Master exemption because versions had made it redundant:
// a Story Master wanting a member to have a different-looking book could simply make them a
// version. That reasoning holds while the member can publish. It stops holding when they cannot,
// because then nobody but the Story Master can finish the book at all.
//
// SO THE GATE IS THE PUBLISH FLAG ITSELF. Setting on: 575 stands, untouched, and a member owns
// their book completely. Setting off: the Story Master may set the presentation of a member book
// in this campaign -- and only in this campaign, and only over its members.
//
// SCOPE FALLS OUT OF THE ROUTE. Cover, back cover, title page image, built title, book title,
// subtitle, title colour and layout_opts all arrive here. Art style and narrative voice do not --
// they live per-fork on the session side. Ian: "They should not be changing Art Style or narrative
// style. Those are really the users." Nothing had to be excluded to honour that; the boundary he
// described and the boundary of this route are the same line.
function smCurationOpen(req) {
  if (!req || req.campaignRole !== 'dm') return false;
  var c = req.campaign || {};
  var allow = (c.allow_player_novel_access === true || c.allow_player_novel_access === 1 ||
              c.allow_player_novel_access === 't' || c.allow_player_novel_access === 'true');
  return !allow;
}
router.put('/:campaignId/my-book-meta', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const uid = req.session.userId, cid = req.params.campaignId, b = req.body || {};
  const fork = (b.fork_user != null) ? Number(b.fork_user) : (req.query.as_user ? Number(req.query.as_user) : uid);
  // v3.0.575 -- THE STORY MASTER EXEMPTION IS GONE. You write the book you own, and nothing else.
  // Ian, 2026-08-09: "the userID of the person logged in must match the userid of the owner of the
  // version in order for it to save. This is a slight departure from what we had before -- I think
  // before you could have your own title and cover on someone elses book. Now that we have added
  // versions that is not necessary anymore."
  // A Story Master who wants a member to have a different-looking book creates a VERSION for them,
  // which carries the layout, the art style and the narrative too -- where this overlay only ever
  // carried the cover and the title, so the book it produced was half curated.
  // v3.0.650 -- the 575 rule, with the publish-flag exemption. A refusal here still reads exactly
  // as it did when the setting is on.
  var _curating = false;
  if (fork !== uid) {
    if (!smCurationOpen(req)) {
      return res.status(403).json({ error: 'You can only edit your own book. Switch to your own version to change the cover or the layout.' });
    }
    // The target has to be a member of THIS campaign. campaignRole proves who is asking; it says
    // nothing about who is being written to, and a campaign id in the path is not a licence over
    // an arbitrary user id in the body.
    var _isMember = await db.prepare('SELECT 1 AS ok FROM campaign_members WHERE campaign_id = ? AND user_id = ?').get(cid, fork);
    if (!_isMember) {
      return res.status(403).json({ error: 'That person is not a member of this campaign.' });
    }
    _curating = true;
  }
  const patch = {};
  if (b.cover_image_url !== undefined) patch.cover_image_url = b.cover_image_url || null;
  if (b.back_cover_image_url !== undefined) patch.back_cover_image_url = b.back_cover_image_url || null;
  if (b.title_image_url !== undefined) patch.title_image_url = b.title_image_url || null;
  // v3.0.618 -- THE BUILT TITLE IS ITS OWN FIELD. v3.0.617 stored it in title_image_url, which was
  // ALREADY TAKEN: that is the third image in the Prep panel, the artwork on the book title PAGE.
  // Ian saw his own title-page image appear in the builder and said so before anything overwrote it.
  // The prefs blob takes new keys with no schema change, which is exactly what it is for.
  if (b.built_title_url !== undefined) patch.built_title_url = b.built_title_url || null;
  // v3.0.622 -- TD-357(2). Written in the same call as the URL, never on their own, so the artwork
  // and the record of what it says cannot drift apart. Empty is preserved for the subtitle for the
  // same reason it is on `subtitle` above -- a title drawn with no subtitle is a real state.
  if (b.built_title_src !== undefined) patch.built_title_src = b.built_title_src || null;
  if (b.built_title_prompt !== undefined) patch.built_title_prompt = b.built_title_prompt || null;
  if (b.built_title_prev !== undefined) patch.built_title_prev = b.built_title_prev || null;
  if (b.built_title_prev_src !== undefined) patch.built_title_prev_src = b.built_title_prev_src || null;
  if (b.built_title_text !== undefined) patch.built_title_text = b.built_title_text || null;
  if (b.built_title_sub !== undefined) patch.built_title_sub = (b.built_title_sub === '' ? '' : (b.built_title_sub || null));
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
  // v3.0.575 -- ONE OWNERSHIP TEST, AND IT COVERS THE CANONICAL TOO.
  // This used to exempt any DM outright, so a Story Master could write onto a member's version.
  // Now everyone is asked the same question: are you the owner of the version on screen.
  // THE CANONICAL HAS NO user_id AND THAT IS DELIBERATE. versionOwnerUserId derives it from
  // campaign_members role='dm', so canonical ownership FOLLOWS A STORY MASTER HANDOVER for free --
  // where a stamped column would leave the new Story Master locked out of their own book and would
  // go NULL again if the old owner's account were deleted (TD-248). Ian asked for the row to be
  // stamped; the derivation gives the same answer and cannot go stale, so it is used instead.
  // v3.0.622 -- the same test, now shared with the three title routes below (see ownsBookVersion).
  // v3.0.650 -- a curating Story Master is answering a different question, so it is asked here
  // rather than skipped: the version on screen must belong to the person being written to, and to
  // this campaign. Without that, a stale or hand-edited as_version would write one member settings
  // into another member book -- the same class of fault as the (chooser, fork) inversion the
  // v3.0.481 note below describes, and just as silent.
  if (_curating) {
    if (_scP.bookVersionId) {
      var _vrow = await getVersionRow(db, _scP.bookVersionId);
      var _vowner = _vrow ? await versionOwnerUserId(db, _vrow) : null;
      if (!_vrow || String(_vrow.campaign_id) !== String(cid) || String(_vowner) !== String(fork)) {
        return res.status(403).json({ error: 'That version does not belong to the member whose book you are editing.' });
      }
    }
  } else if (!(await ownsBookVersion(db, uid, _scP.bookVersionId))) {
    return res.status(403).json({ error: 'You are looking at someone else\u2019s version. Switch to your own version to change the cover or the layout.' });
  }
  // v3.0.578 -- fill_only: write these values only where nothing is stored yet. Used by the Prep
  // panel's first-load materialise, which must establish defaults without ever overwriting an edit
  // the reader has already made. See the note on setForkBookPrefs: this route can have two writes
  // in flight at once, and fill-only is safe under every interleaving rather than under most.
  const _fillOnly = !!(b && b.fill_only);
  // v3.0.650 -- THE CHOOSER IS THE OWNER WHEN CURATING, AND THAT IS THE WHOLE DIFFERENCE BETWEEN
  // AN OVERWRITE AND A PRIVATE OVERLAY.
  //
  // fork_book_prefs is keyed (chooser_user_id, fork_user_id, campaign_id, version_id). Writing as
  // the Story Master would land in (SM, member) -- a row only the Story Master ever reads back,
  // which is precisely the overlay v3.0.575 removed and precisely what Ian rejected when asked:
  // "I think a real overwrite... They are the STORY MASTER so when this is the case they have more
  // control over that users settings."
  //
  // So a curating write goes to (member, member) -- the row the member reads themselves. What the
  // Story Master publishes is what the member would see. It is not reversible and the member is
  // not told; that is the deal the setting describes.
  var _chooser = _curating ? fork : uid;
  const merged = await setForkBookPrefs(db, _chooser, fork, cid, patch, _scP.versionId, { fillOnly: _fillOnly });
  const camp = await db.prepare('SELECT campaign_image_url FROM campaigns WHERE id = ?').get(cid);
  res.json({
    campaign_id: Number(cid),
    cover_image_url: merged.cover_image_url || (camp ? camp.campaign_image_url : '') || '',
    back_cover_image_url: merged.back_cover_image_url || '',
    title_image_url: merged.title_image_url || '',
    built_title_url: merged.built_title_url || '',
    built_title_src: merged.built_title_src || '',
    built_title_prompt: merged.built_title_prompt || '',
    built_title_prev: merged.built_title_prev || '',
    built_title_prev_src: merged.built_title_prev_src || '',
    built_title_text: merged.built_title_text || '',
    built_title_sub: (merged.built_title_sub == null ? null : String(merged.built_title_sub)),
    book_title: merged.book_title || '',
    // v3.0.575 -- THE PUT NOW ANSWERS IN THE SAME SHAPE AS THE GET. It omitted the subtitle, so a
    // client assigning this response onto state.bookMeta (the image picker does, and the new
    // materialise does) silently dropped a subtitle it had never touched. Two payloads describing
    // one record must carry the same fields or the caller has to remember which is which.
    subtitle: (merged.subtitle == null ? null : String(merged.subtitle)),
    title_color: merged.title_color || '',
    layout_opts: merged.layout_opts || '',
    own_cover: merged.cover_image_url || '', own_back: merged.back_cover_image_url || '', own_title: merged.title_image_url || ''
  });
});

// =============================================================================================
// BUILT TITLE: ARCHIVE, RESTORE, AND REUSE AS A REFERENCE  (TD-401, TD-402)
// =============================================================================================
// Ian, 2026-08-10: "we need to be able to remove it once it is on there", "allow them to Archive the
// title and allow them to pull it back in as the title reference image", and a new archive type
// called title.
//
// REMOVE IS NOT A ROUTE. Clearing a built title is `built_title_url: ''` through the my-book-meta PUT
// that already exists and already refuses a cross-version write. A second way to write the same field
// would be a second place for that refusal to be got wrong.
//
// THESE THREE ARE ROUTES because each does something the client cannot: copy bytes into the protected
// archives/ prefix, copy them back out into a live object, or repaint a transparent PNG.
//
// NONE OF THEM CALLS FAL, so none of them costs a token. Ian's rule is one token per fal call; these
// move pictures that have already been paid for.
//
// WHY THE WORDS ARE STORED WITH THE PICTURE. A built title has its subtitle DRAWN INTO it, so an
// archive that says only "a title" is six identical thumbnails. `title` holds the book title and
// layout_meta holds the subtitle and the uncut original -- layout_meta is already the free-form
// per-image column (it carries focal/crop_safe for panels), so no schema change is needed.

// v3.0.636 -- titleScope is gone; these three routes call resolveTitleTarget, the same adapter
// routes/images.js uses. It was a second hand-written copy of resolve-scope-prove-ownership-read,
// and the ownership refusal it returned had to be word-identical to the other copy to keep the
// message consistent -- which is exactly the kind of agreement that stops being true (TD-422).

// POST /:campaignId/title-read -- what title is on this target right now (TD-422).
//
// v3.0.641 -- the book's title arrives with the rest of my-book-meta, so the Title Builder never
// needed to ask for it. A chapter's lives on the establishing moment and nothing sends it, so the
// modal had no way to know whether a chapter already had artwork.
//
// POST, not GET, because the target is a structured thing and belongs in a body rather than smeared
// across a query string -- and because it is the same shape title-write takes. Two routes over one
// adapter, reading and writing the same words.
//
// NOT PLATINUM GATED, deliberately. Reading what is already on your own chapter tells you nothing
// you could not see by looking at the page, and a lapsed Platinum still needs the modal to show what
// is there so they can take it off (TD-421).
router.post('/:campaignId/title-read', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    const db = await getDb();
    const t = await resolveTitleTarget(db, req, targetFromRequest(req, req.params.campaignId));
    if (t.error) return res.status(403).json({ error: t.error });
    return res.json({
      success: true,
      kind: t.kind,
      momentId: t.momentId || null,
      current: {
        url: t.current.url, src: t.current.src,
        text: t.current.text, sub: t.current.sub, prompt: t.current.prompt,
        prevUrl: t.current.prevUrl
      },
      // What this target SHOULD draw, so the modal shows the same words the server will use.
      words: t.current.words || { title: '', subtitle: '' }
    });
  } catch (e) {
    console.error('title-read error:', e && e.message);
    return res.json({ error: 'Could not read the title for this.' });
  }
});

// POST /:campaignId/title-write -- save a built title onto WHATEVER target is named (TD-422).
//
// v3.0.639 -- the client wrote titles through the my-book-meta PUT, which only knows about a book.
// A chapter title lives on the establishing moment, so a second writer was needed -- and a second
// writer is how the two drift. This is ONE route for both, and the adapter decides where the bytes
// land: prefs for a book, the moment for a chapter.
//
// THE KEYS ARE WHITELISTED. The patch goes into a prefs blob or a layout_meta blob, both free-form
// JSON, so an unfiltered body would let a caller write anything it liked into either -- including
// keys the layout engine reads. Only the seven the Title Builder owns are copied across.
//
// REMOVE STILL WORKS WITHOUT PLATINUM ON A BOOK, deliberately: it goes through the my-book-meta PUT,
// which is ungated, so a lapsed Platinum can still take a drawn title off their own cover (TD-421).
// This route IS gated, because everything reaching it is a Title Builder action.
router.post('/:campaignId/title-write', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const db = await getDb();
    const t = await resolveTitleTarget(db, req, targetFromRequest(req, req.params.campaignId));
    if (t.error) return res.status(403).json({ error: t.error });

    const body = (req.body && req.body.patch) || {};
    const patch = {};
    ['url', 'src', 'text', 'sub', 'prompt', 'prevUrl', 'prevSrc'].forEach(function (k) {
      if (body[k] !== undefined) patch[k] = body[k];
    });
    if (!Object.keys(patch).length) return res.json({ error: 'Nothing to save.' });

    const out = await t.write(patch);
    if (out && out.error) return res.json({ error: out.error });
    return res.json({ success: true, kind: t.kind, momentId: t.momentId || null, current: out });
  } catch (e) {
    console.error('title-write error:', e && e.message);
    return res.json({ error: 'Could not save the title. Please try again.' });
  }
});

// POST /:campaignId/my-book-meta/archive-title -- save the built title into the campaign Archive.
// The URL is READ FROM THE VERSION, never taken from the body: a client-named URL would let anything
// on the internet be fetched and stored into someone else's campaign.
router.post('/:campaignId/my-book-meta/archive-title', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    // v3.0.634 -- Platinum only, same as the Title Builder itself. Reached only from that modal,
    // but a route may not rely on which button opened it.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const db = await getDb();
    const t = await resolveTitleTarget(db, req, targetFromRequest(req, req.params.campaignId));
    if (t.error) return res.status(403).json({ error: t.error });
    const liveUrl = t.current.url;
    if (!liveUrl) return res.json({ error: 'There is no built title to archive yet.' });

    // Same cap, same message, same tier as every other archive. Ian: "Fine for the count too."
    try {
      const effName = await getEffectiveTier(req.session.userId, t.campaignId);
      const effTier = getTier(effName);
      const cap = effTier ? effTier.max_archives_per_campaign : null;
      if (cap !== null && cap !== undefined) {
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_archives WHERE campaign_id = ?').get(t.campaignId);
        if (cnt && cnt.c >= cap) {
          return res.json({ error: 'This campaign has hit its archive limit of ' + cap + ' images on the ' + effTier.name + ' tier. Remove an archived image to make room, or upgrade for more.' });
        }
      }
    } catch (capErr) { console.error('archive cap check error:', capErr.message); }

    const archivedUrl = await archiveCopy(liveUrl);
    // The uncut original is archived TOO when there is one, because it is the picture a later Retouch
    // or Reference wants and the live copy it points at is not protected from cleanup.
    let archivedSrc = '';
    if (t.current.src) {
      try { archivedSrc = await archiveCopy(t.current.src); }
      catch (e) { console.error('archive built-title source failed (keeping the cut copy):', e.message); }
    }
    const meta = JSON.stringify({
      subtitle: t.current.sub,
      src: archivedSrc || null
    });
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_archives (campaign_id, fork_id, image_type, title, image_url, source_url, image_prompt, layout_meta, archived_by, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    // v3.0.623 -- FORK_ID IS NULL, AND THAT IS NOT A SHORTCUT.
    // v3.0.622 passed sc.fork here and every archive attempt failed on a foreign key. Two different
    // things are called a fork in this codebase: bookPrefsScope.fork is a USER id, and
    // campaign_archives.fork_id REFERENCES session_forks(id). Same word, different kind of number,
    // and the name matching is exactly why it was never checked against the column it was going into.
    // A built title belongs to a book version and has no session fork at all, so NULL is also the
    // true answer -- the archives list LEFT JOINs session_forks, which is built for that.
    ).run(t.campaignId, null, 'title', t.current.text || t.current.bookTitle || null,
          archivedUrl, liveUrl, t.current.prompt || null, meta, req.session.userId, now);
    const row = await db.prepare('SELECT * FROM campaign_archives WHERE id = ?').get(result.lastInsertRowid);
    return res.json({ success: true, archive: row });
  } catch (e) {
    console.error('archive-title error:', e && e.message);
    return res.json({ error: 'Could not archive the title. Please try again.' });
  }
});

// POST /:campaignId/my-book-meta/restore-title -- put an archived title back on the cover.
// Body: { archiveId }. The archived bytes are copied into a FRESH live object exactly as the panel
// and character replaces do, so archives/ is never pointed at by a living book.
router.post('/:campaignId/my-book-meta/restore-title', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    // v3.0.634 -- Platinum only, same as the Title Builder itself. Reached only from that modal,
    // but a route may not rely on which button opened it.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const db = await getDb();
    const t = await resolveTitleTarget(db, req, targetFromRequest(req, req.params.campaignId));
    if (t.error) return res.status(403).json({ error: t.error });
    const arch = await db.prepare('SELECT * FROM campaign_archives WHERE id = ? AND campaign_id = ?').get(req.body && req.body.archiveId, t.campaignId);
    if (!arch || !arch.image_url) return res.json({ error: 'Archived title not found.' });
    if (arch.image_type !== 'title') return res.json({ error: 'That archived image is not a title.' });

    const freshUrl = await restoreCopy(arch.image_url);
    let meta = {};
    try { meta = arch.layout_meta ? (typeof arch.layout_meta === 'object' ? arch.layout_meta : JSON.parse(arch.layout_meta)) : {}; } catch (e) { meta = {}; }
    let freshSrc = '';
    if (meta && meta.src) { try { freshSrc = await restoreCopy(meta.src); } catch (e) { console.error('restore built-title source failed:', e.message); } }

    const prevUrl = t.current.url, prevSrc = t.current.src;
    // The WORDS travel with the picture. Without them the mismatch warning would compare the book's
    // title against whatever the PREVIOUS title had drawn on it, and quietly say the wrong thing.
    const merged = await t.write({
      url: freshUrl,
      src: freshSrc || '',
      text: arch.title || '',
      sub: (meta && meta.subtitle !== undefined) ? meta.subtitle : null
    });
    if (prevUrl && prevUrl !== freshUrl) { try { await releaseImage(db, prevUrl); } catch (e) {} }
    if (prevSrc && prevSrc !== freshSrc) { try { await releaseImage(db, prevSrc); } catch (e) {} }
    return res.json({
      success: true,
      built_title_url: merged.url,
      built_title_src: merged.src,
      built_title_text: merged.text,
      built_title_sub: merged.sub
    });
  } catch (e) {
    console.error('restore-title error:', e && e.message);
    return res.json({ error: 'Could not put that title back on the cover. Please try again.' });
  }
});

// POST /:campaignId/my-book-meta/title-ref-from-archive -- hand an archived title back as a REFERENCE.
// Body: { archiveId }. Returns { url } for the Title Builder's reference slot.
//
// The archived UNCUT original is preferred. Where there isn't one -- every title archived before
// v3.0.622 -- the cut copy is repainted onto TB_REF_BACK, because a transparent PNG handed to fal has
// no background and what fal decides to put there is neither ours to choose nor visible to us.
router.post('/:campaignId/my-book-meta/title-ref-from-archive', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    // v3.0.634 -- Platinum only, same as the Title Builder itself. Reached only from that modal,
    // but a route may not rely on which button opened it.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const db = await getDb();
    const arch = await db.prepare('SELECT * FROM campaign_archives WHERE id = ? AND campaign_id = ?').get(req.body && req.body.archiveId, req.params.campaignId);
    if (!arch || !arch.image_url) return res.json({ error: 'Archived title not found.' });
    if (arch.image_type !== 'title') return res.json({ error: 'That archived image is not a title.' });

    let meta = {};
    try { meta = arch.layout_meta ? (typeof arch.layout_meta === 'object' ? arch.layout_meta : JSON.parse(arch.layout_meta)) : {}; } catch (e) { meta = {}; }
    if (meta && meta.src) return res.json({ url: await restoreCopy(meta.src) });

    const axios = require('axios');
    const https = require('https');
    const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
    const resp = await axios.get(arch.image_url, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const buf = Buffer.from(resp.data);
    // TB_REF_BACK is black -- see the note in routes/images.js. Black is not a guess here: the
    // generate prompt demands a flat solid black field, so black is exactly what the cut removed.
    const out = flattenOntoColour(buf, 0, 0, 0);
    if (out === buf) return res.json({ url: await restoreCopy(arch.image_url) });   // opaque already
    const name = 'titleflat-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10) + '.png';
    return res.json({ url: await uploadFile(out, name, 'image/png') });
  } catch (e) {
    console.error('title-ref-from-archive error:', e && e.message);
    return res.json({ error: 'Could not use that archived title as a reference.' });
  }
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
