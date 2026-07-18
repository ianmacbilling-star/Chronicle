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
    const navTimeout = options.timeoutMs || 120000;
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: navTimeout });

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

    const buf = await page.pdf(pdfOpts);
    // page.pdf returns a Uint8Array on newer Puppeteer; normalize to Buffer
    // so downstream (R2 uploadFile, res.send) always gets a Buffer.
    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

module.exports = { renderHtmlToPdf };
