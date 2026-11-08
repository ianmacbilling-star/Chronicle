// ============================================================
// v3.5.04 -- TD-090. VIDEO: EPISODES, SHOTS, KEYFRAMES, MOVES AND TAKES. Spec: claude/VIDEO_EPISODES_SPEC.md.
// Rebuilt with Ian's words (2026-11-08): "Episode is made up of Shots. Shots are a continuous video... made up of 1 or
// more keyframes that ends with a cut. Each Shot can have multiple takes... Between each shot we should have a Cut".
//
//   episodes     one video of one version of one session: name, model, sound, style, overall direction, pin, and the
//                joined episode video (the chosen take of every shot, in order).
//   shots        one continuous camera run inside an episode, in order; the cut after it (style, length; only
//                'instant' is made in this build); its chosen take.
//   keyframes    the pictures of a shot, in order. A keyframe also holds the directions (prompt, length) of the move
//                that starts on it.
//   takes        one attempt at a whole shot: its moves made side by side, then joined into the take's video.
//   moves        one model clip inside a take: keyframe to next keyframe (or one keyframe brought to life when the
//                shot has a single keyframe). A word kept off the screen unless needed.
//   episode_writer_jobs  one row per Write the shot list (one running per episode).
//
// The tables of v3.4.86-v3.5.03 (video_projects, video_shots, video_cut_pictures, video_shotlist_jobs) are dropped
// once, the first time this starts (Ian: "There really is NO data that we need to keep here"), with a marker in
// app_settings so it never happens again. Their files in R2 video-lab/ are left where they are.
//
// ASYNC BY DESIGN, as before: every clip and every join is a row; fal calls POST /api/video-lab/webhook when done, and a
// sweep every 30 s asks fal about anything still open. Whoever gets there first claims the row with one UPDATE, so a
// clip is saved once even with both paths, or two servers, running.
//
// SAVES ONE AT A TIME (the doubled-pictures bug of v3.4.97): an episode is saved in one transaction with its row locked
// (SELECT ... FOR UPDATE), and the page sends one save at a time.
//
// Clips are not charged in tokens yet (fal bills Campaignia); writing a shot list is (see that section).
// ============================================================
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, isAdminEmail, getCampaignRole } = require('../middleware/auth');
const { getDb, getViewableForkId } = require('../database/db');
const storage = require('../storage/storage');

// v3.4.94 -- THE VIDEO SWITCH: admins always; everyone else only while app_settings.video_lab_on is '1'.
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
// See: any member of the campaign. Change: the member who made it, or the campaign's Story Master. Admins: anything.
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

// Model table (fal's model pages, 2026-11-07). Prices are USD per second at 720p; "sound" is the model's own audio.
// single: how a move of ONE keyframe is sent (no end picture). Seedance and Kling take the start picture alone on the
// same endpoint; Veo's first-and-last-frame endpoint needs both, so a single keyframe goes to its image-to-video one.
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
    extra: { resolution: '720p', aspect_ratio: 'auto' }, promptRequired: true,
    single: { endpoint: 'fal-ai/veo3.1/fast/image-to-video', start: 'image_url' }
  }
};
const DEFAULT_MODEL = 'seedance2fast';
const MERGE_ENDPOINT = 'fal-ai/ffmpeg-api/merge-videos';   // joins clips in order on fal's servers (listed at $0)
const MAX_KEYFRAMES = 60;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const STUCK_MINUTES = 45;
const CUT_STYLES = ['instant'];   // this build makes plain cuts only; the styles come in their own build (spec section 4)

function estCost(m, duration, sound) {
  const per = sound ? m.priceSound : m.price;
  return Math.round(per * Number(duration) * 10000) / 10000;
}
function falClient() {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error('FAL_API_KEY is not set');
  require('./images').falSetup(key);
  return require('@fal-ai/client').fal;
}
function webhookUrl() {
  let base = String(process.env.PUBLIC_BASE_URL || '');
  while (base.length && base.charAt(base.length - 1) === '/') base = base.slice(0, -1);
  return base ? base + '/api/video-lab/webhook' : '';
}
function falErrorText(e) {
  if (!e) return 'unknown error';
  const body = e.body || (e.response && e.response.data);
  let detail = '';
  if (body) { try { detail = typeof body === 'string' ? body : JSON.stringify(body); } catch (_e) {} }
  return ((e.status ? e.status + ' ' : '') + (e.message || '') + (detail ? ' ' + detail : '')).trim().slice(0, 1000) || 'unknown error';
}
function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim();
  return s.slice(0, 120);
}
function shortSig(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }

// ---- the tables ------------------------------------------------------------------------------
const OLD_DROPPED = 'video_old_tables_dropped';
let _tablesReady = null;
function ensureTables() {
  if (_tablesReady) return _tablesReady;
  _tablesReady = (async function () {
    const db = await getDb();
    const mark = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(OLD_DROPPED);
    if (!mark) {
      await db.exec('DROP TABLE IF EXISTS video_shotlist_jobs, video_cut_pictures, video_shots, video_projects CASCADE');
      const again = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(OLD_DROPPED);
      if (!again) await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(OLD_DROPPED, new Date().toISOString());
      console.log('[video] the v3.4.86-v3.5.03 video tables were dropped (episodes replace them)');
    }
    await db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        campaign_id INTEGER,
        session_id INTEGER,
        fork_id INTEGER,
        name TEXT,
        model TEXT,
        sound BOOLEAN DEFAULT FALSE,
        style TEXT,
        overall TEXT,
        pinned BOOLEAN DEFAULT FALSE,
        source TEXT,
        shot_list TEXT,
        video_url TEXT,
        video_sig TEXT,
        join_status TEXT,
        join_request_id TEXT,
        join_sig TEXT,
        join_error TEXT,
        join_started_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS shots (
        id SERIAL PRIMARY KEY,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        cut_style TEXT DEFAULT 'instant',
        cut_seconds REAL,
        chosen_take_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS keyframes (
        id SERIAL PRIMARY KEY,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        image_url TEXT,
        source TEXT,
        moment_id INTEGER,
        archive_id INTEGER,
        label TEXT,
        prompt TEXT,
        duration TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS takes (
        id SERIAL PRIMARY KEY,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
        user_id INTEGER,
        status TEXT NOT NULL DEFAULT 'making',
        model TEXT,
        sound BOOLEAN DEFAULT FALSE,
        sig TEXT,
        directions TEXT,
        video_url TEXT,
        merge_status TEXT,
        merge_request_id TEXT,
        merge_error TEXT,
        merge_started_at TIMESTAMP,
        est_cost_usd REAL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS moves (
        id SERIAL PRIMARY KEY,
        take_id INTEGER NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 1,
        start_url TEXT,
        end_url TEXT,
        prompt TEXT,
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        submitted_at TIMESTAMP,
        finished_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS episode_writer_jobs (
        id SERIAL PRIMARY KEY,
        episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        user_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        style TEXT,
        model TEXT,
        boot_id TEXT,
        sig TEXT,
        est_tokens INTEGER,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        tokens_charged INTEGER DEFAULT 0,
        error TEXT,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP
      )`);
    await db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_version ON episodes(session_id, fork_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_join ON episodes(join_request_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots(episode_id, position)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_keyframes_shot ON keyframes(shot_id, position)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_keyframes_episode ON keyframes(episode_id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_takes_shot ON takes(shot_id, id)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_takes_merge ON takes(merge_request_id)');
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_takes_one_making ON takes(shot_id) WHERE status = 'making'");
    await db.exec('CREATE INDEX IF NOT EXISTS idx_moves_take ON moves(take_id, position)');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_moves_request ON moves(request_id)');
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_one_running ON episode_writer_jobs(episode_id) WHERE status = 'running'");
    await db.exec('CREATE INDEX IF NOT EXISTS idx_writer_episode ON episode_writer_jobs(episode_id, id)');
    // v3.5.09 -- Retouch on a keyframe: its one-step Revert slot, and the episode a retouch job belongs to.
    await db.exec('ALTER TABLE keyframes ADD COLUMN IF NOT EXISTS prev_image_url TEXT');
    await db.exec('ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS episode_id INTEGER');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_image_jobs_episode ON image_jobs(episode_id)');
  })();
  _tablesReady.catch(function () { _tablesReady = null; });
  return _tablesReady;
}

// ---- reading an episode ----------------------------------------------------------------------
// What a shot will be made from now: the model, the sound, the overall direction and every keyframe with its move's
// words and length. A take records the same signature, so a take made before an edit shows as out of date.
function shotSig(ep, kfs) {
  return shortSig(JSON.stringify([ep.model, !!ep.sound, String(ep.overall || '')].concat(kfs.map(function (k) { return [k.image_url, k.prompt || '', k.duration || '']; }))));
}
// Which chosen takes, in order, the episode video is made of.
function chosenSig(shots) { return shots.map(function (s) { return s.chosen_take_id || 0; }).join(','); }

async function loadEpisodes(db, where, params) {
  const eps = await db.prepare('SELECT * FROM episodes WHERE ' + where + ' ORDER BY pinned DESC, created_at DESC, id DESC').all(params);
  if (!eps.length) return [];
  const ids = eps.map(function (e) { return e.id; });
  const shots = await db.prepare('SELECT * FROM shots WHERE episode_id = ANY(?) ORDER BY episode_id, position, id').all([ids]);
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE episode_id = ANY(?) ORDER BY shot_id, position, id').all([ids]);
  const takes = await db.prepare('SELECT * FROM takes WHERE episode_id = ANY(?) ORDER BY shot_id, id').all([ids]);
  const moves = await db.prepare('SELECT * FROM moves WHERE episode_id = ANY(?) ORDER BY take_id, position, id').all([ids]);
  eps.forEach(function (ep) {
    ep.shots = shots.filter(function (s) { return s.episode_id === ep.id; });
    ep.shots.forEach(function (s) {
      s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; });
      s.sig = shotSig(ep, s.keyframes);
      s.takes = takes.filter(function (t) { return t.shot_id === s.id; });
      s.takes.forEach(function (t) {
        t.moves = moves.filter(function (m) { return m.take_id === t.id; });
        t.stale = t.sig !== s.sig;
      });
    });
    const cs = chosenSig(ep.shots);
    ep.video_current = !!(ep.video_url && ep.video_sig === cs);
  });
  // v3.5.09 -- keyframe retouches still being drawn (the picture being retouched, and the job), so a page opened
  // meanwhile shows them and follows them to the end.
  const rt = await db.prepare("SELECT id, episode_id, prev_image FROM image_jobs WHERE kind = 'keyframe' AND episode_id = ANY(?) AND status IN ('queued', 'processing') AND created_at > NOW() - INTERVAL '15 minutes'").all([ids]);
  eps.forEach(function (ep) { ep.retouching = rt.filter(function (j) { return j.episode_id === ep.id; }).map(function (j) { return { job_id: j.id, image_url: j.prev_image }; }); });
  return eps;
}
async function loadEpisode(db, id) { const out = await loadEpisodes(db, 'id = ?', [id]); return out[0] || null; }

// A version's storyboard pictures, in story order: the title picture first (the version's own, else the Canonical's),
// then every panel with a picture. A picture rejected by the rights check (TD-979) is left out, as everywhere else.
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
// May this person work on this version of this session? (the rule the storyboard uses, getViewableForkId)
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
// A picture may go into an episode if it is on a storyboard of the session or in the campaign's Archive.
// v3.5.09 -- a keyframe retouched in any episode of this session (a finished 'keyframe' job) is the campaign's too.
async function retouchedPictures(db, ep, urls) {
  if (!urls.length) return {};
  const rows = await db.prepare("SELECT DISTINCT j.image_url FROM image_jobs j JOIN episodes e ON e.id = j.episode_id WHERE j.kind = 'keyframe' AND j.status = 'done' AND e.session_id = ? AND j.image_url = ANY(?)").all(ep.session_id, [urls]);
  const ok = {}; rows.forEach(function (r) { ok[r.image_url] = true; });
  return ok;
}
async function picturesAllowed(req, db, ep, urls) {
  if (req.vlAdmin || !urls.length) return true;
  const rt = await retouchedPictures(db, ep, urls);   // v3.5.09
  urls = urls.filter(function (u) { return !rt[u]; });
  if (!urls.length) return true;
  const a = await db.prepare('SELECT DISTINCT image_url FROM campaign_archives WHERE campaign_id = ? AND image_url = ANY(?)').all(ep.campaign_id, [urls]);
  const b = await db.prepare('SELECT DISTINCT m.image AS image_url FROM moments m JOIN session_forks f ON f.id = m.fork_id WHERE f.session_id = ? AND m.image = ANY(?)').all(ep.session_id, [urls]);
  const ok = {}; (a || []).concat(b || []).forEach(function (r) { ok[r.image_url] = true; });
  return urls.every(function (u) { return ok[u]; });
}

// ---- the debug log (v3.4.99, kept) -----------------------------------------------------------
function vlDebug(userId, level, fn, message, detail) {
  try {
    require('./debug').logDebug(userId, { level: level, source: 'video', page: 'Video tab', fn: fn, message: String(message).slice(0, 500), detail: detail || null })
      .catch(function () {});
  } catch (e) {}
}
function vlRefuse(req, res, fn, status, error, detail) {
  try { console.warn('[video] ' + fn + ' refused (' + status + '): ' + error + (detail ? ' ' + JSON.stringify(detail).slice(0, 600) : '')); } catch (e) {}
  vlDebug(req.session && req.session.userId, 'warn', fn, 'Refused (' + status + '): ' + error, detail);
  return res.status(status).json({ error: error });
}
function vlShortUrl(u) { u = String(u || ''); return u.length > 80 ? u.slice(0, 80) + '...' : u; }
function vlSaveSummary(b) {
  b = b || {};
  const shots = Array.isArray(b.shots) ? b.shots : null;
  return { name: b.name != null ? String(b.name).slice(0, 120) : undefined, model: b.model, sound: b.sound, style: b.style,
    overall_chars: b.overall != null ? String(b.overall).length : undefined,
    shots: shots ? shots.length : undefined,
    keyframes: shots ? shots.reduce(function (t, s) { return t + ((s && Array.isArray(s.keyframes)) ? s.keyframes.length : 0); }, 0) : undefined };
}

// ---- the list, new, save ---------------------------------------------------------------------
router.get('/models', requireAuth, requireVideo, function (req, res) {
  const out = Object.keys(MODELS).map(function (k) {
    const m = MODELS[k];
    return { key: k, label: m.label, durations: m.durations, defDuration: m.defDuration, price: m.price, priceSound: m.priceSound, promptRequired: m.promptRequired };
  });
  const styles = VIDEO_STYLES.map(function (s) { return { key: s.key, label: s.label, description: s.description, speech: s.speech, defaultShot: s.defaultShot }; });
  res.json({ models: out, webhook: !!webhookUrl(), styles: styles, defaultStyle: DEFAULT_STYLE, defaultModel: DEFAULT_MODEL, cutStyles: CUT_STYLES });
});

router.get('/episodes', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const sid = parseInt(req.query.session_id, 10), fid = parseInt(req.query.fork_id, 10);
    if (!sid || !fid) return res.status(400).json({ error: 'session_id and fork_id are required' });
    if (!(await versionAccess(req, db, sid, fid))) return res.status(403).json({ error: 'You cannot see that version.' });
    res.json({ episodes: await loadEpisodes(db, 'session_id = ? AND fork_id = ?', [sid, fid]) });
  } catch (e) {
    console.error('[video] episode list error:', e && e.message);
    res.status(500).json({ error: 'Could not load the episodes.' });
  }
});

router.get('/episodes/:id', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await loadEpisode(db, parseInt(req.params.id, 10));
    if (!ep || !(await canSee(req, ep))) return res.status(404).json({ error: 'Not found.' });
    res.json({ episode: ep });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the episode.' });
  }
});

// Write the shots and keyframes of an episode. shots: [{id, cut_style, keyframes: [{url, source, moment_id, archive_id,
// label, prompt, duration}]}]. A shot's id is kept when it is one of this episode's (so its takes stay); the others are
// new; shots no longer sent are removed with their takes. Runs inside the caller's transaction. Returns the files of
// removed takes, to delete once the transaction is in.
async function writeShots(tx, ep, shotsIn) {
  const have = await tx.prepare('SELECT id FROM shots WHERE episode_id = ?').all(ep.id);
  const haveIds = {}; have.forEach(function (s) { haveIds[s.id] = true; });
  const keep = {};
  await tx.prepare('DELETE FROM keyframes WHERE episode_id = ?').run(ep.id);
  let pos = 0;
  for (const s of shotsIn) {
    pos++;
    let sid = parseInt(s.id, 10) || null;
    if (sid && haveIds[sid] && !keep[sid]) {
      await tx.prepare('UPDATE shots SET position = ?, cut_style = ? WHERE id = ?').run(pos, s.cut_style, sid);
    } else {
      const r = await tx.prepare('INSERT INTO shots (episode_id, position, cut_style) VALUES (?, ?, ?)').run(ep.id, pos, s.cut_style);
      sid = r.lastInsertRowid;
    }
    keep[sid] = true;
    for (let i = 0; i < s.keyframes.length; i++) {
      const k = s.keyframes[i];
      await tx.prepare('INSERT INTO keyframes (episode_id, shot_id, position, image_url, source, moment_id, archive_id, label, prompt, duration, prev_image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ep.id, sid, i + 1, k.url, k.source, k.moment_id, k.archive_id, k.label, k.prompt, k.duration, k.prev_url || null);
    }
  }
  const gone = have.map(function (s) { return s.id; }).filter(function (id) { return !keep[id]; });
  let files = [];
  if (gone.length) {
    const busy = await tx.prepare("SELECT id FROM takes WHERE shot_id = ANY(?) AND status = 'making' LIMIT 1").get([gone]);
    if (busy) { const e = new Error('A shot being made cannot be removed or joined to another; wait until it is made.'); e.userFacing = 409; throw e; }
    files = await takeFiles(tx, 'shot_id = ANY(?)', [gone]);
    await tx.prepare('DELETE FROM shots WHERE id = ANY(?)').run([gone]);
  }
  return files;
}
// The files of some takes: their moves' clips and their joined videos (a one-move take's video is its move's clip).
async function takeFiles(db, where, params) {
  const ts = await db.prepare('SELECT id, video_url FROM takes WHERE ' + where).all(params);
  if (!ts.length) return [];
  const ms = await db.prepare('SELECT video_url FROM moves WHERE take_id = ANY(?)').all([ts.map(function (t) { return t.id; })]);
  return ts.map(function (t) { return t.video_url; }).concat(ms.map(function (m) { return m.video_url; }))
    .filter(function (f, i, all) { return f && all.indexOf(f) === i; });
}
// An episode video that was one of the deleted files (a one-shot episode's video is its take's) is forgotten.
async function forgetVideo(db, episodeId, files) {
  if (files.length) await db.prepare('UPDATE episodes SET video_url = NULL, video_sig = NULL, updated_at = NOW() WHERE id = ? AND video_url = ANY(?)').run(episodeId, [files]);
}
async function deleteFiles(files, why) {
  let asked = 0;
  for (const f of files) { try { await storage.deleteFile(f); asked++; } catch (e) { console.error('[video] could not delete ' + f + ': ' + (e && e.message)); } }
  if (files.length) console.log('[video] ' + why + ': ' + asked + '/' + files.length + ' file(s) sent for deletion');
}

function cleanShots(list, m) {
  const out = [];
  let n = 0;
  (Array.isArray(list) ? list : []).forEach(function (s) {
    s = s || {};
    const kfs = (Array.isArray(s.keyframes) ? s.keyframes : []).map(function (k) {
      k = k || {};
      const src = ['title', 'moment', 'archive'].indexOf(k.source) >= 0 ? k.source : 'archive';
      let d = String(k.duration == null ? '' : k.duration);
      if (m.durations.indexOf(d) < 0) d = snapDuration(m, parseFloat(d)) || m.defDuration;   // the nearest length the model offers
      return { url: String(k.url || k.image_url || ''), source: src, moment_id: parseInt(k.moment_id, 10) || null, archive_id: parseInt(k.archive_id, 10) || null,
        label: k.label ? String(k.label).slice(0, 200) : null, prompt: String(k.prompt || '').slice(0, 1500), duration: d,
        prev_url: String(k.prev_url || k.prev_image_url || '') || null };   // v3.5.09: the Revert slot
    }).filter(function (k) { return k.url; });
    const room = MAX_KEYFRAMES - n;
    if (room <= 0 || !kfs.length) return;
    n += Math.min(room, kfs.length);
    out.push({ id: parseInt(s.id, 10) || null, cut_style: CUT_STYLES.indexOf(s.cut_style) >= 0 ? s.cut_style : 'instant', keyframes: kfs.slice(0, room) });
  });
  return out;
}

// New episode: the version's storyboard pictures, title picture first, all in one shot (no cuts yet).
router.post('/episodes', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const b = req.body || {};
    const sid = parseInt(b.session_id, 10), fid = parseInt(b.fork_id, 10);
    if (!sid || !fid) return res.status(400).json({ error: 'session_id and fork_id are required' });
    const s = await versionAccess(req, db, sid, fid);
    if (!s) return res.status(403).json({ error: 'You cannot make an episode of that version.' });
    const pics = await storyboardPictures(db, sid, fid);
    const model = MODELS[b.model] ? b.model : DEFAULT_MODEL;
    const name = cleanName(b.name) || ('Episode ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
    let id = null;
    await db.transaction(async function (tx) {
      const r = await tx.prepare('INSERT INTO episodes (user_id, campaign_id, session_id, fork_id, name, model, sound, style, overall, pinned, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.session.userId, s.campaign_id, sid, fid, name, model, false, styleFor(b.style).key, '', false, 'storyboard');
      id = r.lastInsertRowid;
      const shots = pics.length ? cleanShots([{ keyframes: pics.map(function (p) { return Object.assign({}, p, { prompt: '', duration: MODELS[model].defDuration }); }) }], MODELS[model]) : [];
      await writeShots(tx, { id: id }, shots);
    });
    console.log('[video] episode ' + id + ' made from version ' + fid + ' of session ' + sid + ': ' + pics.length + ' keyframe(s) in one shot');
    res.json({ episode: await loadEpisode(db, id) });
  } catch (e) {
    console.error('[video] new episode error:', e && e.message);
    res.status(500).json({ error: 'Could not make the episode.' });
  }
});

// Save: name, model, sound, style, overall direction, and the shots with their keyframes and moves' words.
router.put('/episodes/:id', requireAuth, requireVideo, async function (req, res) {
  const FN = 'PUT /api/video-lab/episodes/' + req.params.id;
  const b = req.body || {};
  try {
    await ensureTables();
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    const ep0 = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    if (!(await canChange(req, ep0))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!ep0, admin: !!req.vlAdmin });
    if (await runningWriter(db, id)) return vlRefuse(req, res, FN, 409, 'The shot list is being written; your changes can be made when it is done.');
    const model = (b.model != null && MODELS[b.model]) ? b.model : (MODELS[ep0.model] ? ep0.model : DEFAULT_MODEL);
    let shots = null;
    if (b.shots != null) {
      shots = cleanShots(b.shots, MODELS[model]);
      const urls = [];
      shots.forEach(function (s) { s.keyframes.forEach(function (k) { urls.push(k.url); }); });
      const notOurs = urls.filter(function (u) { return !storage.isOurPublicUrl(u); });
      if (notOurs.length) return vlRefuse(req, res, FN, 400, 'Every keyframe must be a Campaignia picture.', { sent: vlSaveSummary(b), not_campaignia: notOurs.slice(0, 10).map(vlShortUrl) });
      if (!(await picturesAllowed(req, db, ep0, urls))) return vlRefuse(req, res, FN, 400, 'Every keyframe must come from this campaign.', { sent: vlSaveSummary(b) });
      // v3.5.09 -- a Revert slot holding a picture that is not this campaign's is emptied, not refused.
      for (const s of shots) for (const k of s.keyframes) {
        if (k.prev_url && (!storage.isOurPublicUrl(k.prev_url) || !(await picturesAllowed(req, db, ep0, [k.prev_url])))) k.prev_url = null;
      }
    }
    let files = [];
    await db.transaction(async function (tx) {
      const ep = await tx.prepare('SELECT * FROM episodes WHERE id = ? FOR UPDATE').get(id);
      if (!ep) { const e = new Error('Not found.'); e.userFacing = 404; throw e; }
      const name = b.name != null ? (cleanName(b.name) || ep.name) : ep.name;
      const style = (b.style != null && VIDEO_STYLES.some(function (s) { return s.key === b.style; })) ? b.style : ep.style;
      const overall = b.overall != null ? String(b.overall).slice(0, 2000) : ep.overall;
      const sound = b.sound != null ? !!b.sound : !!ep.sound;
      await tx.prepare('UPDATE episodes SET name = ?, model = ?, sound = ?, style = ?, overall = ?, updated_at = NOW() WHERE id = ?').run(name, model, sound, style, overall, id);
      if (shots) files = await writeShots(tx, ep, shots);
      else if (model !== ep.model) {   // another model, keyframes not sent: each move's length becomes the nearest the new model offers
        const ks = await tx.prepare('SELECT id, duration FROM keyframes WHERE episode_id = ?').all(id);
        for (const k of ks) {
          const d = MODELS[model].durations.indexOf(String(k.duration)) >= 0 ? String(k.duration) : (snapDuration(MODELS[model], parseFloat(k.duration)) || MODELS[model].defDuration);
          if (d !== String(k.duration)) await tx.prepare('UPDATE keyframes SET duration = ? WHERE id = ?').run(d, k.id);
        }
      }
    });
    await forgetVideo(db, id, files);
    await deleteFiles(files, 'episode ' + id + ': shots removed');
    await maybeJoinEpisode(db, id);
    vlDebug(req.session.userId, 'info', FN, 'Saved the episode', { sent: vlSaveSummary(b) });
    res.json({ episode: await loadEpisode(db, id) });
  } catch (e) {
    if (e && e.userFacing) return vlRefuse(req, res, FN, e.userFacing, e.message, { sent: vlSaveSummary(b) });
    console.error('[video] save episode error:', e && e.message, e && e.stack);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Save failed: ' + (e && e.message), { sent: vlSaveSummary(b), code: e && e.code, stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
    res.status(500).json({ error: 'Could not save the episode.' });
  }
});

router.delete('/episodes/:id', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    const files = (await takeFiles(db, 'episode_id = ?', [id])).concat([ep.video_url]).filter(function (f, i, all) { return f && all.indexOf(f) === i; });
    await db.prepare('DELETE FROM episodes WHERE id = ?').run(id);
    await deleteFiles(files, 'episode ' + id + ' deleted');
    res.json({ ok: true, files: files.length });
  } catch (e) {
    console.error('[video] delete episode error:', e && e.message);
    res.status(500).json({ error: 'Could not delete it.' });
  }
});

// Copy: a new episode of the same version with the same shots, keyframes and words (no takes).
router.post('/episodes/:id/copy', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const src = await loadEpisode(db, parseInt(req.params.id, 10));
    if (!src || !(await canSee(req, src))) return res.status(404).json({ error: 'Not found.' });
    if (!(await versionAccess(req, db, src.session_id, src.fork_id))) return res.status(403).json({ error: 'You cannot make an episode of that version.' });
    const m = MODELS[src.model] || MODELS[DEFAULT_MODEL];
    let id = null;
    await db.transaction(async function (tx) {
      const r = await tx.prepare('INSERT INTO episodes (user_id, campaign_id, session_id, fork_id, name, model, sound, style, overall, pinned, source, shot_list) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.session.userId, src.campaign_id, src.session_id, src.fork_id, cleanName(String(src.name || 'Episode') + ' (copy)'), MODELS[src.model] ? src.model : DEFAULT_MODEL,
          !!src.sound, src.style, src.overall || '', false, 'copy', src.shot_list || null);
      id = r.lastInsertRowid;
      await writeShots(tx, { id: id }, cleanShots(src.shots.map(function (s) {
        return { cut_style: s.cut_style, keyframes: s.keyframes.map(function (k) { return { url: k.image_url, source: k.source, moment_id: k.moment_id, archive_id: k.archive_id, label: k.label, prompt: k.prompt, duration: k.duration, prev_url: k.prev_image_url }; }) };
      }), m));
    });
    res.json({ episode: await loadEpisode(db, id) });
  } catch (e) {
    console.error('[video] copy episode error:', e && e.message);
    res.status(500).json({ error: 'Could not copy the episode.' });
  }
});

// Pin: the one episode of this version that Final Cut will use. Pinning one unpins the others.
router.post('/episodes/:id/pin', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    const on = !(req.body && req.body.pinned === false);
    if (on) await db.prepare('UPDATE episodes SET pinned = FALSE, updated_at = NOW() WHERE session_id = ? AND fork_id = ? AND id <> ? AND pinned = TRUE').run(ep.session_id, ep.fork_id, ep.id);
    await db.prepare('UPDATE episodes SET pinned = ?, updated_at = NOW() WHERE id = ?').run(on, ep.id);
    res.json({ episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not pin it.' });
  }
});

// ---- making a shot (a take) ------------------------------------------------------------------
// The moves of a shot as it stands: one keyframe -> one move bringing it to life; N keyframes -> N-1 moves.
function overallWith(overall, own) {
  overall = String(overall || '').trim(); own = String(own || '').trim();
  if (overall && own) return (overall + '\n\nThis part of the shot: ' + own).slice(0, 2500);
  return (overall || own).slice(0, 2500);
}
// v3.5.07 -- AFTER THE LAST KEYFRAME (Ian, 2026-11-08: Gubuk hears Drel, looks around and runs off "before the cut").
// The last keyframe of a longer shot holds an optional move of its own: when its words are filled, the shot gets one
// more move that starts on that picture with no end picture. Empty, nothing changes. (A one-keyframe shot's only move
// was always of this kind.)
function hasAfter(kfs) { return kfs.length > 1 && !!String(kfs[kfs.length - 1].prompt || '').trim(); }
function planMoves(ep, kfs, shotNo) {
  const m = MODELS[ep.model];
  if (!m) return { error: 'Pick a video model.' };
  if (!kfs.length) return { error: 'Shot ' + shotNo + ' has no keyframes.' };
  const out = [];
  const n = kfs.length === 1 ? 1 : kfs.length - 1 + (hasAfter(kfs) ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = kfs[i], z = (kfs.length === 1 || i === kfs.length - 1) ? null : kfs[i + 1];
    const d = String(a.duration || m.defDuration);
    if (m.durations.indexOf(d) < 0) return { error: 'Shot ' + shotNo + ': ' + d + ' seconds is not offered for ' + m.label + '.' };
    const full = overallWith(ep.overall, a.prompt);
    if (m.promptRequired && !full) return { error: m.label + ' needs words for shot ' + shotNo + (n > 1 ? ' (keyframe ' + (i + 1) + ' to ' + (i + 2) + ')' : '') + ', or an overall direction.' };
    out.push({ position: i + 1, start: a.image_url, end: z ? z.image_url : null, own: String(a.prompt || ''), full: full, duration: d });
  }
  return { moves: out, model: m };
}
// What one move sends to fal: each model names its pictures and its length its own way.
function buildInput(m, prompt, startUrl, endUrl, duration, sound) {
  const input = Object.assign({}, m.extra);
  if (prompt) input.prompt = prompt;
  let endpoint = m.endpoint;
  if (endUrl) { input[m.start] = startUrl; input[m.end] = endUrl; }
  else if (m.single) { endpoint = m.single.endpoint; input[m.single.start] = startUrl; }
  else input[m.start] = startUrl;
  input.duration = m.durationValue(duration);
  input.generate_audio = !!sound;
  return { endpoint: endpoint, input: input };
}

// Make one shot: a new take (it becomes the chosen one), its moves sent to fal side by side. One take of a shot is made
// at a time (a partial unique index is the claim). Returns { take } or { status, error }.
async function makeShot(db, req, ep, shot, shotNo) {
  const m = MODELS[ep.model];
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shot.id);
  const plan = planMoves(ep, kfs, shotNo);
  if (plan.error) return { status: 400, error: plan.error };
  const hook = webhookUrl();
  if (!hook) return { status: 500, error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' };
  const sound = !!ep.sound;
  const cost = Math.round(plan.moves.reduce(function (t, x) { return t + estCost(m, x.duration, sound); }, 0) * 10000) / 10000;
  const directions = JSON.stringify({ overall: ep.overall || '', style: ep.style, moves: plan.moves.map(function (x) { return { own: x.own, duration: x.duration }; }) });
  const ins = await db.prepare("INSERT INTO takes (episode_id, shot_id, user_id, status, model, sound, sig, directions, est_cost_usd) VALUES (?, ?, ?, 'making', ?, ?, ?, ?, ?) ON CONFLICT (shot_id) WHERE status = 'making' DO NOTHING")
    .run(ep.id, shot.id, req.session.userId, ep.model, sound, shotSig(ep, kfs), directions, cost);
  if (!ins.lastInsertRowid) return { status: 409, error: 'Shot ' + shotNo + ' is already being made.' };
  const takeId = ins.lastInsertRowid;
  await db.prepare('UPDATE shots SET chosen_take_id = ? WHERE id = ?').run(takeId, shot.id);
  const rows = [];
  for (const x of plan.moves) {
    const bi = buildInput(m, x.full, x.start, x.end, x.duration, sound);
    const r = await db.prepare('INSERT INTO moves (take_id, episode_id, position, start_url, end_url, prompt, model, endpoint, duration, sound, status, est_cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(takeId, ep.id, x.position, x.start, x.end, x.full, ep.model, bi.endpoint, x.duration, sound, 'queued', estCost(m, x.duration, sound));
    rows.push({ id: r.lastInsertRowid, bi: bi });
  }
  let sent = 0;
  const fal = falClient();
  for (const x of rows) {
    try {
      const sub = await fal.queue.submit(x.bi.endpoint, { input: x.bi.input, webhookUrl: hook });
      await db.prepare("UPDATE moves SET request_id = ?, status = 'running', submitted_at = NOW(), updated_at = NOW() WHERE id = ?").run(sub.request_id, x.id);
      sent++;
    } catch (e) {
      await db.prepare("UPDATE moves SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(('fal refused it: ' + falErrorText(e)).slice(0, 1000), x.id);
    }
  }
  console.log('[video] episode ' + ep.id + ' shot ' + shot.id + ' take ' + takeId + ': ' + sent + ' of ' + rows.length + ' move(s) sent');
  await takeStatus(db, takeId);
  return { take: takeId, sent: sent };
}

router.post('/shots/:id/make', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT * FROM shots WHERE id = ?').get(parseInt(req.params.id, 10));
    const ep = shot ? await db.prepare('SELECT * FROM episodes WHERE id = ?').get(shot.episode_id) : null;
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    if (await runningWriter(db, ep.id)) return res.status(409).json({ error: 'The shot list is being written; make the shot when it is done.' });
    const r = await makeShot(db, req, ep, shot, shot.position);
    const out = await loadEpisode(db, ep.id);
    if (r.error) return res.status(r.status).json({ error: r.error, episode: out });
    res.json({ episode: out });
  } catch (e) {
    console.error('[video] make shot error:', falErrorText(e));
    res.status(500).json({ error: 'Could not start it: ' + falErrorText(e) });
  }
});

// Make every shot that has no take yet (or whose chosen take failed).
router.post('/episodes/:id/make', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    if (await runningWriter(db, ep.id)) return res.status(409).json({ error: 'The shot list is being written; make the shots when it is done.' });
    const shots = await db.prepare('SELECT s.*, t.status AS chosen_status FROM shots s LEFT JOIN takes t ON t.id = s.chosen_take_id WHERE s.episode_id = ? ORDER BY s.position, s.id').all(ep.id);
    if (!shots.length) return res.status(400).json({ error: 'This episode has no keyframes.' });
    // Check every shot first, so a missing word in shot 5 does not leave shots 1 to 4 made and the rest not.
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].chosen_status === 'done' || shots[i].chosen_status === 'making') continue;
      const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shots[i].id);
      const p = planMoves(ep, kfs, i + 1);
      if (p.error) return res.status(400).json({ error: p.error });
    }
    const errors = [];
    let made = 0;
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].chosen_status === 'done' || shots[i].chosen_status === 'making') continue;
      const r = await makeShot(db, req, ep, shots[i], i + 1);
      if (r.error) errors.push(r.error); else made++;
    }
    const out = await loadEpisode(db, ep.id);
    if (!made && errors.length) return res.status(400).json({ error: errors[0], episode: out });
    if (!made) return res.status(409).json({ error: 'Every shot already has a take.', episode: out });
    res.json({ episode: out, made: made, errors: errors });
  } catch (e) {
    console.error('[video] make episode error:', falErrorText(e));
    res.status(500).json({ error: 'Could not start it: ' + falErrorText(e) });
  }
});

async function takeAndEpisode(db, takeId) {
  const t = await db.prepare('SELECT * FROM takes WHERE id = ?').get(takeId);
  const ep = t ? await db.prepare('SELECT * FROM episodes WHERE id = ?').get(t.episode_id) : null;
  return { t: t, ep: ep };
}
router.post('/takes/:id/choose', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canChange(req, x.ep))) return res.status(404).json({ error: 'Not found.' });
    await db.prepare('UPDATE shots SET chosen_take_id = ? WHERE id = ?').run(x.t.id, x.t.shot_id);
    await maybeJoinEpisode(db, x.ep.id);
    res.json({ episode: await loadEpisode(db, x.ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not choose it.' });
  }
});
router.delete('/takes/:id', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canChange(req, x.ep))) return res.status(404).json({ error: 'Not found.' });
    if (x.t.status === 'making') return res.status(409).json({ error: 'That take is still being made.' });
    const files = await takeFiles(db, 'id = ?', [x.t.id]);
    await db.prepare('DELETE FROM takes WHERE id = ?').run(x.t.id);
    // The chosen take gone: the newest made take of the shot is chosen instead (none: the shot waits for one).
    const sh = await db.prepare('SELECT chosen_take_id FROM shots WHERE id = ?').get(x.t.shot_id);
    if (sh && Number(sh.chosen_take_id) === Number(x.t.id)) {
      const next = await db.prepare("SELECT id FROM takes WHERE shot_id = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(x.t.shot_id);
      await db.prepare('UPDATE shots SET chosen_take_id = ? WHERE id = ?').run(next ? next.id : null, x.t.shot_id);
    }
    await forgetVideo(db, x.ep.id, files);
    await deleteFiles(files, 'take ' + x.t.id + ' deleted');
    await maybeJoinEpisode(db, x.ep.id);
    res.json({ episode: await loadEpisode(db, x.ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the take.' });
  }
});
// Join the episode again after a failed join.
router.post('/episodes/:id/join', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    await db.prepare("UPDATE episodes SET join_status = NULL, join_error = NULL, join_request_id = NULL, updated_at = NOW() WHERE id = ? AND join_status = 'error'").run(ep.id);
    await maybeJoinEpisode(db, ep.id);
    res.json({ episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not join it again.' });
  }
});
// A take whose join failed: join its moves again.
router.post('/takes/:id/join', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canChange(req, x.ep))) return res.status(404).json({ error: 'Not found.' });
    const r = await db.prepare("UPDATE takes SET merge_status = NULL, merge_error = NULL, merge_request_id = NULL, status = 'making', error = NULL, updated_at = NOW() WHERE id = ? AND merge_status = 'error'").run(x.t.id);
    if (!r.changes) return res.status(409).json({ error: 'Nothing to join again.' });
    await takeStatus(db, x.t.id);
    res.json({ episode: await loadEpisode(db, x.ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not join it again.' });
  }
});

// ---- retouch on a keyframe (v3.5.09) ---------------------------------------------------------
// Ian, 2026-11-08: "put the retouch option on the keyframes". The Story panels' retouch (routes/images.js
// startKeyframeRetouch) on the episode's own copy: when the picture arrives every keyframe of this episode still showing
// the old picture takes the new one and keeps the old in its Revert slot. The book is not changed. Takes made from the
// old picture show "out of date" (the shot's signature includes its pictures).
router.post('/episodes/:id/keyframe-retouch', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/keyframe-retouch';
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!(await canChange(req, ep))) return vlRefuse(req, res, FN, 404, 'Not found.');
    const b = req.body || {};
    const url = String(b.image_url || '');
    const kf = await db.prepare('SELECT * FROM keyframes WHERE episode_id = ? AND image_url = ? ORDER BY id LIMIT 1').get(ep.id, url);
    if (!kf) return vlRefuse(req, res, FN, 409, 'That keyframe has changed; try again in a moment.', { url: vlShortUrl(url) });
    const busy = await db.prepare("SELECT id FROM image_jobs WHERE kind = 'keyframe' AND episode_id = ? AND prev_image = ? AND status IN ('queued', 'processing') AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1").get(ep.id, url);
    if (busy) return res.status(409).json({ error: 'That keyframe is already being retouched.', job_id: busy.id });
    try {
      if (await require('../services/rightsCheck').refuseRejected(res, [url], 'It can\u2019t be retouched. Replace it with a picture you have the rights to. Nothing was charged.')) return;
    } catch (e) { console.error('[video] rights check failed:', e && e.message); }
    let shape = null, style = null;
    if (kf.archive_id) {
      const a = await db.prepare('SELECT shape, art_style FROM campaign_archives WHERE id = ? AND campaign_id = ?').get(kf.archive_id, ep.campaign_id);
      if (a) { shape = a.shape || null; style = a.art_style || null; }
    }
    // v3.5.10 -- Ian, 2026-11-08: "pass the current art style... of the version the episode is on". The version's own
    // style, else its session's, else the campaign's (as the shot list reads it); the picture's own only when none is set.
    const vs = await db.prepare('SELECT f.art_style_override AS fork_style, s.art_style AS session_style, c.art_style AS campaign_style FROM session_forks f JOIN sessions s ON s.id = f.session_id JOIN campaigns c ON c.id = s.campaign_id WHERE f.id = ?').get(ep.fork_id);
    const versionStyle = vs ? String(vs.fork_style || vs.session_style || vs.campaign_style || '').trim() : '';
    if (versionStyle) style = versionStyle;
    const out = await require('./images').startKeyframeRetouch(db, { userId: req.session.userId, campaignId: ep.campaign_id, episodeId: ep.id, imageUrl: url,
      momentId: kf.moment_id || null, shape: shape, style: style, instruction: b.instruction, markedUrl: b.marked_url, refName: b.ref_name });
    if (out.error) return res.status(out.error === 'INSUFFICIENT_TOKENS' ? 402 : 400).json(out);
    vlDebug(req.session.userId, 'info', FN, 'Keyframe retouch started (job ' + out.job_id + ')', { url: vlShortUrl(url), moment_id: kf.moment_id, archive_id: kf.archive_id, art_style: style });
    res.json({ job_id: out.job_id });
  } catch (e) {
    console.error('[video] keyframe retouch error:', e && e.message);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Could not start: ' + (e && e.message), { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the retouch.' });
  }
});

// ---- downloads -------------------------------------------------------------------------------
function baseName(name) { return String(name || 'video').replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video'; }
async function sendVideo(res, url, fname) {
  const key = storage.keyFromUrl(url);
  const buf = key ? await storage.getObject(key) : null;
  if (!buf) return res.status(404).json({ error: 'The video file is missing from storage.' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.end(buf);
}
router.get('/episodes/:id/download', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !ep.video_url || !(await canSee(req, ep))) return res.status(404).json({ error: 'That episode has no video yet.' });
    await sendVideo(res, ep.video_url, baseName(ep.name) + '.mp4');
  } catch (e) {
    res.status(500).json({ error: 'Could not read the video.' });
  }
});
router.get('/takes/:id/download', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !x.t.video_url || !(await canSee(req, x.ep))) return res.status(404).json({ error: 'That take has no video.' });
    const sh = await db.prepare('SELECT position FROM shots WHERE id = ?').get(x.t.shot_id);
    await sendVideo(res, x.t.video_url, baseName(x.ep.name) + ' (shot ' + (sh ? sh.position : '') + ', take ' + x.t.id + ').mp4');
  } catch (e) {
    res.status(500).json({ error: 'Could not read the video.' });
  }
});

// ---- finishing: moves, takes, the episode ----------------------------------------------------
async function fetchVideo(url) {
  const axios = require('axios');
  const https = require('https');
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 180000, maxContentLength: MAX_VIDEO_BYTES, maxBodyLength: MAX_VIDEO_BYTES, httpsAgent: new https.Agent({ minVersion: 'TLSv1.2' }) });
  const ct = String(resp.headers['content-type'] || 'video/mp4').split(';')[0].trim();
  if (!/^video\//.test(ct) && !/octet-stream/.test(ct)) throw new Error('fal returned ' + ct + ', not a video');
  return Buffer.from(resp.data);
}

// Claim the move (one caller wins), read the result from fal by our own ticket, copy the clip to R2.
async function finishMove(mv, falResult, falError) {
  const db = await getDb();
  const claim = await db.prepare("UPDATE moves SET status = 'saving', updated_at = NOW() WHERE id = ? AND status IN ('queued', 'running')").run(mv.id);
  if (!claim.changes) return 'not-mine';
  try {
    if (falError) throw new Error(falError);
    let data = falResult;
    if (!data || !data.video) { const r = await falClient().queue.result(mv.endpoint, { requestId: mv.request_id }); data = r && (r.data || r); }
    const url = data && data.video && data.video.url;
    if (!url || !/^https:\/\//i.test(url)) throw new Error('fal returned no video');
    const buf = await fetchVideo(url);
    const stored = await storage.uploadFile(buf, 'ep-' + mv.episode_id + '-take-' + mv.take_id + '-move-' + mv.id + '-' + Date.now() + '.mp4', 'video/mp4', 'video-lab');
    await db.prepare("UPDATE moves SET status = 'done', fal_video_url = ?, video_url = ?, file_size = ?, error = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(url, stored, buf.length, mv.id);
    console.log('[video] move ' + mv.id + ' done: ' + buf.length + ' bytes -> ' + stored);
    await takeStatus(db, mv.take_id);
    return 'done';
  } catch (e) {
    const msg = falErrorText(e);
    await db.prepare("UPDATE moves SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), mv.id);
    console.error('[video] move ' + mv.id + ' failed: ' + msg);
    await takeStatus(db, mv.take_id);
    return 'error';
  }
}

// Where a take stands: every move back and saved -> one move is the take's video; more are joined (one caller claims
// the join). A failed move fails the take. A finished take may complete the episode.
async function takeStatus(db, takeId) {
  const t = await db.prepare('SELECT * FROM takes WHERE id = ?').get(takeId);
  if (!t || t.status !== 'making') return;
  const mvs = await db.prepare('SELECT id, status, video_url FROM moves WHERE take_id = ? ORDER BY position, id').all(takeId);
  if (!mvs.length) return;
  if (mvs.some(function (m) { return m.status !== 'done' && m.status !== 'error'; })) return;
  if (mvs.some(function (m) { return m.status === 'error'; })) {
    await db.prepare("UPDATE takes SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'making'").run('A part of this take failed at fal.', takeId);
    return;
  }
  if (mvs.length === 1) {
    const r = await db.prepare("UPDATE takes SET video_url = ?, status = 'done', merge_status = 'single', finished_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'making'").run(mvs[0].video_url, takeId);
    if (r.changes) await maybeJoinEpisode(db, t.episode_id);
    return;
  }
  const claim = await db.prepare("UPDATE takes SET merge_status = 'running', merge_error = NULL, merge_started_at = NOW(), updated_at = NOW() WHERE id = ? AND merge_status IS NULL AND status = 'making'").run(takeId);
  if (!claim.changes) return;
  try {
    const sub = await falClient().queue.submit(MERGE_ENDPOINT, { input: { video_urls: mvs.map(function (m) { return m.video_url; }) }, webhookUrl: webhookUrl() || undefined });
    await db.prepare('UPDATE takes SET merge_request_id = ?, updated_at = NOW() WHERE id = ?').run(sub.request_id, takeId);
    console.log('[video] take ' + takeId + ': joining ' + mvs.length + ' moves, request ' + sub.request_id);
  } catch (e) {
    await db.prepare("UPDATE takes SET merge_status = 'error', merge_error = ?, status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(('fal refused the join: ' + falErrorText(e)).slice(0, 1000), 'Joining the parts failed.', takeId);
  }
}

// A join is back (a take's or an episode's): claim it, copy the joined video to R2.
async function joinedVideo(falResult, requestId) {
  let data = falResult;
  if (!data || !data.video) { const r = await falClient().queue.result(MERGE_ENDPOINT, { requestId: requestId }); data = r && (r.data || r); }
  const url = data && data.video && data.video.url;
  if (!url || !/^https:\/\//i.test(url)) throw new Error('fal returned no joined video');
  return fetchVideo(url);
}
async function finishTakeMerge(t, falResult, falError) {
  const db = await getDb();
  const claim = await db.prepare("UPDATE takes SET merge_status = 'saving', updated_at = NOW() WHERE id = ? AND merge_status = 'running'").run(t.id);
  if (!claim.changes) return 'not-mine';
  try {
    if (falError) throw new Error(falError);
    const buf = await joinedVideo(falResult, t.merge_request_id);
    const stored = await storage.uploadFile(buf, 'ep-' + t.episode_id + '-take-' + t.id + '-' + Date.now() + '.mp4', 'video/mp4', 'video-lab');
    await db.prepare("UPDATE takes SET video_url = ?, merge_status = 'done', status = 'done', finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(stored, t.id);
    console.log('[video] take ' + t.id + ' joined: ' + buf.length + ' bytes');
    await maybeJoinEpisode(db, t.episode_id);
    return 'done';
  } catch (e) {
    const msg = falErrorText(e);
    await db.prepare("UPDATE takes SET merge_status = 'error', merge_error = ?, status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), 'Joining the parts failed.', t.id);
    console.error('[video] take ' + t.id + ' join failed: ' + msg);
    return 'error';
  }
}

// The episode video: once every shot has a made chosen take, they are joined in order with plain cuts. Joined again
// whenever the chosen takes change (video_sig records which takes the video is made of). One shot: its take is the video.
async function maybeJoinEpisode(db, episodeId) {
  const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!ep || ep.join_status === 'running' || ep.join_status === 'saving') return;
  const shots = await db.prepare('SELECT s.id, s.chosen_take_id, t.status, t.video_url FROM shots s LEFT JOIN takes t ON t.id = s.chosen_take_id WHERE s.episode_id = ? ORDER BY s.position, s.id').all(episodeId);
  if (!shots.length || !shots.every(function (s) { return s.status === 'done' && s.video_url; })) return;
  const sig = chosenSig(shots);
  if (ep.video_sig === sig && ep.video_url) return;
  if (ep.join_status === 'error' && ep.join_sig === sig) return;   // the same join failed: Join again asks for it (a new take tries by itself)
  if (shots.length === 1) {
    const old = ep.video_url;
    await db.prepare('UPDATE episodes SET video_url = ?, video_sig = ?, updated_at = NOW() WHERE id = ?').run(shots[0].video_url, sig, episodeId);
    if (old && old !== shots[0].video_url && !(await videoInUse(db, old))) await deleteFiles([old], 'episode ' + episodeId + ': old video');
    return;
  }
  const claim = await db.prepare("UPDATE episodes SET join_status = 'running', join_sig = ?, join_error = NULL, join_request_id = NULL, join_started_at = NOW(), updated_at = NOW() WHERE id = ? AND (join_status IS NULL OR join_status = 'done' OR (join_status = 'error' AND join_sig IS DISTINCT FROM ?))").run(sig, episodeId, sig);
  if (!claim.changes) return;
  try {
    const sub = await falClient().queue.submit(MERGE_ENDPOINT, { input: { video_urls: shots.map(function (s) { return s.video_url; }) }, webhookUrl: webhookUrl() || undefined });
    await db.prepare('UPDATE episodes SET join_request_id = ?, updated_at = NOW() WHERE id = ?').run(sub.request_id, episodeId);
    console.log('[video] episode ' + episodeId + ': joining ' + shots.length + ' shots, request ' + sub.request_id);
  } catch (e) {
    await db.prepare("UPDATE episodes SET join_status = 'error', join_error = ?, updated_at = NOW() WHERE id = ?").run(('fal refused the join: ' + falErrorText(e)).slice(0, 1000), episodeId);
  }
}
// An old episode video may be a take's own video (a one-shot episode): only files nothing else points at are deleted.
async function videoInUse(db, url) {
  const a = await db.prepare('SELECT id FROM takes WHERE video_url = ? LIMIT 1').get(url);
  const b = await db.prepare('SELECT id FROM moves WHERE video_url = ? LIMIT 1').get(url);
  return !!(a || b);
}
async function finishEpisodeJoin(ep, falResult, falError) {
  const db = await getDb();
  const claim = await db.prepare("UPDATE episodes SET join_status = 'saving', updated_at = NOW() WHERE id = ? AND join_status = 'running'").run(ep.id);
  if (!claim.changes) return 'not-mine';
  try {
    if (falError) throw new Error(falError);
    const buf = await joinedVideo(falResult, ep.join_request_id);
    const stored = await storage.uploadFile(buf, 'ep-' + ep.id + '-joined-' + Date.now() + '.mp4', 'video/mp4', 'video-lab');
    const old = ep.video_url;
    await db.prepare("UPDATE episodes SET video_url = ?, video_sig = join_sig, join_status = 'done', join_error = NULL, updated_at = NOW() WHERE id = ?").run(stored, ep.id);
    console.log('[video] episode ' + ep.id + ' joined: ' + buf.length + ' bytes');
    if (old && old !== stored && !(await videoInUse(db, old))) await deleteFiles([old], 'episode ' + ep.id + ': old video');
    await maybeJoinEpisode(db, ep.id);   // the chosen takes may have changed while it was joining
    return 'done';
  } catch (e) {
    const msg = falErrorText(e);
    await db.prepare("UPDATE episodes SET join_status = 'error', join_error = ?, updated_at = NOW() WHERE id = ?").run(msg.slice(0, 1000), ep.id);
    console.error('[video] episode ' + ep.id + ' join failed: ' + msg);
    return 'error';
  }
}

// fal's webhook. No session: accepted only for a ticket we issued; the result is read back from fal by that ticket.
router.post('/webhook', async function (req, res) {
  res.json({ ok: true });
  try {
    await ensureTables();
    const b = req.body || {};
    const rid = String(b.request_id || b.requestId || '');
    if (!rid) return;
    const db = await getDb();
    const failed = String(b.status || '').toUpperCase() === 'ERROR';
    const why = failed ? 'fal: ' + (b.error || JSON.stringify(b.payload || {})).toString().slice(0, 500) : null;
    const mv = await db.prepare('SELECT * FROM moves WHERE request_id = ?').get(rid);
    if (mv) {
      if (failed) return void await finishMove(mv, null, why);
      let data = null;
      try { const r = await falClient().queue.result(mv.endpoint, { requestId: rid }); data = r && (r.data || r); } catch (e) { data = b.payload || null; }
      return void await finishMove(mv, data, null);
    }
    const t = await db.prepare('SELECT * FROM takes WHERE merge_request_id = ?').get(rid);
    if (t) return void await finishTakeMerge(t, null, why);   // the joined video is read from fal by our ticket, never from the post
    const ep = await db.prepare('SELECT * FROM episodes WHERE join_request_id = ?').get(rid);
    if (ep) return void await finishEpisodeJoin(ep, null, why);
  } catch (e) {
    console.error('[video] webhook error:', e && e.message);
  }
});

// The sweep: anything still open is asked about directly, so a missed webhook never strands a clip or a join.
async function askJoin(requestId, ageMin, finish) {
  if (!requestId) { if (ageMin > 5) await finish('the join never reached fal'); return; }
  let st = null;
  try { st = await falClient().queue.status(MERGE_ENDPOINT, { requestId: requestId, logs: false }); }
  catch (e) { if (ageMin > STUCK_MINUTES) await finish('fal status check failed: ' + falErrorText(e)); return; }
  const s = String(st && st.status || '').toUpperCase();
  if (s === 'COMPLETED') await finish((st && st.error) ? ('fal: ' + st.error) : null);
  else if (ageMin > STUCK_MINUTES) await finish('the join timed out after ' + STUCK_MINUTES + ' minutes');
}
let _sweeping = false;
async function sweep() {
  if (_sweeping) return;
  _sweeping = true;
  try {
    await ensureTables();
    const db = await getDb();
    const open = await db.prepare("SELECT * FROM moves WHERE status IN ('queued', 'running') ORDER BY id LIMIT 20").all();
    for (const mv of open) {
      const ageMin = (Date.now() - new Date(mv.created_at).getTime()) / 60000;
      if (!mv.request_id) { if (ageMin > 5) await finishMove(mv, null, 'never reached fal'); continue; }
      let st = null;
      try { st = await falClient().queue.status(mv.endpoint, { requestId: mv.request_id, logs: false }); }
      catch (e) { if (ageMin > STUCK_MINUTES) await finishMove(mv, null, 'fal status check failed: ' + falErrorText(e)); continue; }
      const s = String(st && st.status || '').toUpperCase();
      if (s === 'COMPLETED') await finishMove(mv, null, (st && st.error) ? ('fal: ' + st.error) : null);
      else if (ageMin > STUCK_MINUTES) await finishMove(mv, null, 'timed out after ' + STUCK_MINUTES + ' minutes (fal says ' + (s || 'nothing') + ')');
    }
    const tj = await db.prepare("SELECT * FROM takes WHERE merge_status = 'running' ORDER BY id LIMIT 20").all();
    for (const t of tj) {
      await askJoin(t.merge_request_id, (Date.now() - new Date(t.merge_started_at || t.updated_at).getTime()) / 60000, function (err) { return finishTakeMerge(t, null, err); });
    }
    const ej = await db.prepare("SELECT * FROM episodes WHERE join_status = 'running' ORDER BY id LIMIT 20").all();
    for (const ep of ej) {
      await askJoin(ep.join_request_id, (Date.now() - new Date(ep.join_started_at || ep.updated_at).getTime()) / 60000, function (err) { return finishEpisodeJoin(ep, null, err); });
    }
    // A take whose moves are all back but whose join never started (a restart at the wrong moment).
    const waiting = await db.prepare("SELECT id FROM takes WHERE status = 'making' AND merge_status IS NULL ORDER BY id LIMIT 20").all();
    for (const t of waiting) await takeStatus(db, t.id);
  } catch (e) {
    if (!/DATABASE_URL/.test(String(e && e.message))) console.error('[video] sweep error:', e && e.message);
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

// ---- the shot list (v3.4.98, now per shot) ---------------------------------------------------
// Write the shot list sends the version's story, the keyframes (as pictures and as words) grouped into their shots, the
// cast, the art style, the genre, the chosen style's rules and the video model's limits to the model that writes the
// story (TEXT_MODEL), and fills the Overall direction and every move's box. It is told where the cuts are: each shot is
// one continuous camera run. It runs as a job (one row in episode_writer_jobs, one running per episode). Tokens:
// max(1, ceil(actual cost / 8 cents)), charged only once the boxes are filled. The book is only read, never written.
const VIDEO_STYLES = [
  { key: 'animated', label: 'Animated',
    description: 'Full motion: the characters act, move and speak; the camera follows the action.',
    motion: 'high', defaultShot: 5, speech: true,
    instructions: 'ANIMATED. Real action happens: name what each character does, step by step, so the movement carries each keyframe into the next. The camera may move (follow, pan, push in, pull back) to serve the action. Characters may speak: short lines in their own words, said by a character on screen or called from off screen, a few words that fit inside the move\'s length (about two words a second at most). Add sound effects that fit. Keep faces, costumes and the art style true to the pictures: more motion means more drift, so keep the action clear and simple rather than busy.' },
  { key: 'living', label: 'Living Illustration',
    description: 'The picture comes alive gently: cloaks stir, fire flickers, dust drifts, a slow push in. Characters hold their poses.',
    motion: 'low', defaultShot: 5, speech: false,
    instructions: 'LIVING ILLUSTRATION. Subtle motion only: hair and cloth stirring, light and flame flickering, smoke, dust, rain or particles drifting, breathing, blinking. Characters keep their pose and their place; nobody walks, fights or gestures. The camera is slow (a gentle push in or pan) or still. No speech. Keep the art style exactly as painted. Inside a shot the camera drifts from one keyframe to the next, never jumping.' },
  { key: 'documentary', label: 'Documentary',
    description: 'Slow camera moves across each picture, like a documentary. Narration comes later with voices.',
    motion: 'low', defaultShot: 6, speech: false,
    instructions: 'DOCUMENTARY. Treat each move as a slow camera move over the picture, as in a documentary about paintings: say which part of the picture the camera starts on, where it drifts or zooms, and what it comes to rest on. Nothing in the picture moves by itself: no character motion. No speech (narration comes later). Ambient sound only (wind, a room, a crowd far off).' }
];
const DEFAULT_STYLE = 'living';
function styleFor(key) {
  for (let i = 0; i < VIDEO_STYLES.length; i++) if (VIDEO_STYLES[i].key === key) return VIDEO_STYLES[i];
  for (let i = 0; i < VIDEO_STYLES.length; i++) if (VIDEO_STYLES[i].key === DEFAULT_STYLE) return VIDEO_STYLES[i];
  return VIDEO_STYLES[0];
}
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
const SL_MAX_IMAGES = 20;
const SL_IMAGE_PX = 512;
const SL_STORY_CHARS = 30000;
const SL_TIMEOUT_MS = 240000;
const SL_STALE_MS = 10 * 60 * 1000;
const SL_BOOT_GRACE_MS = 3 * 60 * 1000;
const SL_BOOT = crypto.randomBytes(6).toString('hex');
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
// The structure the writer was given: shots and their keyframes' pictures. If it differs when the answer comes back,
// nothing is filled and nothing is charged.
function structureSig(shots) { return shortSig(JSON.stringify(shots.map(function (s) { return [s.id].concat(s.keyframes.map(function (k) { return k.image_url; })); }))); }
function movesIn(s) { return s.keyframes.length === 1 ? 1 : s.keyframes.length - 1; }

async function shotListContext(db, ep) {
  const m = MODELS[ep.model] || MODELS[DEFAULT_MODEL];
  const style = styleFor(ep.style);
  const shots = await db.prepare('SELECT * FROM shots WHERE episode_id = ? ORDER BY position, id').all(ep.id);
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE episode_id = ? ORDER BY shot_id, position, id').all(ep.id);
  shots.forEach(function (s) { s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; }); });
  const live = shots.filter(function (s) { return s.keyframes.length; });
  const story = await storyOfVersion(db, ep.fork_id);
  const session = await db.prepare('SELECT id, name, art_style FROM sessions WHERE id = ?').get(ep.session_id);
  const campaign = await db.prepare('SELECT id, name, art_style, genres FROM campaigns WHERE id = ?').get(ep.campaign_id);
  const momentsById = {}; story.moments.forEach(function (mo) { momentsById[mo.id] = mo; });
  let cast = await db.prepare('SELECT ch.name, ch.cls, ch.description, ch.is_npc, sc.prompt FROM session_characters sc JOIN characters ch ON ch.id = sc.character_id WHERE sc.fork_id = ? ORDER BY ch.is_npc ASC, ch.id ASC').all(ep.fork_id);
  if (!cast.length) cast = await db.prepare('SELECT name, cls, description, is_npc, canonical_prompt AS prompt FROM characters WHERE campaign_id = ? ORDER BY is_npc ASC, id ASC LIMIT 40').all(ep.campaign_id);
  let artStyle = String((story.fork && story.fork.art_style_override) || (session && session.art_style) || (campaign && campaign.art_style) || '').trim();
  const cm = /^custom:(\d+)$/i.exec(artStyle);
  if (cm) {
    try { const r = await db.prepare('SELECT name FROM custom_art_styles WHERE id = ?').get(parseInt(cm[1], 10)); artStyle = (r && r.name) ? String(r.name) : 'a custom art style'; } catch (e) { artStyle = 'a custom art style'; }
  } else if (artStyle) {
    try { artStyle = require('../services/artStyleCatalog').labelFor(artStyle); } catch (e) {}
  }
  let genres = [];
  try { genres = require('../services/genres').genreLabels(campaign); } catch (e) { genres = []; }
  let n = 0;
  const pictures = [];
  live.forEach(function (s, si) {
    s.keyframes.forEach(function (k, ki) {
      n++;
      const mo = k.moment_id ? momentsById[k.moment_id] : null;
      let words;
      if (k.source === 'title') words = 'The title picture.';
      else if (mo) words = 'A storyboard picture: "' + textOf(mo.title) + '".' + (textOf(mo.description) ? ' What it shows: ' + textOf(mo.description).slice(0, 600) : '') +
        (story.byMoment[mo.id] ? '\nIts text in the story: ' + story.byMoment[mo.id].slice(0, 1200) : '');
      else words = 'A picture from the Archive' + (k.label ? ': "' + textOf(k.label) + '"' : '') + '.';
      pictures.push({ n: n, shot: si + 1, k: ki + 1, of: s.keyframes.length, url: k.image_url, words: words });
    });
  });
  return { ep: ep, m: m, modelKey: ep.model, style: style, story: story, cast: cast, artStyle: artStyle, genres: genres, shots: live, sig: structureSig(live),
    sessionName: session ? String(session.name || '') : '', campaignName: campaign ? String(campaign.name || '') : '', pictures: pictures };
}
function estimateShotList(ctx, prices) {
  const n = ctx.pictures.length;
  const moves = ctx.shots.reduce(function (t, s) { return t + movesIn(s); }, 0);
  const words = ctx.pictures.reduce(function (t, p) { return t + p.words.length; }, 0);
  const castChars = ctx.cast.reduce(function (t, c) { return t + String(c.name || '').length + String(c.description || '').length + Math.min(800, String(c.prompt || '').length); }, 0);
  const inTok = Math.ceil((4500 + ctx.story.text.length + words + castChars) / 4) + Math.min(n, SL_MAX_IMAGES) * 360;
  const outTok = 300 + moves * 170;
  const usd = usdFor(prices, inTok, outTok);
  return { input_tokens: inTok, output_tokens: outTok, usd: Math.round(usd * 10000) / 10000, tokens: tokensFor(prices, usd), moves: moves, shots: ctx.shots.length };
}
async function pictureForModel(url) {
  try {
    if (!url || !storage.isOurPublicUrl(url)) return null;
    const axios = require('axios');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024 });
    const out = await require('sharp')(Buffer.from(resp.data)).rotate().resize({ width: SL_IMAGE_PX, height: SL_IMAGE_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    return out.toString('base64');
  } catch (e) {
    console.warn('[video] shot list: could not read a picture (' + (e && e.message) + ')');
    return null;
  }
}
function shotListRequest(ctx, images) {
  const m = ctx.m, style = ctx.style;
  const def = snapDuration(m, style.defaultShot) || m.defDuration;
  const counts = ctx.shots.map(movesIn);
  const system =
    'You are the director of a short video made from the illustrations of a story. It is made by an image-to-video model, ' + m.label + '.\n\n' +
    'HOW THE VIDEO IS BUILT\nThe video is a series of SHOTS joined by CUTS. A shot is one continuous camera run: the camera never cuts away inside it. ' +
    'A shot is made from one or more KEYFRAMES (pictures) in order. A shot of several keyframes is made of MOVES joined seamlessly: each move starts exactly on one keyframe and ends exactly on the next, ' +
    'so the camera and the action must flow through every keyframe as one unbroken take. A shot of ONE keyframe is one move that brings that single picture to life. ' +
    'A shot of several keyframes may also end with an AFTER move: it starts on the last keyframe and has no end picture, for what happens after that picture until the cut (a character turns, speaks, runs out of frame). ' +
    'Write an after move only when the story needs action after the last picture of the shot. ' +
    'Between shots there is a cut: the next shot may begin somewhere new, or later in time.\n\n' +
    'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
    'THE VIDEO MODEL\nMove lengths it offers, in seconds: ' + m.durations.join(', ') + '. Give every move one of these exact numbers; ' + def + ' suits this style unless a move needs more or less time. ' +
    'The model sees only the move\'s pictures and your words: name people as the pictures show them and describe what they do in plain visual terms.\n\n' +
    'THE OVERALL DIRECTION is sent with every move: one short paragraph (at most 600 characters) naming the setting, the mood, the light, and each main character\'s look in words ' +
    '(build, hair, clothes, colours) so every shot keeps them the same. Keep the art style as it is in the pictures.\n\n' +
    'RULES\n- Keep the names exactly as the story and the cast list write them.\n- Each move\'s action is at most 450 characters; camera, sound and each line short.\n' +
    '- Inside a shot, each move continues the camera and the action of the move before it; never describe a cut inside a shot.\n' +
    (style.speech ? '- Dialogue: a character visible in that move speaks, or a voice from off screen (write the speaker as "Name (off-screen)"); at most two short lines a move; leave it empty when nobody should talk.\n' : '- Dialogue: always an empty list in this style.\n') +
    '- Write original words; never reproduce text from any published source.\n- Never put words, captions or titles on screen.\n\n' +
    'ANSWER WITH ONLY THIS JSON, no other text:\n' +
    '{"overall": "...", "shots": [{"shot": 1, "moves": [{"from": 1, "action": "...", "camera": "...", "dialogue": [{"speaker": "...", "line": "..."}], "sound": "...", "duration": "' + def + '"}]}]}\n' +
    'The shots list has exactly ' + counts.length + ' entr' + (counts.length === 1 ? 'y' : 'ies') + ', in order, and each shot has exactly this many moves: ' +
    counts.map(function (c, i) { return 'shot ' + (i + 1) + ': ' + c; }).join(', ') + '. ' +
    '"from" is the keyframe number (within its shot) the move starts on. A shot of N keyframes has N-1 moves, from 1 to N-1, and may add one after move, from N (the last keyframe). ' +
    'A shot of one keyframe has exactly one move, from 1.';
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
  head.push('THE SHOTS OF THIS VIDEO, IN ORDER (' + ctx.shots.length + ' shot' + (ctx.shots.length === 1 ? '' : 's') + ', ' + ctx.pictures.length + ' keyframes).' +
    (sent < ctx.pictures.length ? (sent ? ' Only ' + sent + ' keyframes are shown as pictures; the others are described in words only.' : ' They are described in words only.') : ''));
  content.push({ type: 'text', text: head.join('\n') });
  ctx.pictures.forEach(function (p, i) {
    const shotHead = p.k === 1 ? ((p.shot > 1 ? '--- CUT ---\n' : '') + 'SHOT ' + p.shot + ' (' + p.of + ' keyframe' + (p.of === 1 ? '' : 's') + ', ' + (p.of === 1 ? 1 : p.of - 1) + ' move' + (p.of === 2 || p.of === 1 ? '' : 's') + ')\n') : '';
    content.push({ type: 'text', text: shotHead + 'Shot ' + p.shot + ', keyframe ' + p.k + ' of ' + p.of + '. ' + p.words });
    if (images[i]) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[i] } });
  });
  // v3.5.05 -- every move named, so a long shot is not answered with one move too many (Ian, 2026-11-08: "shot 1 came
  // back with 16 moves, not 15").
  const plan = ctx.shots.map(function (s, i) {
    const n = s.keyframes.length;
    if (n === 1) return 'Shot ' + (i + 1) + ': 1 move, from keyframe 1 (the picture brought to life).';
    const list = [];
    for (let k = 1; k < n; k++) list.push(k + '\u2192' + (k + 1));
    return 'Shot ' + (i + 1) + ': ' + (n - 1) + ' move' + (n === 2 ? '' : 's') + ': ' + list.join(', ') + '; and, only if needed, an after move from ' + n + '.';
  });
  content.push({ type: 'text', text: 'THE MOVES TO WRITE, exactly these and no others:\n' + plan.join('\n') + '\n\nNow write the shot list as JSON: the overall direction and the moves of every shot, in the ' + style.label + ' style.' });
  const total = counts.reduce(function (t, c) { return t + c; }, 0);
  return { system: system, content: content, max_tokens: Math.min(16000, 1200 + total * 450) };
}
function parseShotList(raw, ctx) {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  let p = null;
  try { p = JSON.parse(clean); } catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { p = JSON.parse(clean.slice(a, b + 1)); } catch (e2) { p = null; } }
  }
  if (!p || typeof p !== 'object' || !Array.isArray(p.shots)) return { error: 'unreadable' };
  if (p.shots.length !== ctx.shots.length) return { error: 'came back with ' + p.shots.length + ' shots, not ' + ctx.shots.length };
  const shots = [];
  for (let i = 0; i < p.shots.length; i++) {
    const want = movesIn(ctx.shots[i]);
    let mv = (p.shots[i] && Array.isArray(p.shots[i].moves)) ? p.shots[i].moves : null;
    let after = null;
    if (!mv) return { error: 'shot ' + (i + 1) + ' came back with no moves' };
    // v3.5.05 -- line the moves up by the keyframe each starts on ("from"): a move from the last keyframe of a longer
    // shot (it leads nowhere) is dropped, as is a second move from the same keyframe. Without "from", one move too many
    // loses the last. Only a move that is missing still fails the list.
    const hasFrom = mv.every(function (x) { return x && Number.isFinite(parseInt(x.from, 10)); });
    if (hasFrom) {
      const byFrom = {};
      mv.forEach(function (x) { const f = parseInt(x.from, 10); if (f >= 1 && f <= want + 1 && !byFrom[f]) byFrom[f] = x; });
      const lined = [];
      for (let f = 1; f <= want; f++) if (byFrom[f]) lined.push(byFrom[f]);
      after = (ctx.shots[i].keyframes.length > 1 && byFrom[want + 1]) ? byFrom[want + 1] : null;   // v3.5.07: from the last keyframe = the after move
      mv = lined;   // a keyframe with no move from it leaves the list short, and it fails below
    } else if (ctx.shots[i].keyframes.length > 1 && mv.length === want + 1) {
      after = mv[want];   // v3.5.07: without "from", one more than the keyframes need is the after move
    }
    if (mv.length > want) mv = mv.slice(0, want);
    if (mv.length !== want) return { error: 'shot ' + (i + 1) + ' came back with ' + mv.length + ' moves, not ' + want };
    const moves = [];
    const all = after ? mv.concat([after]) : mv;
    for (let j = 0; j < all.length; j++) {
      const s = all[j] || {};
      const d = snapDuration(ctx.m, parseFloat(String(s.duration == null ? '' : s.duration).replace(/[^0-9.]/g, '')));
      if (!d) return { error: 'shot ' + (i + 1) + ' move ' + (j + 1) + ' has no length' };
      let dlg = [];
      if (Array.isArray(s.dialogue)) dlg = s.dialogue.map(function (x) { return { speaker: textOf(x && x.speaker).slice(0, 80), line: textOf(x && x.line).replace(/^["\u201c]+|["\u201d]+$/g, '').slice(0, 300) }; }).filter(function (x) { return x.line; });
      else if (textOf(s.dialogue)) dlg = [{ speaker: '', line: textOf(s.dialogue).slice(0, 300) }];
      if (!ctx.style.speech) dlg = [];
      moves.push({ action: textOf(s.action).slice(0, 900), camera: textOf(s.camera).slice(0, 300), dialogue: dlg.slice(0, 4), sound: textOf(s.sound).slice(0, 300), duration: d });
    }
    shots.push({ moves: moves });   // v3.5.07: one more than the keyframes need when there is an after move
  }
  return { overall: textOf(p.overall).slice(0, 2000), shots: shots };
}
function moveBoxText(s) {
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
async function retireLostJobs(db, episodeId) {
  const now = Date.now();
  const rows = await db.prepare("SELECT id, boot_id, started_at FROM episode_writer_jobs WHERE episode_id = ? AND status = 'running'").all(episodeId);
  for (const j of rows) {
    const age = now - new Date(j.started_at).getTime();
    if (age > SL_STALE_MS || (j.boot_id !== SL_BOOT && age > SL_BOOT_GRACE_MS)) {
      await db.prepare("UPDATE episode_writer_jobs SET status = 'interrupted', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'")
        .run('Interrupted (the server restarted while it was being written). Nothing was charged; try again.', j.id);
    }
  }
}
async function runningWriter(db, episodeId) {
  await retireLostJobs(db, episodeId);
  return db.prepare("SELECT id FROM episode_writer_jobs WHERE episode_id = ? AND status = 'running' LIMIT 1").get(episodeId);
}
function jobView(j) {
  if (!j) return null;
  return { id: j.id, status: j.status, error: j.error || null, tokens_charged: j.tokens_charged || 0, style: j.style, started_at: j.started_at, finished_at: j.finished_at };
}
async function runShotList(jobId, episodeId, userId, ctx, prices, key) {
  const db = await getDb();
  const JFN = 'shot list job ' + jobId + ' (episode ' + episodeId + ')';
  let inTok = 0, outTok = 0, result = null, lastErr = '';
  try {
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
      result = p;
    }
  } catch (e) { lastErr = (e && e.message) || 'unknown error'; vlDebug(userId, 'error', JFN, 'The job threw: ' + lastErr, { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' }); }
  const usd = Math.round(usdFor(prices, inTok, outTok) * 10000) / 10000;
  if (!result) {
    await db.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'")
      .run(('The shot list came back incomplete (' + lastErr + '). Nothing was charged; try again.').slice(0, 1000), inTok, outTok, usd, jobId);
    console.error('[video] ' + JFN + ' failed: ' + lastErr + ' ($' + usd + ' to Campaignia)');
    vlDebug(userId, 'error', JFN, 'Failed after two tries: ' + lastErr, { input_tokens: inTok, output_tokens: outTok, cost_usd: usd });
    return;
  }
  const charge = tokensFor(prices, usd);
  const shotList = { style: ctx.style.key, model: ctx.modelKey, written_at: new Date().toISOString(), overall: result.overall, shots: result.shots };
  let filled = false;
  await db.transaction(async function (tx) {
    const claim = await tx.prepare("UPDATE episode_writer_jobs SET status = 'done', input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run(inTok, outTok, usd, jobId);
    if (!claim.changes) return;
    const ep = await tx.prepare('SELECT * FROM episodes WHERE id = ? FOR UPDATE').get(episodeId);
    const shots = ep ? await tx.prepare('SELECT * FROM shots WHERE episode_id = ? ORDER BY position, id').all(episodeId) : [];
    const kfs = ep ? await tx.prepare('SELECT * FROM keyframes WHERE episode_id = ? ORDER BY shot_id, position, id').all(episodeId) : [];
    shots.forEach(function (s) { s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; }); });
    const live = shots.filter(function (s) { return s.keyframes.length; });
    if (!ep || structureSig(live) !== ctx.sig) {
      await tx.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ? WHERE id = ?").run('The episode changed while its shot list was being written. Nothing was charged; try again.', jobId);
      return;
    }
    for (let i = 0; i < live.length; i++) {
      const mv = result.shots[i].moves;
      for (let j = 0; j < live[i].keyframes.length; j++) {
        const k = live[i].keyframes[j];
        const x = mv[j];   // the move that starts on this keyframe; the last keyframe of a longer shot has one only when the writer gave an after move (v3.5.07)
        if (x) await tx.prepare('UPDATE keyframes SET prompt = ?, duration = ? WHERE id = ?').run(moveBoxText(x), x.duration, k.id);
        else await tx.prepare("UPDATE keyframes SET prompt = '' WHERE id = ?").run(k.id);
      }
    }
    await tx.prepare('UPDATE episodes SET overall = ?, shot_list = ?, style = ?, updated_at = NOW() WHERE id = ?').run(result.overall, JSON.stringify(shotList), ctx.style.key, episodeId);
    filled = true;
  });
  if (!filled) { vlDebug(userId, 'warn', JFN, 'Not filled (the episode changed, was deleted, or the job was interrupted); nothing charged'); return; }
  let charged = 0;
  try {
    const tokens = require('./tokens');
    const bal = await tokens.getBalance(userId);
    charged = Math.min(charge, Math.max(0, bal.total));
    if (charged > 0) await tokens.spendTokens(userId, charged, { source: 'video_shot_list', event_type: 'generation_spend', related_campaign_id: ctx.ep.campaign_id });
    if (charged < charge) console.warn('[video] ' + JFN + ': balance covered ' + charged + ' of ' + charge + ' token(s)');
    const moves = result.shots.reduce(function (t, s) { return t + s.moves.length; }, 0);
    await tokens.recordGeneration(userId, { event_type: 'video_shot_list', tokens_redeemed: charged, quantity: moves, unit: 'moves', model: require('../config/models').TEXT_MODEL, related_campaign_id: ctx.ep.campaign_id, related_session_id: ctx.ep.session_id });
  } catch (e) { console.error('[video] shot list charge failed:', e && e.message); }
  await db.prepare('UPDATE episode_writer_jobs SET tokens_charged = ? WHERE id = ?').run(charged, jobId);
  console.log('[video] ' + JFN + ': ' + result.shots.length + ' shot(s), ' + inTok + ' in / ' + outTok + ' out, $' + usd + ', ' + charged + ' token(s)');
  vlDebug(userId, 'info', JFN, 'Boxes filled: ' + result.shots.length + ' shot(s), ' + charged + ' token(s) charged', { input_tokens: inTok, output_tokens: outTok, cost_usd: usd, worked_out: charge });
}

router.post('/episodes/:id/shot-list', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/shot-list';
  try {
    await ensureTables();
    const db = await getDb();
    const ep0 = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!(await canChange(req, ep0))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!ep0, admin: !!req.vlAdmin });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return vlRefuse(req, res, FN, 500, 'The writer is not set up on this server (ANTHROPIC_API_KEY).');
    const b = req.body || {};
    let ep = ep0;
    if (b.style != null && VIDEO_STYLES.some(function (s) { return s.key === b.style; }) && b.style !== ep0.style) {
      await db.prepare('UPDATE episodes SET style = ?, updated_at = NOW() WHERE id = ?').run(b.style, ep0.id);
      ep = Object.assign({}, ep0, { style: b.style });
    }
    const ctx = await shotListContext(db, ep);
    if (!ctx.pictures.length) return vlRefuse(req, res, FN, 400, 'This episode has no keyframes.');
    const prices = await shotListPrices(db);
    const est = estimateShotList(ctx, prices);
    const bal = await require('./tokens').getBalance(req.session.userId);
    vlDebug(req.session.userId, 'info', FN, 'Shot list asked for', { style: ctx.style.key, model: ctx.modelKey, shots: ctx.shots.length, keyframes: ctx.pictures.length, story_chars: ctx.story.text.length, cast: ctx.cast.length, estimate: est, balance: bal.total });
    if (bal.total < est.tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: 'Writing this shot list costs about ' + est.tokens + ' token' + (est.tokens === 1 ? '' : 's') + ', but you have ' + bal.total + '. Add tokens and try again.' });
    await retireLostJobs(db, ep.id);
    const ins = await db.prepare("INSERT INTO episode_writer_jobs (episode_id, user_id, status, style, model, boot_id, sig, est_tokens) VALUES (?, ?, 'running', ?, ?, ?, ?, ?) ON CONFLICT (episode_id) WHERE status = 'running' DO NOTHING")
      .run(ep.id, req.session.userId, ctx.style.key, ctx.modelKey, SL_BOOT, ctx.sig, est.tokens);
    if (!ins.lastInsertRowid) return vlRefuse(req, res, FN, 409, 'A shot list is already being written for this episode.');
    const job = await db.prepare('SELECT * FROM episode_writer_jobs WHERE id = ?').get(ins.lastInsertRowid);
    res.json({ job: jobView(job), estimate: est });
    runShotList(job.id, ep.id, req.session.userId, ctx, prices, key).catch(async function (e) {
      console.error('[video] shot list job ' + job.id + ' crashed:', e && e.message);
      try { await db.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run('Something went wrong writing it. Nothing was charged; try again.', job.id); } catch (e2) {}
    });
  } catch (e) {
    console.error('[video] shot list start error:', e && e.message, e && e.stack);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Could not start: ' + (e && e.message), { code: e && e.code, stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the shot list.' });
  }
});
router.get('/episodes/:id/shot-list', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canSee(req, ep))) return res.status(404).json({ error: 'Not found.' });
    await retireLostJobs(db, ep.id);
    const j = await db.prepare('SELECT * FROM episode_writer_jobs WHERE episode_id = ? ORDER BY id DESC LIMIT 1').get(ep.id);
    let estimate = null;
    try { const ctx = await shotListContext(db, ep); if (ctx.pictures.length) estimate = estimateShotList(ctx, await shotListPrices(db)); } catch (e) { estimate = null; }
    res.json({ job: jobView(j), estimate: estimate, episode: (j && j.status !== 'running') ? await loadEpisode(db, ep.id) : null });
  } catch (e) {
    console.error('[video] shot list read error:', e && e.message);
    res.status(500).json({ error: 'Could not read the shot list.' });
  }
});

startSweep();

module.exports = router;
module.exports.MODELS = MODELS;
module.exports.VIDEO_STYLES = VIDEO_STYLES;
module.exports.estCost = estCost;
module.exports.buildInput = buildInput;
module.exports.MERGE_ENDPOINT = MERGE_ENDPOINT;
module.exports._ensureTables = ensureTables;
module.exports._sweep = sweep;
module.exports._stopSweep = function () { if (_timer) clearInterval(_timer); _timer = null; };
module.exports._internals = { finishMove: finishMove, takeStatus: takeStatus, finishTakeMerge: finishTakeMerge, maybeJoinEpisode: maybeJoinEpisode, finishEpisodeJoin: finishEpisodeJoin,
  loadEpisode: loadEpisode, planMoves: planMoves, cleanShots: cleanShots, writeShots: writeShots, shotSig: shotSig, makeShot: makeShot, vlSaveSummary: vlSaveSummary };
module.exports._shotList = { styleFor: styleFor, snapDuration: snapDuration, usdFor: usdFor, tokensFor: tokensFor, shotListPrices: shotListPrices, estimateShotList: estimateShotList,
  shotListContext: shotListContext, shotListRequest: shotListRequest, parseShotList: parseShotList, moveBoxText: moveBoxText, runShotList: runShotList, retireLostJobs: retireLostJobs, BOOT: SL_BOOT, structureSig: structureSig };
