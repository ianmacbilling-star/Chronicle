'use strict';

// ============================================================
// ORDER COVERS -- v3.0.989, TD-901 follow-on. Ian, 2026-09-23: "Can you some how put the covers on
// the Orders like you did on the bookshelf... you have the cover PDF right there. But we only want
// the right half of it. Maybe a thumbnail?"
// ============================================================
//   GET /api/order-covers/:orderId -> the FRONT of that order's print cover, as a small JPEG
//
// WHAT IS DRAWN. Every order keeps the exact cover PDF that went to the printer: one wide page,
// back cover | spine | front cover. The front is the right-hand panel. Its width is the book's trim
// width plus the outside bleed, and the only trim sold is 8.5 x 11 (services/printing/catalog.js),
// so the front is 8.625 in wide against a page 11.25 in tall -- a ratio this reads off the page's
// own height, which also keeps a hardcover's wider wrap margins inside the picture rather than
// guessing them. Ghostscript (already on the server for the flatten) draws only that panel, by
// shifting the page left and cutting the canvas to the front's width.
//
// NOTHING ABOUT ORDERS CHANGES. This is its own file on its own path, it only READS print_orders
// (id, owner, cover url), and the picture it keeps goes in its own small table, order_cover_thumbs,
// never a column on print_orders. Drawn the first time the card is shown, then reused. Anything
// that goes wrong answers 404 and the card simply shows no picture, exactly as before.
//
// WHO SEES WHAT. Only the order's owner: an order that is not yours answers 404.
// ============================================================

const express = require('express');
const router = express.Router();

var FRONT_RATIO = 8.625 / 11.25;   // (trim width + outside bleed) / (trim height + 2 x bleed), 8.5 x 11 trim

// Where the front panel starts and how wide it is, in PDF points, from the page's own size.
function frontPanel(w, h) {
  w = Number(w) || 0; h = Number(h) || 0;
  if (!(w > 0 && h > 0)) return null;
  var fw = Math.min(w, Math.round(h * FRONT_RATIO));
  return { width: fw, height: Math.round(h), offset: Math.max(0, Math.round(w - fw)) };
}

function makeHandlers(d) {
  // d: { getDb, fetchFile, uploadFile, deleteFile, pageSize, renderRegion, now, log }
  var jobs = {};
  async function cover(req, res) {
    try {
      var uid = req.session.userId;
      var id = parseInt(req.params.orderId, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ error: 'Order not found' });
      var db = await d.getDb();
      var row = await db.prepare('SELECT id, user_id, cover_pdf_url FROM print_orders WHERE id = ?').get(id);
      if (!row || String(row.user_id) !== String(uid) || !row.cover_pdf_url) return res.status(404).json({ error: 'Order not found' });
      var img = null, old = null;
      var t = await db.prepare('SELECT thumb_url FROM order_cover_thumbs WHERE order_id = ?').get(id);
      if (t && t.thumb_url) { old = t.thumb_url; try { img = await d.fetchFile(t.thumb_url); } catch (e) { img = null; } }
      if (!img || !img.length) {
        var key = String(id);
        if (!jobs[key]) {
          jobs[key] = (async function () {
            var pdf = await d.fetchFile(row.cover_pdf_url);
            if (!pdf || !pdf.length) throw new Error('the cover file could not be read back');
            var size = await d.pageSize(pdf);
            var fp = frontPanel(size && size.width, size && size.height);
            if (!fp) throw new Error('the cover page has no size');
            var jpg = await d.renderRegion(pdf, fp);
            if (!jpg || !jpg.length) throw new Error('nothing was drawn');
            var url = await d.uploadFile(jpg, 'order-' + id + '-front-' + d.now() + '.jpg', 'image/jpeg', 'optimized');
            await db.prepare('DELETE FROM order_cover_thumbs WHERE order_id = ?').run(id);
            await db.prepare('INSERT INTO order_cover_thumbs (order_id, user_id, thumb_url) VALUES (?, ?, ?)').run(id, uid, url);
            if (old && old !== url) { try { await d.deleteFile(old); } catch (e) {} }
            return jpg;
          })().then(function (v) { delete jobs[key]; return v; }, function (e) { delete jobs[key]; throw e; });
        }
        img = await jobs[key];
      }
      res.set('Content-Type', 'image/jpeg');
      res.set('Content-Length', String(img.length));
      res.set('Cache-Control', 'private, max-age=86400');
      return res.send(img);
    } catch (e) {
      d.log('cover', e);
      return res.status(404).json({ error: 'The cover could not be drawn.' });
    }
  }
  return { cover: cover };
}

// Page 1's size in points, by pdf-lib (already used by routes/pdf.js).
async function pdfPageSize(buf) {
  var lib = require('pdf-lib');
  var doc = await lib.PDFDocument.load(buf, { ignoreEncryption: true });
  var p = doc.getPage(0);
  var s = p.getSize();
  return { width: s.width, height: s.height };
}

// One region of page 1 as a JPEG: the canvas is cut to the region's size and the page shifted left
// by its offset. 40 dpi: the front comes out about 345 x 450, plenty for a card thumbnail.
function renderRegionJpeg(buf, fp) {
  var fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
  return new Promise(function (resolve, reject) {
    var dir = null;
    function done(err, v) { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (x) {} if (err) reject(err); else resolve(v); }
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-cover-'));
      fs.writeFileSync(path.join(dir, 'in.pdf'), buf);
    } catch (e) { return done(e); }
    var out = path.join(dir, 'front.jpg');
    cp.execFile(process.env.GHOSTSCRIPT_PATH || 'gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=jpeg', '-dJPEGQ=85', '-r40',
      '-dFirstPage=1', '-dLastPage=1', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
      '-dDEVICEWIDTHPOINTS=' + fp.width, '-dDEVICEHEIGHTPOINTS=' + fp.height, '-dFIXEDMEDIA',
      '-sOutputFile=' + out, '-c', '<</PageOffset [' + (-fp.offset) + ' 0]>> setpagedevice', '-f', path.join(dir, 'in.pdf')],
      { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, function (err) {
        if (err) return done(err);
        try { done(null, fs.readFileSync(out)); } catch (e) { done(e); }
      });
  });
}

var _h = null;
function H() {
  if (_h) return _h;
  var db = require('../database/db');
  var storage = require('../storage/storage');
  _h = makeHandlers({
    getDb: db.getDb, fetchFile: storage.fetchFile, uploadFile: storage.uploadFile, deleteFile: storage.deleteFile,
    pageSize: pdfPageSize, renderRegion: renderRegionJpeg,
    now: function () { return Date.now(); },
    log: function (where, e) { try { console.error('[order-covers] ' + where + ' failed: ' + ((e && e.message) || e)); } catch (x) {} }
  });
  return _h;
}

const { requireAuth } = require('../middleware/auth');
router.get('/:orderId', requireAuth, function (req, res) { return H().cover(req, res); });

module.exports = router;
module.exports.makeHandlers = makeHandlers;
module.exports.frontPanel = frontPanel;
module.exports.pdfPageSize = pdfPageSize;
module.exports.renderRegionJpeg = renderRegionJpeg;
