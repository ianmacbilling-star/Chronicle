const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getOrCreateDmFork, getViewableForkId } = require('../database/db');
const { releaseImage } = require('../storage/storage');
const { requireAuth, verifyCampaignDM, verifyCampaignMember } = require('../middleware/auth');
// v3.1.15 -- TD-910: upload your own picture onto a panel.
const multer = require('multer');
const sharp = require('sharp');
const { uploadFile } = require('../storage/storage');
const { imageFileFilter, guardUpload } = require('../middleware/uploadGuard');
const { demoteBuiltTitle } = require('../services/titleTarget');

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

// =================================================================================================
// v3.1.15 -- TD-910. PUT YOUR OWN PICTURE ON A PANEL. Spec: claude/OWN_ART_UPLOAD_SPEC.md.
//
// Ian, 2026-09-25: "giving the user the ability to replace the image panels on the storyboard with
// their own images... If you are an artist campaignia can write the story and you can provide the
// art... or if you are a writer campaignia can make the art and you can write the story."
//
// HIS RULES, AS BUILT:
//   - The picture is cropped to whichever of our seven panel shapes it already fits best (or the
//     one the reader picked), and the PANEL TAKES THAT SHAPE -- the art is not bent to the panel.
//   - The reader slides the crop in the modal; `offset` (0 to 1) is where the crop sits along the
//     axis that has room. The server recomputes the crop itself from the real pixel size, so the
//     page cannot ask for a rectangle the picture does not have.
//   - Only the CROPPED size is recorded (img_w / img_h, which already exist). No new columns.
//   - Small pictures are WARNED, never refused: "we flatten the book before we print and we tell
//     them to approve it."
//   - The panel is LOCKED straight away, so Generate Images and Generate Story leave it alone. To
//     retouch it the reader unlocks, retouches and locks again -- "it's on them."
//   - Any tier, no token: no model is called.
//
// THE RESULT LOOKS EXACTLY LIKE A GENERATED PICTURE TO EVERYTHING DOWNSTREAM: a JPEG in the same
// store, at the same aspect ratio the image model uses for that shape, with img_w/img_h filled in.
// Nothing in the layout, the PDF or the print path has to know where it came from.
//
// REVERT WORKS, SHAPE INCLUDED. The picture it displaced goes into the one-deep undo slot as every
// other replace does, and because this can change the panel's SHAPE, the previous shape is recorded
// beside it (layout_meta.prev_shape, tied to that exact image) so Revert puts both back.
// =================================================================================================
const ownUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');
// The ratios the image model is asked for per shape (routes/images.js shapeAspectRatio), so an
// uploaded picture is indistinguishable from a generated one of the same shape.
const OWN_SHAPES = { panoramic: 21 / 9, wide: 16 / 9, standard: 4 / 3, square: 1, fullpage: 3 / 4, tall: 2 / 3, tower: 1 / 4 };
const OWN_MAX_SIDE = 2048;    // bigger is kept at this size: print does not need more, and PDFs grow with pixels (TD-002)
const OWN_SMALL_SIDE = 1024;  // our own panel pictures are about this on the long side; below it, warn
const OWN_MIN_SIDE = 128;     // v3.1.16 -- smallest crop the zoom allows, long side (matches RP_MIN_SIDE in app.js)

function nearestOwnShape(w, h) {
  var a = Math.log(w / h), best = 'standard', bestD = Infinity;
  Object.keys(OWN_SHAPES).forEach(function (k) {
    var d = Math.abs(Math.log(OWN_SHAPES[k]) - a);
    if (d < bestD - 1e-9) { bestD = d; best = k; }
  });
  return best;
}
// The largest rectangle of the shape's ratio inside W x H, slid along the free axis by offset.
// v3.1.16 -- TD-910. ZOOM. The page's crop frame arrives as FRACTIONS of the picture (left, top,
// width) and is turned into pixels HERE by the same arithmetic the page uses to draw it
// (_rpRectFromFrac in app.js; the guard proves they agree). The shape's ratio is enforced, the frame
// is kept inside the picture and no smaller than OWN_MIN_SIDE, whatever the page sent.
function ownRectFromFrac(W, H, shape, x, y, w) {
  var r = OWN_SHAPES[shape];
  var maxW = Math.min(W, Math.floor(H * r));
  var minW = Math.min(maxW, Math.max(1, r >= 1 ? OWN_MIN_SIDE : Math.round(OWN_MIN_SIDE * r)));
  var width = Math.max(minW, Math.min(maxW, Math.round(w * W)));
  var height = Math.max(1, Math.min(H, Math.round(width / r)));
  var left = Math.max(0, Math.min(W - width, Math.round(x * W)));
  var top = Math.max(0, Math.min(H - height, Math.round(y * H)));
  return { left: left, top: top, width: width, height: height };
}
function ownCropRect(W, H, shape, offset) {
  var r = OWN_SHAPES[shape], o = Math.min(1, Math.max(0, offset));
  if (W / H > r) {
    var cw = Math.max(1, Math.min(W, Math.round(H * r)));
    return { left: Math.round(o * (W - cw)), top: 0, width: cw, height: H };
  }
  var ch = Math.max(1, Math.min(H, Math.round(W / r)));
  return { left: 0, top: Math.round(o * (H - ch)), width: W, height: ch };
}

router.post('/:momentId/upload-image', requireAuth, verifyCampaignMember, guardUpload(ownUpload, 'own-image', 20), async function (req, res) {
  try {
    const db = await getDb();
    const moment = await db.prepare(
      'SELECT m.id, m.image, m.locked, m.shape, m.title, m.layout_meta, m.img_w, m.img_h, m.revert_image, sf.user_id AS fork_owner ' +
      'FROM moments m JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ? AND m.session_id = ?'
    ).get(req.params.momentId, req.params.sessionId);
    if (!moment) return res.status(404).json({ error: 'That panel no longer exists.' });
    if (String(moment.fork_owner) !== String(req.session.userId)) return res.status(403).json({ error: 'You can only replace images on your own version.' });
    if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to replace the image.' });
    if (!req.file || !req.file.buffer) return res.json({ error: 'No image received.' });

    // Oriented size: a phone photo's EXIF orientation is applied, exactly as the browser shows it.
    let meta;
    try { meta = await sharp(req.file.buffer, { failOn: 'none' }).metadata(); } catch (e) { meta = null; }
    if (!meta || !meta.width || !meta.height) return res.json({ error: 'We could not read that image. Please try a JPG, PNG, WebP or HEIC.' });
    const swap = (meta.orientation || 1) >= 5;
    const W = swap ? meta.height : meta.width, H = swap ? meta.width : meta.height;

    const wanted = String((req.body && req.body.shape) || '');
    const shape = OWN_SHAPES[wanted] ? wanted : nearestOwnShape(W, H);
    // v3.1.16 -- a zoomed frame (crop_x/crop_y/crop_w) when the page sends one; otherwise the largest
    // frame of the shape, slid by offset, exactly as in v3.1.15.
    const cx = parseFloat(req.body && req.body.crop_x), cy = parseFloat(req.body && req.body.crop_y), cw = parseFloat(req.body && req.body.crop_w);
    const off = parseFloat(req.body && req.body.offset);
    const rect = (isFinite(cx) && isFinite(cy) && isFinite(cw) && cw > 0)
      ? ownRectFromFrac(W, H, shape, cx, cy, cw)
      : ownCropRect(W, H, shape, isFinite(off) ? off : 0.5);

    let pipe = sharp(req.file.buffer, { failOn: 'none' }).rotate().extract(rect);
    if (Math.max(rect.width, rect.height) > OWN_MAX_SIDE) {
      pipe = pipe.resize(rect.width >= rect.height ? { width: OWN_MAX_SIDE } : { height: OWN_MAX_SIDE });
    }
    const out = await pipe.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const url = await uploadFile(out.data, 'own-' + moment.id + '-' + Date.now() + '.jpg', 'image/jpeg');

    // The undo slot is a pair (v3.0.655): the displaced picture, its title marker, and now its shape.
    let pm = {};
    try { pm = moment.layout_meta ? (typeof moment.layout_meta === 'object' ? moment.layout_meta : JSON.parse(moment.layout_meta)) : {}; } catch (e) { pm = {}; }
    const wasTitle = pm.built_title || null;
    if (wasTitle) demoteBuiltTitle(pm);
    if (wasTitle) pm.prev_built_title = wasTitle; else delete pm.prev_built_title;
    const prevImg = moment.image || null;
    if (prevImg) pm.prev_shape = { shape: moment.shape || 'standard', image: prevImg }; else delete pm.prev_shape;

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE moments SET image = ?, style = NULL, img_w = ?, img_h = ?, shape = ?, title = ?, layout_meta = ?, ' +
      'revert_image = ?, revert_img_w = ?, revert_img_h = ?, locked = 1, edited_at = ?, edited_by = ? WHERE id = ?'
    ).run(url, out.info.width, out.info.height, shape, (moment.title == null ? null : capTitleForShape(moment.title, shape)), JSON.stringify(pm),
      prevImg, prevImg ? (moment.img_w || null) : null, prevImg ? (moment.img_h || null) : null,
      now, req.session.userId, moment.id);
    // The picture that WAS in the undo slot is no longer referenced by this panel.
    if (moment.revert_image && moment.revert_image !== prevImg && moment.revert_image !== url) {
      try { await releaseImage(db, moment.revert_image); } catch (e) {}
    }
    console.log('[own-image] moment ' + moment.id + ': ' + W + 'x' + H + ' -> ' + shape + ' ' + out.info.width + 'x' + out.info.height);
    res.json({ success: true, image_url: url, shape: shape, img_w: out.info.width, img_h: out.info.height,
      small: Math.max(out.info.width, out.info.height) < OWN_SMALL_SIDE, locked: 1 });
  } catch (e) {
    console.error('own-image upload error:', e && e.message);
    res.json({ error: 'Could not put that image on the panel. Please try again.' });
  }
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
