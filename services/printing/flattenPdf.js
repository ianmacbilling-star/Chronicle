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
 * Ghostscript is declared in nixpacks.toml. Set PDF_FLATTEN=off to disable
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
        '-dCompatibilityLevel=1.3',      // <- the flatten
        '-dPDFSETTINGS=/prepress',       // keep image quality; do not downsample
        '-dAutoRotatePages=/None',       // never re-orient a laid-out page
        '-dDetectDuplicateImages=true',  // one copy of a repeated logo
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
