const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getDmForkId } = require('../database/db');
const { friendlyError } = require('../middleware/friendlyErrors');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const { archiveCopy, releaseImage, restoreCopy } = require('../storage/storage');
const { getEffectiveTier, getTier } = require('../middleware/tiers');

// POST /api/campaigns/:campaignId/archives
// Save an image off to the campaign archive. Open to ANY member: you can
// archive any image you can see. The image BYTES are copied into the
// protected archives/ R2 key so a later regen/re-extract can never lose it.
router.post('/', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();

    // Tier gate: cap archived images per campaign by the archiving member's
    // EFFECTIVE tier (max of their own tier and the campaign SM's). Block the
    // create with a friendly message if it would push past the cap.
    try {
      const effName = await getEffectiveTier(req.session.userId, req.params.campaignId);
      const effTier = getTier(effName);
      const cap = effTier ? effTier.max_archives_per_campaign : null;
      if (cap !== null && cap !== undefined) {
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_archives WHERE campaign_id = ?').get(req.params.campaignId);
        if (cnt && cnt.c >= cap) {
          return res.json({ error: 'This campaign has hit its archive limit of ' + cap + ' images on the ' + effTier.name + ' tier. Remove an archived image to make room, or upgrade for more.' });
        }
      }
    } catch (capErr) {
      console.error('archive cap check error:', capErr.message);
      // On an internal cap-check failure, allow the archive rather than block
      // the user on an error that isn't their fault.
    }

    const imageType = req.body && req.body.image_type;

    if (imageType === 'moment') {
      const moment = await db.prepare(
        'SELECT m.id, m.title, m.prompt, m.image, m.session_id, m.fork_id, m.style, m.img_w, m.img_h, m.shape, s.campaign_id ' +
        'FROM moments m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
      ).get(req.body.moment_id);
      if (!moment) return res.status(404).json({ error: 'Moment not found' });
      if (String(moment.campaign_id) !== String(req.params.campaignId)) {
        return res.status(403).json({ error: 'That moment is not in this campaign' });
      }
      if (!moment.image) return res.json({ error: 'This panel has no image to archive yet.' });

      const artStyle = moment.style || null;
      // Stamp the resolved display name for a custom style so the archive label
      // is identical for every viewer and survives later rename/delete/lapse.
      // Trusted server-side lookup by id only (no owner constraint) — this is a
      // read for labeling, not a use grant.
      let artStyleName = null;
      if (artStyle && /^custom:/i.test(artStyle)) {
        const _csId = parseInt(String(artStyle).slice(7), 10);
        if (_csId) {
          try {
            const _cs = await db.prepare('SELECT name FROM custom_art_styles WHERE id = ?').get(_csId);
            if (_cs && _cs.name) artStyleName = _cs.name;
          } catch (e) { console.error('archive style-name resolve error:', e.message); }
        }
      }
      const archivedUrl = await archiveCopy(moment.image);
      const now = new Date().toISOString();
      const result = await db.prepare(
        'INSERT INTO campaign_archives (campaign_id, session_id, fork_id, moment_id, image_type, title, image_url, source_url, image_prompt, art_style, art_style_name, img_w, img_h, shape, archived_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.campaignId, moment.session_id, moment.fork_id, moment.id, 'moment',
            moment.title || null, archivedUrl, moment.image, moment.prompt || null, artStyle, artStyleName, moment.img_w || null, moment.img_h || null, moment.shape || null, req.session.userId, now);
      const row = await db.prepare('SELECT * FROM campaign_archives WHERE id = ?').get(result.lastInsertRowid);
      return res.json({ success: true, archive: row });
    }

    if (imageType === 'character') {
      const characterId = req.body.character_id;
      const forkId = req.body.fork_id || null;
      const sessionId = req.body.session_id || null;
      const ch = await db.prepare(
        'SELECT id, name, campaign_id, canonical_reference_url, canonical_prompt FROM characters WHERE id = ?'
      ).get(characterId);
      if (!ch) return res.status(404).json({ error: 'Character not found' });
      if (String(ch.campaign_id) !== String(req.params.campaignId)) {
        return res.status(403).json({ error: 'That character is not in this campaign' });
      }
      let sourceUrl, prompt;
      if (forkId) {
        const sc = await db.prepare(
          'SELECT reference_url, prompt FROM session_characters WHERE fork_id = ? AND character_id = ?'
        ).get(forkId, characterId);
        // Mirror the panel's display fallback: snapshot reference, else canonical.
        sourceUrl = (sc && sc.reference_url) ? sc.reference_url : ch.canonical_reference_url;
        prompt = (sc && sc.prompt) ? sc.prompt : ch.canonical_prompt;
        if (!sourceUrl) return res.json({ error: 'This character has no reference image to archive yet.' });
      } else {
        if (!ch.canonical_reference_url) return res.json({ error: 'This character has no reference image to archive yet.' });
        sourceUrl = ch.canonical_reference_url; prompt = ch.canonical_prompt;
      }
      const archivedUrl = await archiveCopy(sourceUrl);
      const now = new Date().toISOString();
      const result = await db.prepare(
        'INSERT INTO campaign_archives (campaign_id, session_id, fork_id, character_id, image_type, title, image_url, source_url, image_prompt, archived_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.campaignId, sessionId, forkId, characterId, 'character',
            ch.name || null, archivedUrl, sourceUrl, prompt || null, req.session.userId, now);
      const row = await db.prepare('SELECT * FROM campaign_archives WHERE id = ?').get(result.lastInsertRowid);
      return res.json({ success: true, archive: row });
    }


    return res.status(400).json({ error: 'Unsupported image type' });
  } catch (e) {
    console.error('archive create error:', e.message);
    res.json({ error: 'Could not archive the image. Please try again.' });
  }
});

// DELETE /api/campaigns/:campaignId/archives
// Un-archive: removes ONLY the caller's OWN archive entries for a moment
// (archived_by must equal the current user), so a member can never delete
// someone else's archive from a panel. Story-Master-level removal of any
// member's entry lives on the Archives screen.
router.delete('/', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const imageType = req.body && req.body.image_type;

    if (imageType === 'moment') {
      const moment = await db.prepare(
        'SELECT m.id, m.image, s.campaign_id FROM moments m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
      ).get(req.body.moment_id);
      if (!moment) return res.status(404).json({ error: 'Moment not found' });
      if (String(moment.campaign_id) !== String(req.params.campaignId)) {
        return res.status(403).json({ error: 'That moment is not in this campaign' });
      }

      // Per-image: only remove MY archive of the image currently on the panel.
      const mine = await db.prepare(
        'SELECT id, image_url FROM campaign_archives WHERE moment_id = ? AND archived_by = ? AND source_url IS NOT DISTINCT FROM ?'
      ).all(req.body.moment_id, req.session.userId, moment.image);
      if (!mine || mine.length === 0) return res.json({ success: true, removed: 0 });

      for (const a of mine) {
        await db.prepare('DELETE FROM campaign_archives WHERE id = ?').run(a.id);
      }
      // Free each archived copy AFTER its row is gone, so the refcount sees zero refs.
      for (const a of mine) {
        try { await releaseImage(db, a.image_url); }
        catch (e) { console.error('release archive copy:', e.message); }
      }
      return res.json({ success: true, removed: mine.length });
    }


    if (imageType === 'character') {
      const characterId = req.body.character_id;
      const forkId = req.body.fork_id || null;
      // Resolve the image currently shown (snapshot reference, else canonical)
      // so we only remove MY archive of that exact image.
      const ch = await db.prepare('SELECT canonical_reference_url FROM characters WHERE id = ?').get(characterId);
      let curUrl = ch ? ch.canonical_reference_url : null;
      if (forkId) {
        const sc = await db.prepare('SELECT reference_url FROM session_characters WHERE fork_id = ? AND character_id = ?').get(forkId, characterId);
        curUrl = (sc && sc.reference_url) ? sc.reference_url : (ch ? ch.canonical_reference_url : null);
      }
      const mine = await db.prepare(
        'SELECT id, image_url FROM campaign_archives WHERE character_id = ? AND archived_by = ? AND fork_id IS NOT DISTINCT FROM ? AND source_url IS NOT DISTINCT FROM ?'
      ).all(characterId, req.session.userId, forkId, curUrl);
      if (!mine || mine.length === 0) return res.json({ success: true, removed: 0 });
      for (const a of mine) {
        await db.prepare('DELETE FROM campaign_archives WHERE id = ?').run(a.id);
      }
      for (const a of mine) {
        try { await releaseImage(db, a.image_url); }
        catch (e) { console.error('release archive copy:', e.message); }
      }
      return res.json({ success: true, removed: mine.length });
    }

    return res.status(400).json({ error: 'Unsupported image type' });
  } catch (e) {
    console.error('archive delete error:', e.message);
    res.json({ error: 'Could not remove the archive. Please try again.' });
  }
});

// GET /api/campaigns/:campaignId/archives — list every archived image in the
// campaign (any member can view). Joins owner/session/character for display.
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT a.*, u.name AS archived_by_name, s.name AS session_title, ch.name AS character_name, ' +
      'sf.role AS fork_role, fu.name AS fork_owner_name, ' +
      'm.title AS moment_title, m.panel_order AS moment_panel_order ' +
      'FROM campaign_archives a ' +
      'LEFT JOIN users u ON u.id = a.archived_by ' +
      'LEFT JOIN sessions s ON s.id = a.session_id ' +
      'LEFT JOIN characters ch ON ch.id = a.character_id ' +
      'LEFT JOIN session_forks sf ON sf.id = a.fork_id ' +
      'LEFT JOIN users fu ON fu.id = sf.user_id ' +
      'LEFT JOIN moments m ON m.id = a.moment_id ' +
      'WHERE a.campaign_id = ? ORDER BY a.created_at DESC, a.id DESC'
    ).all(req.params.campaignId);
    res.json(rows);
  } catch (e) {
    console.error('archive list error:', e.message);
    res.json([]);
  }
});

// DELETE /api/campaigns/:campaignId/archives/:archiveId — remove ONE archive
// entry by id. Allowed if you archived it (archived_by) OR you are the Story
// Master. Releases the R2 copy via the refcount after the row is gone.
router.delete('/:archiveId', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare('SELECT id, campaign_id, image_url, archived_by FROM campaign_archives WHERE id = ?').get(req.params.archiveId);
    if (!row) return res.json({ success: true, removed: 0 });
    if (String(row.campaign_id) !== String(req.params.campaignId)) {
      return res.status(403).json({ error: 'Not in this campaign' });
    }
    const isOwner = String(row.archived_by) === String(req.session.userId);
    const isDm = req.campaignRole === 'dm';
    if (!isOwner && !isDm) {
      return res.status(403).json({ error: 'Only the person who archived this (or the Story Master) can remove it.' });
    }
    await db.prepare('DELETE FROM campaign_archives WHERE id = ?').run(row.id);
    try { await releaseImage(db, row.image_url); }
    catch (e) { console.error('release archive copy:', e.message); }
    res.json({ success: true, removed: 1 });
  } catch (e) {
    console.error('archive delete-by-id error:', e.message);
    res.json({ error: 'Could not remove the archive. Please try again.' });
  }
});

// PUT /api/campaigns/:campaignId/archives/:archiveId/public
// Owner (archived_by) or Story Master flips an archived image into / out of
// the anonymous Public Library. Body: { public: true|false }.
router.put('/:archiveId/public', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const wantPublic = !!req.body.public;
    const row = await db.prepare('SELECT id, campaign_id, archived_by FROM campaign_archives WHERE id = ?').get(req.params.archiveId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (String(row.campaign_id) !== String(req.params.campaignId)) return res.status(403).json({ error: 'Not in this campaign' });
    const isOwner = String(row.archived_by) === String(req.session.userId);
    const isDm = req.campaignRole === 'dm';
    if (!isOwner && !isDm) return res.status(403).json({ error: 'Only the person who archived this (or the Story Master) can change this.' });
    await db.prepare('UPDATE campaign_archives SET public = ? WHERE id = ?').run(wantPublic, row.id);
    res.json({ success: true, public: wantPublic });
  } catch (e) {
    console.error('archive public-toggle error:', e.message);
    res.status(500).json({ error: 'Could not update. Please try again.' });
  }
});

// POST /api/campaigns/:campaignId/archives/:archiveId/apply
// Replace a target image (a moment panel, or a session-character snapshot)
// with the chosen archived image. The archive's protected bytes are copied
// into a FRESH live object; the target repoints to it and the old image is
// released by refcount. The archive entry itself is left untouched.
router.post('/:archiveId/apply', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const archive = await db.prepare(
      'SELECT * FROM campaign_archives WHERE id = ? AND campaign_id = ?'
    ).get(req.params.archiveId, req.params.campaignId);
    if (!archive || !archive.image_url) return res.json({ error: 'Archived image not found.' });
    const targetType = req.body && req.body.target_type;
    const now = new Date().toISOString();

    if (targetType === 'moment') {
      const moment = await db.prepare(
        'SELECT m.id, m.image, m.locked, sf.user_id AS fork_owner ' +
        'FROM moments m JOIN session_forks sf ON sf.id = m.fork_id ' +
        'JOIN sessions s ON s.id = m.session_id ' +
        'WHERE m.id = ? AND s.campaign_id = ?'
      ).get(req.body.target_moment_id, req.params.campaignId);
      if (!moment) return res.json({ error: 'The target panel no longer exists.' });
      if (String(moment.fork_owner) !== String(req.session.userId))
        return res.status(403).json({ error: 'You can only replace images on your own version.' });
      if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to replace the image.' });
      const freshUrl = await restoreCopy(archive.image_url);
      const prevImg = moment.image;
      await db.prepare('UPDATE moments SET image = ?, style = ?, img_w = ?, img_h = ?, shape = COALESCE(?, shape), edited_at = ?, edited_by = ? WHERE id = ?')
        .run(freshUrl, archive.art_style || null, archive.img_w || null, archive.img_h || null, archive.shape || null, now, req.session.userId, moment.id);
      if (prevImg && prevImg !== freshUrl) await releaseImage(db, prevImg);
      return res.json({ success: true, image_url: freshUrl });
    }

    if (targetType === 'character') {
      let forkId = req.body.fork_id;
      if (!forkId) forkId = await getDmForkId(db, req.body.session_id);
      const sc = await db.prepare(
        'SELECT sc.id, sc.reference_url, sf.user_id AS fork_owner ' +
        'FROM session_characters sc JOIN session_forks sf ON sf.id = sc.fork_id ' +
        'WHERE sc.fork_id = ? AND sc.character_id = ?'
      ).get(forkId, req.body.target_character_id);
      if (!sc) return res.json({ error: 'The target character image no longer exists.' });
      if (String(sc.fork_owner) !== String(req.session.userId))
        return res.status(403).json({ error: 'You can only replace images on your own version.' });
      const freshUrl = await restoreCopy(archive.image_url);
      const prevRef = sc.reference_url;
      await db.prepare('UPDATE session_characters SET reference_url = ?, edited_at = ? WHERE id = ?')
        .run(freshUrl, now, sc.id);
      if (prevRef && prevRef !== freshUrl) await releaseImage(db, prevRef);
      return res.json({ success: true, image_url: freshUrl });
    }

    if (targetType === 'canonical_character') {
      const ch = await db.prepare(
        'SELECT id, canonical_reference_url, owner_user_id FROM characters WHERE id = ? AND campaign_id = ?'
      ).get(req.body.target_character_id, req.params.campaignId);
      if (!ch) return res.json({ error: 'The target character no longer exists.' });
      const isOwner = String(ch.owner_user_id) === String(req.session.userId);
      if (req.campaignRole !== 'dm' && !isOwner)
        return res.status(403).json({ error: 'Only the DM or the character owner can replace its reference image.' });
      const freshUrl = await restoreCopy(archive.image_url);
      const prevRef = ch.canonical_reference_url;
      await db.prepare('UPDATE characters SET canonical_reference_url = ?, edited_at = ?, edited_by = ? WHERE id = ?')
        .run(freshUrl, now, req.session.userId, ch.id);
      if (prevRef && prevRef !== freshUrl) await releaseImage(db, prevRef);
      return res.json({ success: true, image_url: freshUrl });
    }


    if (targetType === 'asset') {
      const asset = await db.prepare(
        'SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?'
      ).get(req.body.target_asset_id, req.params.campaignId);
      if (!asset) return res.json({ error: 'The target asset no longer exists.' });
      // Same gate as verifyCampaignAssetCreator: DM, or a member when the
      // campaign allows members to add/edit assets.
      if (req.campaignRole !== 'dm') {
        const camp = await db.prepare('SELECT allow_member_assets FROM campaigns WHERE id = ?').get(req.params.campaignId);
        const allowMembers = camp && (camp.allow_member_assets === true || camp.allow_member_assets === 1 || camp.allow_member_assets === 't' || camp.allow_member_assets === 'true');
        if (!allowMembers) return res.status(403).json({ error: 'The Story Master has not enabled members to add assets in this campaign.' });
      }
      const freshUrl = await restoreCopy(archive.image_url);
      const prevImg = asset.image_url;
      const priorRevert = asset.revert_image_url;
      await db.prepare('UPDATE campaign_assets SET image_url = ?, revert_image_url = ?, edited_at = ?, edited_by = ? WHERE id = ?')
        .run(freshUrl, (prevImg && prevImg !== freshUrl) ? prevImg : null, now, req.session.userId, asset.id);
      if (priorRevert && priorRevert !== prevImg && priorRevert !== freshUrl) await releaseImage(db, priorRevert);
      return res.json({ success: true, image_url: freshUrl });
    }

    return res.json({ error: 'Unknown replace target.' });
  } catch (e) {
    console.error('archive apply error:', e.message);
    res.json({ error: friendlyError(e, 'Could not replace the image. Please try again.') });
  }
});

module.exports = router;
