'use strict';

// ============================================================
// BOOKSHELF -- TD-901. Spec: claude/BOOKSHELF_SPEC.md.
//   v3.0.981 (release 2): save, list, remove, view.
//   v3.0.982 (release 3): Bring back, and Library pointers.
// ============================================================
// Ian, 2026-09-23: "Right now there is no place to save off their books without ordering them or
// publishing them to the library." A Gold or Platinum member keeps a finished, optimized book on a
// shelf: the PDF AND the layout memory behind it (the approved body, moves and grows), so a book
// brought back can still be edited.
//
//   GET    /api/bookshelf                     -> { limit, used, tierName, books }  (your own books only)
//   POST   /api/bookshelf/save                -> shelve the version's saved optimized book (book query as
//                                                for /api/pdf/last-optimized-file, body { campaignId })
//   POST   /api/bookshelf/:id/restore         -> Bring back: make this the version's saved book again.
//                                                body { shelveFirst } or { replace } -- see restore()
//   POST   /api/bookshelf/library             -> body { storyId, token }: a pointer to a Library story
//   GET    /api/bookshelf/library-status/:id  -> may I add this Library story, and is it already there
//   GET    /api/bookshelf/library-status?ids= -> the same for a page of Library cards (v3.0.983)
//   DELETE /api/bookshelf/:id                 -> remove one of your own books, and its files
//   GET    /api/bookshelf/:id/pdf             -> the shelf PDF from our own origin; ?download=1
//
// THE STORAGE TRAP (spec section 3). save-optimized DELETES the previous saved book's pdfUrl and
// bodyUrl when a version is optimized again. So a shelf book never shares a file with a version's
// saved book, IN EITHER DIRECTION: saving copies both objects into the shelf, bringing back copies
// the shelf's objects into NEW ones for the version, and removing deletes only the shelf's own.
// Everything lives under the existing 'optimized/' prefix, so storage.keyFromUrl needs no new entry
// (the TD-469 drift trap).
//
// WHOSE VERSION. v3.0.984 -- Ian, 2026-09-23: "Even if you can't publish I think we let you save to
// your bookshelf." Optimizing someone else's version already saves the book under YOUR prefs row for
// that version (chooser = you, fork = the owner), never over theirs, so shelving it copies your own
// file. Save and Bring back therefore need only campaign membership (and, for a player, the Story
// Master's novel switch) -- not ownership. Ownership still decides one thing: whether Bring back may
// change the version's layout type (see restore()).
//
// WHO SEES WHAT. Every query here is WHERE user_id = the session user. Nobody sees, opens, brings
// back or removes another member's shelf, and an id that is not yours answers 404, not 403, so a
// guess cannot tell a real id from a missing one.
//
// NOTHING HERE TOUCHES THE ORDER, PRINT, PUBLISH OR BILLING ROUTES. Bring back writes the version's
// lastOptimized entry exactly as save-optimized does, and from then on ordering and publishing run
// through the paths that exist today, unchanged.
//
// The limit is the member's OWN plan (a live pass counts at the pass's tier, which is what ownTier
// answers), not the campaign's effective tier: the shelf belongs to the person, not the campaign.
// Gold 10, Platinum 50; Copper, Silver and the Free Trial 0. Library pointers do not count. Over the
// limit after a downgrade nothing is deleted -- view, download, bring back and remove still work;
// only adding is refused (Ian, 2026-09-23).
// ============================================================

const express = require('express');
const router = express.Router();

// The same filename rule as /api/pdf/last-optimized-file's download (v3.0.893).
function shelfDownloadName(title) {
  var nm = String(title || '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim().slice(0, 80);
  return nm || 'campaignia-book';
}

function layoutName(a) { return a === 'paired' ? 'Picture Book' : (a === 'magazine' ? 'Magazine' : String(a || 'other')); }

function isTruthyFlag(v) { return v === true || v === 1 || v === 't' || v === 'true'; }

// v3.0.982 -- the co string a book was optimized under, as the layout_opts blob the Layout panel
// stores ({ opts, active }). Used by Bring back ONLY when the version is set to a different layout
// (arrange) from the book's -- see restore().
// Numbers stay numbers (the toggles are 1/0 in customOpts); unknown keys are harmless -- the
// client's clMerge copies only the keys it knows.
function coToLayoutOpts(co) {
  var opts = {};
  String(co || '').split(',').forEach(function (pair) {
    var i = pair.indexOf(':');
    if (i <= 0) return;
    var k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(k)) return;
    opts[k] = /^-?\d+$/.test(v) ? Number(v) : v;
  });
  return Object.keys(opts).length ? JSON.stringify({ opts: opts, active: true }) : null;
}

// The Library link for a story: the token link when there is one (v3.0.829 -- it keeps working
// if the story is later made link-only), the id link otherwise.
function storyLink(st) {
  var slug = (st && st.slug) ? String(st.slug) : 'story';
  if (st && st.share_token) return '/library/story/s/' + st.share_token + '/' + slug;
  return '/library/story/' + (st && st.id) + '/' + slug;
}

function makeHandlers(d) {
  // d: { getDb, bookPrefsScope, getForkBookPrefs, setForkBookPrefs, ownsBookVersion, coverFromPrefs, getTier, ownTier,
  //      copyObject, deleteFile, fetchFile, parseCustomOpts, now, log }
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
      storyUrl: r.story_url || '', gone: !!r._gone
    };
  }
  function refuse(status, body) { return { ok: false, status: status, body: body }; }

  // May this person shelve or bring back a book of this campaign? A member who can open the book.
  // v3.0.984 -- no longer requires owning the version (Ian); `own` is reported for restore().
  // Answers { campaign, sc, own } or a refusal.
  async function bookAccess(db, uid, campaignId, scopeReq) {
    var campaign = await db.prepare(
      'SELECT c.id, c.name, c.cover_image_url, c.campaign_image_url, c.allow_player_novel_access, cm.role AS my_role FROM campaigns c JOIN campaign_members cm ON cm.campaign_id = c.id WHERE c.id = ? AND cm.user_id = ?'
    ).get(campaignId, uid);
    if (!campaign) return refuse(404, { code: 'not_found', error: 'That campaign could not be found, or you are no longer in it.' });
    if (campaign.my_role !== 'dm' && !isTruthyFlag(campaign.allow_player_novel_access)) {
      return refuse(403, { code: 'novel_not_enabled', error: 'The Story Master has not enabled the graphic novel for players in this campaign.' });
    }
    var sc = await d.bookPrefsScope(db, scopeReq, campaignId);
    // The saved book is read from, and brought back to, the (chooser, fork) row. chooser is always
    // the session user; anything else would be someone else's row, which is never touched.
    if (String(sc.chooser) !== String(uid)) return refuse(403, { code: 'not_your_book', error: 'That saved book is not yours.' });
    var owns = false;
    try { owns = String(sc.fork) === String(uid) && await d.ownsBookVersion(db, uid, sc.bookVersionId); } catch (e) { owns = false; }
    return { ok: true, campaign: campaign, sc: sc, own: owns };
  }
  async function findShelved(db, uid, campaignId, prefsVid, arrange, at) {
    return await db.prepare(
      "SELECT id FROM bookshelf_books WHERE user_id = ? AND kind = 'book' AND campaign_id = ? AND COALESCE(prefs_version_id, 0) = ? AND arrange = ? AND saved_at = ?"
    ).get(uid, campaignId, Number(prefsVid) || 0, arrange, String(at || ''));
  }
  // Put one lastOptimized entry on the shelf, as COPIES. Used by Save, and by Bring back's
  // "shelve it first". A failure after a copy removes what was copied, so it leaves nothing.
  async function shelveEntry(db, uid, t, campaign, sc, arrange, lo) {
    if (lo.flattened === false) return refuse(409, { code: 'quick_save', error: 'This book is still being saved. Try again when the save has finished.' });
    var dup = await findShelved(db, uid, campaign.id, sc.versionId, arrange, lo.at);
    if (dup) return refuse(409, { code: 'already_shelved', id: dup.id, error: 'This book is already on your Bookshelf.' });
    var used = await countBooks(db, uid);
    if (used >= t.limit) {
      return refuse(403, { code: 'bookshelf_full', limit: t.limit, used: used,
        error: 'Your Bookshelf is full (' + used + ' of ' + t.limit + '). Remove a book to make room.' });
    }
    var vLabel = '';
    if (sc.bookVersionId) {
      try {
        var vr = await db.prepare('SELECT name FROM campaign_versions WHERE id = ?').get(sc.bookVersionId);
        vLabel = (vr && vr.name) ? String(vr.name) : '';
      } catch (e) { vLabel = ''; }
    }
    var made = [];
    try {
      var base = 'shelf-u' + uid + '-c' + campaign.id + '-' + d.now();
      var pdfUrl = await d.copyObject(lo.pdfUrl, base + '.pdf', 'optimized');
      made.push(pdfUrl);
      var bodyUrl = null;
      if (lo.bodyUrl) {
        bodyUrl = await d.copyObject(lo.bodyUrl, base + '-layout.json.gz', 'optimized');
        made.push(bodyUrl);
      }
      // v3.0.984 -- THE VERSION'S OWN FRONT COVER, not the campaign picture (Ian: two versions with
      // different covers showed the same one). Read the way the book reads it -- inherit on -- and
      // through the one rule for "no cover chosen" (db.coverFromPrefs).
      var coverUrl = campaign.cover_image_url || campaign.campaign_image_url || '';
      try {
        var bp = await d.getForkBookPrefs(db, sc.chooser, sc.fork, campaign.id, { inherit: true, versionId: sc.versionId });
        coverUrl = d.coverFromPrefs(bp, campaign.cover_image_url || campaign.campaign_image_url || '') || '';
      } catch (e) { /* keep the campaign picture */ }
      var ins = await db.prepare(
        'INSERT INTO bookshelf_books (user_id, kind, campaign_id, campaign_name, version_id, prefs_version_id, version_label, arrange, layout, co, inc, book_title, cover_url, pdf_url, body_url, pages, front_covers, back_covers, saved_at) ' +
        "VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(uid, campaign.id, campaign.name || '', sc.bookVersionId || null, Number(sc.versionId) || 0, vLabel,
        arrange, lo.layout || '', lo.co || '', (lo.inc == null ? null : String(lo.inc)), lo.bookTitle || campaign.name || '',
        coverUrl, pdfUrl, bodyUrl, Number(lo.pages) || 0,
        (lo.frontCovers == null ? null : Number(lo.frontCovers)), (lo.backCovers == null ? null : Number(lo.backCovers)), String(lo.at || ''));
      made = [];
      return { ok: true, id: ins && ins.lastInsertRowid, used: used + 1, limit: t.limit };
    } catch (e) {
      for (var i = 0; i < made.length; i++) { try { await d.deleteFile(made[i]); } catch (e2) {} }
      throw e;
    }
  }

  async function list(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      var rows = await db.prepare('SELECT * FROM bookshelf_books WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(uid);
      // v3.0.982 -- a pointer whose story has left the Library says so rather than opening a 404.
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].kind !== 'library') continue;
        try {
          var st = await db.prepare('SELECT id FROM public_stories WHERE id = ? AND public = TRUE').get(rows[i].public_story_id || 0);
          rows[i]._gone = !st;
        } catch (e) { rows[i]._gone = false; }
      }
      var used = rows.filter(function (r) { return r.kind === 'book'; }).length;
      return res.json({ limit: t.limit, used: used, tier: t.key, tierName: t.name, books: rows.map(shape) });
    } catch (e) {
      d.log('list', e);
      return res.status(500).json({ error: 'Could not load your Bookshelf right now.' });
    }
  }

  async function save(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      if (!t.limit) {
        return res.status(403).json({ code: 'bookshelf_tier', error: 'The Bookshelf is part of Gold, which keeps 10 books, and Platinum, which keeps 50.' });
      }
      var campaignId = Number((req.body && req.body.campaignId) || 0);
      if (!campaignId) return res.status(400).json({ code: 'bad_request', error: 'Which book? No campaign was named.' });
      var acc = await bookAccess(db, uid, campaignId, req);
      if (!acc.ok) return res.status(acc.status).json(acc.body);
      var arrange = req.query.arrange || (req.query.co ? (d.parseCustomOpts(req.query.co).arrange || 'magazine') : 'magazine');
      var prefs = await d.getForkBookPrefs(db, acc.sc.chooser, acc.sc.fork, campaignId, { inherit: false, versionId: acc.sc.versionId });
      var lo = prefs && prefs.lastOptimized && prefs.lastOptimized[arrange];
      if (!lo || !lo.pdfUrl) {
        return res.status(409).json({ code: 'nothing_saved', error: 'There is no saved optimized book for this version and layout yet. Optimize and save it first.' });
      }
      var r = await shelveEntry(db, uid, t, acc.campaign, acc.sc, arrange, lo);
      if (!r.ok) return res.status(r.status).json(r.body);
      return res.json({ ok: true, id: r.id, used: r.used, limit: r.limit });
    } catch (e) {
      d.log('save', e);
      return res.status(500).json({ code: 'save_failed', error: 'The book could not be put on your Bookshelf. Nothing was saved; please try again.' });
    }
  }

  // v3.0.982 -- BRING BACK. Makes a shelf book the saved book of the version it came from, with the
  // layout settings it was made with, so it opens on the Optimize tab ready to edit, order or
  // publish. Ian, 2026-09-23: "if there is one sitting there optimized already then offer to shelve
  // it first." So when the version already holds a DIFFERENT saved book that is NOT on your shelf,
  // this answers 409 needs_shelve_first unless the body says shelveFirst (shelve it, then bring
  // back) or replace (bring back over it). Allowed on any plan and over the limit -- only
  // "shelve it first" needs room, because that one ADDS a book. The version's layout settings are
  // changed only when its layout (arrange) differs from the book's.
  async function restore(req, res) {
    var made = [];
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      var b = req.body || {};
      var row = await db.prepare("SELECT * FROM bookshelf_books WHERE id = ? AND user_id = ? AND kind = 'book'").get(Number(req.params.id) || 0, uid);
      if (!row) return res.status(404).json({ code: 'not_found', error: 'That book is not on your Bookshelf.' });
      if (!row.pdf_url) return res.status(409).json({ code: 'no_file', error: 'This book has no saved file to bring back.' });
      var campaignId = Number(row.campaign_id) || 0;
      var scopeReq = { session: req.session, query: { as_version: row.version_id ? String(row.version_id) : '' }, body: {} };
      var acc = await bookAccess(db, uid, campaignId, scopeReq);
      if (!acc.ok) {
        if (acc.body.code === 'not_found') acc.body.error = 'The campaign this book came from no longer exists, or you are no longer in it, so it cannot be brought back. You can still view and download it.';
        return res.status(acc.status).json(acc.body);
      }
      var sc = acc.sc;
      if ((Number(sc.versionId) || 0) !== (Number(row.prefs_version_id) || 0)) {
        return res.status(409).json({ code: 'version_changed', error: 'The version this book came from is not there any more, so it cannot be brought back. You can still view and download it.' });
      }
      var arrange = row.arrange || 'magazine';
      // THE LAYOUT SETTINGS ARE LEFT ALONE UNLESS THEY HAVE TO MOVE. Ian, 2026-09-23: "If we need
      // to load the layout settings then do so... but if we don't, load the book without touching
      // the existing layout settings" -- the Optimize tab's own "settings don't match" message
      // then says what differs. They HAVE to move only when the version's layout (arrange) is not
      // the book's: saved books are kept per layout, so Load Last Optimized File would look under
      // the other one and find nothing. Read the way the Layout panel reads them (my-book-meta:
      // inherit on); nothing saved means the panel's default, Picture Book.
      var nowArr = 'paired';
      try {
        var _lp = await d.getForkBookPrefs(db, sc.chooser, sc.fork, campaignId, { inherit: true, versionId: sc.versionId });
        var _lo = (_lp && _lp.layout_opts) ? (typeof _lp.layout_opts === 'string' ? JSON.parse(_lp.layout_opts) : _lp.layout_opts) : null;
        var _lop = _lo && _lo.opts;
        if (_lop && (_lop.novel || _lop.session)) _lop = _lop.novel || _lop.session;   // the legacy two-slot shape
        if (_lop && _lop.arrange) nowArr = String(_lop.arrange);
      } catch (e) { nowArr = 'paired'; }
      // v3.0.984 -- SOMEONE ELSE'S VERSION: its layout settings are the owner's, and nobody else may
      // change them. So if the owner has switched the layout type since, the book cannot be put
      // back there -- said plainly, before anything is copied. It stays on the shelf to view,
      // download or order. (Ian: "not sure I love that if it changes you can't load it" -- a
      // candidate for the next round.)
      if (nowArr !== arrange && !acc.own) {
        return res.status(409).json({ code: 'layout_differs',
          error: 'This book was made as a ' + layoutName(arrange) + ' book, and the owner of that version has since switched it to ' + layoutName(nowArr) +
            '. Only they can change it back, so it cannot be brought back there. You can still view and download it from your Bookshelf.' });
      }
      var prefs = await d.getForkBookPrefs(db, sc.chooser, sc.fork, campaignId, { inherit: false, versionId: sc.versionId });
      var lastOpt = (prefs && prefs.lastOptimized && typeof prefs.lastOptimized === 'object') ? Object.assign({}, prefs.lastOptimized) : {};
      var cur = lastOpt[arrange];
      if (cur && cur.pdfUrl && String(cur.at || '') !== String(row.saved_at || '')) {
        var already = await findShelved(db, uid, campaignId, sc.versionId, arrange, cur.at);
        if (!already) {
          if (b.shelveFirst === true) {
            if (!t.limit) return res.status(403).json({ code: 'bookshelf_tier', error: 'Your plan cannot add books to the Bookshelf, so the book there now cannot be shelved first. Replace it, or cancel.' });
            var sh = await shelveEntry(db, uid, t, acc.campaign, sc, arrange, cur);
            if (!sh.ok) {
              if (sh.body.code === 'bookshelf_full') sh.body.error = 'Your Bookshelf is full, so the book there now cannot be shelved first. Remove a book, or choose Replace it.';
              return res.status(sh.status).json(Object.assign({ during: 'shelve_first' }, sh.body));
            }
          } else if (b.replace !== true) {
            return res.status(409).json({ code: 'needs_shelve_first', needsShelveFirst: true, currentAt: cur.at || null, currentPages: Number(cur.pages) || 0,
              error: 'This version already has an optimized book that is not on your Bookshelf. Bringing this one back replaces it.' });
          }
        }
      }
      var stamp = d.now();
      var pdfUrl = await d.copyObject(row.pdf_url, 'optimized-' + campaignId + '-u' + uid + '-' + stamp + '.pdf', 'optimized');
      made.push(pdfUrl);
      var bodyUrl = null;
      if (row.body_url) {
        bodyUrl = await d.copyObject(row.body_url, 'approved-' + campaignId + '-' + arrange + '-' + stamp + '.json.gz', 'optimized');
        made.push(bodyUrl);
      }
      var prev = lastOpt[arrange] || null;
      // The same shape save-optimized writes. `at` is the date the book was OPTIMIZED, not now: it
      // is the same book, and keeping the date is also what lets Save to Bookshelf and this route
      // recognise it as the one already on the shelf.
      lastOpt[arrange] = { pdfUrl: pdfUrl, at: row.saved_at || new Date(stamp).toISOString(), pages: Number(row.pages) || 0,
        bookTitle: row.book_title || '', bodyUrl: bodyUrl, co: row.co || '', layout: row.layout || '',
        frontCovers: (row.front_covers == null ? null : Number(row.front_covers)), backCovers: (row.back_covers == null ? null : Number(row.back_covers)),
        inc: (row.inc == null ? null : row.inc), flattened: true, fromShelf: row.id };
      var patch = { lastOptimized: lastOpt };
      // Only your own version reaches here with a different layout type (see above).
      var lay = (nowArr !== arrange && acc.own) ? coToLayoutOpts(row.co) : null;
      if (lay) patch.layout_opts = lay;
      await d.setForkBookPrefs(db, sc.chooser, sc.fork, campaignId, patch, sc.versionId);
      made = [];
      // The version's previous files go, best effort, exactly as save-optimized cleans up. They are
      // the version's own objects, never a shelf's: the shelf only ever holds copies.
      try { if (prev && prev.pdfUrl && prev.pdfUrl !== pdfUrl) await d.deleteFile(prev.pdfUrl); } catch (e) {}
      try { if (prev && prev.bodyUrl && prev.bodyUrl !== bodyUrl) await d.deleteFile(prev.bodyUrl); } catch (e) {}
      return res.json({ ok: true, campaignId: campaignId, versionId: row.version_id || null, arrange: arrange,
        layoutRestored: !!lay, editable: !!bodyUrl });
    } catch (e) {
      for (var i = 0; i < made.length; i++) { try { await d.deleteFile(made[i]); } catch (e2) {} }
      d.log('restore', e);
      return res.status(500).json({ code: 'restore_failed', error: 'The book could not be brought back. Nothing was changed; please try again.' });
    }
  }

  // v3.0.982 -- LIBRARY POINTERS. Ian: "if they aren't your books they are only pointers to the
  // public library page", and they do not count toward the limit. A link-only story can be added
  // only by someone holding its link (the token), which is the same rule the page itself keeps.
  async function libraryStory(db, storyId, token) {
    var st = await db.prepare('SELECT id, user_id, title, author_name, cover_url, slug, share_token, visibility FROM public_stories WHERE id = ? AND public = TRUE').get(Number(storyId) || 0);
    if (!st) return null;
    if (st.visibility !== 'public' && !(token && st.share_token && String(token) === String(st.share_token))) return null;
    return st;
  }
  async function addLibrary(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      if (!t.limit) return res.status(403).json({ code: 'bookshelf_tier', error: 'The Bookshelf is part of Gold and Platinum.' });
      var b = req.body || {};
      var st = await libraryStory(db, b.storyId, b.token);
      if (!st) return res.status(404).json({ code: 'not_found', error: 'That story is not in the Library.' });
      if (String(st.user_id) === String(uid)) return res.status(409).json({ code: 'own_story', error: 'This is your own story. It is on the Published Stories tab of My Stuff.' });
      var dup = await db.prepare("SELECT id FROM bookshelf_books WHERE user_id = ? AND kind = 'library' AND public_story_id = ?").get(uid, st.id);
      if (dup) return res.status(409).json({ code: 'already_shelved', id: dup.id, error: 'This story is already on your Bookshelf.' });
      var ins = await db.prepare(
        "INSERT INTO bookshelf_books (user_id, kind, campaign_name, book_title, cover_url, public_story_id, story_url) VALUES (?, 'library', ?, ?, ?, ?, ?)"
      ).run(uid, st.author_name || '', st.title || '', st.cover_url || '', st.id, storyLink(st));
      return res.json({ ok: true, id: ins && ins.lastInsertRowid });
    } catch (e) {
      d.log('library', e);
      return res.status(500).json({ error: 'Could not add the story to your Bookshelf right now.' });
    }
  }
  async function libraryStatus(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      var st = await libraryStory(db, req.params.storyId, req.query.t);
      if (!st) return res.json({ found: false });
      var dup = await db.prepare("SELECT id FROM bookshelf_books WHERE user_id = ? AND kind = 'library' AND public_story_id = ?").get(uid, st.id);
      return res.json({ found: true, own: String(st.user_id) === String(uid), onShelf: !!dup, canAdd: t.limit > 0 });
    } catch (e) {
      d.log('library-status', e);
      return res.json({ found: false });
    }
  }

  // v3.0.983 -- the same question for a page of Library cards at once: ?ids=1,2,3 (at most 60).
  // Only browsable stories are answered -- the grid lists nothing else -- and a story that is not
  // in the Library is simply absent from items.
  async function libraryStatusMany(req, res) {
    try {
      var uid = req.session.userId;
      var db = await d.getDb();
      var t = tierOf(req);
      var ids = String(req.query.ids || '').split(',').map(function (x) { return Number(x); })
        .filter(function (n, i, a) { return Number.isInteger(n) && n > 0 && a.indexOf(n) === i; }).slice(0, 60);
      var items = {};
      if (!t.limit || !ids.length) return res.json({ canAdd: t.limit > 0, items: items });
      var marks = ids.map(function () { return '?'; }).join(', ');
      var stories = await db.prepare("SELECT id, user_id FROM public_stories WHERE public = TRUE AND visibility = 'public' AND id IN (" + marks + ')').all(ids);
      var mine = await db.prepare("SELECT public_story_id FROM bookshelf_books WHERE user_id = ? AND kind = 'library' AND public_story_id IN (" + marks + ')').all([uid].concat(ids));
      var on = {};
      mine.forEach(function (m) { on[String(m.public_story_id)] = true; });
      stories.forEach(function (st) { items[String(st.id)] = { own: String(st.user_id) === String(uid), onShelf: !!on[String(st.id)] }; });
      return res.json({ canAdd: true, items: items });
    } catch (e) {
      d.log('library-status-many', e);
      return res.json({ canAdd: false, items: {} });
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

  return { list: list, save: save, restore: restore, addLibrary: addLibrary, libraryStatus: libraryStatus, libraryStatusMany: libraryStatusMany, remove: remove, pdf: pdf, tierOf: tierOf };
}

var _h = null;
function H() {
  if (_h) return _h;
  var db = require('../database/db');
  var tiers = require('../middleware/tiers');
  var storage = require('../storage/storage');
  _h = makeHandlers({
    getDb: db.getDb, bookPrefsScope: db.bookPrefsScope, getForkBookPrefs: db.getForkBookPrefs, setForkBookPrefs: db.setForkBookPrefs,
    ownsBookVersion: db.ownsBookVersion, coverFromPrefs: db.coverFromPrefs, getTier: tiers.getTier, ownTier: tiers.ownTier,
    copyObject: storage.copyObject, deleteFile: storage.deleteFile, fetchFile: storage.fetchFile,
    // Loaded late: pdf.js is the one parser of the co string, and a second copy would drift.
    parseCustomOpts: function (s) { return require('./pdf').parseCustomOpts(s); },
    now: function () { return Date.now(); },
    log: function (where, e) { try { console.error('[bookshelf] ' + where + ' failed: ' + ((e && e.message) || e)); } catch (x) {} }
  });
  return _h;
}

const { requireAuth } = require('../middleware/auth');
// The two named paths come before '/:id/...' so an id can never be read as 'library'.
router.get('/', requireAuth, function (req, res) { return H().list(req, res); });
router.post('/save', requireAuth, function (req, res) { return H().save(req, res); });
router.post('/library', requireAuth, function (req, res) { return H().addLibrary(req, res); });
router.get('/library-status', requireAuth, function (req, res) { return H().libraryStatusMany(req, res); });   // v3.0.983
router.get('/library-status/:storyId', requireAuth, function (req, res) { return H().libraryStatus(req, res); });
router.post('/:id/restore', requireAuth, function (req, res) { return H().restore(req, res); });
router.delete('/:id', requireAuth, function (req, res) { return H().remove(req, res); });
router.get('/:id/pdf', requireAuth, function (req, res) { return H().pdf(req, res); });

module.exports = router;
module.exports.makeHandlers = makeHandlers;
module.exports.shelfDownloadName = shelfDownloadName;
module.exports.coToLayoutOpts = coToLayoutOpts;
