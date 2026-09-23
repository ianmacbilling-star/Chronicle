'use strict';

// ============================================================
// BOOKSHELF -- v3.0.981, TD-901 release 2 of 3. Spec: claude/BOOKSHELF_SPEC.md.
// ============================================================
// Ian, 2026-09-23: "Right now there is no place to save off their books without ordering them or
// publishing them to the library." A Gold or Platinum member can now keep a finished, optimized book
// on a shelf: the PDF AND the layout memory behind it (the approved body, moves and grows), so a
// book brought back in release 3 can still be edited.
//
//   GET    /api/bookshelf            -> { limit, used, tierName, books }  (this member's own books only)
//   POST   /api/bookshelf/save       -> shelve the version's saved optimized book (book query as for
//                                       /api/pdf/last-optimized-file, body { campaignId })
//   DELETE /api/bookshelf/:id        -> remove one of your own books, and its files
//   GET    /api/bookshelf/:id/pdf    -> the shelf PDF from our own origin; ?download=1 to download
//
// THE STORAGE TRAP (spec section 3). save-optimized DELETES the previous saved book's pdfUrl and
// bodyUrl when a version is optimized again. So a shelf book never shares a file with a version's
// saved book: saving COPIES both objects, and removing deletes only the shelf's own copies. Shelf
// objects live under the existing 'optimized/' prefix, so storage.keyFromUrl needs no new entry
// (the TD-469 drift trap).
//
// WHO SEES WHAT. Every query here is WHERE user_id = the session user. Nobody sees, opens or
// removes another member's shelf, and an id that is not yours answers 404, not 403, so a guess
// cannot tell a real id from a missing one.
//
// NOTHING HERE TOUCHES THE ORDER, PRINT, PUBLISH OR BILLING ROUTES. Save only reads the version's
// saved book; it never writes a prefs row.
//
// The limit is the member's OWN plan (a live pass counts at the pass's tier, which is what ownTier
// answers), not the campaign's effective tier: the shelf belongs to the person, not the campaign.
// Gold 10, Platinum 50; Copper, Silver and the Free Trial 0. Over the limit after a downgrade,
// nothing is deleted -- view, download and remove still work; only saving is refused.
// ============================================================

const express = require('express');
const router = express.Router();

// The same filename rule as /api/pdf/last-optimized-file's download (v3.0.893).
function shelfDownloadName(title) {
  var nm = String(title || '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().slice(0, 80);
  return nm || 'campaignia-book';
}

function isTruthyFlag(v) { return v === true || v === 1 || v === 't' || v === 'true'; }

function makeHandlers(d) {
  // d: { getDb, bookPrefsScope, getForkBookPrefs, ownsBookVersion, getTier, ownTier, copyObject,
  //      deleteFile, fetchFile, parseCustomOpts, now, log }
  function tierOf(req) {
    var name = (req.user) ? d.ownTier(req.user) : 'copper';
    var t = d.getTier(name) || {};
    var lim = Number(t.bookshelf_limit);
    return { key: name, name: t.name || name, limit: (Number.isFinite(lim) && lim > 0) ? Math.floor(lim) : 0 };
  }
  async function countBooks(db, uid) {
    var r = await db.prepare("SELECT COUNT(*) AS n FROM bookshelf_books WHERE user_id = ? AND kind = 'book'").get(uid);
    return Number(r && r.n) || 0;
  }
  function shape(r) {
    return {
      id: r.id, kind: r.kind, campaignId: r.campaign_id, campaignName: r.campaign_name || '',
      versionId: r.version_id, versionLabel: r.version_label || '', arrange: r.arrange || '', layout: r.layout || '',
      bookTitle: r.book_title || '', coverUrl: r.cover_url || '', pages: Number(r.pages) || 0,
      savedAt: r.saved_at || null, createdAt: r.created_at || null, editable: !!r.body_url,
      storyUrl: r.story_url || ''
    };
  }

  async function list(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      var rows = await db.prepare('SELECT * FROM bookshelf_books WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(uid);
      var used = rows.filter(function (r) { return r.kind === 'book'; }).length;
      return res.json({ limit: t.limit, used: used, tier: t.key, tierName: t.name, books: rows.map(shape) });
    } catch (e) {
      d.log('list', e);
      return res.status(500).json({ error: 'Could not load your Bookshelf right now.' });
    }
  }

  async function save(req, res) {
    var made = [];
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      if (!t.limit) {
        return res.status(403).json({ code: 'bookshelf_tier', error: 'The Bookshelf is part of Gold, which keeps 10 books, and Platinum, which keeps 50.' });
      }
      var campaignId = Number((req.body && req.body.campaignId) || 0);
      if (!campaignId) return res.status(400).json({ code: 'bad_request', error: 'Which book? No campaign was named.' });
      var campaign = await db.prepare(
        'SELECT c.id, c.name, c.cover_image_url, c.campaign_image_url, c.allow_player_novel_access, cm.role AS my_role FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id WHERE c.id = ? AND cm.user_id = ?'
      ).get(campaignId, uid);
      if (!campaign) return res.status(404).json({ code: 'not_found', error: 'That campaign could not be found.' });
      if (campaign.my_role !== 'dm' && !isTruthyFlag(campaign.allow_player_novel_access)) {
        return res.status(403).json({ code: 'not_your_version', error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
      }
      // THE SAME QUESTION AS novelOwnView: may this person publish the version on screen? The scope
      // must be their own prefs row (fork) AND a version they own. Someone else's version is theirs
      // to shelve, not yours.
      var sc = await d.bookPrefsScope(db, req, campaignId);
      var owns = false;
      try { owns = String(sc.fork) === String(uid) && await d.ownsBookVersion(db, uid, sc.bookVersionId); } catch (e) { owns = false; }
      if (!owns) {
        return res.status(403).json({ code: 'not_your_version', error: 'This version is not yours, so it cannot go on your Bookshelf. Switch to your own version first.' });
      }
      var arrange = req.query.arrange || (req.query.co ? (d.parseCustomOpts(req.query.co).arrange || 'magazine') : 'magazine');
      var prefs = await d.getForkBookPrefs(db, sc.chooser, sc.fork, campaignId, { inherit: false, versionId: sc.versionId });
      var lo = prefs && prefs.lastOptimized && prefs.lastOptimized[arrange];
      if (!lo || !lo.pdfUrl) {
        return res.status(409).json({ code: 'nothing_saved', error: 'There is no saved optimized book for this version and layout yet. Optimize and save it first.' });
      }
      // A protective quick save is overwritten seconds later; only the real save is a book.
      if (lo.flattened === false) {
        return res.status(409).json({ code: 'quick_save', error: 'This book is still being saved. Try again when the save has finished.' });
      }
      var dup = await db.prepare(
        "SELECT id FROM bookshelf_books WHERE user_id = ? AND kind = 'book' AND campaign_id = ? AND COALESCE(prefs_version_id, 0) = ? AND arrange = ? AND saved_at = ?"
      ).get(uid, campaignId, Number(sc.versionId) || 0, arrange, String(lo.at || ''));
      if (dup) return res.status(409).json({ code: 'already_shelved', id: dup.id, error: 'This book is already on your Bookshelf.' });
      var used = await countBooks(db, uid);
      if (used >= t.limit) {
        return res.status(403).json({ code: 'bookshelf_full', limit: t.limit, used: used,
          error: 'Your Bookshelf is full (' + used + ' of ' + t.limit + '). Remove a book to make room.' });
      }
      var vLabel = '';
      if (sc.bookVersionId) {
        try {
          var vr = await db.prepare('SELECT name FROM campaign_versions WHERE id = ?').get(sc.bookVersionId);
          vLabel = (vr && vr.name) ? String(vr.name) : '';
        } catch (e) { vLabel = ''; }
      }
      // COPIES, never references (section 3 of the spec). The PDF first; if the layout copy then
      // fails the PDF copy is removed, so a failed save leaves nothing behind.
      var stamp = d.now();
      var base = 'shelf-u' + uid + '-c' + campaignId + '-' + stamp;
      var pdfUrl = await d.copyObject(lo.pdfUrl, base + '.pdf', 'optimized');
      made.push(pdfUrl);
      var bodyUrl = null;
      if (lo.bodyUrl) {
        bodyUrl = await d.copyObject(lo.bodyUrl, base + '-layout.json.gz', 'optimized');
        made.push(bodyUrl);
      }
      var ins = await db.prepare(
        'INSERT INTO bookshelf_books (user_id, kind, campaign_id, campaign_name, version_id, prefs_version_id, version_label, arrange, layout, co, inc, book_title, cover_url, pdf_url, body_url, pages, front_covers, back_covers, saved_at) ' +
        "VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(uid, campaignId, campaign.name || '', sc.bookVersionId || null, Number(sc.versionId) || 0, vLabel,
        arrange, lo.layout || '', lo.co || '', (lo.inc == null ? null : String(lo.inc)), lo.bookTitle || campaign.name || '',
        campaign.cover_image_url || campaign.campaign_image_url || '', pdfUrl, bodyUrl, Number(lo.pages) || 0,
        (lo.frontCovers == null ? null : Number(lo.frontCovers)), (lo.backCovers == null ? null : Number(lo.backCovers)), String(lo.at || ''));
      made = [];
      return res.json({ ok: true, id: ins && ins.lastInsertRowid, used: used + 1, limit: t.limit });
    } catch (e) {
      for (var i = 0; i < made.length; i++) { try { await d.deleteFile(made[i]); } catch (e2) {} }
      d.log('save', e);
      return res.status(500).json({ code: 'save_failed', error: 'The book could not be put on your Bookshelf. Nothing was saved; please try again.' });
    }
  }

  async function remove(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var row = await db.prepare('SELECT * FROM bookshelf_books WHERE id = ? AND user_id = ?').get(Number(req.params.id) || 0, uid);
      if (!row) return res.status(404).json({ error: 'That book is not on your Bookshelf.' });
      await db.prepare('DELETE FROM bookshelf_books WHERE id = ? AND user_id = ?').run(row.id, uid);
      // The row goes first: a file left behind costs storage, a row left pointing at a deleted file
      // costs a broken book.
      if (row.kind === 'book') {
        try { if (row.pdf_url) await d.deleteFile(row.pdf_url); } catch (e) {}
        try { if (row.body_url) await d.deleteFile(row.body_url); } catch (e) {}
      }
      return res.json({ ok: true });
    } catch (e) {
      d.log('remove', e);
      return res.status(500).json({ error: 'Could not remove the book right now.' });
    }
  }

  async function pdf(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var row = await db.prepare("SELECT * FROM bookshelf_books WHERE id = ? AND user_id = ? AND kind = 'book'").get(Number(req.params.id) || 0, uid);
      if (!row || !row.pdf_url) return res.status(404).json({ error: 'That book is not on your Bookshelf.' });
      var buf = await d.fetchFile(row.pdf_url);
      if (!buf || !buf.length) return res.status(502).json({ error: 'The book could not be read back from storage.' });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Length', String(buf.length));
      res.set('Cache-Control', 'private, max-age=60');
      if (req.query.download) res.set('Content-Disposition', 'attachment; filename="' + shelfDownloadName(row.book_title || row.campaign_name) + '.pdf"');
      return res.send(buf);
    } catch (e) {
      d.log('pdf', e);
      return res.status(500).json({ error: 'Could not open the book right now.' });
    }
  }

  return { list: list, save: save, remove: remove, pdf: pdf, tierOf: tierOf };
}

var _h = null;
function H() {
  if (_h) return _h;
  var db = require('../database/db');
  var tiers = require('../middleware/tiers');
  var storage = require('../storage/storage');
  _h = makeHandlers({
    getDb: db.getDb, bookPrefsScope: db.bookPrefsScope, getForkBookPrefs: db.getForkBookPrefs, ownsBookVersion: db.ownsBookVersion,
    getTier: tiers.getTier, ownTier: tiers.ownTier,
    copyObject: storage.copyObject, deleteFile: storage.deleteFile, fetchFile: storage.fetchFile,
    // Loaded late: pdf.js is the one parser of the co string, and a second copy would drift.
    parseCustomOpts: function (s) { return require('./pdf').parseCustomOpts(s); },
    now: function () { return Date.now(); },
    log: function (where, e) { try { console.error('[bookshelf] ' + where + ' failed: ' + ((e && e.message) || e)); } catch (x) {} }
  });
  return _h;
}

const { requireAuth } = require('../middleware/auth');
router.get('/', requireAuth, function (req, res) { return H().list(req, res); });
router.post('/save', requireAuth, function (req, res) { return H().save(req, res); });
router.delete('/:id', requireAuth, function (req, res) { return H().remove(req, res); });
router.get('/:id/pdf', requireAuth, function (req, res) { return H().pdf(req, res); });

module.exports = router;
module.exports.makeHandlers = makeHandlers;
module.exports.shelfDownloadName = shelfDownloadName;
