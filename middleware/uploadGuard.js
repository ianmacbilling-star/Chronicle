// middleware/uploadGuard.js
//
// Single source of truth for which image types Chronicle accepts on upload,
// plus a wrapper that turns multer's rejections (wrong type, too large) into a
// clean JSON error instead of an unhandled 500 + busboy/multer stack dump in the
// logs. No DB, no app imports -- any route can require it safely.
//
// Accepted: JPG, PNG, WebP -- and, since v3.1.14, HEIC/HEIF (iPhone photos), which are converted
// to JPEG right here before any route sees them. GIF is intentionally excluded (indexed-colour /
// animated -- a poor fit for art references, generation input, and print PDFs).
//
// v3.1.14 -- TD-909. HEIC. Ian: "IS there any way we can support the .HEIC format? I'd like to
// support that everywhere" -- character and asset uploads. sharp, which we already ship, can READ a
// HEIC's header but cannot decode its pixels (its prebuilt libvips has no HEVC decoder; measured in
// the sandbox: "Support for this compression format has not been built in"). heic-convert (libheif
// compiled to WebAssembly, no native build) decodes it: a 4032x3024 iPhone-sized file came out as a
// JPEG in about 0.7s. It is required LAZILY, so a missing package costs HEIC uploads -- with a clear
// message -- and never the boot.
//
// THE CONVERSION RUNS IN guardUpload, AFTER multer and BEFORE the route. Every route that already
// wraps its multer in guardUpload therefore receives a JPEG it already knows how to handle, with no
// change to the route: characters, assets, and the Title Builder and marked-overlay uploads. That is
// the whole of "everywhere" on the server, by construction rather than by a list of call sites.

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const HEIC_MIME = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];
const MAX_BYTES = 5 * 1024 * 1024;

// HEIC files arrive with an honest type on a Mac or iPhone, but Chrome on Windows usually sends an
// EMPTY type (or application/octet-stream) for a .heic, because Windows has no registered MIME for
// it. So the file name counts as well, and the bytes decide in the end (see isHeicBuffer).
function looksHeic(mime, name) {
  const m = String(mime || '').toLowerCase();
  if (HEIC_MIME.indexOf(m) !== -1) return true;
  if ((m === '' || m === 'application/octet-stream') && /\.(heic|heif)$/i.test(String(name || ''))) return true;
  return false;
}

// The ISO-BMFF "ftyp" box: bytes 4-7 are "ftyp", 8-11 the major brand. HEVC-coded HEIF brands only;
// AVIF ("avif", "avis") is a different codec and stays unaccepted.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
function isHeicBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('latin1', 8, 12);
  if (HEIC_BRANDS.indexOf(brand) === -1) return false;
  if (brand === 'mif1' || brand === 'msf1') {
    // A generic HEIF brand: look for an HEVC compatible brand in the ftyp box, and never AVIF.
    const boxLen = Math.min(buf.readUInt32BE(0) || 0, 256, buf.length);
    const head = buf.toString('latin1', 16, boxLen);
    if (/avif|avis/.test(head)) return false;
    return /heic|heix|hevc|hevx/.test(head);
  }
  return true;
}

let _heicLib = null;
function heicLib() {
  if (_heicLib === null) {
    try { _heicLib = require('heic-convert'); }
    catch (e) { _heicLib = false; console.error('[heic] heic-convert is not installed: ' + (e && e.message)); }
  }
  return _heicLib;
}

// Buffer in, JPEG buffer out. Throws a CODED error the wrapper turns into a friendly line.
async function heicToJpeg(buf) {
  const lib = heicLib();
  if (!lib) { const e = new Error('HEIC support is not installed'); e.code = 'HEIC_UNAVAILABLE'; throw e; }
  try {
    const out = await lib({ buffer: buf, format: 'JPEG', quality: 0.92 });
    return Buffer.from(out);
  } catch (err) {
    const e = new Error('Could not decode HEIC: ' + (err && err.message)); e.code = 'HEIC_DECODE'; throw e;
  }
}

// Convert one multer file object in place: buffer, mimetype, size and name all describe the JPEG
// afterwards, so nothing downstream can tell it was ever anything else.
async function convertHeicFile(file) {
  if (!file || !file.buffer) return false;
  if (!(looksHeic(file.mimetype, file.originalname) || isHeicBuffer(file.buffer))) return false;
  if (!isHeicBuffer(file.buffer)) {
    // Named or typed as HEIC, but the bytes say otherwise -- refuse rather than guess.
    const e = new Error('Not a HEIC file'); e.code = 'UNSUPPORTED_TYPE'; throw e;
  }
  const t0 = Date.now();
  const jpeg = await heicToJpeg(file.buffer);
  const before = file.buffer.length;
  file.buffer = jpeg;
  file.size = jpeg.length;
  file.mimetype = 'image/jpeg';
  file.originalname = String(file.originalname || 'photo').replace(/\.(heic|heif)$/i, '') + '.jpg';
  file.heicConverted = true;
  console.log('[heic] converted ' + before + ' -> ' + jpeg.length + ' bytes in ' + (Date.now() - t0) + 'ms');
  return true;
}

// Every file multer left on the request, whether from .single(), .array() or .fields().
function filesOn(req) {
  const out = [];
  if (req && req.file) out.push(req.file);
  if (req && req.files) {
    if (Array.isArray(req.files)) req.files.forEach(function (f) { out.push(f); });
    else Object.keys(req.files).forEach(function (k) { (req.files[k] || []).forEach(function (f) { out.push(f); }); });
  }
  return out;
}

// multer fileFilter: accept whitelisted types, else reject with a CODED error so
// the wrapper maps it to a precise message. multer clears req.file on reject, so
// we stash the offending mimetype/name on the error for logging.
function imageFileFilter(req, file, cb) {
  if (ACCEPTED_MIME.indexOf(file.mimetype) !== -1) return cb(null, true);
  if (looksHeic(file.mimetype, file.originalname)) return cb(null, true);   // v3.1.14 -- converted in guardUpload
  const e = new Error('Unsupported image type');
  e.code = 'UNSUPPORTED_TYPE';
  e.rejectedMime = (file && file.mimetype) || '';
  e.rejectedName = (file && file.originalname) || '';
  cb(e);
}

// Map a multer/upload error to a friendly, user-facing line. Never leaks raw
// detail; unknown shapes fall back to a safe generic message.
// v3.1.14 -- maxMb: a route with a bigger limit than the default 5 MB says its own number.
function friendlyUploadMsg(err, maxMb) {
  const code = err && err.code;
  if (code === 'LIMIT_FILE_SIZE') return 'That image is too large -- the maximum size is ' + (maxMb || 5) + ' MB.';
  if (code === 'UNSUPPORTED_TYPE') return 'Please upload a JPG, PNG, WebP or HEIC (iPhone) image.';
  if (code === 'LIMIT_UNEXPECTED_FILE') return 'That was not an expected upload. Please try again.';
  if (code === 'HEIC_DECODE') return 'We could not read that iPhone (HEIC) photo. Try exporting it as a JPG and uploading that.';
  if (code === 'HEIC_UNAVAILABLE') return 'iPhone (HEIC) photos cannot be read right now. Please upload a JPG or PNG instead.';
  return 'Could not read your image. Please try a JPG, PNG, WebP or HEIC image.';
}

// Wrap a multer middleware so a rejection returns clean JSON (400) instead of
// falling through to Express's default 500 handler. Logs ONE greppable line
// ([upload-reject] type=... file=...) so we can see WHAT is being rejected in the
// server logs, replacing the multi-line stack dumps. `label` tags the route.
// v3.1.14 -- then converts any HEIC on the request to JPEG before the route runs.
function guardUpload(mw, label, maxMb) {
  return function(req, res, next) {
    function reject(err) {
      try {
        const f = (req && req.file) || null;
        const mt = err.rejectedMime || (f && f.mimetype) || 'unknown';
        const nm = err.rejectedName || (f && f.originalname) || '';
        console.warn('[upload-reject]' + (label ? ' route=' + label : '') +
          ' code=' + ((err && err.code) || 'THROWN') +
          ' type=' + mt + (nm ? ' file=' + nm : ''));
      } catch (_e) {}
      return res.status(400).json({ error: friendlyUploadMsg(err, maxMb) });
    }
    mw(req, res, function(err) {
      if (err) return reject(err);
      const files = filesOn(req);
      if (!files.length) return next();
      (async function () {
        for (let i = 0; i < files.length; i++) await convertHeicFile(files[i]);
      })().then(function () { next(); }, reject);
    });
  };
}

module.exports = { ACCEPTED_MIME, HEIC_MIME, MAX_BYTES, imageFileFilter, friendlyUploadMsg, guardUpload,
  looksHeic, isHeicBuffer, heicToJpeg, convertHeicFile };
