'use strict';

// ============================================================
// renderPdf.js  -  HTML -> PDF via headless Chromium (Puppeteer)
// ------------------------------------------------------------
// puppeteer is require()'d lazily INSIDE the function so this module loads
// fine even before the dependency is installed; it only throws when a render
// is actually attempted. That keeps `node --check` and app boot working until
// `npm install puppeteer` + Railway build config are in place.
//
// Launch args are tuned for a containerized environment (Railway). If a system
// Chromium is provided by the build (e.g. nixpacks), set PUPPETEER_EXECUTABLE_PATH
// and it will be used instead of Puppeteer's bundled binary.
// ============================================================

// v3.0.805 -- TD-615. WHERE THE TIME ACTUALLY GOES IN A RENDER.
//
// Ian has two data points and they disagree with the obvious model: a 100-page book with almost no
// decorations rendered fine, a 60-page book with gold frames did not. Page count is clearly not the
// only factor, and nobody can say what the other one costs because nothing has ever been timed.
//
// TWO THINGS WORTH KNOWING BEFORE ANY ARCHITECTURE IS CHOSEN:
//   1. LOAD vs PAINT. `setContent` builds the document; `page.pdf` rasterises it. TD-567 found the
//      second is far the slower and that it was the call which timed out. If decorations cost in
//      PAINT, chunking helps and a bigger budget only defers. If they cost in LOAD, the fix is
//      different again. One number settles it.
//   2. THE DOCUMENT IS EXPORTED TWICE when running heads are on -- see the head-split below. On a
//      400-page book that is 800 pages of paint. TD-567 noted "a book near the limit hits it at
//      half the size it otherwise would" and nobody has ever measured what the second pass costs.
//      If it is expensive, halving it is one function rather than an architecture.
//
// COSTS NOTHING AND CHANGES NOTHING. Date.now() around work that already happens, one log line per
// render, and a small ring kept in memory so the diagnostics dump can show the last few without
// anyone having to be watching the logs at the time.
var RENDER_TIMING_KEEP = 20;
var _renderTimings = [];
function _recordRenderTiming(rec) {
  try {
    _renderTimings.push(rec);
    while (_renderTimings.length > RENDER_TIMING_KEEP) _renderTimings.shift();
    var parts = [];
    for (var k in rec.phases) parts.push(k + '=' + rec.phases[k] + 'ms');
    console.log('[render-timing] ' + (rec.label || 'render') + ' pages=' + (rec.pages != null ? rec.pages : '?') +
      ' bytes=' + (rec.bytes || 0) + ' ' + parts.join(' ') + ' TOTAL=' + rec.totalMs + 'ms' +
      (rec.doubleExport ? '  (DOUBLE EXPORT: running heads)' : ''));
  } catch (e) {}
}
// Newest first. Optionally filtered to one label, for the dump.
function recentRenderTimings(label) {
  var out = _renderTimings.slice().reverse();
  if (label) out = out.filter(function (r) { return String(r.label || '').indexOf(label) === 0; });
  return out;
}
async function renderHtmlToPdf(html, options) {
  options = options || {};
  // Ensure relative asset URLs (Campaignia logo, paper textures) resolve: Puppeteer's
  // setContent has no document base. Guarded so callers that already injected <base>
  // (the print routes) are not doubled. Preview routes rely on this.
  if (html && html.indexOf('<base ') === -1) {
    var _baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (_baseUrl) html = html.replace('<head>', '<head><base href="' + _baseUrl + '/">');
  }
  const puppeteer = require('puppeteer');

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();

    // Load the document and wait for remote panel images (R2 URLs) to settle.
    // v3.0.779 -- a 400-page book is the target, and painting one is far
    // slower than loading it. Fifteen minutes, overridable per call.
    const navTimeout = options.timeoutMs || 900000;
    // The SAME budget for painting. Loading a document and rasterising a
    // 200-page book are not comparable jobs, and the second is the slow one.
    if (typeof page.setDefaultTimeout === 'function') page.setDefaultTimeout(navTimeout);
    if (typeof page.setDefaultNavigationTimeout === 'function') page.setDefaultNavigationTimeout(navTimeout);
    var _renderStarted = Date.now();
    // v3.0.805 -- TD-615. One lap per phase. _tMark moves; _renderStarted does not, so the
    // RENDER_TIMEOUT message below still reports the true elapsed time.
    var _tMark = _renderStarted, _phases = {};
    function _lap(name) { var n = Date.now(); _phases[name] = n - _tMark; _tMark = n; }
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: navTimeout });
    _lap('load');

    // Belt-and-suspenders: make sure every <img> has finished (loaded or errored)
    // before we snapshot to PDF, so panels are never half-painted.
    await page.evaluate(function () {
      var imgs = Array.prototype.slice.call(document.images || []);
      return Promise.all(imgs.map(function (img) {
        if (img.complete) return null;
        return new Promise(function (resolve) {
          img.addEventListener('load', resolve);
          img.addEventListener('error', resolve);
        });
      }));
    });
    _lap('images');

    const pdfOpts = {
      printBackground: true,
      preferCSSPageSize: true
    };

    // NATIVE RUNNING HEAD (flow render only). Chromium repeats these templates on EVERY printed page,
    // which CSS cannot do for a document whose page breaks it does not control. The composed paths
    // (paired / magazine) draw their own session-aware head per page, so they must NOT pass this or
    // the two would double up. Header/footer render inside the page margin box; templates get no page
    // styles or web fonts, so everything is inlined with web-safe fonts.
    if (options.runningHeader) {
      var _rhCamp = String(options.runningHeader.campaign || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var _rhCss = 'font-family:Georgia,serif;font-size:7.5pt;color:#8a6a2a;letter-spacing:0.08em;' +
        'text-transform:uppercase;width:100%;padding:0 0.85in;margin:0;-webkit-print-color-adjust:exact;';
      pdfOpts.displayHeaderFooter = true;
      pdfOpts.headerTemplate =
        '<div style="' + _rhCss + 'display:flex;justify-content:space-between;align-items:flex-end;">' +
          '<span>' + _rhCamp + '</span>' +
          '<span class="pageNumber" style="letter-spacing:0;"></span>' +
        '</div>';
      // An empty footer is required: with displayHeaderFooter on and no template, Chromium prints its
      // own default footer (document URL + date).
      pdfOpts.footerTemplate = '<span></span>';
    }

    // Explicit size override. Phase 1 leaves this unset so the document's own
    // @page (8.5in x 11in trim) is used. Later phases can pass widthIn/heightIn
    // to render at the full-bleed 8.75 x 11.25 box.
    if (options.widthIn && options.heightIn) {
      pdfOpts.width = options.widthIn + 'in';
      pdfOpts.height = options.heightIn + 'in';
      pdfOpts.preferCSSPageSize = false;
    }

    // FRONT/BACK MATTER MUST NOT CARRY THE RUNNING HEAD. Chromium stamps header/footer on EVERY
    // printed page and has no 'start at page N', and zeroing the @page margin does not suppress it
    // (verified: the head still printed on the cover). So when the caller says how many pages are
    // matter, export the SAME loaded page twice -- once plain, once with the head -- and stitch:
    // matter pages come from the plain copy, interior pages from the headed one. Layout is already
    // computed, so the second export re-serialises paint only; no reload, no image refetch. Both
    // exports are the full document, so Chromium's page numbering stays physical and correct
    // (pageRanges would have renumbered the interior from 1).
    var _skipHead = Math.max(0, (options.runningHeader && options.runningHeader.skipPages) || 0);
    var _skipTail = Math.max(0, (options.runningHeader && options.runningHeader.skipLastPages) || 0);
    if (pdfOpts.displayHeaderFooter && (_skipHead > 0 || _skipTail > 0)) {
      try {
        var plainOpts = Object.assign({}, pdfOpts);
        delete plainOpts.displayHeaderFooter;
        delete plainOpts.headerTemplate;
        delete plainOpts.footerTemplate;
        // v3.0.805 -- TD-615. THE TWO EXPORTS ARE TIMED SEPARATELY, because the whole question is
        // whether the second one is nearly free (layout is already computed, so it re-serialises
        // paint only) or nearly as expensive as the first. On a 400-page book that is the
        // difference between 400 pages of paint and 800.
        var headedBuf = await page.pdf(Object.assign({ timeout: navTimeout }, pdfOpts));
        _lap('paint_headed');
        var plainBuf = await page.pdf(Object.assign({ timeout: navTimeout }, plainOpts));
        _lap('paint_plain');
        var PDFDocument = require('pdf-lib').PDFDocument;
        var dHead = await PDFDocument.load(headedBuf);
        var dPlain = await PDFDocument.load(plainBuf);
        var total = dPlain.getPageCount();
        var head = Math.min(_skipHead, total);
        var tail = Math.min(_skipTail, Math.max(0, total - head));
        var bodyEnd = total - tail;   // interior is [head, bodyEnd)
        if (head <= 0 && tail <= 0) {
          _recordRenderTiming({ label: options.timingLabel || 'render', pages: total, bytes: headedBuf.length,
            phases: _phases, totalMs: Date.now() - _renderStarted, doubleExport: true });
          return Buffer.from(headedBuf);
        }
        var out = await PDFDocument.create();
        var i, idx, cp;
        idx = []; for (i = 0; i < head; i++) idx.push(i);
        if (idx.length) { cp = await out.copyPages(dPlain, idx); cp.forEach(function (pg) { out.addPage(pg); }); }
        idx = []; for (i = head; i < bodyEnd; i++) idx.push(i);
        if (idx.length) { cp = await out.copyPages(dHead, idx); cp.forEach(function (pg) { out.addPage(pg); }); }
        idx = []; for (i = bodyEnd; i < total; i++) idx.push(i);
        if (idx.length) { cp = await out.copyPages(dPlain, idx); cp.forEach(function (pg) { out.addPage(pg); }); }
        var _stitched = Buffer.from(await out.save());
        _lap('stitch');
        _recordRenderTiming({ label: options.timingLabel || 'render', pages: total, bytes: _stitched.length,
          phases: _phases, totalMs: Date.now() - _renderStarted, doubleExport: true });
        return _stitched;
      } catch (e) {
        // Never fail a render over the running head: fall through to the normal single export.
        try { console.error('[renderPdf] matter-page head split failed, using plain export:', (e && e.message) || e); } catch (e2) {}
      }
    }
    const buf = await page.pdf(Object.assign({ timeout: navTimeout }, pdfOpts));
    _lap('paint');
    // page.pdf returns a Uint8Array on newer Puppeteer; normalize to Buffer
    // so downstream (R2 uploadFile, res.send) always gets a Buffer.
    var _out = Buffer.from(buf);
    // v3.0.805 -- TD-615. Page count is not known here without parsing the PDF, and parsing a
    // 400-page document just to log a number would be its own cost. The caller knows it.
    _recordRenderTiming({ label: options.timingLabel || 'render', pages: options.timingPages || null,
      bytes: _out.length, phases: _phases, totalMs: Date.now() - _renderStarted, doubleExport: false });
    return _out;
  } catch (err) {
    // A timeout here means the BOOK IS TOO BIG for the budget, not that a
    // panel is broken. Saying so is the difference between a one-line fix and
    // an hour spent chasing image URLs.
    var _ms = Date.now() - (_renderStarted || Date.now());
    var _isTimeout = err && (err.name === 'TimeoutError' || /Timed out/i.test(err.message || ''));
    if (_isTimeout) {
      var _e = new Error(
        'The book took longer than the render budget of ' + Math.round(navTimeout / 1000) + ' seconds and was stopped after ' +
        Math.round(_ms / 1000) + ' seconds. This is a SIZE problem, not a broken picture: try fewer sessions, or raise the budget. ' +
        'Original: ' + (err.message || err)
      );
      _e.code = 'RENDER_TIMEOUT';
      _e.elapsedMs = _ms;
      _e.budgetMs = navTimeout;
      // v3.0.805 -- TD-615. A RENDER THAT RAN OUT OF TIME IS THE MOST INFORMATIVE ONE THERE IS, and
      // until now it recorded nothing about WHERE the time went -- only that it was gone. The laps
      // taken so far say whether it died loading or painting, which is the whole question.
      try {
        _recordRenderTiming({ label: (options.timingLabel || 'render') + ':TIMEOUT',
          pages: options.timingPages || null, bytes: 0, phases: _phases || {},
          totalMs: _ms, doubleExport: false });
      } catch (e2) {}
      throw _e;
    }
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { renderHtmlToPdf, recentRenderTimings };
