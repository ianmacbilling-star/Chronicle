const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// ============================================================
// STORAGE ABSTRACTION LAYER
// Uses Cloudflare R2 via HTTPS with AWS Signature V4
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

// AWS Signature V4
function signRequest(method, key, contentType, body) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = 'auto';
  const service = 's3';
  const host = accountId + '.r2.cloudflarestorage.com';

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
    host: host,
    path: '/' + BUCKET_NAME + '/' + key,
    headers: {
      'Authorization': authHeader,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Length': body.length
    }
  };
}

// Upload using Node's https module directly (avoids fetch SSL issues)
function httpsRequest(options, body) {
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: options.host,
      path: options.path,
      method: 'PUT',
      headers: options.headers,
      // Allow legacy SSL renegotiation for compatibility
      secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT
    }, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', function(e) { reject(e); });
    req.write(body);
    req.end();
  });
}

async function uploadFile(fileBuffer, filename, mimetype) {
  if (useCloud) {
    try {
      const key = 'uploads/' + filename;
      const signed = signRequest('PUT', key, mimetype, fileBuffer);

      console.log('  R2 uploading:', filename, '(' + fileBuffer.length + ' bytes)');

      const result = await httpsRequest(signed, fileBuffer);

      if (result.status !== 200) {
        console.error('  R2 upload failed:', result.status, result.body);
        throw new Error('R2 upload failed: ' + result.status + ' ' + result.body);
      }

      const url = (process.env.R2_PUBLIC_URL || '') + '/' + key;
      console.log('  R2 upload success:', url);
      return url;
    } catch(e) {
      console.error('R2 upload error:', e.message);
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
    if (!useCloud && fileUrl.startsWith('/uploads/')) {
      const filepath = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    // R2 delete - files are cheap to leave, skip for now
  } catch(e) {
    console.error('Storage delete error:', e.message);
  }
}

module.exports = { initStorage, uploadFile, deleteFile };
