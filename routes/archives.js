const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignMember } = require('../middleware/auth');
const { archiveCopy } = require('../storage/storage');

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

    return res.status(400).json({ error: 'Unsupported image type' });
  } catch (e) {
    console.error('archive create error:', e.message);
    res.json({ error: 'Could not archive the image. Please try again.' });
  }
});

module.exports = router;
