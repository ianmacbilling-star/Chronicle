// ============================================================
// IMAGE METADATA RIGHTS CHECK -- v3.1.90, TD-979 (spec claude/UPLOAD_RIGHTS_CHECK_SPEC.md).
// ============================================================
//
// Ian, 2026-10-16: check uploaded pictures for watermarks and signatures; "Is there meta data we
// could also check?" -- "Yes. Check it on every upload path. This won't be perfect, but it'll be a
// good start."
//
// WHAT IT READS. The labels a picture can carry inside the file: EXIF (Artist, Copyright), IPTC
// (By-line, Credit, Source, Copyright Notice), XMP (dc:creator, dc:rights, photoshop:Credit,
// photoshop:Source, xmpRights:UsageTerms and WebStatement, plus:Licensor) and, where present, the
// C2PA Content Credentials block. JPEG, PNG and WebP.
//
// THE RULE (Ian's): a stock agency named anywhere in those labels is the metadata version of a
// watermark -> REJECT. Any other creator or copyright name is the metadata version of a signature ->
// WARN, because it may be a commissioned artist or the user's own camera.
//
// PURE AND FREE: Node builtins only, no AI, no network, no database. It must run on the ORIGINAL
// bytes, before anything re-saves the picture (HEIC conversion in middleware/uploadGuard.js, the panel
// upload's JPEG re-save), because a re-save drops all of this.
//
// LIMITS, said plainly: a screenshot or a social-media save carries no labels at all, so this adds to
// the visual check rather than replacing it. A parse fault answers "nothing found", never an error.
'use strict';
var zlib = require('zlib');

// Paid stock libraries and news photo agencies. Free-licence sites (Unsplash, Pexels, Pixabay) are
// deliberately NOT here: their pictures are free to use, so they are not refused; a named
// photographer on one still WARNS like any other copyright name.
var STOCK_AGENCIES = [
  ['getty', /\bgetty\s*images?\b|\bgettyimages\b/i, 'Getty Images'],
  ['istock', /\bistock(?:photo)?\b/i, 'iStock'],
  ['shutterstock', /\bshutterstock\b/i, 'Shutterstock'],
  ['adobestock', /\badobe\s*stock\b|\bstock\.adobe\.com\b/i, 'Adobe Stock'],
  ['fotolia', /\bfotolia\b/i, 'Fotolia'],
  ['alamy', /\balamy\b/i, 'Alamy'],
  ['dreamstime', /\bdreamstime\b/i, 'Dreamstime'],
  ['123rf', /\b123rf\b/i, '123RF'],
  ['depositphotos', /\bdepositphotos?\b/i, 'Depositphotos'],
  ['bigstock', /\bbigstock(?:photo)?\b/i, 'Bigstock'],
  ['canstock', /\bcan\s*stock\s*photo\b|\bcanstockphoto\b/i, 'Can Stock Photo'],
  ['stocksy', /\bstocksy\b/i, 'Stocksy'],
  ['pond5', /\bpond5\b/i, 'Pond5'],
  ['envato', /\benvato\b/i, 'Envato'],
  ['freepik', /\bfreepik\b/i, 'Freepik'],
  ['vecteezy', /\bvecteezy\b/i, 'Vecteezy'],
  ['corbis', /\bcorbis\b/i, 'Corbis'],
  ['ap', /\bassociated\s+press\b|\bap\s+photo\b/i, 'Associated Press'],
  ['reuters', /\breuters\b/i, 'Reuters'],
  ['afp', /\bafp\s+photo\b|\bagence\s+france[-\s]presse\b/i, 'AFP'],
  ['splash', /\bsplash\s+news\b/i, 'Splash News'],
  ['sciencephoto', /\bscience\s+photo\s+library\b/i, 'Science Photo Library']
];

function agencyIn(text) {
  var s = String(text || '');
  if (!s) return null;
  for (var i = 0; i < STOCK_AGENCIES.length; i++) if (STOCK_AGENCIES[i][1].test(s)) return STOCK_AGENCIES[i][2];
  return null;
}
// Inside a C2PA block the strings are CBOR, whose length byte for a short string is itself a letter
// ('a' to 'w'), so a word boundary before the name cannot be relied on there. The same patterns
// without their leading boundary.
var LOOSE = STOCK_AGENCIES.map(function (a) { return [new RegExp(a[1].source.replace(/(^|\|)\\b/g, '$1'), 'i'), a[2]]; });
function agencyInLoose(text) {
  var s = String(text || '');
  if (!s) return null;
  for (var i = 0; i < LOOSE.length; i++) if (LOOSE[i][0].test(s)) return LOOSE[i][1];
  return null;
}

function cleanVal(v) {
  return String(v == null ? '' : v).replace(/\u0000/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#169;|&copy;/g, '©').replace(/\s+/g, ' ').trim();
}

// A value that names nobody: empty, a bare copyright sign or word, or a placeholder.
function namesSomeone(v) {
  var s = cleanVal(v).replace(/^(?:©|\(c\)|copyright)\s*/i, '').replace(/\ball rights reserved\.?/i, '').trim();
  if (s.replace(/[^A-Za-zÀ-ɏ]/g, '').length < 2) return false;
  if (/^(?:unknown|none|n\/a|owner|user|author|artist|copyright|default|picasa|camera owner)$/i.test(s)) return false;
  return true;
}

// ---------------------------------------------------------------- TIFF (EXIF) ----------------
function readTiff(buf) {
  var out = { artist: [], copyright: [] };
  try {
    if (!buf || buf.length < 8) return out;
    var le = buf.toString('latin1', 0, 2) === 'II';
    if (!le && buf.toString('latin1', 0, 2) !== 'MM') return out;
    var u16 = function (o) { return le ? buf.readUInt16LE(o) : buf.readUInt16BE(o); };
    var u32 = function (o) { return le ? buf.readUInt32LE(o) : buf.readUInt32BE(o); };
    var ifd = u32(4);
    if (ifd + 2 > buf.length) return out;
    var n = u16(ifd);
    for (var i = 0; i < n && i < 400; i++) {
      var e = ifd + 2 + i * 12;
      if (e + 12 > buf.length) break;
      var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      var want = tag === 0x013B ? 'artist' : tag === 0x8298 ? 'copyright' : tag === 0x9C9D ? 'artist' : null;
      if (!want) continue;
      var size = type === 1 || type === 2 || type === 7 ? count : 0;
      if (!size || size > 4096) continue;
      var off = size <= 4 ? e + 8 : u32(e + 8);
      if (off + size > buf.length) continue;
      var raw = buf.slice(off, off + size);
      var val = tag === 0x9C9D ? raw.toString('utf16le') : raw.toString('utf8');
      // Copyright may hold "photographer\0editor" -- both count.
      val.split('\u0000').forEach(function (p) { if (cleanVal(p)) out[want].push(cleanVal(p)); });
    }
  } catch (e) { /* a broken EXIF block names nobody */ }
  return out;
}

// ---------------------------------------------------------------- IPTC IIM -------------------
function readIptc(buf) {
  var out = { artist: [], credit: [], source: [], copyright: [], usage: [] };
  try {
    for (var i = 0; i + 5 <= buf.length;) {
      if (buf[i] !== 0x1C) { i++; continue; }
      var rec = buf[i + 1], ds = buf[i + 2], len = buf.readUInt16BE(i + 3);
      if (len & 0x8000) break;   // extended length: not used for these short text fields
      var val = buf.slice(i + 5, i + 5 + len).toString('utf8');
      if (rec === 2) {
        if (ds === 80) out.artist.push(cleanVal(val));
        else if (ds === 110) out.credit.push(cleanVal(val));
        else if (ds === 115) out.source.push(cleanVal(val));
        else if (ds === 116) out.copyright.push(cleanVal(val));
        else if (ds === 40) out.usage.push(cleanVal(val));
      }
      i += 5 + len;
    }
  } catch (e) { /* ignore */ }
  return out;
}

// Photoshop "Photoshop 3.0" resource blocks: resource 0x0404 holds the IPTC IIM.
function readPhotoshop(buf) {
  try {
    var i = 14;   // after "Photoshop 3.0\0"
    while (i + 12 <= buf.length) {
      if (buf.toString('latin1', i, i + 4) !== '8BIM') break;
      var id = buf.readUInt16BE(i + 4);
      var nlen = buf[i + 6];
      var p = i + 7 + nlen;
      if ((nlen + 1) % 2) p++;
      if (p + 4 > buf.length) break;
      var size = buf.readUInt32BE(p);
      var data = buf.slice(p + 4, p + 4 + size);
      if (id === 0x0404) return readIptc(data);
      i = p + 4 + size + (size % 2);
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------- XMP -------------------------
var XMP_PROPS = {
  'dc:creator': 'artist', 'dc:rights': 'copyright', 'photoshop:Credit': 'credit', 'photoshop:Source': 'source',
  'photoshop:AuthorsPosition': null, 'xmpRights:UsageTerms': 'usage', 'xmpRights:WebStatement': 'usage',
  'plus:Licensor': 'credit', 'plus:LicensorName': 'credit', 'Iptc4xmpCore:CopyrightNotice': 'copyright',
  'xmpRights:Owner': 'copyright', 'photoshop:CaptionWriter': null
};
function readXmp(text) {
  var out = { artist: [], copyright: [], credit: [], source: [], usage: [] };
  var s = String(text || '');
  Object.keys(XMP_PROPS).forEach(function (prop) {
    var bucket = XMP_PROPS[prop];
    if (!bucket) return;
    var esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var attr = new RegExp('\\b' + esc + '="([^"]*)"', 'g');
    var m;
    while ((m = attr.exec(s))) if (cleanVal(m[1])) out[bucket].push(cleanVal(m[1]));
    var el = new RegExp('<' + esc + '\\b[^>]*>([\\s\\S]*?)</' + esc + '>', 'g');
    while ((m = el.exec(s))) {
      var inner = m[1];
      var lis = inner.match(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/g);
      if (lis) lis.forEach(function (li) { var v = cleanVal(li); if (v) out[bucket].push(v); });
      else if (cleanVal(inner)) out[bucket].push(cleanVal(inner));
    }
  });
  return out;
}

// ---------------------------------------------------------------- containers ------------------
function merge(into, part) {
  if (!part) return;
  Object.keys(part).forEach(function (k) {
    if (Array.isArray(part[k])) into[k] = (into[k] || []).concat(part[k].filter(Boolean));
  });
}

function walkJpeg(buf, acc) {
  var i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xFF) break;
    var marker = buf[i + 1];
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xDA || marker === 0xD9) break;   // start of scan: no labels after this
    var len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    var seg = buf.slice(i + 4, i + 2 + len);
    if (marker === 0xE1) {
      if (seg.toString('latin1', 0, 6) === 'Exif\u0000\u0000') merge(acc, readTiff(seg.slice(6)));
      else if (seg.toString('latin1', 0, 28) === 'http://ns.adobe.com/xap/1.0/') { acc.xmpText += seg.slice(29).toString('utf8'); }
    } else if (marker === 0xED) {
      if (seg.toString('latin1', 0, 13) === 'Photoshop 3.0') merge(acc, readPhotoshop(seg));
    } else if (marker === 0xEB) {
      acc.c2pa = acc.c2pa || /c2pa|jumb/i.test(seg.toString('latin1'));
      acc.c2paText += seg.toString('latin1');
    }
    i += 2 + len;
  }
}

function walkPng(buf, acc) {
  var i = 8;
  while (i + 12 <= buf.length) {
    var len = buf.readUInt32BE(i);
    var type = buf.toString('latin1', i + 4, i + 8);
    if (len > buf.length) break;
    var data = buf.slice(i + 8, i + 8 + len);
    if (type === 'IDAT' || type === 'IEND') { if (type === 'IEND') break; }
    else if (type === 'eXIf') merge(acc, readTiff(data));
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      var z = data.indexOf(0);
      var key = data.toString('latin1', 0, z < 0 ? 0 : z);
      var text = '';
      try {
        if (type === 'tEXt') text = data.slice(z + 1).toString('latin1');
        else if (type === 'zTXt') text = zlib.inflateSync(data.slice(z + 2)).toString('latin1');
        else {
          var flag = data[z + 1];
          var p = z + 3;
          p = data.indexOf(0, p) + 1;      // language tag
          p = data.indexOf(0, p) + 1;      // translated keyword
          text = flag ? zlib.inflateSync(data.slice(p)).toString('utf8') : data.slice(p).toString('utf8');
        }
      } catch (e) { text = ''; }
      if (key === 'XML:com.adobe.xmp') acc.xmpText += text;
      else if (/^(author|artist|creator)$/i.test(key)) acc.artist.push(cleanVal(text));
      else if (/^copyright$/i.test(key)) acc.copyright.push(cleanVal(text));
      else if (/^(source|credit)$/i.test(key)) acc.credit.push(cleanVal(text));
      else if (/^(disclaimer|warning)$/i.test(key)) acc.usage.push(cleanVal(text));
    } else if (type === 'caBX') {
      acc.c2pa = true;
      acc.c2paText += data.toString('latin1');
    }
    i += 12 + len;
  }
}

function walkWebp(buf, acc) {
  var i = 12;
  while (i + 8 <= buf.length) {
    var type = buf.toString('latin1', i, i + 4);
    var len = buf.readUInt32LE(i + 4);
    var data = buf.slice(i + 8, i + 8 + len);
    if (type === 'EXIF') merge(acc, readTiff(data.toString('latin1', 0, 6) === 'Exif\u0000\u0000' ? data.slice(6) : data));
    else if (type === 'XMP ') acc.xmpText += data.toString('utf8');
    i += 8 + len + (len % 2);
  }
}

// The fields found, for the record and for tests.
function readFields(buf) {
  var acc = { artist: [], copyright: [], credit: [], source: [], usage: [], xmpText: '', c2pa: false, c2paText: '' };
  try {
    if (!buf || buf.length < 12) return acc;
    if (buf[0] === 0xFF && buf[1] === 0xD8) walkJpeg(buf, acc);
    else if (buf.toString('latin1', 1, 4) === 'PNG') walkPng(buf, acc);
    else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') walkWebp(buf, acc);
    if (acc.xmpText) merge(acc, readXmp(acc.xmpText));
  } catch (e) { /* a broken file names nobody */ }
  ['artist', 'copyright', 'credit', 'source', 'usage'].forEach(function (k) {
    var seen = {};
    acc[k] = acc[k].map(cleanVal).filter(function (v) { if (!v || seen[v]) return false; seen[v] = 1; return true; });
  });
  return acc;
}

// The verdict. { verdict: 'ok'|'warn'|'reject', reasons: [{ source, kind, text }], fields }
function checkBuffer(buf) {
  var f = readFields(buf);
  var reasons = [];
  var all = [].concat(f.artist, f.copyright, f.credit, f.source, f.usage);
  var agency = null;
  for (var i = 0; i < all.length && !agency; i++) agency = agencyIn(all[i]);
  if (!agency && f.c2paText) agency = agencyInLoose(f.c2paText);
  if (!agency && f.xmpText) agency = agencyIn(f.xmpText);
  if (agency) {
    reasons.push({ source: 'metadata', kind: 'stock', text: 'The picture’s file details say it comes from ' + agency + ', a stock photo library.' });
  } else {
    var named = [].concat(f.artist, f.copyright, f.credit).filter(namesSomeone);
    if (named.length) {
      reasons.push({ source: 'metadata', kind: 'copyright', text: 'The picture’s file details name a creator or copyright holder: ' + named[0].slice(0, 120) + '.' });
    }
  }
  var verdict = agency ? 'reject' : (reasons.length ? 'warn' : 'ok');
  return { verdict: verdict, reasons: reasons, fields: { artist: f.artist, copyright: f.copyright, credit: f.credit, source: f.source, usage: f.usage, c2pa: !!f.c2pa } };
}

module.exports = { checkBuffer: checkBuffer, readFields: readFields, agencyIn: agencyIn, namesSomeone: namesSomeone, STOCK_AGENCIES: STOCK_AGENCIES };
