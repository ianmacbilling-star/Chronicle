// =====================================================================================================
// WHITE-GROUND ALPHA CUT  (TD-362)
// =====================================================================================================
// Character reference images are generated on a white ground (v3.0.559). White is NOT transparent, and
// the difference cost six builds: the Company page overlaps figures, and an opaque white rectangle does
// not crowd its neighbour, it ERASES it. v3.0.572 had to shrink every figure to stop characters
// vanishing off the page.
//
// mix-blend-mode:multiply was tried first (v3.0.570) and is not enough. A generated ground measures
// 251,251,252 -- not pure white -- and multiply only vanishes TRUE white, so it leaves the faint grey
// rectangles Ian could see behind half the cast.
//
// So the white is cut to real alpha ONCE, here, when the image is first persisted. From then on the
// stored PNG has genuine transparency and every consumer gets it for free: the line-up can overlap as
// hard as it likes, the contact shadows stop being painted over, and no CSS is involved at all --
// which matters, because CSS is exactly what has failed in the print path all week (TD-347, TD-352).
//
// WHY NO DEPENDENCY. There is no image library in this project and adding sharp means a native build on
// Railway. A PNG is deflate plus a per-row filter, and zlib and crypto are both built into Node -- so
// decoding and re-encoding one is about a hundred lines and no install step. That is a smaller, more
// predictable thing to own than a binary dependency.
//
// FAIL-SOFT, LIKE THE FUNCTION THAT CALLS IT. Anything unexpected -- an interlaced PNG, a palette, a
// 16-bit depth, a JPEG, a corrupt stream -- returns the ORIGINAL buffer untouched. A character with a
// white box is a cosmetic problem; a character with no image is a broken book.
//
// EDGE HANDLING IS THE PART THAT MATTERS. A hard threshold leaves a jagged white halo on every
// antialiased outline, which looks worse than the box did. So there are two thresholds: above KEEP the
// pixel is fully transparent, below CUT it is fully opaque, and between them alpha ramps -- which is
// what turns a cut-out into something that reads as drawn rather than as stamped.

const zlib = require('zlib');
const crypto = require('crypto');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// A pixel at or above CUT_HI on every channel is ground; at or below CUT_LO it is ink. Between the two,
// alpha ramps. 236 is deliberately generous -- the measured ground was 251,251,252 and paper highlights
// on the figures themselves run well below 236, so the gap is wide enough to be safe in both directions.
const CUT_HI = 250;
const CUT_LO = 236;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

// Undo the per-row filters PNG applies before deflating. Returns raw samples, bpp bytes per pixel.
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = raw.slice(pos, pos + stride); pos += stride;
    const o = y * stride, prev = (y === 0) ? null : out.slice((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = (x >= bpp) ? out[o + x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = row[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += ((a + b) >> 1);
      else if (ft === 4) v += paeth(a, b, c);
      else if (ft !== 0) return null;          // unknown filter: bail, caller keeps the original
      out[o + x] = v & 0xff;
    }
  }
  return out;
}

/**
 * Cut a white ground to transparency. Returns a new PNG buffer, or the ORIGINAL buffer unchanged if the
 * input is anything this cannot safely handle.
 */
function cutWhiteToAlpha(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) return buf;

    let p = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
    const idat = [];
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.slice(p + 4, p + 8).toString('ascii');
      const data = buf.slice(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; ctype = data[9]; interlace = data[12];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }

    // Only the shapes fal actually returns. Anything else keeps its original bytes.
    if (depth !== 8 || interlace !== 0) return buf;
    if (ctype !== 2 && ctype !== 6) return buf;
    if (!width || !height || !idat.length) return buf;
    // A guard against pathological sizes: 40 megapixels is far beyond any reference image.
    if (width * height > 40e6) return buf;

    const bpp = (ctype === 6) ? 4 : 3;
    const raw = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp);
    if (!raw) return buf;

    // Re-emit as RGBA with the ground cut away.
    const stride = width * 4;
    const out = Buffer.alloc(height * (stride + 1));
    let cut = 0;
    for (let y = 0; y < height; y++) {
      const so = y * width * bpp, doff = y * (stride + 1);
      out[doff] = 0;                                    // filter type 0: no prediction, simplest to verify
      for (let x = 0; x < width; x++) {
        const s = so + x * bpp, d = doff + 1 + x * 4;
        const r = raw[s], g = raw[s + 1], b = raw[s + 2];
        const a0 = (bpp === 4) ? raw[s + 3] : 255;
        const lo = Math.min(r, g, b);
        let a;
        if (lo >= CUT_HI) { a = 0; cut++; }
        else if (lo <= CUT_LO) a = 255;
        else a = Math.round(255 * (CUT_HI - lo) / (CUT_HI - CUT_LO));
        out[d] = r; out[d + 1] = g; out[d + 2] = b;
        out[d + 3] = Math.min(a0, a);                   // never make an already-transparent pixel opaque
      }
    }

    // If almost nothing was cut, the image had no white ground to begin with -- keep the original rather
    // than rewriting it for no reason and losing whatever else its chunks carried.
    if (cut < width * height * 0.02) return buf;

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ]);
  } catch (e) {
    // Fail-soft on purpose: a white box is cosmetic, a missing character is a broken book.
    console.error('cutWhiteToAlpha failed, keeping the original image:', e.message);
    return buf;
  }
}

// =====================================================================================================
// GROUND-BY-CONNECTIVITY ALPHA CUT (TD-357)
// =====================================================================================================
// cutWhiteToAlpha decides by COLOUR: bright enough is ground. That is right for character references,
// which are generated on a white ground and drawn in ink. It is WRONG for a built title.
//
// Ian sent six reference titles -- GALARE EMPIRE in silver, STARLESS KINGDOM in white, BLOOD CROWN in a
// red gradient, SPRING COURT in pale gold -- every one of them LIGHT LETTERING ON BLACK. A colour cut
// would erase the letters along with the sky. Those looks also only exist BECAUSE of the dark field:
// the metallic edges and the glow have nothing to sit against on white.
//
// So this decides by DISTANCE FROM THE MEASURED GROUND rather than by brightness. The reference point
// is read from the image itself, so gold on black, black on cream and a gradient all behave alike --
// which a fixed brightness threshold cannot do.
// v3.0.621: it also does NOT require a pixel to be reachable from the border. It used to, and that
// left a solid plug inside every closed letterform. See the note at the flood site below.
//
// THE SEED COLOUR IS THE FOUR CORNERS, not a constant, and it is a MEDIAN rather than an average: a
// single speckle in one corner -- and every one of Ian's references has gold flecks scattered over the
// black -- would drag a mean but cannot move a median.
//
// THE EDGE RAMP MATTERS MORE HERE THAN ANYWHERE. A hard in/out boundary leaves a jagged fringe on every
// antialiased letterform, which on a printed cover looks worse than the box it replaced. So a pixel is
// scored by DISTANCE from the ground colour: at or below NEAR it is ground, at or above FAR it is ink,
// and between them alpha ramps. v3.0.621 removed the extra condition that a pixel also be reachable
// from the border, because that is what kept a solid plug inside every closed letterform.
//
// FAIL-SOFT, exactly like its sibling: anything unexpected returns the original buffer. A title with a
// rectangle behind it is ugly; a title that fails to load is a broken cover.
const GROUND_NEAR = 26;    // within this distance of the ground colour: fully transparent
const GROUND_FAR  = 74;    // beyond this: fully opaque. Between: ramp. Measured against Ian's references,
                           // whose flecks sit far outside 74 and whose antialiasing sits inside it.
function cutGroundToAlpha(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) return buf;
    let p = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
    const idat = [];
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.slice(p + 4, p + 8).toString('ascii');
      const data = buf.slice(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; ctype = data[9]; interlace = data[12];
      } else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    if (depth !== 8 || interlace !== 0) return buf;
    if (ctype !== 2 && ctype !== 6) return buf;
    if (!width || !height || !idat.length) return buf;
    if (width * height > 40e6) return buf;

    const bpp = (ctype === 6) ? 4 : 3;
    const raw = unfilter(zlib.inflateSync(Buffer.concat(idat)), width, height, bpp);
    if (!raw) return buf;

    const at = (x, y) => (y * width + x) * bpp;
    const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
    const gr = med(corners.map(c => raw[at(c[0], c[1])]));
    const gg = med(corners.map(c => raw[at(c[0], c[1]) + 1]));
    const gb = med(corners.map(c => raw[at(c[0], c[1]) + 2]));
    const dist = (i) => {
      const dr = raw[i] - gr, dg = raw[i + 1] - gg, db = raw[i + 2] - gb;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };

    // v3.0.621 -- THE COUNTERS. Ian: "one thing you need to make sure you make transparent is the
    // closed spaces inside the lettering."
    //
    // WHAT WAS HERE AND WHY IT WAS WRONG. v3.0.618 flooded inward from the border and only made
    // REACHABLE pixels transparent. A counter -- the hole in an O, A, e, R -- is enclosed by ink, so
    // the flood can never reach it: every closed letterform kept a solid blob of ground colour inside
    // it, which over cover art is a black plug in every O. The harness even asserted it, on purpose,
    // to protect a pale shape sitting in the middle of a pale ground.
    //
    // THAT CASE CANNOT ARISE HERE. The prompt DEMANDS a flat solid black ground, so "a light shape
    // enclosed by ink that happens to match the sky" is not an input this function receives. The
    // connectivity test was guarding against something that does not happen, at the cost of the thing
    // that happens in almost every title.
    //
    // So the decision is now purely COLOUR DISTANCE from the measured ground: near it is ground
    // wherever it sits, enclosed or not. The median-corner seed and the edge ramp are unchanged --
    // they are what stop a gold fleck moving the reference point and what keep antialiased edges from
    // fringing.
    //
    // THE EXPOSURE THIS OPENS, stated rather than discovered: a letter's own black OUTLINE or drop
    // shadow on a black ground is also near-ground and will thin or vanish. The flood had the same
    // problem wherever an outline touched the sky; this makes it general. If outlines start
    // disappearing, the answer is a tighter GROUND_NEAR, not the return of the flood.

    const stride = width * 4;
    const out = Buffer.alloc(height * (stride + 1));
    let cut = 0;
    for (let y = 0; y < height; y++) {
      const doff = y * (stride + 1);
      out[doff] = 0;
      for (let x = 0; x < width; x++) {
        const s = at(x, y), d = doff + 1 + x * 4;
        const a0 = (bpp === 4) ? raw[s + 3] : 255;
        let a = 255;
        const dd = dist(s);
        if (dd <= GROUND_NEAR) { a = 0; cut++; }
        else if (dd < GROUND_FAR) a = Math.round(255 * (dd - GROUND_NEAR) / (GROUND_FAR - GROUND_NEAR));
        out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + 2];
        out[d + 3] = Math.min(a0, a);
      }
    }
    // Nothing meaningful removed means there was no ground to remove -- keep the original bytes rather
    // than rewriting the file and discarding whatever else its chunks carried.
    if (cut < width * height * 0.02) return buf;

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      PNG_SIG,
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
      chunk('IEND', Buffer.alloc(0))
    ]);
  } catch (e) {
    console.error('cutGroundToAlpha failed, keeping the original image:', e.message);
    return buf;
  }
}

module.exports = { cutWhiteToAlpha, cutGroundToAlpha, CUT_HI, CUT_LO, GROUND_NEAR, GROUND_FAR };
