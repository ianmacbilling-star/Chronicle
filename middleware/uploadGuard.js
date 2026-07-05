// middleware/uploadGuard.js
//
// Single source of truth for which image types Chronicle accepts on upload,
// plus a wrapper that turns multer's rejections (wrong type, too large) into a
// clean JSON error instead of an unhandled 500 + busboy/multer stack dump in the
// logs. No DB, no app imports -- any route can require it safely.
//
// Accepted: JPG, PNG, WebP. GIF is intentionally excluded (indexed-colour /
// animated -- a poor fit for art references, generation input, and print PDFs).

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

// multer fileFilter: accept whitelisted types, else reject with a CODED error so
// the wrapper maps it to a precise message. multer clears req.file on reject, so
// we stash the offending mimetype/name on the error for logging.
function imageFileFilter(req, file, cb) {
  if (ACCEPTED_MIME.indexOf(file.mimetype) !== -1) return cb(null, true);
  const e = new Error('Unsupported image type');
  e.code = 'UNSUPPORTED_TYPE';
  e.rejectedMime = (file && file.mimetype) || '';
  e.rejectedName = (file && file.originalname) || '';
  cb(e);
}

// Map a multer/upload error to a friendly, user-facing line. Never leaks raw
// detail; unknown shapes fall back to a safe generic message.
function friendlyUploadMsg(err) {
  const code = err && err.code;
  if (code === 'LIMIT_FILE_SIZE') return 'That image is too large -- the maximum size is 5 MB.';
  if (code === 'UNSUPPORTED_TYPE') return 'Please upload a JPG, PNG, or WebP image.';
  if (code === 'LIMIT_UNEXPECTED_FILE') return 'That was not an expected upload. Please try again.';
  return 'Could not read your image. Please try a JPG, PNG, or WebP image.';
}

// Wrap a multer middleware so a rejection returns clean JSON (400) instead of
// falling through to Express's default 500 handler. Logs ONE greppable line
// ([upload-reject] type=... file=...) so we can see WHAT is being rejected in the
// server logs, replacing the multi-line stack dumps. `label` tags the route.
function guardUpload(mw, label) {
  return function(req, res, next) {
    mw(req, res, function(err) {
      if (!err) return next();
      try {
        const f = (req && req.file) || null;
        const mt = err.rejectedMime || (f && f.mimetype) || 'unknown';
        const nm = err.rejectedName || (f && f.originalname) || '';
        console.warn('[upload-reject]' + (label ? ' route=' + label : '') +
          ' code=' + ((err && err.code) || 'THROWN') +
          ' type=' + mt + (nm ? ' file=' + nm : ''));
      } catch (_e) {}
      return res.status(400).json({ error: friendlyUploadMsg(err) });
    });
  };
}

module.exports = { ACCEPTED_MIME, MAX_BYTES, imageFileFilter, friendlyUploadMsg, guardUpload };
