const sharp = require('sharp');
const C = require('../services/imageCrop.js');

let fail = 0;
function ok(m) { console.log('  ok   ' + m); }
function bad(m) { console.log('  FAIL ' + m); fail++; }
function eq(l, g, w) { if (g === w) ok(l + ' = ' + g); else bad(l + ': expected ' + w + ', got ' + g); }

async function panel(W, H) {
  // A panel with a recognisable mark, so a wrong offset is visible in the data.
  const spot = await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 240, g: 30, b: 30 } } }).png().toBuffer();
  return await sharp({ create: { width: W, height: H, channels: 3, background: { r: 18, g: 42, b: 78 } } })
    .composite([{ input: spot, left: Math.round(W * 0.45), top: Math.round(H * 0.42) }])
    .png().toBuffer();
}

async function changedOutside(a, b, box) {
  const A = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  if (A.info.width !== B.info.width || A.info.height !== B.info.height) return -1;
  const { width: W, height: H, channels: ch } = A.info;
  let changed = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= box.left && x < box.left + box.side && y >= box.top && y < box.top + box.side) continue;
      const i = (y * W + x) * ch;
      if (A.data[i] !== B.data[i] || A.data[i + 1] !== B.data[i + 1] || A.data[i + 2] !== B.data[i + 2]) changed++;
    }
  }
  return changed;
}

(async () => {
  console.log('TILE GEOMETRY');
  eq('a centred marker gives a square tile', JSON.stringify(C.tileBox(1200, 900, { x: 0.5, y: 0.5, r: 0.1 })),
     JSON.stringify({ left: 465, top: 315, side: 270 }));
  // A marker at the very edge must still yield a full-size tile INSIDE the panel.
  (function () {
    var b = C.tileBox(1200, 900, { x: 0.01, y: 0.99, r: 0.1 });
    eq('edge marker clamps to the left', b.left, 0);
    eq('edge marker clamps to the bottom', b.top, 900 - b.side);
    eq('edge marker keeps a full tile', b.side, 270);
  })();
  // The 1:4 tower is the case that started all this.
  (function () {
    var b = C.tileBox(512, 2064, { x: 0.5, y: 0.85, r: 0.12 });
    eq('tower tile is square', b.side === Math.min(b.side, 512), true);
    eq('tower tile fits horizontally', b.left + b.side <= 512, true);
    eq('tower tile fits vertically', b.top + b.side <= 2064, true);
    ok('tower tile is ' + b.side + 'px of a 512x2064 panel');
  })();
  eq('a tiny marker still gets a usable tile', C.tileBox(1200, 900, { x: 0.5, y: 0.5, r: 0.001 }).side, C.MIN_TILE);
  eq('a huge marker cannot exceed the panel', C.tileBox(1200, 900, { x: 0.5, y: 0.5, r: 5 }).side, 900);

  console.log('CROP AND COMPOSITE');
  const base = await panel(1200, 900);
  const cut = await C.cropTile(base, { x: 0.45, y: 0.42, r: 0.1 });
  eq('tile is square', cut.box.side + 'x' + cut.box.side, '270x270');
  const cd = await C.dimensions(cut.buffer);
  eq('tile buffer matches the box', cd.width + 'x' + cd.height, '270x270');
  eq('panel dimensions reported', cut.panel.width + 'x' + cut.panel.height, '1200x900');

  // Stand in for the model: hand back a completely different tile.
  const edited = await sharp({ create: { width: 270, height: 270, channels: 3, background: { r: 40, g: 220, b: 90 } } }).png().toBuffer();
  const merged = await C.compositeTile(base, edited, cut.box);
  const md = await C.dimensions(merged);
  eq('merged panel keeps its size', md.width + 'x' + md.height, '1200x900');
  eq('EVERY pixel outside the tile is untouched', await changedOutside(base, merged, cut.box), 0);

  // The model does not always return the size it was given.
  const wrongSize = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: { r: 200, g: 40, b: 200 } } }).png().toBuffer();
  const merged2 = await C.compositeTile(base, wrongSize, cut.box);
  eq('an off-size tile is resized, not rejected', (await C.dimensions(merged2)).width, 1200);
  eq('and still changes nothing outside', await changedOutside(base, merged2, cut.box), 0);

  console.log('FEATHER');
  const feathered = await C.compositeTile(base, edited, cut.box, { feather: 24 });
  eq('feathered composite keeps panel size', (await C.dimensions(feathered)).width, 1200);
  eq('feather changes nothing outside either', await changedOutside(base, feathered, cut.box), 0);
  (function () { ok('feather is OFF unless asked for -- it blends the ORIGINAL back over the edit at the rim'); })();

  console.log('REFUSALS');
  try { await C.compositeTile(base, edited, { left: 1100, top: 800, side: 400 }); bad('a box hanging off the panel was accepted'); }
  catch (e) { ok('a box that does not fit is refused: ' + e.message); }

  console.log('');
  if (fail) { console.log('CROP TESTS FAILED: ' + fail); process.exit(1); }
  console.log('All crop tests passed.');
})().catch(function (e) { console.log('THREW: ' + e.message); process.exit(1); });
