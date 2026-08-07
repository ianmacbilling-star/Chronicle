'use strict';

// ============================================================
// measureLayout.js  -  text-only measurement pass (two-pass pagination, Stage 1)
// ------------------------------------------------------------
// Loads comic HTML in headless Chromium with IMAGE REQUESTS BLOCKED, so layout
// is fast and deterministic (no R2 fetches). Comic image boxes carry explicit
// CSS heights from their aspect ratio, so blocking the pixels does not change
// their measured height -- only TEXT height is actually unknown, which is exactly
// what we read. Returns the real rendered geometry of every [data-mblk] block.
//
// Fonts (@font-face / Google Fonts) are NOT blocked (they are not images), and we
// await document.fonts.ready, so text height matches the real PDF render.
// puppeteer is require()'d lazily so the module loads before the dep is installed.
// ============================================================

// ===== SHARED MEASURE BROWSER =====================================================================
// measureDocument used to launch a FRESH Chromium on every call and close it again. The optimize
// loop calls it constantly -- once per review pass, once per text move, and once per round of the
// scale bisection -- so a couple of Optimize runs produced roughly 95 browser launches, visible in
// the Railway log as 95 [NEVER-CLIP] lines. A single shrinkImage op alone costs four whole-book
// launches while it bisects. Eventually the container has no room to start another and Chromium
// reports 'Failed to launch the browser process' -- which is what stalled a run mid-loop with the
// progress bar still animating (the bar is a CSS animation and knows nothing about state).
// One browser is now launched lazily, shared by every measure, and closed after an idle period.
// Only the PAGE is closed per call. If the browser dies or is disconnected the handle is dropped
// and the next call relaunches, so a crash costs one measure rather than the process.
var _mBrowser = null;
var _mIdleTimer = null;
// v3.0.501 -- TD-136. Set once the CURRENT browser has confirmed every declared face loads.
// Reset whenever the browser handle is dropped. See the note at the font wait below.
var _mFontsOk = false;
var MEASURE_FONT_WAIT_MS = 750;   // was 5000, and 5000 was pure waste -- see below
var MEASURE_BROWSER_IDLE_MS = 5 * 60 * 1000;   // release the browser after five idle minutes
function _mLaunchOpts() {
  var o = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none'
    ]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) o.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return o;
}
function _mTouchIdle() {
  if (_mIdleTimer) clearTimeout(_mIdleTimer);
  _mIdleTimer = setTimeout(function () {
    var b = _mBrowser; _mBrowser = null; _mIdleTimer = null;
    _mFontsOk = false;   // v3.0.501 -- a fresh browser has a cold font cache
    if (b) { try { b.close(); } catch (e) {} }
  }, MEASURE_BROWSER_IDLE_MS);
  if (_mIdleTimer && _mIdleTimer.unref) _mIdleTimer.unref();   // never hold the process open
}
async function _mGetBrowser() {
  if (_mBrowser) {
    var alive = true;
    try { if (typeof _mBrowser.isConnected === 'function') alive = _mBrowser.isConnected(); } catch (e) { alive = false; }
    if (alive) { _mTouchIdle(); return _mBrowser; }
    try { await _mBrowser.close(); } catch (e) {}
    _mBrowser = null;
  }
  const puppeteer = require('puppeteer');
  _mBrowser = await puppeteer.launch(_mLaunchOpts());
  // v3.0.501 -- the font check is confirmed PER BROWSER, not per process. A browser caches the
  // font files it has fetched, so once one page has loaded every declared face the next page on
  // the same browser has them already. A NEW browser has an empty cache and must check again, so
  // this flag is cleared here and wherever the handle is dropped (idle timer, disconnect).
  _mFontsOk = false;
  try { _mBrowser.on('disconnected', function () { _mBrowser = null; _mFontsOk = false; }); } catch (e) {}
  _mTouchIdle();
  return _mBrowser;
}
// Bound a promise that has no timeout of its own. document.fonts.ready in particular can hang
// forever if a webfont never settles -- and because it hangs, the cleanup below never runs and the
// browser leaks. Measuring with fallback metrics is far better than never returning.
function _mWithTimeout(p, ms, label) {
  // v3.0.501 -- WHAT THIS DOES AND DOES NOT FIX. Recorded because a wrong theory was written
  // here first and nearly shipped as a comment, which is worse than shipping no comment at all.
  // THE THEORY (WRONG): when the timer wins, the page.evaluate() left in flight is orphaned;
  // `finally { page.close() }` later rejects it with 'Protocol error: Target closed'; and
  // server.js makes an unhandled rejection FATAL (process.on('unhandledRejection', handleFatal)
  // -> process.exit(1)). So a timed-out font wait would take the process down and 502 every
  // request in flight.
  // WHY IT IS WRONG: Promise.race SUBSCRIBES TO BOTH promises. The loser therefore has a handler
  // attached from the moment the race is constructed, and a later rejection is handled-and-ignored
  // rather than unhandled. Tested against the v3.0.491 helper: a late rejection fires no
  // unhandledRejection there either. Nothing was ever leaking here.
  // WHAT IS ACTUALLY CHANGED: the timer is now CLEARED when the real promise wins. Previously
  // every measure left a live 5-second timer behind that would still fire and print a misleading
  // 'timed out' line after a wait that had already succeeded. The .catch below is belt and braces
  // for a non-promise thenable and costs nothing; it is not load-bearing.
  var _p = Promise.resolve(p);
  _p.catch(function () {});
  var _timer = null;
  return Promise.race([
    _p,
    new Promise(function (resolve) {
      _timer = setTimeout(function () {
        try { console.warn('[measure] ' + label + ' timed out after ' + ms + 'ms -- continuing'); } catch (e) {}
        resolve(null);
      }, ms);
      if (_timer && _timer.unref) _timer.unref();
    })
  ]).then(function (v) { if (_timer) clearTimeout(_timer); return v; });
}
async function measureDocument(html, options) {
  options = options || {};
  const browser = await _mGetBrowser();   // shared, not launched per call
  const page = await browser.newPage();
  try {

    // Block image + media requests: layout is instant and never waits on R2.
    await page.setRequestInterception(true);
    page.on('request', function (req) {
      var t = req.resourceType();
      if (t === 'image' || t === 'media') { req.abort(); }
      else { req.continue(); }
    });

    await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs || 60000 });

    // Wait for web fonts so measured text height matches the real PDF metrics.
    // BOUNDED: setContent above carries a timeout; this did not, and a font that never settles hung
    // the pack forever while leaking the browser, because the cleanup below never ran.
    // DO NOT WAIT ON document.fonts.ready. Three explanations for this hang have now been wrong:
    // that the fonts were fetched from Google and never arrived (they were, and self-hosting them was
    // worth doing, but the timeout survived it); that Puppeteer choked marshalling the FontFaceSet the
    // promise resolves to (it returns a plain string now, and the timeout survived that too). The
    // promise simply does not settle here. Per spec it waits on the document being finished loading,
    // and this page is built with setContent and has every image request aborted, so that condition
    // may never be satisfied -- but the honest position is that we do not know.
    // So stop depending on it. Load each declared face EXPLICITLY and wait for exactly those promises:
    // that is what we actually care about -- the faces this document uses being ready before we
    // measure text with them -- and it does not care what the document's loading state is.
    // On timeout, report the state instead of shrugging, so a fourth wrong theory is not necessary.
    // v3.0.411 (TD-136) -- MAKE THIS SPEAK. It has fired on every measure of every book for weeks:
    // roughly five seconds of dead wait per measure, several measures per pass, and if the faces
    // genuinely are not ready then text is being measured with FALLBACK METRICS -- which would feed
    // the est-vs-real gap that TD-186 is about. So it may be costing a quarter of every run AND be
    // the source of the measurement error underneath the page-budget problem.
    // Three explanations for it have already been wrong. The note on TD-136 says: capture the probe
    // output before theorising. The probe exists -- and has never once appeared in a log, because the
    // catch below swallowed whatever went wrong with it. Neither its timeout message nor its result
    // has ever been seen, which means page.evaluate is THROWING and nobody was told.
    // Nothing here changes behaviour. It only makes the next occurrence answerable.
    // v3.0.501 -- TD-136. STOP ASKING A QUESTION THAT NEVER GETS ANSWERED.
    // THE MEASUREMENT, from Ian's Railway log of 2026-08-07:
    //     [measure] first font wait: 17ms, result 8/8 faces, status=loading, readyState=complete
    // Every face loaded, in SEVENTEEN MILLISECONDS. And then every later measure in that process
    // burned the full 5000ms ceiling. ~56 timeouts in one range = 4.7 MINUTES of dead wait, and a
    // single layout-apply with 20 ops paid it dozens of times over (the note above records that one
    // shrinkImage costs four whole-book measures while it bisects). The request outlived the proxy
    // and the client got a 502 while the server was still grinding -- the run "stopped at pass 2"
    // with the process perfectly healthy and still logging.
    // So the 5000ms wait was not a symptom of the stall. It WAS the stall.
    //
    // WHY IT NEVER SETTLES IS STILL UNKNOWN, and that is deliberate wording. Four explanations have
    // now been wrong (three in the comment below, plus a fifth-attempt crash theory on 2026-08-07
    // that the logs disproved). What changes here is that it stops mattering: we confirm ONCE per
    // browser that every declared face loads, and thereafter trust the browser's own font cache --
    // which is the same cache the render will use.
    // The faces are self-hosted (26 at boot), so this is a local read, not a network fetch.
    if (_mFontsOk) {
      // Already confirmed on this browser. The files are cached; a new page does not refetch them.
      // Nothing is skipped that affects metrics -- the same faces are available to this page.
    } else {
    var _fT0 = Date.now();
    var _fs = await _mWithTimeout(page.evaluate(function () {
      if (!document.fonts) return 'no-font-api';
      var faces = [];
      try { document.fonts.forEach(function (f) { faces.push(f); }); } catch (e) {}
      if (!faces.length) return 'no-faces-declared';
      return Promise.all(faces.map(function (f) {
        try { return f.load().then(function () { return 1; }, function () { return 0; }); }
        catch (e) { return 0; }
      })).then(function (r) {
        var okN = r.reduce(function (a, b) { return a + b; }, 0);
        return okN + '/' + r.length + ' faces, status=' + String(document.fonts.status || '?') +
               ', readyState=' + String(document.readyState || '?');
      });
    }), MEASURE_FONT_WAIT_MS, 'font loading');
    var _fMs = Date.now() - _fT0;
    // Report ONCE per process, whatever happened. A timeout tells us it hung; a success at 4900ms
    // tells us it is merely slow; a success at 30ms with 0 faces tells us it never had anything to
    // wait for. Those are three different bugs and the log has never distinguished them.
    if (!measureDocument._fontReported) {
      measureDocument._fontReported = true;
      try { console.log('[measure] first font wait: ' + _fMs + 'ms, result ' + (_fs == null ? 'TIMED OUT' : String(_fs))); } catch (e) {}
    }
    if (_fs == null) {
      // The wait timed out. Say what the page looked like at that moment -- that is the datum that has
      // been missing every time this has come up.
      try {
        var _st = await _mWithTimeout(page.evaluate(function () {
          return 'status=' + String((document.fonts && document.fonts.status) || '?') +
                 ', readyState=' + String(document.readyState || '?') +
                 ', faces=' + String((document.fonts && document.fonts.size) || 0);
        }), 2000, 'font state probe');
        console.warn('[measure] font loading did not settle -- ' + (_st || 'the page did not answer either'));
      } catch (e) {
        // v3.0.411 -- was silent. This is why the probe has never appeared in a log: it throws, and
        // the throw was discarded, so the one diagnostic built for this question never reached anyone.
        try { console.warn('[measure] font state probe FAILED -- ' + ((e && e.message) || e) +
                           '  (the page could not be evaluated at all; the wait took ' + _fMs + 'ms)'); } catch (e2) {}
      }
    } else if (String(_fs).indexOf('no-') !== 0 && String(_fs).indexOf('/') > 0 &&
               String(_fs).split('/')[0] !== String(_fs).split(' ')[0].split('/')[1]) {
      try { console.warn('[measure] not every face loaded: ' + _fs + ' -- text metrics may not match the render'); } catch (e) {}
    } else if (_fs != null && String(_fs).indexOf('no-') !== 0) {
      // Every declared face reported loaded. Do not ask this browser again -- see above.
      _mFontsOk = true;
      try { console.log('[measure] fonts confirmed on this browser in ' + _fMs + 'ms (' + _fs + ') -- later measures skip the wait'); } catch (e) {}
    }
    }   // end: not yet confirmed on this browser

    var data = await page.evaluate(function () {
      var PX = 96; // CSS px per inch
      var round3 = function (n) { return Math.round(n * 1000) / 1000; };
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-mblk]'));
      var blocks = nodes.map(function (n) {
        var r = n.getBoundingClientRect();
        var lineBottoms = [];
        var lineStartChars = [];
        try {
          var pEl = n.querySelector('p') || n;
          // Walk EVERY text node in the paragraph (not just firstChild): a paragraph with inline
          // markup (<em>, <strong>, spans from em-dashes/emphasis) has multiple text nodes, and
          // measuring only the first one truncated the line data -- the packer then split long
          // paragraphs as if they were 1-2 lines and the composed page clipped by inches. Track a
          // GLOBAL char position across all text nodes so line-start offsets index the full text,
          // and detect a new line whenever a word's top jumps -- across node boundaries too.
          var _tw = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT, null, false);
          var rng2 = document.createRange();
          var prevTop = null, gpos = 0, curBottom = 0, _tn;
          while ((_tn = _tw.nextNode())) {
            var full = _tn.textContent;
            var parts = full.split(/(\s+)/);
            var lpos = 0;
            for (var wi = 0; wi < parts.length; wi++) {
              var wlen = parts[wi].length;
              if (wlen === 0) continue;
              if (/^\s+$/.test(parts[wi])) { lpos += wlen; gpos += wlen; continue; }
              rng2.setStart(_tn, lpos);
              rng2.setEnd(_tn, Math.min(lpos + wlen, full.length));
              var wr = rng2.getBoundingClientRect();
              if (prevTop === null) { lineStartChars.push(0); prevTop = wr.top; }
              else if (wr.top > prevTop + 2) {
                lineBottoms.push(Math.round(((curBottom - r.top) / PX) * 1000) / 1000);
                lineStartChars.push(gpos);
                prevTop = wr.top;
              }
              curBottom = wr.bottom;
              lpos += wlen; gpos += wlen;
            }
          }
          if (prevTop !== null) lineBottoms.push(Math.round(((curBottom - r.top) / PX) * 1000) / 1000);
        } catch (e) { lineBottoms = []; lineStartChars = []; }
        return {
          id: n.getAttribute('data-mblk'),
          kind: n.getAttribute('data-mkind') || '',
          moment: n.getAttribute('data-mmoment'),
          part: n.getAttribute('data-mpart') || '',
          chars: parseInt(n.getAttribute('data-mchars'), 10) || 0,
          split: n.getAttribute('data-msplit') === '1',
          lines: lineBottoms,
          lineChars: lineStartChars,
          topIn: round3(r.top / PX),
          widthIn: round3(r.width / PX),
          heightIn: round3(r.height / PX)
        };
      });
      // Tower geometry probes: hidden markers cgFlowTower emits in the measure pass, plus the
      // rendered height of the image box that immediately follows each probe -- so we can see the
      // PLANNED tower image height vs the box's REAL rendered height (the auto-height divergence).
      var probes = Array.prototype.slice.call(document.querySelectorAll('[data-twprobe]')).map(function (pn) {
        var boxH = null, capH = null, imgRealH = null;
        var boxEl = pn.nextElementSibling;   // the float box that holds the image (probe's sibling)
        // If the immediate sibling isn't the box (or collapsed), search the parent for the first
        // element containing an <img> -- robust to wrapper differences between render paths.
        if (!boxEl || !boxEl.querySelector || !boxEl.querySelector('img')) {
          var _p = pn.parentElement;
          if (_p) { var _imgs = _p.querySelectorAll('img'); if (_imgs.length) boxEl = _imgs[0].parentElement; }
        }
        if (boxEl) { boxH = Math.round((boxEl.getBoundingClientRect().height / 96) * 1000) / 1000;
          var _im = boxEl.querySelector('img'); if (_im) { var _ir = _im.getBoundingClientRect(); imgRealH = Math.round((_ir.height / 96) * 1000) / 1000; }
          var capEl = boxEl.querySelector('div[style*="position:absolute"]');
          if (capEl) capH = Math.round((capEl.getBoundingClientRect().height / 96) * 1000) / 1000; }
        return { imgW: parseFloat(pn.getAttribute('data-tw-imgw')), imgH: parseFloat(pn.getAttribute('data-tw-imgh')),
          asp: parseFloat(pn.getAttribute('data-tw-asp')), cap: pn.getAttribute('data-tw-cap'),
          cropsafe: pn.getAttribute('data-tw-cropsafe'), boxRealH: boxH, imgRealH: imgRealH, capRealH: capH };
      });
      // Universal per-image geometry (AI input contract): every image carries a data-imgprobe with
      // its fit/crop/focal/intrinsic-aspect/shape. Here we read the IMG's own rendered rect and its
      // enclosing box's rect (the box is what the layout sized), plus any caption sibling and whether
      // that caption is in normal flow or absolutely positioned (an absolute caption adds no height
      // and can be clipped by the box's overflow:hidden). This gives the AI, for every picture in
      // every layout, planned-vs-real geometry and a crop/clip signal from one place.
      var PX2 = 96;
      var imgProbes = Array.prototype.slice.call(document.querySelectorAll('img[data-imgprobe]')).map(function (im) {
        var ir = im.getBoundingClientRect();
        var box = im.parentElement;
        var br = box ? box.getBoundingClientRect() : ir;
        // caption: a sibling/descendant of the box positioned absolutely (overlay) or in flow (below)
        var capEl = box ? box.querySelector('[style*="position:absolute"]') : null;
        var capInFlow = 1, capRealH = null;
        if (capEl) {
          var cs = window.getComputedStyle(capEl);
          capInFlow = (cs && cs.position === 'absolute') ? 0 : 1;
          capRealH = Math.round((capEl.getBoundingClientRect().height / PX2) * 1000) / 1000;
        }
        var boxAsp = (br.height > 0) ? Math.round((br.width / br.height) * 1000) / 1000 : null;
        var intrinsic = parseFloat(im.getAttribute('data-ip-intrinsic')) || null;
        var fit = im.getAttribute('data-ip-fit');
        // crop estimate: a cover image whose intrinsic aspect != the box aspect is cropped on one axis
        var cropAxis = null;
        if (fit === 'cover' && intrinsic && boxAsp) {
          if (intrinsic > boxAsp + 0.02) cropAxis = 'sides';       // image wider than box -> left/right cropped
          else if (intrinsic < boxAsp - 0.02) cropAxis = 'topbottom'; // image taller than box -> top/bottom cropped
        }
        return {
          shape: im.getAttribute('data-ip-shape'), fit: fit,
          cropsafe: im.getAttribute('data-ip-cropsafe'), focal: im.getAttribute('data-ip-focal'),
          hasTitle: im.getAttribute('data-ip-title') === '1',
          intrinsicAsp: intrinsic, boxAsp: boxAsp,
          boxWin: Math.round((br.width / PX2) * 1000) / 1000, boxHin: Math.round((br.height / PX2) * 1000) / 1000,
          imgWin: Math.round((ir.width / PX2) * 1000) / 1000, imgHin: Math.round((ir.height / PX2) * 1000) / 1000,
          cropAxis: cropAxis, capInFlow: capInFlow, capRealH: capRealH
        };
      });
      // BOX-OVERFLOW: content clipped INSIDE a measured block is invisible to the page/cell height
      // check, because the height we report is the BOX's height, not the content's. A tower whose
      // beside-column runs past its panel reports the panel height and looks healthy. Walk every
      // element inside each measured block and flag any whose scroll extent exceeds its client box
      // while its computed overflow actually HIDES the excess. Deliberately cause-agnostic: it names
      // the element that is clipping without assuming why it clips.
      // ===== BOX-OVERFLOW -- RETIRED 2026-08-07 (v3.0.508) ==========================================
      // Ian, after checking the rendered PDF against six of these warnings: "I'm not seeing what you
      // are seeing... What do you mean by cut."
      // HE WAS RIGHT AND THE CHECK IS WRONG. On The Strangers (Magazine, v3.0.507) it reported
      // "6 ELEMENT(S) CLIP THEIR OWN CONTENT" -- all six identical in shape, box 0.17in against
      // content 0.25in or 0.40in. Rasterising the flagged pages showed nothing clipped at all:
      // viewer p.11 "The Teleportation Circle Is Drawn" and p.40 "Cold Hand of Fate" both wrap onto
      // a second line and BOTH LINES ARE FULLY VISIBLE. 0.25in is a one-line title plate and 0.40in
      // is a two-line one, so the scan is comparing the plate's scroll extent against a box measured
      // before the plate grows to hold the wrap. The mismatch never reaches the page.
      // So it fires on every wrapped caption plate and finds nothing real -- six false alarms on a
      // healthy book, which is worse than no check at all: a warning that is usually wrong trains
      // everyone to ignore the one that is not.
      // NOT DELETED. The scan and its reasoning are intact behind DEBUG_BOXOVERFLOW=1 (same
      // convention as DEBUG_CLIP and DEBUG_PROMPT) so it can be fixed rather than rewritten. The
      // fault to fix first is the timing: measure the box AFTER layout settles, or exclude
      // absolutely-positioned overlays, which cannot clip their parent by growing.
      // While it is off, the dump prints NOTHING for it rather than "[OK]" -- claiming a clean
      // result from a check that did not run is the one outcome worse than the false alarms.
      var boxOverflows = [];
      var _boxScanOn = !!process.env.DEBUG_BOXOVERFLOW;
      try {
        if (!_boxScanOn) throw { __skip: 1 };
        nodes.forEach(function (n) {
          var bid = n.getAttribute('data-mblk') || '';
          var all = Array.prototype.slice.call(n.querySelectorAll('*'));
          all.push(n);
          all.forEach(function (el) {
            if (el.__boxSeen) return;                // a nested block re-walks its parent's elements
            var sh = el.scrollHeight || 0, ch = el.clientHeight || 0;
            if (!sh || !ch) return;
            var overIn = (sh - ch) / PX;
            // 0.05in floor: an <img> whose intrinsic height rounds a hair past its box reported at
            // 0.02in on every title page -- six entries of pure noise that buried the real signal.
            // Nothing under a rendered line height can lose a line, so nothing under it matters.
            if (overIn <= 0.05) return;
            el.__boxSeen = 1;
            var ovf = '?';
            try { var cs = window.getComputedStyle(el); ovf = cs.overflow + '/' + cs.overflowY; } catch (e) {}
            if (!/hidden|clip|scroll|auto/.test(ovf)) return;   // visible overflow spills, it does not cut
            boxOverflows.push({
              block: bid,
              tag: (el.tagName || '').toLowerCase(),
              cls: String(el.className || '').slice(0, 48),
              clientIn: round3(ch / PX),
              scrollIn: round3(sh / PX),
              overIn: round3(overIn),
              overflow: ovf
            });
          });
        });
      } catch (e) { boxOverflows = []; }
      if (!_boxScanOn) boxOverflows = null;   // null = NOT MEASURED, distinct from [] = measured and clean
      return { blocks: blocks, towerProbes: probes, imgProbes: imgProbes, boxOverflows: boxOverflows };
    });

    var total = 0;
    data.blocks.forEach(function (b) { total += b.heightIn; });
    data.blockCount = data.blocks.length;
    data.totalBlockHeightIn = Math.round(total * 1000) / 1000;
    data.imagesBlocked = true;
    return data;
  } finally {
    // Close the PAGE only -- the browser is shared and lives on. A failure here must never mask the
    // real error or abort the caller, but a leaked page is a leaked tab, so it is still attempted.
    try { await page.close(); } catch (e) {}
  }
}

module.exports = { measureDocument };
