const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const { archiveCopy, releaseImage } = require('../storage/storage');

// POST /api/campaigns/:campaignId/archives
// Save an image off to the campaign archive. Open to ANY member: you can
// archive any image you can see. The image BYTES are copied into the
// protected archives/ R2 key so a later regen/re-extract can never lose it.
router.post('/', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const imageType = req.body && req.body.image_type;

    if (imageType === 'moment') {
      const moment = await db.prepare(
        'SELECT m.id, m.title, m.prompt, m.image, m.session_id, m.fork_id, s.campaign_id ' +
        'FROM moments m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
      ).get(req.body.moment_id);
      if (!moment) return res.status(404).json({ error: 'Moment not found' });
      if (String(moment.campaign_id) !== String(req.params.campaignId)) {
        return res.status(403).json({ error: 'That moment is not in this campaign' });
      }
      if (!moment.image) return res.json({ error: 'This panel has no image to archive yet.' });

      const archivedUrl = await archiveCopy(moment.image);
      const now = new Date().toISOString();
      const result = await db.prepare(
        'INSERT INTO campaign_archives (campaign_id, session_id, fork_id, moment_id, image_type, title, image_url, source_url, image_prompt, archived_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.campaignId, moment.session_id, moment.fork_id, moment.id, 'moment',
            moment.title || null, archivedUrl, moment.image, moment.prompt || null, req.session.userId, now);
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

module.exports = router;
