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
// v3.5.14 -- ONE SHAPE FOR EVERY CLIP (Ian, 2026-11-08: a wide title picture and a tall Gubuk made a nearly square take,
// "the AI video engine is changing the shape"; "go with... whatever most non phone videos are made in now"): wide 16:9,
// asked of every model that takes a shape (Kling takes its shape from the picture). A keyframe that is square or tall is
// flagged on the tab, with Expand to redraw it wide, and Generate warns before making a shot that has one.
const VIDEO_ASPECT = '16:9';
const EXPAND_INSTRUCTION = 'Expand this picture into a wide 16:9 frame. Keep everything that is already in it exactly as it is: the same people, faces, clothes, poses, objects, light and art style. ' +
  'Continue the scene naturally out to the left and right so it fills the wide frame, matching what is already there. Do not crop anyone, do not add new characters, and do not add any text.';
const MODELS = {
  seedance2: {
    label: 'Seedance 2.0', group: 'keyframes', endpoint: 'bytedance/seedance-2.0/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.3024, priceSound: 0.3024,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true
  },
  seedance2fast: {
    label: 'Seedance 2.0 Fast', group: 'keyframes', endpoint: 'bytedance/seedance-2.0/fast/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.2419, priceSound: 0.2419,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true
  },
  kling3std: {
    label: 'Kling 3.0 Standard', group: 'keyframes', endpoint: 'fal-ai/kling-video/v3/standard/image-to-video',
    start: 'start_image_url', end: 'end_image_url', durations: ['3', '5', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.084, priceSound: 0.126,
    extra: {}, promptRequired: false
  },
  veo31fast: {
    label: 'Veo 3.1 Fast', group: 'keyframes', endpoint: 'fal-ai/veo3.1/fast/first-last-frame-to-video',
    start: 'first_frame_url', end: 'last_frame_url', durations: ['4', '6', '8'], defDuration: '8',
    durationValue: function (d) { return String(d) + 's'; }, price: 0.10, priceSound: 0.15,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true,
    single: { endpoint: 'fal-ai/veo3.1/fast/image-to-video', start: 'image_url' }
  },
  // v3.5.16 -- REFERENCE MODE, a test (Ian, 2026-11-08: "Let's just try reference option... hard code that in for a second
  // and let me test it"). The whole shot is ONE clip: the keyframes and the cast's reference pictures go as references
  // (@Image1...), not as fixed first and last frames, so the model directs the shot itself instead of morphing one
  // picture into the next. The shot's length is its boxes' lengths added up (4 to 15 s). Prices as the image-to-video
  // ones until fal's are read.
  seedance2ref: {
    label: 'Seedance 2.0', group: 'reference', endpoint: 'bytedance/seedance-2.0/reference-to-video', reference: true,
    durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.3024, priceSound: 0.3024,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true
  },
  seedance2reffast: {
    label: 'Seedance 2.0 Fast', group: 'reference', endpoint: 'bytedance/seedance-2.0/fast/reference-to-video', reference: true,
    durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.2419, priceSound: 0.2419,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true
  }
};
const REF_MAX_IMAGES = 9;      // fal: up to 9 reference images
const REF_MAX_KEYFRAMES = 5;   // the rest of the 9 are kept for the cast
const REF_MIN_SECS = 4, REF_MAX_SECS = 15;
const DEFAULT_MODEL = 'seedance2reffast';   // v3.5.19: reference mode is the normal way (was seedance2fast, keyframes)
const MERGE_ENDPOINT = 'fal-ai/ffmpeg-api/merge-videos';   // joins clips in order on fal's servers (listed at $0)
const MAX_KEYFRAMES = 60;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const STUCK_MINUTES = 45;
const MAX_TAKES = 10;   // v3.5.15 (Ian: "for now we limit them to 3 takes"); v3.5.25: 10 while Video is built out (Ian: "Let's lift the limit on 3 takes")
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
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS name TEXT');   // v3.5.15: a shot's own name
    await db.exec('ALTER TABLE episode_writer_jobs ADD COLUMN IF NOT EXISTS kind TEXT');
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS source_take_id INTEGER');   // v3.5.26: a retouch of that take
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS retouch_text TEXT');
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS retouch_kind TEXT');   // 'small' (Kling O1 Edit) or 'big' (Seedance 2.0)   // v3.5.23: 'shots' (Create Shots) or 'notes' (Director's Notes)
    // v3.5.19 -- a shot described in plain words, one set per shot (VIDEO_REFERENCE_SHOTS_SPEC section 2). actions and
    // lines are JSON; actions NULL means the shot was never saved this way (its words are still on its keyframes).
    for (const c of ['start_text TEXT', 'actions TEXT', 'lines TEXT', 'camera TEXT', 'end_text TEXT', 'sounds TEXT', 'around TEXT', 'seconds INTEGER', 'refs TEXT']) {   // refs: v3.5.22
      await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS ' + c);
    }
    await db.exec('ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS episode_id INTEGER');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_image_jobs_episode ON image_jobs(episode_id)');
  })();
  _tablesReady.catch(function () { _tablesReady = null; });
  return _tablesReady;
}

// ---- reading an episode ----------------------------------------------------------------------
// What a shot will be made from now: the model, the sound, the overall direction and every keyframe with its move's
// words and length. A take records the same signature, so a take made before an edit shows as out of date.
function shotSig(ep, kfs, shot) {
  const w = shot ? shotWords(shot) : null, r = shot ? shotRefs(shot) : null;
  return shortSig(JSON.stringify([ep.model, !!ep.sound, String(ep.overall || '')].concat(kfs.map(function (k) { return [k.image_url, k.prompt || '', k.duration || '']; }))
    .concat(w ? [w] : []).concat(r ? [r] : [])));   // v3.5.19: the shot's own words too; v3.5.22: and its references
}
// v3.5.19 -- A SHOT IN PLAIN WORDS. A shot's words as stored (JSON in actions and lines), or null for a shot never saved
// this way. lines: [{ who, text, when (1-based action number, or 0 for any time), off (heard off-screen) }].
const SHOT_MIN_SECS = 4, SHOT_MAX_SECS = 15, SHOT_DEFAULT_SECS = 8;
function parseJson(v, dflt) { if (v == null) return dflt; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return dflt; } }
function shotWords(shot) {
  if (!shot || shot.actions == null) return null;
  const actions = parseJson(shot.actions, []), lines = parseJson(shot.lines, []);
  return { start: String(shot.start_text || ''), actions: Array.isArray(actions) ? actions.map(String) : [], lines: Array.isArray(lines) ? lines : [],
    camera: String(shot.camera || ''), end: String(shot.end_text || ''), sounds: String(shot.sounds || ''), around: String(shot.around || ''),
    seconds: Math.max(SHOT_MIN_SECS, Math.min(SHOT_MAX_SECS, parseInt(shot.seconds, 10) || SHOT_DEFAULT_SECS)) };
}
function clampSecs(n) { return Math.max(SHOT_MIN_SECS, Math.min(SHOT_MAX_SECS, Math.round(Number(n) || SHOT_DEFAULT_SECS))); }
// A shot never saved in plain words: its old per-keyframe words become its actions, in order (spec section 5).
function legacyWords(kfs, m) {
  const n = kfs.length === 1 ? 1 : kfs.length - 1 + (hasAfter(kfs) ? 1 : 0);
  const actions = [];
  let secs = 0;
  for (let i = 0; i < n; i++) { const w = String(kfs[i].prompt || '').trim(); if (w) actions.push(w); secs += Number(kfs[i].duration || (m && m.defDuration) || 0) || 0; }
  return { start: '', actions: actions, lines: [], camera: '', end: '', sounds: '', around: '', seconds: clampSecs(secs || SHOT_DEFAULT_SECS) };
}
function cleanText(v, max) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim().slice(0, max); }
function cleanWords(s) {
  const actions = (Array.isArray(s.actions) ? s.actions : String(s.actions || '').split('\n'))
    .map(function (a) { return cleanText(a, 900).replace(/^\s*\d+\s*[.)]\s*/, ''); }).filter(Boolean).slice(0, 20);
  const lines = (Array.isArray(s.lines) ? s.lines : []).map(function (l) {
    l = l || {};
    const when = parseInt(l.when, 10);
    return { who: cleanText(l.who, 80), text: cleanText(l.text, 300).replace(/^["\u201c]+|["\u201d]+$/g, ''), when: when >= 1 && when <= actions.length ? when : 0, off: !!l.off };
  }).filter(function (l) { return l.text; }).slice(0, 12);
  return { start: cleanText(s.start_text != null ? s.start_text : s.start, 900), actions: actions, lines: lines, camera: cleanText(s.camera, 900), end: cleanText(s.end_text != null ? s.end_text : s.end, 900),
    sounds: cleanText(s.sounds, 600), around: cleanText(s.around, 600), seconds: clampSecs(s.seconds) };
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
  const archivedBy = {};   // v3.5.20
  {
    const urls = kfs.map(function (k) { return k.image_url; }).filter(Boolean);
    if (urls.length) {
      let arch = [];
      try { arch = await db.prepare('SELECT DISTINCT campaign_id, source_url FROM campaign_archives WHERE source_url = ANY(?)').all([urls]); }
      catch (e) { console.error('[video] archived pictures could not be read: ' + (e && e.message)); }
      eps.forEach(function (ep) {
        const mine = {}; kfs.forEach(function (k) { if (k.episode_id === ep.id) mine[k.image_url] = true; });
        archivedBy[ep.id] = arch.filter(function (a) { return Number(a.campaign_id) === Number(ep.campaign_id) && mine[a.source_url]; }).map(function (a) { return a.source_url; });
      });
    }
  }
  const castByVersion = {};
  for (const ep of eps) {
    const key = ep.fork_id + ':' + ep.campaign_id;
    if (!castByVersion[key]) castByVersion[key] = await refsPool(db, ep);   // v3.5.22: characters and assets
  }
  eps.forEach(function (ep) {
    ep.shots = shots.filter(function (s) { return s.episode_id === ep.id; });
    ep.shots.forEach(function (s) {
      s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; });
      s.sig = shotSig(ep, s.keyframes, s);
      const w = shotWords(s);   // v3.5.19
      s.words = w || legacyWords(s.keyframes, MODELS[ep.model]);
      s.words_saved = !!w;
      s.refs = shotRefs(s);   // v3.5.22: null = never chosen (the page starts from the characters named)
      s.takes = takes.filter(function (t) { return t.shot_id === s.id; });
      s.takes.forEach(function (t) {
        t.moves = moves.filter(function (m) { return m.take_id === t.id; });
        t.stale = t.sig !== s.sig;
      });
    });
    const cs = chosenSig(ep.shots);
    const pool = castByVersion[ep.fork_id + ':' + ep.campaign_id] || { characters: [], assets: [] };
    ep.cast = pool.characters;   // v3.5.19: who can be sent as a reference; v3.5.22: with id and picture
    ep.assets = pool.assets;     // v3.5.22
    ep.archived = archivedBy[ep.id] || [];   // v3.5.20: the pictures of this episode already in the campaign's Archive
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
    return { key: k, label: m.label, group: m.group || 'keyframes', reference: !!m.reference, durations: m.durations, defDuration: m.defDuration, price: m.price, priceSound: m.priceSound, promptRequired: m.promptRequired };
  }).sort(function (a, b) { return (b.reference ? 1 : 0) - (a.reference ? 1 : 0); });   // v3.5.19: reference first
  const styles = VIDEO_STYLES.map(function (s) { return { key: s.key, label: s.label, description: s.description, speech: s.speech, defaultShot: s.defaultShot }; });
  vlDebug(req.session && req.session.userId, 'info', 'GET /api/video-lab/models', 'Models offered: ' + out.map(function (x) { return x.key; }).join(', '));   // v3.5.18
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
async function writeWords(tx, sid, w) {
  await tx.prepare('UPDATE shots SET start_text = ?, actions = ?, lines = ?, camera = ?, end_text = ?, sounds = ?, around = ?, seconds = ? WHERE id = ?')
    .run(w.start, JSON.stringify(w.actions), JSON.stringify(w.lines), w.camera, w.end, w.sounds, w.around, w.seconds, sid);
}
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
      if (s.name === undefined) await tx.prepare('UPDATE shots SET position = ?, cut_style = ? WHERE id = ?').run(pos, s.cut_style, sid);   // a save that sends no name (a page from before v3.5.15) keeps it
      else await tx.prepare('UPDATE shots SET position = ?, cut_style = ?, name = ? WHERE id = ?').run(pos, s.cut_style, s.name || null, sid);
      if (s.words) await writeWords(tx, sid, s.words);   // v3.5.19 (a save without words keeps them)
      if (s.refs) await tx.prepare('UPDATE shots SET refs = ? WHERE id = ?').run(JSON.stringify(s.refs), sid);   // v3.5.22
    } else {
      const r = await tx.prepare('INSERT INTO shots (episode_id, position, cut_style, name) VALUES (?, ?, ?, ?)').run(ep.id, pos, s.cut_style, s.name || null);
      sid = r.lastInsertRowid;
      if (s.words) await writeWords(tx, sid, s.words);
      if (s.refs) await tx.prepare('UPDATE shots SET refs = ? WHERE id = ?').run(JSON.stringify(s.refs), sid);
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

// v3.5.15 -- a shot's name: one line, at most 120 characters; empty is no name (the shot shows "Shot n").
function cleanShotName(v) { const t = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 120); return t || null; }
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
    out.push({ id: parseInt(s.id, 10) || null, refs: s.refs === undefined || s.refs === null ? undefined : cleanRefs(s.refs), words: s.actions === undefined ? undefined : cleanWords(s), name: s.name === undefined ? undefined : cleanShotName(s.name), cut_style: CUT_STYLES.indexOf(s.cut_style) >= 0 ? s.cut_style : 'instant', keyframes: kfs.slice(0, room) });
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
    vlDebug(req.session.userId, 'info', FN, 'Saved the episode' + (ep0.model !== model ? ' (model ' + ep0.model + ' -> ' + model + ')' : ''), { sent: vlSaveSummary(b), model_before: ep0.model, model_now: model, model_sent_known: b.model == null ? null : !!MODELS[b.model] });   // v3.5.18
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
        const w = s.words || {};
        return { name: s.name, cut_style: s.cut_style, refs: s.refs || undefined, start: w.start, actions: s.words_saved ? w.actions : undefined, lines: w.lines, camera: w.camera, end: w.end, sounds: w.sounds, around: w.around, seconds: w.seconds, keyframes: s.keyframes.map(function (k) { return { url: k.image_url, source: k.source, moment_id: k.moment_id, archive_id: k.archive_id, label: k.label, prompt: k.prompt, duration: k.duration, prev_url: k.prev_image_url }; }) };
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
// v3.5.16 -- a reference shot: one move, the keyframes and the cast named in the words as @Image references.
// cast: [{ name, url }] (the version's reference pictures). Returns { moves, model } or { error }.
function planReference(ep, kfs, shotNo, cast) {
  const m = MODELS[ep.model];
  if (!kfs.length) return { error: 'Shot ' + shotNo + ' has no keyframes.' };
  const n = kfs.length === 1 ? 1 : kfs.length - 1 + (hasAfter(kfs) ? 1 : 0);
  const steps = [];
  let secs = 0;
  for (let i = 0; i < n; i++) {
    const w = String(kfs[i].prompt || '').trim();
    secs += Number(kfs[i].duration || m.defDuration) || 0;
    if (w) steps.push(w);
  }
  const overall = String(ep.overall || '').trim();
  if (!steps.length && !overall) return { error: m.label + ' needs words for shot ' + shotNo + ', or an overall direction.' };
  secs = Math.max(REF_MIN_SECS, Math.min(REF_MAX_SECS, Math.round(secs)));
  const pics = kfs.slice(0, REF_MAX_KEYFRAMES).map(function (k) { return k.image_url; });
  const words = (overall + ' ' + steps.join(' ')).toLowerCase();
  const people = [];
  (cast || []).forEach(function (c) {
    if (people.length >= REF_MAX_IMAGES - pics.length || !c.url || !c.name) return;
    if (people.some(function (p) { return p.name === c.name || p.url === c.url; })) return;
    const first = String(c.name).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9'-]/g, '');
    if (first.length >= 2 && new RegExp('(^|[^a-z0-9])' + first.replace(/[-']/g, '\\$&') + '([^a-z0-9]|$)').test(words)) people.push({ name: String(c.name).trim(), url: c.url });
  });
  const lines = [];
  lines.push('One continuous shot, no cuts. Keep every character looking exactly the same from start to finish.');
  if (pics.length === 1) lines.push('@Image1 is how the shot opens: start the video looking like it, same place, same people, same art style.');
  else lines.push('@Image1 is how the shot opens: start the video looking like it. ' + pics.slice(1).map(function (u, i) { return '@Image' + (i + 2); }).join(', ') +
    (pics.length === 2 ? ' is a later moment' : ' are later moments, in order,') + ' of the same shot: pass through ' + (pics.length === 2 ? 'it' : 'them') + ' as the action reaches ' + (pics.length === 2 ? 'it' : 'them') + '. Keep the art style of these pictures.');
  people.forEach(function (p, i) { lines.push('@Image' + (pics.length + i + 1) + ' is ' + p.name + ': ' + p.name + '\'s face, hair, build, clothes and gear must match @Image' + (pics.length + i + 1) + ' whenever ' + p.name + ' is on screen.'); });
  if (overall) lines.push('Overall: ' + overall);
  lines.push('What happens, in order:');
  steps.forEach(function (w, i) { lines.push((i + 1) + '. ' + w); });
  const full = lines.join('\n').slice(0, 6000);
  const own = steps.join('\n\n');
  return { moves: [{ position: 1, start: kfs[0].image_url, end: null, own: own, full: full, duration: String(secs), images: pics.concat(people.map(function (p) { return p.url; })), cast: people.map(function (p) { return p.name; }) }], model: m };
}
// v3.5.19 -- THE SCRIPT a shot in plain words becomes (VIDEO_REFERENCE_SHOTS_SPEC section 3). pics: { cast: [{ name, n }],
// scene: [n...] } for a reference model (the @Image numbers), or null for a keyframe model (no picture lines).
// v3.5.25 -- A VOICE FROM OFF-SCREEN IS SAID TO BE ONE (takes 11-13: "(off-screen)" was ignored, and a line with no name
// drew a second Gubuk to say it). A line with no name is a voice from off-screen too: never "Someone says".
function lineOff(l) { return !!l.off || !String(l.who || '').trim(); }
// v3.5.25 (Ian's take that worked, ep 1 take 3): the line written as something the one on screen HEARS, "Gubuk hears Drel
// yelling in the distance". hearers: the characters on screen with no line of their own.
function sayLine(l, hearers) {
  const who = String(l.who || '').trim();
  if (!lineOff(l)) return who + ' says: "' + l.text + '"';
  const h = (hearers || []).filter(Boolean);
  const subj = h.length ? (h.length === 1 ? h[0] + ' hears ' : h.slice(0, -1).join(', ') + ' and ' + h[h.length - 1] + ' hear ') : 'we hear ';
  return who ? subj + who + ' calling from off-screen, in the distance: "' + l.text + '" (' + who + ' is not in this shot)' : subj + 'a voice calling from off-screen, in the distance: "' + l.text + '" (the speaker is not in this shot)';
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0].toLowerCase(); }
// Who is only a voice in this shot: an off-screen speaker with no line said on screen.
function voiceOnly(w) {
  const on = {}, off = {};
  w.lines.forEach(function (l) { const f = firstName(l.who); if (!f) return; if (lineOff(l)) off[f] = true; else on[f] = true; });
  return Object.keys(off).filter(function (f) { return !on[f]; });
}
// The rules that keep the voices off the faces we see: the characters on screen with no line of their own keep their
// mouths shut.
function voiceRules(w, onScreen) {
  if (!w.lines.some(function (l) { return lineOff(l) && String(l.text || '').trim(); })) return [];
  const talkers = {}, speakers = {};
  w.lines.forEach(function (l) { speakers[firstName(l.who)] = true; if (!lineOff(l)) talkers[firstName(l.who)] = true; });
  const out = [];
  (onScreen || []).forEach(function (n) { if (!speakers[firstName(n)]) out.push(n + ' does not speak; ' + n + '\'s mouth stays closed.'); });
  if (!Object.keys(talkers).length) out.push('No one on screen speaks.');
  return out;
}
function shotScript(ep, w, pics) {
  const out = [];
  out.push('One continuous shot, no cuts. Keep every character looking exactly the same from start to finish.');
  if (pics) {
    pics.cast.forEach(function (c) {
      if (c.kind === 'asset') out.push('@Image' + c.n + ' is ' + c.name + ': it must look like @Image' + c.n + ' whenever it is on screen.');   // v3.5.22
      else out.push('@Image' + c.n + ' is ' + c.name + ': ' + c.name + '\'s face, hair, build, clothes and gear must match @Image' + c.n + ' whenever ' + c.name + ' is on screen.');
    });
    if (pics.cast.length) out.push('If a scene picture shows a character or thing differently, follow its own picture.');
    if (pics.scene.length) out.push('@Image' + pics.scene[0] + ' is how the shot opens: start the video looking like it, in its art style.');
    if (pics.scene.length > 1) out.push(pics.scene.slice(1).map(function (n) { return '@Image' + n; }).join(', ') + (pics.scene.length === 2 ? ' shows' : ' show') +
      ' the place, the light and who is there. Do not copy poses, positions or which way anyone faces from ' + (pics.scene.length === 2 ? 'it' : 'them') + '.');
  }
  const overall = String(ep.overall || '').trim();
  if (overall) out.push('Overall: ' + overall);
  if (w.start) out.push('Start: ' + w.start);
  const loose = w.lines.filter(function (l) { return !l.when; });
  const spk = {}; w.lines.forEach(function (l) { spk[firstName(l.who)] = true; });
  const hearers = pics ? pics.cast.filter(function (c) { return c.kind !== 'asset' && !spk[firstName(c.name)]; }).map(function (c) { return c.name; }) : [];   // v3.5.25
  if (w.actions.length || loose.length) {
    out.push('What happens, in order:');
    w.actions.forEach(function (a, i) {
      const said = w.lines.filter(function (l) { return l.when === i + 1; }).map(function (l) { return 'As this happens, ' + sayLine(l, hearers) + '.'; });
      out.push((i + 1) + '. ' + a + (said.length ? ' ' + said.join(' ') : ''));
    });
    loose.forEach(function (l) { const t = sayLine(l, hearers); out.push(w.actions.length ? 'Then, ' + t + '.' : t.charAt(0).toUpperCase() + t.slice(1) + '.'); });
  }
  voiceRules(w, pics ? pics.cast.filter(function (c) { return c.kind !== 'asset'; }).map(function (c) { return c.name; }) : []).forEach(function (r) { out.push(r); });   // v3.5.25
  if (w.camera) out.push('Camera: ' + w.camera);
  if (w.end) out.push('End: ' + w.end);
  if (w.sounds) out.push('Sound: ' + w.sounds);
  if (w.around) out.push('Around them: ' + w.around);
  return out.join('\n').slice(0, 6000);
}
function wordsHaveContent(ep, w) { return !!(String(ep.overall || '').trim() || w.start || w.actions.length || w.lines.length || w.camera || w.end); }
// v3.5.25 -- for naming the cast: what a line SAYS names no one in the shot ("Where is Emanon?"), and only the speakers
// seen on screen count.
function wordsText(ep, w) { return [ep.overall, w.start, w.actions.join(' '), w.camera, w.end, w.sounds, w.around].concat(w.lines.filter(function (l) { return !lineOff(l); }).map(function (l) { return l.who; })).join(' '); }
// The characters a shot's words name, less those who are only a voice in it (v3.5.25: they are not in the shot, so their
// pictures are not sent).
// A voice is still in the shot when the words have them DO something there (a sentence that is not about a voice).
function namedInShot(ep, w, chars, room) {
  const vo = voiceOnly(w);
  const seen = wordsText(ep, w).split(/(?<=[.!?])\s+/).filter(function (x) { return !/voice|off[- ]screen/i.test(x); }).join(' ');
  return namedCast(wordsText(ep, w), (chars || []).filter(function (c) { return vo.indexOf(firstName(c.name)) < 0 || namedCast(seen, [c], 1).length; }), room);
}
function namedCast(text, cast, room) {
  const words = String(text || '').toLowerCase(), people = [];
  (cast || []).forEach(function (c) {
    if (people.length >= room || !c.url || !c.name) return;
    if (people.some(function (p) { return p.name === c.name || p.url === c.url; })) return;
    const first = String(c.name).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9'-]/g, '');
    if (first.length >= 2 && new RegExp('(^|[^a-z0-9])' + first.replace(/[-']/g, '\\$&') + '([^a-z0-9]|$)').test(words)) people.push({ name: String(c.name).trim(), url: c.url });
  });
  return people;
}
// A reference shot in plain words: one move; the cast named first (they win), then up to 5 scene pictures.
function planReferenceWords(ep, kfs, w, shotNo, pool, refs) {
  const m = MODELS[ep.model];
  if (!kfs.length) return { error: 'Shot ' + shotNo + ' has no pictures.' };
  if (!wordsHaveContent(ep, w)) return { error: 'Shot ' + shotNo + ' needs words: say what the characters do, or how the shot starts.' };
  const scenePics = kfs.slice(0, REF_MAX_KEYFRAMES).map(function (k) { return k.image_url; });
  const people = refsToSend(ep, w, refs, pool, REF_MAX_IMAGES - scenePics.length);   // v3.5.22: the shot's references
  const pics = { cast: people.map(function (p, i) { return { name: p.name, n: i + 1, kind: p.kind }; }), scene: scenePics.map(function (u, i) { return people.length + i + 1; }) };
  return { moves: [{ position: 1, start: kfs[0].image_url, end: null, own: w.actions.join('\n'), full: shotScript(ep, w, pics), duration: String(w.seconds),
    images: people.map(function (p) { return p.url; }).concat(scenePics), cast: people.map(function (p) { return p.name; }) }], model: m };
}
// A keyframe-model shot in plain words: the same script (no picture lines) for every move; the length shared out.
function planMovesWords(ep, kfs, w, shotNo) {
  const m = MODELS[ep.model];
  if (!m) return { error: 'Pick a video model.' };
  if (!kfs.length) return { error: 'Shot ' + shotNo + ' has no pictures.' };
  if (m.promptRequired && !wordsHaveContent(ep, w)) return { error: m.label + ' needs words for shot ' + shotNo + '.' };
  const full = shotScript(ep, w, null), n = kfs.length === 1 ? 1 : kfs.length - 1;
  const d = snapDuration(m, w.seconds / n) || m.defDuration;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ position: i + 1, start: kfs[i].image_url, end: kfs.length === 1 ? null : kfs[i + 1].image_url, own: w.actions.join('\n'), full: full, duration: String(d) });
  return { moves: out, model: m };
}
function planShot(ep, kfs, shot, shotNo, pool) {
  const m = MODELS[ep.model], w = shotWords(shot);
  pool = pool || { characters: [], assets: [] };
  if (w) return m && m.reference ? planReferenceWords(ep, kfs, w, shotNo, pool, shotRefs(shot)) : planMovesWords(ep, kfs, w, shotNo);
  return m && m.reference ? planReference(ep, kfs, shotNo, pool.characters.filter(function (c) { return c.usable; })) : planMoves(ep, kfs, shotNo);   // never saved in plain words (before v3.5.19)
}
function shotRefs(shot) { const r = parseJson(shot && shot.refs, null); return Array.isArray(r) ? cleanRefs(r) : null; }
// The version's cast with their reference pictures (the version's own, else the character's).
async function castRefs(db, ep, detail) {
  let rows = [];
  try {
    rows = await db.prepare('SELECT ch.id, ch.name, COALESCE(sc.reference_url, ch.canonical_reference_url) AS url FROM characters ch LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? WHERE ch.campaign_id = ? ORDER BY ch.is_npc ASC, ch.id ASC').all(ep.fork_id, ep.campaign_id);
  } catch (e) {
    console.error('[video] cast references could not be read: ' + (e && e.message));
    rows = [];
    if (detail) return { usable: [], all: [{ error: 'could not read the cast: ' + (e && e.message) }] };
  }
  const usable = rows.filter(function (c) { return c.url && storage.isOurPublicUrl(c.url); });
  if (!detail) return usable;
  // v3.5.18 -- for debug mode: every character, and why one is not usable
  return { usable: usable, all: rows.map(function (c) { return { id: c.id, name: c.name, url: c.url && storage.isOurPublicUrl(c.url) ? c.url : null, picture: c.url ? vlShortUrl(c.url) : null, usable: !!(c.url && storage.isOurPublicUrl(c.url)), why_not: !c.url ? 'no reference picture' : (!storage.isOurPublicUrl(c.url) ? 'not a Campaignia picture' : undefined) }; }) };
}
// v3.5.22 -- THE REFERENCES A SHOT CAN SEND (Ian, 2026-11-08: "add the ability to add character and asset references... and
// see the references that are already on that shot... just like we do on the Review tab, Storyboard and Image builder").
// The version's characters (their version picture, else their own) and the campaign's assets; an asset whose picture was
// refused by the rights check, or that is not a Campaignia picture, cannot be sent.
async function refsPool(db, ep) {
  const cast = await castRefs(db, ep, true);
  let assets = [];
  try {
    assets = (await db.prepare("SELECT a.id, a.name, CASE WHEN r.id IS NULL THEN a.image_url ELSE NULL END AS url FROM campaign_assets a LEFT JOIN image_rights r ON r.image_url = a.image_url AND r.verdict = 'reject' WHERE a.campaign_id = ? ORDER BY LOWER(a.name)").all(ep.campaign_id))
      .map(function (a) { const ok = !!(a.url && storage.isOurPublicUrl(a.url)); return { id: a.id, name: a.name, url: ok ? a.url : null, usable: ok, why_not: ok ? null : (a.url ? 'not a Campaignia picture' : 'no usable picture') }; });
  } catch (e) { console.error('[video] assets could not be read: ' + (e && e.message)); }
  return { characters: cast.all.filter(function (c) { return c.name && c.id; }).map(function (c) { return { id: c.id, name: c.name, url: c.url || null, usable: !!c.usable, why_not: c.why_not || null }; }), assets: assets };
}
function cleanRefs(v) {
  if (!Array.isArray(v)) return [];
  const seen = {}, out = [];
  v.forEach(function (r) {
    const type = r && (r.type === 'asset' ? 'asset' : r.type === 'character' ? 'character' : null), id = r && parseInt(r.id, 10);
    if (!type || !id || seen[type + id] || out.length >= 12) return;
    seen[type + id] = true; out.push({ type: type, id: id });
  });
  return out;
}
// The pictures a shot's references send: the chosen ones (in their order), or, for a shot never given references, the
// characters named in its words.
function refsToSend(ep, w, refs, pool, room) {
  pool = pool || { characters: [], assets: [] };
  if (Array.isArray(refs)) {
    const out = [];
    refs.forEach(function (r) {
      if (out.length >= room) return;
      const it = (r.type === 'asset' ? pool.assets : pool.characters).filter(function (x) { return Number(x.id) === Number(r.id); })[0];
      if (it && it.usable && it.url && !out.some(function (o) { return o.url === it.url; })) out.push({ name: String(it.name).trim(), url: it.url, kind: r.type });
    });
    return out;
  }
  return namedInShot(ep, w, pool.characters.filter(function (c) { return c.usable; }), room).map(function (p) { return { name: p.name, url: p.url, kind: 'character' }; });
}
// What one move sends to fal: each model names its pictures and its length its own way.
function buildInput(m, prompt, startUrl, endUrl, duration, sound, images) {
  const input = Object.assign({}, m.extra);
  if (prompt) input.prompt = prompt;
  let endpoint = m.endpoint;
  if (m.reference) input.image_urls = (images && images.length ? images : [startUrl]).slice(0, REF_MAX_IMAGES);   // v3.5.16
  else if (endUrl) { input[m.start] = startUrl; input[m.end] = endUrl; }
  else if (m.single) { endpoint = m.single.endpoint; input[m.single.start] = startUrl; }
  else input[m.start] = startUrl;
  input.duration = m.durationValue(duration);
  input.generate_audio = !!sound;
  return { endpoint: endpoint, input: input };
}

// Make one shot: a new take (it becomes the chosen one), its moves sent to fal side by side. One take of a shot is made
// at a time (a partial unique index is the claim). Returns { take } or { status, error }.
async function takesFull(db, shotId) {
  const c = await db.prepare('SELECT COUNT(*) AS n FROM takes WHERE shot_id = ?').get(shotId);
  return Number(c && c.n) >= MAX_TAKES;
}
async function makeShot(db, req, ep, shot, shotNo) {
  const m = MODELS[ep.model];
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shot.id);
  const cast = m && m.reference ? await castRefs(db, ep, true) : null;
  const pool = m && m.reference ? await refsPool(db, ep) : null;   // v3.5.22
  const plan = planShot(ep, kfs, shot, shotNo, pool);   // v3.5.16; v3.5.19: in plain words; v3.5.22: the shot's references
  // v3.5.18 -- what a Generate is about to send, for debug mode (Ian: "Put what you need to see in debug mode").
  vlDebug(req.session && req.session.userId, plan.error ? 'warn' : 'info', 'makeShot', 'Shot ' + shotNo + ' (shot ' + shot.id + ', episode ' + ep.id + '): model ' + ep.model + ' = ' +
    (m ? (m.reference ? 'REFERENCE mode' : 'KEYFRAME mode') : 'unknown model') + (plan.error ? '; refused: ' + plan.error : '; ' + plan.moves.length + ' move(s)'), {
    model: ep.model, reference: !!(m && m.reference), keyframes: kfs.length, refs_chosen: shotRefs(shot),
    cast_in_version: cast ? cast.all : undefined,
    moves: plan.error ? undefined : plan.moves.map(function (x) {
      return { position: x.position, duration: x.duration, start: vlShortUrl(x.start), end: x.end ? vlShortUrl(x.end) : null,
        images: x.images ? x.images.map(vlShortUrl) : undefined, cast_sent: x.cast || undefined, prompt: String(x.full || '').slice(0, 3000) };
    })
  });
  if (plan.error) return { status: 400, error: plan.error };
  if (await takesFull(db, shot.id)) return { status: 409, full: true, error: 'Shot ' + shotNo + ' already has ' + MAX_TAKES + ' takes. Delete one to make another.' };
  const hook = webhookUrl();
  if (!hook) return { status: 500, error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' };
  const sound = !!ep.sound;
  const cost = Math.round(plan.moves.reduce(function (t, x) { return t + estCost(m, x.duration, sound); }, 0) * 10000) / 10000;
  const directions = JSON.stringify({ overall: ep.overall || '', style: ep.style, moves: plan.moves.map(function (x) { return { own: x.own, duration: x.duration, images: x.images || undefined, cast: x.cast || undefined }; }) });
  const ins = await db.prepare("INSERT INTO takes (episode_id, shot_id, user_id, status, model, sound, sig, directions, est_cost_usd) VALUES (?, ?, ?, 'making', ?, ?, ?, ?, ?) ON CONFLICT (shot_id) WHERE status = 'making' DO NOTHING")
    .run(ep.id, shot.id, req.session.userId, ep.model, sound, shotSig(ep, kfs, shot), directions, cost);
  if (!ins.lastInsertRowid) return { status: 409, error: 'Shot ' + shotNo + ' is already being made.' };
  const takeId = ins.lastInsertRowid;
  await db.prepare('UPDATE shots SET chosen_take_id = ? WHERE id = ?').run(takeId, shot.id);
  const rows = [];
  for (const x of plan.moves) {
    const bi = buildInput(m, x.full, x.start, x.end, x.duration, sound, x.images);
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
    const full = {};   // v3.5.15: shots that already have MAX_TAKES takes are skipped, and named
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].chosen_status === 'done' || shots[i].chosen_status === 'making') continue;
      if (await takesFull(db, shots[i].id)) { full[i] = true; continue; }
      const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shots[i].id);
      const p = planShot(ep, kfs, shots[i], i + 1, null);   // v3.5.16; v3.5.19
      if (p.error) return res.status(400).json({ error: p.error });
    }
    const errors = [];
    let made = 0;
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].chosen_status === 'done' || shots[i].chosen_status === 'making' || full[i]) continue;
      const r = await makeShot(db, req, ep, shots[i], i + 1);
      if (r.full) full[i] = true;
      if (r.error) errors.push(r.error); else made++;
    }
    const skipped = Object.keys(full).map(function (i) { return Number(i) + 1; }).sort(function (a, b) { return a - b; });
    const out = await loadEpisode(db, ep.id);
    const fullText = skipped.length ? (skipped.length === 1 ? 'Shot ' + skipped[0] + ' already has ' : 'Shots ' + skipped.join(', ') + ' already have ') + MAX_TAKES + ' takes, so ' + (skipped.length === 1 ? 'it was' : 'they were') + ' skipped. Delete a take to make another.' : '';
    const other = errors.filter(function (x) { return !/already ha(s|ve) \d+ takes/.test(x); });
    if (!made && other.length) return res.status(400).json({ error: other[0], episode: out, skipped: skipped });
    if (!made && skipped.length) return res.status(409).json({ error: fullText, episode: out, skipped: skipped });
    if (!made) return res.status(409).json({ error: 'Every shot already has a take.', episode: out });
    res.json({ episode: out, made: made, errors: other, skipped: skipped, note: fullText || null });
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
    // v3.5.14 -- Expand: the same retouch, with our own words, drawn wide (16:9) whatever shape the picture was.
    const expand = !!b.expand;
    // v3.5.24 -- the shot's own references go with the retouch (Ian, 2026-11-08: "The references in that shot should show
    // in the Retouch modal to use"; "only the Shots References"). The page sends the shot's list; it is checked here.
    let refs = null;
    if (!expand && Array.isArray(b.refs)) {
      const pool = await refsPool(db, ep);
      refs = refsToSend(ep, null, cleanRefs(b.refs), pool, 12).map(function (r) { return { name: r.name, url: r.url, isAsset: r.kind === 'asset' }; });
    }
    const out = await require('./images').startKeyframeRetouch(db, { refs: refs, userId: req.session.userId, campaignId: ep.campaign_id, episodeId: ep.id, imageUrl: url,
      momentId: kf.moment_id || null, shape: shape, style: style, forceShape: expand ? 'wide' : null,
      instruction: expand ? EXPAND_INSTRUCTION : b.instruction, markedUrl: expand ? null : b.marked_url, refName: expand ? null : b.ref_name });
    if (out.error) return res.status(out.error === 'INSUFFICIENT_TOKENS' ? 402 : 400).json(out);
    vlDebug(req.session.userId, 'info', FN, 'Keyframe retouch started (job ' + out.job_id + ')', { url: vlShortUrl(url), moment_id: kf.moment_id, archive_id: kf.archive_id, art_style: style, shot_refs: refs ? refs.map(function (r) { return r.name; }) : null });
    res.json({ job_id: out.job_id });
  } catch (e) {
    console.error('[video] keyframe retouch error:', e && e.message);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Could not start: ' + (e && e.message), { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the retouch.' });
  }
});

// v3.5.24 -- FLIP A KEYFRAME (Ian, 2026-11-08). The episode's copy of the picture is mirrored left to right (free, no
// AI); every keyframe of the episode showing it takes the flipped one, with the old one in its Revert slot, as a retouch
// lands. The book, the storyboard and the Archive are not touched.
router.post('/episodes/:id/keyframe-flip', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/keyframe-flip';
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!(await canChange(req, ep))) return vlRefuse(req, res, FN, 404, 'Not found.');
    const url = String((req.body && req.body.image_url) || '');
    const kf = await db.prepare('SELECT id FROM keyframes WHERE episode_id = ? AND image_url = ? LIMIT 1').get(ep.id, url);
    if (!kf) return vlRefuse(req, res, FN, 409, 'That keyframe has changed; try again in a moment.', { url: vlShortUrl(url) });
    const busy = await db.prepare("SELECT id FROM image_jobs WHERE kind = 'keyframe' AND episode_id = ? AND prev_image = ? AND status IN ('queued', 'processing') AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1").get(ep.id, url);
    if (busy) return vlRefuse(req, res, FN, 409, 'That keyframe is being retouched; flip it when the retouch is done.');
    try {
      if (await require('../services/rightsCheck').refuseRejected(res, [url], 'It can\u2019t be flipped. Replace it with a picture you have the rights to.')) return;
    } catch (e) { console.error('[video] rights check failed:', e && e.message); }
    let m;
    try { m = await require('./images').mirrorPicture(url); }
    catch (e) { return vlRefuse(req, res, FN, 400, e && e.userFacing ? e.message : 'Could not flip the picture. Please try again.', { error: e && e.message }); }
    const r = await db.prepare('UPDATE keyframes SET image_url = ?, prev_image_url = ? WHERE episode_id = ? AND image_url = ?').run(m.url, url, ep.id, url);
    vlDebug(req.session.userId, 'info', FN, 'Keyframe flipped (' + r.changes + ' keyframe(s) show it)', { from: vlShortUrl(url), to: vlShortUrl(m.url) });
    res.json({ success: true, image_url: m.url });
  } catch (e) {
    console.error('[video] keyframe flip error:', e && e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not flip the picture.' });
  }
});

// v3.5.26 -- RETOUCH A TAKE (TD-1112; Ian, 2026-11-08: "we are going to need a retouch for sure so build it"; spec
// claude/VIDEO_TAKE_RETOUCH_SPEC.md). A finished take is sent with the change asked for and, if chosen, some of the shot's
// references; what comes back is a NEW take ("retouched from take n") so the original stays. Two sizes:
//   small: Kling O1 Edit (Standard): keeps the motion and the sound exactly; clips of 3 to 10 s; up to 4 references.
//   big:   Seedance 2.0 reference-to-video with the take as @Video1: redraws the clip, sound included; up to 15 s.
// Made as a one-move take through the same fal queue, webhook and sweep as every take.
const RETOUCH = {
  small: { label: 'Small fix', endpoint: 'fal-ai/kling-video/o1/standard/video-to-video/edit', minSecs: 3, maxSecs: 10.05, maxRefs: 4 },
  big: { label: 'Bigger change', endpoint: 'bytedance/seedance-2.0/reference-to-video', minSecs: 2, maxSecs: 15, maxRefs: 8 }
};
const RETOUCH_DURATIONS = [4, 5, 6, 8, 10, 12, 15];
function retouchCost(kind, secs) {
  if (kind === 'small') return Math.round(0.126 * secs * 10000) / 10000;   // fal: $0.126 per second
  // fal: (h x w x (input + output seconds) x 24 / 1024) tokens at $0.0086016 per 1,000 with a video input (720p wide)
  return Math.round((1280 * 720 * (secs * 2) * 24 / 1024) / 1000 * 0.0086016 * 10000) / 10000;
}
function takeSecs(moves) { return Math.round((moves || []).reduce(function (t, m) { return t + (parseFloat(m.duration) || 0); }, 0) * 100) / 100; }
function retouchPrompt(kind, text, refs, sound) {
  const out = [];
  if (kind === 'small') {
    out.push('Edit this video. Change only this: ' + text);
    out.push('Keep everything else exactly as it is: the same motion, timing, framing, camera, characters, place and light.');
    refs.forEach(function (r, i) { out.push('@Image' + (i + 1) + ' is ' + r.name + ': ' + r.name + ' must look like @Image' + (i + 1) + '.'); });
  } else {
    out.push('Recreate @Video1 exactly, shot for shot: the same motion, timing, framing, camera, characters, place and light. Change only this: ' + text);
    refs.forEach(function (r, i) {
      const n = '@Image' + (i + 1);
      out.push(r.kind === 'asset' ? n + ' is ' + r.name + ': it must look like ' + n + ' whenever it is on screen.' : n + ' is ' + r.name + ': ' + r.name + '\'s face, hair, build, clothes and gear must match ' + n + ' whenever ' + r.name + ' is on screen.');
    });
    if (sound) out.push('Keep the same voices, words and sounds as @Video1; no one speaks who does not speak in @Video1.');
  }
  return out.join('\n');
}
router.post('/takes/:id/retouch', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/takes/' + req.params.id + '/retouch';
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canChange(req, x.ep))) return vlRefuse(req, res, FN, 404, 'Not found.');
    const b = req.body || {};
    const kind = b.size === 'big' ? 'big' : b.size === 'small' ? 'small' : null;
    const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!kind) return vlRefuse(req, res, FN, 400, 'Choose Small fix or Bigger change.');
    if (!text) return vlRefuse(req, res, FN, 400, 'Say what to change.');
    if (x.t.status !== 'done' || !x.t.video_url) return vlRefuse(req, res, FN, 409, 'Only a finished take can be retouched.');
    if (await runningWriter(db, x.ep.id)) return vlRefuse(req, res, FN, 409, 'The Director is working on this episode; retouch the take when it is done.');
    const shot = await db.prepare('SELECT * FROM shots WHERE id = ?').get(x.t.shot_id);
    if (await takesFull(db, shot.id)) return vlRefuse(req, res, FN, 409, 'This shot already has ' + MAX_TAKES + ' takes. Delete one to make another.');
    const mvs = await db.prepare('SELECT duration FROM moves WHERE take_id = ?').all(x.t.id);
    const secs = takeSecs(mvs);
    const R = RETOUCH[kind];
    if (secs < R.minSecs || secs > R.maxSecs) return vlRefuse(req, res, FN, 400, kind === 'small'
      ? 'A Small fix works on takes of 3 to 10 seconds; this one is ' + secs + ' s. Use Bigger change.'
      : 'This take is ' + secs + ' s; a retouch works on takes of up to 15 seconds.');
    const hook = webhookUrl();
    if (!hook) return vlRefuse(req, res, FN, 500, 'PUBLIC_BASE_URL is not set, so fal cannot report back.');
    // the references: those asked for, checked against the version's cast and assets (rights, our storage)
    const pool = await refsPool(db, x.ep);
    const refs = Array.isArray(b.refs) ? refsToSend(x.ep, null, cleanRefs(b.refs), pool, R.maxRefs) : [];
    const sound = !!x.t.sound;
    const prompt = retouchPrompt(kind, text, refs, sound);
    let input;
    let duration = String(secs);
    if (kind === 'small') {
      input = { prompt: prompt, video_url: x.t.video_url, keep_audio: true };
      if (refs.length) input.image_urls = refs.map(function (r) { return r.url; });
    } else {
      const d = RETOUCH_DURATIONS.reduce(function (best, v) { return Math.abs(v - secs) < Math.abs(best - secs) ? v : best; }, RETOUCH_DURATIONS[0]);
      duration = String(d);
      input = { prompt: prompt, video_urls: [x.t.video_url], resolution: '720p', aspect_ratio: VIDEO_ASPECT, duration: duration, generate_audio: sound };
      if (refs.length) input.image_urls = refs.map(function (r) { return r.url; });
    }
    const cost = retouchCost(kind, secs);
    const directions = JSON.stringify({ retouch: { from: x.t.id, kind: kind, text: text, refs: refs.map(function (r) { return r.name; }) } });
    const ins = await db.prepare("INSERT INTO takes (episode_id, shot_id, user_id, status, model, sound, sig, directions, est_cost_usd, source_take_id, retouch_text, retouch_kind) VALUES (?, ?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (shot_id) WHERE status = 'making' DO NOTHING")
      .run(x.ep.id, shot.id, req.session.userId, x.t.model, sound, x.t.sig, directions, cost, x.t.id, text, kind);
    if (!ins.lastInsertRowid) return vlRefuse(req, res, FN, 409, 'A take of this shot is already being made.');
    const takeId = ins.lastInsertRowid;
    const mv = await db.prepare('INSERT INTO moves (take_id, episode_id, position, start_url, end_url, prompt, model, endpoint, duration, sound, status, est_cost_usd) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?)')
      .run(takeId, x.ep.id, x.t.video_url, prompt, 'retouch-' + kind, R.endpoint, duration, sound, 'queued', cost);
    vlDebug(req.session.userId, 'info', FN, 'Retouch of take ' + x.t.id + ' (' + R.label + ', ' + R.endpoint + ') as take ' + takeId, { kind: kind, seconds: secs, est_cost_usd: cost,
      video: vlShortUrl(x.t.video_url), refs: refs.map(function (r) { return { name: r.name, kind: r.kind, url: vlShortUrl(r.url) }; }), input: Object.assign({}, input, { prompt: undefined }), prompt: prompt });
    try {
      const sub = await falClient().queue.submit(R.endpoint, { input: input, webhookUrl: hook });
      await db.prepare("UPDATE moves SET request_id = ?, status = 'running', submitted_at = NOW(), updated_at = NOW() WHERE id = ?").run(sub.request_id, mv.lastInsertRowid);
    } catch (e) {
      await db.prepare("UPDATE moves SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?").run(('fal refused it: ' + falErrorText(e)).slice(0, 1000), mv.lastInsertRowid);
    }
    await takeStatus(db, takeId);
    res.json({ episode: await loadEpisode(db, x.ep.id), take: takeId });
  } catch (e) {
    console.error('[video] retouch take error:', falErrorText(e));
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the retouch: ' + falErrorText(e) });
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
function pictureSig(pictures) { return shortSig(JSON.stringify(pictures.map(function (p) { return p.url; }))); }
// v3.5.23 -- the cuts as they stand: which pictures each shot holds. Director's Notes writes for these cuts and only these.
function cutSig(shots) { return shortSig(JSON.stringify(shots.map(function (s) { return [s.id, s.keyframes.map(function (k) { return k.image_url; })]; }))); }
function withMode(ctx, mode) { const c = Object.assign({}, ctx); c.mode = mode === 'shots' ? 'shots' : 'notes'; c.sig = c.mode === 'shots' ? pictureSig(c.pictures) : cutSig(c.shots); return c; }
const SL_MAX_PER_SHOT = 5;   // v3.5.20: a reference shot sends 5 pictures at most

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
  return { ep: ep, m: m, modelKey: ep.model, style: style, story: story, cast: cast, artStyle: artStyle, genres: genres, shots: live, sig: pictureSig(pictures),   // v3.5.20: the pictures in order (the writer re-cuts)
    sessionName: session ? String(session.name || '') : '', campaignName: campaign ? String(campaign.name || '') : '', pictures: pictures };
}
function estimateShotList(ctx, prices) {
  const n = ctx.pictures.length;
  const moves = n;   // v3.5.20: the writer plans the shots; its answer grows with the pictures
  const words = ctx.pictures.reduce(function (t, p) { return t + p.words.length; }, 0);
  const castChars = ctx.cast.reduce(function (t, c) { return t + String(c.name || '').length + String(c.description || '').length + Math.min(800, String(c.prompt || '').length); }, 0);
  const inTok = Math.ceil((4500 + ctx.story.text.length + words + castChars) / 4) + Math.min(n, SL_MAX_IMAGES) * 360;
  const outTok = ctx.mode === 'shots' ? 200 + n * 40 : 400 + n * 260;   // v3.5.23: Create Shots answers with the cuts only
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
// v3.5.20 -- THE WRITER PLANS THE CUTS AND FILLS EVERY BOX (VIDEO_REFERENCE_SHOTS_SPEC section 7). Ian, 2026-11-08:
// "have it do the cuts then put the prompts in"; "the Rewrite shot list should basically start over and clear what's
// there". It is given every picture of the episode in order, decides which run of pictures makes each shot, and writes
// each shot's plain-word boxes.
// v3.5.23 -- THE DIRECTOR, IN TWO STEPS (Ian, 2026-11-08: "two separate buttons... Then the user can do the cuts or the
// AI can... Then the AI can do the Shot list knowing what the cuts are"; "lets start the concept of our AI Director...
// like our AI Editor on books"). ctx.mode 'shots' (Create Shots): the Director divides the pictures into shots and names
// them, no words. ctx.mode 'notes' (Director's Notes): the Director writes every box of the shots as they stand.
function directorHead(ctx) {
  return 'You are the Director of a short video made from the illustrations of a story, for the video model ' + ctx.m.label + (ctx.m.reference ? ' (reference mode)' : '') + '.\n\n' +
    'SHOTS AND CUTS\nThe video is a series of SHOTS joined by CUTS. A shot is one continuous camera run in one place: the camera never cuts away inside it.\n\n';
}
function shotListRequest(ctx, images) {
  const m = ctx.m, style = ctx.style, N = ctx.pictures.length, ref = !!m.reference;
  let system;
  if (ctx.mode === 'shots') {
    system = directorHead(ctx) +
      'YOUR JOB NOW: divide the episode\'s ' + N + ' pictures, in story order, into shots. Every picture is used exactly once, none skipped, none moved; each shot is a run of 1 to ' + SL_MAX_PER_SHOT + ' consecutive pictures. ' +
      'Cut where the place changes, where time jumps, or where someone must leave the frame and come back later. Keep pictures together when they are one continuous moment in one place. A single picture can be a shot (a reaction, a line, an establishing view). ' +
      'Give each shot a name of 2 to 5 words. Do not write anything else: what happens in each shot is written later.\n\n' +
      'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
      'ANSWER WITH ONLY THIS JSON, no other text:\n{"shots": [{"pictures": [1, 2], "name": "..."}, {"pictures": [3], "name": "..."}]}\n' +
      '"pictures" lists the picture numbers of the shot. Across all shots they must be exactly 1 to ' + N + ', in order.';
  } else {
    system = directorHead(ctx) +
      'YOUR JOB NOW: the episode is already divided into ' + ctx.shots.length + ' shots, shown below. Keep them exactly as they are and write the Director\'s Notes for each one.\n\n' +
      (ref ? 'HOW THE MODEL USES THE PICTURES\nEach shot is ONE clip. Its first picture is how the shot opens; its later pictures only show the place, the light and who is there: the model does NOT copy their poses or positions, so say in the words what happens and how the shot ends. ' +
        'The cast\'s own reference pictures are sent too, so describe what characters DO, not how they look.\n\n'
        : 'HOW THE MODEL USES THE PICTURES\nA shot of several pictures moves from each picture exactly to the next, so the action must flow through every picture of the shot.\n\n') +
      'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
      'FOR EACH SHOT write these, in plain words:\n' +
      '- name: 2 to 5 words naming the shot.\n' +
      '- start: who is where when the shot opens, and which way they face, and anything lying around that must stay in the shot (bodies, fallen weapons, props) as the shot\'s pictures show it: later pictures do not carry them (one to three sentences).\n' +
      '- actions: what the characters do, in order, one action per item, at most one action for every 2.5 seconds of the shot. Put every movement here: entering, leaving, picking up, turning.\n' +
      (style.speech ? '- lines: what they say: {"who": exact cast name, "line": short, "during": the number of the action it is said during (1 = the first), or 0 for any time, "offscreen": true when the speaker is not in view; always name the speaker}. At most two short lines in a shot; an empty list when nobody should talk.\n'
        : '- lines: always an empty list in this style.\n') +
      '- camera: what the camera does. If someone leaves the frame and is needed again, or the camera has to find someone, say how the camera moves to show it.\n' +
      '- end: who is where when the shot ends, and which way they face.\n' +
      '- sounds: sounds only, never actions.\n' +
      '- around: what the surroundings do (smoke, fire, weather, light), never the characters.\n' +
      '- seconds: the shot\'s length, a whole number from 4 to 15.\n\n' +
      'THE OVERALL DIRECTION is sent with every shot: one short paragraph (at most 600 characters) naming the setting, the mood and the light' + (ref ? '' : ', and each main character\'s look in words (build, hair, clothes, colours)') + '. Keep the art style as it is in the pictures.\n\n' +
      'RULES\n- Keep the names exactly as the story and the cast list write them.\n- Each action is at most 300 characters; every other field short.\n- Never describe a cut inside a shot; never move a picture to another shot.\n' +
      '- Write original words; never reproduce text from any published source.\n- Never put words, captions or titles on screen.\n\n' +
      'ANSWER WITH ONLY THIS JSON, no other text, one entry per shot in order:\n' +
      '{"overall": "...", "shots": [{"shot": 1, "name": "...", "start": "...", "actions": ["...", "..."], "lines": [{"who": "...", "line": "...", "during": 1, "offscreen": false}], "camera": "...", "end": "...", "sounds": "...", "around": "...", "seconds": 10}]}';
  }
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
  head.push('THE PICTURES OF THIS EPISODE, IN STORY ORDER (' + N + ')' + (ctx.mode === 'shots' ? '' : ', SHOT BY SHOT') + '.' +
    (sent < N ? (sent ? ' Only ' + sent + ' are shown as pictures; the others are described in words only.' : ' They are described in words only.') : ''));
  content.push({ type: 'text', text: head.join('\n') });
  let shotOf = null;
  if (ctx.mode !== 'shots') { shotOf = []; let n = 0; ctx.shots.forEach(function (sh, si) { sh.keyframes.forEach(function () { shotOf[n++] = si; }); }); }
  ctx.pictures.forEach(function (p, i) {
    if (shotOf && (i === 0 || shotOf[i] !== shotOf[i - 1])) {
      const sh = ctx.shots[shotOf[i]], first = i + 1, last = i + sh.keyframes.length;
      content.push({ type: 'text', text: (i ? '--- CUT ---\n' : '') + 'SHOT ' + (shotOf[i] + 1) + (sh.name ? ' ("' + sh.name + '")' : '') + ': picture' + (first === last ? ' ' + first : 's ' + first + ' to ' + last) + '.' });
    }
    content.push({ type: 'text', text: 'Picture ' + (i + 1) + '. ' + p.words });
    if (images[i]) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[i] } });
  });
  content.push({ type: 'text', text: ctx.mode === 'shots' ? 'Now divide these ' + N + ' pictures into shots, as JSON.'
    : 'Now write the Director\'s Notes for these ' + ctx.shots.length + ' shots, as JSON, in the ' + style.label + ' style.' });
  return { system: system, content: content, max_tokens: ctx.mode === 'shots' ? Math.min(4000, 600 + N * 80) : Math.min(16000, 1500 + N * 520) };
}
function readJson(raw) {
  const clean = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) {
    const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch (e2) { return null; } }
    return null;
  }
}
function wordsFrom(x, ctx) {
  const actions = (Array.isArray(x.actions) ? x.actions : [x.actions]).map(textOf).filter(Boolean);
  let lines = [];
  if (ctx.style.speech && Array.isArray(x.lines)) lines = x.lines.map(function (l) {
    l = l || {};
    let who = textOf(l.who);
    const off = !!l.offscreen || /off-?screen/i.test(who);
    who = who.replace(/\s*\(off-?screen\)\s*/i, '').trim();
    return { who: who, text: textOf(l.line != null ? l.line : l.text), when: parseInt(l.during != null ? l.during : l.when, 10) || 0, off: off };
  });
  return cleanWords({ start: textOf(x.start), actions: actions, lines: lines, camera: textOf(x.camera), end: textOf(x.end), sounds: textOf(x.sounds), around: textOf(x.around), seconds: parseFloat(String(x.seconds == null ? '' : x.seconds).replace(/[^0-9.]/g, '')) });
}
function parseShotList(raw, ctx) {
  const p = readJson(raw);
  if (!p || typeof p !== 'object' || !Array.isArray(p.shots) || !p.shots.length) return { error: 'unreadable' };
  const N = ctx.pictures.length;
  if (ctx.mode !== 'shots') {
    // Director's Notes: one entry per shot as it stands, in order
    if (p.shots.length !== ctx.shots.length) return { error: p.shots.length + ' shots came back for ' + ctx.shots.length };
    const shots = [];
    let first = 1;
    for (let i = 0; i < p.shots.length; i++) {
      const x = p.shots[i] || {};
      const w = wordsFrom(x, ctx);
      if (!w.actions.length && !w.start) return { error: 'shot ' + (i + 1) + ' came back with no words' };
      const n = ctx.shots[i].keyframes.length, pics = [];
      for (let j = 0; j < n; j++) pics.push(first + j);
      first += n;
      shots.push({ pictures: pics, name: cleanShotName(textOf(x.name)), words: w });
    }
    return { overall: textOf(p.overall).slice(0, 2000), shots: shots };
  }
  // Create Shots: the cuts and the names only
  let next = 1;
  const shots = [];
  for (let i = 0; i < p.shots.length; i++) {
    const x = p.shots[i] || {};
    const pics = Array.isArray(x.pictures) ? x.pictures.map(function (v) { return parseInt(v, 10); }) : [];
    if (!pics.length) return { error: 'shot ' + (i + 1) + ' has no pictures' };
    for (let j = 0; j < pics.length; j++) { if (pics[j] !== next) return { error: 'shot ' + (i + 1) + ' has picture ' + pics[j] + ' where picture ' + next + ' was due' }; next++; }
    if (pics.length > SL_MAX_PER_SHOT) return { error: 'shot ' + (i + 1) + ' has ' + pics.length + ' pictures (at most ' + SL_MAX_PER_SHOT + ')' };
    shots.push({ pictures: pics, name: cleanShotName(textOf(x.name)), words: null });
  }
  if (next !== N + 1) return { error: 'the shots cover ' + (next - 1) + ' of ' + N + ' pictures' };
  return { overall: null, shots: shots };
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
  return { id: j.id, kind: j.kind === 'shots' ? 'shots' : 'notes', status: j.status, error: j.error || null, tokens_charged: j.tokens_charged || 0, style: j.style, started_at: j.started_at, finished_at: j.finished_at };
}
async function runShotList(jobId, episodeId, userId, ctx, prices, key) {
  const db = await getDb();
  const JFN = (ctx.mode === 'shots' ? 'Create Shots' : 'Director\'s Notes') + ' job ' + jobId + ' (episode ' + episodeId + ')';
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
      .run(((ctx.mode === 'shots' ? 'The Director\u2019s plan came back incomplete (' : 'The Director\u2019s Notes came back incomplete (') + lastErr + '). Nothing was charged; try again.').slice(0, 1000), inTok, outTok, usd, jobId);
    console.error('[video] ' + JFN + ' failed: ' + lastErr + ' ($' + usd + ' to Campaignia)');
    vlDebug(userId, 'error', JFN, 'Failed after two tries: ' + lastErr, { input_tokens: inTok, output_tokens: outTok, cost_usd: usd });
    return;
  }
  const charge = tokensFor(prices, usd);
  const shotList = { style: ctx.style.key, model: ctx.modelKey, written_at: new Date().toISOString(), overall: result.overall, shots: result.shots };
  let filled = false, files = [], kept = 0;
  const wpool = await refsPool(db, ctx.ep).catch(function () { return { characters: [], assets: [] }; });   // v3.5.22
  await db.transaction(async function (tx) {
    const claim = await tx.prepare("UPDATE episode_writer_jobs SET status = 'done', input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run(inTok, outTok, usd, jobId);
    if (!claim.changes) return;
    const ep = await tx.prepare('SELECT * FROM episodes WHERE id = ? FOR UPDATE').get(episodeId);
    const shots = ep ? await tx.prepare('SELECT * FROM shots WHERE episode_id = ? ORDER BY position, id').all(episodeId) : [];
    const kfs = ep ? await tx.prepare('SELECT * FROM keyframes WHERE episode_id = ? ORDER BY shot_id, position, id').all(episodeId) : [];
    shots.forEach(function (s) { s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; }); });
    const live = shots.filter(function (s) { return s.keyframes.length; });
    const pics = [];
    live.forEach(function (s) { s.keyframes.forEach(function (k) { pics.push(k); }); });
    const sigNow = ctx.mode === 'shots' ? pictureSig(pics.map(function (k) { return { url: k.image_url }; })) : cutSig(live);
    if (!ep || sigNow !== ctx.sig) {
      await tx.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ? WHERE id = ?").run(ctx.mode === 'shots' ? 'The episode\u2019s pictures changed while the Director was planning the shots. Nothing was charged; try again.' : 'The shots changed while the Director was writing the notes. Nothing was charged; try again.', jobId);
      return;
    }
    function namedRefs(words) {   // v3.5.22: the characters the words name become the shot's references
      const named = namedInShot({ overall: result.overall != null ? result.overall : ep.overall }, words, wpool.characters.filter(function (c) { return c.usable; }), 12);
      return named.map(function (p) { const c = wpool.characters.filter(function (x) { return x.name === p.name; })[0]; return c ? { type: 'character', id: c.id } : null; }).filter(Boolean);
    }
    function kfOut(k) { return { url: k.image_url, source: k.source, moment_id: k.moment_id, archive_id: k.archive_id, label: k.label, prompt: k.prompt || '', duration: k.duration, prev_url: k.prev_image_url || null }; }
    if (ctx.mode !== 'shots') {
      // v3.5.23 -- DIRECTOR'S NOTES: the shots stay exactly as they are (their pictures, cut styles and takes); every box
      // is rewritten, the references become the characters named, and a shot without a name gets the Director's.
      for (let i = 0; i < live.length; i++) {
        const sh = result.shots[i];
        await writeWords(tx, live[i].id, sh.words);
        await tx.prepare('UPDATE shots SET refs = ? WHERE id = ?').run(JSON.stringify(namedRefs(sh.words)), live[i].id);
        if (!cleanShotName(live[i].name) && sh.name) await tx.prepare('UPDATE shots SET name = ? WHERE id = ?').run(sh.name, live[i].id);
      }
      await tx.prepare('UPDATE episodes SET overall = ?, shot_list = ?, style = ?, updated_at = NOW() WHERE id = ?').run(result.overall, JSON.stringify(shotList), ctx.style.key, episodeId);
      filled = true;
      return;
    }
    // v3.5.23 -- CREATE SHOTS: the cuts only. A planned shot with exactly the pictures of a shot that is already there
    // IS that shot: it keeps its name, words, references, cut style and takes. The others are new and empty (the
    // Director's Notes fill them); shots that no longer exist go with their takes and files (asked first).
    const used = {};
    const fresh = result.shots.map(function (sh) {
      const urls = sh.pictures.map(function (n) { return pics[n - 1].image_url; });
      const same = live.filter(function (o) { return !used[o.id] && o.keyframes.length === urls.length && o.keyframes.every(function (k, j) { return k.image_url === urls[j]; }); })[0];
      if (same) {
        used[same.id] = true;
        return { id: same.id, name: cleanShotName(same.name) || sh.name, cut_style: same.cut_style || 'instant', keyframes: same.keyframes.map(kfOut) };
      }
      return { id: null, name: sh.name, cut_style: 'instant', keyframes: sh.pictures.map(function (n) { return kfOut(pics[n - 1]); }) };
    });
    kept = Object.keys(used).length;
    try { files = await writeShots(tx, ep, fresh); }
    catch (e) {
      if (!e.userFacing) throw e;
      await tx.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ? WHERE id = ?").run('A shot was being made while the Director planned the shots, so nothing was changed. Nothing was charged; try again when it is made.', jobId);
      files = [];
      return;
    }
    await tx.prepare('UPDATE episodes SET shot_list = ?, style = ?, updated_at = NOW() WHERE id = ?').run(JSON.stringify(shotList), ctx.style.key, episodeId);
    filled = true;
  });
  if (!filled) { vlDebug(userId, 'warn', JFN, 'Not filled (the episode changed, was deleted, a shot was being made, or the job was interrupted); nothing charged'); return; }
  if (files.length) { await forgetVideo(db, episodeId, files); await deleteFiles(files, 'episode ' + episodeId + ': shots replaced by Create Shots'); }
  let charged = 0;
  try {
    const tokens = require('./tokens');
    const bal = await tokens.getBalance(userId);
    charged = Math.min(charge, Math.max(0, bal.total));
    if (charged > 0) await tokens.spendTokens(userId, charged, { source: ctx.mode === 'shots' ? 'video_shot_plan' : 'video_shot_list', event_type: 'generation_spend', related_campaign_id: ctx.ep.campaign_id });
    if (charged < charge) console.warn('[video] ' + JFN + ': balance covered ' + charged + ' of ' + charge + ' token(s)');
    await tokens.recordGeneration(userId, { event_type: ctx.mode === 'shots' ? 'video_shot_plan' : 'video_shot_list', tokens_redeemed: charged, quantity: result.shots.length, unit: 'shots', model: require('../config/models').TEXT_MODEL, related_campaign_id: ctx.ep.campaign_id, related_session_id: ctx.ep.session_id });
  } catch (e) { console.error('[video] shot list charge failed:', e && e.message); }
  await db.prepare('UPDATE episode_writer_jobs SET tokens_charged = ? WHERE id = ?').run(charged, jobId);
  console.log('[video] ' + JFN + ': ' + result.shots.length + ' shot(s), ' + inTok + ' in / ' + outTok + ' out, $' + usd + ', ' + charged + ' token(s)');
  vlDebug(userId, 'info', JFN, (ctx.mode === 'shots' ? 'The Director planned ' + result.shots.length + ' shot(s), ' + kept + ' kept as they were' : 'The Director wrote the notes of ' + result.shots.length + ' shot(s)') + ', ' + charged + ' token(s) charged', { mode: ctx.mode, input_tokens: inTok, output_tokens: outTok, cost_usd: usd, worked_out: charge,
    plan: result.shots.map(function (sh) { return sh.words ? { pictures: sh.pictures, name: sh.name, actions: sh.words.actions.length, lines: sh.words.lines.length, seconds: sh.words.seconds } : { pictures: sh.pictures, name: sh.name }; }) });
}

// v3.5.20 -- ARCHIVE A PICTURE OF A SHOT (Ian, 2026-11-08: "we need to give them the ability to Archive pics from the
// KeyFrames"). The exact picture in the episode (a retouched or expanded copy included) is copied into the campaign's
// Archive as a picture (image_type 'moment' with no panel, as the Image Builder's Archive does), titled after its panel
// and marked "(video)", in the version's art style. The cap and the rights check apply as on every Archive button.
// Pressing it again removes the member's own entry.
async function keyframeOf(db, req, res) {
  await ensureTables();
  const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!ep || !(await canSee(req, ep))) { res.status(404).json({ error: 'Not found.' }); return null; }
  const url = String((req.body && req.body.url) || '');
  const kf = url ? await db.prepare('SELECT * FROM keyframes WHERE episode_id = ? AND image_url = ? LIMIT 1').get(ep.id, url) : null;
  if (!kf) { res.status(404).json({ error: 'That picture is not in this episode.' }); return null; }
  return { ep: ep, kf: kf, url: url };
}
router.post('/episodes/:id/keyframe-archive', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/keyframe-archive';
  try {
    const db = await getDb();
    const x = await keyframeOf(db, req, res); if (!x) return;
    const already = await db.prepare('SELECT id FROM campaign_archives WHERE campaign_id = ? AND source_url = ? LIMIT 1').get(x.ep.campaign_id, x.url);
    if (already) return res.json({ success: true, already: true });
    try {
      const { getEffectiveTier, getTier } = require('../middleware/tiers');
      const effTier = getTier(await getEffectiveTier(req.session.userId, x.ep.campaign_id));
      const cap = effTier ? effTier.max_archives_per_campaign : null;
      if (cap !== null && cap !== undefined) {
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_archives WHERE campaign_id = ?').get(x.ep.campaign_id);
        if (cnt && Number(cnt.c) >= cap) return res.json({ error: 'This campaign has hit its archive limit of ' + cap + ' images on the ' + effTier.name + ' tier. Remove an archived image to make room, or upgrade for more.' });
      }
    } catch (capErr) { console.error('[video] archive cap check error:', capErr.message); }
    if (await require('../services/rightsCheck').refuseRejected(res, [x.url], 'It can\u2019t be archived. Replace it with a picture you have the rights to.')) return;
    let title = x.kf.source === 'title' ? 'Title picture' : String(x.kf.label || '').trim();
    if (x.kf.moment_id) { const mo = await db.prepare('SELECT title FROM moments WHERE id = ?').get(x.kf.moment_id); if (mo && mo.title) title = String(mo.title); }
    title = (title || 'Video picture') + ' (video)';
    const vs = await db.prepare('SELECT f.art_style_override AS fork_style, s.art_style AS session_style, c.art_style AS campaign_style FROM session_forks f JOIN sessions s ON s.id = f.session_id JOIN campaigns c ON c.id = s.campaign_id WHERE f.id = ?').get(x.ep.fork_id);
    const style = vs ? (String(vs.fork_style || vs.session_style || vs.campaign_style || '').trim() || null) : null;
    let styleName = null;
    const cm = style ? /^custom:(\d+)$/i.exec(style) : null;
    if (cm) { try { const r = await db.prepare('SELECT name FROM custom_art_styles WHERE id = ?').get(parseInt(cm[1], 10)); styleName = (r && r.name) || null; } catch (e) {} }
    const shape = ['wide', 'square', 'tall'].indexOf(String(req.body.shape || '')) >= 0 ? String(req.body.shape) : null;
    const archivedUrl = await storage.archiveCopy(x.url);
    await db.prepare('INSERT INTO campaign_archives (campaign_id, session_id, fork_id, image_type, title, image_url, source_url, art_style, art_style_name, shape, archived_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(x.ep.campaign_id, x.ep.session_id, x.ep.fork_id, 'moment', title.slice(0, 200), archivedUrl, x.url, style, styleName, shape, req.session.userId, new Date().toISOString());
    vlDebug(req.session.userId, 'info', FN, 'Archived "' + title + '"', { url: vlShortUrl(x.url), shape: shape, art_style: style });
    res.json({ success: true });
  } catch (e) {
    console.error('[video] keyframe archive error:', e && e.message);
    res.json({ error: 'Could not archive the picture. Please try again.' });
  }
});
router.delete('/episodes/:id/keyframe-archive', requireAuth, requireVideo, async function (req, res) {
  try {
    const db = await getDb();
    const x = await keyframeOf(db, req, res); if (!x) return;
    const mine = await db.prepare('SELECT id, image_url FROM campaign_archives WHERE campaign_id = ? AND source_url = ? AND archived_by = ?').all(x.ep.campaign_id, x.url, req.session.userId);
    if (!mine.length) {
      const any = await db.prepare('SELECT id FROM campaign_archives WHERE campaign_id = ? AND source_url = ? LIMIT 1').get(x.ep.campaign_id, x.url);
      return res.json(any ? { error: 'Another member archived this picture; it stays in the Archive.' } : { success: true, removed: 0 });
    }
    for (const a of mine) await db.prepare('DELETE FROM campaign_archives WHERE id = ?').run(a.id);
    for (const a of mine) { try { await storage.releaseImage(db, a.image_url); } catch (e) { console.error('[video] release archive copy:', e.message); } }
    res.json({ success: true, removed: mine.length });
  } catch (e) {
    console.error('[video] keyframe un-archive error:', e && e.message);
    res.json({ error: 'Could not remove it from the Archive. Please try again.' });
  }
});

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
    // v3.5.23 -- b.mode 'shots' is Create Shots (the cuts), anything else the Director's Notes (the words).
    const ctx = withMode(await shotListContext(db, ep), b.mode);
    if (!ctx.pictures.length) return vlRefuse(req, res, FN, 400, 'This episode has no keyframes.');
    if (ctx.mode === 'shots') {
      // Create Shots plans the cuts again; a shot whose pictures change goes with its takes. Asked first.
      const tk = await db.prepare('SELECT COUNT(*) AS n FROM takes WHERE episode_id = ?').get(ep.id);
      const nTakes = Number(tk && tk.n) || 0;
      if (nTakes && b.replace_takes !== true) return res.status(409).json({ error: 'TAKES', takes: nTakes, message: 'The Director will plan the shots again. A shot whose pictures stay the same keeps its takes; the others are deleted with theirs (this episode has ' + nTakes + ' take' + (nTakes === 1 ? '' : 's') + ').' });
    }
    const busy = await db.prepare("SELECT id FROM takes WHERE episode_id = ? AND status = 'making' LIMIT 1").get(ep.id);
    if (busy) return vlRefuse(req, res, FN, 409, 'A shot is being made. Ask the Director when it is done.');
    const prices = await shotListPrices(db);
    const est = estimateShotList(ctx, prices);
    const bal = await require('./tokens').getBalance(req.session.userId);
    vlDebug(req.session.userId, 'info', FN, (ctx.mode === 'shots' ? 'Create Shots' : 'Director\'s Notes') + ' asked for', { mode: ctx.mode, style: ctx.style.key, model: ctx.modelKey, shots: ctx.shots.length, keyframes: ctx.pictures.length, story_chars: ctx.story.text.length, cast: ctx.cast.length, estimate: est, balance: bal.total });
    if (bal.total < est.tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: (ctx.mode === 'shots' ? 'Create Shots' : 'The Director\u2019s Notes') + ' costs about ' + est.tokens + ' token' + (est.tokens === 1 ? '' : 's') + ', but you have ' + bal.total + '. Add tokens and try again.' });
    await retireLostJobs(db, ep.id);
    const ins = await db.prepare("INSERT INTO episode_writer_jobs (episode_id, user_id, status, style, model, boot_id, sig, est_tokens, kind) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?) ON CONFLICT (episode_id) WHERE status = 'running' DO NOTHING")
      .run(ep.id, req.session.userId, ctx.style.key, ctx.modelKey, SL_BOOT, ctx.sig, est.tokens, ctx.mode);
    if (!ins.lastInsertRowid) return vlRefuse(req, res, FN, 409, 'The Director is already working on this episode.');
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
    let estimate = null, estimateShots = null;
    try {
      const ctx = await shotListContext(db, ep);
      if (ctx.pictures.length) { const pr = await shotListPrices(db); estimate = estimateShotList(withMode(ctx, 'notes'), pr); estimateShots = estimateShotList(withMode(ctx, 'shots'), pr); }
    } catch (e) { estimate = null; estimateShots = null; }
    res.json({ job: jobView(j), estimate: estimate, estimate_shots: estimateShots, episode: (j && j.status !== 'running') ? await loadEpisode(db, ep.id) : null });
  } catch (e) {
    console.error('[video] shot list read error:', e && e.message);
    res.status(500).json({ error: 'Could not read the shot list.' });
  }
});

startSweep();

module.exports = router;
module.exports.MODELS = MODELS;
module.exports.VIDEO_ASPECT = VIDEO_ASPECT;
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
