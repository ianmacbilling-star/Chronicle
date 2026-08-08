const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let useCloud = false;
const BUCKET_NAME = 'chronicle-images';

function initStorage() {
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ID) {
    useCloud = true;
    console.log('  Storage: Cloudflare R2');
  } else {
    const uploadsDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('  Storage: Local filesystem');
  }
}

// v3.0.492 -- `extra` carries ADDITIONAL headers that must be signed as well as sent
// (today: x-amz-copy-source for a server-side copy). Passing nothing reproduces the
// previous canonical string byte for byte: the sorted header set for the no-extra case
// is content-type, host, x-amz-content-sha256, x-amz-date -- exactly the order this
// function used to hardcode. Building it from a sorted map instead of a literal is what
// lets a new signed header be added without a second copy of the signer, which is the
// fault class this codebase keeps paying for (TD-284, TD-293, TD-295, TD-296).
function signRequest(method, key, contentType, body, extra) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const host = accountId + '.r2.cloudflarestorage.com';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const hdrs = { 'content-type': contentType, 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (extra) Object.keys(extra).forEach(function (k) { hdrs[String(k).toLowerCase()] = String(extra[k]); });
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map(function (n) { return n + ':' + hdrs[n] + '\n'; }).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, '/' + BUCKET_NAME + '/' + key, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credentialScope + '\n' + crypto.createHash('sha256').update(canonicalRequest).digest('hex');

  function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const outHeaders = {
    'Authorization': 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    'Content-Type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'Content-Length': body.length
  };
  // Send every extra header with EXACTLY the value that was signed. A header that is
  // signed and not sent (or sent with a different value) is a SignatureDoesNotMatch.
  if (extra) Object.keys(extra).forEach(function (k) { outHeaders[String(k).toLowerCase()] = String(extra[k]); });

  return {
    url: 'https://' + host + '/' + BUCKET_NAME + '/' + key,
    headers: outHeaders
  };
}

async function uploadFile(fileBuffer, filename, mimetype, prefix) {
  prefix = prefix || 'uploads';
  if (useCloud) {
    try {
      const key = prefix + '/' + filename;
      const signed = signRequest('PUT', key, mimetype, fileBuffer);
      console.log('  R2 uploading to:', signed.url.substring(0, 60));

      const axios = require('axios');
      const https = require('https');
      const agent = new https.Agent({
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false
      });

      const response = await axios.put(signed.url, fileBuffer, {
        headers: signed.headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        httpsAgent: agent
      });

      const url = (process.env.R2_PUBLIC_URL || '') + '/' + key;
      console.log('  R2 success:', response.status, url);
      return url;
    } catch(e) {
      const msg = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data)) : e.message;
      console.error('R2 upload error:', msg);
      throw new Error('Image upload failed: ' + msg);
    }
  } else {
    const uploadsDir = path.join(__dirname, '../uploads');
    fs.writeFileSync(path.join(uploadsDir, filename), fileBuffer);
    return '/uploads/' + filename;
  }
}

// Turn a stored public URL back into a bucket key. Lifted out of deleteFile, which had this inline,
// so a read path can use the same derivation rather than a second copy that drifts.
function keyFromUrl(fileUrl) {
  if (!fileUrl) return null;
  const base = process.env.R2_PUBLIC_URL || '';
  if (base && fileUrl.indexOf(base) === 0) return fileUrl.slice(base.length).replace(/^\/+/, '');
  // v3.0.492 -- `story` added. It is a real prefix (publish-story has written under it since
  // v3.0.341) and this derivation did not know it, so a published book could not be resolved
  // back to a key unless R2_PUBLIC_URL matched the URL. Keep this list in step with every
  // prefix uploadFile is ever called with.
  const m = fileUrl.match(/\/((?:uploads|archives|optimized|story)\/[^?#]+)$/);
  return m ? m[1] : null;
}
// Read an object back OUT of the bucket. The bucket is private -- uploads are AWS-signed PUTs -- so a
// browser fetch of the stored URL fails CORS and, underneath that, authorisation. Every other PDF in
// the app is served from our own origin; this one was the exception, and it failed with nothing more
// useful than 'Failed to fetch'. Sign a GET and hand the bytes back so a route can stream them from
// our origin instead -- same-origin, behind requireAuth, no bucket CORS config to keep in step.
async function fetchFile(fileUrl) {
  if (!useCloud) return null;                       // local disk mode: the file is served statically
  const key = keyFromUrl(fileUrl);
  if (!key) return null;
  const axios = require('axios');   // required here, not at module scope -- see uploadFile
  const signed = signRequest('GET', key, 'application/octet-stream', Buffer.alloc(0));
  const res = await axios.get(signed.url, { headers: signed.headers, responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(res.data);
}
// v3.0.492 -- SERVER-SIDE COPY (TD-296).
// Duplicate an object that is ALREADY in our bucket under a new key, without the bytes
// travelling through this process. Publishing a book copies a 20-60MB PDF; pulling that
// down and pushing it back up would put the whole file in Node memory on the one route
// whose memory pressure has already crashed the process once (TD-293).
//
// Two paths, deliberately:
//   1. Native CopyObject -- a PUT to the destination carrying x-amz-copy-source. R2 does
//      the duplication internally. No egress, no memory, effectively instant.
//   2. Fallback: download and re-upload. Slower and memory-heavy, but it is the mechanism
//      archiveCopy and restoreCopy have used all along, so it is proven.
// The fallback exists because a copy that fails must not fail the PUBLISH. Anything that
// makes the fast path unavailable (a permissions change, a source in another bucket, an R2
// behaviour change) degrades to slow rather than to broken.
//
// Returns the new public URL. NOT fail-soft beyond the fallback: if both paths fail it
// throws, because a published story row pointing at a file that was never written is worse
// than a publish that reports an error.
async function copyObject(sourceUrl, filename, prefix) {
  if (!sourceUrl) throw new Error('No source object to copy');
  prefix = prefix || 'uploads';
  if (!useCloud) {
    // Local disk mode: read the file out of uploads/ and write it back under the new name.
    const srcName = String(sourceUrl).replace(/^.*\//, '');
    const uploadsDir = path.join(__dirname, '../uploads');
    const srcPath = path.join(uploadsDir, srcName);
    if (!fs.existsSync(srcPath)) throw new Error('Source object not found: ' + srcName);
    fs.copyFileSync(srcPath, path.join(uploadsDir, filename));
    return '/uploads/' + filename;
  }
  const srcKey = keyFromUrl(sourceUrl);
  if (!srcKey) throw new Error('Could not derive a bucket key from the source URL');
  const dstKey = prefix + '/' + filename;
  try {
    const body = Buffer.alloc(0);
    // The copy source is /<bucket>/<key>. It is signed AND sent, so both must be the same
    // string -- see the note in signRequest.
    const signed = signRequest('PUT', dstKey, 'application/octet-stream', body, {
      'x-amz-copy-source': '/' + BUCKET_NAME + '/' + srcKey
    });
    const axios = require('axios');
    const https = require('https');
    const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
    const resp = await axios.put(signed.url, body, { headers: signed.headers, httpsAgent: agent, timeout: 60000 });
    // CopyObject answers 200 with a CopyObjectResult body -- and S3 can report a FAILURE
    // inside a 200 body. Treat an Error element as a failure so it falls through rather
    // than recording a story row for an object that was never written.
    const bodyTxt = (resp && resp.data) ? String(resp.data) : '';
    if (bodyTxt.indexOf('<Error') >= 0) throw new Error('copy reported an error in a 200 body');
    const url = (process.env.R2_PUBLIC_URL || '') + '/' + dstKey;
    console.log('  R2 copied:', srcKey, '->', dstKey);
    return url;
  } catch (e) {
    const msg = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data)) : e.message;
    console.warn('  R2 server-side copy failed, falling back to download and re-upload:', msg);
    const buf = await fetchFile(sourceUrl);
    if (!buf || !buf.length) throw new Error('Copy fallback failed: could not read the source object');
    return await uploadFile(buf, filename, 'application/pdf', prefix);
  }
}

async function deleteFile(fileUrl) {
  if (!fileUrl) return;
  if (useCloud) {
    // Real R2 object delete. Derive the bucket key from the public URL.
    // v3.0.492 -- ONE derivation (keyFromUrl), not a second copy of it. This had its own
    // inline version that knew only uploads/ and archives/, so with R2_PUBLIC_URL unset it
    // silently refused to delete an optimized/ or story/ object -- unpublish-story left the
    // PDF in the bucket. keyFromUrl is a strict superset of what this did, so routing through
    // it can only widen what resolves. Same shape as TD-295: a rule consolidated in one place
    // with one caller never routed through it.
    try {
      const key = keyFromUrl(fileUrl);
      if (!key) { console.error('R2 delete: could not derive key from', fileUrl); return; }
      const body = Buffer.alloc(0);
      const signed = signRequest('DELETE', key, 'application/octet-stream', body);
      const axios = require('axios');
      const https = require('https');
      const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
      const resp = await axios.delete(signed.url, { headers: signed.headers, httpsAgent: agent });
      console.log('  R2 deleted:', resp.status, key);
    } catch(e) {
      const msg = e.response ? (e.response.status + ' ' + JSON.stringify(e.response.data)) : e.message;
      console.error('R2 delete error:', msg);
    }
    return;
  }
  // Local filesystem
  try {
    if (fileUrl.startsWith('/uploads/')) {
      const fp = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  } catch(e) { console.error('Delete error:', e.message); }
}

// releaseImage: reference-counted delete. Chronicle shares image URLs by
// reference — a player's fork copies the DM's image URL at fork time,
// character references are reused across snapshots, etc. — so one file may
// be pointed at by many rows. Only delete the underlying R2/local object
// once NO row anywhere still references it. Always non-fatal: an orphan is
// better than a broken user action. Pass the route's db (db.prepare(...)).
async function releaseImage(db, fileUrl) {
  if (!fileUrl) return;
  try {
    const checks = [
      ['SELECT 1 FROM moments WHERE image = ? LIMIT 1', [fileUrl]],
      ['SELECT 1 FROM session_characters WHERE reference_url = ? LIMIT 1', [fileUrl]],
      ['SELECT 1 FROM characters WHERE image = ? OR image_portrait = ? OR image_fullbody = ? OR image_action = ? OR image_other = ? OR canonical_reference_url = ? LIMIT 1',
        [fileUrl, fileUrl, fileUrl, fileUrl, fileUrl, fileUrl]],
      ['SELECT 1 FROM campaign_assets WHERE image_url = ? LIMIT 1', [fileUrl]],
      ['SELECT 1 FROM campaign_archives WHERE image_url = ? LIMIT 1', [fileUrl]],
      ['SELECT 1 FROM public_story_images WHERE image_url = ? LIMIT 1', [fileUrl]]
    ];
    for (let i = 0; i < checks.length; i++) {
      const row = await db.prepare(checks[i][0]).get(...checks[i][1]);
      if (row) return; // still referenced somewhere — keep the file
    }
    await deleteFile(fileUrl);
  } catch(e) {
    console.error('releaseImage error (left in place):', e.message);
  }
}

// persistToR2: download a remote (fal.media) image and re-host it in our
// own R2 bucket so it survives fal's ~24h CDN expiry. Returns the new R2
// URL, or — fail-soft — the original URL if the copy fails, so a storage
// hiccup never breaks (or double-charges) a successful generation. A rare
// fallback can be repaired later by a background sweep.
// v3.0.573 -- opts.cutWhite cuts a white ground to real alpha before storing (TD-362). Only the
// character reference path asks for it: those are generated on white BY SPEC (v3.0.559) and are the
// only images composited over one another. A scene image has a real background and must keep it.
async function persistToR2(remoteUrl, opts) {
  if (!remoteUrl) return remoteUrl;
  const base = process.env.R2_PUBLIC_URL || '';
  // Already one of ours (R2 public URL or local upload)? Don't re-copy.
  if ((base && remoteUrl.indexOf(base) === 0) || remoteUrl.indexOf('/uploads/') === 0) return remoteUrl;
  try {
    const axios = require('axios');
    const https = require('https');
    const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
    const resp = await axios.get(remoteUrl, {
      responseType: 'arraybuffer',
      httpsAgent: agent,
      timeout: 60000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    let buf = Buffer.from(resp.data);
    if (opts && opts.cutWhite) {
      // Fail-soft inside: returns the original bytes for anything it cannot safely handle.
      buf = require('./alpha').cutWhiteToAlpha(buf);
    }
    const ct = String(resp.headers['content-type'] || 'image/png').split(';')[0].trim();
    // v3.0.573 -- if the cut rewrote the image it is a PNG now whatever it arrived as, so the stored
    // content type has to follow the BYTES rather than the response header.
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const ct2 = isPng ? 'image/png' : ct;
    const ext = isPng ? 'png' : (ct.indexOf('jpeg') !== -1 ? 'jpg' : ct.indexOf('webp') !== -1 ? 'webp' : ct.indexOf('gif') !== -1 ? 'gif' : 'png');
    const filename = 'gen-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
    const url = await uploadFile(buf, filename, ct2);
    console.log('  Persisted to R2:', url);
    return url;
  } catch (e) {
    const msg = e.response ? (e.response.status + ' ' + e.message) : e.message;
    console.error('persistToR2 failed, keeping source URL:', msg);
    return remoteUrl;
  }
}

// archiveCopy: copy an existing image into the protected archives/ prefix
// so it survives regen/cleanup forever. NOT fail-soft — if the copy fails
// the archive must not be created (no point pointing it at a vanishing src).
async function archiveCopy(sourceUrl) {
  if (!sourceUrl) throw new Error('No source image to archive');
  const axios = require('axios');
  const https = require('https');
  const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
  const buf = Buffer.from(resp.data);
  const ct = String(resp.headers['content-type'] || 'image/png').split(';')[0].trim();
  const ext = ct.indexOf('jpeg') !== -1 ? 'jpg' : ct.indexOf('webp') !== -1 ? 'webp' : ct.indexOf('gif') !== -1 ? 'gif' : 'png';
  const filename = 'arch-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
  return await uploadFile(buf, filename, ct, 'archives');
}

// restoreCopy: copy an archived image (a protected archives/ object) into the
// LIVE uploads/ prefix as a FRESH object, so a panel/character can point at its
// own live image again while archives/ stays untouched. NOT fail-soft.
async function restoreCopy(sourceUrl) {
  if (!sourceUrl) throw new Error('No source image to restore');
  const axios = require('axios');
  const https = require('https');
  const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
  const buf = Buffer.from(resp.data);
  const ct = String(resp.headers['content-type'] || 'image/png').split(';')[0].trim();
  const ext = ct.indexOf('jpeg') !== -1 ? 'jpg' : ct.indexOf('webp') !== -1 ? 'webp' : ct.indexOf('gif') !== -1 ? 'gif' : 'png';
  const filename = 'rest-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
  return await uploadFile(buf, filename, ct);
}

module.exports = { initStorage, uploadFile, fetchFile, keyFromUrl, copyObject, deleteFile, releaseImage, persistToR2, archiveCopy, restoreCopy };
