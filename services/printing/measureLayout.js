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

async function measureDocument(html, options) {
  options = options || {};
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

    // Block image + media requests: layout is instant and never waits on R2.
    await page.setRequestInterception(true);
    page.on('request', function (req) {
      var t = req.resourceType();
      if (t === 'image' || t === 'media') { req.abort(); }
      else { req.continue(); }
    });

    await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs || 60000 });

    // Wait for web fonts so measured text height matches the real PDF metrics.
    await page.evaluate(function () {
      return (document.fonts && document.fonts.ready) ? document.fonts.ready : null;
    });

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
      return { blocks: blocks, towerProbes: probes, imgProbes: imgProbes };
    });

    var total = 0;
    data.blocks.forEach(function (b) { total += b.heightIn; });
    data.blockCount = data.blocks.length;
    data.totalBlockHeightIn = Math.round(total * 1000) / 1000;
    data.imagesBlocked = true;
    return data;
  } finally {
    await browser.close();
  }
}

module.exports = { measureDocument };
