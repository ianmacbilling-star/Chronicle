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

module.exports = { cutWhiteToAlpha, CUT_HI, CUT_LO };
