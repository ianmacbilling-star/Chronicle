// imageSize.js -- read pixel dimensions from an image Buffer by parsing the file
// header only (no full decode, no external dependency). Supports PNG, JPEG, GIF, and
// WebP (VP8/VP8L/VP8X). Returns { width, height } or null if it cannot be determined.
//
// WHY THIS EXISTS: the image model (nano-banana-2) returns width/height as NULL in its
// webhook, so the layout previously fell back to the NOMINAL shape aspect (e.g. every
// "Standard" panel treated as 4:3). But "Standard" can generate landscape OR portrait,
// so a portrait image forced into a 4:3 box gets cropped by object-fit:cover. Measuring
// the real bytes here lets us store true img_w/img_h so every image's box fits it exactly.

'use strict';

function readPng(buf) {
  // PNG signature 8 bytes, then IHDR: length(4) 'IHDR'(4) width(4) height(4)
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w > 0 && h > 0) return { width: w, height: h };
  return null;
}

function readGif(buf) {
  // 'GIF87a'/'GIF89a', then logical screen width(2 LE) height(2 LE)
  if (buf.length < 10) return null;
  if (buf[0] !== 0x47 || buf[1] !== 0x49 || buf[2] !== 0x46) return null;
  var w = buf.readUInt16LE(6), h = buf.readUInt16LE(8);
  if (w > 0 && h > 0) return { width: w, height: h };
  return null;
}

function readJpeg(buf) {
  // JPEG: starts FF D8. Walk the marker segments until a Start-Of-Frame (SOFn) whose
  // payload holds height(2) then width(2). Skip other markers by their length field.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  var off = 2, len = buf.length;
  while (off < len) {
    if (buf[off] !== 0xff) { off++; continue; }          // resync to next marker byte
    var marker = buf[off + 1];
    off += 2;
    // Standalone markers with no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (off + 2 > len) break;
    var segLen = buf.readUInt16BE(off);
    // SOF0..SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC) carry frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 7 > len) break;
      var h = buf.readUInt16BE(off + 3);
      var w = buf.readUInt16BE(off + 5);
      if (w > 0 && h > 0) return { width: w, height: h };
      return null;
    }
    off += segLen;   // skip this segment (length includes its own 2 bytes)
  }
  return null;
}

function readWebp(buf) {
  // RIFF....WEBP then a chunk: 'VP8 ' (lossy), 'VP8L' (lossless), or 'VP8X' (extended).
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  var fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    // Lossy: after 'VP8 '(4) size(4) frameTag(3) startCode(3) then width(2 LE, 14 bits) height(2 LE)
    var w = buf.readUInt16LE(26) & 0x3fff;
    var h = buf.readUInt16LE(28) & 0x3fff;
    if (w > 0 && h > 0) return { width: w, height: h };
  } else if (fourcc === 'VP8L') {
    // Lossless: 'VP8L'(4) size(4) signature(1=0x2f) then 14 bits width-1, 14 bits height-1.
    if (buf[20] !== 0x2f) return null;
    var b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    var wl = 1 + (((b1 & 0x3f) << 8) | b0);
    var hl = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    if (wl > 0 && hl > 0) return { width: wl, height: hl };
  } else if (fourcc === 'VP8X') {
    // Extended: 'VP8X'(4) size(4) flags(4) then canvasWidth-1(3 LE) canvasHeight-1(3 LE)
    var xw = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    var xh = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    if (xw > 0 && xh > 0) return { width: xw, height: xh };
  }
  return null;
}

// Return { width, height } for a supported image Buffer, or null.
function imageSize(buf) {
  if (!buf || !buf.length) return null;
  try {
    return readPng(buf) || readGif(buf) || readJpeg(buf) || readWebp(buf) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { imageSize };
