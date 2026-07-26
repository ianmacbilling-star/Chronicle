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
      return { blocks: blocks };
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
