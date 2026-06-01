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

function signRequest(method, key, contentType, body) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const host = accountId + '.r2.cloudflarestorage.com';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const canonicalHeaders = 'content-type:' + contentType + '\nhost:' + host + '\nx-amz-content-sha256:' + payloadHash + '\nx-amz-date:' + amzDate + '\n';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, '/' + BUCKET_NAME + '/' + key, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = dateStamp + '/auto/s3/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credentialScope + '\n' + crypto.createHash('sha256').update(canonicalRequest).digest('hex');

  function hmac(k, d) { return crypto.createHmac('sha256', k).update(d).digest(); }
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    url: 'https://' + host + '/' + BUCKET_NAME + '/' + key,
    headers: {
      'Authorization': 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Length': body.length
    }
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

async function deleteFile(fileUrl) {
  if (!fileUrl) return;
  if (useCloud) {
    // Real R2 object delete. Derive the bucket key from the public URL.
    try {
      const base = process.env.R2_PUBLIC_URL || '';
      let key = null;
      if (base && fileUrl.indexOf(base) === 0) {
        key = fileUrl.slice(base.length).replace(/^\/+/, '');
      } else {
        const m = fileUrl.match(/\/((?:uploads|archives)\/[^?#]+)$/);
        if (m) key = m[1];
      }
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
      ['SELECT 1 FROM campaign_archives WHERE image_url = ? LIMIT 1', [fileUrl]]
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
async function persistToR2(remoteUrl) {
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
    const buf = Buffer.from(resp.data);
    const ct = String(resp.headers['content-type'] || 'image/png').split(';')[0].trim();
    const ext = ct.indexOf('jpeg') !== -1 ? 'jpg' : ct.indexOf('webp') !== -1 ? 'webp' : ct.indexOf('gif') !== -1 ? 'gif' : 'png';
    const filename = 'gen-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.' + ext;
    const url = await uploadFile(buf, filename, ct);
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

module.exports = { initStorage, uploadFile, deleteFile, releaseImage, persistToR2, archiveCopy, restoreCopy };
