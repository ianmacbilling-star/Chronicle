const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork, getViewableForkId } = require('../database/db');
const { releaseImage } = require('../storage/storage');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');

// v3.0.507 -- ONE definition of the title cap, shared with routes/extract.js. A title typed by
// hand must obey the same rule a generated one does, or the cap is decorative. Kept byte-identical
// to the extractor's copy on purpose; the build asserts the two match.
function capTitleForShape(title, shape) {
  var t = String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
  if (!t) return t;
  var narrow = (shape === 'tower' || shape === 'tall');
  var maxChars = narrow ? 36 : 64;
  if (t.length <= maxChars) return t;
  var cut = t.slice(0, maxChars);
  var sp = cut.lastIndexOf(' ');
  if (sp > Math.floor(maxChars * 0.5)) cut = cut.slice(0, sp);   // whole words, unless the first word is itself huge
  return cut.replace(/[\s,;:.\-]+$/, '');
}

router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const viewForkId = await getViewableForkId(db, req.params.sessionId, req.session.userId, req.query.fork_id);
  if (!viewForkId) return res.status(403).json({ error: 'Fork not viewable' });
  const moments = await db.prepare(
    'SELECT m.*, EXISTS(SELECT 1 FROM campaign_archives ca WHERE ca.moment_id = m.id AND ca.source_url = m.image AND ca.archived_by = ?) AS archived ' +
    'FROM moments m WHERE m.fork_id=? ORDER BY m.panel_order ASC'
  ).all(req.session.userId, viewForkId);
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
  const prev = await db.prepare('SELECT image, kind, revert_image FROM moments WHERE id=? AND session_id=?').get(req.params.momentId, req.params.sessionId);
  if (prev && prev.kind === 'establishing') return res.status(403).json({ error: 'The title image cannot be deleted. Regenerate it from the storyboard instead.' });
  await db.prepare('DELETE FROM moments WHERE id=? AND session_id=?').run(req.params.momentId, req.params.sessionId);
  if (prev && prev.image) await releaseImage(db, prev.image);
  if (prev && prev.revert_image) await releaseImage(db, prev.revert_image);
  res.json({ success: true });
});

// PUT - edit a moment's prompt. DM may edit canonical (Platinum-gated);
// a player may edit prompts freely on their OWN version (tokens are the
// meter for forks, not tier).
router.put('/:momentId', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.id, m.locked, m.shape, sf.user_id AS fork_owner FROM moments m JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ? AND m.session_id = ?'
  ).get(req.params.momentId, req.params.sessionId);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const ownsThisFork = String(moment.fork_owner) === String(req.session.userId);
  if (!ownsThisFork) return res.status(403).json({ error: 'You can only edit your own version' });
  const { prompt, description, title } = req.body;
  const hasPrompt = typeof prompt === 'string';
  const hasDesc = typeof description === 'string';
  const hasTitle = typeof title === 'string';
  // v3.0.507 -- A LOCK PROTECTS THE PICTURE, NOT ITS CAPTION.
  // Ian, 2026-08-07: "A locked panel SHOULD allow an edit." The lock exists so a picture the user
  // is happy with cannot be regenerated out from under them -- its own message says "Unlock it to
  // edit the prompt". A title drives the CAPTION and never reaches image generation, so refusing a
  // title edit on a locked panel would protect nothing, and would block the one correction most
  // likely to be wanted on a panel that is otherwise finished.
  // The prompt and description remain locked exactly as before.
  if (moment.locked && (hasPrompt || hasDesc)) {
    return res.status(403).json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to edit the prompt.' });
  }
  if (!hasPrompt && !hasDesc && !hasTitle) return res.json({ error: 'Prompt, description or title required' });

  const now = new Date().toISOString();
  const sets = [], vals = [];
  if (hasPrompt) { sets.push('prompt = ?'); vals.push(prompt); }
  if (hasDesc) { sets.push('description = ?'); vals.push(description); }
  // v3.0.507 -- the same shape-aware cap the extractor applies, so a hand-typed title cannot do
  // what a generated one is prevented from doing. The moment's OWN shape decides the limit.
  if (hasTitle) { sets.push('title = ?'); vals.push(capTitleForShape(title, moment.shape)); }
  sets.push('edited_at = ?'); vals.push(now);
  sets.push('edited_by = ?'); vals.push(req.session.userId);
  vals.push(req.params.momentId, req.params.sessionId);
  await db.prepare('UPDATE moments SET ' + sets.join(', ') + ' WHERE id = ? AND session_id = ?').run(...vals);

  const updatedMoment = await db.prepare('SELECT * FROM moments WHERE id = ?').get(req.params.momentId);
  res.json({ success: true, moment: updatedMoment });
});

// PUT lock toggle — mark/unmark a storyboard moment as locked on the
// caller's OWN version. A locked moment is skipped by generate-all and
// blocks Generate Story (re-extract) for that fork. Owner-only, no tier gate.
router.put('/:momentId/lock', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.id, m.locked, sf.user_id AS fork_owner FROM moments m JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ? AND m.session_id = ?'
  ).get(req.params.momentId, req.params.sessionId);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const ownsThisFork = String(moment.fork_owner) === String(req.session.userId);
  if (!ownsThisFork) return res.status(403).json({ error: 'You can only lock moments on your own version' });
  const locked = req.body.locked ? 1 : 0;
  const now = new Date().toISOString();
  await db.prepare('UPDATE moments SET locked = ?, edited_at = ?, edited_by = ? WHERE id = ? AND session_id = ?')
    .run(locked, now, req.session.userId, req.params.momentId, req.params.sessionId);
  res.json({ success: true, locked: locked });
});

// PUT prominence -- set how much visual weight (1-5) a moment gets in the
// comic layout. Stored in layout_meta JSON (merged, so focal etc. survive).
// Owner-only on the caller's OWN version; read by lmProminence at PDF time.
router.put('/:momentId/prominence', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.id, m.layout_meta, sf.user_id AS fork_owner FROM moments m JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ? AND m.session_id = ?'
  ).get(req.params.momentId, req.params.sessionId);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  if (String(moment.fork_owner) !== String(req.session.userId)) {
    return res.status(403).json({ error: 'You can only edit your own version' });
  }
  var p = parseInt(req.body && req.body.prominence, 10);
  if (!(p >= 1 && p <= 5)) return res.status(400).json({ error: 'Prominence must be 1 to 5' });
  var meta = {};
  try { if (moment.layout_meta) meta = (typeof moment.layout_meta === 'string') ? JSON.parse(moment.layout_meta) : moment.layout_meta; } catch (e) { meta = {}; }
  if (!meta || typeof meta !== 'object') meta = {};
  meta.prominence = p;
  var metaStr = JSON.stringify(meta);
  const now = new Date().toISOString();
  await db.prepare('UPDATE moments SET layout_meta = ?, edited_at = ?, edited_by = ? WHERE id = ? AND session_id = ?')
    .run(metaStr, now, req.session.userId, req.params.momentId, req.params.sessionId);
  res.json({ success: true, prominence: p, layout_meta: metaStr });
});

module.exports = router;
