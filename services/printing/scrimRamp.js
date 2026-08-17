'use strict';

/**
 * THE COVER SCRIM, AS A PNG INSTEAD OF A CSS GRADIENT.  v3.0.686 -- TD-406.
 *
 * WHY THIS EXISTS, MEASURED ON A REAL BOOK RATHER THAN REASONED ABOUT
 * The scrim behind the cover title was `background:linear-gradient(...)`. Chromium draws that
 * correctly -- it is in the PDF, and poppler renders it -- but Chromium emits it as a dense strip
 * of 1x1 rects painted through a soft mask, and GHOSTSCRIPT CANNOT REPRODUCE THAT CONSTRUCT. The
 * flatten in services/printing/flattenPdf.js runs every print-bound file through Ghostscript, so
 * the scrim was being erased on exactly the artifacts a customer pays for.
 *
 * Verified on Ian's own unflattened book, 2026-08-17, by rendering the identical file two ways:
 *     poppler 24.02      scrim band luminance  43.5   <- the fade is there
 *     ghostscript 10.02  scrim band luminance 106.3   <- gone, artwork above it identical
 * and then by re-flattening that same file six ways. EVERY Ghostscript invocation lost it:
 *     -dCompatibilityLevel=1.3 (production)  106.3
 *     -dCompatibilityLevel=1.4               105.8
 *     bare pdfwrite 1.7                      105.8
 *     1.3 with no image flags                106.2
 *     1.7 -dPreserveSMask -dPreserveMarkedContent  105.8
 * There is no flag. It is not the transparency downgrade and it is not the image handling.
 * qpdf round-trips it perfectly (43.5, unchanged) but saves no space, so it is not a substitute.
 *
 * WHY AN IMAGE IS THE RIGHT ANSWER, AND HOW WE KNOW
 * The SAME flattened file keeps two things that are structurally identical to this: the built
 * title (an image XObject carrying an /SMask) and the cover vignette (a fill through a luminosity
 * mask backed by an image). Both survive Ghostscript intact. So an RGBA PNG stretched across the
 * caption box lands in the family that provably survives, rather than in the one that does not.
 * That is evidence from the artifact, not a preference between two things that look the same --
 * which is the mistake v3.0.682 made and the reason it drew a line across the artwork.
 *
 * ONE TABLE, FOUR RAMPS. The stops below are the SAME numbers the gradients used, so no cover
 * changes appearance. They are written once and the PNGs are derived from them; two numbers that
 * must agree are never written down twice. Positions are fractions FROM THE TOP of the box, which
 * is why the `to top` gradients appear reversed here -- converted once, here, rather than in four
 * places.
 *
 * BOTH TITLE STYLES, BY CONSTRUCTION. The scrim is a background on `.cover-art-caption`, and that
 * box is what holds EITHER the built-title image OR the plain `.cover-art-title` lettering. Ian,
 * 2026-08-17: "Remember this has to work under the original Title styles as well." It does,
 * because the scrim never knew which one it was behind.
 *
 * Built once at require time and cached: the bytes never vary, and a per-render PNG encode on the
 * PDF path would be pure waste.
 */

const zlib = require('zlib');

// rgba(10,6,4) -- the colour every cover scrim has always used.
const SCRIM_RGB = [10, 6, 4];

// Fractions FROM THE TOP -> alpha. Converted from the CSS stops once, here.
const STOPS = {
  // was: linear-gradient(to top, rgba(10,6,4,0.95) 22%, rgba(10,6,4,0.6) 58%, rgba(10,6,4,0) 100%)
  bottom: [[0, 0], [0.42, 0.6], [0.78, 0.95], [1, 0.95]],
  // was: linear-gradient(to bottom, rgba(10,6,4,0.95) 22%, rgba(10,6,4,0.6) 58%, rgba(10,6,4,0) 100%)
  top: [[0, 0.95], [0.22, 0.95], [0.58, 0.6], [1, 0]],
  // was: linear-gradient(to bottom, rgba(10,6,4,0) 0%, rgba(10,6,4,0.6) 18%, rgba(10,6,4,0.95) 50%, rgba(10,6,4,0.6) 82%, rgba(10,6,4,0) 100%)
  middle: [[0, 0], [0.18, 0.6], [0.5, 0.95], [0.82, 0.6], [1, 0]],
  // was: linear-gradient(to top, rgba(10,6,4,0.96) 24%, rgba(10,6,4,0.55) 60%, rgba(10,6,4,0) 100%)
  wrap: [[0, 0], [0.4, 0.55], [0.76, 0.96], [1, 0.96]]
};

// 512 rows is finer than any printer resolves over a five-inch band, and 8 columns keeps the
// image from being a degenerate 1px strip that a scaler might treat specially. Identical rows
// compress to almost nothing.
const RAMP_H = 512;
const RAMP_W = 8;

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function alphaAt(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, a0] = stops[i - 1];
      const [p1, a1] = stops[i];
      const span = (p1 - p0) || 1;
      return a0 + (a1 - a0) * ((t - p0) / span);
    }
  }
  return stops[stops.length - 1][1];
}

function rampPng(stops) {
  const raw = Buffer.alloc((RAMP_W * 4 + 1) * RAMP_H);
  let o = 0;
  for (let y = 0; y < RAMP_H; y++) {
    raw[o++] = 0;   // filter: None. The rows are near-identical, so deflate does the work.
    const a = Math.round(255 * alphaAt(stops, RAMP_H === 1 ? 0 : y / (RAMP_H - 1)));
    for (let x = 0; x < RAMP_W; x++) {
      raw[o++] = SCRIM_RGB[0];
      raw[o++] = SCRIM_RGB[1];
      raw[o++] = SCRIM_RGB[2];
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(RAMP_W, 0);
  ihdr.writeUInt32BE(RAMP_H, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// The full CSS declaration, so every call site emits the same three properties. background-size
// stretches the 8x512 ramp to the caption box; no-repeat because a stretched image that tiles
// after a rounding error draws a seam.
function scrimDecl(key) {
  const uri = 'data:image/png;base64,' + rampPng(STOPS[key]).toString('base64');
  return 'background-image:url(' + uri + ');background-size:100% 100%;background-repeat:no-repeat;';
}

const scrimCss = {
  bottom: scrimDecl('bottom'),
  top: scrimDecl('top'),
  middle: scrimDecl('middle'),
  wrap: scrimDecl('wrap')
};

module.exports = { scrimCss, STOPS, SCRIM_RGB, rampPng };
