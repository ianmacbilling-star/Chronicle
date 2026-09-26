// v3.1.17 -- TD-911. THE SERVER HALF OF THE CROP VIEW. Spec: claude/CROP_VIEW_SPEC.md.
//
// The page keeps a crop frame as FRACTIONS of the picture (x, y, w, h) and draws it with
// cropRectFromFrac in public/js/app.js. This is the same arithmetic, line for line, so the pixels
// stored are exactly the pixels the reader framed. The guard proves the two agree in both modes, and
// that the panel upload's own ownRectFromFrac (routes/moments.js, v3.1.16) gives the same answers.
//   ratio = a number -> the frame keeps that shape; w decides the size and h is ignored
//   ratio = null     -> free: w and h are independent
// Whatever arrives, the frame is kept inside the picture and no smaller than minSide.
'use strict';

function rectFromFrac(W, H, ratio, minSide, x, y, w, h) {
  var width, height;
  if (ratio) {
    var maxW = Math.min(W, Math.floor(H * ratio));
    var minW = Math.min(maxW, Math.max(1, ratio >= 1 ? minSide : Math.round(minSide * ratio)));
    width = Math.max(minW, Math.min(maxW, Math.round(w * W)));
    height = Math.max(1, Math.min(H, Math.round(width / ratio)));
  } else {
    width = Math.max(Math.min(minSide, W), Math.min(W, Math.round(w * W)));
    height = Math.max(Math.min(minSide, H), Math.min(H, Math.round(h * H)));
  }
  var left = Math.max(0, Math.min(W - width, Math.round(x * W)));
  var top = Math.max(0, Math.min(H - height, Math.round(y * H)));
  return { left: left, top: top, width: width, height: height };
}

// A frame from a request body, or null when there is none or it is not four finite numbers.
function readFrac(c) {
  if (!c || typeof c !== 'object') return null;
  var x = Number(c.x), y = Number(c.y), w = Number(c.w), h = Number(c.h);
  if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

module.exports = { rectFromFrac: rectFromFrac, readFrac: readFrac };
