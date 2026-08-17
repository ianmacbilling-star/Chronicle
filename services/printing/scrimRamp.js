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

// =====================================================================================================
// v3.0.688 -- THE HAZE. TD-490.
//
// Ian, 2026-08-17, with a marked-up screenshot showing the runes and the staff at the far edges of
// the band: "I would like the areas inside the red circles to Not be faded... it should go past the
// lettering but not much... I don't want the Plate." And: "it should be automatic."
//
// So the scrim stops being a full-width band and becomes a soft cloud around the TYPE. The four
// directional ramps above are retired by this: a haze that surrounds the lettering needs no
// direction, so top / middle / bottom now share ONE image instead of three that could drift.
//
// THIS IS THE OVAL, ATTEMPT FOUR, AND IT IS A DIFFERENT MECHANISM. v3.0.624 drew an ellipse, 625
// pulled the core under the lettering, 628 bounded the blurs to the artwork width. All three read
// as a visible shape and v3.0.631 removed the lot at Ian's request, with the reason recorded: a
// filled shape has an edge, and blur only MOVES an edge. Those were CSS primitives, which always
// have a boundary. This is a bitmap: alpha reaches EXACTLY ZERO at the image border AND arrives
// there with zero slope, because (1-d^2)^p has derivative 0 at d=1. There is no edge to move.
//
// THE SHAPE WAS CHOSEN BY EYE, TWICE. Three bleeds were composited onto Ian's real cover -- 1.10x,
// 1.30x and 1.55x the lettering width -- and he picked the middle. Seeing it rendered he asked for
// more: "The fade isn't big enough, it needs to be wider and a just a little taller." (v3.0.689).
// Width went to the widest of the three; height up by a tenth, because "a little" was the word.
// A COMPOSITE IS NOT A RENDER: the preview was drawn with numpy over a rasterised cover, which is
// the right way to choose a shape and NOT the same as Chromium painting it at print scale. Expect
// to move these twice; that is why they are two constants with everything derived from them.
// rx and ry below are the
// semi-axes as a multiple of the TITLE BOX half-width and half-height, and PAD_X / PAD_Y are
// derived from them so the ellipse lands exactly on the image border. Change rx/ry and the padding
// follows; the two cannot disagree.
//
// IT SIZES ITSELF, WITH NO TEXT METRICS ANYWHERE. The haze is painted on a box that wraps the title
// and subtitle, and that box is shrink-to-fit for lettering and takes the built title's own width
// for a drawing. So Small gets a small haze and Large a large one because the BOX is smaller or
// larger -- nothing reads the size setting, and there is no second number to keep in step with
// COVER_SIZE_RATIO.
//
// KNOWN LIMIT, STATED RATHER THAN DISCOVERED: this measures the title BOX. A built title is a PNG
// whose lettering need not fill its own width, so a drawing with wide transparent margins gets a
// haze wider than its words. The fix is an ink bounding box computed at build time (TD-491),
// deliberately a separate build. Plain text titles are exact already, because the box IS the text.
const HAZE_RX = 1.55;      // semi-axis / title-box half-width
const HAZE_RY = 2.30;      // semi-axis / title-box half-height
const HAZE_PEAK = 0.94;    // alpha at the centre
// v3.0.690 -- THE EXPONENT IS THE SIZE CONTROL NOBODY WAS USING.
// Ian, 2026-08-17: "I think the size of the fade is correct. It's just too dark too far out on
// the edges. So make it fade more drastic from the center. So the edges are barely even there."
// Measured along the horizontal, alpha at the box edge / 25% / 50% / 75% of the way out:
//     power 1.5 (v3.0.689)   239  218  156   70   <- still 60% of peak HALFWAY out
//     power 4.5 (this)       234  177   65    6
// The box edge barely moves, so the lettering keeps its cover; everything past it collapses.
// RX, RY and PEAK are DELIBERATELY UNCHANGED -- Ian said the size was right, and v3.0.689
// overshot precisely because two things moved at once.
const HAZE_POWER = 4.5;    // falloff shape; higher = the rim dies off much faster
// Where the title box sits inside the image, derived from the semi-axes rather than named twice.
const INNER_X = 1 / HAZE_RX;
const INNER_Y = 1 / HAZE_RY;
const HAZE_W = 192;
const HAZE_H = 192;

// The insets that put the ellipse exactly on the image border, DERIVED from the semi-axes above.
// A box of width W has half-width W/2; the ellipse wants HAZE_RX * (W/2), so the image must overhang
// each side by (HAZE_RX - 1) / 2 of the box width.
function hazeInsetPct(r) { return Math.round((r - 1) / 2 * 1000) / 10; }

function hazePng() {
  const raw = Buffer.alloc((HAZE_W * 4 + 1) * HAZE_H);
  let o = 0;
  for (let y = 0; y < HAZE_H; y++) {
    raw[o++] = 0;
    const py2 = (y / (HAZE_H - 1)) * 2 - 1;
    for (let x = 0; x < HAZE_W; x++) {
      const px2 = (x / (HAZE_W - 1)) * 2 - 1;
      // PLATEAU, NOT AN ELLIPSE. v3.0.688 used a plain radial falloff and Ian's report was exact:
      // "It's just not getting the outer edges of the text... it really should go a little past the
      // text in all cases." An ellipse falls away from its CENTRE, so the ends of a line of type sit
      // far out on the curve -- at the text box's own left and right extremes the alpha was down to
      // roughly a QUARTER of peak. Widening it only spreads a weak rim further out; the shape was
      // the fault, not the size.
      //
      // So: full opacity across the whole title box, and the falloff begins OUTSIDE it. INNER_X and
      // INNER_Y are where that box sits inside this image and are DERIVED from the same two
      // semi-axis constants the CSS insets come from, so the plateau is the title box by
      // construction and the two cannot drift.
      const ox = Math.max(0, Math.abs(px2) - INNER_X) / (1 - INNER_X);
      const oy = Math.max(0, Math.abs(py2) - INNER_Y) / (1 - INNER_Y);
      const t = Math.min(1, Math.sqrt(ox * ox + oy * oy));
      const a = Math.pow(1 - t * t, HAZE_POWER) * HAZE_PEAK;
      raw[o++] = SCRIM_RGB[0];
      raw[o++] = SCRIM_RGB[1];
      raw[o++] = SCRIM_RGB[2];
      raw[o++] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(HAZE_W, 0);
  ihdr.writeUInt32BE(HAZE_H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// THE WHOLE RULE SET, emitted from here so all three cover builders get one haze and not three.
//
// NO NEGATIVE z-index, on purpose. The nearest stacking context above the caption is
// `.cover-content.cover-image-layout` (position:absolute, z-index:1), so a z-index:-1 pseudo-element
// would sink to the bottom of THAT context -- behind the cover artwork -- and vanish completely.
// Instead the haze is a positioned element FIRST in tree order and the type is position:relative,
// so both are positioned with z-index auto and paint in document order: haze, then words.
function hazeCss() {
  const uri = 'data:image/png;base64,' + hazePng().toString('base64');
  const px = hazeInsetPct(HAZE_RX), py = hazeInsetPct(HAZE_RY);
  return '.cover-title-haze { position:relative; display:inline-block; max-width:100%; }' +
    ' .cover-title-haze-fx { position:absolute; left:-' + px + '%; right:-' + px + '%;' +
    ' top:-' + py + '%; bottom:-' + py + '%; pointer-events:none;' +
    ' background-image:url(' + uri + '); background-size:100% 100%; background-repeat:no-repeat; }' +
    ' .cover-title-haze .cover-art-title, .cover-title-haze .cover-art-dates,' +
    ' .cover-title-haze .cover-built-title { position:relative; }';
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

const coverHazeCss = hazeCss();
module.exports = { scrimCss, coverHazeCss, STOPS, SCRIM_RGB, rampPng, hazePng,
                   HAZE_RX, HAZE_RY, HAZE_PEAK, HAZE_POWER, hazeInsetPct, INNER_X, INNER_Y };

