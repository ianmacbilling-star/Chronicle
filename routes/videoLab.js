// ============================================================
// v3.4.86 -- TD-090. THE VIDEO LAB (admin only). Spec: claude/VIDEO_SPEC.md.
// Two pictures (start and end) and a prompt go to a fal video model; fal makes the clip on its own
// servers; we copy the finished clip to R2 and list it on the session's Video Lab tab.
//
// ASYNC BY DESIGN. Every run is a row in the database, never process memory, so a closed browser,
// a deploy or a restart loses nothing (unlike Optimize, TD-597). A run finishes one of two ways:
//   1. fal calls POST /api/video-lab/webhook when it is done;
//   2. a sweep every 30 s asks fal about any run still unfinished (a webhook can be missed while
//      the server is restarting).
// Whichever gets there first CLAIMS the shot with one UPDATE ... WHERE status IN (...), so a shot is
// saved once even with both paths, or two servers, running.
//
// TABLES, SHAPED FOR THE FULL VIDEO (Ian, 2026-11-07: "one full video sequence might be 20 to 30
// before and after pictures all sequenced together with prompts between them"):
//   video_projects  one video: name, campaign, status, the joined final video (later), settings JSON
//   video_shots     one pair of pictures in that video: position, start/end, prompt, model, duration,
//                   the fal ticket, the clip in R2, cost, timings. Columns for later (dialogue,
//                   replaces_shot_id, settings) are here now so adding shots needs no migration.
// Today the Lab makes a project with ONE shot per Generate. Created here, lazily, so database/db.js
// is untouched; id SERIAL because the db wrapper appends RETURNING id to every INSERT.
//
// NO TOKENS ARE CHARGED (Ian: "Don't worry about deducting tokens on this test run, but we'll need
// that"). est_cost_usd records what fal is expected to bill, from the price table below.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getDb } = require('../database/db');
const storage = require('../storage/storage');

// Model table. Endpoint ids, input names, durations and prices from fal's own model pages,
// 2026-11-07. Prices are USD per second of video at 720p; "sound" is the model's own audio.
const MODELS = {
  seedance2: {
    label: 'Seedance 2.0 (ByteDance)', endpoint: 'bytedance/seedance-2.0/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.3024, priceSound: 0.3024,
    extra: { resolution: '720p', aspect_ratio: 'auto' }, promptRequired: true
  },
  seedance2fast: {
    label: 'Seedance 2.0 Fast (ByteDance)', endpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.2419, priceSound: 0.2419,
    extra: { resolution: '720p', aspect_ratio: 'auto' }, promptRequired: true
  },
  kling3std: {
    label: 'Kling 3.0 Standard (Kuaishou)', endpoint: 'fal-ai/kling-video/v3/standard/image-to-video',
    start: 'start_image_url', end: 'end_image_url', durations: ['3', '5', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.084, priceSound: 0.126,
    extra: {}, promptRequired: false
  },
  veo31fast: {
    label: 'Veo 3.1 Fast (Google)', endpoint: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
    start: 'first_frame_url', end: 'last_frame_url', durations: ['4', '6', '8'], defDuration: '8',
    durationValue: function (d) { return String(d) + 's'; }, price: 0.10, priceSound: 0.15,
    extra: { resolution: '720p', aspect_ratio: 'auto' }, promptRequired: true
  }
};
const DONE_STATES = ['done', 'error'];
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const STUCK_MINUTES = 45;

function estCost(m, duration, sound) {
  const per = sound ? m.priceSound : m.price;
  return Math.round(per * Number(duration) * 10000) / 10000;
}

// fal client with the same privacy headers as every picture call (X-Fal-Store-IO 0, CDN expiry):
// images.js owns the one set-up function and exports it (v3.4.86).
function falClient() {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error('FAL_API_KEY is not set');
  const images = require('./images');
  images.falSetup(key);
  return require('@fal-ai/client').fal;
}
function webhookUrl() {
  let base = String(process.env.PUBLIC_BASE_URL || '');
  while (base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  return base ? base + '/api/video-lab/webhook' : '';
}

let _tablesReady = null;
function ensureTables() {
  if (_tablesReady) return _tablesReady;
  _tablesReady = (async function () {
    const db = await getDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS video_projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        campaign_id INTEGER,
        session_id INTEGER,
        name TEXT,
        kind TEXT DEFAULT 'lab',
        status TEXT DEFAULT 'draft',
        aspect_ratio TEXT,
        final_video_url TEXT,
        total_cost_usd REAL DEFAULT 0,
        settings TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS video_shots (
        id SERIAL PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        start_url TEXT,
        end_url TEXT,
        start_archive_id INTEGER,
        end_archive_id INTEGER,
        prompt TEXT,
        dialogue TEXT,
        model TEXT,
        endpoint TEXT,
        duration TEXT,
        sound BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'queued',
        request_id TEXT,
        fal_video_url TEXT,
        video_url TEXT,
        file_size BIGINT,
        est_cost_usd REAL DEFAULT 0,
        error TEXT,
        attempt INTEGER DEFAULT 1,
        replaces_shot_id INTEGER,
        settings TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP,
        finished_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_shots_request ON video_shots(request_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_shots_project ON video_shots(project_id, position)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_projects_campaign ON video_projects(campaign_id, created_at)');
  })();
  _tablesReady.catch(function () { _tablesReady = null; });
  return _tablesReady;
}

// What one shot sends to fal: each model names its start and end pictures and its duration its own way.
function buildInput(m, prompt, startUrl, endUrl, duration, sound) {
  const input = Object.assign({}, m.extra);
  if (prompt) input.prompt = prompt;
  input[m.start] = startUrl;
  input[m.end] = endUrl;
  input.duration = m.durationValue(duration);
  input.generate_audio = !!sound;
  return input;
}

function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s.slice(0, 120);
}

// ---- reading -------------------------------------------------------------------------------
router.get('/models', requireAuth, requireAdmin, function (req, res) {
  const out = Object.keys(MODELS).map(function (k) {
    const m = MODELS[k];
    return { key: k, label: m.label, durations: m.durations, defDuration: m.defDuration, price: m.price, priceSound: m.priceSound, promptRequired: m.promptRequired };
  });
  res.json({ models: out, webhook: !!webhookUrl() });
});

async function projectsWithShots(db, where, params) {
  const projects = await db.prepare('SELECT * FROM video_projects WHERE ' + where + ' ORDER BY created_at DESC, id DESC').all(params);
  if (!projects.length) return [];
  const ids = projects.map(function (p) { return p.id; });
  const shots = await db.prepare('SELECT * FROM video_shots WHERE project_id = ANY(?) ORDER BY project_id, position, id').all([ids]);
  projects.forEach(function (p) { p.shots = shots.filter(function (s) { return s.project_id === p.id; }); });
  return projects;
}

router.get('/projects', requireAuth, requireAdmin, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cid = parseInt(req.query.campaign_id, 10);
    if (!cid) return res.status(400).json({ error: 'campaign_id is required' });
    res.json({ projects: await projectsWithShots(db, 'campaign_id = ?', [cid]) });
  } catch (e) {
    console.error('[video-lab] list error:', e && e.message);
    res.status(500).json({ error: 'Could not load the Video Lab runs.' });
  }
});

// ---- making a run --------------------------------------------------------------------------
router.post('/projects', requireAuth, requireAdmin, async function (req, res) {
  const b = req.body || {};
  const m = MODELS[b.model];
  if (!m) return res.status(400).json({ error: 'Pick a model.' });
  const duration = String(b.duration || m.defDuration);
  if (m.durations.indexOf(duration) < 0) return res.status(400).json({ error: 'That duration is not offered for ' + m.label + '.' });
  const cid = parseInt(b.campaign_id, 10);
  if (!cid) return res.status(400).json({ error: 'campaign_id is required' });
  const startUrl = String(b.start_url || ''), endUrl = String(b.end_url || '');
  if (!startUrl || !endUrl) return res.status(400).json({ error: 'Pick a start picture and an end picture.' });
  if (!storage.isOurPublicUrl(startUrl) || !storage.isOurPublicUrl(endUrl)) return res.status(400).json({ error: 'Both pictures must be Campaignia pictures.' });
  const prompt = String(b.prompt || '').trim().slice(0, 2500);
  if (m.promptRequired && !prompt) return res.status(400).json({ error: m.label + ' needs a prompt: say what happens between the two pictures.' });
  const sound = !!b.sound;
  const hook = webhookUrl();
  if (!hook) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' });
  let projectId = null, shotId = null;
  try {
    await ensureTables();
    const db = await getDb();
    const name = cleanName(b.name) || ('Video Lab ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
    const sid = parseInt(b.session_id, 10) || null;
    const cost = estCost(m, duration, sound);
    const p = await db.prepare('INSERT INTO video_projects (user_id, campaign_id, session_id, name, kind, status, total_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, cid, sid, name, 'lab', 'making', cost);
    projectId = p.lastInsertRowid;
    const s = await db.prepare('INSERT INTO video_shots (project_id, position, start_url, end_url, start_archive_id, end_archive_id, prompt, model, endpoint, duration, sound, status, est_cost_usd) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, startUrl, endUrl, parseInt(b.start_archive_id, 10) || null, parseInt(b.end_archive_id, 10) || null, prompt, b.model, m.endpoint, duration, sound, 'queued', cost);
    shotId = s.lastInsertRowid;
    const input = buildInput(m, prompt, startUrl, endUrl, duration, sound);
    const fal = falClient();
    const sub = await fal.queue.submit(m.endpoint, { input: input, webhookUrl: hook });
    await db.prepare("UPDATE video_shots SET request_id = ?, status = 'running', submitted_at = NOW(), updated_at = NOW() WHERE id = ?").run(sub.request_id, shotId);
    console.log('[video-lab] shot ' + shotId + ' submitted to ' + m.endpoint + ' (' + duration + ' s), request ' + sub.request_id);
    const out = await projectsWithShots(db, 'id = ?', [projectId]);
    res.json({ project: out[0] || null });
  } catch (e) {
    const msg = falErrorText(e);
    console.error('[video-lab] submit failed:', msg);
    if (shotId) {
      try { const db = await getDb(); await db.prepare("UPDATE video_shots SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), shotId); await projectStatus(db, projectId); } catch (_e) {}
    }
    res.status(502).json({ error: 'fal refused the run: ' + msg, project_id: projectId });
  }
});

function falErrorText(e) {
  if (!e) return 'unknown error';
  const body = e.body || (e.response && e.response.data);
  let detail = '';
  if (body) { try { detail = typeof body === 'string' ? body : JSON.stringify(body); } catch (_e) {} }
  return ((e.status ? e.status + ' ' : '') + (e.message || '') + (detail ? ' ' + detail : '')).trim().slice(0, 1000) || 'unknown error';
}

router.patch('/projects/:id', requireAuth, requireAdmin, async function (req, res) {
  try {
    await ensureTables();
    const name = cleanName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'A name is needed.' });
    const db = await getDb();
    const r = await db.prepare('UPDATE video_projects SET name = ?, updated_at = NOW() WHERE id = ?').run(name, parseInt(req.params.id, 10));
    if (!r.changes) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true, name: name });
  } catch (e) {
    res.status(500).json({ error: 'Could not rename it.' });
  }
});

// Download one shot's clip as a file (Ian: "the ability to download the video to your computer").
// The clip lives on the pictures domain, where a plain link only opens it; this reads it from the
// bucket by key and sends it from our own origin as an attachment named after the video.
function fileNameFor(name, shotId) {
  const base = String(name || 'video').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  return base + ' (shot ' + shotId + ').mp4';
}
router.get('/shots/:id/download', requireAuth, requireAdmin, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT s.id, s.video_url, p.name FROM video_shots s JOIN video_projects p ON p.id = s.project_id WHERE s.id = ?').get(parseInt(req.params.id, 10));
    if (!shot || !shot.video_url) return res.status(404).json({ error: 'No video for that shot.' });
    const key = storage.keyFromUrl(shot.video_url);
    const buf = key ? await storage.getObject(key) : null;
    if (!buf) return res.status(404).json({ error: 'The video file is missing from storage.' });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileNameFor(shot.name, shot.id) + '"');
    res.end(buf);
  } catch (e) {
    console.error('[video-lab] download error:', e && e.message);
    res.status(500).json({ error: 'Could not read the video.' });
  }
});

router.delete('/projects/:id', requireAuth, requireAdmin, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    const p = await db.prepare('SELECT * FROM video_projects WHERE id = ?').get(id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    const shots = await db.prepare('SELECT id, video_url FROM video_shots WHERE project_id = ?').all(id);
    const files = shots.map(function (s) { return s.video_url; }).concat([p.final_video_url]).filter(Boolean);
    // deleteFile logs and swallows its own failures, so this counts files asked for, not proven gone.
    let asked = 0;
    for (const f of files) {
      try { await storage.deleteFile(f); asked++; } catch (e) { console.error('[video-lab] could not delete ' + f + ': ' + (e && e.message)); }
    }
    await db.prepare('DELETE FROM video_shots WHERE project_id = ?').run(id);
    await db.prepare('DELETE FROM video_projects WHERE id = ?').run(id);
    console.log('[video-lab] deleted project ' + id + ' (' + shots.length + ' shot(s), ' + asked + '/' + files.length + ' file(s) sent for deletion)');
    res.json({ ok: true, files: files.length });
  } catch (e) {
    console.error('[video-lab] delete error:', e && e.message);
    res.status(500).json({ error: 'Could not delete it.' });
  }
});

// ---- finishing a run -----------------------------------------------------------------------
async function projectStatus(db, projectId) {
  if (!projectId) return;
  const shots = await db.prepare('SELECT status FROM video_shots WHERE project_id = ?').all(projectId);
  let st = 'done';
  if (shots.some(function (s) { return DONE_STATES.indexOf(s.status) < 0; })) st = 'making';
  else if (shots.some(function (s) { return s.status === 'error'; })) st = shots.every(function (s) { return s.status === 'error'; }) ? 'error' : 'done';
  await db.prepare('UPDATE video_projects SET status = ?, updated_at = NOW() WHERE id = ?').run(st, projectId);
}

// Claim the shot (only one caller wins), fetch the result from fal by our own ticket, copy the
// clip to R2. falResult is the fal result data if the caller already has it.
async function finishShot(shot, falResult, falError) {
  const db = await getDb();
  const claim = await db.prepare("UPDATE video_shots SET status = 'saving', updated_at = NOW() WHERE id = ? AND status IN ('queued', 'running') ").run(shot.id);
  if (!claim.changes) return 'not-mine';
  try {
    if (falError) throw new Error(falError);
    let data = falResult;
    if (!data || !data.video) {
      const fal = falClient();
      const r = await fal.queue.result(shot.endpoint, { requestId: shot.request_id });
      data = r && (r.data || r);
    }
    const url = data && data.video && data.video.url;
    if (!url || !/^https:\/\//i.test(url)) throw new Error('fal returned no video');
    const axios = require('axios');
    const https = require('https');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: MAX_VIDEO_BYTES, maxBodyLength: MAX_VIDEO_BYTES, httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }) });
    const buf = Buffer.from(resp.data);
    const ct = String(resp.headers['content-type'] || 'video/mp4').split(';')[0].trim();
    if (!/^video\//.test(ct) && !/octet-stream/.test(ct)) throw new Error('fal returned ' + ct + ', not a video');
    const fname = 'vl-' + shot.project_id + '-' + shot.id + '-' + Date.now() + '.mp4';
    const stored = await storage.uploadFile(buf, fname, 'video/mp4', 'video-lab');
    await db.prepare("UPDATE video_shots SET status = 'done', fal_video_url = ?, video_url = ?, file_size = ?, error = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(url, stored, buf.length, shot.id);
    console.log('[video-lab] shot ' + shot.id + ' done: ' + buf.length + ' bytes -> ' + stored);
    await projectStatus(db, shot.project_id);
    return 'done';
  } catch (e) {
    const msg = falErrorText(e);
    await db.prepare("UPDATE video_shots SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), shot.id);
    console.error('[video-lab] shot ' + shot.id + ' failed: ' + msg);
    await projectStatus(db, shot.project_id);
    return 'error';
  }
}

// fal's webhook. No session: it is accepted only for a ticket we issued, and the result is read
// back from fal by that ticket (the posted payload is used only if that read fails).
router.post('/webhook', async function (req, res) {
  res.json({ ok: true });   // answer fal at once; the copy to R2 can take a while
  try {
    await ensureTables();
    const b = req.body || {};
    const rid = String(b.request_id || b.requestId || '');
    if (!rid) return;
    const db = await getDb();
    const shot = await db.prepare('SELECT * FROM video_shots WHERE request_id = ?').get(rid);
    if (!shot) return;
    if (String(b.status || '').toUpperCase() === 'ERROR') {
      await finishShot(shot, null, 'fal: ' + (b.error || JSON.stringify(b.payload || {})).toString().slice(0, 500));
      return;
    }
    let data = null;
    try { const r = await falClient().queue.result(shot.endpoint, { requestId: rid }); data = r && (r.data || r); }
    catch (e) { data = b.payload || null; }
    await finishShot(shot, data, null);
  } catch (e) {
    console.error('[video-lab] webhook error:', e && e.message);
  }
});

// The sweep: anything still unfinished is asked about directly, so a missed webhook (a deploy, a
// restart) never strands a run. One sweep at a time per process; the claim in finishShot covers
// two processes.
let _sweeping = false;
async function sweep() {
  if (_sweeping) return;
  _sweeping = true;
  try {
    await ensureTables();
    const db = await getDb();
    const open = await db.prepare("SELECT * FROM video_shots WHERE status IN ('queued', 'running') ORDER BY id LIMIT 20").all();
    for (const shot of open) {
      const ageMin = (Date.now() - new Date(shot.created_at).getTime()) / 60000;
      if (!shot.request_id) {
        if (ageMin > 5) await finishShot(shot, null, 'never reached fal');
        continue;
      }
      let st = null;
      try { st = await falClient().queue.status(shot.endpoint, { requestId: shot.request_id, logs: false }); }
      catch (e) { if (ageMin > STUCK_MINUTES) await finishShot(shot, null, 'fal status check failed: ' + falErrorText(e)); continue; }
      const s = String(st && st.status || '').toUpperCase();
      if (s === 'COMPLETED') await finishShot(shot, null, (st && st.error) ? ('fal: ' + st.error) : null);
      else if (ageMin > STUCK_MINUTES) await finishShot(shot, null, 'timed out after ' + STUCK_MINUTES + ' minutes (fal says ' + (s || 'nothing') + ')');
    }
  } catch (e) {
    if (!/DATABASE_URL/.test(String(e && e.message))) console.error('[video-lab] sweep error:', e && e.message);
  } finally {
    _sweeping = false;
  }
}
let _timer = null;
function startSweep() {
  if (_timer || String(process.env.VIDEO_LAB_SWEEP || '') === '0') return;
  _timer = setInterval(function () { sweep(); }, 30000);
  if (_timer.unref) _timer.unref();
}
startSweep();

module.exports = router;
module.exports.MODELS = MODELS;
module.exports.estCost = estCost;
module.exports.buildInput = buildInput;
module.exports.fileNameFor = fileNameFor;
module.exports._sweep = sweep;
module.exports._finishShot = finishShot;
module.exports._ensureTables = ensureTables;
module.exports._stopSweep = function () { if (_timer) clearInterval(_timer); _timer = null; };
