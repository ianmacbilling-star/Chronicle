// routes/audio.js -- v3.6.09, TD-1046: TRANSCRIBE A RECORDING (first draft).
// Ian, 2026-11-13: "a button that is next to the File Upload button over the story field on the Story tab. It opens a little
// modal that allows you to drop or select a audio file. Then tell you based on its size roughly how many tokens it will cost.
// then transcript it into the story field"; "if we have to tell it who people are we can do it on the modal".
// Plan: claude/AUDIO_TRANSCRIPT_FAL_ROUTE.md (fal's ElevenLabs Scribe v2).
//
// How the file travels: the browser asks to start (checks, a job row), gets a short-lived signed PUT address into a PRIVATE
// bucket (AUDIO_BUCKET, else the holding bucket; never the public picture bucket) and uploads straight to it, so nothing passes
// through our server or Cloudflare's 100-second limit. The server then hands fal a signed GET address (1 hour). When the words
// come back (fal's webhook, or the page's polling as a safety net), the file is deleted at once, the words are kept on the job
// row, and the tokens are charged. A failed job charges nothing. The words are deleted once they are put into the Story box.
//
// Who may use it: admins always; everyone else only while app_settings.audio_transcribe_on is '1' (a draft, off by default).
// v3.6.13 (Ian, 2026-11-13: "it should not be admin only at this point"): open to everyone whose plan has it (Gold and up,
// planAllows); audio_transcribe_on = '0' is now only an off switch.
//
// v3.6.12 -- LONG RECORDINGS. fal's Scribe v2 takes at most 1200 s a request (a 422 "Audio duration exceeds the maximum allowed.
// Maximum is 1200 seconds", Ian's test, 2026-11-13). Ian: "go with it ... the users won't know the difference and doing it async
// might be quicker". Once the upload is in, our server (ffmpeg, one recording at a time) reads it straight from the bucket and
// makes one small speech-quality copy (mono, 16 kHz, 48 kbps mp3); the original is deleted at once. The copy is cut into parts of
// 19 minutes that overlap by 90 s; every part goes to fal at the same time. When all are back the words are joined in order: in each
// overlap the same words heard by both parts tie part 1's speaker labels to part 2's (stitchParts), and the join is made in the
// longest pause of the overlap so no word is doubled or lost. A speaker who says nothing in an overlap stays a separate speaker;
// the window then says one person may show up twice. A recording of 20 minutes or less is one part. Parts are deleted as their
// words come back; a failed part fails the job (nothing charged, every file deleted).
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, isAdminEmail, getCampaignRole } = require('../middleware/auth');
const { getEffectiveTier, accessRank } = require('../middleware/tiers');   // v3.6.13
const { getDb } = require('../database/db');
const storage = require('../storage/storage');

const ENDPOINT = 'fal-ai/elevenlabs/speech-to-text/scribe-v2';
const TOKENS_PER_HALF_HOUR = 4;   // 8 tokens an hour with keyterms (Ian, 2026-11-13: a token covers 8 cents; Scribe v2 + keyterms ~ $0.62 an hour)
const MAX_SECS = 6 * 3600;        // 6 hours (Ian, 2026-11-13)
const MAX_BYTES = 1536 * 1024 * 1024;
const PUT_SECS = 3600, GET_SECS = 3600;
const PART_SECS = 1140, OVERLAP_SECS = 90;   // v3.6.12: parts of 19 minutes overlapping by 90 s (fal's limit is 1200 s a request)
const PREP_STALE_MINS = 45;                  // a recording still being prepared after this long was lost (a restart): failed, nothing charged

function audioTokens(secs) { return TOKENS_PER_HALF_HOUR * Math.max(1, Math.ceil((Number(secs) || 0) / 1800 - 1e-9)); }
function audioBucket() { return String(process.env.AUDIO_BUCKET || '').trim() || storage.holdingBucket(); }

let tablesReady = null;
function ensureTables() {
  if (tablesReady) return tablesReady;
  tablesReady = (async function () {
    const db = await getDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audio_jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        campaign_id INTEGER,
        session_id INTEGER,
        status TEXT NOT NULL DEFAULT 'uploading',
        file_key TEXT,
        bucket TEXT,
        file_name TEXT,
        bytes BIGINT,
        secs_est REAL,
        tokens INTEGER,
        tokens_charged INTEGER,
        speakers_hint INTEGER,
        request_id TEXT,
        words TEXT,
        text_len INTEGER,
        error TEXT,
        consent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_audio_jobs_user ON audio_jobs(user_id, id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_audio_jobs_request ON audio_jobs(request_id)');
    // v3.6.12: the parts of a recording, and the recording's real length and number of parts.
    await db.exec('ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS secs_real REAL');
    await db.exec('ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS parts INTEGER');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audio_parts (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        offset_s REAL NOT NULL DEFAULT 0,
        len_s REAL,
        file_key TEXT,
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'cut',
        words TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_audio_parts_job ON audio_parts(job_id, idx)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_audio_parts_request ON audio_parts(request_id)');
  })().catch(function (e) { tablesReady = null; throw e; });
  return tablesReady;
}

async function audioOn(db, req) {
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (u && isAdminEmail(u.email)) return true;
  const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('audio_transcribe_on');
  return !(r && String(r.value) === '0');   // v3.6.13: on unless switched off
}

// v3.6.13 (Ian, 2026-11-13: "make this a Gold and up feature"; "Inheritable from the story master. So option 1"): the same
// test as the Writing Coach (wtAccess in routes/narrative.js): the campaign's effective plan has accessRank 3 or more -- Gold,
// Platinum and the Free Trial, and a member gets it from the Story Master's plan. The tokens are still the presser's. Admins
// always. The launch switch (audioOn) still comes first.
const PLAN_MSG = 'Audio Transcription comes with Gold and Platinum, and with any campaign whose Story Master has one of them.';
async function planAllows(db, req, campaignId) {
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (u && isAdminEmail(u.email)) return true;
  try { return accessRank(await getEffectiveTier(req.session.userId, campaignId)) >= 3; } catch (e) { return false; }
}

// A signed address (SigV4 query string) for one object of an R2 bucket: anyone holding it may do `method` on that key until
// it expires. Only the host header is signed and the payload is UNSIGNED-PAYLOAD, so the browser may send its own
// Content-Type. now (a Date) only for tests.
function presign(method, bucket, key, expiresSecs, now) {
  const accountId = process.env.R2_ACCOUNT_ID, accessKeyId = process.env.R2_ACCESS_KEY_ID, secretKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretKey) throw new Error('R2 is not set up on this server');
  const host = accountId + '.r2.cloudflarestorage.com';
  const amzDate = (now || new Date()).toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/auto/s3/aws4_request';
  const enc = function (s) { return encodeURIComponent(String(s)).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); };
  const uri = '/' + bucket + '/' + String(key).split('/').map(enc).join('/');
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': accessKeyId + '/' + scope, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expiresSecs), 'X-Amz-SignedHeaders': 'host' };
  const cq = Object.keys(q).sort().map(function (k) { return enc(k) + '=' + enc(q[k]); }).join('&');
  const creq = [method, uri, cq, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + crypto.createHash('sha256').update(creq).digest('hex');
  const hmac = function (k, d) { return crypto.createHmac('sha256', k).update(d).digest(); };
  const sk = hmac(hmac(hmac(hmac('AWS4' + secretKey, dateStamp), 'auto'), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', sk).update(sts).digest('hex');
  return 'https://' + host + uri + '?' + cq + '&X-Amz-Signature=' + sig;
}
// v3.6.12: everything that leaves this server goes through IO, so the tests can stand in for the bucket, fal and ffmpeg.
const IO = {
  url: function (bucket, key) { return presign('GET', bucket, key, GET_SECS); },
  put: async function (bucket, key, buf, type) {
    const axios = require('axios'), https = require('https');
    const r = await axios.put(presign('PUT', bucket, key, 900), buf, { headers: { 'Content-Type': type }, httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }), timeout: 180000, maxBodyLength: Infinity, maxContentLength: Infinity, validateStatus: function () { return true; } });
    if (r.status >= 300) throw new Error('storage refused a part (' + r.status + ')');
  },
  del: async function (bucket, key) {
    const axios = require('axios'), https = require('https');
    await axios.delete(presign('DELETE', bucket, key, 300), { httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }), timeout: 30000, validateStatus: function (s) { return s < 500; } });
  },
  submit: function (input, hook) { return falClient().queue.submit(ENDPOINT, { input: input, webhookUrl: hook }); },
  status: function (rid) { return falClient().queue.status(ENDPOINT, { requestId: rid, logs: false }); },
  result: function (rid) { return falClient().queue.result(ENDPOINT, { requestId: rid }); },
  run: function (cmd, args, ms) {
    return new Promise(function (resolve, reject) {
      require('child_process').execFile(cmd, args, { timeout: ms, maxBuffer: 8 * 1024 * 1024 }, function (err, out, errOut) {
        if (err) return reject(new Error(cmd + ' failed: ' + scrubUrls(String(errOut || '').trim().split('\n').slice(-3).join(' ') || err.message).slice(0, 400)));
        resolve(String(out || ''));
      });
    });
  }
};
function scrubUrls(s) { return String(s || '').replace(/https?:\/\/\S+/g, '(signed address)'); }

async function deleteAudio(job) {
  if (!job || !job.file_key) return;
  try {
    await IO.del(job.bucket || audioBucket(), job.file_key);
    audLog(job.user_id, 'info', 'delete', 'Job ' + job.id + ': recording deleted from ' + (job.bucket || audioBucket()) + '/' + job.file_key);
  } catch (e) { audLog(job.user_id, 'error', 'delete', 'Job ' + job.id + ': could not delete the recording ' + job.file_key + ': ' + (e && e.message)); }
}

function falClient() {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error('FAL_API_KEY is not set');
  require('./images').falSetup(key);
  return require('@fal-ai/client').fal;
}
function falWhy(e) {
  if (!e) return 'unknown error';
  const body = e.body || (e.response && e.response.data);
  try {
    const b = typeof body === 'string' ? JSON.parse(body) : body;
    if (b && Array.isArray(b.detail)) return b.detail.map(function (d) { return d && d.msg ? d.msg : JSON.stringify(d); }).join('; ').slice(0, 500);
    if (b && b.detail) return String(b.detail).slice(0, 500);
  } catch (x) {}
  return String((e && e.message) || e).slice(0, 500);
}
// v3.6.10 (Ian, 2026-11-13: "Show the real error and write everything you need to debug mode"): every step goes to the server
// log and, for a person with Debug Mode on, to their debug log (Dashboard > Support > View log). Never the recording's signed
// address and never the words of a transcript.
function audLog(userId, level, fn, message, detail) {
  try { console.log('[audio] ' + fn + ': ' + message + (detail ? ' ' + JSON.stringify(detail).slice(0, 4000) : '')); } catch (e) {}
  try { require('./debug').logDebug(userId, { level: level, source: 'audio', page: 'Story tab: Transcribe a recording', fn: fn, message: String(message).slice(0, 500), detail: detail || null }).catch(function () {}); } catch (e) {}
}
function audRefuse(req, res, fn, status, error, detail) {
  audLog(req.session && req.session.userId, 'warn', fn, 'Refused (' + status + '): ' + error, detail);
  return res.status(status).json({ error: error });
}
// fal's reasons from a refusal's payload (detail[]: msg and the field it is about), else its error line.
function falReasons(payload, error) {
  try {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const d = p && (Array.isArray(p.detail) ? p.detail : (p.detail ? [p.detail] : null));
    if (d && d.length) return d.map(function (x) { if (!x || typeof x !== 'object') return String(x); const loc = Array.isArray(x.loc) ? x.loc.filter(function (l) { return l !== 'body'; }).join('.') : ''; return (loc ? loc + ': ' : '') + (x.msg || JSON.stringify(x)); }).join('; ');
  } catch (e) {}
  return String(error || (payload ? JSON.stringify(payload) : 'unknown error'));
}
function webhookUrl() {
  let base = String(process.env.PUBLIC_BASE_URL || '');
  while (base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  return base ? base + '/api/audio/fal-webhook' : '';
}

// Names the recording is likely to contain: the campaign's characters, then the campaign and the session (keyterms, capped,
// each under 50 characters and at most 5 words, none of < > { } [ ] \).
async function keytermsFor(db, campaignId, sessionId) {
  const out = [];
  const add = function (s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length >= 50 || s.split(' ').length > 5 || /[<>{}\[\]\\]/.test(s)) return;
    if (out.map(function (x) { return x.toLowerCase(); }).indexOf(s.toLowerCase()) < 0) out.push(s);
  };
  try { (await db.prepare('SELECT name FROM characters WHERE campaign_id = ? ORDER BY id').all(campaignId)).forEach(function (r) { add(r.name); }); } catch (e) {}
  try { const c = await db.prepare('SELECT name FROM campaigns WHERE id = ?').get(campaignId); if (c) add(c.name); } catch (e) {}
  try { const s = await db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId); if (s) add(s.name); } catch (e) {}
  return out.slice(0, 100);
}

// The words, compact: [speaker, start, end, text, type] for every word and space (no sound tags).
function compactWords(words) {
  return (Array.isArray(words) ? words : []).filter(function (w) { return w && w.type !== 'audio_event' && typeof w.text === 'string'; })
    .map(function (w) { return [String(w.speaker_id == null ? 'speaker_0' : w.speaker_id), Number(w.start) || 0, Number(w.end) || 0, w.text, w.type === 'spacing' ? 's' : 'w']; });
}
// Turns: consecutive words of one speaker, broken at a pause of 2 s or more.
function turnsOf(cw) {
  const turns = [];
  let cur = null, lastEnd = 0;
  cw.forEach(function (w) {
    if (w[4] === 's') { if (cur) cur.text += w[3]; return; }
    if (!cur || cur.speaker !== w[0] || w[1] - lastEnd >= 2) { cur = { speaker: w[0], start: w[1], text: '' }; turns.push(cur); }
    cur.text += w[3];
    lastEnd = w[2];
  });
  turns.forEach(function (t) { t.text = t.text.replace(/\s+/g, ' ').trim(); });
  return turns.filter(function (t) { return t.text; });
}
function speakersOf(turns) {
  const by = {};
  turns.forEach(function (t) {
    const s = by[t.speaker] || (by[t.speaker] = { id: t.speaker, words: 0, samples: [] });
    s.words += t.text.split(' ').length;
    if (s.samples.length < 3 && t.text.split(' ').length >= 4) s.samples.push(t.text.length > 160 ? t.text.slice(0, 157) + '...' : t.text);
  });
  const list = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.words - a.words; });
  list.forEach(function (s, i) { s.label = 'Speaker ' + (i + 1); if (!s.samples.length) { const t = turns.filter(function (x) { return x.speaker === s.id; })[0]; if (t) s.samples.push(t.text.slice(0, 160)); } });
  return list;
}
// The text for the Story box: one paragraph per turn, "Name: what they said". names: { speaker_id: name }; a speaker whose
// name is '-' is left out; a blank name keeps "Speaker n".
function buildText(turns, speakers, names) {
  const label = {}; speakers.forEach(function (s) { label[s.id] = s.label; });
  const out = [];
  turns.forEach(function (t) {
    const n = names && Object.prototype.hasOwnProperty.call(names, t.speaker) ? String(names[t.speaker] || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (n === '-') return;
    const who = n || label[t.speaker] || 'Speaker';
    const last = out[out.length - 1];
    if (last && last.who === who) last.text += ' ' + t.text; else out.push({ who: who, text: t.text });
  });
  return out.map(function (p) { return p.who + ': ' + p.text; }).join('\n\n');
}

function jobView(job) {
  const v = { id: job.id, status: job.status, file_name: job.file_name, secs_est: job.secs_est, tokens: job.tokens, tokens_charged: job.tokens_charged, error: job.error || null, created_at: job.created_at, parts: Number(job.parts) || null };
  if (job.status === 'ready' && job.words) {
    try { const turns = turnsOf(JSON.parse(job.words)); v.speakers = speakersOf(turns); v.turns = turns.length; } catch (e) { v.speakers = []; }
  }
  return v;
}

// v3.6.14 (Ian, 2026-11-13: "The name you assign a person talking should (if it's a game session) match the Player Name on a
// character ... a drop down with player names in it or they can type in it"; "Just the player name"): the campaign's Player
// Names, for the name boxes of a ready job.
async function withPlayers(db, job) {
  const v = jobView(job);
  if (job.status !== 'ready') return v;
  try {
    const seen = {};
    v.players = (await db.prepare("SELECT player_name FROM characters WHERE campaign_id = ? AND player_name IS NOT NULL AND player_name <> '' ORDER BY id").all(job.campaign_id))
      .map(function (r) { return String(r.player_name).replace(/\s+/g, ' ').trim().slice(0, 80); })
      .filter(function (n) { const k = n.toLowerCase(); if (!n || seen[k]) return false; seen[k] = true; return true; })
      .sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
  } catch (e) { v.players = []; }
  return v;
}

async function chargeJob(db, job) {
  const claim = await db.prepare('UPDATE audio_jobs SET tokens_charged = 0 WHERE id = ? AND tokens_charged IS NULL').run(job.id);
  if (!claim.changes) return;
  try {
    const tk = require('./tokens');
    const bal = await tk.getBalance(job.user_id);
    const charged = Math.min(Number(job.tokens) || 0, Math.max(0, Number(bal.total) || 0));
    if (charged > 0) await tk.spendTokens(job.user_id, charged, { source: 'audio_transcript', event_type: 'generation_spend', related_campaign_id: job.campaign_id });
    try { await tk.recordGeneration(job.user_id, { event_type: 'audio_transcript', tokens_redeemed: charged, quantity: Math.round((Number(job.secs_real) || Number(job.secs_est) || 0) / 60), unit: 'minutes', model: 'scribe-v2', related_campaign_id: job.campaign_id, related_session_id: job.session_id }); } catch (e) {}
    await db.prepare('UPDATE audio_jobs SET tokens_charged = ? WHERE id = ?').run(charged, job.id);
  } catch (e) { audLog(job.user_id, 'error', 'charge', 'Job ' + job.id + ' charge failed: ' + (e && e.message)); }
}

// The words are in at fal: read them, keep them, delete the recording, charge. Claimed so a webhook and a poll never both do it.
async function finishJob(db, job, falError) {
  const claim = await db.prepare("UPDATE audio_jobs SET status = 'saving', updated_at = NOW() WHERE id = ? AND status = 'transcribing'").run(job.id);
  if (!claim.changes) return;
  let data = null, err = falError || null;
  if (!err) {
    try { const r = await falClient().queue.result(ENDPOINT, { requestId: job.request_id }); data = r && (r.data || r); }
    catch (e) { err = 'fal: ' + falWhy(e); audLog(job.user_id, 'error', 'result', 'Job ' + job.id + ': reading the result from fal failed', { request_id: job.request_id, message: e && e.message, status: e && (e.status || (e.response && e.response.status)), body: (e && (e.body || (e.response && e.response.data))) || null }); }   // v3.6.10
  }
  await deleteAudio(job);
  if (err || !data) {
    await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run(String(err || 'no result').slice(0, 1000), job.id);
    audLog(job.user_id, 'error', 'finish', 'Job ' + job.id + ' failed: ' + err);
    return;
  }
  const cw = compactWords(data.words);
  if (!cw.some(function (w) { return w[4] === 'w'; })) {
    await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run('No speech was found in that recording.', job.id);
    audLog(job.user_id, 'warn', 'finish', 'Job ' + job.id + ': no speech found', { entries: Array.isArray(data.words) ? data.words.length : null, language: data.language_code || null });
    return;
  }
  await db.prepare("UPDATE audio_jobs SET status = 'ready', words = ?, text_len = ?, updated_at = NOW() WHERE id = ?").run(JSON.stringify(cw), String(data.text || '').length, job.id);
  { const sp = {}; cw.forEach(function (w) { if (w[4] === 'w') sp[w[0]] = (sp[w[0]] || 0) + 1; });
    audLog(job.user_id, 'info', 'finish', 'Job ' + job.id + ' ready', { words: cw.filter(function (w) { return w[4] === 'w'; }).length, speakers: sp, language: data.language_code || null, language_probability: data.language_probability || null, last_word_end_s: cw.length ? cw[cw.length - 1][2] : null, secs_est: job.secs_est }); }
  await chargeJob(db, job);
}

// v3.6.12 -- THE PARTS. planParts: where each part starts and how long it is (seconds), for a recording of dur seconds.
function planParts(dur) {
  dur = Number(dur) || 0;
  if (dur <= PART_SECS + 50) return [{ idx: 0, offset: 0, len: dur }];
  const out = [], step = PART_SECS - OVERLAP_SECS;
  for (let s = 0; s + OVERLAP_SECS < dur; s += step) out.push({ idx: out.length, offset: s, len: Math.min(PART_SECS, dur - s) });
  return out;
}
function normWord(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9']/g, ''); }
// Joins the parts' words (compact, times from the start of each part) into one list for the whole recording. In each overlap a
// word heard by both parts (the same word within 0.6 s) is a vote that their two speaker labels are one person; a pair with 3 or
// more votes, the strongest first and each label used once, is tied. Then the fill-in: once as many people have been heard as
// the busiest part holds, a part left with exactly one unmatched voice (20+ words) and exactly one known person missing from it
// ties those two (someone silent through the overlap). A newcomer while everyone known is present stays new. The join is made
// in the longest pause of the overlap.
// Speakers come out as speaker_0, speaker_1, ... in the order they first speak.
function stitchParts(parts) {
  parts = parts.slice().sort(function (a, b) { return a.idx - b.idx; });
  const P = parts.map(function (p) { return (p.words || []).map(function (w) { return ['p' + p.idx + ':' + w[0], w[1] + p.offset, w[2] + p.offset, w[3], w[4]]; }); });
  const parent = {};
  const find = function (l) { while (parent[l] && parent[l] !== l) l = parent[l]; return l; };
  const ties = [];
  let fills = 0;
  const counts = P.map(function (ws) { const c = {}; ws.forEach(function (w) { if (w[4] === 'w') c[w[0]] = (c[w[0]] || 0) + 1; }); return c; });
  const big = function (c) { return Object.keys(c).filter(function (l) { return c[l] >= 20; }); };
  const people = Math.max.apply(null, counts.map(function (c) { return big(c).length; }).concat([0]));
  let out = [], from = -Infinity;
  for (let k = 0; k < P.length; k++) {
    let upto = Infinity;
    if (k + 1 < P.length) {
      const a = P[k], b = P[k + 1];
      const lo = parts[k + 1].offset, hi = parts[k].offset + parts[k].len;
      const bw = b.filter(function (w) { return w[4] === 'w' && w[1] < hi + 1; });
      const votes = {};
      a.forEach(function (w) {
        if (w[4] !== 'w' || w[1] < lo - 1) return;
        const n = normWord(w[3]);
        if (!n) return;
        let best = null, bd = 0.6;
        bw.forEach(function (x) { const d = Math.abs(x[1] - w[1]); if (d < bd && normWord(x[3]) === n) { best = x; bd = d; } });
        if (best) { const key = w[0] + '|' + best[0]; votes[key] = (votes[key] || 0) + 1; }
      });
      const pairs = Object.keys(votes).map(function (key) { const ab = key.split('|'); return { a: ab[0], b: ab[1], n: votes[key] }; }).sort(function (x, y) { return y.n - x.n; });
      const usedA = {}, usedB = {};
      pairs.forEach(function (p) { if (p.n < 3 || usedA[p.a] || usedB[p.b]) return; usedA[p.a] = usedB[p.b] = true; parent[p.b] = p.a; ties.push(p); });
      const known = {};
      for (let q = 0; q <= k; q++) big(counts[q]).forEach(function (l) { known[find(l)] = true; });
      const nb = big(counts[k + 1]), present = {};
      nb.forEach(function (l) { if (parent[l]) present[find(l)] = true; });
      const loose = nb.filter(function (l) { return !parent[l]; }), missing = Object.keys(known).filter(function (x) { return !present[x]; });
      if (loose.length === 1 && missing.length === 1 && Object.keys(known).length >= people) { parent[loose[0]] = missing[0]; fills++; }
      const aw = a.filter(function (w) { return w[4] === 'w'; });
      let cut = (lo + hi) / 2, gap = -1;
      for (let i = 0; i + 1 < aw.length; i++) {
        const g0 = aw[i][2], g1 = aw[i + 1][1], mid = (g0 + g1) / 2;
        if (mid < lo + 5 || mid > hi - 5) continue;
        if (g1 - g0 > gap) { gap = g1 - g0; cut = mid; }
      }
      upto = cut;
    }
    P[k].forEach(function (w) { if (w[1] >= from && w[1] < upto) out.push(w); });
    from = upto;
  }
  const names = {};
  let n = 0;
  out = out.map(function (w) { const r = find(w[0]); if (!Object.prototype.hasOwnProperty.call(names, r)) names[r] = 'speaker_' + (n++); return [names[r], w[1], w[2], w[3], w[4]]; });
  return { words: out, ties: ties.length, fills: fills, speakers: n };
}

// A job that cannot finish: failed, nothing charged, the recording and every part deleted.
async function failJob(db, job, why) {
  await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ? AND status IN ('uploading', 'preparing', 'transcribing', 'saving')").run(String(why || 'unknown error').slice(0, 1000), job.id);
  audLog(job.user_id, 'error', 'fail', 'Job ' + job.id + ' failed: ' + why);
  const fresh = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id);
  if (fresh && fresh.file_key) { await deleteAudio(fresh); await db.prepare('UPDATE audio_jobs SET file_key = NULL WHERE id = ?').run(job.id); }
  const parts = await db.prepare('SELECT * FROM audio_parts WHERE job_id = ? AND file_key IS NOT NULL').all(job.id);
  for (const p of parts) await deletePart(db, job, p);
}
async function deletePart(db, job, p) {
  if (!p.file_key) return;
  try {
    await IO.del(job.bucket || audioBucket(), p.file_key);
    await db.prepare('UPDATE audio_parts SET file_key = NULL WHERE id = ?').run(p.id);
    audLog(job.user_id, 'info', 'delete', 'Job ' + job.id + ': part ' + (p.idx + 1) + ' deleted from storage');
  } catch (e) { audLog(job.user_id, 'error', 'delete', 'Job ' + job.id + ': could not delete part ' + (p.idx + 1) + ' (' + p.file_key + '): ' + (e && e.message)); }
}

// One recording is prepared at a time on this server (ffmpeg is heavy); the rest wait their turn.
let prepChain = Promise.resolve();
function queuePrep(jobId) {
  prepChain = prepChain.then(function () { return prepareJob(jobId); }).catch(function (e) { console.error('[audio] prepare error:', e && e.message); });
  return prepChain;
}
async function prepareJob(jobId) {
  const db = await getDb();
  const job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'preparing') return;
  await db.prepare('UPDATE audio_jobs SET updated_at = NOW() WHERE id = ?').run(job.id);
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aud-'));
  const bucket = job.bucket || audioBucket();
  try {
    const all = path.join(dir, 'all.mp3');
    const t0 = Date.now();
    audLog(job.user_id, 'info', 'prepare', 'Job ' + job.id + ': making the speech copy');
    await IO.run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-i', IO.url(bucket, job.file_key), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', all], 45 * 60 * 1000);
    await deleteAudio(job);
    await db.prepare('UPDATE audio_jobs SET file_key = NULL WHERE id = ?').run(job.id);
    job.file_key = null;
    const dur = parseFloat(String(await IO.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', all], 60000)).trim());
    if (!(dur > 1)) throw new Error('No sound could be read from that recording.');
    if (dur > MAX_SECS + 60) throw new Error('That recording is longer than 6 hours. Split it and transcribe each part.');
    const plan = planParts(dur);
    audLog(job.user_id, 'info', 'prepare', 'Job ' + job.id + ': speech copy made', { secs: Math.round(dur), secs_est: job.secs_est, bytes: fs.statSync(all).size, took_s: Math.round((Date.now() - t0) / 1000), parts: plan.length });
    await db.prepare('UPDATE audio_jobs SET secs_real = ?, parts = ?, updated_at = NOW() WHERE id = ?').run(dur, plan.length, job.id);
    const hex = crypto.randomBytes(16).toString('hex');
    for (const p of plan) {
      const f = path.join(dir, 'p' + p.idx + '.mp3');
      await IO.run('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', '-ss', p.offset.toFixed(3), '-t', p.len.toFixed(3), '-i', all, '-c', 'copy', f], 10 * 60 * 1000);
      const key = 'audio-in/' + hex + '-p' + p.idx + '.mp3';
      await IO.put(bucket, key, fs.readFileSync(f), 'audio/mpeg');
      await db.prepare("INSERT INTO audio_parts (job_id, idx, offset_s, len_s, file_key, status) VALUES (?, ?, ?, ?, ?, 'cut')").run(job.id, p.idx, p.offset, p.len, key);
      try { fs.unlinkSync(f); } catch (e) {}
    }
    const hook = webhookUrl();
    if (!hook) throw new Error('PUBLIC_BASE_URL is not set, so fal cannot report back.');
    const terms = await keytermsFor(db, job.campaign_id, job.session_id);
    const parts = await db.prepare('SELECT * FROM audio_parts WHERE job_id = ? ORDER BY idx').all(job.id);
    const base = { diarize: true, tag_audio_events: false };
    if (terms.length) base.keyterms = terms;
    if (job.speakers_hint) base.num_speakers = job.speakers_hint;
    audLog(job.user_id, 'info', 'prepare', 'Job ' + job.id + ': sending ' + parts.length + ' part(s) to fal', { endpoint: ENDPOINT, input: Object.assign({ audio_url: '(signed address, 1 hour)' }, base), webhook: hook });
    const refused = (await Promise.all(parts.map(async function (p) {
      try {
        const sub = await IO.submit(Object.assign({ audio_url: IO.url(bucket, p.file_key) }, base), hook);
        await db.prepare("UPDATE audio_parts SET status = 'sent', request_id = ?, updated_at = NOW() WHERE id = ?").run(sub.request_id, p.id);
        return null;
      } catch (e) {
        audLog(job.user_id, 'error', 'prepare', 'Job ' + job.id + ': fal refused part ' + (p.idx + 1) + ': ' + falWhy(e), { message: e && e.message, status: e && (e.status || (e.response && e.response.status)), body: (e && (e.body || (e.response && e.response.data))) || null });
        return 'part ' + (p.idx + 1) + ': ' + falWhy(e);
      }
    }))).filter(Boolean);
    if (refused.length) throw new Error('The transcription service refused it (' + refused[0] + ')');
    await db.prepare("UPDATE audio_jobs SET status = 'transcribing', updated_at = NOW() WHERE id = ? AND status = 'preparing'").run(job.id);
    audLog(job.user_id, 'info', 'prepare', 'Job ' + job.id + ': all ' + parts.length + ' part(s) sent to fal', { keyterms: terms.length });
    await checkJob(db, job.id);   // a part may already be back
  } catch (e) {
    await failJob(db, job, scrubUrls(e && e.message));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}
// One part's words are in at fal (or it failed). Claimed so a webhook and a poll never both do it.
async function finishPart(db, part, falError) {
  const claim = await db.prepare("UPDATE audio_parts SET status = 'saving', updated_at = NOW() WHERE id = ? AND status = 'sent'").run(part.id);
  if (!claim.changes) return;
  const job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(part.job_id);
  const live = !!(job && (job.status === 'preparing' || job.status === 'transcribing'));
  let data = null, err = falError || null;
  if (!err && live) {
    try { const r = await IO.result(part.request_id); data = r && (r.data || r); }
    catch (e) { err = 'fal: ' + falWhy(e); audLog(job.user_id, 'error', 'result', 'Job ' + job.id + ': reading part ' + (part.idx + 1) + ' from fal failed', { request_id: part.request_id, message: e && e.message, status: e && (e.status || (e.response && e.response.status)), body: (e && (e.body || (e.response && e.response.data))) || null }); }
  }
  if (job) await deletePart(db, job, part);
  if (!live) { await db.prepare("UPDATE audio_parts SET status = 'dropped', updated_at = NOW() WHERE id = ?").run(part.id); return; }
  if (err || !data) {
    await db.prepare("UPDATE audio_parts SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run(String(err || 'no result').slice(0, 1000), part.id);
    await failJob(db, job, (Number(job.parts) > 1 ? 'Part ' + (part.idx + 1) + ' of ' + job.parts + ': ' : '') + (err || 'no result'));
    return;
  }
  const cw = compactWords(data.words);
  await db.prepare("UPDATE audio_parts SET status = 'done', words = ?, updated_at = NOW() WHERE id = ?").run(JSON.stringify(cw), part.id);
  audLog(job.user_id, 'info', 'finish', 'Job ' + job.id + ': part ' + (part.idx + 1) + ' back', { words: cw.filter(function (w) { return w[4] === 'w'; }).length, language: data.language_code || null, language_probability: data.language_probability || null });
  await checkJob(db, job.id);
}
// Every part is back: join them, keep the words, charge.
async function checkJob(db, jobId) {
  const parts = await db.prepare('SELECT id, idx, offset_s, len_s, status, words FROM audio_parts WHERE job_id = ? ORDER BY idx').all(jobId);
  if (!parts.length || parts.some(function (p) { return p.status !== 'done'; })) return;
  const claim = await db.prepare("UPDATE audio_jobs SET status = 'saving', updated_at = NOW() WHERE id = ? AND status = 'transcribing'").run(jobId);
  if (!claim.changes) return;
  const job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(jobId);
  let st;
  try { st = stitchParts(parts.map(function (p) { return { idx: Number(p.idx), offset: Number(p.offset_s) || 0, len: Number(p.len_s) || 0, words: JSON.parse(p.words || '[]') }; })); }
  catch (e) { await db.prepare("UPDATE audio_jobs SET status = 'transcribing' WHERE id = ?").run(jobId); await failJob(db, job, 'Joining the parts failed: ' + (e && e.message)); return; }
  const cw = st.words;
  await db.prepare('UPDATE audio_parts SET words = NULL WHERE job_id = ?').run(jobId);
  if (!cw.some(function (w) { return w[4] === 'w'; })) {
    await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run('No speech was found in that recording.', jobId);
    audLog(job.user_id, 'warn', 'finish', 'Job ' + jobId + ': no speech found');
    return;
  }
  const textLen = cw.reduce(function (n, w) { return n + String(w[3]).length; }, 0);
  await db.prepare("UPDATE audio_jobs SET status = 'ready', words = ?, text_len = ?, updated_at = NOW() WHERE id = ?").run(JSON.stringify(cw), textLen, jobId);
  { const sp = {}; cw.forEach(function (w) { if (w[4] === 'w') sp[w[0]] = (sp[w[0]] || 0) + 1; });
    audLog(job.user_id, 'info', 'finish', 'Job ' + jobId + ' ready', { parts: parts.length, ties: st.ties, fills: st.fills, speakers: sp, words: cw.filter(function (w) { return w[4] === 'w'; }).length, last_word_end_s: cw[cw.length - 1][2], secs: job.secs_real }); }
  await chargeJob(db, job);
}

async function jobFor(req, db, id) {
  const job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(id);
  if (!job || Number(job.user_id) !== Number(req.session.userId)) return null;
  return job;
}

router.get('/config', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cid = parseInt(req.query.campaign, 10);   // v3.6.13: whether this campaign's plan has it
    res.json({ enabled: await audioOn(db, req), allowed: cid ? await planAllows(db, req, cid) : null, plan_message: PLAN_MSG, tokens_per_half_hour: TOKENS_PER_HALF_HOUR, max_secs: MAX_SECS, max_bytes: MAX_BYTES });
  } catch (e) { res.json({ enabled: false }); }
});

// Start: checks, the job row, and the signed address to upload to.
router.post('/start', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    if (!(await audioOn(db, req))) return audRefuse(req, res, 'start', 403, 'Transcribing a recording is not available yet.');
    if (req.session.impersonatorId) return audRefuse(req, res, 'start', 403, 'Not while signed in as another person.');
    const b = req.body || {};
    const campaignId = parseInt(b.campaignId, 10), sessionId = parseInt(b.sessionId, 10);
    if (!campaignId || !sessionId || !(await getCampaignRole(req.session.userId, campaignId))) return audRefuse(req, res, 'start', 404, 'Open a session of your campaign first.');
    if (!(await planAllows(db, req, campaignId))) return audRefuse(req, res, 'start', 403, PLAN_MSG);   // v3.6.13 Gold and up
    const sess = await db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(sessionId, campaignId);
    if (!sess) return audRefuse(req, res, 'start', 404, 'That session was not found.');
    const secs = Number(b.secs), bytes = Number(b.bytes);
    if (!(secs > 0)) return audRefuse(req, res, 'start', 400, "The recording's length could not be read. Try converting it to mp3 or m4a.");
    if (secs > MAX_SECS) return audRefuse(req, res, 'start', 400, 'That recording is longer than 6 hours. Split it and transcribe each part.');
    if (!(bytes > 0) || bytes > MAX_BYTES) return audRefuse(req, res, 'start', 400, 'That file is too large (the limit is 1.5 GB). Convert it to mp3 or m4a first.');
    if (!b.consent) return audRefuse(req, res, 'start', 400, 'Tick the box to confirm everyone agreed to be recorded.');
    const busy = await db.prepare("SELECT id FROM audio_jobs WHERE user_id = ? AND status IN ('uploading', 'preparing', 'transcribing', 'saving') AND updated_at > NOW() - INTERVAL '2 hours'").get(req.session.userId);
    if (busy) return audRefuse(req, res, 'start', 409, 'You already have a recording being transcribed. Wait for it to finish.', { job: busy.id });
    const tokens = audioTokens(secs);
    const bal = await require('./tokens').getBalance(req.session.userId);
    if ((Number(bal.total) || 0) < tokens) { audLog(req.session.userId, 'warn', 'start', 'Refused (402): not enough tokens', { need: tokens, have: Number(bal.total) || 0 }); return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: 'This recording costs ' + tokens + ' tokens, but you have ' + (Number(bal.total) || 0) + '. Add tokens and try again.' }); }
    const name = String(b.name || 'recording').slice(0, 200);
    const ext = ((/\.([A-Za-z0-9]{2,5})$/.exec(name) || [])[1] || 'bin').toLowerCase();
    const key = 'audio-in/' + crypto.randomBytes(16).toString('hex') + '.' + ext;
    const hint = parseInt(b.speakers, 10);
    const ins = await db.prepare("INSERT INTO audio_jobs (user_id, campaign_id, session_id, status, file_key, bucket, file_name, bytes, secs_est, tokens, speakers_hint, consent_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, NOW())")
      .run(req.session.userId, campaignId, sessionId, key, audioBucket(), name, Math.round(bytes), secs, tokens, hint >= 1 && hint <= 32 ? hint : null);
    audLog(req.session.userId, 'info', 'start', 'Job ' + ins.lastInsertRowid + ' started', { file: name, secs: secs, bytes: bytes, tokens: tokens, speakers_hint: hint || null, bucket: audioBucket(), key: key });
    res.json({ job: ins.lastInsertRowid, upload_url: presign('PUT', audioBucket(), key, PUT_SECS), tokens: tokens });
  } catch (e) {
    audLog(req.session && req.session.userId, 'error', 'start', 'Start failed: ' + (e && e.message), { stack: String((e && e.stack) || '').slice(0, 1500) });
    res.status(500).json({ error: 'Could not start: ' + String((e && e.message) || '').slice(0, 200) });
  }
});

// The upload is done. v3.6.12: our server prepares it (the speech copy and the parts) in the background and sends the parts to fal.
router.post('/jobs/:id/uploaded', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    if (job.status !== 'uploading') return res.json({ job: jobView(job) });
    if (!webhookUrl()) return audRefuse(req, res, 'uploaded', 500, 'PUBLIC_BASE_URL is not set, so fal cannot report back.');
    const claim = await db.prepare("UPDATE audio_jobs SET status = 'preparing', updated_at = NOW() WHERE id = ? AND status = 'uploading'").run(job.id);
    if (claim.changes) { audLog(job.user_id, 'info', 'uploaded', 'Job ' + job.id + ': upload done, waiting to be prepared'); queuePrep(job.id); }
    res.json({ job: jobView(await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id)) });
  } catch (e) {
    audLog(req.session && req.session.userId, 'error', 'uploaded', 'Sending failed: ' + (e && e.message), { stack: String((e && e.stack) || '').slice(0, 1500) });
    res.status(500).json({ error: 'Could not send it for transcription.' });
  }
});

router.post('/jobs/:id/cancel', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    if (job.status === 'uploading') {
      await db.prepare("UPDATE audio_jobs SET status = 'failed', error = 'Cancelled before it was sent.', updated_at = NOW() WHERE id = ? AND status = 'uploading'").run(job.id);
      audLog(job.user_id, 'warn', 'cancel', 'Job ' + job.id + ': the upload did not finish (cancelled by the page)', { reason: String((req.body || {}).reason || '').slice(0, 300) });
      await deleteAudio(job);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not cancel.' }); }
});

// The job, for the page's polling. A job still transcribing after 20 s asks fal itself, in case the webhook was missed.
router.get('/jobs/:id', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    let job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    if (job.status === 'preparing') {   // v3.6.12
      const stale = await db.prepare("SELECT id FROM audio_jobs WHERE id = ? AND updated_at < NOW() - INTERVAL '" + PREP_STALE_MINS + " minutes'").get(job.id);
      if (stale) { await failJob(db, job, 'Preparing the recording stopped part way (the server restarted). Please try again.'); job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id); }
    }
    if (job.status === 'transcribing' && !job.request_id) {   // v3.6.12: ask fal about any part not heard from for 20 s
      const due = await db.prepare("SELECT * FROM audio_parts WHERE job_id = ? AND status = 'sent' AND updated_at < NOW() - INTERVAL '20 seconds' ORDER BY idx").all(job.id);
      for (const p of due) {
        try {
          const st = await IO.status(p.request_id);
          const s = String((st && st.status) || '').toUpperCase();
          audLog(job.user_id, 'info', 'poll', 'Job ' + job.id + ': fal says part ' + (p.idx + 1) + ' is ' + s, { request_id: p.request_id });
          if (s === 'COMPLETED') await finishPart(db, p, null);
          else await db.prepare('UPDATE audio_parts SET updated_at = NOW() WHERE id = ?').run(p.id);
        } catch (e) {
          const st = e && (e.status || (e.response && e.response.status));
          audLog(job.user_id, 'error', 'poll', 'Job ' + job.id + ': asking fal about part ' + (p.idx + 1) + ' failed', { status: st || null, message: e && e.message, body: (e && (e.body || (e.response && e.response.data))) || null });
          if (st && st >= 400 && st < 500) await finishPart(db, p, 'fal: ' + falWhy(e));
        }
      }
      await checkJob(db, job.id);
      job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id);
    }
    const due = job.status === 'transcribing' && job.request_id ? await db.prepare("SELECT id FROM audio_jobs WHERE id = ? AND updated_at < NOW() - INTERVAL '20 seconds'").get(job.id) : null;   // the age in SQL: TIMESTAMP columns read in JS shift with the server's time zone
    if (due) {
      try {
        const st = await falClient().queue.status(ENDPOINT, { requestId: job.request_id, logs: false });
        const s = String((st && st.status) || '').toUpperCase();
        audLog(job.user_id, 'info', 'poll', 'Job ' + job.id + ': fal says ' + s, { request_id: job.request_id });
        if (s === 'COMPLETED') await finishJob(db, job, null);
        else await db.prepare('UPDATE audio_jobs SET updated_at = NOW() WHERE id = ?').run(job.id);
      } catch (e) {
        const st = e && (e.status || (e.response && e.response.status));
        audLog(job.user_id, 'error', 'poll', 'Job ' + job.id + ': asking fal failed', { status: st || null, message: e && e.message, body: (e && (e.body || (e.response && e.response.data))) || null });
        if (st && st >= 400 && st < 500) await finishJob(db, job, 'fal: ' + falWhy(e));
      }
      job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id);
    }
    res.json({ job: await withPlayers(db, job) });
  } catch (e) {
    console.error('[audio] job read error:', e && e.message);
    res.status(500).json({ error: 'Could not read the job.' });
  }
});
// The newest unfinished job for this session (so the window picks it up again after it was closed).
router.get('/active', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await db.prepare("SELECT * FROM audio_jobs WHERE user_id = ? AND session_id = ? AND status IN ('uploading', 'preparing', 'transcribing', 'saving', 'ready') AND created_at > NOW() - INTERVAL '7 days' ORDER BY id DESC LIMIT 1").get(req.session.userId, parseInt(req.query.session, 10) || 0);
    res.json({ job: job ? await withPlayers(db, job) : null });
  } catch (e) { res.json({ job: null }); }
});

// The speakers named: the text for the Story box. The words are deleted from the job once they are used.
router.post('/jobs/:id/apply', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    if (job.status !== 'ready' || !job.words) return res.status(409).json({ error: 'That transcript is not ready, or was already used.' });
    const turns = turnsOf(JSON.parse(job.words));
    const text = buildText(turns, speakersOf(turns), (req.body || {}).names || {});
    res.json({ text: text });
  } catch (e) {
    console.error('[audio] apply error:', e && e.message);
    res.status(500).json({ error: 'Could not build the text.' });
  }
});
router.post('/jobs/:id/done', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    await db.prepare("UPDATE audio_jobs SET status = 'applied', words = NULL, updated_at = NOW() WHERE id = ? AND status = 'ready'").run(job.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not finish.' }); }
});

// fal reports back. Open to fal; it acts only on a ticket we issued, and reads the result from fal by that ticket.
router.post('/fal-webhook', async function (req, res) {
  res.json({ ok: true });
  try {
    await ensureTables();
    const b = req.body || {};
    const rid = String(b.request_id || b.requestId || '');
    if (!rid) return;
    const db = await getDb();
    const failed = String(b.status || '').toUpperCase() === 'ERROR';
    const part = await db.prepare("SELECT * FROM audio_parts WHERE request_id = ? AND status = 'sent'").get(rid);   // v3.6.12
    if (part) {
      const pj = await db.prepare('SELECT user_id FROM audio_jobs WHERE id = ?').get(part.job_id);
      const uid = pj && pj.user_id;
      if (failed) audLog(uid, 'error', 'fal-webhook', 'Job ' + part.job_id + ': fal failed part ' + (part.idx + 1) + ': ' + falReasons(b.payload, b.error), { request_id: rid, status: b.status, error: b.error, payload: b.payload });
      else audLog(uid, 'info', 'fal-webhook', 'Job ' + part.job_id + ': fal says part ' + (part.idx + 1) + ' is done', { request_id: rid });
      await finishPart(db, part, failed ? ('fal: ' + falReasons(b.payload, b.error)).slice(0, 1000) : null);
      return;
    }
    const job = await db.prepare("SELECT * FROM audio_jobs WHERE request_id = ? AND status = 'transcribing'").get(rid);   // a job sent whole before v3.6.12
    if (!job) return;
    // v3.6.10 (Ian, 2026-11-13: a test failed with only "fal: Unexpected status code: 422"; "if you write to the log i'll send it"): on a
    // failure, fal's whole answer goes to the log and its reasons to the job (never on success: the payload is the transcript).
    if (failed) audLog(job.user_id, 'error', 'fal-webhook', 'Job ' + job.id + ': fal failed it: ' + falReasons(b.payload, b.error), { request_id: rid, status: b.status, error: b.error, payload: b.payload });
    else audLog(job.user_id, 'info', 'fal-webhook', 'Job ' + job.id + ': fal says done', { request_id: rid });
    await finishJob(db, job, failed ? ('fal: ' + falReasons(b.payload, b.error)).slice(0, 1000) : null);
  } catch (e) { console.error('[audio] webhook error:', e && e.message); }
});

module.exports = router;
module.exports._test = { presign: presign, audioTokens: audioTokens, compactWords: compactWords, turnsOf: turnsOf, speakersOf: speakersOf, buildText: buildText, keytermsFor: keytermsFor, planParts: planParts, stitchParts: stitchParts, IO: IO, prepareJob: prepareJob, queuePrep: queuePrep, finishPart: finishPart, checkJob: checkJob, ensureTables: ensureTables };
