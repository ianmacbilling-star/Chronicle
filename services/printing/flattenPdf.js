'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Flatten transparency in a print-bound PDF.
 *
 * WHY
 * Lulu warns on every book we send: "We detected an element that may be
 * transparent within your file. We strongly recommend flattening or removing
 * any transparencies." It is a warning rather than a rejection, but it is a
 * real property of our output: the logos are RGB+ALPHA PNGs, and 34 of the 39
 * gradients in the print HTML end in a fully transparent stop.
 *
 * HOW
 * -dCompatibilityLevel=1.3 is the whole trick. PDF 1.3 predates transparency,
 * so Ghostscript has no way to carry it forward and must composite it into the
 * page instead. NOTHING IS DISCARDED -- the gradient over a picture is baked
 * into the pixels it was already going to blend with, so the book looks the
 * same. Verified on a hand-built PDF carrying /Transparency, /ca, /CA and /BM:
 * all four markers present before, all four gone after, artwork unchanged.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not convert to CMYK, and it is not PDF/X-1a. Converting colour
 * without a matching output profile shifts it -- hardest on exactly the vivid
 * art this product is made of -- and can make Lulu's OTHER warning (ink
 * coverage) worse, because a naive conversion turns a rich RGB black into a
 * four-ink black. Lulu normalises colour to their own profile anyway. Decide
 * that against a PRINTED PROOF, not against a warning message; if the colour
 * is converted now and the proof comes back muddy, there is no way to tell
 * whether that was the conversion or the press.
 *
 * FAILS OPEN, ALWAYS
 * If Ghostscript is missing, errors, or takes too long, the ORIGINAL buffer is
 * returned and the reason is logged. A missing flatten is a warning on a Lulu
 * order; a failed flatten that threw would be a customer unable to buy a book.
 * The log line is loud precisely because the silent version of this is worse.
 *
 * WHERE GHOSTSCRIPT COMES FROM, AND THE ONE THING NOT TO BREAK
 * It is installed by `railpack.json` -> deploy.aptPackages. Railway builds with
 * RAILPACK, not Nixpacks: `nixpacks.toml` is dead and adding a package there does
 * nothing at all. v3.0.377 did exactly that and the transparency warning survived
 * two more days with a green deploy and no error anywhere.
 *
 * railpack.json reads:      "aptPackages": ["...", "ghostscript"]
 *
 * THE "..." IS LOAD-BEARING. Railpack already installs about thirty apt packages
 * automatically when it detects puppeteer -- libnss3, libgbm1, libgtk-3-0, xvfb --
 * and those are the only reason Chromium runs. A plain ["ghostscript"] REPLACES
 * that list instead of extending it: ghostscript arrives, Chromium's libraries
 * vanish, and NO PDF RENDERS AT ALL. That is far worse than the warning this code
 * exists to fix. The file is kept as strict JSON with no comments, because a parse
 * failure there has the same consequence.
 *
 * After changing it, read the build log: the `install apt packages:` line must
 * still contain libnss3 / libgbm1 / xvfb AND ghostscript.
 *
 * GHOSTSCRIPT_PATH overrides the binary. PDF_FLATTEN=off disables the whole thing
 * without a deploy.
 */

const GS_TIMEOUT_MS = 180000;   // a long book on a cold container
const GS_BIN = process.env.GHOSTSCRIPT_PATH || 'gs';

function flattenEnabled() {
  return String(process.env.PDF_FLATTEN || 'on').toLowerCase() !== 'off';
}

/**
 * @param {Buffer} buffer   the rendered PDF
 * @param {string} label    for the log line, e.g. 'interior' or 'cover'
 * @returns {Promise<{buffer: Buffer, flattened: boolean, reason: string}>}
 */
async function flattenPdf(buffer, label) {
  const tag = label || 'pdf';
  if (!flattenEnabled()) {
    return { buffer, flattened: false, reason: 'PDF_FLATTEN=off' };
  }
  if (!buffer || !buffer.length) {
    return { buffer, flattened: false, reason: 'empty buffer' };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flatten-'));
  const inPath = path.join(dir, 'in.pdf');
  const outPath = path.join(dir, 'out.pdf');
  const started = Date.now();

  try {
    fs.writeFileSync(inPath, buffer);
    await new Promise((resolve, reject) => {
      execFile(GS_BIN, [
        '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.3',      // <- THE FLATTEN. PDF 1.3 has no transparency model.
        '-dAutoRotatePages=/None',       // never re-orient a laid-out page
        '-dDetectDuplicateImages=true',  // one copy of a repeated logo
        // v3.0.387 -- MEASURED ON A REAL BOOK, not chosen from the manual.
        // The Strangers, Picture Book, 49 pages, 89MB in:
        //   PDFSETTINGS prepress             91s   130MB   (what v3.0.377 shipped)
        //   JPEG re-encode, no downsample    33s    94MB
        //   JPEG + downsample to 400dpi      42s    34MB   <- this
        // Prepress re-encodes images losslessly and INFLATED the file by 46 percent while taking
        // a minute and a half. It was picked to protect quality without measuring what it cost.
        // Page 12 was rasterised from the original and from this and compared: no visible
        // difference in the artwork, the text or the gradient over the picture.
        // 400dpi also caps Lulu's OTHER complaint -- "images with resolution greater than 600
        // pixels per inch" -- inside their recommended 200-600 band and well above the 300 print
        // standard. It does NOT fix the under-200 warning; that is a generation-side problem.
        // Threshold 1.0 means only images ABOVE 400dpi are touched; anything below is left alone.
        // Colour images only. Greyscale and 1-bit images are deliberately untouched: they were not
        // in the book measured, and JPEG is the wrong filter for 1-bit line art.
        '-dAutoFilterColorImages=false',
        '-dColorImageFilter=/DCTEncode',
        '-dJPEGQ=92',
        '-dDownsampleColorImages=true',
        '-dColorImageResolution=400',
        '-dColorImageDownsampleType=/Bicubic',
        '-dColorImageDownsampleThreshold=1.0',
        '-sOutputFile=' + outPath,
        inPath,
      ], { timeout: GS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout, stderr) {
        if (err) return reject(new Error((err.message || 'gs failed') + (stderr ? (' :: ' + String(stderr).slice(0, 300)) : '')));
        resolve();
      });
    });

    const out = fs.readFileSync(outPath);
    // A flattened file that is drastically smaller than the original is a
    // signal that content was dropped, not compressed. Refuse it rather than
    // ship a book with missing pages.
    if (!out || out.length < 1024 || out.length < buffer.length * 0.15) {
      throw new Error('output implausibly small (' + (out ? out.length : 0) + ' vs ' + buffer.length + ' bytes)');
    }
    // v3.0.387 -- say WHICH binary answered, once per process. Ghostscript was absent from the
    // Railway image for two days because a build setting was written to a file Railway had stopped
    // reading, and the only symptom was a Lulu warning. One line makes that visible immediately.
    if (!flattenPdf._announced) {
      flattenPdf._announced = true;
      try {
        require('child_process').execFile(GS_BIN, ['--version'], { timeout: 5000 }, function (e, out) {
          console.log('[flatten] ghostscript ' + (e ? ('NOT AVAILABLE: ' + e.message) : String(out).trim()) + ' at ' + GS_BIN);
        });
      } catch (e) {}
    }
    const ms = Date.now() - started;
    const pct = Math.round((out.length / buffer.length) * 100);
    console.log('[flatten] ' + tag + ': transparency flattened in ' + ms + 'ms, '
      + Math.round(buffer.length / 1024) + 'KB -> ' + Math.round(out.length / 1024) + 'KB (' + pct + '%)');
    return { buffer: out, flattened: true, reason: '' };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.warn('[flatten] ' + tag + ': NOT FLATTENED, sending the original PDF -- Lulu will warn about '
      + 'transparency on this file: ' + msg);
    return { buffer, flattened: false, reason: msg };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { flattenPdf, flattenEnabled };
