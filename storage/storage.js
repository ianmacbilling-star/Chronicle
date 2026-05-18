const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============================================================
// STORAGE ABSTRACTION LAYER
// Uses Cloudflare R2 via direct HTTP (avoids AWS SDK SSL issues)
// Falls back to local filesystem when R2 env vars not set
// ============================================================

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

// AWS Signature V4 for R2
function signRequest(method, key, contentType, body) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = 'auto';
  const service = 's3';
  const host = accountId + '.r2.cloudflarestorage.com';
  const endpoint = 'https://' + host + '/' + BUCKET_NAME + '/' + key;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const canonicalHeaders = 'content-type:' + contentType + '\n' +
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';

  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    '/' + BUCKET_NAME + '/' + key,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + credentialScope + '\n' +
    crypto.createHash('sha256').update(canonicalRequest).digest('hex');

  function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authHeader = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  return {
    url: endpoint,
    headers: {
      'Authorization': authHeader,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Length': body.length.toString()
    }
  };
}

async function uploadFile(fileBuffer, filename, mimetype) {
  if (useCloud) {
    try {
      const key = 'uploads/' + filename;
      const signed = signRequest('PUT', key, mimetype, fileBuffer);

      console.log('  R2 uploading:', filename, '(' + fileBuffer.length + ' bytes)');
      console.log('  R2 endpoint:', signed.url.substring(0, 60) + '...');

      const response = await fetch(signed.url, {
        method: 'PUT',
        headers: signed.headers,
        body: fileBuffer
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('  R2 upload failed:', response.status, text);
        throw new Error('R2 upload failed: ' + response.status + ' ' + text);
      }

      const url = (process.env.R2_PUBLIC_URL || '') + '/' + key;
      console.log('  R2 upload success:', url);
      return url;
    } catch(e) {
      console.error('R2 upload error:', e.message, e.cause ? JSON.stringify(e.cause) : '');
      throw e;
    }
  } else {
    const uploadsDir = path.join(__dirname, '../uploads');
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, fileBuffer);
    return '/uploads/' + filename;
  }
}

async function deleteFile(fileUrl) {
  if (!fileUrl) return;
  try {
    if (useCloud && fileUrl.includes('r2.dev')) {
      const key = fileUrl.replace((process.env.R2_PUBLIC_URL || '') + '/', '');
      const signed = signRequest('DELETE', key, 'application/octet-stream', Buffer.alloc(0));
      await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
    } else if (!useCloud && fileUrl.startsWith('/uploads/')) {
      const filepath = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
  } catch(e) {
    console.error('Storage delete error:', e.message);
  }
}

module.exports = { initStorage, uploadFile, deleteFile };
