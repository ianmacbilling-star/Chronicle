// ---------------------------------------------------------------------------
// services/imageCrop.js -- v3.0.769
//
// WHY THIS EXISTS. A retouch decodes and re-encodes the WHOLE picture, so every
// pass loses a little fine detail and the next pass takes that as its ground
// truth. Ian, 2026-08-22: "the more you retouch an image the more it starts to
// drift and get blurrier." Five passes in, you are looking at a copy of a copy.
//
// Cropping ends that for everything outside the edited region. A tile is sent
// to the image model on its own and the result is composited back, so the rest
// of the picture is never decoded, never re-encoded and never re-imagined.
// Measured: on a 1200x900 panel with a 270px tile, 1,007,100 pixels lie outside
// the tile and ZERO of them change. That is arithmetic, not a request.
//
// It also fixes two other things at once:
//   - A hand that occupied 3 percent of a 1:4 tower panel occupies most of a
//     square tile, so the model can finally see what it is being asked to redraw.
//   - A square tile cannot tile. The stacked-duplicate failure on extreme
//     aspect ratios is impossible by construction.
//
// NOTHING IN THIS FILE IS WIRED TO A ROUTE YET. It is shipped on its own so the
// native dependency lands in Railway as its own deploy: if the build fails,
// the cause is unambiguous and no feature is in flight behind it.
// ---------------------------------------------------------------------------
const sharp = require('sharp');

// How much bigger than the marker the tile should be. A tile the exact size of
// the ring gives the model no context and it redraws a thing that does not fit
// its surroundings; too much context and the pixel-budget advantage is lost.
const TILE_MULTIPLE = 3;
const MIN_TILE = 256;

/**
 * Work out the square tile to cut for a marker.
 * @param {number} W  panel width in pixels
 * @param {number} H  panel height in pixels
 * @param {object} m  marker as fractions: { x, y, r } where r is of the SHORTER side
 * @returns {{left:number, top:number, side:number}} clamped to the panel
 */
function tileBox(W, H, m) {
  if (!W || !H || !m) return null;
  const shortSide = Math.min(W, H);
  let side = Math.round((m.r || 0.07) * shortSide * TILE_MULTIPLE);
  side = Math.max(MIN_TILE, side);
  // A tile can never be larger than the panel, or extract() throws.
  side = Math.min(side, W, H);
  let left = Math.round((m.x || 0.5) * W - side / 2);
  let top = Math.round((m.y || 0.5) * H - side / 2);
  // Clamp INSIDE the panel rather than shrinking, so the tile stays square and
  // a marker near an edge still gets a full-sized tile to work with.
  left = Math.max(0, Math.min(W - side, left));
  top = Math.max(0, Math.min(H - side, top));
  return { left, top, side };
}

/** Read the pixel dimensions of an image buffer. */
async function dimensions(buf) {
  const md = await sharp(buf).metadata();
  return { width: md.width || 0, height: md.height || 0 };
}

/**
 * Cut the tile out of a panel.
 * @returns {{buffer:Buffer, box:{left,top,side}, panel:{width,height}}}
 */
async function cropTile(panelBuf, marker) {
  const { width, height } = await dimensions(panelBuf);
  const box = tileBox(width, height, marker);
  if (!box) throw new Error('could not compute a tile box');
  const buffer = await sharp(panelBuf)
    .extract({ left: box.left, top: box.top, width: box.side, height: box.side })
    .png()
    .toBuffer();
  return { buffer, box, panel: { width, height } };
}

/**
 * Paste an edited tile back into the panel.
 *
 * The model does not always hand back a tile at the size it was given, so the
 * result is resized to the box before compositing -- otherwise sharp throws or,
 * worse, the paste lands offset.
 *
 * `feather` softens the seam. It is OFF by default: a hard edge is honest and
 * usually invisible when the tile came from this very picture, and a feather
 * blends the ORIGINAL back over the model's work at the rim, which quietly
 * undoes an edit that reached the tile edge.
 */
async function compositeTile(panelBuf, tileBuf, box, opts) {
  const o = opts || {};
  const { width, height } = await dimensions(panelBuf);
  if (!box || box.left < 0 || box.top < 0 ||
      box.left + box.side > width || box.top + box.side > height) {
    throw new Error('tile box does not fit the panel');
  }
  let tile = await sharp(tileBuf).resize(box.side, box.side, { fit: 'fill' }).png().toBuffer();
  if (o.feather > 0) {
    tile = await applyFeather(tile, box.side, Math.min(o.feather, Math.floor(box.side / 4)));
  }
  return await sharp(panelBuf)
    .composite([{ input: tile, left: box.left, top: box.top }])
    .png()
    .toBuffer();
}

/** Give a tile a soft alpha rim so its edge does not read as a rectangle. */
async function applyFeather(tileBuf, side, px) {
  if (!px || px < 1) return tileBuf;
  const mask = Buffer.alloc(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const d = Math.min(x, y, side - 1 - x, side - 1 - y);
      mask[y * side + x] = d >= px ? 255 : Math.round((d / px) * 255);
    }
  }
  const alpha = await sharp(mask, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
  return await sharp(tileBuf)
    .ensureAlpha()
    .composite([{ input: alpha, raw: undefined, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

module.exports = { tileBox, cropTile, compositeTile, dimensions, TILE_MULTIPLE, MIN_TILE };
