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
// v3.4.95 -- CUTS (Video Phase 2, build 2; claude/VIDEO_PHASE2_SPEC.md). A cut is one video for one version of one session:
// its own list of pictures (video_cut_pictures), made from the version's storyboard (title picture first), moved, removed,
// added from the Archive, named, and one pinned per version. While a cut is a DRAFT its pictures and the prompts between
// them are edited and saved; Generate turns it into shots exactly as the Lab did (planShots / sendShots, shared with the
// Lab route so the two cannot drift). The Lab's runs are folded in as cuts the first time this starts (foldLabRuns).
// Additive only (spec section 0): new columns and one new table; nothing outside the Video tab reads them.
//
// v3.4.98 -- THE SHOT LIST AND THE FIRST THREE VIDEO STYLES (Phase 2, build 3; spec section 15). A cut has a style
// (Animated, Living Illustration, Documentary); Write the shot list fills its boxes from the model that writes the story.
//
// NO TOKENS ARE CHARGED FOR THE CLIPS (Ian: "Don't worry about deducting tokens on this test run, but we'll need
// that"). est_cost_usd records what fal is expected to bill, from the price table below. v3.4.98: writing a shot list
// does cost tokens (see the shot list section).
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, isAdminEmail, getCampaignRole } = require('../middleware/auth');
const { getDb, getViewableForkId } = require('../database/db');
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
    // v3.4.95 -- cuts: the version, the pin, and (for later builds) the style, the shot list and where it came from.
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS fork_id INTEGER');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS style TEXT');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS shot_list TEXT');
    await db.exec('ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS source TEXT');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS video_cut_pictures (
        id SERIAL PRIMARY KEY,
        cut_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        image_url TEXT,
        source TEXT,
        moment_id INTEGER,
        archive_id INTEGER,
        label TEXT,
        prev_image_url TEXT,
        retouched_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_cut_pictures_cut ON video_cut_pictures(cut_id, position)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_projects_version ON video_projects(session_id, fork_id)');
    // v3.4.98 -- one row per Write the shot list; one running per cut (the partial unique index is the claim).
    await db.exec(`
      CREATE TABLE IF NOT EXISTS video_shotlist_jobs (
        id SERIAL PRIMARY KEY,
        cut_id INTEGER NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
        user_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        style TEXT,
        model TEXT,
        boot_id TEXT,
        est_tokens INTEGER,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        tokens_charged INTEGER DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP
      )`);
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_video_shotlist_one_running ON video_shotlist_jobs(cut_id) WHERE status = 'running'");
    await db.exec('CREATE INDEX IF NOT EXISTS idx_video_shotlist_cut ON video_shotlist_jobs(cut_id, id)');
    await foldLabRuns(db);
  })();
  _tablesReady.catch(function () { _tablesReady = null; });
  return _tablesReady;
}

// v3.4.95 -- THE LAB'S RUNS BECOME CUTS (Ian: "if you can keep the two videos I've made"). A Lab run made on a session
// takes that session's Canonical as its version (the Lab did not record one) and its pictures from its shots: each shot's
// start, then the last shot's end. Pictures first, then the kind, so a restart half way through finishes the job.
// A run with no session (none were made that way from the tab) stays a Lab run and is not shown.
async function foldLabRuns(db) {
  const labs = await db.prepare("SELECT id, session_id FROM video_projects WHERE kind = 'lab' AND session_id IS NOT NULL ORDER BY id").all();
  for (const p of labs) {
    const fork = await db.prepare("SELECT id FROM session_forks WHERE session_id = ? AND role = 'dm' ORDER BY id ASC LIMIT 1").get(p.session_id);
    const has = await db.prepare('SELECT id FROM video_cut_pictures WHERE cut_id = ? LIMIT 1').get(p.id);
    if (!has) {
      const shots = await db.prepare('SELECT position, start_url, end_url, start_archive_id, end_archive_id FROM video_shots WHERE project_id = ? ORDER BY position, id').all(p.id);
      const pics = shots.map(function (s) { return { url: s.start_url, archive_id: s.start_archive_id }; });
      if (shots.length) pics.push({ url: shots[shots.length - 1].end_url, archive_id: shots[shots.length - 1].end_archive_id });
      for (let i = 0; i < pics.length; i++) {
        await db.prepare('INSERT INTO video_cut_pictures (cut_id, position, image_url, source, archive_id) VALUES (?, ?, ?, ?, ?)').run(p.id, i + 1, pics[i].url, 'archive', pics[i].archive_id || null);
      }
    }
    await db.prepare("UPDATE video_projects SET kind = 'cut', source = 'lab', fork_id = COALESCE(fork_id, ?), updated_at = NOW() WHERE id = ? AND kind = 'lab'").run(fork ? fork.id : null, p.id);
  }
  if (labs.length) console.log('[video-lab] folded ' + labs.length + ' Lab run(s) into cuts');
}

// v3.4.95 -- a version's storyboard pictures, in story order: the title picture first (the version's own, else the
// Canonical's, as the session tile reads it), then every panel with a picture, by panel order. A picture rejected by the
// rights check (TD-979) is left out, as everywhere else.
const NOT_REJECTED = " AND NOT EXISTS (SELECT 1 FROM image_rights ir WHERE ir.image_url = m.image AND ir.verdict = 'reject')";
async function storyboardPictures(db, sessionId, forkId) {
  const rows = await db.prepare(
    "SELECT m.id, m.kind, m.title, m.image FROM moments m WHERE m.fork_id = ? AND m.image IS NOT NULL AND m.image <> ''" + NOT_REJECTED +
    " ORDER BY CASE WHEN m.kind = 'establishing' THEN 0 ELSE 1 END ASC, m.panel_order ASC, m.id ASC").all(forkId);
  const out = rows.map(function (r) {
    return { url: r.image, source: r.kind === 'establishing' ? 'title' : 'moment', moment_id: r.id, label: r.kind === 'establishing' ? 'Title picture' : String(r.title || '') };
  });
  if (!out.some(function (x) { return x.source === 'title'; })) {
    const t = await db.prepare(
      "SELECT m.id, m.image FROM moments m JOIN session_forks f ON f.id = m.fork_id WHERE f.session_id = ? AND f.role = 'dm' AND m.kind = 'establishing' AND m.image IS NOT NULL AND m.image <> ''" + NOT_REJECTED +
      ' ORDER BY m.panel_order ASC, m.id ASC LIMIT 1').get(sessionId);
    if (t) out.unshift({ url: t.image, source: 'title', moment_id: t.id, label: 'Title picture' });
  }
  return out;
}

// v3.4.95 -- may this person work on this version of this session? Admins: any version of any session. Everyone else:
// a member of its campaign, and a version they may view (the same rule the storyboard uses, getViewableForkId).
async function versionAccess(req, db, sessionId, forkId) {
  const s = await db.prepare('SELECT id, campaign_id FROM sessions WHERE id = ?').get(sessionId);
  if (!s) return null;
  const f = await db.prepare('SELECT id FROM session_forks WHERE id = ? AND session_id = ?').get(forkId, sessionId);
  if (!f) return null;
  if (req.vlAdmin) return s;
  if (!(await getCampaignRole(req.session.userId, s.campaign_id))) return null;
  const v = await getViewableForkId(db, sessionId, req.session.userId, forkId);
  return (v && String(v) === String(forkId)) ? s : null;
}

// v3.4.95 -- a picture may go into a cut if it is this campaign's: a picture on any storyboard of the session (the
// version's own or the title picture borrowed from the Canonical) or one in the campaign's Archive. Admins as before.
async function picturesAllowed(req, db, cut, urls) {
  if (req.vlAdmin || !urls.length) return true;
  const a = await db.prepare('SELECT DISTINCT image_url FROM campaign_archives WHERE campaign_id = ? AND image_url = ANY(?)').all(cut.campaign_id, [urls]);
  const b = await db.prepare('SELECT DISTINCT m.image AS image_url FROM moments m JOIN session_forks f ON f.id = m.fork_id WHERE f.session_id = ? AND m.image = ANY(?)').all(cut.session_id, [urls]);
  const ok = {}; (a || []).concat(b || []).forEach(function (r) { ok[r.image_url] = true; });
  return urls.every(function (u) { return ok[u]; });
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
  const styles = VIDEO_STYLES.map(function (s) { return { key: s.key, label: s.label, description: s.description, speech: s.speech, defaultShot: s.defaultShot }; });   // v3.4.98
  res.json({ models: out, webhook: !!webhookUrl(), styles: styles, defaultStyle: DEFAULT_STYLE });
});

async function projectsWithShots(db, where, params) {
  const projects = await db.prepare('SELECT * FROM video_projects WHERE ' + where + ' ORDER BY created_at DESC, id DESC').all(params);
  if (!projects.length) return [];
  const ids = projects.map(function (p) { return p.id; });
  const shots = await db.prepare('SELECT * FROM video_shots WHERE project_id = ANY(?) ORDER BY project_id, position, id').all([ids]);
  projects.forEach(function (p) { p.shots = shots.filter(function (s) { return s.project_id === p.id; }); });
  const pics = await db.prepare('SELECT * FROM video_cut_pictures WHERE cut_id = ANY(?) ORDER BY cut_id, position, id').all([ids]);   // v3.4.95
  projects.forEach(function (p) { p.pictures = pics.filter(function (x) { return x.cut_id === p.id; }); });
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
// v3.4.95 -- ONE PLACE that turns pictures and the prompts between them into shots, and one that sends them, for the
// Lab route and for Generate on a cut alike (rule 5c: make the twin impossible). pics: [{url, archive_id}].
function planShots(m, pics, pairsIn, overall, fallbackDuration) {
  const shots = [];
  for (let i = 0; i < pics.length - 1; i++) {
    const pr = pairsIn[i] || {};
    const d = String(pr.duration || fallbackDuration || m.defDuration);
    if (m.durations.indexOf(d) < 0) return { error: 'Clip ' + (i + 1) + ': ' + d + ' seconds is not offered for ' + m.label + '.' };
    const own = String(pr.prompt || '').trim().slice(0, 1500);
    const full = shotPrompt(overall, own);
    if (m.promptRequired && !full) return { error: m.label + ' needs a prompt for clip ' + (i + 1) + ' (pictures ' + (i + 1) + ' to ' + (i + 2) + '), or an overall prompt.' };
    shots.push({ position: i + 1, start: pics[i], end: pics[i + 1], own: own, full: full, duration: d });
  }
  return { shots: shots };
}
// Save the shots, then send every one to fal; they are made side by side. A refusal fails that shot only.
async function sendShots(db, projectId, modelKey, m, shots, sound, hook) {
  for (const x of shots) {
    const r = await db.prepare('INSERT INTO video_shots (project_id, position, start_url, end_url, start_archive_id, end_archive_id, prompt, model, endpoint, duration, sound, status, est_cost_usd, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, x.position, x.start.url, x.end.url, x.start.archive_id || null, x.end.archive_id || null, x.full, modelKey, m.endpoint, x.duration, sound, 'queued', estCost(m, x.duration, sound), JSON.stringify({ own_prompt: x.own }));
    x.id = r.lastInsertRowid;
  }
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
  return sent;
}

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
  const plan = planShots(m, pics, pairsIn, overall, b.duration);
  if (plan.error) return res.status(400).json({ error: plan.error });
  const shots = plan.shots;
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
    const sent = await sendShots(db, projectId, b.model, m, shots, sound, hook);
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
    await db.prepare('DELETE FROM video_cut_pictures WHERE cut_id = ?').run(id);   // v3.4.95
    await db.prepare('DELETE FROM video_projects WHERE id = ?').run(id);
    console.log('[video-lab] deleted project ' + id + ' (' + shots.length + ' shot(s), ' + asked + '/' + files.length + ' file(s) sent for deletion)');
    res.json({ ok: true, files: files.length });
  } catch (e) {
    console.error('[video-lab] delete error:', e && e.message);
    res.status(500).json({ error: 'Could not delete it.' });
  }
});

// ---- cuts (v3.4.95) ------------------------------------------------------------------------
// A cut's draft: its settings JSON holds the overall prompt, the model, the sound choice and the prompts between pictures
// (pairs: [{prompt, duration}]); its pictures are rows in video_cut_pictures. Generate turns the draft into shots.
function cutSettings(p) { try { return JSON.parse(p.settings || '{}') || {}; } catch (e) { return {}; } }
function defaultCutName() { return 'Cut ' + new Date().toISOString().slice(0, 16).replace('T', ' '); }
async function loadCut(db, id) { const out = await projectsWithShots(db, "id = ? AND kind = 'cut'", [id]); return out[0] || null; }
async function writePictures(db, cutId, pics) {
  await db.prepare('DELETE FROM video_cut_pictures WHERE cut_id = ?').run(cutId);
  for (let i = 0; i < pics.length; i++) {
    const x = pics[i];
    await db.prepare('INSERT INTO video_cut_pictures (cut_id, position, image_url, source, moment_id, archive_id, label) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cutId, i + 1, x.url, x.source || 'archive', x.moment_id || null, x.archive_id || null, x.label ? String(x.label).slice(0, 200) : null);
  }
}
function cleanPictures(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_PICTURES).map(function (p) {
    p = p || {};
    const src = ['title', 'moment', 'archive'].indexOf(p.source) >= 0 ? p.source : 'archive';
    return { url: String(p.url || p.image_url || ''), source: src, moment_id: parseInt(p.moment_id, 10) || null, archive_id: parseInt(p.archive_id, 10) || null, label: p.label ? String(p.label) : null };
  }).filter(function (p) { return p.url; });
}
function cleanPairs(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_PICTURES).map(function (p) {
    p = p || {};
    return { prompt: String(p.prompt || '').slice(0, 1500), duration: String(p.duration || '') };
  });
}

// The cuts of one version of one session, newest first, the pinned one first.
router.get('/cuts', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const sid = parseInt(req.query.session_id, 10), fid = parseInt(req.query.fork_id, 10);
    if (!sid || !fid) return res.status(400).json({ error: 'session_id and fork_id are required' });
    if (!(await versionAccess(req, db, sid, fid))) return res.status(403).json({ error: 'You cannot see that version.' });
    const cuts = await projectsWithShots(db, "kind = 'cut' AND session_id = ? AND fork_id = ?", [sid, fid]);
    cuts.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    res.json({ cuts: cuts });
  } catch (e) {
    console.error('[video-lab] cuts list error:', e && e.message);
    res.status(500).json({ error: 'Could not load the cuts.' });
  }
});

// New cut: the version's storyboard pictures, title picture first. A draft until Generate.
router.post('/cuts', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const b = req.body || {};
    const sid = parseInt(b.session_id, 10), fid = parseInt(b.fork_id, 10);
    if (!sid || !fid) return res.status(400).json({ error: 'session_id and fork_id are required' });
    const s = await versionAccess(req, db, sid, fid);
    if (!s) return res.status(403).json({ error: 'You cannot make a cut of that version.' });
    const pics = await storyboardPictures(db, sid, fid);
    const model = MODELS[b.model] ? b.model : Object.keys(MODELS)[0];
    const settings = JSON.stringify({ overall_prompt: '', model: model, sound: false, pairs: [] });
    const r = await db.prepare('INSERT INTO video_projects (user_id, campaign_id, session_id, fork_id, name, kind, status, total_cost_usd, settings, source, pinned, style) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, s.campaign_id, sid, fid, cleanName(b.name) || defaultCutName(), 'cut', 'draft', 0, settings, 'storyboard', false, styleFor(b.style).key);   // v3.4.98: a new cut starts on Living Illustration
    await writePictures(db, r.lastInsertRowid, pics);
    console.log('[video-lab] cut ' + r.lastInsertRowid + ' made from version ' + fid + ' of session ' + sid + ': ' + pics.length + ' picture(s)');
    res.json({ cut: await loadCut(db, r.lastInsertRowid) });
  } catch (e) {
    console.error('[video-lab] new cut error:', e && e.message);
    res.status(500).json({ error: 'Could not make the cut.' });
  }
});

// Save a draft: name, overall prompt, model, sound, pictures in order and the prompts between them.
// v3.4.99 -- STEPS TO THE DEBUG LOG (Ian, 2026-11-07: every save of a cut and Write the shot list failed on staging
// with no reason shown; "spend some time writing some steps to the debug log"). Every refusal and failure of a cut's
// save and of the shot list is written to the debug log (only for a user with Debug Mode on: logDebug checks) and to
// the server log (always), with the reason and what was sent. Never awaited and never thrown: a log that fails costs
// nothing. Does not change what any route does or answers.
function vlDebug(userId, level, fn, message, detail) {
  try {
    require('./debug').logDebug(userId, { level: level, source: 'video', page: 'Video tab', fn: fn, message: String(message).slice(0, 500), detail: detail || null })
      .catch(function () {});
  } catch (e) {}
}
// One refusal: to the server log, to the debug log, and the same answer the route always gave.
function vlRefuse(req, res, fn, status, error, detail) {
  try { console.warn('[video-lab] ' + fn + ' refused (' + status + '): ' + error + (detail ? ' ' + JSON.stringify(detail).slice(0, 600) : '')); } catch (e) {}
  vlDebug(req.session && req.session.userId, 'warn', fn, 'Refused (' + status + '): ' + error, detail);
  return res.status(status).json({ error: error });
}
// What a save carried, in short (no picture addresses in full; the first 80 characters of each).
function vlSaveSummary(b) {
  b = b || {};
  return { name: b.name != null ? String(b.name).slice(0, 120) : undefined, model: b.model, sound: b.sound, style: b.style,
    overall_chars: b.overall_prompt != null ? String(b.overall_prompt).length : undefined,
    pictures: Array.isArray(b.pictures) ? b.pictures.length : undefined, pairs: Array.isArray(b.pairs) ? b.pairs.length : undefined };
}
function vlShortUrl(u) { u = String(u || ''); return u.length > 80 ? u.slice(0, 80) + '...' : u; }

router.put('/cuts/:id', requireAuth, requireVideo, async function (req, res) {
  const FN = 'PUT /api/video-lab/cuts/' + req.params.id;
  try {
    await ensureTables();
    const db = await getDb();
    const cut = await db.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(parseInt(req.params.id, 10));
    if (!(await canChange(req, cut))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!cut, maker: cut ? cut.user_id : null, admin: !!req.vlAdmin });
    if (cut.status !== 'draft') return vlRefuse(req, res, FN, 409, 'This cut has been made; copy it to change its pictures.', { status: cut.status });
    if (await runningShotList(db, cut.id)) return vlRefuse(req, res, FN, 409, 'The shot list is being written; your changes can be made when it is done.');   // v3.4.98
    const b = req.body || {};
    const st = cutSettings(cut);
    if (b.overall_prompt != null) st.overall_prompt = String(b.overall_prompt).slice(0, 2000);
    if (b.model != null && MODELS[b.model]) st.model = b.model;
    if (b.sound != null) st.sound = !!b.sound;
    if (b.pairs != null) st.pairs = cleanPairs(b.pairs);
    if (b.pictures != null) {
      const pics = cleanPictures(b.pictures);
      const notOurs = pics.map(function (p, i) { return { n: i + 1, source: p.source, url: vlShortUrl(p.url) }; }).filter(function (x, i) { return !storage.isOurPublicUrl(pics[i].url); });   // v3.4.99
      if (notOurs.length) return vlRefuse(req, res, FN, 400, 'Every picture must be a Campaignia picture.', { sent: vlSaveSummary(b), not_campaignia: notOurs.slice(0, 10) });
      if (!(await picturesAllowed(req, db, cut, pics.map(function (p) { return p.url; })))) return vlRefuse(req, res, FN, 400, 'Every picture must come from this campaign.', { sent: vlSaveSummary(b) });
      await writePictures(db, cut.id, pics);
    }
    const name = b.name != null ? (cleanName(b.name) || cut.name) : cut.name;
    const style = (b.style != null && VIDEO_STYLES.some(function (s) { return s.key === b.style; })) ? b.style : cut.style;   // v3.4.98
    await db.prepare('UPDATE video_projects SET name = ?, settings = ?, style = ?, updated_at = NOW() WHERE id = ?').run(name, JSON.stringify(st), style, cut.id);
    vlDebug(req.session.userId, 'info', FN, 'Saved the cut', { sent: vlSaveSummary(b) });   // v3.4.99
    res.json({ cut: await loadCut(db, cut.id) });
  } catch (e) {
    console.error('[video-lab] save cut error:', e && e.message, e && e.stack);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Save failed: ' + (e && e.message), { sent: vlSaveSummary(req.body), code: e && e.code, stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });   // v3.4.99
    res.status(500).json({ error: 'Could not save the cut.' });
  }
});

// Generate: the draft's pictures and prompts become shots, sent to fal; the cut then finishes like a Lab run.
router.post('/cuts/:id/generate', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cut = await db.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(parseInt(req.params.id, 10));
    if (!(await canChange(req, cut))) return res.status(404).json({ error: 'Not found.' });
    if (await runningShotList(db, cut.id)) return res.status(409).json({ error: 'The shot list is still being written; Generate when it is done.' });   // v3.4.98
    const st = cutSettings(cut);
    const m = MODELS[st.model];
    if (!m) return res.status(400).json({ error: 'Pick a model.' });
    const hook = webhookUrl();
    if (!hook) return res.status(500).json({ error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' });
    const rows = await db.prepare('SELECT * FROM video_cut_pictures WHERE cut_id = ? ORDER BY position, id').all(cut.id);
    const pics = rows.map(function (r) { return { url: r.image_url, archive_id: r.archive_id }; });
    if (pics.length < 2) return res.status(400).json({ error: 'A cut needs two pictures at least.' });
    const plan = planShots(m, pics, st.pairs || [], String(st.overall_prompt || '').trim(), null);
    if (plan.error) return res.status(400).json({ error: plan.error });
    // Claim the draft (one Generate wins, even with two clicks or two tabs).
    const claim = await db.prepare("UPDATE video_projects SET status = 'making', updated_at = NOW() WHERE id = ? AND status = 'draft'").run(cut.id);
    if (!claim.changes) return res.status(409).json({ error: 'This cut has already been made.' });
    const sound = !!st.sound;
    const total = Math.round(plan.shots.reduce(function (t, x) { return t + estCost(m, x.duration, sound); }, 0) * 10000) / 10000;
    await db.prepare('UPDATE video_projects SET total_cost_usd = ?, updated_at = NOW() WHERE id = ?').run(total, cut.id);
    const sent = await sendShots(db, cut.id, st.model, m, plan.shots, sound, hook);
    await projectStatus(db, cut.id);
    const out = await loadCut(db, cut.id);
    if (!sent) return res.status(502).json({ error: 'fal refused the cut: ' + ((out && out.shots[0] && out.shots[0].error) || 'unknown'), cut: out });
    res.json({ cut: out });
  } catch (e) {
    console.error('[video-lab] generate cut error:', falErrorText(e));
    res.status(500).json({ error: 'Could not start it: ' + falErrorText(e) });
  }
});

// Copy a cut into a new draft of the same version: its pictures, prompts, model and sound (from its shots once made).
router.post('/cuts/:id/copy', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const src = await loadCut(db, parseInt(req.params.id, 10));
    if (!src || !(await canSee(req, src))) return res.status(404).json({ error: 'Not found.' });
    if (!(await versionAccess(req, db, src.session_id, src.fork_id))) return res.status(403).json({ error: 'You cannot make a cut of that version.' });
    const st = cutSettings(src);
    const shots = src.shots || [];
    const pairs = (st.pairs && st.pairs.length && !shots.length) ? st.pairs : shots.map(function (s) {
      let own = ''; try { own = (JSON.parse(s.settings || '{}') || {}).own_prompt || ''; } catch (e) {}
      return { prompt: own, duration: String(s.duration || '') };
    });
    const model = MODELS[st.model] ? st.model : (shots[0] && MODELS[shots[0].model] ? shots[0].model : Object.keys(MODELS)[0]);
    const settings = JSON.stringify({ overall_prompt: st.overall_prompt || '', model: model, sound: !!st.sound, pairs: cleanPairs(pairs) });
    const name = cleanName(String(src.name || 'Cut') + ' (copy)');
    const r = await db.prepare('INSERT INTO video_projects (user_id, campaign_id, session_id, fork_id, name, kind, status, total_cost_usd, settings, source, pinned, style, shot_list) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, src.campaign_id, src.session_id, src.fork_id, name, 'cut', 'draft', 0, settings, 'copy', false, src.style || null, src.shot_list || null);   // v3.4.98: the style and shot list come too
    await writePictures(db, r.lastInsertRowid, (src.pictures || []).map(function (p) { return { url: p.image_url, source: p.source, moment_id: p.moment_id, archive_id: p.archive_id, label: p.label }; }));
    res.json({ cut: await loadCut(db, r.lastInsertRowid) });
  } catch (e) {
    console.error('[video-lab] copy cut error:', e && e.message);
    res.status(500).json({ error: 'Could not copy the cut.' });
  }
});

// Pin: the one cut of this version of this session that Final Cut will use. Pinning one unpins the others.
router.post('/cuts/:id/pin', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cut = await db.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(parseInt(req.params.id, 10));
    if (!(await canChange(req, cut))) return res.status(404).json({ error: 'Not found.' });
    const on = !(req.body && req.body.pinned === false);
    if (on) await db.prepare("UPDATE video_projects SET pinned = FALSE, updated_at = NOW() WHERE kind = 'cut' AND session_id = ? AND fork_id = ? AND id <> ? AND pinned = TRUE").run(cut.session_id, cut.fork_id, cut.id);
    await db.prepare('UPDATE video_projects SET pinned = ?, updated_at = NOW() WHERE id = ?').run(on, cut.id);
    res.json({ cut: await loadCut(db, cut.id) });
  } catch (e) {
    console.error('[video-lab] pin error:', e && e.message);
    res.status(500).json({ error: 'Could not pin it.' });
  }
});

// ---- the shot list (v3.4.98) -----------------------------------------------------------------
// Video Phase 2, build 3 (claude/VIDEO_PHASE2_SPEC.md section 15). Ian, 2026-11-07: "for the cut you would pick the
// video style... Then it would generate the prompts that go on each shot... and then that in conjunction with the story
// would all be fed to the video AI engine". Write the shot list sends the version's story, the cut's pictures (as
// pictures and as words), the cast, the art style, the genre, the chosen style's rules and the video model's limits to
// the model that writes the story (TEXT_MODEL), and fills the Overall direction and every shot box from what comes back.
// The book's narrative is only read, never written. It runs as a job (a long chapter with pictures can pass Cloudflare's
// ~100 s ceiling, TD-396): one row per press in video_shotlist_jobs, one running per cut (a partial unique index), so a
// deploy mid-call reads "interrupted, nothing charged" instead of spinning. Tokens (Ian: "one token... or more if it's
// more than 8 cents"): max(1, ceil(actual cost / 8 cents)), worked out from the reply's usage at the stored prices, and
// charged only once the boxes are filled. Additive only (spec section 0): one new table; nothing outside the Video tab
// reads it. The clips themselves stay free.

// The first three video styles (Ian, 2026-11-07: Animated, Living Illustration, Documentary). Records like narrative
// styles, kept here for this build. defaultShot is snapped to the chosen model's durations.
const VIDEO_STYLES = [
  { key: 'animated', label: 'Animated',
    description: 'Full motion: the characters act, move and speak; the camera follows the action.',
    motion: 'high', defaultShot: 5, speech: true,
    instructions: 'ANIMATED. Real action happens between the two pictures: name what each character in the shot does, step by step, so the movement carries the first picture into the second. The camera may move (follow, pan, push in, pull back) to serve the action. Characters may speak: short lines in their own words, said by a character who is in the shot, a few words that fit inside the shot\'s length (about two words a second at most). Add sound effects that fit. Keep faces, costumes and the art style true to the pictures: more motion means more drift, so keep the action clear and simple rather than busy.' },
  { key: 'living', label: 'Living Illustration',
    description: 'The picture comes alive gently: cloaks stir, fire flickers, dust drifts, a slow push in. Characters hold their poses.',
    motion: 'low', defaultShot: 5, speech: false,
    instructions: 'LIVING ILLUSTRATION. Subtle motion only: hair and cloth stirring, light and flame flickering, smoke, dust, rain or particles drifting, breathing, blinking. Characters keep their pose and their place; nobody walks, fights or gestures. The camera is slow (a gentle push in or pan) or still. No speech. Keep the art style exactly as painted. The move from one picture to the next is a slow drift or dissolve, never a cut or a jump.' },
  { key: 'documentary', label: 'Documentary',
    description: 'Slow camera moves across each picture, like a documentary. Narration comes later with voices.',
    motion: 'low', defaultShot: 6, speech: false,
    instructions: 'DOCUMENTARY. Treat each shot as a slow camera move over the start picture that settles toward the end picture, as in a documentary about paintings: say which part of the picture the camera starts on, where it drifts or zooms, and what it comes to rest on. Nothing in the picture moves by itself: no character motion. No speech (narration comes later). Ambient sound only (wind, a room, a crowd far off).' }
];
const DEFAULT_STYLE = 'living';
function styleFor(key) {
  for (let i = 0; i < VIDEO_STYLES.length; i++) if (VIDEO_STYLES[i].key === key) return VIDEO_STYLES[i];
  for (let i = 0; i < VIDEO_STYLES.length; i++) if (VIDEO_STYLES[i].key === DEFAULT_STYLE) return VIDEO_STYLES[i];
  return VIDEO_STYLES[0];
}
// The offered duration nearest to want (the longer on a tie: 5 s on a 4/6/8 model is 6), as the model's own string.
function snapDuration(m, want) {
  const n = Number(want);
  if (!Number.isFinite(n)) return null;
  let best = null;
  m.durations.forEach(function (d) {
    const a = Math.abs(Number(d) - n), b = best === null ? Infinity : Math.abs(Number(best) - n);
    if (a < b || (a === b && Number(d) > Number(best))) best = d;
  });
  return best;
}

const SL_MAX_IMAGES = 20;            // pictures sent as pictures; the rest go as words only (spec 15.3)
const SL_IMAGE_PX = 512;             // the long side of each picture sent
const SL_STORY_CHARS = 30000;        // the version's story is trimmed to this
const SL_TIMEOUT_MS = 240000;        // one call to the model
const SL_STALE_MS = 10 * 60 * 1000;  // a job still 'running' after this was lost
const SL_BOOT_GRACE_MS = 3 * 60 * 1000;   // a job from an earlier server process is lost once it is this old
const SL_BOOT = require('crypto').randomBytes(6).toString('hex');   // this process; a deploy starts another
// Prices live in app_settings so they can change without a deploy. Defaults: Claude Sonnet 4.6 list prices (USD per
// million tokens, input 3, output 15; Anthropic's pricing, read 2026-11-07) and 8 cents a token (Ian).
const SL_DEFAULTS = { shotlist_cents_per_token: 8, shotlist_price_in_per_mtok: 3, shotlist_price_out_per_mtok: 15 };
async function shotListPrices(db) {
  const out = {};
  for (const k of Object.keys(SL_DEFAULTS)) {
    let v = null;
    try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(k); v = r ? parseFloat(r.value) : null; } catch (e) { v = null; }
    out[k] = (Number.isFinite(v) && v > 0) ? v : SL_DEFAULTS[k];
  }
  return out;
}
function usdFor(prices, inTok, outTok) {
  return (Number(inTok || 0) * prices.shotlist_price_in_per_mtok + Number(outTok || 0) * prices.shotlist_price_out_per_mtok) / 1000000;
}
function tokensFor(prices, usd) {
  const n = Math.ceil((Number(usd || 0) * 100) / prices.shotlist_cents_per_token - 1e-9);
  return Math.max(1, Number.isFinite(n) ? n : 1);
}

// The version's story as the Storyboard shows it: the opening, then each picture's own text and the text after it, in
// panel order (the title picture's hidden block is skipped, TD-1106). byMoment: a picture's own text, by moment id.
function textOf(v) { return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim(); }
async function storyOfVersion(db, forkId) {
  const fork = await db.prepare('SELECT id, narrative_intro, narrative_sections, narrative_outro, art_style_override FROM session_forks WHERE id = ?').get(forkId);
  const moments = await db.prepare('SELECT id, kind, title, description FROM moments WHERE fork_id = ? ORDER BY panel_order ASC, id ASC').all(forkId);
  const byMoment = {};
  const parts = [];
  if (fork && textOf(fork.narrative_intro)) parts.push(textOf(fork.narrative_intro));
  let blocks = null;
  try { blocks = require('../services/panelOrder').readNorm(fork ? fork.narrative_sections : null, moments); } catch (e) { blocks = null; }
  if (!blocks && fork && fork.narrative_sections) {
    try { const raw = JSON.parse(fork.narrative_sections); if (Array.isArray(raw) && raw.length === moments.length) blocks = raw; } catch (e) { blocks = null; }
  }
  moments.forEach(function (mo, i) {
    if (mo.kind === 'establishing') return;
    const b = blocks ? (blocks[i] || {}) : {};
    const own = textOf(b.before);
    if (own) byMoment[mo.id] = own;
    parts.push('[Picture: ' + textOf(mo.title || 'untitled') + ']' + (own ? '\n' + own : ''));
    const after = textOf(b.after);
    if (after) parts.push(after);
  });
  if (fork && textOf(fork.narrative_outro)) parts.push(textOf(fork.narrative_outro));
  let text = parts.join('\n\n');
  const hasStory = !!(blocks || (fork && (textOf(fork.narrative_intro) || textOf(fork.narrative_outro))));
  let trimmed = false;
  if (text.length > SL_STORY_CHARS) { text = text.slice(0, SL_STORY_CHARS); trimmed = true; }
  return { fork: fork, moments: moments, text: hasStory ? text : '', byMoment: byMoment, trimmed: trimmed };
}

// Everything the writer is told about one cut, read fresh at the press.
async function shotListContext(db, cut) {
  const st = cutSettings(cut);
  const m = MODELS[st.model] || MODELS[Object.keys(MODELS)[0]];
  const style = styleFor(cut.style);
  const pics = await db.prepare('SELECT * FROM video_cut_pictures WHERE cut_id = ? ORDER BY position, id').all(cut.id);
  const story = await storyOfVersion(db, cut.fork_id);
  const session = await db.prepare('SELECT id, name, art_style FROM sessions WHERE id = ?').get(cut.session_id);
  const campaign = await db.prepare('SELECT id, name, art_style, genres FROM campaigns WHERE id = ?').get(cut.campaign_id);
  const momentsById = {}; story.moments.forEach(function (mo) { momentsById[mo.id] = mo; });
  let cast = await db.prepare('SELECT ch.name, ch.cls, ch.description, ch.is_npc, sc.prompt FROM session_characters sc JOIN characters ch ON ch.id = sc.character_id WHERE sc.fork_id = ? ORDER BY ch.is_npc ASC, ch.id ASC').all(cut.fork_id);
  if (!cast.length) cast = await db.prepare('SELECT name, cls, description, is_npc, canonical_prompt AS prompt FROM characters WHERE campaign_id = ? ORDER BY is_npc ASC, id ASC LIMIT 40').all(cut.campaign_id);
  let artStyle = String((story.fork && story.fork.art_style_override) || (session && session.art_style) || (campaign && campaign.art_style) || '').trim();
  const cm = /^custom:(\d+)$/i.exec(artStyle);
  if (cm) {
    try { const r = await db.prepare('SELECT name FROM custom_art_styles WHERE id = ?').get(parseInt(cm[1], 10)); artStyle = (r && r.name) ? String(r.name) : 'a custom art style'; } catch (e) { artStyle = 'a custom art style'; }
  } else if (artStyle) {
    try { artStyle = require('../services/artStyleCatalog').labelFor(artStyle); } catch (e) {}
  }
  let genres = [];
  try { genres = require('../services/genres').genreLabels(campaign); } catch (e) { genres = []; }
  return {
    cut: cut, m: m, modelKey: st.model, style: style, story: story, cast: cast, artStyle: artStyle, genres: genres,
    sessionName: session ? String(session.name || '') : '', campaignName: campaign ? String(campaign.name || '') : '',
    pictures: pics.map(function (p, i) {
      const mo = p.moment_id ? momentsById[p.moment_id] : null;
      let words;
      if (p.source === 'title') words = 'The title picture (the opening shot).';
      else if (mo) words = 'A storyboard picture: "' + textOf(mo.title) + '".' + (textOf(mo.description) ? ' What it shows: ' + textOf(mo.description).slice(0, 600) : '') +
        (story.byMoment[mo.id] ? '\nIts text in the story: ' + story.byMoment[mo.id].slice(0, 1200) : '');
      else words = 'A picture from the Archive' + (p.label ? ': "' + textOf(p.label) + '"' : '') + '.';
      return { n: i + 1, url: p.image_url, words: words };
    })
  };
}

// An estimate before the press, from the cut's size (pictures and story length): what the button shows and the
// balance must cover. The charge afterwards is worked out from the real usage instead.
function estimateShotList(ctx, prices) {
  const n = ctx.pictures.length, shots = Math.max(0, n - 1);
  const words = ctx.pictures.reduce(function (t, p) { return t + p.words.length; }, 0);
  const castChars = ctx.cast.reduce(function (t, c) { return t + String(c.name || '').length + String(c.description || '').length + Math.min(800, String(c.prompt || '').length); }, 0);
  const inTok = Math.ceil((4000 + ctx.story.text.length + words + castChars) / 4) + Math.min(n, SL_MAX_IMAGES) * 360;
  const outTok = 300 + shots * 170;
  const usd = usdFor(prices, inTok, outTok);
  return { input_tokens: inTok, output_tokens: outTok, usd: Math.round(usd * 10000) / 10000, tokens: tokensFor(prices, usd), shots: shots };
}

// One picture, small, for the writer to look at (only our own pictures are fetched). null when it cannot be read: that
// picture then goes as words only.
async function pictureForModel(url) {
  try {
    if (!url || !storage.isOurPublicUrl(url)) return null;
    const axios = require('axios');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024 });
    const out = await require('sharp')(Buffer.from(resp.data)).rotate().resize({ width: SL_IMAGE_PX, height: SL_IMAGE_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    return out.toString('base64');
  } catch (e) {
    console.warn('[video-lab] shot list: could not read a picture (' + (e && e.message) + ')');
    return null;
  }
}

// What goes to the model: the rules in the system part, the cut in the message (story, cast, then each picture with its
// words), and the exact JSON asked for. images: base64 per picture index, or null.
function shotListRequest(ctx, images) {
  const m = ctx.m, style = ctx.style;
  const shots = ctx.pictures.length - 1;
  const def = snapDuration(m, style.defaultShot) || m.defDuration;
  const system =
    'You are the director of a short video made from the illustrations of a story. The video is made by an image-to-video model, ' + m.label + ', ' +
    'one shot at a time: each shot starts exactly on one picture and ends exactly on the next, and the model is told what happens in between. ' +
    'You write the shot list: an overall direction for the whole video, then one shot for each pair of pictures, in order.\n\n' +
    'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
    'THE VIDEO MODEL\nShot lengths it offers, in seconds: ' + m.durations.join(', ') + '. Give every shot one of these exact numbers; ' + def + ' suits this style unless a shot needs more or less time. ' +
    'Each shot runs from its start picture to its end picture, so describe how the first becomes the second, not a new scene. The model sees only the two pictures and your words: ' +
    'name people as the pictures show them and describe what they do in plain visual terms.\n\n' +
    'THE OVERALL DIRECTION is sent with every shot: one short paragraph (at most 600 characters) naming the setting, the mood, the light, and each main character\'s look in words ' +
    '(build, hair, clothes, colours) so every shot keeps them the same. Keep the art style as it is in the pictures.\n\n' +
    'RULES\n- Keep the names exactly as the story and the cast list write them.\n- Each shot\'s action is at most 450 characters; camera, sound and each line short.\n' +
    (style.speech ? '- Dialogue: only a character visible in that shot speaks; at most two short lines a shot; leave it empty when nobody should talk.\n' : '- Dialogue: always an empty list in this style.\n') +
    '- Write original words; never reproduce text from any published source.\n- Never put words, captions or titles on screen.\n\n' +
    'ANSWER WITH ONLY THIS JSON, no other text:\n' +
    '{"overall": "...", "shots": [{"action": "...", "camera": "...", "dialogue": [{"speaker": "...", "line": "..."}], "sound": "...", "duration": "' + def + '"}]}\n' +
    'The shots list has exactly ' + shots + ' entr' + (shots === 1 ? 'y' : 'ies') + ': the first goes from picture 1 to picture 2, the last from picture ' + shots + ' to picture ' + (shots + 1) + '.';
  const content = [];
  const head = [];
  head.push('THE STORY: ' + (ctx.campaignName ? '"' + ctx.campaignName + '"' : 'untitled') + (ctx.sessionName ? ', the session "' + ctx.sessionName + '"' : '') + '.');
  if (ctx.genres.length) head.push('Genre: ' + ctx.genres.join(', ') + '.');
  if (ctx.artStyle) head.push('Art style of the pictures: ' + ctx.artStyle + '.');
  head.push('');
  head.push(ctx.story.text ? ('The story of this version, as the book tells it' + (ctx.story.trimmed ? ' (trimmed: it is long)' : '') + ':\n' + ctx.story.text)
    : 'This version has no written story yet; work from the pictures and their words.');
  if (ctx.cast.length) {
    head.push('');
    head.push('THE CAST (as they are drawn):');
    ctx.cast.forEach(function (c) {
      const look = String(c.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      head.push('- ' + String(c.name || '').trim() + (c.is_npc ? ' (not a player character)' : '') + (c.cls ? ', ' + String(c.cls).trim() : '') +
        (c.description ? ': ' + String(c.description).replace(/\s+/g, ' ').trim().slice(0, 400).replace(/[.\s]*$/, '.') : '') + (look ? ' Looks: ' + look : ''));
    });
  }
  head.push('');
  const sent = images.filter(Boolean).length;
  head.push('THE PICTURES OF THIS VIDEO, IN ORDER (' + ctx.pictures.length + ' pictures, so ' + shots + ' shot' + (shots === 1 ? '' : 's') + ').' +
    (sent < ctx.pictures.length ? (sent ? ' Only ' + sent + ' are shown as pictures; the others are described in words only.' : ' They are described in words only.') : ''));
  content.push({ type: 'text', text: head.join('\n') });
  ctx.pictures.forEach(function (p, i) {
    content.push({ type: 'text', text: 'Picture ' + p.n + '. ' + p.words });
    if (images[i]) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[i] } });
  });
  content.push({ type: 'text', text: 'Now write the shot list as JSON: the overall direction and exactly ' + shots + ' shot' + (shots === 1 ? '' : 's') + ', in the ' + style.label + ' style.' });
  return { system: system, content: content, max_tokens: Math.min(16000, 1200 + shots * 450) };
}

// The reply, checked: readable JSON, exactly one shot per pair, a length the model offers (the nearest offered length
// when it gave another number). Anything else is { error } and is tried once more.
function parseShotList(raw, ctx) {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  let p = null;
  try { p = JSON.parse(clean); } catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { p = JSON.parse(clean.slice(a, b + 1)); } catch (e2) { p = null; } }
  }
  if (!p || typeof p !== 'object' || !Array.isArray(p.shots)) return { error: 'unreadable' };
  const want = ctx.pictures.length - 1;
  if (p.shots.length !== want) return { error: 'came back with ' + p.shots.length + ' shots, not ' + want };
  const shots = [];
  for (let i = 0; i < p.shots.length; i++) {
    const s = p.shots[i] || {};
    const d = snapDuration(ctx.m, parseFloat(String(s.duration == null ? '' : s.duration).replace(/[^0-9.]/g, '')));
    if (!d) return { error: 'shot ' + (i + 1) + ' has no length' };
    let dlg = [];
    if (Array.isArray(s.dialogue)) dlg = s.dialogue.map(function (x) { return { speaker: textOf(x && x.speaker).slice(0, 80), line: textOf(x && x.line).replace(/^["\u201c]+|["\u201d]+$/g, '').slice(0, 300) }; }).filter(function (x) { return x.line; });
    else if (textOf(s.dialogue)) dlg = [{ speaker: '', line: textOf(s.dialogue).slice(0, 300) }];
    if (!ctx.style.speech) dlg = [];
    shots.push({ action: textOf(s.action).slice(0, 900), camera: textOf(s.camera).slice(0, 300), dialogue: dlg.slice(0, 4), sound: textOf(s.sound).slice(0, 300), duration: d });
  }
  return { overall: textOf(p.overall).slice(0, 2000), shots: shots };
}

// What a shot box says: plain words the person can edit, and exactly what the video model will be sent.
function shotBoxText(s) {
  const lines = [];
  if (s.action) lines.push(s.action);
  if (s.camera) lines.push('Camera: ' + s.camera);
  (s.dialogue || []).forEach(function (x) { lines.push((x.speaker ? x.speaker + ': ' : '') + '"' + x.line + '"'); });
  if (s.sound) lines.push('Sound: ' + s.sound);
  return lines.join('\n').slice(0, 1500);
}

async function callShotListModel(key, req) {
  const { TEXT_MODEL } = require('../config/models');
  const ac = new AbortController();
  const t = setTimeout(function () { try { ac.abort(); } catch (e) {} }, SL_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: TEXT_MODEL, max_tokens: req.max_tokens, system: req.system, messages: [{ role: 'user', content: req.content }] }),
      signal: ac.signal
    });
    const data = await r.json();
    if (!data || data.error || !Array.isArray(data.content)) return { error: (data && data.error && data.error.message) || ('the writer answered ' + r.status), usage: (data && data.usage) || {} };
    return { text: data.content.map(function (b) { return b.text || ''; }).join(''), usage: data.usage || {}, truncated: data.stop_reason === 'max_tokens' };
  } catch (e) {
    return { error: (e && e.name === 'AbortError') ? 'the writer took too long to answer' : 'the writer could not be reached', usage: {} };
  } finally { clearTimeout(t); }
}

// A job left 'running' by a server that has gone (a deploy, a restart) is marked interrupted: nothing was charged.
async function retireLostJobs(db, cutId) {
  const now = Date.now();
  const rows = await db.prepare("SELECT id, boot_id, started_at FROM video_shotlist_jobs WHERE cut_id = ? AND status = 'running'").all(cutId);
  for (const j of rows) {
    const age = now - new Date(j.started_at).getTime();
    if (age > SL_STALE_MS || (j.boot_id !== SL_BOOT && age > SL_BOOT_GRACE_MS)) {
      await db.prepare("UPDATE video_shotlist_jobs SET status = 'interrupted', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'")
        .run('Interrupted (the server restarted while it was being written). Nothing was charged; try again.', j.id);
    }
  }
}
async function runningShotList(db, cutId) {
  await retireLostJobs(db, cutId);
  return db.prepare("SELECT id FROM video_shotlist_jobs WHERE cut_id = ? AND status = 'running' LIMIT 1").get(cutId);
}
function jobView(j) {
  if (!j) return null;
  return { id: j.id, status: j.status, error: j.error || null, tokens_charged: j.tokens_charged || 0, style: j.style, started_at: j.started_at, finished_at: j.finished_at };
}

// The job itself, after the press has been answered. Two tries at most; the boxes are filled and the tokens charged
// only when the job is still this one's to finish (a deleted cut or an interrupted job charges nothing).
async function runShotList(jobId, cutId, userId, ctx, prices, key) {
  const db = await getDb();
  let inTok = 0, outTok = 0, result = null, lastErr = '';
  try {
    const JFN = 'shot list job ' + jobId + ' (cut ' + cutId + ')';   // v3.4.99: each step to the debug log
    const images = [];
    for (let i = 0; i < ctx.pictures.length; i++) images.push(i < SL_MAX_IMAGES ? await pictureForModel(ctx.pictures[i].url) : null);
    vlDebug(userId, 'info', JFN, 'Pictures read for the writer: ' + images.filter(Boolean).length + ' of ' + ctx.pictures.length,
      { unread: ctx.pictures.map(function (p, i) { return images[i] ? null : { n: p.n, url: vlShortUrl(p.url) }; }).filter(Boolean).slice(0, 20) });
    const req = shotListRequest(ctx, images);
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      const r = await callShotListModel(key, req);
      inTok += Number((r.usage && r.usage.input_tokens) || 0); outTok += Number((r.usage && r.usage.output_tokens) || 0);
      if (r.error) { lastErr = r.error; vlDebug(userId, 'warn', JFN, 'Call ' + attempt + ' to the writer failed: ' + r.error, { usage: r.usage }); continue; }
      const p = parseShotList(r.text, ctx);
      if (p.error) { lastErr = (r.truncated ? 'it ran out of room' : p.error); vlDebug(userId, 'warn', JFN, 'Call ' + attempt + ': the reply did not pass the checks (' + lastErr + ')', { usage: r.usage, truncated: !!r.truncated, reply_start: String(r.text || '').slice(0, 600) }); continue; }
      vlDebug(userId, 'info', JFN, 'Call ' + attempt + ': ' + p.shots.length + ' shot(s) read', { usage: r.usage });
      result = p;
    }
  } catch (e) { lastErr = (e && e.message) || 'unknown error'; vlDebug(userId, 'error', 'shot list job ' + jobId, 'The job threw: ' + lastErr, { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' }); }
  const usd = Math.round(usdFor(prices, inTok, outTok) * 10000) / 10000;
  if (!result) {
    await db.prepare("UPDATE video_shotlist_jobs SET status = 'error', error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'")
      .run(('The shot list came back incomplete (' + lastErr + '). Nothing was charged; try again.').slice(0, 1000), inTok, outTok, usd, jobId);
    console.error('[video-lab] shot list job ' + jobId + ' failed: ' + lastErr + ' ($' + usd + ' to Campaignia)');
    vlDebug(userId, 'error', 'shot list job ' + jobId, 'Failed after two tries: ' + lastErr, { input_tokens: inTok, output_tokens: outTok, cost_usd: usd });   // v3.4.99
    return;
  }
  const charge = tokensFor(prices, usd);
  const shotList = { style: ctx.style.key, model: ctx.modelKey, written_at: new Date().toISOString(), overall: result.overall, shots: result.shots };
  let filled = false;
  await db.transaction(async function (tx) {
    const claim = await tx.prepare("UPDATE video_shotlist_jobs SET status = 'done', input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run(inTok, outTok, usd, jobId);
    if (!claim.changes) return;
    const cut = await tx.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(cutId);
    const n = await tx.prepare('SELECT COUNT(*)::int AS n FROM video_cut_pictures WHERE cut_id = ?').get(cutId);
    if (!cut || cut.status !== 'draft' || !n || n.n !== result.shots.length + 1) {
      await tx.prepare("UPDATE video_shotlist_jobs SET status = 'error', error = ? WHERE id = ?").run('The cut changed while its shot list was being written. Nothing was charged; try again.', jobId);
      return;
    }
    const st = cutSettings(cut);
    st.overall_prompt = result.overall;
    st.pairs = result.shots.map(function (s) { return { prompt: shotBoxText(s), duration: s.duration }; });
    await tx.prepare('UPDATE video_projects SET settings = ?, shot_list = ?, style = ?, updated_at = NOW() WHERE id = ?').run(JSON.stringify(st), JSON.stringify(shotList), ctx.style.key, cutId);
    filled = true;
  });
  if (!filled) { console.log('[video-lab] shot list job ' + jobId + ': not filled (cut changed, deleted or job interrupted); nothing charged'); vlDebug(userId, 'warn', 'shot list job ' + jobId, 'Not filled (the cut changed, was deleted, or the job was interrupted); nothing charged'); return; }
  let charged = 0;
  try {
    const tokens = require('./tokens');
    const bal = await tokens.getBalance(userId);
    charged = Math.min(charge, Math.max(0, bal.total));
    if (charged > 0) await tokens.spendTokens(userId, charged, { source: 'video_shot_list', event_type: 'generation_spend', related_campaign_id: ctx.cut.campaign_id });
    if (charged < charge) console.warn('[video-lab] shot list job ' + jobId + ': balance covered ' + charged + ' of ' + charge + ' token(s)');
    await tokens.recordGeneration(userId, { event_type: 'video_shot_list', tokens_redeemed: charged, quantity: result.shots.length, unit: 'shots', model: require('../config/models').TEXT_MODEL, related_campaign_id: ctx.cut.campaign_id, related_session_id: ctx.cut.session_id });
  } catch (e) { console.error('[video-lab] shot list charge failed:', e && e.message); }
  await db.prepare('UPDATE video_shotlist_jobs SET tokens_charged = ? WHERE id = ?').run(charged, jobId);
  console.log('[video-lab] shot list job ' + jobId + ' for cut ' + cutId + ': ' + result.shots.length + ' shot(s), ' + inTok + ' in / ' + outTok + ' out, $' + usd + ', ' + charged + ' token(s)');
  vlDebug(userId, 'info', 'shot list job ' + jobId, 'Boxes filled: ' + result.shots.length + ' shot(s), ' + charged + ' token(s) charged', { input_tokens: inTok, output_tokens: outTok, cost_usd: usd, worked_out: charge });   // v3.4.99
}

// The press. Answers at once with the job; the tab asks GET below until it is done.
router.post('/cuts/:id/shot-list', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/cuts/' + req.params.id + '/shot-list';   // v3.4.99
  try {
    await ensureTables();
    const db = await getDb();
    const cut = await db.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(parseInt(req.params.id, 10));
    if (!(await canChange(req, cut))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!cut, maker: cut ? cut.user_id : null, admin: !!req.vlAdmin });
    if (cut.status !== 'draft') return vlRefuse(req, res, FN, 409, 'This cut has been made; copy it to write a new shot list.', { status: cut.status });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return vlRefuse(req, res, FN, 500, 'The writer is not set up on this server (ANTHROPIC_API_KEY).');
    const b = req.body || {};
    let c = cut;
    if (b.style != null && VIDEO_STYLES.some(function (s) { return s.key === b.style; }) && b.style !== cut.style) {
      await db.prepare('UPDATE video_projects SET style = ?, updated_at = NOW() WHERE id = ?').run(b.style, cut.id);
      c = Object.assign({}, cut, { style: b.style });
    }
    const ctx = await shotListContext(db, c);
    if (ctx.pictures.length < 2) return vlRefuse(req, res, FN, 400, 'A cut needs two pictures at least.', { pictures: ctx.pictures.length });
    const prices = await shotListPrices(db);
    const est = estimateShotList(ctx, prices);
    const bal = await require('./tokens').getBalance(req.session.userId);
    vlDebug(req.session.userId, 'info', FN, 'Shot list asked for', { style: ctx.style.key, model: ctx.modelKey, pictures: ctx.pictures.length, story_chars: ctx.story.text.length, cast: ctx.cast.length, art_style: ctx.artStyle, estimate: est, balance: bal.total, prices: prices });   // v3.4.99
    if (bal.total < est.tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: 'Writing this shot list costs about ' + est.tokens + ' token' + (est.tokens === 1 ? '' : 's') + ', but you have ' + bal.total + '. Add tokens and try again.' });
    await retireLostJobs(db, cut.id);
    const ins = await db.prepare("INSERT INTO video_shotlist_jobs (cut_id, user_id, status, style, model, boot_id, est_tokens) VALUES (?, ?, 'running', ?, ?, ?, ?) ON CONFLICT (cut_id) WHERE status = 'running' DO NOTHING")
      .run(cut.id, req.session.userId, ctx.style.key, ctx.modelKey, SL_BOOT, est.tokens);
    if (!ins.lastInsertRowid) return vlRefuse(req, res, FN, 409, 'A shot list is already being written for this cut.');
    const job = await db.prepare('SELECT * FROM video_shotlist_jobs WHERE id = ?').get(ins.lastInsertRowid);
    res.json({ job: jobView(job), estimate: est });
    runShotList(job.id, cut.id, req.session.userId, ctx, prices, key).catch(async function (e) {
      console.error('[video-lab] shot list job ' + job.id + ' crashed:', e && e.message);
      try { await db.prepare("UPDATE video_shotlist_jobs SET status = 'error', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run('Something went wrong writing it. Nothing was charged; try again.', job.id); } catch (e2) {}
    });
  } catch (e) {
    console.error('[video-lab] shot list start error:', e && e.message, e && e.stack);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Could not start: ' + (e && e.message), { code: e && e.code, stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });   // v3.4.99
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the shot list.' });
  }
});

// The latest job of a cut, the price of writing one now, and the cut itself once a job has filled it.
router.get('/cuts/:id/shot-list', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const cut = await db.prepare("SELECT * FROM video_projects WHERE id = ? AND kind = 'cut'").get(parseInt(req.params.id, 10));
    if (!cut || !(await canSee(req, cut))) return res.status(404).json({ error: 'Not found.' });
    await retireLostJobs(db, cut.id);
    const j = await db.prepare('SELECT * FROM video_shotlist_jobs WHERE cut_id = ? ORDER BY id DESC LIMIT 1').get(cut.id);
    let estimate = null;
    if (cut.status === 'draft') { try { estimate = estimateShotList(await shotListContext(db, cut), await shotListPrices(db)); } catch (e) { estimate = null; } }
    res.json({ job: jobView(j), estimate: estimate, cut: (j && j.status !== 'running') ? await loadCut(db, cut.id) : null });
  } catch (e) {
    console.error('[video-lab] shot list read error:', e && e.message);
    vlDebug(req.session && req.session.userId, 'error', 'GET /api/video-lab/cuts/' + req.params.id + '/shot-list', 'Read failed: ' + (e && e.message), { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });   // v3.4.99
    res.status(500).json({ error: 'Could not read the shot list.' });
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
// v3.4.98 -- the shot list, for the batch tests
module.exports.VIDEO_STYLES = VIDEO_STYLES;
module.exports._vlDebug = { vlSaveSummary: vlSaveSummary, vlShortUrl: vlShortUrl };   // v3.4.99
module.exports._shotList = { styleFor: styleFor, snapDuration: snapDuration, usdFor: usdFor, tokensFor: tokensFor, shotListPrices: shotListPrices, estimateShotList: estimateShotList,
  shotListContext: shotListContext, shotListRequest: shotListRequest, parseShotList: parseShotList, shotBoxText: shotBoxText, runShotList: runShotList, retireLostJobs: retireLostJobs, BOOT: SL_BOOT };
