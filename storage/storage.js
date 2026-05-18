const path = require('path');
const fs = require('fs');

// ============================================================
// STORAGE ABSTRACTION LAYER
// Uses Cloudflare R2 when env vars are set, local disk otherwise
// To swap providers: only change this file
// ============================================================

let useCloud = false;
let s3Client = null;
const BUCKET_NAME = 'chronicle-images';

function initStorage() {
  if (process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ACCOUNT_ID) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: 'auto',
      endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      },
      forcePathStyle: true,
      tls: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
    useCloud = true;
    console.log('  Storage: Cloudflare R2');
  } else {
    const uploadsDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    console.log('  Storage: Local filesystem');
  }
}

async function uploadFile(fileBuffer, filename, mimetype) {
  if (useCloud) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const key = 'uploads/' + filename;
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: mimetype
    }));
    return (process.env.R2_PUBLIC_URL || '') + '/' + key;
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
    if (useCloud && fileUrl.startsWith('http')) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const key = fileUrl.replace((process.env.R2_PUBLIC_URL || '') + '/', '');
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    } else if (!useCloud && fileUrl.startsWith('/uploads/')) {
      const filepath = path.join(__dirname, '..', fileUrl);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
  } catch(e) { console.error('Storage delete error:', e.message); }
}

module.exports = { initStorage, uploadFile, deleteFile };
