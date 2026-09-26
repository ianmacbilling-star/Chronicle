// v3.1.18 -- TD-911. CUT A FRAMED PART OUT OF A STORED PICTURE AND STORE IT AS A NEW PICTURE.
// Spec: claude/CROP_VIEW_SPEC.md.
//
// One place for every server-side crop the crop view asks for: Copy to Assets (free frame, v3.1.17,
// moved here from routes/assets.js) and the front and back cover picks (the cover's own shape,
// v3.1.18). The frame arrives as fractions and becomes pixels through cropMath.rectFromFrac, the twin
// of the page's arithmetic, measured on the real EXIF-oriented picture. The source is only READ.
// PNG stays PNG (so transparency survives); anything else is stored as JPEG.
'use strict';
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { fetchFile, uploadFile } = require('../storage/storage');
const { rectFromFrac } = require('./cropMath');

async function loadImageBytes(url) {
  const fromBucket = await fetchFile(url);                        // null in local disk mode
  if (fromBucket) return fromBucket;
  if (/^https?:\/\//i.test(url)) {
    const axios = require('axios');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: Infinity });
    return Buffer.from(resp.data);
  }
  return fs.readFileSync(path.join(__dirname, '../uploads', String(url).replace(/^.*\//, '')));
}

// o = { ratio (number or null), minSide, frac: {x, y, w, h}, maxSide, name }
// Returns { url, width, height } -- the stored size, after any shrink to maxSide.
async function cutAndStore(url, o) {
  const buf = await loadImageBytes(url);
  const meta = await sharp(buf, { failOn: 'none' }).metadata();
  const swap = (meta.orientation || 1) >= 5;
  const W = swap ? meta.height : meta.width, H = swap ? meta.width : meta.height;
  if (!W || !H) throw new Error('unreadable image');
  const f = o.frac;
  const rect = rectFromFrac(W, H, o.ratio, o.minSide, f.x, f.y, f.w, f.h);
  let pipe = sharp(buf, { failOn: 'none' }).rotate().extract(rect);
  if (Math.max(rect.width, rect.height) > o.maxSide) pipe = pipe.resize({ width: o.maxSide, height: o.maxSide, fit: 'inside' });
  const png = meta.format === 'png';
  const out = png ? await pipe.png().toBuffer({ resolveWithObject: true })
                  : await pipe.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  const name = o.name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + (png ? '.png' : '.jpg');
  const stored = await uploadFile(out.data, name, png ? 'image/png' : 'image/jpeg');
  return { url: stored, width: out.info.width, height: out.info.height };
}

module.exports = { loadImageBytes: loadImageBytes, cutAndStore: cutAndStore };
