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

async function uploadFile(fileBuffer, filename, mimetype) {
  if (useCloud) {
    try {
      const key = 'uploads/' + filename;
      const signed = signRequest('PUT', key, mimetype, fileBuffer);
      console.log('  R2 uploading to:', signed.url.substring(0, 60));

      const axios = require('axios');
      const response = await axios.put(signed.url, fileBuffer, {
        headers: signed.headers,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
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
  if (!fileUrl || useCloud) return; // Skip R2 deletes for now
  try {
    if (fileUrl.startsWith('/uploads/')) {
      const fp = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  } catch(e) { console.error('Delete error:', e.message); }
}

module.exports = { initStorage, uploadFile, deleteFile };
