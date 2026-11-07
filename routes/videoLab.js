// ============================================================
// v3.4.86 -- TD-090. THE VIDEO LAB (admin only; v3.4.90: picture sequences joined into one video). Spec: claude/VIDEO_SPEC.md.
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
// v3.4.90: the Lab makes a SEQUENCE: N pictures in order become N-1 shots (1->2, 2->3, ...), each with its own prompt
// and duration plus the video's overall prompt; when every shot is saved, fal's ffmpeg merge joins them into one video
// (final_video_url). A one-shot video needs no join. Redo remakes one shot and joins again. Created here, lazily, so database/db.js
// is untouched; id SERIAL because the db wrapper appends RETURNING id to every INSERT.
//
// NO TOKENS ARE CHARGED (Ian: "Don't worry about deducting tokens on this test run, but we'll need
// that"). est_cost_usd records what fal is expected to bill, from the price table below.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, isAdminEmail, getCampaignRole } = require('../middleware/auth');
const { getDb } = require('../database/db');
const storage = require('../storage/storage');

// v3.4.94 -- THE VIDEO SWITCH (Ian, 2026-11-07: "Make it always work for admins... but the on and off would be for
// everyone else"). The Dashboard sets app_settings.video_lab_on ('1' on, anything else off). Admins always pass;
// everyone else passes only while it is on. Read on every call, so switching it off stops the next request.
// No tokens are charged yet: while it is on, every clip anyone makes is billed to Campaignia by fal.
async function videoSwitchOn(db) {
  const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('video_lab_on');
  return !!(r && String(r.value) === '1');
}
async function requireVideo(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    if (!u) return res.status(403).json({ error: 'Video is not available.' });
    if (isAdminEmail(u.email)) { req.vlAdmin = true; return next(); }
    if (await videoSwitchOn(db)) { req.vlAdmin = false; return next(); }
    return res.status(403).json({ error: 'Video is not available.' });
  } catch (e) {
    return res.status(500).json({ error: 'Could not check video access.' });
  }
}
// Who may do what, for everyone but admins (admins may do anything, as before):
//   see a video   -- any member of its campaign;
//   change it     -- (rename, redo, join again, delete) the member who made it, or the campaign Story Master.
async function canSee(req, p) {
  if (req.vlAdmin) return true;
  return !!(p && await getCampaignRole(req.session.userId, p.campaign_id));
}
async function canChange(req, p) {
  if (req.vlAdmin) return true;
  if (!p) return false;
  const role = await getCampaignRole(req.session.userId, p.campaign_id);
  if (!role) return false;
  return role === 'dm' || Number(p.user_id) === Number(req.session.userId);
}

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
const MERGE_ENDPOINT = 'fal-ai/ffmpeg-api/merge-videos';   // v3.4.90: joins clips in order on fal's servers (listed at $0)
const MAX_PICTURES = 60;
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
    // v3.4.90 -- the join: fal's ticket, its state and any error, kept on the video itself.
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS merge_request_id TEXT');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS merge_status TEXT');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS merge_error TEXT');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS merge_started_at TIMESTAMP');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_shots_request ON video_shots(request_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_projects_merge ON video_projects(merge_request_id)');
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

// v3.4.90 -- the overall prompt (the whole video: who, where, mood) goes into every shot, then this shot's own direction.
function shotPrompt(overall, own) {
  overall = String(overall || '').trim(); own = String(own || '').trim();
  if (overall && own) return (overall + '\n\nThis shot: ' + own).slice(0, 2500);
  return (overall || own).slice(0, 2500);
}

function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s.slice(0, 120);
}

// ---- reading -------------------------------------------------------------------------------
router.get('/models', requireAuth, requireVideo, function (req, res) {
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

router.get('/projects', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cid = parseInt(req.query.campaign_id, 10);
    if (!cid) return res.status(400).json({ error: 'campaign_id is required' });
    if (!req.vlAdmin && !(await getCampaignRole(req.session.userId, cid))) return res.status(403).json({ error: 'You are not in that campaign.' });   // v3.4.94
    res.json({ projects: await projectsWithShots(db, 'campaign_id = ?', [cid]) });
  } catch (e) {
    console.error('[video-lab] list error:', e && e.message);
    res.status(500).json({ error: 'Could not load the Video Lab runs.' });
  }
});

// ---- making a run --------------------------------------------------------------------------
router.post('/projects', requireAuth, requireVideo, async function (req, res) {
  const b = req.body || {};
  const m = MODELS[b.model];
  if (!m) return res.status(400).json({ error: 'Pick a model.' });
  const cid = parseInt(b.campaign_id, 10);
  if (!cid) return res.status(400).json({ error: 'campaign_id is required' });
  // v3.4.90: pictures [{url, archive_id}] in order and pairs [{prompt, duration}] between them. The v3.4.86 shape
  // (start_url / end_url / prompt / duration) still works: it is a sequence of two.
  let pics = Array.isArray(b.pictures) ? b.pictures : [{ url: b.start_url, archive_id: b.start_archive_id }, { url: b.end_url, archive_id: b.end_archive_id }];
  pics = pics.map(function (p) { return { url: String((p && p.url) || ''), archive_id: parseInt(p && p.archive_id, 10) || null }; });
  if (pics.length < 2 || pics.some(function (p) { return !p.url; })) return res.status(400).json({ error: 'Pick at least two pictures.' });
  if (pics.length > MAX_PICTURES) return res.status(400).json({ error: 'At most ' + MAX_PICTURES + ' pictures in one video.' });
  if (pics.some(function (p) { return !storage.isOurPublicUrl(p.url); })) return res.status(400).json({ error: 'Every picture must be a Campaignia picture.' });
  const overall = String(b.overall_prompt || '').trim().slice(0, 2000);
  const pairsIn = Array.isArray(b.pairs) ? b.pairs : [{ prompt: b.prompt, duration: b.duration }];
  const shots = [];
  for (let i = 0; i < pics.length - 1; i++) {
    const pr = pairsIn[i] || {};
    const d = String(pr.duration || b.duration || m.defDuration);
    if (m.durations.indexOf(d) < 0) return res.status(400).json({ error: 'Clip ' + (i + 1) + ': ' + d + ' seconds is not offered for ' + m.label + '.' });
    const own = String(pr.prompt || '').trim().slice(0, 1500);
    const full = shotPrompt(overall, own);
    if (m.promptRequired && !full) return res.status(400).json({ error: m.label + ' needs a prompt for clip ' + (i + 1) + ' (pictures ' + (i + 1) + ' to ' + (i + 2) + '), or an overall prompt.' });
    shots.push({ position: i + 1, start: pics[i], end: pics[i + 1], own: own, full: full, duration: d });
  }
  const sound = !!b.sound;
  const hook = webhookUrl();
  if (!hook) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' });
  let projectId = null;
  try {
    await ensureTables();
    const db = await getDb();
    // v3.4.94 -- with the switch on, a member makes videos only in their own campaign, only from its Archive.
    if (!req.vlAdmin) {
      if (!(await getCampaignRole(req.session.userId, cid))) return res.status(403).json({ error: 'You are not in that campaign.' });
      const got = await db.prepare('SELECT DISTINCT image_url FROM campaign_archives WHERE campaign_id = ? AND image_url = ANY(?)').all(cid, [pics.map(function (p) { return p.url; })]);
      const inArchive = {}; (got || []).forEach(function (r) { inArchive[r.image_url] = true; });
      if (pics.some(function (p) { return !inArchive[p.url]; })) return res.status(400).json({ error: 'Every picture must come from this campaign Archive.' });
    }
    const name = cleanName(b.name) || ('Video Lab ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
    let sid = parseInt(b.session_id, 10) || null;
    if (sid && !(await db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(sid, cid))) sid = null;   // v3.4.94: only a session of this campaign
    const total = Math.round(shots.reduce(function (t, x) { return t + estCost(m, x.duration, sound); }, 0) * 10000) / 10000;
    const settings = JSON.stringify({ overall_prompt: overall, pictures: pics, model: b.model, sound: sound });
    const p = await db.prepare('INSERT INTO video_projects (user_id, campaign_id, session_id, name, kind, status, total_cost_usd, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, cid, sid, name, 'lab', 'making', total, settings);
    projectId = p.lastInsertRowid;
    for (const x of shots) {
      const r = await db.prepare('INSERT INTO video_shots (project_id, position, start_url, end_url, start_archive_id, end_archive_id, prompt, model, endpoint, duration, sound, status, est_cost_usd, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, x.position, x.start.url, x.end.url, x.start.archive_id, x.end.archive_id, x.full, b.model, m.endpoint, x.duration, sound, 'queued', estCost(m, x.duration, sound), JSON.stringify({ own_prompt: x.own }));
      x.id = r.lastInsertRowid;
    }
    // Send every shot to fal; they are made side by side. A refusal fails that shot only.
    const fal = falClient();
    let sent = 0;
    for (const x of shots) {
      try {
        const sub = await fal.queue.submit(m.endpoint, { input: buildInput(m, x.full, x.start.url, x.end.url, x.duration, sound), webhookUrl: hook });
        await db.prepare("UPDATE video_shots SET request_id = ?, status = 'running', submitted_at = NOW(), updated_at = NOW() WHERE id = ?").run(sub.request_id, x.id);
        sent++;
      } catch (e) {
        const msg = falErrorText(e);
        await db.prepare("UPDATE video_shots SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(('fal refused it: ' + msg).slice(0, 1000), x.id);
      }
    }
    console.log('[video-lab] project ' + projectId + ': ' + sent + ' of ' + shots.length + ' shot(s) sent to ' + m.endpoint);
    await projectStatus(db, projectId);
    const out = await projectsWithShots(db, 'id = ?', [projectId]);
    if (!sent) return res.status(502).json({ error: 'fal refused the run: ' + ((out[0] && out[0].shots[0] && out[0].shots[0].error) || 'unknown'), project: out[0] || null, project_id: projectId });
    res.json({ project: out[0] || null });
  } catch (e) {
    const msg = falErrorText(e);
    console.error('[video-lab] submit failed:', msg);
    res.status(500).json({ error: 'Could not start it: ' + msg, project_id: projectId });
  }
});

// v3.4.90 -- Redo one shot: the same pictures, prompt and settings sent again. Its old clip and the joined video are
// removed (the join is made again once every shot is back).
router.post('/shots/:id/redo', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT * FROM video_shots WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!shot) return res.status(404).json({ error: 'Not found.' });
    if (['queued', 'running', 'saving'].indexOf(shot.status) >= 0) return res.status(409).json({ error: 'That clip is still being made.' });
    const p = await db.prepare('SELECT * FROM video_projects WHERE id = ?').get(shot.project_id);
    if (!(await canChange(req, p))) return res.status(404).json({ error: 'Not found.' });   // v3.4.94
    if (p && p.merge_status === 'running') return res.status(409).json({ error: 'The clips are being joined right now; try again in a minute.' });
    const m = MODELS[shot.model];
    if (!m) return res.status(400).json({ error: 'That model is no longer offered.' });
    const hook = webhookUrl();
    if (!hook) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' });
    const old = [shot.video_url, p && p.final_video_url].filter(Boolean);
    await db.prepare("UPDATE video_shots SET status = 'queued', request_id = NULL, video_url = NULL, fal_video_url = NULL, file_size = NULL, error = NULL, finished_at = NULL, attempt = COALESCE(attempt, 1) + 1, updated_at = NOW() WHERE id = ?").run(shot.id);
    await db.prepare("UPDATE video_projects SET final_video_url = NULL, merge_request_id = NULL, merge_status = NULL, merge_error = NULL, status = 'making', updated_at = NOW() WHERE id = ?").run(shot.project_id);
    for (const f of old) { try { await storage.deleteFile(f); } catch (e) {} }
    try {
      const sub = await falClient().queue.submit(m.endpoint, { input: buildInput(m, shot.prompt, shot.start_url, shot.end_url, shot.duration, shot.sound), webhookUrl: hook });
      await db.prepare("UPDATE video_shots SET request_id = ?, status = 'running', submitted_at = NOW(), created_at = NOW(), updated_at = NOW() WHERE id = ?").run(sub.request_id, shot.id);
    } catch (e) {
      await db.prepare("UPDATE video_shots SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(('fal refused it: ' + falErrorText(e)).slice(0, 1000), shot.id);
    }
    await projectStatus(db, shot.project_id);
    const out = await projectsWithShots(db, 'id = ?', [shot.project_id]);
    res.json({ project: out[0] || null });
  } catch (e) {
    console.error('[video-lab] redo error:', e && e.message);
    res.status(500).json({ error: 'Could not redo it.' });
  }
});

function falErrorText(e) {
  if (!e) return 'unknown error';
  const body = e.body || (e.response && e.response.data);
  let detail = '';
  if (body) { try { detail = typeof body === 'string' ? body : JSON.stringify(body); } catch (_e) {} }
  return ((e.status ? e.status + ' ' : '') + (e.message || '') + (detail ? ' ' + detail : '')).trim().slice(0, 1000) || 'unknown error';
}

router.patch('/projects/:id', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const name = cleanName(req.body && req.body.name);
    if (!name) return res.status(400).json({ error: 'A name is needed.' });
    const db = await getDb();
    const _p = await db.prepare('SELECT id, user_id, campaign_id FROM video_projects WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!(await canChange(req, _p))) return res.status(404).json({ error: 'Not found.' });   // v3.4.94
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
async function sendVideo(res, url, fname) {
  const key = storage.keyFromUrl(url);
  const buf = key ? await storage.getObject(key) : null;
  if (!buf) return res.status(404).json({ error: 'The video file is missing from storage.' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.end(buf);
}
// v3.4.90 -- the joined video as one file.
router.get('/projects/:id/download', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const p = await db.prepare('SELECT id, name, final_video_url, user_id, campaign_id FROM video_projects WHERE id = ?').get(parseInt(req.params.id, 10));
    if (p && !(await canSee(req, p))) return res.status(404).json({ error: 'That video is not finished.' });   // v3.4.94
    if (!p || !p.final_video_url) return res.status(404).json({ error: 'That video is not finished.' });
    const base = String(p.name || 'video').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
    await sendVideo(res, p.final_video_url, base + '.mp4');
  } catch (e) {
    console.error('[video-lab] download error:', e && e.message);
    res.status(500).json({ error: 'Could not read the video.' });
  }
});
router.get('/shots/:id/download', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT s.id, s.video_url, p.name, p.user_id, p.campaign_id FROM video_shots s JOIN video_projects p ON p.id = s.project_id WHERE s.id = ?').get(parseInt(req.params.id, 10));
    if (shot && !(await canSee(req, shot))) return res.status(404).json({ error: 'No video for that shot.' });   // v3.4.94
    if (!shot || !shot.video_url) return res.status(404).json({ error: 'No video for that shot.' });
    await sendVideo(res, shot.video_url, fileNameFor(shot.name, shot.id));
  } catch (e) {
    console.error('[video-lab] download error:', e && e.message);
    res.status(500).json({ error: 'Could not read the video.' });
  }
});

router.delete('/projects/:id', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    const p = await db.prepare('SELECT * FROM video_projects WHERE id = ?').get(id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    if (!(await canChange(req, p))) return res.status(404).json({ error: 'Not found.' });   // v3.4.94
    const shots = await db.prepare('SELECT id, video_url FROM video_shots WHERE project_id = ?').all(id);
    const files = shots.map(function (s) { return s.video_url; }).concat([p.final_video_url]).filter(function (f, i, all) { return f && all.indexOf(f) === i; });   // v3.4.90: a one-shot video's file is its shot's
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
  const p = await db.prepare('SELECT * FROM video_projects WHERE id = ?').get(projectId);
  if (!p) return;
  const shots = await db.prepare('SELECT id, status, video_url FROM video_shots WHERE project_id = ? ORDER BY position, id').all(projectId);
  let st;
  if (shots.some(function (s) { return DONE_STATES.indexOf(s.status) < 0; })) st = 'making';
  else if (shots.some(function (s) { return s.status === 'error'; })) st = 'error';
  else if (p.final_video_url) st = 'done';
  else if (p.merge_status === 'error') st = 'error';
  else st = 'making';   // every shot saved; the join is on its way
  await db.prepare('UPDATE video_projects SET status = ?, updated_at = NOW() WHERE id = ?').run(st, projectId);
  // v3.4.90 -- every shot saved and nothing joined yet: one shot is the video itself; more go to fal's merge. The claim
  // (merge_status NULL -> 'running') lets only one caller start the join.
  if (st === 'making' && shots.length && shots.every(function (s) { return s.status === 'done' && s.video_url; }) && !p.final_video_url) {
    if (shots.length === 1) {
      await db.prepare("UPDATE video_projects SET final_video_url = ?, merge_status = 'single', status = 'done', updated_at = NOW() WHERE id = ? AND final_video_url IS NULL").run(shots[0].video_url, projectId);
      return;
    }
    const claim = await db.prepare("UPDATE video_projects SET merge_status = 'running', merge_error = NULL, merge_started_at = NOW(), updated_at = NOW() WHERE id = ? AND merge_status IS NULL").run(projectId);
    if (!claim.changes) return;
    try {
      const sub = await falClient().queue.submit(MERGE_ENDPOINT, { input: { video_urls: shots.map(function (s) { return s.video_url; }) }, webhookUrl: webhookUrl() || undefined });
      await db.prepare('UPDATE video_projects SET merge_request_id = ?, updated_at = NOW() WHERE id = ?').run(sub.request_id, projectId);
      console.log('[video-lab] project ' + projectId + ': joining ' + shots.length + ' clips, request ' + sub.request_id);
    } catch (e) {
      await db.prepare("UPDATE video_projects SET merge_status = 'error', merge_error = ?, status = 'error', updated_at = NOW() WHERE id = ?").run(('fal refused the join: ' + falErrorText(e)).slice(0, 1000), projectId);
    }
  }
}

// v3.4.90 -- the join is back: claim it ('running' -> 'saving'), copy the joined video to R2, and the video is done.
async function finishMerge(project, falResult, falError) {
  const db = await getDb();
  const claim = await db.prepare("UPDATE video_projects SET merge_status = 'saving', updated_at = NOW() WHERE id = ? AND merge_status = 'running'").run(project.id);
  if (!claim.changes) return 'not-mine';
  try {
    if (falError) throw new Error(falError);
    let data = falResult;
    if (!data || !data.video) { const r = await falClient().queue.result(MERGE_ENDPOINT, { requestId: project.merge_request_id }); data = r && (r.data || r); }
    const url = data && data.video && data.video.url;
    if (!url || !/^https:\/\//i.test(url)) throw new Error('fal returned no joined video');
    const buf = await fetchVideo(url);
    const stored = await storage.uploadFile(buf, 'vl-' + project.id + '-joined-' + Date.now() + '.mp4', 'video/mp4', 'video-lab');
    await db.prepare("UPDATE video_projects SET final_video_url = ?, merge_status = 'done', merge_error = NULL, status = 'done', updated_at = NOW() WHERE id = ?").run(stored, project.id);
    console.log('[video-lab] project ' + project.id + ' joined: ' + buf.length + ' bytes -> ' + stored);
    return 'done';
  } catch (e) {
    const msg = falErrorText(e);
    await db.prepare("UPDATE video_projects SET merge_status = 'error', merge_error = ?, status = 'error', updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), project.id);
    console.error('[video-lab] project ' + project.id + ' join failed: ' + msg);
    return 'error';
  }
}

async function fetchVideo(url) {
  const axios = require('axios');
  const https = require('https');
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: MAX_VIDEO_BYTES, maxBodyLength: MAX_VIDEO_BYTES, httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }) });
  const ct = String(resp.headers['content-type'] || 'video/mp4').split(';')[0].trim();
  if (!/^video\//.test(ct) && !/octet-stream/.test(ct)) throw new Error('fal returned ' + ct + ', not a video');
  return Buffer.from(resp.data);
}

// Join again after a failed join (the clips are all there).
router.post('/projects/:id/join', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    const _p = await db.prepare('SELECT id, user_id, campaign_id FROM video_projects WHERE id = ?').get(id);
    if (!(await canChange(req, _p))) return res.status(404).json({ error: 'Not found.' });   // v3.4.94
    const r = await db.prepare("UPDATE video_projects SET merge_status = NULL, merge_error = NULL, merge_request_id = NULL, updated_at = NOW() WHERE id = ? AND merge_status = 'error'").run(id);
    if (!r.changes) return res.status(409).json({ error: 'Nothing to join again.' });
    await projectStatus(db, id);
    const out = await projectsWithShots(db, 'id = ?', [id]);
    res.json({ project: out[0] || null });
  } catch (e) {
    res.status(500).json({ error: 'Could not join it again.' });
  }
});

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
    const buf = await fetchVideo(url);
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
    if (!shot) {
      // v3.4.90 -- or the join of a whole video
      const proj = await db.prepare('SELECT * FROM video_projects WHERE merge_request_id = ?').get(rid);
      if (!proj) return;
      if (String(b.status || '').toUpperCase() === 'ERROR') { await finishMerge(proj, null, 'fal: ' + (b.error || JSON.stringify(b.payload || {})).toString().slice(0, 500)); return; }
      let md = null;
      try { const r = await falClient().queue.result(MERGE_ENDPOINT, { requestId: rid }); md = r && (r.data || r); } catch (e) { md = b.payload || null; }
      await finishMerge(proj, md, null);
      return;
    }
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
    // v3.4.90 -- joins: one in flight is asked about directly; a video whose shots are all saved but never started its
    // join (a restart at the wrong moment) is started now.
    const joins = await db.prepare("SELECT * FROM video_projects WHERE merge_status = 'running' ORDER BY id LIMIT 20").all();
    for (const p of joins) {
      const ageMin = (Date.now() - new Date(p.merge_started_at || p.updated_at).getTime()) / 60000;
      if (!p.merge_request_id) { if (ageMin > 5) await finishMerge(p, null, 'the join never reached fal'); continue; }
      let st = null;
      try { st = await falClient().queue.status(MERGE_ENDPOINT, { requestId: p.merge_request_id, logs: false }); }
      catch (e) { if (ageMin > STUCK_MINUTES) await finishMerge(p, null, 'fal status check failed: ' + falErrorText(e)); continue; }
      const s = String(st && st.status || '').toUpperCase();
      if (s === 'COMPLETED') await finishMerge(p, null, (st && st.error) ? ('fal: ' + st.error) : null);
      else if (ageMin > STUCK_MINUTES) await finishMerge(p, null, 'the join timed out after ' + STUCK_MINUTES + ' minutes');
    }
    const waiting = await db.prepare("SELECT id FROM video_projects WHERE status = 'making' AND final_video_url IS NULL AND merge_status IS NULL ORDER BY id LIMIT 20").all();
    for (const p of waiting) await projectStatus(db, p.id);
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
module.exports.shotPrompt = shotPrompt;
module.exports._finishMerge = finishMerge;
module.exports.MERGE_ENDPOINT = MERGE_ENDPOINT;
module.exports._sweep = sweep;
module.exports._finishShot = finishShot;
module.exports._ensureTables = ensureTables;
module.exports._stopSweep = function () { if (_timer) clearInterval(_timer); _timer = null; };
