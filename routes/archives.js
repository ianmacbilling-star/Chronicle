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
        'INSERT INTO campaign_archives (campaign_id, session_id, fork_id, moment_id, image_type, title, image_url, image_prompt, archived_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.campaignId, moment.session_id, moment.fork_id, moment.id, 'moment',
            moment.title || null, archivedUrl, moment.prompt || null, req.session.userId, now);
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
        if (!sc || !sc.reference_url) return res.json({ error: 'This character has no reference image to archive yet.' });
        sourceUrl = sc.reference_url; prompt = sc.prompt;
      } else {
        if (!ch.canonical_reference_url) return res.json({ error: 'This character has no reference image to archive yet.' });
        sourceUrl = ch.canonical_reference_url; prompt = ch.canonical_prompt;
      }
      const archivedUrl = await archiveCopy(sourceUrl);
      const now = new Date().toISOString();
      const result = await db.prepare(
        'INSERT INTO campaign_archives (campaign_id, session_id, fork_id, character_id, image_type, title, image_url, image_prompt, archived_by, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.campaignId, sessionId, forkId, characterId, 'character',
            ch.name || null, archivedUrl, prompt || null, req.session.userId, now);
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
        'SELECT m.id, s.campaign_id FROM moments m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?'
      ).get(req.body.moment_id);
      if (!moment) return res.status(404).json({ error: 'Moment not found' });
      if (String(moment.campaign_id) !== String(req.params.campaignId)) {
        return res.status(403).json({ error: 'That moment is not in this campaign' });
      }

      const mine = await db.prepare(
        'SELECT id, image_url FROM campaign_archives WHERE moment_id = ? AND archived_by = ?'
      ).all(req.body.moment_id, req.session.userId);
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
      const mine = await db.prepare(
        'SELECT id, image_url FROM campaign_archives WHERE character_id = ? AND archived_by = ? AND fork_id IS NOT DISTINCT FROM ?'
      ).all(characterId, req.session.userId, forkId);
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

module.exports = router;
