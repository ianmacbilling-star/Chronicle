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
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, isAdminEmail, getCampaignRole } = require('../middleware/auth');
const { getDb } = require('../database/db');
const storage = require('../storage/storage');

const ENDPOINT = 'fal-ai/elevenlabs/speech-to-text/scribe-v2';
const TOKENS_PER_HALF_HOUR = 4;   // 8 tokens an hour with keyterms (Ian, 2026-11-13: a token covers 8 cents; Scribe v2 + keyterms ~ $0.62 an hour)
const MAX_SECS = 6 * 3600;        // 6 hours (Ian, 2026-11-13)
const MAX_BYTES = 1536 * 1024 * 1024;
const PUT_SECS = 3600, GET_SECS = 3600;

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
  })().catch(function (e) { tablesReady = null; throw e; });
  return tablesReady;
}

async function audioOn(db, req) {
  const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (u && isAdminEmail(u.email)) return true;
  const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('audio_transcribe_on');
  return !!(r && String(r.value) === '1');
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
async function deleteAudio(job) {
  if (!job || !job.file_key) return;
  try {
    const axios = require('axios'), https = require('https');
    await axios.delete(presign('DELETE', job.bucket || audioBucket(), job.file_key, 300), { httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }), timeout: 30000, validateStatus: function (s) { return s < 500; } });
    console.log('[audio] job ' + job.id + ': recording deleted');
  } catch (e) { console.error('[audio] job ' + job.id + ': could not delete the recording: ' + (e && e.message)); }
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
  const v = { id: job.id, status: job.status, file_name: job.file_name, secs_est: job.secs_est, tokens: job.tokens, tokens_charged: job.tokens_charged, error: job.error || null, created_at: job.created_at };
  if (job.status === 'ready' && job.words) {
    try { const turns = turnsOf(JSON.parse(job.words)); v.speakers = speakersOf(turns); v.turns = turns.length; } catch (e) { v.speakers = []; }
  }
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
    try { await tk.recordGeneration(job.user_id, { event_type: 'audio_transcript', tokens_redeemed: charged, quantity: Math.round((Number(job.secs_est) || 0) / 60), unit: 'minutes', model: 'scribe-v2', related_campaign_id: job.campaign_id, related_session_id: job.session_id }); } catch (e) {}
    await db.prepare('UPDATE audio_jobs SET tokens_charged = ? WHERE id = ?').run(charged, job.id);
  } catch (e) { console.error('[audio] job ' + job.id + ' charge failed: ' + (e && e.message)); }
}

// The words are in at fal: read them, keep them, delete the recording, charge. Claimed so a webhook and a poll never both do it.
async function finishJob(db, job, falError) {
  const claim = await db.prepare("UPDATE audio_jobs SET status = 'saving', updated_at = NOW() WHERE id = ? AND status = 'transcribing'").run(job.id);
  if (!claim.changes) return;
  let data = null, err = falError || null;
  if (!err) {
    try { const r = await falClient().queue.result(ENDPOINT, { requestId: job.request_id }); data = r && (r.data || r); } catch (e) { err = 'fal: ' + falWhy(e); }
  }
  await deleteAudio(job);
  if (err || !data) {
    await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run(String(err || 'no result').slice(0, 1000), job.id);
    console.log('[audio] job ' + job.id + ' failed: ' + err);
    return;
  }
  const cw = compactWords(data.words);
  if (!cw.some(function (w) { return w[4] === 'w'; })) {
    await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run('No speech was found in that recording.', job.id);
    return;
  }
  await db.prepare("UPDATE audio_jobs SET status = 'ready', words = ?, text_len = ?, updated_at = NOW() WHERE id = ?").run(JSON.stringify(cw), String(data.text || '').length, job.id);
  console.log('[audio] job ' + job.id + ' ready: ' + cw.length + ' word(s), language ' + (data.language_code || '?'));
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
    res.json({ enabled: await audioOn(db, req), tokens_per_half_hour: TOKENS_PER_HALF_HOUR, max_secs: MAX_SECS, max_bytes: MAX_BYTES });
  } catch (e) { res.json({ enabled: false }); }
});

// Start: checks, the job row, and the signed address to upload to.
router.post('/start', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    if (!(await audioOn(db, req))) return res.status(403).json({ error: 'Transcribing a recording is not available yet.' });
    if (req.session.impersonatorId) return res.status(403).json({ error: 'Not while signed in as another person.' });
    const b = req.body || {};
    const campaignId = parseInt(b.campaignId, 10), sessionId = parseInt(b.sessionId, 10);
    if (!campaignId || !sessionId || !(await getCampaignRole(req.session.userId, campaignId))) return res.status(404).json({ error: 'Open a session of your campaign first.' });
    const sess = await db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(sessionId, campaignId);
    if (!sess) return res.status(404).json({ error: 'That session was not found.' });
    const secs = Number(b.secs), bytes = Number(b.bytes);
    if (!(secs > 0)) return res.status(400).json({ error: "The recording's length could not be read. Try converting it to mp3 or m4a." });
    if (secs > MAX_SECS) return res.status(400).json({ error: 'That recording is longer than 6 hours. Split it and transcribe each part.' });
    if (!(bytes > 0) || bytes > MAX_BYTES) return res.status(400).json({ error: 'That file is too large (the limit is 1.5 GB). Convert it to mp3 or m4a first.' });
    if (!b.consent) return res.status(400).json({ error: 'Tick the box to confirm everyone agreed to be recorded.' });
    const busy = await db.prepare("SELECT id FROM audio_jobs WHERE user_id = ? AND status IN ('uploading', 'transcribing', 'saving') AND updated_at > NOW() - INTERVAL '2 hours'").get(req.session.userId);
    if (busy) return res.status(409).json({ error: 'You already have a recording being transcribed. Wait for it to finish.', job: busy.id });
    const tokens = audioTokens(secs);
    const bal = await require('./tokens').getBalance(req.session.userId);
    if ((Number(bal.total) || 0) < tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: 'This recording costs ' + tokens + ' tokens, but you have ' + (Number(bal.total) || 0) + '. Add tokens and try again.' });
    const name = String(b.name || 'recording').slice(0, 200);
    const ext = ((/\.([A-Za-z0-9]{2,5})$/.exec(name) || [])[1] || 'bin').toLowerCase();
    const key = 'audio-in/' + crypto.randomBytes(16).toString('hex') + '.' + ext;
    const hint = parseInt(b.speakers, 10);
    const ins = await db.prepare("INSERT INTO audio_jobs (user_id, campaign_id, session_id, status, file_key, bucket, file_name, bytes, secs_est, tokens, speakers_hint, consent_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, NOW())")
      .run(req.session.userId, campaignId, sessionId, key, audioBucket(), name, Math.round(bytes), secs, tokens, hint >= 1 && hint <= 32 ? hint : null);
    console.log('[audio] job ' + ins.lastInsertRowid + ' started: ' + Math.round(secs) + ' s, ' + Math.round(bytes / 1048576) + ' MB, ' + tokens + ' tokens');
    res.json({ job: ins.lastInsertRowid, upload_url: presign('PUT', audioBucket(), key, PUT_SECS), tokens: tokens });
  } catch (e) {
    console.error('[audio] start error:', e && e.message);
    res.status(500).json({ error: 'Could not start: ' + String((e && e.message) || '').slice(0, 200) });
  }
});

// The upload is done: hand the recording to fal.
router.post('/jobs/:id/uploaded', requireAuth, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const job = await jobFor(req, db, parseInt(req.params.id, 10));
    if (!job) return res.status(404).json({ error: 'Not found.' });
    if (job.status !== 'uploading') return res.json({ job: jobView(job) });
    const hook = webhookUrl();
    if (!hook) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' });
    const input = { audio_url: presign('GET', job.bucket, job.file_key, GET_SECS), diarize: true, tag_audio_events: false };
    const terms = await keytermsFor(db, job.campaign_id, job.session_id);
    if (terms.length) input.keyterms = terms;
    if (job.speakers_hint) input.num_speakers = job.speakers_hint;
    let sub;
    try { sub = await falClient().queue.submit(ENDPOINT, { input: input, webhookUrl: hook }); }
    catch (e) {
      const why = falWhy(e);
      await deleteAudio(job);
      await db.prepare("UPDATE audio_jobs SET status = 'failed', error = ?, updated_at = NOW() WHERE id = ?").run(('fal refused it: ' + why).slice(0, 1000), job.id);
      return res.status(502).json({ error: 'The transcription service refused it: ' + why });
    }
    await db.prepare("UPDATE audio_jobs SET status = 'transcribing', request_id = ?, updated_at = NOW() WHERE id = ? AND status = 'uploading'").run(sub.request_id, job.id);
    console.log('[audio] job ' + job.id + ' sent to fal (' + sub.request_id + ', ' + terms.length + ' keyterm(s))');
    res.json({ job: jobView(await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id)) });
  } catch (e) {
    console.error('[audio] uploaded error:', e && e.message);
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
    const due = job.status === 'transcribing' && job.request_id ? await db.prepare("SELECT id FROM audio_jobs WHERE id = ? AND updated_at < NOW() - INTERVAL '20 seconds'").get(job.id) : null;   // the age in SQL: TIMESTAMP columns read in JS shift with the server's time zone
    if (due) {
      try {
        const st = await falClient().queue.status(ENDPOINT, { requestId: job.request_id, logs: false });
        const s = String((st && st.status) || '').toUpperCase();
        if (s === 'COMPLETED') await finishJob(db, job, null);
        else await db.prepare('UPDATE audio_jobs SET updated_at = NOW() WHERE id = ?').run(job.id);
      } catch (e) {
        const st = e && (e.status || (e.response && e.response.status));
        if (st && st >= 400 && st < 500) await finishJob(db, job, 'fal: ' + falWhy(e));
      }
      job = await db.prepare('SELECT * FROM audio_jobs WHERE id = ?').get(job.id);
    }
    res.json({ job: jobView(job) });
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
    const job = await db.prepare("SELECT * FROM audio_jobs WHERE user_id = ? AND session_id = ? AND status IN ('uploading', 'transcribing', 'saving', 'ready') AND created_at > NOW() - INTERVAL '7 days' ORDER BY id DESC LIMIT 1").get(req.session.userId, parseInt(req.query.session, 10) || 0);
    res.json({ job: job ? jobView(job) : null });
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
    const job = await db.prepare("SELECT * FROM audio_jobs WHERE request_id = ? AND status = 'transcribing'").get(rid);
    if (!job) return;
    const failed = String(b.status || '').toUpperCase() === 'ERROR';
    await finishJob(db, job, failed ? ('fal: ' + String(b.error || JSON.stringify(b.payload || '')).slice(0, 800)) : null);
  } catch (e) { console.error('[audio] webhook error:', e && e.message); }
});

module.exports = router;
module.exports._test = { presign: presign, audioTokens: audioTokens, compactWords: compactWords, turnsOf: turnsOf, speakersOf: speakersOf, buildText: buildText, keytermsFor: keytermsFor };
