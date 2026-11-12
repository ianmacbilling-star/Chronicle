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
    label: 'Seedance 2.0', group: 'keyframes', pair: 'seedance2ref', endpoint: 'bytedance/seedance-2.0/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['4', '5', '6', '8', '10', '12', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.3024, priceSound: 0.3024,
    extra: { resolution: '720p', aspect_ratio: VIDEO_ASPECT }, promptRequired: true
  },
  seedance2fast: {
    label: 'Seedance 2.0 Fast', group: 'keyframes', pair: 'seedance2reffast', endpoint: 'bytedance/seedance-2.0/fast/image-to-video',
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
  },
  // v3.5.42 (Ian, 2026-11-09: "lets get this new Kling model in there. I need something cheaper to test out instructions
  // with but that still handles our basic needs"). Kling O3 Standard, reference-to-video: the same way of working as
  // Seedance's reference models (the shot's pictures and the cast as @Image1...), 3 to 15 s, $0.084 a second, $0.112
  // with its own sound. At most 7 pictures in all (fal: elements + reference images + start image), so 4 scene pictures
  // and the cast in the rest.
  klingo3ref: {
    label: 'Kling O3 Standard', group: 'reference', endpoint: 'fal-ai/kling-video/o3/standard/reference-to-video', reference: true,
    durations: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.084, priceSound: 0.112,
    extra: { aspect_ratio: VIDEO_ASPECT }, promptRequired: true, maxRefs: 7, maxScene: 4,
    maxPrompt: 2500   // v3.5.44: fal refuses a Kling O3 prompt over 2500 characters (Ian's first take failed)
  },
  // v3.5.82 (Ian, 2026-11-11: "go ahead and build all the models and we can weed out the ones we don't like later"; Seedance
  // refused shot 2's picture as a real face, Kling held the picture's framing, Veo 3.1 Fast did well). Test models, admins
  // only (test: true), each in both modes. Read from fal's model pages on 2026-11-11: field names, lengths, prices. Some
  // name the pictures list differently (refsField), the sound switch (audioField: null = none sent), and how the words
  // point at a picture (tag). pair: the same model in the other mode.
  klingo3pro: {
    label: 'Kling O3 Pro', group: 'keyframes', test: true, pair: 'klingo3proref', endpoint: 'fal-ai/kling-video/o3/pro/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.112, priceSound: 0.14,
    extra: {}, promptRequired: false, maxPrompt: 2500
  },
  klingo3proref: {
    label: 'Kling O3 Pro', group: 'reference', test: true, pair: 'klingo3pro', endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video', reference: true,
    durations: ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return String(d); }, price: 0.224, priceSound: 0.28,   // fal's playground; other listings say half
    extra: { aspect_ratio: VIDEO_ASPECT }, promptRequired: true, maxRefs: 7, maxScene: 4, maxPrompt: 2500
  },
  viduq3: {
    label: 'Vidu Q3', group: 'keyframes', test: true, pair: 'viduq3ref', endpoint: 'fal-ai/vidu/q3/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.154, priceSound: 0.154,
    extra: { resolution: '720p' }, promptRequired: false, maxPrompt: 2000, audioField: 'audio'
  },
  viduq3ref: {
    label: 'Vidu Q3', group: 'reference', test: true, pair: 'viduq3', endpoint: 'fal-ai/vidu/q3/reference-to-video/mix', reference: true,
    durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.154, priceSound: 0.154,
    extra: { aspect_ratio: VIDEO_ASPECT, resolution: '720p' }, promptRequired: true, maxRefs: 4, maxScene: 2, maxPrompt: 2000,
    audioField: 'audio', refsField: 'reference_image_urls', tag: function (n) { return 'image ' + n; }
  },
  h3max: {
    label: 'MiniMax H3 Max', group: 'keyframes', test: true, pair: 'h3maxref', endpoint: 'minimax/h3-max/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.08, priceSound: 0.08,
    extra: { resolution: '768P', prompt_expansion_mode: 'disabled' }, promptRequired: true, audioField: null   // v3.5.91: our words as written, no MiniMax rewrite (was 'balanced')
  },
  h3maxref: {
    label: 'MiniMax H3 Max', group: 'reference', test: true, pair: 'h3max', endpoint: 'minimax/h3-max/reference-to-video', reference: true,
    durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.10, priceSound: 0.10,   // $0.08 at 768p, plus a little for pictures past the fourth
    extra: { resolution: '768P', aspect_ratio: VIDEO_ASPECT, prompt_expansion_mode: 'disabled' }, promptRequired: true, maxRefs: 9, maxScene: 5,   // v3.5.91: no rewrite (was 'balanced')
    audioField: null, refsField: 'reference_image_urls', tag: function (n) { return 'Image ' + n; }
  },
  wan27: {
    label: 'Wan 2.7', group: 'keyframes', test: true, pair: 'wan27ref', endpoint: 'fal-ai/wan/v2.7/image-to-video',
    start: 'image_url', end: 'end_image_url', durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.10, priceSound: 0.10,
    extra: { resolution: '720p' }, promptRequired: false, maxPrompt: 5000, audioField: null
  },
  wan27ref: {
    label: 'Wan 2.7', group: 'reference', test: true, pair: 'wan27', endpoint: 'fal-ai/wan/v2.7/reference-to-video', reference: true,
    durations: ['2', '3', '4', '5', '6', '7', '8', '9', '10'], defDuration: '5',
    durationValue: function (d) { return Number(d); }, price: 0.10, priceSound: 0.10,
    extra: { aspect_ratio: VIDEO_ASPECT, resolution: '720p' }, promptRequired: true, maxRefs: 5, maxScene: 2, maxPrompt: 5000,
    audioField: null, refsField: 'reference_image_urls', tag: function (n) { return 'image ' + n; }
  }
};
const REF_MAX_IMAGES = 9;      // fal: up to 9 reference images
const REF_MAX_KEYFRAMES = 5;   // the rest of the 9 are kept for the cast
const REF_MIN_SECS = 4, REF_MAX_SECS = 15;
const DEFAULT_MODEL = 'seedance2reffast';   // v3.5.19: reference mode is the normal way (was seedance2fast, keyframes)
// v3.5.51 (Ian, 2026-11-09: canned transitions between shots need ffmpeg on our own server; railpack.json now installs it).
// Said once at start-up, so the deploy log shows whether it is there. Nothing uses it yet.
let FFMPEG_VERSION = null;
try {
  require('child_process').execFile('ffmpeg', ['-version'], { timeout: 15000 }, function (err, out) {
    FFMPEG_VERSION = err ? null : String(out || '').split('\n')[0].trim().slice(0, 120);
    console.log('[video] ffmpeg: ' + (FFMPEG_VERSION || 'NOT FOUND (' + (err && (err.code || err.message)) + ')'));
  });
} catch (e) { console.log('[video] ffmpeg: could not check (' + e.message + ')'); }
const MERGE_ENDPOINT = 'fal-ai/ffmpeg-api/merge-videos';   // joins clips in order on fal's servers (listed at $0)
const MAX_KEYFRAMES = 60;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const STUCK_MINUTES = 45;
const MAX_TAKES = 5;   // v3.5.15 (Ian: "for now we limit them to 3 takes"); v3.5.25: 10 while Video is built out (Ian: "Let's lift the limit on 3 takes")
// v3.5.89 (Ian, 2026-11-12: "set it to 5 but only for non admin. Admin can have 30 for now. I'm doing the bake off")
const MAX_TAKES_ADMIN = 30;
function maxTakes(req) { return req && req.vlAdmin ? MAX_TAKES_ADMIN : MAX_TAKES; }
// v3.5.54 (Ian, 2026-11-09: "Between the shots... we need to have some canned transitions"; spec
// claude/VIDEO_TRANSITIONS_SPEC.md). The cut AFTER a shot: its name, its length in seconds and ffmpeg's xfade name.
const CUT_STYLE_INFO = {
  instant: { label: 'Cut', secs: 0 },
  dissolve: { label: 'Dissolve', secs: 0.5, xfade: 'fade' },
  fadeblack: { label: 'Fade to black', secs: 1, xfade: 'fadeblack' },
  fadewhite: { label: 'Fade to white', secs: 1, xfade: 'fadewhite' },
  wipeleft: { label: 'Wipe left', secs: 0.5, xfade: 'wipeleft' },
  wiperight: { label: 'Wipe right', secs: 0.5, xfade: 'wiperight' },
  slideleft: { label: 'Slide left', secs: 0.5, xfade: 'slideleft' },
  slideright: { label: 'Slide right', secs: 0.5, xfade: 'slideright' },
  circleopen: { label: 'Circle open', secs: 0.7, xfade: 'circleopen' },
  circleclose: { label: 'Circle close', secs: 0.7, xfade: 'circleclose' }
};
const CUT_STYLES = Object.keys(CUT_STYLE_INFO);

function estCost(m, duration, sound) {
  const per = sound ? m.priceSound : m.price;
  return Math.round(per * Number(duration) * 10000) / 10000;
}
// v3.5.46 -- TAKES IN TOKENS (Ian, 2026-11-09: "start deducting tokens when actions are performed"; admins too; the
// episode join stays free). A take's price is fal's cost at shotlist_cents_per_token (8 cents) a token, rounded up. The
// balance is checked before anything goes to fal, less what the person's takes still being made will cost, and the
// tokens come off when the video lands; a take that fails costs nothing.
async function takeTokens(db, usd) {
  const pr = await shotListPrices(db);
  return Math.max(1, Math.ceil((Number(usd) || 0) * 100 / pr.shotlist_cents_per_token - 1e-9));
}
async function tokensFree(db, userId) {
  const bal = await require('./tokens').getBalance(userId);
  const r = await db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM takes WHERE user_id = ? AND status = 'making' AND tokens_charged IS NULL").get(userId);
  return { total: Number(bal.total) || 0, held: Number(r && r.n) || 0, free: (Number(bal.total) || 0) - (Number(r && r.n) || 0) };
}
function tokensShort(need, f, what) {
  return { status: 402, error: 'INSUFFICIENT_TOKENS', message: what + ' costs ' + need + ' token' + (need === 1 ? '' : 's') + ', but you have ' + f.free + (f.held ? ' free (' + f.held + ' are held for takes still being made)' : '') + '. Add tokens and try again.' };
}
async function chargeTake(db, takeId) {
  const t = await db.prepare('SELECT t.id, t.user_id, t.tokens, t.episode_id, e.campaign_id, e.session_id FROM takes t JOIN episodes e ON e.id = t.episode_id WHERE t.id = ?').get(takeId);
  if (!t || !t.tokens) return;
  const claim = await db.prepare('UPDATE takes SET tokens_charged = 0 WHERE id = ? AND tokens_charged IS NULL').run(takeId);
  if (!claim.changes) return;
  let charged = 0;
  try {
    const tk = require('./tokens');
    const bal = await tk.getBalance(t.user_id);
    charged = Math.min(Number(t.tokens), Math.max(0, Number(bal.total) || 0));
    if (charged > 0) await tk.spendTokens(t.user_id, charged, { source: 'video_take', event_type: 'generation_spend', related_campaign_id: t.campaign_id });
    await tk.recordGeneration(t.user_id, { event_type: 'video_take', tokens_redeemed: charged, quantity: 1, unit: 'takes', model: 'video', related_campaign_id: t.campaign_id, related_session_id: t.session_id });
    await db.prepare('UPDATE takes SET tokens_charged = ? WHERE id = ?').run(charged, takeId);
    if (charged < Number(t.tokens)) console.warn('[video] take ' + takeId + ': balance covered ' + charged + ' of ' + t.tokens + ' token(s)');
  } catch (e) { console.error('[video] take ' + takeId + ' charge failed:', e && e.message); }
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
  // v3.5.68 (Ian, 2026-11-10: a 422 showed only the echo of what was sent, cut before the reason): a refusal's reasons
  // ("msg", with the field they are about) come first, without the copy of the input fal sends back.
  try {
    const b = typeof body === 'string' ? JSON.parse(body) : body;
    if (b && Array.isArray(b.detail) && b.detail.length) {
      const why = b.detail.map(function (d) { return d && d.msg ? (Array.isArray(d.loc) ? d.loc.filter(function (x) { return x !== 'body'; }).join('.') + ': ' : '') + d.msg : ''; }).filter(Boolean);
      if (why.length) detail = why.map(function (w) { return '"msg": "' + w.replace(/"/g, "'") + '"'; }).join(' ');
    }
  } catch (_e) {}
  if (!detail && body) { try { detail = typeof body === 'string' ? body : JSON.stringify(body); } catch (_e) {} }
  return ((e.status ? e.status + ' ' : '') + (e.message || '') + (detail ? ' ' + detail : '')).trim().slice(0, 1000) || 'unknown error';
}
// v3.5.69 -- the reasons in a fal refusal ({"detail": [{"loc": [...], "msg": "..."}]}, anywhere in the text), each with the
// field it is about, as "msg" fields; '' when there are none.
function falDetailWhy(text) {
  const t = String(text || ''), out = [];
  let from = t.indexOf('{');
  while (from >= 0 && out.length === 0) {
    for (let to = t.lastIndexOf('}'); to > from; to = t.lastIndexOf('}', to - 1)) {
      let b = null; try { b = JSON.parse(t.slice(from, to + 1)); } catch (e) { continue; }
      const list = (b && Array.isArray(b.detail)) ? b.detail : (b && b.detail && Array.isArray(b.detail.detail) ? b.detail.detail : []);
      list.forEach(function (d) { if (d && d.msg) out.push('"msg": "' + ((Array.isArray(d.loc) ? d.loc.filter(function (x) { return x !== 'body'; }).join('.') + ': ' : '') + d.msg).replace(/"/g, "'") + '"'); });
      break;
    }
    from = t.indexOf('{', from + 1);
    if (out.length || from > 2000) break;
  }
  return out.join(' ');
}
// v3.5.44 -- fal's reason in a few words: the "msg" fields of its answer when there are any (a 422 lists what it refused),
// else the start of what it said.
function falReason(text) {
  const t = String(text || ''), msgs = [];
  t.replace(/"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/g, function (m0, m1) { if (msgs.indexOf(m1) < 0) msgs.push(m1); return m0; });
  const r = msgs.length ? msgs.join('; ') : t;
  return r.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no reason given';
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
    // v3.5.43: idx_writer_one_running (one job of any kind per episode) is replaced by the two lanes' indexes below
    await db.exec('CREATE INDEX IF NOT EXISTS idx_writer_episode ON episode_writer_jobs(episode_id, id)');
    // v3.5.09 -- Retouch on a keyframe: its one-step Revert slot, and the episode a retouch job belongs to.
    await db.exec('ALTER TABLE keyframes ADD COLUMN IF NOT EXISTS prev_image_url TEXT');
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS name TEXT');   // v3.5.15: a shot's own name
    await db.exec('ALTER TABLE episode_writer_jobs ADD COLUMN IF NOT EXISTS kind TEXT');
    await db.exec('ALTER TABLE episode_writer_jobs ADD COLUMN IF NOT EXISTS shot_id INTEGER');   // v3.5.38: a check of one shot
    // v3.5.43 (Ian, 2026-11-09: "multiple pre prod checks going at once for multiple shots"): two lanes. One episode-wide
    // job (Create Shots, the Notes, the full check) at a time; checks of single shots side by side, one per shot. Which
    // lane may start is decided in claimWriterJob under the episode's row lock; these indexes are the backstop.
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_one_running_ep ON episode_writer_jobs(episode_id) WHERE status = 'running' AND shot_id IS NULL");
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_one_running_shot ON episode_writer_jobs(episode_id, shot_id) WHERE status = 'running' AND shot_id IS NOT NULL");
    await db.exec('DROP INDEX IF EXISTS idx_writer_one_running');
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS source_take_id INTEGER');   // v3.5.26: a retouch of that take
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS retouch_text TEXT');
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS retouch_kind TEXT');
    await db.exec('ALTER TABLE episodes ADD COLUMN IF NOT EXISTS missing_shots TEXT');   // v3.5.58
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS concept TEXT');   // v3.5.99: how the shot should look and feel (for the user and the Director; never sent to the video model)
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS purpose TEXT');   // v3.5.59: what the shot is for (for the user and the Director; never sent to the video model)   // v3.5.58: Create Shots' list of shots the story still needs
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS trim_start REAL');   // v3.5.54: the part of the take the episode uses
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS trim_end REAL');
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS tokens INTEGER');   // v3.5.46: the take's price in tokens (NULL: made before tokens)
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS tokens_charged INTEGER');   // v3.5.46: NULL until it lands and is charged   // 'small' (Kling O1 Edit) or 'big' (Seedance 2.0)   // v3.5.23: 'shots' (Create Shots) or 'notes' (Director's Notes)
    // v3.5.19 -- a shot described in plain words, one set per shot (VIDEO_REFERENCE_SHOTS_SPEC section 2). actions and
    // lines are JSON; actions NULL means the shot was never saved this way (its words are still on its keyframes).
    for (const c of ['start_text TEXT', 'actions TEXT', 'lines TEXT', 'camera TEXT', 'end_text TEXT', 'sounds TEXT', 'around TEXT', 'seconds INTEGER', 'refs TEXT', 'beats TEXT']) {   // refs: v3.5.22; beats: v3.5.63 (TD-1121)
      await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS ' + c);
    }
    await db.exec('ALTER TABLE image_jobs ADD COLUMN IF NOT EXISTS episode_id INTEGER');
    // v3.5.34 -- TD-1115: a shot's own video mode ('' = the episode's model, 'reference', 'keyframes') and its pre-production check.
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS mode TEXT');
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS precheck TEXT');
    await db.exec('ALTER TABLE shots ADD COLUMN IF NOT EXISTS model TEXT');   // v3.5.86 -- TD-1122: a shot's own video model (NULL = the episode's)
    // v3.5.92 -- a take's Info (Ian, 2026-11-12: "Everything we know about the video"): the shot's words when it was made, the
    // exact input sent to fal for each move, and the prompt the model says it used (fal's expanded_prompt).
    await db.exec('ALTER TABLE takes ADD COLUMN IF NOT EXISTS words_at TEXT');
    await db.exec('ALTER TABLE moves ADD COLUMN IF NOT EXISTS sent_input TEXT');
    await db.exec('ALTER TABLE moves ADD COLUMN IF NOT EXISTS used_prompt TEXT');
    await db.exec('CREATE INDEX IF NOT EXISTS idx_image_jobs_episode ON image_jobs(episode_id)');
  })();
  _tablesReady.catch(function () { _tablesReady = null; });
  return _tablesReady;
}

// ---- reading an episode ----------------------------------------------------------------------
// What a shot will be made from now: the model, the sound, the overall direction and every keyframe with its move's
// words and length. A take records the same signature, so a take made before an edit shows as out of date.
// v3.5.34 -- TD-1115. A SHOT'S VIDEO MODE (Ian, 2026-11-09: "that video mode option at the top of the shot in a drop down").
// '' follows the episode's model. 'reference' / 'keyframes' pick the matching model: the episode's own when it is of that
// kind, else Seedance 2.0 of the same speed (Kling and Veo have no reference model: Seedance 2.0 Fast).
function shotMode(shot) { const m = String((shot && shot.mode) || ''); return m === 'reference' || m === 'keyframes' ? m : ''; }
// v3.5.86 -- TD-1122 (Ian, 2026-11-12: a model on each shot, "People may switch back and forth"). A shot's own model
// (shots.model, NULL = the episode's) wins; its Mode then only switches to the same model in the other mode, if there is one.
function modelPartner(key) {
  const m = MODELS[key]; if (!m) return null;
  if (m.pair && MODELS[m.pair]) return m.pair;
  const k = Object.keys(MODELS).filter(function (x) { return MODELS[x].pair === key; })[0];
  return k || null;
}
function shotModel(shot) { const k = String((shot && shot.model) || ''); return MODELS[k] ? k : ''; }
function shotModelKey(epModel, mode, own) {
  if (own && MODELS[own]) {   // v3.5.86
    const p = modelPartner(own);
    if (mode && p && !!MODELS[p].reference === (mode === 'reference') && !!MODELS[own].reference !== (mode === 'reference')) return p;
    return own;
  }
  const key = MODELS[epModel] ? epModel : DEFAULT_MODEL, m = MODELS[key];
  const p0 = modelPartner(key);   // v3.5.86: the same partner rule as a shot's own model and the page; and only when a mode is set
  // (v3.5.82 switched a reference test model with a pair to its keyframes twin even on a shot left on the episode's mode)
  if (mode && p0 && !!MODELS[p0].reference === (mode === 'reference') && !!m.reference !== (mode === 'reference')) return p0;   // v3.5.82: the same model in the other mode
  if (mode === 'reference' && !m.reference) return key === 'seedance2' ? 'seedance2ref' : (key === 'kling3std' ? 'klingo3ref' : 'seedance2reffast');   // v3.5.42: Kling to Kling
  if (mode === 'keyframes' && m.reference) return key === 'seedance2ref' ? 'seedance2' : (key === 'klingo3ref' ? 'kling3std' : 'seedance2fast');
  return key;
}
function epForShot(ep, shot) { const k = shotModelKey(ep.model, shotMode(shot), shotModel(shot)); return k === ep.model ? ep : Object.assign({}, ep, { model: k }); }
function shotSig(ep, kfs, shot) {
  const w = shot ? shotWords(shot) : null, r = shot ? shotRefs(shot) : null;
  return shortSig(JSON.stringify([ep.model, !!ep.sound, String(ep.overall || '')].concat(kfs.map(function (k) { return [k.image_url, k.prompt || '', k.duration || '']; }))
    .concat(w ? [w] : []).concat(r ? [r] : []).concat(shot && shotMode(shot) ? ['mode:' + shotMode(shot)] : []).concat(shot && shotModel(shot) ? ['model:' + shotModel(shot)] : [])));   // v3.5.86: its model, when set   // v3.5.19: the shot's own words too; v3.5.22: and its references; v3.5.34: its mode, when set
}
// v3.5.19 -- A SHOT IN PLAIN WORDS. A shot's words as stored (JSON in actions and lines), or null for a shot never saved
// this way. lines: [{ who, text, when (1-based action number, or 0 for any time), off (heard off-screen) }].
const SHOT_MIN_SECS = 4, SHOT_MAX_SECS = 15, SHOT_DEFAULT_SECS = 8;
function parseJson(v, dflt) { if (v == null) return dflt; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return dflt; } }
function shotWords(shot) {
  if (!shot || shot.actions == null) return null;
  const actions = parseJson(shot.actions, []), lines = parseJson(shot.lines, []);
  const w = { start: String(shot.start_text || ''), actions: Array.isArray(actions) ? actions.map(String) : [], lines: Array.isArray(lines) ? lines : [],
    camera: String(shot.camera || ''), end: String(shot.end_text || ''), sounds: String(shot.sounds || ''), around: String(shot.around || ''),
    seconds: Math.max(SHOT_MIN_SECS, Math.min(SHOT_MAX_SECS, parseInt(shot.seconds, 10) || SHOT_DEFAULT_SECS)) };
  return withBeats(w, parseJson(shot.beats, null));
}
// v3.5.63 -- TD-1121, THE SHOT IN BEATS (Ian, 2026-11-10; spec claude/VIDEO_BEATS_SPEC.md). Each action is a beat with its own
// camera, sound and seconds (null: an equal share of what is left). The words carry beats only when one has something in
// it, so takes made before stay current.
function cleanBeats(list, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = (Array.isArray(list) && list[i]) || {};
    const secs = parseFloat(b.secs);
    out.push({ camera: cleanText(b.camera, 300), sound: cleanText(b.sound, 300), secs: secs > 0 ? Math.min(SHOT_MAX_SECS, Math.round(secs * 2) / 2) : null });
  }
  return out;
}
function withBeats(w, list) {
  const b = cleanBeats(list, w.actions.length);
  if (b.some(function (x) { return x.camera || x.sound || x.secs; })) w.beats = b;
  return w;
}
// Each beat's seconds, from and to: the fixed ones as set, the rest an equal share of what they leave (at least half a second).
function beatTimes(w) {
  const n = w.actions.length, b = w.beats || [], out = [];
  if (!n) return out;
  let fixed = 0, loose = 0;
  for (let i = 0; i < n; i++) { if (b[i] && b[i].secs) fixed += b[i].secs; else loose++; }
  const share = loose ? Math.max(0.5, (w.seconds - fixed) / loose) : 0;
  let t = 0;
  for (let i = 0; i < n; i++) { const d = (b[i] && b[i].secs) || share; out.push({ from: t, to: t + d }); t += d; }
  return out;
}
function secsText(x) { return String(Math.round(x * 10) / 10); }
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
  const w = { start: cleanText(s.start_text != null ? s.start_text : s.start, 900), actions: actions, lines: lines, camera: cleanText(s.camera, 900), end: cleanText(s.end_text != null ? s.end_text : s.end, 900),
    sounds: cleanText(s.sounds, 600), around: cleanText(s.around, 600), seconds: clampSecs(s.seconds) };
  return withBeats(w, s.beats);
}
// Which chosen takes, in order, the episode video is made of.
function chosenSig(shots) { return shots.map(function (s) { return s.chosen_take_id || 0; }).join(','); }
// v3.5.54 -- what the episode video is made from: the chosen takes, and, once any cut is not plain or any chosen take is
// trimmed, the cuts and the trims too (so an episode joined before stays current). shots: [{ chosen_take_id, cut_style,
// trim_start, trim_end }] in order.
function trimOf(v) { return v == null || v === '' ? null : Math.round(Number(v) * 100) / 100; }
function needsLocalJoin(shots) {
  return shots.some(function (s, i) { return (i < shots.length - 1 && (s.cut_style || 'instant') !== 'instant') || trimOf(s.trim_start) != null || trimOf(s.trim_end) != null; });
}
function joinSig(shots) {
  if (!needsLocalJoin(shots)) return chosenSig(shots);
  return shots.map(function (s, i) { return (s.chosen_take_id || 0) + '[' + (trimOf(s.trim_start) == null ? '' : trimOf(s.trim_start)) + '-' + (trimOf(s.trim_end) == null ? '' : trimOf(s.trim_end)) + ']' + (i < shots.length - 1 ? '>' + (s.cut_style || 'instant') : ''); }).join(',');
}

async function loadEpisodes(db, where, params) {
  const eps = await db.prepare('SELECT * FROM episodes WHERE ' + where + ' ORDER BY pinned DESC, created_at DESC, id DESC').all(params);
  if (!eps.length) return [];
  const ids = eps.map(function (e) { return e.id; });
  const shots = await db.prepare('SELECT * FROM shots WHERE episode_id = ANY(?) ORDER BY episode_id, position, id').all([ids]);
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE episode_id = ANY(?) ORDER BY shot_id, position, id').all([ids]);
  const takes = await db.prepare('SELECT * FROM takes WHERE episode_id = ANY(?) ORDER BY shot_id, id').all([ids]);
  const moves = await db.prepare('SELECT * FROM moves WHERE episode_id = ANY(?) ORDER BY take_id, position, id').all([ids]);
  takes.forEach(function (t) { delete t.words_at; });   // v3.5.92: only a take's Info reads these, not every refresh
  moves.forEach(function (m) { delete m.sent_input; delete m.used_prompt; });
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
      s.mode = shotMode(s);   // v3.5.34
      s.model = shotModel(s);   // v3.5.86 -- TD-1122
      s.model_used = shotModelKey(ep.model, s.mode, s.model);
      s.precheck = parseJson(s.precheck, null);
      if (s.precheck && typeof s.precheck === 'object') s.precheck.stale = s.precheck.sig !== s.sig; else s.precheck = null;
      s.takes = takes.filter(function (t) { return t.shot_id === s.id; });
      s.takes.forEach(function (t) {
        t.moves = moves.filter(function (m) { return m.take_id === t.id; });
        t.stale = t.sig !== s.sig;
      });
    });
    const cs = joinSig(ep.shots.map(function (s) { const t = s.takes.filter(function (x) { return x.id === s.chosen_take_id; })[0]; return { chosen_take_id: s.chosen_take_id, cut_style: s.cut_style, trim_start: t ? t.trim_start : null, trim_end: t ? t.trim_end : null }; }));   // v3.5.54
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
router.get('/models', requireAuth, requireVideo, async function (req, res) {
  const out = Object.keys(MODELS).map(function (k) {
    const m = MODELS[k];
    if (m.test && !req.vlAdmin) return null;   // v3.5.82: the test models are for admins
    return { key: k, label: m.label, group: m.group || 'keyframes', reference: !!m.reference, partner: modelPartner(k), durations: m.durations, defDuration: m.defDuration, price: m.price, priceSound: m.priceSound, promptRequired: m.promptRequired, test: !!m.test, no_sound_switch: m.audioField === null, max_prompt: m.maxPrompt || 0,   // v3.5.85
      max_refs: m.reference ? (m.maxRefs || REF_MAX_IMAGES) : 0, max_scene: m.reference ? (m.maxScene || REF_MAX_KEYFRAMES) : 0 };
  }).filter(Boolean).sort(function (a, b) { return (b.reference ? 1 : 0) - (a.reference ? 1 : 0); });   // v3.5.19: reference first
  const styles = VIDEO_STYLES.map(function (s) { return { key: s.key, label: s.label, description: s.description, speech: s.speech, defaultShot: s.defaultShot }; });
  vlDebug(req.session && req.session.userId, 'info', 'GET /api/video-lab/models', 'Models offered: ' + out.map(function (x) { return x.key; }).join(', '));   // v3.5.18
  let cpt = SL_DEFAULTS.shotlist_cents_per_token;   // v3.5.39 (Ian, 2026-11-09): the model menu shows tokens a second
  try { cpt = (await shotListPrices(await getDb())).shotlist_cents_per_token; } catch (e) { cpt = SL_DEFAULTS.shotlist_cents_per_token; }
  res.json({ models: out, webhook: !!webhookUrl(), ffmpeg: FFMPEG_VERSION, styles: styles, defaultStyle: DEFAULT_STYLE, defaultModel: DEFAULT_MODEL, cutStyles: CUT_STYLES, cutStyleInfo: CUT_STYLES.map(function (k) { return { key: k, label: CUT_STYLE_INFO[k].label, secs: CUT_STYLE_INFO[k].secs }; }), cents_per_token: cpt, max_takes: maxTakes(req) });   // v3.5.89 max_takes
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
  await tx.prepare('UPDATE shots SET start_text = ?, actions = ?, lines = ?, camera = ?, end_text = ?, sounds = ?, around = ?, seconds = ?, beats = ? WHERE id = ?')
    .run(w.start, JSON.stringify(w.actions), JSON.stringify(w.lines), w.camera, w.end, w.sounds, w.around, w.seconds, w.beats ? JSON.stringify(w.beats) : null, sid);   // v3.5.63 beats
}
// v3.5.99: the Purpose and the Concept are written in a window with room, so they keep their line breaks
function cleanLong(v, max) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
function cleanPurpose(v) { return cleanLong(v, 600); }   // v3.5.59; v3.5.99 600 characters, line breaks kept
function cleanConcept(v) { return cleanLong(v, 1000); }   // v3.5.99
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
      if (s.mode !== undefined) await tx.prepare('UPDATE shots SET mode = ? WHERE id = ?').run(s.mode || null, sid);   // v3.5.34
      if (s.model !== undefined) await tx.prepare('UPDATE shots SET model = ? WHERE id = ?').run(s.model || null, sid);   // v3.5.86
      if (s.purpose !== undefined) await tx.prepare('UPDATE shots SET purpose = ? WHERE id = ?').run(s.purpose || null, sid);   // v3.5.59
      if (s.concept !== undefined) await tx.prepare('UPDATE shots SET concept = ? WHERE id = ?').run(s.concept || null, sid);   // v3.5.99
    } else {
      const r = await tx.prepare('INSERT INTO shots (episode_id, position, cut_style, name) VALUES (?, ?, ?, ?)').run(ep.id, pos, s.cut_style, s.name || null);
      sid = r.lastInsertRowid;
      if (s.words) await writeWords(tx, sid, s.words);
      if (s.refs) await tx.prepare('UPDATE shots SET refs = ? WHERE id = ?').run(JSON.stringify(s.refs), sid);
      if (s.mode) await tx.prepare('UPDATE shots SET mode = ? WHERE id = ?').run(s.mode, sid);   // v3.5.34
      if (s.model) await tx.prepare('UPDATE shots SET model = ? WHERE id = ?').run(s.model, sid);   // v3.5.86
      if (s.purpose) await tx.prepare('UPDATE shots SET purpose = ? WHERE id = ?').run(s.purpose, sid);   // v3.5.59
      if (s.concept) await tx.prepare('UPDATE shots SET concept = ? WHERE id = ?').run(s.concept, sid);   // v3.5.99
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
function cleanShots(list, m0, admin) {
  const out = [];
  let n = 0;
  (Array.isArray(list) ? list : []).forEach(function (s) {
    s = s || {};
    // v3.5.86 -- TD-1122: the shot's own model ('' = the episode's); a test model only from an admin, as for the episode
    const own = s.model === undefined ? undefined : (MODELS[s.model] && !(MODELS[s.model].test && !admin) ? String(s.model) : '');
    const m = own ? MODELS[own] : m0;
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
    if (kfs.length && room <= 0) return;   // v3.5.57: a shot with no pictures yet is kept (Add new shot below)
    n += Math.max(0, Math.min(room, kfs.length));
    out.push({ id: parseInt(s.id, 10) || null, model: own, mode: s.mode === undefined ? undefined : (s.mode === 'reference' || s.mode === 'keyframes' ? s.mode : ''), refs: s.refs === undefined || s.refs === null ? undefined : cleanRefs(s.refs), words: s.actions === undefined ? undefined : cleanWords(s), name: s.name === undefined ? undefined : cleanShotName(s.name), purpose: s.purpose === undefined ? undefined : cleanPurpose(s.purpose), concept: s.concept === undefined ? undefined : cleanConcept(s.concept), cut_style: CUT_STYLES.indexOf(s.cut_style) >= 0 ? s.cut_style : 'instant', keyframes: kfs.slice(0, room) });
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
    const model = MODELS[b.model] && !(MODELS[b.model].test && !req.vlAdmin) ? b.model : DEFAULT_MODEL;   // v3.5.82 test models: admins
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
    if (await runningWriter(db, id, true)) return vlRefuse(req, res, FN, 409, 'The shot list is being written; your changes can be made when it is done.');
    const model = (b.model != null && MODELS[b.model] && !(MODELS[b.model].test && !req.vlAdmin)) ? b.model : (MODELS[ep0.model] ? ep0.model : DEFAULT_MODEL);   // v3.5.82 test models: admins
    let shots = null;
    if (b.shots != null) {
      shots = cleanShots(b.shots, MODELS[model], !!req.vlAdmin);   // v3.5.86 admin: a shot's test model
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
        return { name: s.name, purpose: s.purpose || '', concept: s.concept || '', mode: s.mode || '', model: s.model || '', cut_style: s.cut_style, refs: s.refs || undefined, start: w.start, actions: s.words_saved ? w.actions : undefined, lines: w.lines, camera: w.camera, end: w.end, sounds: w.sounds, around: w.around, seconds: w.seconds, beats: w.beats, keyframes: s.keyframes.map(function (k) { return { url: k.image_url, source: k.source, moment_id: k.moment_id, archive_id: k.archive_id, label: k.label, prompt: k.prompt, duration: k.duration, prev_url: k.prev_image_url }; }) };
      }), m, !!req.vlAdmin));   // v3.5.86
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
  const pics = kfs.slice(0, m.maxScene || REF_MAX_KEYFRAMES).map(function (k) { return k.image_url; });   // v3.5.42: a model's own limits
  const words = (overall + ' ' + steps.join(' ')).toLowerCase();
  const people = [];
  (cast || []).forEach(function (c) {
    if (people.length >= (m.maxRefs || REF_MAX_IMAGES) - pics.length || !c.url || !c.name) return;
    if (people.some(function (p) { return p.name === c.name || p.url === c.url; })) return;
    const first = String(c.name).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9'-]/g, '');
    if (first.length >= 2 && new RegExp('(^|[^a-z0-9])' + first.replace(/[-']/g, '\\$&') + '([^a-z0-9]|$)').test(words)) people.push({ name: String(c.name).trim(), url: c.url });
  });
  const lines = [];
  lines.push('One continuous shot, no cuts. Keep every character looking exactly the same from start to finish.');
  if (pics.length === 1) lines.push('@Image1 is how the shot opens: start the video looking like it, same place, same people, same art style.');
  else lines.push('@Image1 is how the shot opens: start the video looking like it. ' + pics.slice(1).map(function (u, i) { return '@Image' + (i + 2); }).join(', ') +
    (pics.length === 2 ? ' is a later moment' : ' are later moments, in order,') + ' of the same shot: pass through ' + (pics.length === 2 ? 'it' : 'them') + ' as the action reaches ' + (pics.length === 2 ? 'it' : 'them') + '. Keep the art style of these pictures.');
  people.forEach(function (p, i) { lines.push('@Image' + (pics.length + i + 1) + ' is ' + p.name + ': ' + p.name + '\'s face, hair, build and clothes must match @Image' + (pics.length + i + 1) + ' whenever ' + p.name + ' is on screen. ' + gearLine(p.name)); });   // v3.5.96
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
// v3.5.47 -- EXITS (Ian, 2026-11-09: "when I mention I want someone to leave the frame... It often stops before the leave
// the frame entirely... can we do something so if we say they leave the frame that they leave all the way?"). An action
// or End that has someone leave gets a firm line: completely out of frame before the shot ends, then the empty frame held.
// v3.5.96 (Ian, 2026-11-12, takes 58 and 84: "The diamond vanishes" was read as someone leaving, so Gubuk walked off in 58 and
// Drel and Gubuk dissolved in 84's last second). Only people leave: words that only things do (vanishes, disappears, is gone,
// out of sight) count only right after a name or he/she/they ("Gubuk vanishes", "he slowly disappears"); never after
// "the diamond" or "Emanon's glow". The page's VL_EXIT_RE / vlHasExit are the same.
const EXIT_RE = /\b(leaves (the )?(frame|shot|scene|room|picture|view)|leaves (through|to the|off)|(walks?|runs?|strides?|heads?|steps?|hurries|hurry|rushes|rush|limps?|slips?|backs?) (out|off|away)|exits?\b|exiting|out of (the )?(frame|shot|picture)|off[- ]?(screen|frame))/i;
const EXIT_WEAK_RE = /(^|[^A-Za-z'\u2019])(he|she|they|He|She|They|everyone|Everyone|both|Both|[A-Z][A-Za-z-]+)((?:\s+[a-z]+){0,2})\s+(disappears?|disappearing|vanish(?:es|ing)?|(?:is|are) gone|(?:is|are) out of (?:view|sight))\b/g;
const EXIT_NOT_SUBJECT = { The: 1, A: 1, An: 1, His: 1, Her: 1, Its: 1, Their: 1, This: 1, That: 1, These: 1, Those: 1, Then: 1, And: 1, But: 1, When: 1, As: 1, Suddenly: 1, Slowly: 1, Finally: 1 };
function hasExit(text) {
  const t = String(text || '').replace(/\bfrom off[- ]?(screen|frame)\b/gi, '');
  if (EXIT_RE.test(t)) return true;
  EXIT_WEAK_RE.lastIndex = 0; let m;
  while ((m = EXIT_WEAK_RE.exec(t))) { if (!EXIT_NOT_SUBJECT[m[2]]) return true; }
  return false;
}
// v3.5.49 (Ian, 2026-11-09: the figure still did not get all the way out; "say one second"): a deadline in seconds, one
// second before the end, when the shot is one move (reference mode), and the camera told not to follow them out.
function exitLines(w, names, secs) {
  const acts = [];
  w.actions.forEach(function (a, i) { if (hasExit(a)) acts.push(i + 1); });
  const endExit = hasExit(w.end);
  if (!acts.length && !endExit) return [];
  const src = acts.map(function (n) { return w.actions[n - 1]; }).concat(endExit ? [w.end] : []).join(' ');
  const who = (names || []).filter(function (nm, i, all) { return all.indexOf(nm) === i; }).filter(function (nm) { const f = firstName(nm); return f && new RegExp('(^|[^a-z])' + f.toLowerCase().replace(/[^a-z0-9]/g, '') + '([^a-z]|$)').test(src.toLowerCase()); });
  const whom = who.length === 1 ? who[0] : (acts.length > 1 || who.length > 1 ? 'everyone who leaves' : 'whoever leaves');   // v3.5.96: several
  // v3.5.96 (Ian, take 80: "in the background" lost to "do not stop at the edge"; take 84: "hold the empty frame" emptied it of
  // the people who stay): a way out the words name (a door, an archway) is used instead of the frame's edge, and the last second
  // is held without the ones who left, not empty.
  const door = /\b(through|into|out of|out through|up|down)\s+(the |a |an |his |her |their )?([a-z-]+ ){0,2}(door|doors|doorway|archway|arch|gate|gateway|stairs|stairway|stair|steps|corridor|passage|tunnel|hall|hallway|curtain|flap|portal|opening|gap)\b/i.test(src);
  const out = ['Leaving the frame' + (acts.length ? ' (action ' + acts.join(', ') + ')' : '') + ': ' + whom + ' must keep moving until completely out of ' + (door ? 'view' : 'frame') + ', with no part of them left in view, ' + (secs >= 4 ? 'by second ' + (secs - 1) + ' of this ' + secs + '-second shot' : 'well before the shot ends') + '. ' +
    (door ? 'They leave by the way the words name, not by the edge of the frame. ' : 'Do not stop at the edge of the frame. ') + 'The camera does not follow them out: it holds still as they go. Anyone who does not leave stays where they are; hold the last second without the ones who left.'];
  if (!endExit) out.push('The shot ends with ' + (who.length === 1 ? who[0] : 'everyone who left') + ' gone from the frame.');
  return out;
}
function gearLine(name) { return 'What ' + name + ' carries or holds is up to the words; where they do not say, only what fits the scene, never anything belonging to another character; empty hands are fine.'; }   // v3.5.96
function shotScript(ep, w, pics) {
  const out = [];
  out.push('One continuous shot, no cuts. Keep every character looking exactly the same from start to finish.');
  // v3.5.48 (Ian, 2026-11-09: "can you make it so nothing appears out of thin air unless we tell it to?" -- take 26's pestle)
  out.push('Nothing appears or disappears out of thin air unless the words say so (something used up, destroyed or vanishing, as they describe it): any object a character uses must first be seen in the scene and picked up, drawn or brought into view on screen, and anyone who appears must walk or come into view.');
  if (pics) {
    pics.cast.forEach(function (c) {
      if (c.kind === 'asset') out.push('@Image' + c.n + ' is ' + c.name + (c.height ? ', ' + c.height : '') + ': it must look like @Image' + c.n + ' whenever it is on screen.');   // v3.5.22; v3.5.61 an NPC's height
      // v3.5.96 (Ian, 2026-11-12: "Just because their reference image says they have an item... that does not mean they have to be
      // carrying it"; "I'd rather him carrying nothing than carrying the pick"): the reference is their looks and height; what they
      // hold is the words' to say, never another character's things.
      else out.push('@Image' + c.n + ' is ' + c.name + (c.height ? ', ' + c.height : '') + ': ' + c.name + '\'s face, hair, build and clothes must match @Image' + c.n + ' whenever ' + c.name + ' is on screen. ' + gearLine(c.name));
    });
    if (pics.cast.length) out.push('If a scene picture shows a character or thing differently, follow its own picture.');
    if (pics.scene.length) out.push('@Image' + pics.scene[0] + ' is how the shot opens: start the video looking like it, in its art style.');
    if (pics.scene.length > 1) out.push(pics.scene.slice(1).map(function (n) { return '@Image' + n; }).join(', ') + (pics.scene.length === 2 ? ' shows' : ' show') +
      ' the place, the light and who is there. Do not copy poses, positions or which way anyone faces from ' + (pics.scene.length === 2 ? 'it' : 'them') + '.');
  }
  const overall = String(ep.overall || '').trim();
  if (overall) out.push('Overall: ' + overall);
  // v3.5.97 (Ian, 2026-11-12, takes 85 and 86: MiniMax painted floating islands from the Overall instead of the picture's hall;
  // "unless specified... the background should match the background of the keyframe"; "Is that wise for cameras that move?"):
  // the PLACE holds, not the frame -- a pan shows more of the same place.
  if (pics && pics.scene.length) out.push('The place: unless the words say the place changes, the shot stays in the place @Image' + pics.scene[0] + ' shows: what is in view keeps its look (the buildings, sky and light), and anything the camera turns or moves to is more of that same place, never somewhere new.');
  if (w.start) out.push('Start: ' + w.start);
  const loose = w.lines.filter(function (l) { return !l.when; });
  const spk = {}; w.lines.forEach(function (l) { spk[firstName(l.who)] = true; });
  const hearers = pics ? pics.cast.filter(function (c) { return c.kind !== 'asset' && !spk[firstName(c.name)]; }).map(function (c) { return c.name; }) : [];   // v3.5.25
  if (w.actions.length || loose.length) {
    out.push('What happens, in order' + (w.actions.length >= 2 ? ', with the seconds each part takes' : '') + ':');
    const times = beatTimes(w), beats = w.beats || [];   // v3.5.63 -- TD-1121: each beat its seconds, camera and sound
    w.actions.forEach(function (a, i) {
      const said = w.lines.filter(function (l) { return l.when === i + 1; }).map(function (l) { return 'As this happens, ' + sayLine(l, hearers) + '.'; });
      const b = beats[i] || {}, at = w.actions.length >= 2 && times[i] ? '(' + secsText(times[i].from) + '-' + secsText(times[i].to) + ' s) ' : '';
      function stop(x) { x = String(x).trim(); return /[.!?"\u201d]$/.test(x) ? x : x + '.'; }
      out.push((i + 1) + '. ' + at + ((said.length || b.camera || b.sound) ? stop(a) : a) + (said.length ? ' ' + said.join(' ') : '') + (b.camera ? ' Camera in this part: ' + stop(b.camera) : '') + (b.sound ? ' Sound in this part: ' + stop(b.sound) : ''));
    });
    loose.forEach(function (l) { const t = sayLine(l, hearers); out.push(w.actions.length ? 'Then, ' + t + '.' : t.charAt(0).toUpperCase() + t.slice(1) + '.'); });
  }
  voiceRules(w, pics ? pics.cast.filter(function (c) { return c.kind !== 'asset'; }).map(function (c) { return c.name; }) : []).forEach(function (r) { out.push(r); });   // v3.5.25
  const ex = exitLines(w, (ep.castNames || []).concat(pics ? pics.cast.filter(function (c) { return c.kind !== 'asset'; }).map(function (c) { return c.name; }) : []), pics ? w.seconds : 0);   // v3.5.47; v3.5.49 the deadline
  if (ex.length) out.push(ex[0]);
  if (w.camera) out.push('Camera: ' + w.camera);
  if (w.end) out.push('End (where everyone must be by the last second): ' + w.end);   // v3.5.96
  if (ex.length > 1) out.push(ex[1]);
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
    if (first.length >= 2 && new RegExp('(^|[^a-z0-9])' + first.replace(/[-']/g, '\\$&') + '([^a-z0-9]|$)').test(words)) people.push({ name: String(c.name).trim(), url: c.url, height: c.height || '' });   // v3.5.96 height
  });
  return people;
}
// A reference shot in plain words: one move; the cast named first (they win), then up to 5 scene pictures.
function planReferenceWords(ep, kfs, w, shotNo, pool, refs) {
  const m = MODELS[ep.model];
  if (!kfs.length) return { error: 'Shot ' + shotNo + ' has no pictures.' };
  if (!wordsHaveContent(ep, w)) return { error: 'Shot ' + shotNo + ' needs words: say what the characters do, or how the shot starts.' };
  const scenePics = kfs.slice(0, m.maxScene || REF_MAX_KEYFRAMES).map(function (k) { return k.image_url; });   // v3.5.42: a model's own limits
  const people = refsToSend(ep, w, refs, pool, (m.maxRefs || REF_MAX_IMAGES) - scenePics.length);   // v3.5.22: the shot's references
  const pics = { cast: people.map(function (p, i) { return { name: p.name, n: i + 1, kind: p.kind, height: p.height || '' }; }), scene: scenePics.map(function (u, i) { return people.length + i + 1; }) };   // v3.5.61 height
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
    rows = await db.prepare('SELECT ch.id, ch.name, ch.height_ft, COALESCE(sc.reference_url, ch.canonical_reference_url) AS url FROM characters ch LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? WHERE ch.campaign_id = ? ORDER BY ch.is_npc ASC, ch.id ASC').all(ep.fork_id, ep.campaign_id);
  } catch (e) {
    console.error('[video] cast references could not be read: ' + (e && e.message));
    rows = [];
    if (detail) return { usable: [], all: [{ error: 'could not read the cast: ' + (e && e.message) }] };
  }
  const usable = rows.filter(function (c) { return c.url && storage.isOurPublicUrl(c.url); });
  if (!detail) return usable;
  // v3.5.18 -- for debug mode: every character, and why one is not usable
  return { usable: usable, all: rows.map(function (c) { return { id: c.id, name: c.name, height: Number(c.height_ft) > 0 ? vlHeightPhrase(c.height_ft) : '', url: c.url && storage.isOurPublicUrl(c.url) ? c.url : null, picture: c.url ? vlShortUrl(c.url) : null, usable: !!(c.url && storage.isOurPublicUrl(c.url)), why_not: !c.url ? 'no reference picture' : (!storage.isOurPublicUrl(c.url) ? 'not a Campaignia picture' : undefined) }; }) };
}
// v3.5.22 -- THE REFERENCES A SHOT CAN SEND (Ian, 2026-11-08: "add the ability to add character and asset references... and
// see the references that are already on that shot... just like we do on the Review tab, Storyboard and Image builder").
// The version's characters (their version picture, else their own) and the campaign's assets; an asset whose picture was
// refused by the rights check, or that is not a Campaignia picture, cannot be sent.
// v3.5.61 -- an NPC asset's height in words, as images.js charHeightPhrase writes a character's ("about 9 feet 6 inches tall").
function vlHeightPhrase(ft) {
  const n = parseFloat(ft);
  if (!(n > 0)) return '';
  const inches = Math.round(n * 12), f = Math.floor(inches / 12), i = inches % 12;
  if (f <= 0) return 'about ' + inches + ' inches tall';
  return 'about ' + f + (f === 1 ? ' foot' : ' feet') + (i && f < 25 ? ' ' + i + (i === 1 ? ' inch' : ' inches') : '') + ' tall';
}
async function refsPool(db, ep) {
  const cast = await castRefs(db, ep, true);
  let assets = [];
  try {
    assets = (await db.prepare("SELECT a.id, a.name, a.category, a.height_ft, CASE WHEN r.id IS NULL THEN a.image_url ELSE NULL END AS url FROM campaign_assets a LEFT JOIN image_rights r ON r.image_url = a.image_url AND r.verdict = 'reject' WHERE a.campaign_id = ? ORDER BY LOWER(a.name)").all(ep.campaign_id))
      .map(function (a) { const ok = !!(a.url && storage.isOurPublicUrl(a.url)); return { id: a.id, name: a.name, url: ok ? a.url : null, usable: ok, why_not: ok ? null : (a.url ? 'not a Campaignia picture' : 'no usable picture'), height: (a.category === 'npc' && Number(a.height_ft) > 0) ? vlHeightPhrase(a.height_ft) : '' }; });   // v3.5.61 an NPC's height
  } catch (e) { console.error('[video] assets could not be read: ' + (e && e.message)); }
  return { characters: cast.all.filter(function (c) { return c.name && c.id; }).map(function (c) { return { id: c.id, name: c.name, height: c.height || '', url: c.url || null, usable: !!c.usable, why_not: c.why_not || null }; }), assets: assets };
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
      if (it && it.usable && it.url && !out.some(function (o) { return o.url === it.url; })) out.push({ name: String(it.name).trim(), url: it.url, kind: r.type, height: it.height || '' });   // v3.5.61 height
    });
    return out;
  }
  return namedInShot(ep, w, pool.characters.filter(function (c) { return c.usable; }), room).map(function (p) { return { name: p.name, url: p.url, kind: 'character', height: p.height || '' }; });   // v3.5.96 height
}
// v3.5.44 -- a model with a prompt limit (Kling O3: 2500 characters) gets the script cut to fit: first the lines that
// matter least to the picture (Sound, unless its own sound is on; Around them; Overall), then the end of the text at a
// full stop. Without this fal refuses the whole take.
// v3.5.71 (Ian, 2026-11-10: "prompt: size must be between 0 and 2500" on a prompt we had cut to 2500 characters): fal
// counts bytes, and a dash or a curly quote is three. The fancy punctuation is made plain, and the cut is measured in bytes.
function plainPunct(p) {
  return String(p || '').replace(/[\u2014\u2013\u2012\u2212]/g, '-').replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"').replace(/[\u2018\u2019\u201a]/g, "'").replace(/\u2026/g, '...').replace(/\u00a0/g, ' ');
}
function byteLen(x) {
  return Buffer.byteLength(String(x || ''), 'utf8');
}
// v3.5.72 (Ian, 2026-11-10: still refused on 3.5.71; "we need to not send the general stuff like lore and backstory"): a
// margin under the limit (fal's count can run past ours), and the general lines go first: the overall direction, then the
// surroundings, the sound and the house rules, before the shot's own beats are ever cut.
function fitPrompt(p, max, sound) {
  const PROMPT_MARGIN = 250;
  p = plainPunct(p);
  if (max) max = Math.max(500, max - PROMPT_MARGIN);
  if (!max || byteLen(p) <= max) return p;
  let lines = p.split('\n');
  const drop = [/^Overall:/, /^Around them:/].concat(sound ? [] : [/^Sound:/]).concat([/^Nothing appears or disappears/, /^If a scene picture shows a character/, /^Sound:/]);
  for (let i = 0; i < drop.length && byteLen(lines.join('\n')) > max; i++) { const re = drop[i]; lines = lines.filter(function (l) { return !re.test(l); }); }
  let out = lines.join('\n');
  if (byteLen(out) > max) {
    let cut = max; while (cut > 0 && byteLen(out.slice(0, cut)) > max) cut -= Math.max(1, Math.ceil((byteLen(out.slice(0, cut)) - max) / 3));
    out = out.slice(0, cut); const k = Math.max(out.lastIndexOf('. '), out.lastIndexOf('.\n')); if (k > cut * 0.6) out = out.slice(0, k + 1);
  }
  console.log('[video] prompt fitted: ' + byteLen(p) + ' bytes to ' + byteLen(out) + ' (limit ' + max + ')');
  return out;
}
// What one move sends to fal: each model names its pictures and its length its own way.
function buildInput(m, prompt, startUrl, endUrl, duration, sound, images) {
  const input = Object.assign({}, m.extra);
  if (prompt) input.prompt = m.maxPrompt ? fitPrompt(prompt, m.maxPrompt, sound) : prompt;   // v3.5.44
  let endpoint = m.endpoint;
  if (m.reference) input[m.refsField || 'image_urls'] = (images && images.length ? images : [startUrl]).slice(0, m.maxRefs || REF_MAX_IMAGES);   // v3.5.16; v3.5.42 the model's own limit; v3.5.82 its own field name
  if (m.reference && m.tag && input.prompt) input.prompt = input.prompt.replace(/@Image(\d+)/g, function (x, n) { return m.tag(Number(n)); });   // v3.5.82: how this model names a picture
  else if (endUrl) { input[m.start] = startUrl; input[m.end] = endUrl; }
  else if (m.single) { endpoint = m.single.endpoint; input[m.single.start] = startUrl; }
  else input[m.start] = startUrl;
  // v3.5.82: a length the model does not make (Wan 2.7 Reference stops at 10 s) goes to the nearest one it does
  input.duration = m.durationValue(m.durations.indexOf(String(duration)) >= 0 ? duration : (snapDuration(m, parseFloat(duration)) || m.defDuration));
  if (m.audioField !== null) input[m.audioField || 'generate_audio'] = !!sound;   // v3.5.82: some name it 'audio', some have no switch
  return { endpoint: endpoint, input: input };
}

// Make one shot: a new take (it becomes the chosen one), its moves sent to fal side by side. One take of a shot is made
// at a time (a partial unique index is the claim). Returns { take } or { status, error }.
async function takesFull(db, shotId, max) {   // v3.5.89: max = maxTakes(req)
  const c = await db.prepare('SELECT COUNT(*) AS n FROM takes WHERE shot_id = ?').get(shotId);
  return Number(c && c.n) >= max;
}
async function makeShot(db, req, ep0, shot, shotNo) {
  const ep = epForShot(ep0, shot);   // v3.5.34: the shot's own mode
  const m = MODELS[ep.model];
  const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shot.id);
  const cast = m && m.reference ? await castRefs(db, ep, true) : null;
  const pool = m && m.reference ? await refsPool(db, ep) : null;   // v3.5.22
  try { ep.castNames = ((cast || await castRefs(db, ep, true)).all || []).map(function (c) { return c.name; }).filter(Boolean); } catch (e) { ep.castNames = []; }   // v3.5.47: who leaves, by name
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
  if (await takesFull(db, shot.id, maxTakes(req))) return { status: 409, full: true, error: 'Shot ' + shotNo + ' already has ' + maxTakes(req) + ' takes. Delete one to make another.' };
  const hook = webhookUrl();
  if (!hook) return { status: 500, error: 'PUBLIC_BASE_URL is not set, so fal cannot report back.' };
  const sound = !!ep.sound;
  const cost = Math.round(plan.moves.reduce(function (t, x) { return t + estCost(m, x.duration, sound); }, 0) * 10000) / 10000;
  const tokens = await takeTokens(db, cost);   // v3.5.46
  const tf = await tokensFree(db, req.session.userId);
  if (tf.free < tokens) return tokensShort(tokens, tf, 'Shot ' + shotNo + '\u2019s take');
  const directions = JSON.stringify({ overall: ep.overall || '', style: ep.style, moves: plan.moves.map(function (x) { return { own: x.own, duration: x.duration, images: x.images || undefined, cast: x.cast || undefined }; }) });
  const ins = await db.prepare("INSERT INTO takes (episode_id, shot_id, user_id, status, model, sound, sig, directions, est_cost_usd, tokens) VALUES (?, ?, ?, 'making', ?, ?, ?, ?, ?, ?) ON CONFLICT (shot_id) WHERE status = 'making' DO NOTHING")
    .run(ep.id, shot.id, req.session.userId, ep.model, sound, shotSig(ep0, kfs, shot), directions, cost, tokens);   // v3.5.34: signed as the episode reads it; v3.5.46 tokens
  if (!ins.lastInsertRowid) return { status: 409, error: 'Shot ' + shotNo + ' is already being made.' };
  const takeId = ins.lastInsertRowid;
  // v3.5.96 (Ian, 2026-11-12: "don't assume that the newest video should be the pinned take"): a new take is pinned only when the
  // shot has no finished pinned take; otherwise the pin stays where the person put it.
  await db.prepare("UPDATE shots SET chosen_take_id = ? WHERE id = ? AND (chosen_take_id IS NULL OR NOT EXISTS (SELECT 1 FROM takes t WHERE t.id = shots.chosen_take_id AND t.status = 'done'))").run(takeId, shot.id);
  try {   // v3.5.92: the shot as it was when this take was made, for the take's Info
    await db.prepare('UPDATE takes SET words_at = ? WHERE id = ?').run(JSON.stringify({ name: shot.name || '', purpose: shot.purpose || '', concept: shot.concept || '', shot_model: shotModel(shot), shot_mode: shotMode(shot),
      words: shotWords(shot) || legacyWords(kfs, m), pictures: kfs.map(function (k) { return { url: k.image_url, label: k.label || '' }; }), overall: ep.overall || '', style: ep.style || '' }), takeId);
  } catch (e) { console.warn('[video] take ' + takeId + ': could not keep the words: ' + (e && e.message)); }
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
    const big = await enlargeSmallPictures(x.bi.input);   // v3.5.56
    if (big.length) vlDebug(req.session.userId, 'info', 'makeShot', 'Shot ' + shotNo + ': ' + big.length + ' small picture(s) sent enlarged', { pictures: big });
    try { await db.prepare('UPDATE moves SET sent_input = ? WHERE id = ?').run(JSON.stringify({ endpoint: x.bi.endpoint, input: x.bi.input }), x.id); } catch (e) {}   // v3.5.92: exactly what fal is sent
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
    if (await runningWriter(db, ep.id, true)) return res.status(409).json({ error: 'The shot list is being written; make the shot when it is done.' });
    const r = await makeShot(db, req, ep, shot, shot.position);
    const out = await loadEpisode(db, ep.id);
    if (r.error) return res.status(r.status).json({ error: r.error, message: r.message, episode: out });   // v3.5.46 message
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
    if (await runningWriter(db, ep.id, true)) return res.status(409).json({ error: 'The shot list is being written; make the shots when it is done.' });
    const shots = await db.prepare('SELECT s.*, t.status AS chosen_status FROM shots s LEFT JOIN takes t ON t.id = s.chosen_take_id WHERE s.episode_id = ? ORDER BY s.position, s.id').all(ep.id);
    if (!shots.length) return res.status(400).json({ error: 'This episode has no keyframes.' });
    // Check every shot first, so a missing word in shot 5 does not leave shots 1 to 4 made and the rest not.
    const full = {};   // v3.5.15: shots that already have MAX_TAKES takes are skipped, and named
    let need = 0;
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].chosen_status === 'done' || shots[i].chosen_status === 'making') continue;
      if (await takesFull(db, shots[i].id, maxTakes(req))) { full[i] = true; continue; }
      const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shots[i].id);
      const p = planShot(epForShot(ep, shots[i]), kfs, shots[i], i + 1, null);   // v3.5.16; v3.5.19; v3.5.34: the shot's mode
      if (p.error) return res.status(400).json({ error: p.error });
      const pm = MODELS[epForShot(ep, shots[i]).model];   // v3.5.46: what they all cost together
      need += await takeTokens(db, p.moves.reduce(function (t, x) { return t + estCost(pm, x.duration, !!ep.sound); }, 0));
    }
    const tfAll = await tokensFree(db, req.session.userId);
    if (need && tfAll.free < need) { const sh = tokensShort(need, tfAll, 'Making these shots'); return res.status(402).json({ error: sh.error, message: sh.message }); }
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
    const fullText = skipped.length ? (skipped.length === 1 ? 'Shot ' + skipped[0] + ' already has ' : 'Shots ' + skipped.join(', ') + ' already have ') + maxTakes(req) + ' takes, so ' + (skipped.length === 1 ? 'it was' : 'they were') + ' skipped. Delete a take to make another.' : '';
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
    await maybeJoinEpisode(db, ep.id, true);
    res.json({ episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not join it again.' });
  }
});
// v3.5.58 -- a missing shot created or dismissed: ticked off Create Shots' list.
router.post('/episodes/:id/missing/:k/done', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    let list = []; try { list = JSON.parse(ep.missing_shots || '[]') || []; } catch (e) { list = []; }
    const k = parseInt(req.params.k, 10);
    list.forEach(function (x) { if (x.id === k) x.done = true; });
    await db.prepare('UPDATE episodes SET missing_shots = ? WHERE id = ?').run(JSON.stringify(list), ep.id);
    res.json({ episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    res.status(500).json({ error: 'Could not update the list.' });
  }
});
// v3.5.57 -- COMPILE: the pinned take of every shot, with their trims and the transitions, into the episode video.
router.post('/episodes/:id/compile', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/compile';
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canChange(req, ep))) return vlRefuse(req, res, FN, 404, 'Not found.');
    if (ep.join_status === 'running' || ep.join_status === 'saving') return res.json({ episode: await loadEpisode(db, ep.id), message: 'The episode is already being put together.' });
    const shots = await db.prepare('SELECT s.id, t.status, t.video_url FROM shots s LEFT JOIN takes t ON t.id = s.chosen_take_id WHERE s.episode_id = ? ORDER BY s.position, s.id').all(ep.id);
    if (!shots.length) return vlRefuse(req, res, FN, 409, 'This episode has no shots yet.');
    const missing = []; shots.forEach(function (s, i) { if (!(s.status === 'done' && s.video_url)) missing.push(i + 1); });
    if (missing.length) return vlRefuse(req, res, FN, 409, (missing.length === 1 ? 'Shot ' + missing[0] + ' has' : 'Shots ' + missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] + ' have') + ' no finished pinned take yet. Pin a finished take in every shot, then compile.');
    await db.prepare("UPDATE episodes SET join_status = NULL, join_error = NULL, join_request_id = NULL, updated_at = NOW() WHERE id = ? AND join_status = 'error'").run(ep.id);
    await maybeJoinEpisode(db, ep.id, true);
    vlDebug(req.session.userId, 'info', FN, 'Compile asked for (' + shots.length + ' shot(s))', {});
    const out = await loadEpisode(db, ep.id);
    res.json({ episode: out, message: out && out.video_current ? 'The episode video is up to date.' : 'Putting the episode together...' });
  } catch (e) {
    console.error('[video] compile error:', e && e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not put the episode together.' });
  }
});
// A take whose join failed: join its moves again.
// v3.5.54 -- TRIM A TAKE (Ian, 2026-11-09: the end at trim, "the more options the better"). The part of a done take the
// episode uses: start and end in seconds (null: from the start / to the end). The take's file is never changed.
router.post('/takes/:id/trim', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/takes/' + req.params.id + '/trim';
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canChange(req, x.ep))) return vlRefuse(req, res, FN, 404, 'Not found.');
    if (x.t.status !== 'done') return vlRefuse(req, res, FN, 409, 'Only a finished take can be trimmed.');
    const moves = await db.prepare('SELECT duration FROM moves WHERE take_id = ?').all(x.t.id);
    const len = takeSecs(moves) || 15;
    const b = req.body || {};
    let st = b.start == null || b.start === '' ? null : Number(b.start), en = b.end == null || b.end === '' ? null : Number(b.end);
    if ((st != null && !isFinite(st)) || (en != null && !isFinite(en))) return vlRefuse(req, res, FN, 400, 'Give the start and end in seconds.');
    if (st != null) st = Math.round(Math.max(0, Math.min(st, len)) * 100) / 100;
    if (en != null) en = Math.round(Math.max(0, Math.min(en, len + 0.5)) * 100) / 100;
    if (st === 0) st = null;
    if ((st || 0) + 1 > (en == null ? len : en)) return vlRefuse(req, res, FN, 400, 'Keep at least 1 second of the take.');
    await db.prepare('UPDATE takes SET trim_start = ?, trim_end = ?, updated_at = NOW() WHERE id = ?').run(st, en, x.t.id);
    vlDebug(req.session.userId, 'info', FN, 'Take ' + x.t.id + ' trimmed to ' + (st || 0) + '-' + (en == null ? 'end' : en) + ' s', { length: len });
    await maybeJoinEpisode(db, x.ep.id);
    res.json({ episode: await loadEpisode(db, x.ep.id) });
  } catch (e) {
    console.error('[video] trim error:', e && e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Could not trim the take.' });
  }
});
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
// v3.5.52 (Ian, 2026-11-09: "i put the same picture in the sequence... When I did that it retouched both of them"). The
// keyframe pressed, found by its shot and its place in it: [id, url] when this episode shows its picture more than once,
// else null (one keyframe, or none named: the old way, by picture).
async function pressedKeyframe(db, ep, url, b) {
  const shotId = parseInt(b && b.shot_id, 10), ki = parseInt(b && b.kf_index, 10);
  if (!shotId || !(ki >= 0)) return null;
  const n = await db.prepare('SELECT COUNT(*) AS n FROM keyframes WHERE episode_id = ? AND image_url = ?').get(ep.id, url);
  if (Number(n && n.n) < 2) return null;
  const all = await db.prepare('SELECT id, image_url FROM keyframes WHERE episode_id = ? AND shot_id = ? ORDER BY position, id').all(ep.id, shotId);
  const k = all[ki];
  return k && k.image_url === url ? k : null;
}
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
    // v3.5.52 -- the same picture on more than one keyframe: the one pressed gets its own copy first, and the copy is retouched
    let target = url;
    const pk = await pressedKeyframe(db, ep, url, b);
    if (pk) {
      let c;
      try { c = await require('./images').copyPicture(url); }
      catch (e) { return vlRefuse(req, res, FN, 400, e && e.userFacing ? e.message : 'Could not retouch that keyframe on its own. Please try again.', { error: e && e.message }); }
      await db.prepare('UPDATE keyframes SET image_url = ? WHERE id = ? AND image_url = ?').run(c.url, pk.id, url);
      target = c.url;
      vlDebug(req.session.userId, 'info', FN, 'The picture is on more than one keyframe: the one pressed got its own copy', { from: vlShortUrl(url), copy: vlShortUrl(c.url), keyframe: pk.id });
    }
    const out = await require('./images').startKeyframeRetouch(db, { refs: refs, userId: req.session.userId, campaignId: ep.campaign_id, episodeId: ep.id, imageUrl: target,
      momentId: kf.moment_id || null, shape: shape, style: style, forceShape: expand ? 'wide' : null,
      instruction: expand ? EXPAND_INSTRUCTION : b.instruction, markedUrl: expand ? null : b.marked_url, refName: expand ? null : b.ref_name });
    if (out.error) return res.status(out.error === 'INSUFFICIENT_TOKENS' ? 402 : 400).json(out);
    vlDebug(req.session.userId, 'info', FN, 'Keyframe retouch started (job ' + out.job_id + ')', { url: vlShortUrl(url), moment_id: kf.moment_id, archive_id: kf.archive_id, art_style: style, shot_refs: refs ? refs.map(function (r) { return r.name; }) : null });
    res.json({ job_id: out.job_id, image_url: target });
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
    const pk = await pressedKeyframe(db, ep, url, req.body);   // v3.5.52: only the keyframe pressed, when the picture is on more than one
    const r = pk ? await db.prepare('UPDATE keyframes SET image_url = ?, prev_image_url = ? WHERE id = ? AND image_url = ?').run(m.url, url, pk.id, url)
      : await db.prepare('UPDATE keyframes SET image_url = ?, prev_image_url = ? WHERE episode_id = ? AND image_url = ?').run(m.url, url, ep.id, url);
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
      out.push(r.kind === 'asset' ? n + ' is ' + r.name + (r.height ? ', ' + r.height : '') + ': it must look like ' + n + ' whenever it is on screen.' : n + ' is ' + r.name + ': ' + r.name + '\'s face, hair, build, clothes and gear must match ' + n + ' whenever ' + r.name + ' is on screen.');   // v3.5.61 an NPC's height
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
    if (await runningWriter(db, x.ep.id, true)) return vlRefuse(req, res, FN, 409, 'The Director is working on this episode; retouch the take when it is done.');
    const shot = await db.prepare('SELECT * FROM shots WHERE id = ?').get(x.t.shot_id);
    if (await takesFull(db, shot.id, maxTakes(req))) return vlRefuse(req, res, FN, 409, 'This shot already has ' + maxTakes(req) + ' takes. Delete one to make another.');
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
    const tokens = await takeTokens(db, cost);   // v3.5.46
    const tfR = await tokensFree(db, req.session.userId);
    if (tfR.free < tokens) { const sh = tokensShort(tokens, tfR, 'This retouch'); return res.status(402).json({ error: sh.error, message: sh.message }); }
    const directions = JSON.stringify({ retouch: { from: x.t.id, kind: kind, text: text, refs: refs.map(function (r) { return r.name; }) } });
    const ins = await db.prepare("INSERT INTO takes (episode_id, shot_id, user_id, status, model, sound, sig, directions, est_cost_usd, source_take_id, retouch_text, retouch_kind, tokens) VALUES (?, ?, ?, 'making', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (shot_id) WHERE status = 'making' DO NOTHING")
      .run(x.ep.id, shot.id, req.session.userId, x.t.model, sound, x.t.sig, directions, cost, x.t.id, text, kind, tokens);
    if (!ins.lastInsertRowid) return vlRefuse(req, res, FN, 409, 'A take of this shot is already being made.');
    const takeId = ins.lastInsertRowid;
    const mv = await db.prepare('INSERT INTO moves (take_id, episode_id, position, start_url, end_url, prompt, model, endpoint, duration, sound, status, est_cost_usd) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?)')
      .run(takeId, x.ep.id, x.t.video_url, prompt, 'retouch-' + kind, R.endpoint, duration, sound, 'queued', cost);
    vlDebug(req.session.userId, 'info', FN, 'Retouch of take ' + x.t.id + ' (' + R.label + ', ' + R.endpoint + ') as take ' + takeId, { kind: kind, seconds: secs, est_cost_usd: cost,
      video: vlShortUrl(x.t.video_url), refs: refs.map(function (r) { return { name: r.name, kind: r.kind, url: vlShortUrl(r.url) }; }), input: Object.assign({}, input, { prompt: undefined }), prompt: prompt });
    const bigR = await enlargeSmallPictures(input);   // v3.5.56
    if (bigR.length) vlDebug(req.session.userId, 'info', FN, bigR.length + ' small picture(s) sent enlarged', { pictures: bigR });
    try { await db.prepare('UPDATE moves SET sent_input = ? WHERE id = ?').run(JSON.stringify({ endpoint: R.endpoint, input: input }), mv.lastInsertRowid); } catch (e) {}   // v3.5.92
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
// v3.5.92 -- A TAKE'S INFO (Ian, 2026-11-12: model, mode, tokens, prompt sent, prompt used, references... "Everything we know
// about the video"; for everyone for now, failed takes too). Read only; the page lays it out.
// v3.5.99 -- WHAT THE STORY SAYS ABOUT EACH SHOT (Ian, 2026-11-12: "a way to view what the story currently says about this shot.
// The story is getting fed into the shots but I don't think the user can see the details anywhere"). Read only, nothing charged.
// Each picture: its title, what it shows, and its text in the story before and after it (what the Director reads with the
// whole story). A shot with no story pictures gets the story where it sits: after the last story picture before it, before
// the first one after it (the opening or the closing at the ends). Never sent to the video model.
async function shotStories(db, ep) {
  const shots = await db.prepare('SELECT id FROM shots WHERE episode_id = ? ORDER BY position, id').all(ep.id);
  const kfs = await db.prepare('SELECT shot_id, source, moment_id, label FROM keyframes WHERE episode_id = ? ORDER BY shot_id, position, id').all(ep.id);
  const story = await storyOfVersion(db, ep.fork_id);
  const byId = {}; story.moments.forEach(function (mo) { byId[mo.id] = mo; });
  const out = shots.map(function (s) {
    const pictures = kfs.filter(function (k) { return k.shot_id === s.id; }).map(function (k) {
      if (k.source === 'title') return { kind: 'title', title: 'The title picture' };
      const mo = k.moment_id ? byId[k.moment_id] : null;
      if (!mo) return { kind: 'archive', title: textOf(k.label) || 'A picture from the Archive' };
      return { kind: 'story', title: textOf(mo.title) || 'Untitled', shows: textOf(mo.description), before: story.byMoment[mo.id] || '', after: story.afterByMoment[mo.id] || '' };
    });
    return { id: s.id, pictures: pictures };
  });
  function storyPics(s) { return s.pictures.filter(function (p) { return p.kind === 'story'; }); }
  out.forEach(function (s, i) {
    if (storyPics(s).length) return;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0 && !prev; j--) { const st = storyPics(out[j]); if (st.length) prev = st[st.length - 1]; }
    for (let j = i + 1; j < out.length && !next; j++) { const st = storyPics(out[j]); if (st.length) next = st[0]; }
    s.gap = { after_title: prev ? prev.title : '', after: prev ? prev.after : story.intro, before_title: next ? next.title : '', before: next ? next.before : story.outro };
  });
  return { shots: out, has_story: !!story.text };
}
router.get('/episodes/:id/shot-story', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!ep || !(await canSee(req, ep))) return res.status(404).json({ error: 'Not found.' });
    res.json(await shotStories(db, ep));
  } catch (e) {
    console.error('[video] shot story error:', e && e.message);
    res.status(500).json({ error: 'Could not read the story.' });
  }
});
router.get('/takes/:id/info', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !(await canSee(req, x.ep))) return res.status(404).json({ error: 'That take is not there any more.' });
    const t = x.t;
    const sh = await db.prepare('SELECT id, position, name FROM shots WHERE id = ?').get(t.shot_id);
    const mvs = await db.prepare('SELECT * FROM moves WHERE take_id = ? ORDER BY position, id').all(t.id);
    const tm = MODELS[t.model];
    const made = t.retouch_kind ? (t.retouch_kind === 'small' ? 'Kling O1 Edit (Small fix retouch)' : 'Seedance 2.0 (Bigger change retouch)') : null;
    let maker = null; try { const u = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(t.user_id); maker = u ? (u.name || u.email || null) : null; } catch (e) { maker = null; }
    res.json({
      take: { id: t.id, status: t.status, model: t.model, model_label: made || (tm ? tm.label : t.model), mode: made ? 'Retouch' : (tm ? (tm.reference ? 'Reference' : 'Keyframes') : ''),
        sound: !!t.sound, tokens: t.tokens, tokens_charged: t.tokens_charged, est_cost_usd: req.vlAdmin ? t.est_cost_usd : undefined, error: t.merge_error || t.error || null,   // v3.5.94: dollars for admins only
        created_at: t.created_at, finished_at: t.finished_at, trim_start: t.trim_start, trim_end: t.trim_end, made_by: maker,
        source_take_id: t.source_take_id, retouch_kind: t.retouch_kind, retouch_text: t.retouch_text, video_url: t.video_url,
        directions: parseJson(t.directions, null), words_at: parseJson(t.words_at, null) },
      shot: sh ? { id: sh.id, position: sh.position, name: sh.name || '' } : null,
      episode: { id: x.ep.id, name: x.ep.name || '' },
      moves: mvs.map(function (m) { return { position: m.position, model: m.model, endpoint: m.endpoint, duration: m.duration, sound: !!m.sound, status: m.status, request_id: m.request_id,
        error: m.error, est_cost_usd: req.vlAdmin ? m.est_cost_usd : undefined, file_size: m.file_size, submitted_at: m.submitted_at, finished_at: m.finished_at, start_url: m.start_url, end_url: m.end_url,
        prompt: m.prompt, sent: parseJson(m.sent_input, null), used_prompt: m.used_prompt || null }; })
    });
  } catch (e) {
    console.error('[video] take info error:', e && e.message);
    res.status(500).json({ error: 'Could not read the take.' });
  }
});
router.get('/takes/:id/download', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const x = await takeAndEpisode(db, parseInt(req.params.id, 10));
    if (!x.ep || !x.t.video_url || !(await canSee(req, x.ep))) return res.status(404).json({ error: 'That take has no video.' });
    const sh = await db.prepare('SELECT position FROM shots WHERE id = ?').get(x.t.shot_id);
    // v3.5.84 (Ian, 2026-11-11: "When I download a video.. it has the model and mode in the name on it too"): e.g.
    // "Third Go Episode (shot 3, take 57, Kling O3 Pro, Keyframes).mp4"; a retouch says which kind
    const tm = MODELS[x.t.model];
    const made = x.t.retouch_kind ? (x.t.retouch_kind === 'small' ? 'Kling O1 Edit, retouch' : 'Seedance 2.0, retouch') : (tm ? tm.label + ', ' + (tm.reference ? 'Reference' : 'Keyframes') : '');
    // v3.5.95 (Ian, 2026-11-12): named by the take's code, e<episode id>s<shot>t<take on the card>-<take id, 4 digits>-<date made>,
    // then the model and mode, e.g. "e6s2t8-0077-2026-11-12 MiniMax H3 Max Reference.mp4". The page sends its code (the date in the
    // person's own time zone); it is used only when its episode, shot, take and id are this take's.
    const nRow = await db.prepare('SELECT COUNT(*) AS n FROM takes WHERE shot_id = ? AND id <= ?').get(x.t.shot_id, x.t.id);
    const want = 'e' + x.ep.id + 's' + (sh ? sh.position : 0) + 't' + (Number(nRow && nRow.n) || 1) + '-' + String(x.t.id).padStart(4, '0') + '-';
    const sent = String(req.query.code || '');
    const code = (sent.indexOf(want) === 0 && /^\d{4}-\d{2}-\d{2}$/.test(sent.slice(want.length))) ? sent : want + new Date(x.t.created_at || Date.now()).toISOString().slice(0, 10);
    await sendVideo(res, x.t.video_url, code + (made ? ' ' + made.replace(/,/g, '') : '') + '.mp4');
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
    if (typeof data.expanded_prompt === 'string' && data.expanded_prompt) { try { await db.prepare('UPDATE moves SET used_prompt = ? WHERE id = ?').run(data.expanded_prompt.slice(0, 20000), mv.id); } catch (e) {} }   // v3.5.92: the model's own rewrite, when it made one
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
  const mvs = await db.prepare('SELECT id, status, video_url, error FROM moves WHERE take_id = ? ORDER BY position, id').all(takeId);   // v3.5.44: error, for the take's message
  if (!mvs.length) return;
  if (mvs.some(function (m) { return m.status !== 'done' && m.status !== 'error'; })) return;
  if (mvs.some(function (m) { return m.status === 'error'; })) {
    const bad = mvs.filter(function (m) { return m.status === 'error'; })[0];
    await db.prepare("UPDATE takes SET status = 'error', error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'making'").run(('A part of this take failed at fal' + (bad && bad.error ? ': ' + falReason(bad.error) : '.')).slice(0, 600), takeId);   // v3.5.44: fal's own reason
    return;
  }
  if (mvs.length === 1) {
    const r = await db.prepare("UPDATE takes SET video_url = ?, status = 'done', merge_status = 'single', finished_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'making'").run(mvs[0].video_url, takeId);
    if (r.changes) await chargeTake(db, takeId);   // v3.5.46
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
  if (falResult && Buffer.isBuffer(falResult.buffer)) return falResult.buffer;   // v3.5.54: joined on our own server
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
    await chargeTake(db, t.id);   // v3.5.46
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
// v3.5.57 (Ian, 2026-11-09: "a button below All the Shots called Compile all Shots Together... that creates the Final
// Episode video"; joining only on the button). Every other caller is a no-op now; only Compile (and Join again) joins.
async function maybeJoinEpisode(db, episodeId, compile) {
  if (!compile) return;
  const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!ep || ep.join_status === 'running' || ep.join_status === 'saving') return;
  const shots = await db.prepare('SELECT s.id, s.chosen_take_id, s.cut_style, t.status, t.video_url, t.trim_start, t.trim_end FROM shots s LEFT JOIN takes t ON t.id = s.chosen_take_id WHERE s.episode_id = ? ORDER BY s.position, s.id').all(episodeId);
  if (!shots.length || !shots.every(function (s) { return s.status === 'done' && s.video_url; })) return;
  const sig = joinSig(shots);   // v3.5.54
  if (ep.video_sig === sig && ep.video_url) return;
  if (ep.join_status === 'error' && ep.join_sig === sig) return;   // the same join failed: Join again asks for it (a new take tries by itself)
  if (needsLocalJoin(shots)) return void await startLocalJoin(db, ep, shots, sig);   // v3.5.54: transitions or trims, on our own server
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
// v3.5.54 -- THE JOIN ON OUR OWN SERVER (spec claude/VIDEO_TRANSITIONS_SPEC.md): trims and transitions with ffmpeg. One
// join at a time in this process; join_request_id 'local' marks it, and the sweep ends one this process no longer has.
const LOCAL_JOINS = {};
let _joinQueue = Promise.resolve();
const LOCAL_JOIN_TIMEOUT_MS = 10 * 60 * 1000;
function r3(x) { return Math.round(x * 1000) / 1000; }
function runTool(cmd, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    require('child_process').execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, function (err, out, errOut) {
      if (err) return reject(new Error(cmd + ' failed: ' + String(errOut || err.message || '').trim().split('\n').slice(-3).join(' ').slice(0, 600)));
      resolve(String(out || ''));
    });
  });
}
async function probeClip(file) {
  const j = JSON.parse(await runTool('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file], 60000));
  const v = (j.streams || []).filter(function (s) { return s.codec_type === 'video'; })[0];
  if (!v) throw new Error('a take has no video stream');
  return { dur: Number(j.format && j.format.duration) || 0, w: Number(v.width) || 1280, h: Number(v.height) || 720, audio: (j.streams || []).some(function (s) { return s.codec_type === 'audio'; }) };
}
// clips: [{ start, end, audio, cut }] (cut: the style after this clip). The filter for one ffmpeg run, and the length.
function joinFilter(clips, W, H) {
  const parts = [], lens = clips.map(function (c) { return r3(c.end - c.start); });
  const AF = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  clips.forEach(function (c, i) {
    parts.push('[' + i + ':v]trim=start=' + r3(c.start) + ':end=' + r3(c.end) + ',setpts=PTS-STARTPTS,scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,settb=AVTB[v' + i + ']');
    parts.push(c.audio ? '[' + i + ':a]atrim=start=' + r3(c.start) + ':end=' + r3(c.end) + ',asetpts=PTS-STARTPTS,' + AF + '[a' + i + ']'
      : 'anullsrc=r=48000:cl=stereo,atrim=0:' + lens[i] + ',asetpts=PTS-STARTPTS,' + AF + '[a' + i + ']');
  });
  let v = 'v0', a = 'a0', L = lens[0];
  for (let i = 1; i < clips.length; i++) {
    const info = CUT_STYLE_INFO[clips[i - 1].cut] || CUT_STYLE_INFO.instant, nv = 'vj' + i, na = 'aj' + i;
    const d = info.xfade ? r3(Math.min(info.secs, lens[i - 1] / 2, lens[i] / 2)) : 0;
    if (!d) {
      parts.push('[' + v + '][v' + i + ']concat=n=2:v=1:a=0,settb=AVTB[' + nv + ']');
      parts.push('[' + a + '][a' + i + ']concat=n=2:v=0:a=1[' + na + ']');
      L = r3(L + lens[i]);
    } else {
      parts.push('[' + v + '][v' + i + ']xfade=transition=' + info.xfade + ':duration=' + d + ':offset=' + r3(L - d) + '[' + nv + ']');
      parts.push('[' + a + '][a' + i + ']acrossfade=d=' + d + '[' + na + ']');
      L = r3(L + lens[i] - d);
    }
    v = nv; a = na;
  }
  return { filter: parts.join(';'), v: v, a: a, total: L };
}
async function ffmpegJoin(shots) {
  const fs = require('fs'), path = require('path'), os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vljoin-'));
  try {
    const clips = [];
    for (let i = 0; i < shots.length; i++) {
      const f = path.join(dir, 'c' + i + '.mp4');
      fs.writeFileSync(f, await fetchVideo(shots[i].video_url));
      const p = await probeClip(f);
      let st = trimOf(shots[i].trim_start), en = trimOf(shots[i].trim_end);
      st = st == null ? 0 : Math.max(0, Math.min(st, p.dur));
      en = en == null ? p.dur : Math.max(st, Math.min(en, p.dur));
      if (en - st < 0.5) { st = 0; en = p.dur; }
      clips.push({ file: f, start: st, end: en, audio: p.audio, cut: shots[i].cut_style || 'instant', w: p.w, h: p.h });
    }
    const W = clips[0].w - (clips[0].w % 2), H = clips[0].h - (clips[0].h % 2);
    const j = joinFilter(clips, W, H), out = path.join(dir, 'out.mp4');
    const args = ['-y', '-loglevel', 'error'];
    clips.forEach(function (c) { args.push('-i', c.file); });
    args.push('-filter_complex', j.filter, '-map', '[' + j.v + ']', '-map', '[' + j.a + ']', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
    await runTool('ffmpeg', args, LOCAL_JOIN_TIMEOUT_MS);
    return fs.readFileSync(out);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}
async function startLocalJoin(db, ep, shots, sig) {
  const claim = await db.prepare("UPDATE episodes SET join_status = 'running', join_sig = ?, join_error = NULL, join_request_id = 'local', join_started_at = NOW(), updated_at = NOW() WHERE id = ? AND (join_status IS NULL OR join_status = 'done' OR (join_status = 'error' AND join_sig IS DISTINCT FROM ?))").run(sig, ep.id, sig);
  if (!claim.changes) return;
  LOCAL_JOINS[ep.id] = true;
  console.log('[video] episode ' + ep.id + ': joining ' + shots.length + ' shot(s) here with transitions or trims');
  _joinQueue = _joinQueue.then(async function () {
    let buf = null, err = null;
    try { buf = await ffmpegJoin(shots); } catch (e) { err = 'the join on our server failed: ' + (e && e.message); }
    try {
      const fresh = await (await getDb()).prepare('SELECT * FROM episodes WHERE id = ?').get(ep.id);
      if (fresh) await finishEpisodeJoin(fresh, buf ? { buffer: buf } : null, err);
    } catch (e) { console.error('[video] episode ' + ep.id + ' local join could not finish:', e && e.message); }
    delete LOCAL_JOINS[ep.id];
  });
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
    // v3.5.49 (Ian, 2026-11-09: a take failed with only "Unexpected status code: 422"): fal puts its reasons in the payload
    // (detail[].msg) and only the status in error, so both are kept and falReason picks out the reasons.
    const full = failed ? [b.error ? String(b.error) : '', b.payload ? JSON.stringify(b.payload) : ''].filter(Boolean).join(' ') : '';
    const why = failed ? ('fal: ' + [falDetailWhy(full), full].filter(Boolean).join(' ')).slice(0, 1500) : null;   // v3.5.69: the reasons first, before the cut
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
      if (ep.join_request_id === 'local') {   // v3.5.54: ours; one this process no longer has was cut off by a restart
        if (!LOCAL_JOINS[ep.id] && (Date.now() - new Date(ep.join_started_at || ep.updated_at).getTime()) / 60000 > 2) await finishEpisodeJoin(ep, null, 'the join was interrupted (the server restarted); press Join again');
        continue;
      }
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
  const byMoment = {}, afterByMoment = {};   // v3.5.99 afterByMoment
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
    if (after) { parts.push(after); afterByMoment[mo.id] = after; }   // v3.5.99
  });
  if (fork && textOf(fork.narrative_outro)) parts.push(textOf(fork.narrative_outro));
  let text = parts.join('\n\n');
  const hasStory = !!(blocks || (fork && (textOf(fork.narrative_intro) || textOf(fork.narrative_outro))));
  let trimmed = false;
  if (text.length > SL_STORY_CHARS) { text = text.slice(0, SL_STORY_CHARS); trimmed = true; }
  return { fork: fork, moments: moments, text: hasStory ? text : '', byMoment: byMoment, trimmed: trimmed, afterByMoment: afterByMoment, intro: fork ? textOf(fork.narrative_intro) : '', outro: fork ? textOf(fork.narrative_outro) : '' };   // v3.5.99
}
// The structure the writer was given: shots and their keyframes' pictures. If it differs when the answer comes back,
// nothing is filled and nothing is charged.
function structureSig(shots) { return shortSig(JSON.stringify(shots.map(function (s) { return [s.id].concat(s.keyframes.map(function (k) { return k.image_url; })); }))); }
function movesIn(s) { return s.keyframes.length === 1 ? 1 : s.keyframes.length - 1; }
function pictureSig(pictures) { return shortSig(JSON.stringify(pictures.map(function (p) { return p.url; }))); }
// v3.5.23 -- the cuts as they stand: which pictures each shot holds. Director's Notes writes for these cuts and only these.
function cutSig(shots) { return shortSig(JSON.stringify(shots.map(function (s) { return [s.id, s.keyframes.map(function (k) { return k.image_url; })]; }))); }
function withMode(ctx, mode) { const c = Object.assign({}, ctx); c.mode = mode === 'shots' ? 'shots' : 'notes'; if (c.mode === 'notes' && c.allShots) c.shots = c.allShots; c.sig = c.mode === 'shots' ? pictureSig(c.pictures) : cutSig(c.shots); return c; }   // v3.5.58: the notes write every shot, pictures or not
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
  return { ep: ep, m: m, modelKey: ep.model, style: style, story: story, cast: cast, artStyle: artStyle, genres: genres, shots: live, allShots: shots, sig: pictureSig(pictures),   // v3.5.58 allShots: the notes include shots with no pictures yet   // v3.5.20: the pictures in order (the writer re-cuts)
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
      'Give each shot a name of 2 to 5 words and a purpose: one short sentence saying what the shot is for in the story (what the viewer learns or sees happen). Do not write anything else: what happens in each shot is written later.\n\n' +   // v3.5.59 purpose
      // v3.5.58 (Ian, 2026-11-10: "a modal dialog that pops up that tells you which shots it thinks it needs and a button to create each one")
      'THEN LIST THE MISSING SHOTS: moments the story tells between or around the pictures that a video would show and no picture covers, such as getting from one place to another, a talk that decides what happens next, or a scene the pictures skip. Read the story closely for them. At most 6, the most needed first; an empty list only when the story skips nothing. For each: "after" (the number of the shot in your list that it comes after; 0 = before the first shot), "name" (2 to 5 words), "what" (one or two sentences: who does what, where), "why" (one short sentence: what the viewer would miss without it).\n\n' +
      'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
      'ANSWER WITH ONLY THIS JSON, no other text:\n{"shots": [{"pictures": [1, 2], "name": "...", "purpose": "..."}, {"pictures": [3], "name": "...", "purpose": "..."}], "missing": [{"after": 1, "name": "...", "what": "...", "why": "..."}]}\n' +
      '"pictures" lists the picture numbers of the shot. Across all shots they must be exactly 1 to ' + N + ', in order.';
  } else {
    system = directorHead(ctx) +
      'YOUR JOB NOW: the episode is already divided into ' + ctx.shots.length + ' shots, shown below. Keep them exactly as they are and write the Director\'s Notes for each one.\n\n' +
      (ref ? 'HOW THE MODEL USES THE PICTURES\nEach shot is ONE clip. Its first picture is how the shot opens and decides who is there and where: write the start as that picture shows it. Anyone not in it must enter in a beat, through a place the picture shows and with a path ("through the far archway, toward us"), or be revealed by a camera move that names them; a reference picture alone never brings anyone in. Its later pictures only show the place, the light and who is there: the model does NOT copy their poses or positions, so say in the words what happens and how the shot ends. ' +
        'The cast\'s own reference pictures are sent too, so describe what characters DO, not how they look. Those pictures give their looks, not what they must carry: when it matters, say what each one holds ("carries only the stone bowl").\n\n'
        : 'HOW THE MODEL USES THE PICTURES\nA shot of several pictures moves from each picture exactly to the next, so the action must flow through every picture of the shot.\n\n') +
      'THE STYLE OF THIS VIDEO\n' + style.instructions + '\n\n' +
      'FOR EACH SHOT write these, in plain words:\n' +
      '- name: 2 to 5 words naming the shot.\n' +
      '- start: who is where when the shot opens, and which way they face, and anything lying around that must stay in the shot (bodies, fallen weapons, props) as the shot\'s pictures show it: later pictures do not carry them (one to three sentences).\n' +
      '- actions: the shot\'s BEATS. Each item is one beat, either a string (what happens) or {"do": what happens, "camera": what the camera does during this beat, only when it does something then, "sound": a sound heard at this moment, only when there is one, "seconds": the beat\'s length, only when it must be set (a quick look 1.5, a long walk 4); leave it out and the beats share the shot\'s length}. A camera move or a sound tied to one moment goes on its beat; what lasts the whole shot goes in camera, sounds and around.\n' +
      '- actions: what the characters do, in order, one action per item, at most one action for every 2.5 seconds of the shot. Put every movement here: entering, leaving, picking up, turning. Read the shot\'s pictures in order and write what they show being done (crumbling something, pouring, lighting) and every step that gets from one picture to the next: when a later picture shows something an earlier one does not (a tool now in a hand, a person now there, something now lit or open), write the action that brings it in, in its place (for example "He picks up the stone pestle from beside the bowl."), so nothing appears out of thin air. When something is used up or destroyed, say what happens to it ("bursts into glittering dust", "crumbles"), never only that it vanishes or disappears. When someone leaves the frame, say they walk completely out of frame and are gone, give that about 2 seconds, and make the end say the frame is empty of them.\n' +   // v3.5.47
      (style.speech ? '- lines: what they say: {"who": exact cast name, "line": short, "during": the number of the action it is said during (1 = the first), or 0 for any time, "offscreen": true when the speaker is not in view; always name the speaker}. At most two short lines in a shot; an empty list when nobody should talk.\n'
        : '- lines: always an empty list in this style.\n') +
      '- camera: what the camera does across the whole shot (a move tied to one beat goes on that beat). If someone leaves the frame and is needed again, or the camera has to find someone, say how the camera moves to show it.\n' +
      '- end: who is where when the shot ends, and which way they face. Every change in where people are (someone sits back, stands, turns away) happens in a beat; the end only confirms it.\n' +
      '- sounds: sounds only, never actions.\n' +
      '- around: what the surroundings do (smoke, fire, weather, light), never the characters.\n' +
      '- seconds: the shot\'s length, a whole number from 4 to 15.\n\n' +
      'THE OVERALL DIRECTION is sent with every shot: one short paragraph (at most 600 characters) naming the setting, the mood and the light' + (ref ? '' : ', and each main character\'s look in words (build, hair, clothes, colours)') + '. Keep the art style as it is in the pictures.\n\n' +
      'PURPOSE AND CONCEPT (v3.5.99): a shot\'s Purpose (what has to land in the story) and Concept (how it should look and feel) are the user\'s own words. Write the shot to deliver both. Where they and the story disagree, follow the user\'s words.\n\n' +
      'A SHOT WITH NO PICTURES YET was added for a moment the story needs; its first line below says what it is for. Write its notes from that and the story, as for any shot (it gets its pictures later).\n\n' +   // v3.5.58
      'RULES\n- Keep the names exactly as the story and the cast list write them.\n- Each action is at most 300 characters; every other field short.\n- Never describe a cut inside a shot; never move a picture to another shot.\n' +
      '- Write original words; never reproduce text from any published source.\n- Never put words, captions or titles on screen.\n\n' +
      'ANSWER WITH ONLY THIS JSON, no other text, one entry per shot in order:\n' +
      '{"overall": "...", "shots": [{"shot": 1, "name": "...", "start": "...", "actions": ["...", {"do": "...", "camera": "...", "sound": "..."}], "lines": [{"who": "...", "line": "...", "during": 1, "offscreen": false}], "camera": "...", "end": "...", "sounds": "...", "around": "...", "seconds": 10}]}';
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
  function pushPicture(i) {
    content.push({ type: 'text', text: 'Picture ' + (i + 1) + '. ' + ctx.pictures[i].words });
    if (images[i]) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[i] } });
  }
  if (ctx.mode === 'shots') ctx.pictures.forEach(function (p, i) { pushPicture(i); });
  else {   // v3.5.58: shot by shot, a shot with no pictures yet by what it is for
    let i = 0;
    ctx.shots.forEach(function (sh, si) {
      const n = sh.keyframes.length, first = i + 1, last = i + n;
      if (!n) {
        const why = [textOf(sh.start_text), (function () { try { return (JSON.parse(sh.actions || '[]') || []).join(' '); } catch (e) { return ''; } })()].filter(Boolean).join(' ').slice(0, 800);
        content.push({ type: 'text', text: (si ? '--- CUT ---\n' : '') + 'SHOT ' + (si + 1) + (sh.name ? ' ("' + sh.name + '")' : '') + ': NO PICTURES YET. It is for: ' + ([textOf(sh.purpose), why].filter(Boolean).join(' ') || 'a moment the story needs here') + (textOf(sh.concept) ? ' Its concept (how it should look and feel): ' + textOf(sh.concept) : '') });   // v3.5.99 concept
        return;
      }
      content.push({ type: 'text', text: (si ? '--- CUT ---\n' : '') + 'SHOT ' + (si + 1) + (sh.name ? ' ("' + sh.name + '")' : '') + ': picture' + (first === last ? ' ' + first : 's ' + first + ' to ' + last) + '.' + (textOf(sh.purpose) ? ' Its purpose: ' + textOf(sh.purpose) : '') + (textOf(sh.concept) ? ' Its concept (how it should look and feel): ' + textOf(sh.concept) : '') });   // v3.5.59; v3.5.99 concept
      for (let k = 0; k < n; k++) pushPicture(i + k);
      i += n;
    });
  }
  content.push({ type: 'text', text: ctx.mode === 'shots' ? 'Now divide these ' + N + ' pictures into shots, as JSON.'
    : 'Now write the Director\'s Notes for these ' + ctx.shots.length + ' shots, as JSON, in the ' + style.label + ' style.' });
  return { system: system, content: content, max_tokens: ctx.mode === 'shots' ? Math.min(5000, 1400 + N * 80) : Math.min(16000, 1500 + (N + ctx.shots.filter(function (s) { return !s.keyframes.length; }).length * 2) * 520) };   // v3.5.58: room for the missing shots
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
  // v3.5.64 -- TD-1121 phase 2: an action may come as a beat {"do", "camera", "sound", "seconds"}
  const items = (Array.isArray(x.actions) ? x.actions : [x.actions]).map(function (a) {
    if (a && typeof a === 'object') return { a: textOf(a.do != null ? a.do : (a.action != null ? a.action : a.text)), camera: textOf(a.camera), sound: textOf(a.sound), secs: parseFloat(a.seconds) || null };
    return { a: textOf(a), camera: '', sound: '', secs: null };
  }).filter(function (it) { return it.a; });
  const actions = items.map(function (it) { return it.a; });
  const beats = items.map(function (it) { return { camera: it.camera, sound: it.sound, secs: it.secs }; });
  let lines = [];
  if (ctx.style.speech && Array.isArray(x.lines)) lines = x.lines.map(function (l) {
    l = l || {};
    let who = textOf(l.who);
    const off = !!l.offscreen || /off-?screen/i.test(who);
    who = who.replace(/\s*\(off-?screen\)\s*/i, '').trim();
    return { who: who, text: textOf(l.line != null ? l.line : l.text), when: parseInt(l.during != null ? l.during : l.when, 10) || 0, off: off };
  });
  return cleanWords({ start: textOf(x.start), actions: actions, beats: beats, lines: lines, camera: textOf(x.camera), end: textOf(x.end), sounds: textOf(x.sounds), around: textOf(x.around), seconds: parseFloat(String(x.seconds == null ? '' : x.seconds).replace(/[^0-9.]/g, '')) });
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
    shots.push({ pictures: pics, name: cleanShotName(textOf(x.name)), purpose: cleanPurpose(textOf(x.purpose)), words: null });   // v3.5.59 purpose
  }
  if (next !== N + 1) return { error: 'the shots cover ' + (next - 1) + ' of ' + N + ' pictures' };
  return { overall: null, shots: shots, missing: cleanMissing(p.missing, shots.length) };   // v3.5.58
}
function cleanMissing(list, nShots) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 6).map(function (x) {
    x = x || {};
    const after = Math.max(0, Math.min(nShots, parseInt(x.after, 10) || 0));
    const what = textOf(x.what).slice(0, 600);
    return { after: after, name: cleanShotName(textOf(x.name)) || 'New shot', what: what, why: textOf(x.why).slice(0, 300) };
  }).filter(function (x) { return x.what; });
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
// v3.5.37 (Ian, 2026-11-09): editsOk -- the Pre-production check only reads the shots, so saving, making and retouching
// go on while it runs; only Create Shots and the Director's Notes (which rewrite the shots) lock the episode.
async function runningWriter(db, episodeId, editsOk) {
  await retireLostJobs(db, episodeId);
  return db.prepare("SELECT id FROM episode_writer_jobs WHERE episode_id = ? AND status = 'running'" + (editsOk ? " AND kind IS DISTINCT FROM 'precheck'" : '') + ' LIMIT 1').get(episodeId);
}
// v3.5.43 -- start a Director job if its lane is free: an episode-wide job only when nothing runs; a check of one shot
// only when no episode-wide job runs and that shot is not already being checked. Returns { id } or { busy: message }.
async function claimWriterJob(db, epId, shotId, row) {
  let out = null;
  await db.transaction(async function (tx) {
    await tx.prepare('SELECT id FROM episodes WHERE id = ? FOR UPDATE').get(epId);
    const running = await tx.prepare("SELECT id, shot_id FROM episode_writer_jobs WHERE episode_id = ? AND status = 'running'").all(epId);
    if (!shotId && running.length) { out = { busy: running.some(function (r) { return r.shot_id; }) ? 'The Director is checking shots on this episode. Try again when those checks are done.' : 'The Director is already working on this episode.' }; return; }
    if (shotId && running.some(function (r) { return !r.shot_id; })) { out = { busy: 'The Director is already working on this episode.' }; return; }
    if (shotId && running.some(function (r) { return Number(r.shot_id) === Number(shotId); })) { out = { busy: 'That shot is already being checked.' }; return; }
    const ins = await tx.prepare("INSERT INTO episode_writer_jobs (episode_id, user_id, status, style, model, boot_id, sig, est_tokens, kind, shot_id) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)")
      .run(epId, row.user_id, row.style, row.model, SL_BOOT, row.sig, row.est_tokens, row.kind, shotId || null);
    out = { id: ins.lastInsertRowid };
  });
  return out || { busy: 'The Director is already working on this episode.' };
}
function jobView(j) {
  if (!j) return null;
  return { id: j.id, kind: j.kind === 'shots' ? 'shots' : (j.kind === 'precheck' ? 'precheck' : 'notes'), status: j.status, error: j.error || null, tokens_charged: j.tokens_charged || 0, style: j.style, started_at: j.started_at, finished_at: j.finished_at, shot_id: j.shot_id || null };   // v3.5.38 shot_id
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
    const live = ctx.mode === 'shots' ? shots.filter(function (s) { return s.keyframes.length; }) : shots;   // v3.5.58: the notes write every shot
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
        // v3.5.65 (Ian, 2026-11-10: shot 14 lost the Goliath Rider): the assets already on the shot stay
        const keepAssets = (shotRefs(live[i]) || []).filter(function (r) { return r.type === 'asset'; });
        await tx.prepare('UPDATE shots SET refs = ? WHERE id = ?').run(JSON.stringify(namedRefs(sh.words).concat(keepAssets)), live[i].id);
        await tx.prepare('UPDATE shots SET precheck = NULL WHERE id = ?').run(live[i].id);   // v3.5.65 (Ian: "If I rerun the Directors notes... Shouldn't it clear the Pre Prod Suggestions?")
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
    let lastModel = '';   // v3.5.86 (Ian, 2026-11-12: "default to whatever was in the last shot")
    const fresh = result.shots.map(function (sh) {
      const urls = sh.pictures.map(function (n) { return pics[n - 1].image_url; });
      const same = live.filter(function (o) { return !used[o.id] && o.keyframes.length === urls.length && o.keyframes.every(function (k, j) { return k.image_url === urls[j]; }); })[0];
      if (same) {
        used[same.id] = true;
        lastModel = shotModel(same);
        return { id: same.id, name: cleanShotName(same.name) || sh.name, purpose: cleanPurpose(same.purpose) || sh.purpose || undefined, cut_style: same.cut_style || 'instant', keyframes: same.keyframes.map(kfOut) };
      }
      return { id: null, model: lastModel || undefined, name: sh.name, purpose: sh.purpose || undefined, cut_style: 'instant', keyframes: sh.pictures.map(function (n) { return kfOut(pics[n - 1]); }) };
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
    {   // v3.5.58 -- the missing shots, each placed after a shot by its id (0 = at the start)
      const ids = (await tx.prepare('SELECT id FROM shots WHERE episode_id = ? ORDER BY position, id').all(episodeId)).map(function (r) { return r.id; });
      const ms = (result.missing || []).map(function (x, k) { return { id: k + 1, after_id: x.after ? (ids[x.after - 1] || 0) : 0, after: x.after, name: x.name, what: x.what, why: x.why, done: false }; });
      await tx.prepare('UPDATE episodes SET missing_shots = ? WHERE id = ?').run(JSON.stringify(ms), episodeId);
    }
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
  if (ctx.mode === 'shots') vlDebug(userId, 'info', JFN, 'The cut and the missing shots', {   // v3.5.59 (Ian, 2026-11-10: "Did you happen to write what it's doing to the log")
    shots: result.shots.map(function (sh, i) { return { shot: i + 1, pictures: sh.pictures.join(','), name: sh.name, purpose: sh.purpose || '' }; }),
    missing: (result.missing || []).map(function (x) { return { after: x.after, name: x.name, what: x.what, why: x.why }; }) });
  vlDebug(userId, 'info', JFN, (ctx.mode === 'shots' ? 'The Director planned ' + result.shots.length + ' shot(s), ' + kept + ' kept as they were, ' + (result.missing || []).length + ' missing shot(s) found' : 'The Director wrote the notes of ' + result.shots.length + ' shot(s)') + ', ' + charged + ' token(s) charged', { mode: ctx.mode, input_tokens: inTok, output_tokens: outTok, cost_usd: usd, worked_out: charge,
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
    const cl = await claimWriterJob(db, ep.id, null, { user_id: req.session.userId, style: ctx.style.key, model: ctx.modelKey, sig: ctx.sig, est_tokens: est.tokens, kind: ctx.mode });   // v3.5.43
    if (!cl.id) return vlRefuse(req, res, FN, 409, cl.busy);
    const job = await db.prepare('SELECT * FROM episode_writer_jobs WHERE id = ?').get(cl.id);
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
    const j = await db.prepare('SELECT * FROM episode_writer_jobs WHERE episode_id = ? AND shot_id IS NULL ORDER BY id DESC LIMIT 1').get(ep.id);   // v3.5.43: the episode-wide lane
    // v3.5.43: the checks of single shots, running or ended in the last 15 minutes (the latest per shot)
    const ck = await db.prepare("SELECT * FROM episode_writer_jobs WHERE episode_id = ? AND shot_id IS NOT NULL AND (status = 'running' OR finished_at > NOW() - INTERVAL '15 minutes') ORDER BY id DESC").all(ep.id);
    const seenShot = {}, checks = [];
    ck.forEach(function (x) { if (seenShot[x.shot_id]) return; seenShot[x.shot_id] = true; checks.push(jobView(x)); });
    let estimate = null, estimateShots = null;
    try {
      const ctx = await shotListContext(db, ep);
      if (ctx.pictures.length) { const pr = await shotListPrices(db); estimate = estimateShotList(withMode(ctx, 'notes'), pr); estimateShots = estimateShotList(withMode(ctx, 'shots'), pr); }
    } catch (e) { estimate = null; estimateShots = null; }
    let estimatePrecheck = null;
    try { estimatePrecheck = { tokens: await precheckTokens(db), shot_tokens: await precheckShotTokens(db) }; } catch (e) { estimatePrecheck = null; }   // v3.5.34; v3.5.38 shot_tokens
    res.json({ job: jobView(j), checks: checks, estimate: estimate, estimate_shots: estimateShots, estimate_precheck: estimatePrecheck,
      episode: ((j && j.status !== 'running') || req.query.episode === '1') ? await loadEpisode(db, ep.id) : null });   // v3.5.43: ?episode=1 when a shot's check has ended
  } catch (e) {
    console.error('[video] shot list read error:', e && e.message);
    res.status(500).json({ error: 'Could not read the shot list.' });
  }
});

// =================================================================================================
// v3.5.34 -- TD-1115. THE PRE-PRODUCTION CHECK (spec: claude/PREPRODUCTION_CHECK_SPEC.md). Ian, 2026-11-09: "Couldn't the AI
// see this in a much cheaper pass and warn about it before spending 5 dollars on a video". Order of work: Create Shots,
// Director's Notes, Pre-production check; it can run at any time. The Director looks at every shot (its pictures, words,
// references and mode) with the story, and says per shot which mode suits it and what will go wrong, each with a fix where
// there is one. The pictures' shape is measured here, exactly. Stored on each shot (shots.precheck) with the shot's
// signature, so a shot changed since shows its findings as out of date. 1 token (app_settings.video_precheck_tokens),
// charged only once the findings are saved. Runs as a Director job (kind 'precheck'), one at a time with the others.
// =================================================================================================
const PC_KINDS = ['gap', 'mode', 'continuity', 'words', 'reference', 'style', 'aspect', 'cut', 'other'];   // v3.5.79 cut
const PC_BOXES = ['start', 'actions', 'camera', 'end', 'sounds', 'around'];
// v3.5.64 -- each words finding is named after what it changes (Ian: "Art style" offered new Start words)
function pcBoxLabel(fix) {
  if (fix.box === 'beat') return 'Beat ' + fix.beat + (fix.field === 'camera' ? ': camera' : (fix.field === 'sound' ? ': sound' : ''));
  return { start: 'Opening', actions: 'Beats', camera: 'Throughout: camera', end: 'Closing', sounds: 'Throughout: sounds', around: 'Throughout: around them' }[fix.box] || fix.box;
}
const PC_MAX_FINDINGS = 8;
const PC_WIDE = 1.6;   // a picture narrower than this (width / height) is not wide: the video is 16:9
const PC_SURE = 1.25;   // v3.5.35: narrower than this the model will crop or stretch it (square or tall); between the two it might
async function precheckTokens(db) {
  let v = null;
  try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('video_precheck_tokens'); v = r ? parseInt(r.value, 10) : null; } catch (e) { v = null; }
  return (Number.isFinite(v) && v >= 1) ? v : 2;   // v3.5.38 (Ian, 2026-11-09): 2 tokens; a run costs about 13-14 cents
}
// v3.5.38 -- checking one shot (Ian: "each individual shot run 1 token"): app_settings video_precheck_shot_tokens, 1.
async function precheckShotTokens(db) {
  let v = null;
  try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('video_precheck_shot_tokens'); v = r ? parseInt(r.value, 10) : null; } catch (e) { v = null; }
  return (Number.isFinite(v) && v >= 1) ? v : 1;
}
// A picture for the Director (512 px JPEG) and its real shape.
// v3.5.56 (Ian, 2026-11-09: a Kling take failed "Image dimensions are too small. Minimum dimensions are 300x300 pixels";
// Oya's asset picture was 258 x 335; "just do it automatically"). Every picture in a take's input that is under 320 px on a
// side is sent as an enlarged copy (the original is not changed). Copies are remembered for the life of the process.
const MIN_PIC_PX = 320;
const PIC_MIN_RATIO = 0.42, PIC_MAX_RATIO = 2.4;   // v3.5.68: inside fal's 0.4 to 2.5, with a little room
const _bigCopies = {};
async function bigEnoughUrl(url) {
  if (!url || !storage.isOurPublicUrl(url)) return null;
  if (_bigCopies[url] !== undefined) return _bigCopies[url];
  const axios = require('axios'), sharp = require('sharp');
  const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024 });
  const buf = Buffer.from(resp.data);
  const meta = await sharp(buf).rotate().metadata();
  let w = meta.width || 0, h = meta.height || 0;
  if (meta.orientation && meta.orientation >= 5) { const t = w; w = h; h = t; }
  // v3.5.68 (Ian, 2026-11-10: "The aspect ratio of the image should be between 0.4 and 2.5" -- the title logo, a wide
  // banner): a picture too wide or too tall is sent padded out to the limit in its own edge colour (black around a logo).
  const tooWide = w / h > PIC_MAX_RATIO, tooTall = w / h < PIC_MIN_RATIO;
  if (!w || !h || (Math.min(w, h) >= MIN_PIC_PX && !tooWide && !tooTall)) { _bigCopies[url] = null; return null; }
  const pw = tooTall ? Math.ceil(h * PIC_MIN_RATIO) : w, ph = tooWide ? Math.ceil(w / PIC_MAX_RATIO) : h;
  const f = Math.max(1, MIN_PIC_PX / Math.min(pw, ph)), nw = Math.round(pw * f), nh = Math.round(ph * f);
  let img = sharp(buf).rotate();
  if (pw !== w || ph !== h) {
    const raw = await sharp(buf).rotate().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    const bg = { r: raw[0] || 0, g: raw[1] || 0, b: raw[2] || 0, alpha: 1 };
    const top = Math.floor((ph - h) / 2), left = Math.floor((pw - w) / 2);
    img = sharp(await img.extend({ top: top, bottom: ph - h - top, left: left, right: pw - w - left, background: bg }).png().toBuffer());
  }
  const out = await img.resize({ width: nw, height: nh, kernel: 'lanczos3' }).png().toBuffer();
  const nu = await storage.uploadFile(out, 'vlbig-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png', 'image/png', 'video-lab');
  if (!nu) return null;
  try { await require('../services/rightsCheck').inherit(url, nu); } catch (e) {}
  _bigCopies[url] = { url: nu, from: w + 'x' + h, to: nw + 'x' + nh };
  return _bigCopies[url];
}
// Swaps small pictures in a fal input for their enlarged copies; returns what it changed. Never throws.
async function enlargeSmallPictures(input) {
  const done = [];
  const swap = async function (u) {
    try { const c = await bigEnoughUrl(u); if (c) { done.push({ url: vlShortUrl(u), from: c.from, to: c.to }); return c.url; } }
    catch (e) { console.warn('[video] could not measure a picture (' + (e && e.message) + ')'); }
    return u;
  };
  if (!input) return done;
  if (Array.isArray(input.image_urls)) { for (let i = 0; i < input.image_urls.length; i++) input.image_urls[i] = await swap(input.image_urls[i]); }
  for (const k of Object.keys(input)) if (/image_url$/.test(k) && typeof input[k] === 'string') input[k] = await swap(input[k]);
  return done;
}
async function pcShape(url) {
  try {
    if (!url || !storage.isOurPublicUrl(url)) return null;
    const axios = require('axios'), sharp = require('sharp');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024 });
    const buf = Buffer.from(resp.data);
    const meta = await sharp(buf).rotate().metadata();
    const out = await sharp(buf).rotate().resize({ width: SL_IMAGE_PX, height: SL_IMAGE_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
    let w = meta.width || 0, h = meta.height || 0;
    if (meta.orientation && meta.orientation >= 5) { const x = w; w = h; h = x; }
    return { b64: out.toString('base64'), w: w, h: h };
  } catch (e) {
    console.warn('[video] pre-production check: could not read a picture (' + (e && e.message) + ')');
    return null;
  }
}
async function precheckContext(db, ep) {
  const ctx = await shotListContext(db, ep);
  const pool = await refsPool(db, ep).catch(function () { return { characters: [], assets: [] }; });
  ctx.mode = 'precheck';
  ctx.sig = cutSig(ctx.shots);
  ctx.shotSigs = ctx.shots.map(function (s) { return shotSig(ep, s.keyframes, s); });   // v3.5.37: the shots as checked; one edited meanwhile reads as changed since
  ctx.pool = pool;
  ctx.info = ctx.shots.map(function (s) {
    const w = shotWords(s) || legacyWords(s.keyframes, MODELS[ep.model]);
    const key = shotModelKey(ep.model, shotMode(s), shotModel(s)), mm = MODELS[key];   // v3.5.86: the shot's own model
    return { id: s.id, name: s.name || '', words: w, refs: refsToSend(ep, w, shotRefs(s), pool, 12).map(function (p) { return p.name; }),
      mode: mm.reference ? 'reference' : 'keyframes', modeSet: shotMode(s), model: mm.label + (mm.reference ? ' (Reference)' : ' (Keyframes)'),
      maxSecs: Math.min(SHOT_MAX_SECS, Math.max.apply(null, (mm.durations || ['15']).map(Number))),   // v3.5.79
      dealt: pcDealt(s) };
  });
  return ctx;
}
function precheckRequest(ctx, images) {
  const N = ctx.pictures.length;
  const system = directorHead(ctx) +
    'YOUR JOB NOW: THE PRE-PRODUCTION CHECK. The shots, their words and their pictures are ready. Every take costs real money, so before any video is made, look at each shot and say plainly what will go wrong and how to fix it. Only real problems: if a shot is fine, say nothing about it.\n\n' +
    'THE TWO VIDEO MODES\n' +
    '- REFERENCE: the model is given the shot\'s pictures and the cast\'s reference pictures as references and directs the shot from the words. Its first picture decides who is there and how they are laid out, but it is not a strict first frame: the model may redraw the setting or open with a move of its own and reach the picture later (v3.5.97, takes 85 and 86). A reference picture alone never brings anyone into the shot. When a shot must open exactly on its picture, Keyframes is the safe mode. Later pictures only show the place, the light and who is there. Best when the pictures disagree on place, poses, facing or who is where.\n' +
    '- KEYFRAMES: the video moves from each picture EXACTLY to the next one, morphing the first into the second. Best only when neighbouring pictures match closely: the same place, the same people in nearly the same poses and positions, a small change. When neighbouring pictures differ in place, in someone\'s pose or facing (a man carried with his head to the left in one picture and lying with his head to the right in the next), in who is holding what, or in who is where, a Keyframes take morphs nonsense.\n\n' +
    'WHAT TO LOOK FOR, SHOT BY SHOT\n' +
    '1. mode: which mode suits the shot, and why, in one sentence. If the shot is set to the other one, add a finding of kind "mode" with a fix to switch.\n' +
    // v3.5.82 (Ian, 2026-11-11: "Can it mention it in the findings that you need a reference for X because they are not pictured?").
    // v3.5.83 (Ian: "should it recommend Keyframes when everyone is in the picture?... What I was hoping for was... to recommend
    // adding a reference image when someone isn't in the inital or any Keyframe"): the Keyframes preference is gone again.
    'NOT PICTURED (recommended): when someone or something that matters (a named character, an asset) appears in the shot but is in none of its pictures, the model can only guess what they look like. Say who, and in which beat they appear, and that they are not in the pictures. If the shot is in Keyframes mode, the fix is to switch to Reference (fix type "mode"); if it is already in Reference and they are not among the references sent, the fix is add_reference.\n' +
    // v3.5.96 (Ian's MiniMax takes, 2026-11-12: the opening picture rules the shot in both modes; Ori's reference was sent and he
    // never appeared; Emanon, Ori and Gubuk, in no picture, walked in on cue when a beat brought them in).
    'NOT IN THE OPENING PICTURE (recommended): a reference picture alone never brings anyone into the shot. When someone named in the start, the beats or the end is not in the shot\'s FIRST picture, a beat must bring them in (they walk in, enter through a place the picture shows, arrive) or a camera move must reveal them BY NAME ("pans right to reveal Ori by the door"). When neither does, say who and that they will not appear, and give a beat fix that adds their entrance to the first beat they matter in (keeping that beat\'s own words), or suggest putting them in the opening picture.\n' +
    'THE START AND THE OPENING PICTURE (recommended): the opening picture wins over the start words. When the start says something the first picture does not show (someone there who is not, sitting up when the picture has them lying down, another place or position), say what differs and give a words fix for the start box that describes the picture as it is, or suggest changing the picture. Leave the start alone when a beat explains the difference (the start has the diamond still in his coat and beat 1 draws it out: v3.5.97, take 84 got that right and the check broke it), and when you are not sure what the picture shows.\n' +
    'DIRECTIONS AND DEPTH (recommended): where someone comes from or goes ("from the left", "from the back of the room", "in the background", "through the archway") loses when the picture or the path words disagree. "In the background" or "from the back" needs a place in the picture to come from, named (a doorway, an archway, a gap), and a path in depth ("toward us", "away from us", "behind the fallen shelves"); "enters from the left edge ... exits right" is a crossing at the front, and walking past someone in the foreground brings them forward. Give a beat fix that names the place in the picture and a path that matches.\n' +
    '2. gap: the story says something happens that the video must show and no picture covers (between two pictures of a shot, or between two shots). Read the story: if it explains a change (someone healed in turn, a later moment), that is not a mistake, but the video still has to get from one picture to the next. Suggest the missing picture: say after which picture number it goes and describe it in one or two sentences.\n' +
    '3. continuity: a person or prop that appears from nowhere: when a later picture shows something an earlier one does not (a tool now in a hand, a person now there) and no action brings it in, give a fix of type "words" for the actions box with the missing step written in its place (for example "He picks up the stone pestle from beside the bowl."); someone who leaves and is needed again in the same shot (a cut is the reliable fix); a change of place inside one shot.\n' +   // v3.5.48
    '4. words: words that fight the pictures or each other, an action placed in the Sound or Around boxes, more actions than the shot\'s length allows (about one action per 2.5 seconds), a shot of two or more pictures with no end (when there are more actions than the length allows, give a fix of type "seconds" with the length that fits, at most 15), someone who must leave the frame with too little time left to get all the way out at least 1 second before the shot ends (they stop at the edge; give a fix of type "seconds" or cut an action) or an end that still shows them after they leave. Offer replacement words for the one box to change.\n' +
    // v3.5.96 (shot 2: the camera line still named the diamond a beat had used up, so it stayed whole)
    'USED UP (recommended): when a beat uses something up, destroys it or makes it vanish (a diamond pressed in and gone, a scroll burned), later camera, sound, around or end words that still name it keep it on screen. Give a fix that drops it from those words. Prefer words that say what happens to it ("bursts into glittering dust") over "vanishes" or "disappears".\n' +
    'TWO CAMERAS (recommended): a beat\'s camera and the whole-shot camera must agree. When one eases back and the other holds close, or one moves where the other is still, say which beat and give a fix for the one to change (v3.5.97).\n' +
    'OUR ADDED LINES (recommended): a shot may list lines the video script adds by itself (leaving the frame). When one fights the words (it has someone leave who should not, or the words name a doorway), say so and give a beat fix that rewords the beat.\n' +
    'GEAR: what a character carries is set by the words; their reference picture shows their looks, not what they must hold, and the video is told so. Never ask for reference gear to be explained or written in. Report only a real contradiction: the words have someone use an item that is in none of the pictures or references and no beat brings in.\n' +
    'BEATS: each action is a beat with its seconds (shown as "(0-3 s)"); judge crowding from those seconds, not by counting actions: a beat under about 2 seconds rarely shows a whole movement. A line shown inside a beat ([line said during this beat: ...]) is already tied to that beat and is sent with it: never say a line has no beat, never suggest moving a line, and never put a line in a sound box. People move and speak at the same time: never treat an action and a line as competing for the same seconds. Judge a line only by how long it takes to say, about 2.5 words a second (an 8-word line needs about 3 seconds).\n' +   // v3.5.76
    'KEEP THE USER\'S WORDS (v3.5.64, Ian: a suggestion threw away "run", a shouted line and a bloody flail): replacement words keep everything the user wrote, their verbs, details, lines and who does what, and change ONLY the part that causes the problem. Never rewrite a box to fix something in another box.\n' +
    'NO EMPTY FINDINGS: report only what needs changing. Never a finding that ends with "it is fine", "retain" or "no change needed", and never two findings with the same fix.\n' +
    'CONCEPT (v3.5.99): a shot\'s Concept is the user\'s intent for how it looks and feels. When the words fight it (it asks for a slow push in and the camera whips around), that is a finding of kind "words" with a fix that changes only that part. Where a Purpose or Concept and the story disagree, the user\'s words win: never report that difference.\n' +
    'PURPOSE: each shot\'s Purpose is the user\'s intent. When the words leave out part of it (the purpose says Drel takes the mirror from Ori and Ori is not in the shot) or do something it does not ask for, that is a finding of kind "words" with a fix that adds only what is missing. When a purpose describes what happens in another shot, say which shot and suggest no words.\n' +
    'TITLE CARDS: a title, logo or text-on-black picture as a shot\'s first picture is meant: the shot opens on it and moves into the scene (clouds, a fade). Never report it as a different kind of art, never tell them to drop it, and never take "opens on the title" out of the words.\n' +
    // v3.5.79 (Ian, 2026-11-11: the check should get people to an all clear; "Recommended vs Optional"; "It's too long you should cut between x and y beats")
    'RECOMMENDED OR OPTIONAL: give every finding a "level". "recommended" is only for what will spoil a take: words the model will say or show by mistake, boxes that contradict each other, a beat too short for what is in it, a person or thing that appears from nowhere, someone who leaves and is needed again, a shot longer than the model can make, a picture that cannot be the character, the wrong mode. Everything else (a clearer wording, an extra detail, where a prop comes from, a picture that would help) is "optional". When in doubt, optional. A shot whose only findings are optional is ready to generate.\n' +
    // v3.5.81 (Ian, 2026-11-11): the fix takes the line away too; every beat with a line is looked at
    'SPOKEN BY MISTAKE (recommended): a line\'s words are spoken aloud exactly as written. A line that is really a direction ("Chanting under his breath.", "whispers a prayer", "(muttering)") will be read out: say so, and give a beat fix with "remove_line": true that puts the direction in the beat\'s action (or the chanting in its sound); using the fix takes the line away.\n' +
    'SILENT AND SPEAKING (recommended): look at EVERY beat that has a line. If that beat\'s words say the speaker speaks silently, "silently speaks", mouths the words, speaks "without sound" or "words without sound", the line will still be said aloud or dropped: say which beat, and give a beat fix whose words say how the line is said (quietly, under his breath, hoarsely) instead. The reverse too: a beat that says someone speaks or calls out a line but has no line on it.\n' +
    'THE CLOSING (recommended): the end must match where the last beat leaves people: who is where, standing or kneeling, what is in their hands. The video acts on the beats and treats the end only as where people must be: when the end asks for a change no beat makes (someone sits back, stands, turns away), give a beat fix that adds that move to the last beat (keeping its own words) rather than changing the end (v3.5.96: take 84, Drel sat back once his last beat said so). When the beats contradict the end, give a words fix for the end box. Compare the details too: where hands end up (in his lap or at his sides), standing or sitting, facing which way; when the last beat and the end disagree on one, give a fix that makes them agree. On EVERY shot whose camera ends close (a push-in, a close-up, "closing on" someone), check whether the end names people who will be outside that frame; when it does, say so: end the camera wider, or trim the end (v3.5.97: shot 3\'s camera closed on Drel while the end placed Gubuk and Ori).\n' +
    'TOO LONG (recommended): when the beats add up to more than the most this model makes (given with each shot), the shot must be cut in two. Give a finding of kind "cut" with a fix {"type": "cut", "after_beat": N}: the shot is cut between beat N and beat N+1. Pick the natural break (a change of subject, one action finished before the next starts), with each half no longer than the model makes.\n' +
    'ALREADY DEALT WITH: findings listed under a shot as already dealt with by the user were fixed or dismissed. Do not raise them again, in any wording.\n' +
    '5. reference: someone clearly on screen AND named in the shot\'s words who is not among the references sent. Never someone already sent, a background figure or a guess.\n' +
    '6. style: only a picture that is plainly a different kind of art from the shot\'s other pictures (a photo among paintings, a flat cartoon among painted pictures, black and white among colour). The art style\'s name' + (ctx.artStyle ? ' (' + ctx.artStyle + ')' : '') + ' is a loose label, not a test: never report that a picture is not that style, and never report differences of colour, light or detail.\n' +
    'LIKENESS: never judge whether a character in a picture looks like their reference (build, height, proportions, face, hair, clothing details): the reference picture is sent and the video follows it. Report only a picture where it plainly cannot be them (another skin colour, another kind of creature, a man where a woman should be).\n\n' +   // v3.5.50 (Ian, 2026-11-09: "it\'s saying this isn\'t Emanon because he\'s too bulky... a little over the top")
    'Do NOT report the pictures\' shape (it is measured separately). At most ' + PC_MAX_FINDINGS + ' findings a shot, most important first. Each "text" is one or two plain sentences a writer understands, naming the picture numbers and the characters.\n\n' +
    (ctx.only != null ? 'THIS TIME, CHECK ONLY SHOT ' + (ctx.only + 1) + '. The other shots are listed so you know what comes before and after it (the last picture of the shot before and the first of the shot after are shown): look at the cut into it and out of it, but report only on shot ' + (ctx.only + 1) + '.\n\n' : '') +   // v3.5.38
    'ANSWER WITH ONLY THIS JSON, no other text:\n' +
    '{"shots": [{"shot": 1, "mode": "reference", "mode_why": "...", "findings": [{"kind": "gap", "level": "optional", "text": "...", "fix": {"type": "add_picture", "after_picture": 3, "describe": "..."}}]}]}\n' +
    (ctx.only != null ? 'One entry only, for shot ' + (ctx.only + 1) + '. "kind" is one of' : 'One entry per shot, ' + ctx.shots.length + ' in all, in order. "kind" is one of') + ': gap, mode, continuity, words, reference, style, cut, other. "level" is recommended or optional. "fix" is optional and is one of:\n' +
    '{"type": "words", "box": "start|actions|camera|end|sounds|around", "text": "the whole new text of that box (for actions, one action per line)"}\n' +
    '{"type": "words", "box": "beat", "beat": <beat number>, "field": "do|camera|sound", "text": "the new words for that one part of that one beat", "remove_line": true only when the line on that beat must go} (best when only one beat needs changing)\n' +
    '{"type": "add_reference", "name": "a character\'s exact name"}\n' +
    '{"type": "mode", "mode": "reference|keyframes"}\n' +
    '{"type": "add_picture", "after_picture": <picture number>, "describe": "what the missing picture shows"}\n' +
    '{"type": "seconds", "seconds": <the shot\'s new length, 4 to 15>}\n' +   // v3.5.48
    '{"type": "cut", "after_beat": <the beat the first half ends with>}';   // v3.5.79
  const content = [];
  const head = [];
  head.push('EPISODE: ' + String(ctx.ep.name || '') + (ctx.sessionName ? ' (session "' + ctx.sessionName + '")' : '') + '.');
  if (ctx.artStyle) head.push('THE VERSION\'S ART STYLE: ' + ctx.artStyle + '.');
  head.push('THE STYLE OF THIS VIDEO: ' + ctx.style.label + '. ' + ctx.style.instructions);
  if (ctx.story.text) head.push('\nTHE STORY OF THIS SESSION' + (ctx.story.trimmed ? ' (its start)' : '') + ':\n' + ctx.story.text);
  if (ctx.cast.length) {
    head.push('\nTHE CAST:');
    ctx.cast.forEach(function (c) { head.push('- ' + String(c.name || '').trim() + (c.cls ? ', ' + String(c.cls).trim() : '') + (c.description ? ': ' + String(c.description).replace(/\s+/g, ' ').trim().slice(0, 300) : '')); });
  }
  const sent = images.filter(Boolean).length;
  head.push('\nTHE SHOTS, IN ORDER (' + ctx.shots.length + ' shots, ' + N + ' pictures numbered across the episode)' + (sent < N ? '. Only ' + sent + ' pictures are shown; the others are described in words only.' : '.'));
  content.push({ type: 'text', text: head.join('\n') });
  let n = 0;
  ctx.shots.forEach(function (s, si) {
    const inf = ctx.info[si], w = inf.words, first = n + 1, last = n + s.keyframes.length;
    const lines = ['--- SHOT ' + (si + 1) + (inf.name ? ' ("' + inf.name + '")' : '') + ': picture' + (first === last ? ' ' + first : 's ' + first + ' to ' + last) + '.' + (textOf(s.purpose) ? ' Purpose (the user\'s intent for this shot): ' + textOf(s.purpose) + '.' : '') + (textOf(s.concept) ? ' Concept (how the user wants it to look and feel): ' + textOf(s.concept) + '.' : '') + ' Made in ' + inf.mode.toUpperCase() + ' mode (' + inf.model + '), ' + w.seconds + ' seconds.'];
    lines.push('References sent: ' + (inf.refs.length ? inf.refs.join(', ') : 'none') + '.');
    { const ours = exitLines(w, (ctx.cast || []).map(function (c) { return c.name; }).concat(inf.refs || []), w.seconds || 0);   // v3.5.96: our own added lines, so the check can see them fight the words
      if (ours.length) lines.push('Lines our script adds for this shot: ' + ours.join(' ')); }
    { const bt0 = beatTimes(w), tot = bt0.length ? bt0[bt0.length - 1].to : 0;   // v3.5.79: too long for the model
      lines.push('The beats add up to ' + secsText(tot) + ' seconds; this model makes at most ' + inf.maxSecs + ' seconds' + (tot > inf.maxSecs + 0.25 ? ': TOO LONG, it must be cut.' : '.')); }
    if (inf.dealt.length) lines.push('Already dealt with by the user (do not raise again): ' + inf.dealt.map(function (t) { return '"' + t + '"'; }).join(' '));
    lines.push('start: ' + (w.start || '(empty)'));
    const bt = beatTimes(w), bb = w.beats || [];   // v3.5.63 -- TD-1121: each beat with its seconds, camera and sound
    lines.push('actions (beats): ' + (w.actions.length ? w.actions.map(function (a, i) { const b = bb[i] || {}; return (i + 1) + '. (' + secsText(bt[i].from) + '-' + secsText(bt[i].to) + ' s' + (b.secs ? ', set by the user' : '') + ') ' + a + (b.camera ? ' [camera: ' + b.camera + ']' : '') + (b.sound ? ' [sound: ' + b.sound + ']' : '') +
      w.lines.filter(function (l) { return l.when === i + 1; }).map(function (l) { return ' [line said during this beat: ' + (String(l.who || '').trim() || 'a voice') + (l.off ? ' (off-screen)' : '') + ': "' + l.text + '"]'; }).join(''); }).join(' ') : '(empty)'));   // v3.5.67 (Ian: the check said a line on beat 4 had no beat)
    const anyTime = w.lines.filter(function (l) { return !l.when; });
    if (anyTime.length) lines.push('lines said at any time (no beat): ' + anyTime.map(function (l) { return (String(l.who || '').trim() || 'a voice off-screen') + (l.off ? ' (off-screen)' : '') + ': "' + l.text + '"'; }).join('; '));
    lines.push('camera: ' + (w.camera || '(empty)'));
    lines.push('end: ' + (w.end || '(empty)'));
    if (w.sounds) lines.push('sounds: ' + w.sounds);
    if (w.around) lines.push('around: ' + w.around);
    content.push({ type: 'text', text: lines.join('\n') });
    s.keyframes.forEach(function () {
      const p = ctx.pictures[n];
      content.push({ type: 'text', text: 'Picture ' + (n + 1) + '. ' + p.words });
      if (images[n]) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: images[n] } });
      n++;
    });
  });
  content.push({ type: 'text', text: ctx.only != null ? 'Now the pre-production check for shot ' + (ctx.only + 1) + ' only, as JSON.' : 'Now the pre-production check for these ' + ctx.shots.length + ' shots, as JSON.' });
  return { system: system, content: content, max_tokens: ctx.only != null ? 3000 : Math.min(12000, 1200 + ctx.shots.length * 700) };
}
// v3.5.53 (Ian, 2026-11-09: "You list the actions twice... only list the number that you need to be different for the
// issue at hand"). A new Actions box from the check, as the actions it changes against the shot's actions when it was
// checked: replace (n, old, text), insert (after n, 0 = first; anchor = the old text of n) and delete (n, old).
function pcActNorm(t) { return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function pcActLines(text) { return String(text || '').split('\n').map(function (a) { return a.replace(/^\s*\d+\s*[.)]\s*/, '').trim(); }).filter(Boolean); }
function actionChanges(oldA, newA) {
  const a = oldA.map(pcActNorm), b = newA.map(pcActNorm), n = a.length, m = b.length;
  const L = []; for (let i = 0; i <= n; i++) { L.push(new Array(m + 1).fill(0)); }
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, D = [], I = [];
  function flush() {
    const k = Math.min(D.length, I.length);
    for (let x = 0; x < k; x++) out.push({ op: 'replace', n: D[x] + 1, old: oldA[D[x]], text: newA[I[x]] });
    for (let x = k; x < D.length; x++) out.push({ op: 'delete', n: D[x] + 1, old: oldA[D[x]] });
    const after = k ? D[k - 1] + 1 : (D.length ? D[0] : i - D.length);
    for (let x = k; x < I.length; x++) out.push({ op: 'insert', after: after, anchor: after ? oldA[after - 1] : '', text: newA[I[x]] });
    D = []; I = [];
  }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { I.push(j); j++; }
    else { D.push(i); i++; }
  }
  flush();
  return out;
}
// v3.5.79 (Ian, 2026-11-11): a recheck starts the list over, but what the user fixed or dismissed is not raised again
function pcDealt(s) {
  const pc = parseJson(s && s.precheck, null);
  if (!pc || !Array.isArray(pc.findings)) return [];
  return pc.findings.filter(function (f) { return f && f.done && f.kind !== 'aspect'; }).map(function (f) { return pcText(f.text, 240); }).filter(Boolean).slice(0, 12);
}
function pcText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function parsePrecheck(raw, ctx) {
  const j = readJson(raw);
  if (!j || !Array.isArray(j.shots)) return { error: 'no shots in the answer' };
  const N = ctx.pictures.length, names = {};
  (ctx.pool.characters || []).concat(ctx.pool.assets || []).forEach(function (c) { if (c && c.name) names[String(c.name).trim().toLowerCase()] = String(c.name).trim(); });
  const out = ctx.shots.map(function () { return null; });
  j.shots.forEach(function (x, i) {
    if (!x) return;
    const si = parseInt(x.shot, 10) >= 1 && parseInt(x.shot, 10) <= ctx.shots.length ? parseInt(x.shot, 10) - 1 : i;
    if (si < 0 || si >= ctx.shots.length || out[si]) return;
    const mode = x.mode === 'reference' || x.mode === 'keyframes' ? x.mode : null;
    const findings = [];
    (Array.isArray(x.findings) ? x.findings : []).forEach(function (f) {
      if (!f || findings.length >= PC_MAX_FINDINGS) return;
      const text = pcText(f.text, 500);
      if (!text) return;
      const kind = PC_KINDS.indexOf(f.kind) >= 0 && f.kind !== 'aspect' ? f.kind : 'other';
      let fix = null;
      const fx = f.fix;
      if (fx && fx.type === 'words' && PC_BOXES.indexOf(fx.box) >= 0 && String(fx.text || '').trim()) {
        fix = { type: 'words', box: fx.box, text: String(fx.text).replace(/\r\n?/g, '\n').trim().slice(0, 1500) };
        const was = fx.box === 'actions' && ctx.info && ctx.info[si] && ctx.info[si].words ? (ctx.info[si].words.actions || []) : [];
        if (fx.box === 'actions' && was.length) {   // v3.5.53: only the actions it changes
          const ch = actionChanges(was, pcActLines(fix.text));
          if (!ch.length) fix = null; else fix.changes = ch;
        }
      }
      else if (fx && fx.type === 'words' && fx.box === 'beat' && String(fx.text || '').trim()) {   // v3.5.64: one part of one beat
        const w0 = ctx.info && ctx.info[si] && ctx.info[si].words, bn = parseInt(fx.beat, 10), field = ['do', 'camera', 'sound'].indexOf(fx.field) >= 0 ? fx.field : 'do';
        if (w0 && bn >= 1 && bn <= w0.actions.length) {
          const cur = field === 'do' ? w0.actions[bn - 1] : String(((w0.beats || [])[bn - 1] || {})[field] || '');
          const t = String(fx.text).replace(/\s+/g, ' ').trim().slice(0, field === 'do' ? 900 : 300);
          const rl = fx.remove_line === true ? (w0.lines || []).filter(function (l) { return Number(l.when) === bn && String(l.text || '').trim(); })[0] : null;   // v3.5.81
          if (t !== String(cur).trim() || rl) fix = { type: 'words', box: 'beat', beat: bn, field: field, text: t, was: String(cur) };
          if (fix && rl) { fix.remove_line = String(rl.text).trim().slice(0, 300); fix.remove_who = String(rl.who || '').trim().slice(0, 80); }
        }
      }
      else if (fx && fx.type === 'add_reference' && names[String(fx.name || '').trim().toLowerCase()]) fix = { type: 'add_reference', name: names[String(fx.name).trim().toLowerCase()] };
      else if (fx && fx.type === 'mode' && (fx.mode === 'reference' || fx.mode === 'keyframes')) fix = { type: 'mode', mode: fx.mode };
      else if (fx && fx.type === 'seconds' && parseInt(fx.seconds, 10) >= 4 && parseInt(fx.seconds, 10) <= 15) fix = { type: 'seconds', seconds: parseInt(fx.seconds, 10) };   // v3.5.48: Make it N s
      else if (fx && fx.type === 'cut' && ctx.info && ctx.info[si] && parseInt(fx.after_beat, 10) >= 1 && parseInt(fx.after_beat, 10) < ctx.info[si].words.actions.length) fix = { type: 'cut', after_beat: parseInt(fx.after_beat, 10) };   // v3.5.79
      else if (fx && fx.type === 'add_picture' && parseInt(fx.after_picture, 10) >= 1 && parseInt(fx.after_picture, 10) <= N) fix = { type: 'add_picture', after_picture: parseInt(fx.after_picture, 10), describe: pcText(fx.describe, 500) };
      // v3.5.64 -- NO EMPTY FINDINGS: words that change nothing, the same fix twice, or a finding that says to keep things as they are
      if (fx && fx.type === 'words' && !fix && (PC_BOXES.indexOf(fx.box) >= 0 || fx.box === 'beat')) return;   // words that change nothing
      if (fix && fix.type === 'words' && fix.box !== 'beat' && fix.box !== 'actions') {
        const w0 = ctx.info && ctx.info[si] && ctx.info[si].words;
        if (w0 && String(w0[fix.box] || '').trim() === fix.text.trim()) return;
      }
      if (fix && fix.type === 'words' && findings.some(function (o) { return o.fix && o.fix.type === 'words' && o.fix.box === fix.box && o.fix.text === fix.text && o.fix.beat === fix.beat && o.fix.field === fix.field; })) return;
      if (!fix && kind === 'words' && /\b(retain|keep (both|them|it) as|no change (is )?needed|is fine|are fine)\b/i.test(text)) return;
      if (fix && fix.type === 'words') fix.label = pcBoxLabel(fix);
      findings.push({ kind: kind, level: f.level === 'optional' && kind !== 'cut' ? 'optional' : 'recommended', text: text, fix: fix });   // v3.5.79
    });
    out[si] = { mode: mode, mode_why: pcText(x.mode_why, 400), findings: findings };
  });
  if (ctx.only != null) {   // v3.5.38: one shot -- its entry is all that counts (the shot number given, or the only entry)
    if (!out[ctx.only] && j.shots.length === 1 && out.filter(Boolean).length === 1) { const k = out.findIndex(Boolean); out[ctx.only] = out[k]; out[k] = null; }
    if (!out[ctx.only]) return { error: 'shot ' + (ctx.only + 1) + ' missing from the answer' };
    return { shots: out.map(function (x, i) { return i === ctx.only ? x : { mode: null, mode_why: '', findings: [] }; }) };
  }
  const missing = out.filter(function (x) { return !x; }).length;
  if (missing > Math.floor(ctx.shots.length / 2)) return { error: missing + ' of ' + ctx.shots.length + ' shots missing from the answer' };
  return { shots: out.map(function (x) { return x || { mode: null, mode_why: '', findings: [] }; }) };
}
async function runPrecheck(jobId, episodeId, userId, ctx, prices, key, tokens) {
  const db = await getDb();
  const JFN = 'Pre-production check job ' + jobId + ' (episode ' + episodeId + ')';
  let inTok = 0, outTok = 0, result = null, lastErr = '';
  const shapes = [];
  try {
    // v3.5.38: checking one shot, only its pictures and the two either side of it are fetched and shown
    let lo = 0, hi = ctx.pictures.length - 1;
    if (ctx.only != null) { let a = 0; for (let k = 0; k < ctx.only; k++) a += ctx.shots[k].keyframes.length; lo = Math.max(0, a - 1); hi = Math.min(ctx.pictures.length - 1, a + ctx.shots[ctx.only].keyframes.length); }
    for (let i = 0; i < ctx.pictures.length; i++) shapes.push(i >= lo && i <= hi ? await pcShape(ctx.pictures[i].url) : null);
    const images = shapes.map(function (s, i) { return s && (ctx.only != null || i < SL_MAX_IMAGES) ? s.b64 : null; });
    const req = precheckRequest(ctx, images);
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      const r = await callShotListModel(key, req);
      inTok += Number((r.usage && r.usage.input_tokens) || 0); outTok += Number((r.usage && r.usage.output_tokens) || 0);
      if (r.error) { lastErr = r.error; vlDebug(userId, 'warn', JFN, 'Call ' + attempt + ' failed: ' + r.error, { usage: r.usage }); continue; }
      const p = parsePrecheck(r.text, ctx);
      if (p.error) { lastErr = r.truncated ? 'it ran out of room' : p.error; vlDebug(userId, 'warn', JFN, 'Call ' + attempt + ': the reply did not pass the checks (' + lastErr + ')', { reply_start: String(r.text || '').slice(0, 600) }); continue; }
      result = p;
    }
  } catch (e) { lastErr = (e && e.message) || 'unknown error'; vlDebug(userId, 'error', JFN, 'The job threw: ' + lastErr, { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' }); }
  const usd = Math.round(usdFor(prices, inTok, outTok) * 10000) / 10000;
  if (!result) {
    await db.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'")
      .run(('The pre-production check came back incomplete (' + lastErr + '). Nothing was charged; try again.').slice(0, 1000), inTok, outTok, usd, jobId);
    console.error('[video] ' + JFN + ' failed: ' + lastErr + ' ($' + usd + ' to Campaignia)');
    return;
  }
  // The shape of every picture, measured. v3.5.35 (Ian, 2026-11-09): one finding per picture, each with Expand; under
  // PC_SURE (square or tall, the same line as the tags on the pictures) the model will crop or stretch it, from there to
  // PC_WIDE (about 4:3) it might ("this size picture didn't cause issues"). A shot made in Reference mode is not checked:
  // reference pictures may be any shape.
  let n = 0;
  ctx.shots.forEach(function (s, si) {
    const isRef = !!(ctx.info[si] && ctx.info[si].mode === 'reference');
    const found = [];
    s.keyframes.forEach(function (k, ki) {
      const sh = shapes[n]; n++;
      if (isRef || (ctx.only != null && si !== ctx.only) || !sh || !sh.w || !sh.h || sh.w / sh.h >= PC_WIDE) return;
      const sure = sh.w / sh.h < PC_SURE;
      found.push({ kind: 'aspect', level: sure ? 'recommended' : 'optional', text: 'Picture ' + n + ' (' + sh.w + ' x ' + sh.h + ') is ' + (sure ? 'not wide' : 'not quite wide') + '. The video is wide (16:9), so the model ' +
        (sure ? 'will crop or stretch it. Expand redraws it wide.' : 'might crop or stretch it a little. Expand redraws it wide if the edges matter.'),
        fix: { type: 'expand', url: k.image_url, picture: n, sure: sure } });
    });
    if (found.length) result.shots[si].findings = found.concat(result.shots[si].findings);
  });
  let filled = false;
  await db.transaction(async function (tx) {
    const claim = await tx.prepare("UPDATE episode_writer_jobs SET status = 'done', input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run(inTok, outTok, usd, jobId);
    if (!claim.changes) return;
    const ep = await tx.prepare('SELECT * FROM episodes WHERE id = ? FOR UPDATE').get(episodeId);
    const shots = ep ? await tx.prepare('SELECT * FROM shots WHERE episode_id = ? ORDER BY position, id').all(episodeId) : [];
    const kfs = ep ? await tx.prepare('SELECT * FROM keyframes WHERE episode_id = ? ORDER BY shot_id, position, id').all(episodeId) : [];
    shots.forEach(function (s) { s.keyframes = kfs.filter(function (k) { return k.shot_id === s.id; }); });
    const live = shots.filter(function (s) { return s.keyframes.length; });
    // v3.5.37: the episode stays open during the check, so a shot may have changed meanwhile. Each shot still there gets its
    // findings, signed to the shot as it was checked (a changed one reads "Changed since the check"); a shot removed since
    // gets none. Only when none of the checked shots is left does the check fail, with nothing charged.
    const liveIds = {};
    live.forEach(function (s) { liveIds[s.id] = true; });
    const keep = [];
    ctx.shots.forEach(function (s, i) { if (liveIds[s.id] && (ctx.only == null || i === ctx.only)) keep.push(i); });   // v3.5.38: one shot
    if (!ep || !keep.length) {
      await tx.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ? WHERE id = ?").run('The shots changed while the Director was checking them. Nothing was charged; try again.', jobId);
      return;
    }
    const at = new Date().toISOString();
    for (let x = 0; x < keep.length; x++) {
      const i = keep[x], r = result.shots[i];
      const pc = { sig: ctx.shotSigs[i], at: at, mode: r.mode, mode_why: r.mode_why,
        findings: r.findings.map(function (f, k) { return { id: k + 1, kind: f.kind, level: f.level || 'recommended', text: f.text, fix: f.fix, done: false }; }) };   // v3.5.79 level
      await tx.prepare('UPDATE shots SET precheck = ? WHERE id = ?').run(JSON.stringify(pc), ctx.shots[i].id);
    }
    filled = true;
  });
  if (!filled) { vlDebug(userId, 'warn', JFN, 'Not saved (the shots changed, the episode was deleted, or the job was interrupted); nothing charged'); return; }
  let charged = 0;
  try {
    const tk = require('./tokens');
    const bal = await tk.getBalance(userId);
    charged = Math.min(tokens, Math.max(0, bal.total));
    if (charged > 0) await tk.spendTokens(userId, charged, { source: 'video_precheck', event_type: 'generation_spend', related_campaign_id: ctx.ep.campaign_id });
    await tk.recordGeneration(userId, { event_type: 'video_precheck', tokens_redeemed: charged, quantity: ctx.only != null ? 1 : ctx.shots.length, unit: 'shots', model: require('../config/models').TEXT_MODEL, related_campaign_id: ctx.ep.campaign_id, related_session_id: ctx.ep.session_id, cost_usd: usd });
  } catch (e) { console.error('[video] pre-production check charge failed:', e && e.message); }
  await db.prepare('UPDATE episode_writer_jobs SET tokens_charged = ? WHERE id = ?').run(charged, jobId);
  const count = result.shots.reduce(function (t, s) { return t + s.findings.length; }, 0);
  console.log('[video] ' + JFN + ': ' + count + ' finding(s) on ' + result.shots.length + ' shot(s), ' + inTok + ' in / ' + outTok + ' out, $' + usd + ', ' + charged + ' token(s)');
  vlDebug(userId, 'info', JFN, count + ' finding(s), ' + charged + ' token(s) charged', { input_tokens: inTok, output_tokens: outTok, cost_usd: usd,
    shots: result.shots.map(function (s) { return { mode: s.mode, findings: s.findings.map(function (f) { return f.kind + (f.fix ? '+' + f.fix.type : ''); }) }; }) });
}
// =================================================================================================
// v3.5.77 -- TD-1127, A SHOT'S OWN DIRECTOR'S NOTES (Ian, 2026-11-11: "when you create a new shot and it has empty sections
// this Directors notes button will fill in the missing pieces"; spec claude/VIDEO_BEAT_CUT_SPEC.md). Only the empty boxes
// are written; everything the user wrote stays. The shots before and after are read so the words follow on. 1 token
// (app_settings video_fill_tokens), charged only when something was written. Answered at once, no job.
// =================================================================================================
const FILL_BOXES = { start: 'Opening (the first frame: who is where, facing which way, and the place)', end: 'Closing (the last frame: where everyone is and how they stand)', camera: 'Camera across the whole shot', sounds: 'Sounds heard all the way through', around: 'What is happening around them (weather, fire, crowds)' };
async function fillTokens(db) {
  let v = null;
  try { const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get('video_fill_tokens'); v = r ? parseInt(r.value, 10) : null; } catch (e) { v = null; }
  return (Number.isFinite(v) && v >= 1) ? v : 1;
}
function fillWordsText(w, label) {
  if (!w) return label + ': (none)';
  const t = beatTimes(w);
  return label + ':\n' + ['Opening: ' + (w.start || '(empty)'), 'Beats: ' + (w.actions.length ? w.actions.map(function (a, i) { return (i + 1) + '. (' + secsText(t[i].from) + '-' + secsText(t[i].to) + ' s) ' + a + w.lines.filter(function (l) { return l.when === i + 1; }).map(function (l) { return ' [' + (l.who || 'a voice') + (l.off ? ', off screen' : '') + ': "' + l.text + '"]'; }).join(''); }).join(' ') : '(none)'),
    'Camera: ' + (w.camera || '(empty)'), 'Sounds: ' + (w.sounds || '(empty)'), 'Around them: ' + (w.around || '(empty)'), 'Closing: ' + (w.end || '(empty)'), 'Length: ' + w.seconds + ' s'].join('\n');
}
router.post('/shots/:id/fill', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/shots/' + req.params.id + '/fill';
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT * FROM shots WHERE id = ?').get(parseInt(req.params.id, 10));
    const ep = shot ? await db.prepare('SELECT * FROM episodes WHERE id = ?').get(shot.episode_id) : null;
    if (!shot || !(await canChange(req, ep))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!shot });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return vlRefuse(req, res, FN, 500, 'The writer is not set up on this server (ANTHROPIC_API_KEY).');
    const busy = await db.prepare("SELECT id FROM episode_writer_jobs WHERE episode_id = ? AND shot_id IS NULL AND status = 'running' LIMIT 1").get(ep.id);
    if (busy) return vlRefuse(req, res, FN, 409, 'The Director is rewriting the episode. Try when that is done.');
    const w = shotWords(shot) || cleanWords({ seconds: shot.seconds });
    const empty = Object.keys(FILL_BOXES).filter(function (k) { return !String(w[k] || '').trim(); });
    const noBeats = !w.actions.length;
    if (!empty.length && !noBeats) return res.status(400).json({ error: 'NOTHING', message: 'Every box of this shot is filled in already. Clear a box you want the Director to write.' });
    const tokens = await fillTokens(db);
    const bal = await require('./tokens').getBalance(req.session.userId);
    if (bal.total < tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: 'The Director\u2019s Notes for one shot cost ' + tokens + ' token' + (tokens === 1 ? '' : 's') + '.' });
    const all = await db.prepare('SELECT * FROM shots WHERE episode_id = ? ORDER BY position, id').all(ep.id);
    const at = all.findIndex(function (x) { return x.id === shot.id; });
    const prev = at > 0 ? shotWords(all[at - 1]) : null, next = at >= 0 && at < all.length - 1 ? shotWords(all[at + 1]) : null;
    const pool = await refsPool(db, ep).catch(function () { return { characters: [], assets: [] }; });
    const ask = empty.map(function (k) { return '"' + k + '": ' + FILL_BOXES[k]; }).concat(noBeats ? ['"actions": the shot\'s beats in order, a list of strings, about one for every 2.5 seconds of its ' + w.seconds + ' seconds'] : []);
    const system = 'You are the director of an animated episode, writing the words a video model will follow for ONE shot. Fill ONLY the boxes asked for. Everything else in the shot was written by the user: keep to it exactly and make what you write agree with it. Make the Opening follow on from the shot before it and the Closing lead into the shot after it. Plain, visual, present tense; no camera jargon in the Opening or Closing; one or two sentences a box. Reply with JSON only, with just the boxes asked for.';
    const text = ['Overall direction: ' + (ep.overall || '(none)'), 'Characters: ' + (pool.characters.map(function (c) { return c.name; }).join(', ') || '(none)'),
      'Shot ' + (at + 1) + (shot.name ? ' "' + shot.name + '"' : '') + (shot.purpose ? '. Purpose: ' + shot.purpose : '') + (shot.concept ? '. Concept: ' + shot.concept : ''),   // v3.5.99 concept
      fillWordsText(w, 'THIS SHOT, as written so far'), prev ? fillWordsText(prev, 'THE SHOT BEFORE') : 'This is the first shot.', next ? fillWordsText(next, 'THE SHOT AFTER') : 'This is the last shot.',
      'Write these boxes: {' + ask.join(', ') + '}'].join('\n\n');
    const prices = await shotListPrices(db);
    const r = await callShotListModel(key, { max_tokens: 1500, system: system, content: [{ type: 'text', text: text }] });
    if (r.error) return vlRefuse(req, res, FN, 502, 'The Director could not be reached (' + r.error + '). Nothing was charged.');
    const j = readJson(r.text) || {};
    const got = {};
    empty.forEach(function (k) { if (typeof j[k] === 'string' && j[k].trim()) got[k] = j[k].trim(); });
    if (noBeats && Array.isArray(j.actions)) { const a = j.actions.map(textOf).filter(Boolean).slice(0, 12); if (a.length) got.actions = a; }
    if (!Object.keys(got).length) return vlRefuse(req, res, FN, 502, 'The Director\u2019s answer had nothing usable. Nothing was charged; try again.');
    const merged = cleanWords(Object.assign({}, w, got, { beats: got.actions ? null : w.beats }));
    await db.transaction(async function (tx) {
      await writeWords(tx, shot.id, merged);
      await tx.prepare('UPDATE shots SET precheck = NULL WHERE id = ?').run(shot.id);
    });
    const tk = require('./tokens');
    await tk.spendTokens(req.session.userId, tokens, { source: 'video_shot_fill', event_type: 'generation_spend', related_campaign_id: ep.campaign_id });
    const usd = Math.round(usdFor(prices, Number((r.usage && r.usage.input_tokens) || 0), Number((r.usage && r.usage.output_tokens) || 0)) * 10000) / 10000;
    vlDebug(req.session.userId, 'info', FN, 'Filled ' + Object.keys(got).join(', ') + ' for ' + tokens + ' token(s), $' + usd + ' to Campaignia', { usage: r.usage });
    res.json({ ok: true, filled: Object.keys(got), tokens: tokens, episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    console.error('[video] shot fill error:', e && e.message);
    vlDebug(req.session && req.session.userId, 'error', FN, 'Could not fill: ' + (e && e.message), { stack: e && e.stack ? String(e.stack).slice(0, 1500) : '' });
    if (!res.headersSent) res.status(500).json({ error: 'Could not write the notes. Nothing was charged.' });
  }
});
router.post('/episodes/:id/precheck', requireAuth, requireVideo, async function (req, res) {
  const FN = 'POST /api/video-lab/episodes/' + req.params.id + '/precheck';
  try {
    await ensureTables();
    const db = await getDb();
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!(await canChange(req, ep))) return vlRefuse(req, res, FN, 404, 'Not found.', { found: !!ep, admin: !!req.vlAdmin });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return vlRefuse(req, res, FN, 500, 'The Director is not set up on this server (ANTHROPIC_API_KEY).');
    const ctx = await precheckContext(db, ep);
    if (!ctx.pictures.length) return vlRefuse(req, res, FN, 400, 'This episode has no keyframes.');
    // v3.5.38 (Ian, 2026-11-09): shot_id checks that one shot (1 token); none checks them all (2 tokens).
    const shotId = parseInt((req.body || {}).shot_id, 10) || null;
    if (shotId) {
      ctx.only = ctx.shots.findIndex(function (s) { return Number(s.id) === shotId; });
      if (ctx.only < 0) return vlRefuse(req, res, FN, 400, 'That shot has no keyframes, or is not in this episode.');
    }
    const tokens = shotId ? await precheckShotTokens(db) : await precheckTokens(db);
    const bal = await require('./tokens').getBalance(req.session.userId);
    if (bal.total < tokens) return res.status(402).json({ error: 'INSUFFICIENT_TOKENS', message: (shotId ? 'Checking a shot costs ' : 'The pre-production check costs ') + tokens + ' token' + (tokens === 1 ? '' : 's') + ', but you have ' + bal.total + '. Add tokens and try again.' });
    await retireLostJobs(db, ep.id);
    const cl = await claimWriterJob(db, ep.id, shotId, { user_id: req.session.userId, style: ctx.style.key, model: ctx.modelKey, sig: ctx.sig, est_tokens: tokens, kind: 'precheck' });   // v3.5.43
    if (!cl.id) return vlRefuse(req, res, FN, 409, cl.busy);
    const job = await db.prepare('SELECT * FROM episode_writer_jobs WHERE id = ?').get(cl.id);
    vlDebug(req.session.userId, 'info', FN, 'Pre-production check asked for', { only_shot: shotId, shots: ctx.shots.length, keyframes: ctx.pictures.length, tokens: tokens, modes: ctx.info.map(function (x) { return x.mode; }) });
    res.json({ job: jobView(job), estimate: { tokens: tokens } });
    const prices = await shotListPrices(db);
    runPrecheck(job.id, ep.id, req.session.userId, ctx, prices, key, tokens).catch(async function (e) {
      console.error('[video] pre-production check job ' + job.id + ' crashed:', e && e.message);
      try { await db.prepare("UPDATE episode_writer_jobs SET status = 'error', error = ?, finished_at = NOW() WHERE id = ? AND status = 'running'").run('Something went wrong checking it. Nothing was charged; try again.', job.id); } catch (e2) {}
    });
  } catch (e) {
    console.error('[video] pre-production check start error:', e && e.message, e && e.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the pre-production check.' });
  }
});
// A finding dealt with: its fix used, or dismissed. resig: the shot was just changed by that fix, so the check is signed
// again to the shot as it is now and the other findings stay current.
router.post('/shots/:id/precheck-done', requireAuth, requireVideo, async function (req, res) {
  try {
    await ensureTables();
    const db = await getDb();
    const shot = await db.prepare('SELECT * FROM shots WHERE id = ?').get(parseInt(req.params.id, 10));
    const ep = shot ? await db.prepare('SELECT * FROM episodes WHERE id = ?').get(shot.episode_id) : null;
    if (!ep || !(await canChange(req, ep))) return res.status(404).json({ error: 'Not found.' });
    const pc = parseJson(shot.precheck, null);
    if (!pc || !Array.isArray(pc.findings)) return res.status(404).json({ error: 'This shot has not been checked.' });
    const fid = parseInt((req.body || {}).finding, 10);
    const f = pc.findings.filter(function (x) { return Number(x.id) === fid; })[0];
    if (!f) return res.status(404).json({ error: 'That finding is not on this shot.' });
    f.done = (req.body || {}).undo === true ? false : true;
    if ((req.body || {}).resig === true) {
      const kfs = await db.prepare('SELECT * FROM keyframes WHERE shot_id = ? ORDER BY position, id').all(shot.id);
      pc.sig = shotSig(ep, kfs, shot);
    }
    await db.prepare('UPDATE shots SET precheck = ? WHERE id = ?').run(JSON.stringify(pc), shot.id);
    res.json({ episode: await loadEpisode(db, ep.id) });
  } catch (e) {
    console.error('[video] pre-production finding error:', e && e.message);
    res.status(500).json({ error: 'Could not save it.' });
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
module.exports._join = { joinFilter: joinFilter, joinSig: joinSig, chosenSig: chosenSig, needsLocalJoin: needsLocalJoin, LOCAL_JOINS: LOCAL_JOINS, CUT_STYLE_INFO: CUT_STYLE_INFO };   // v3.5.54
module.exports._pics = { enlargeSmallPictures: enlargeSmallPictures };   // v3.5.56
module.exports._stopSweep = function () { if (_timer) clearInterval(_timer); _timer = null; };
module.exports._internals = { finishMove: finishMove, takeStatus: takeStatus, finishTakeMerge: finishTakeMerge, maybeJoinEpisode: maybeJoinEpisode, finishEpisodeJoin: finishEpisodeJoin,
  loadEpisode: loadEpisode, planMoves: planMoves, cleanShots: cleanShots, writeShots: writeShots, shotSig: shotSig, makeShot: makeShot, vlSaveSummary: vlSaveSummary };
module.exports._precheck = { shotMode: shotMode, shotModel: shotModel, modelPartner: modelPartner, cleanShots: cleanShots, shotSig: shotSig, shotModelKey: shotModelKey, epForShot: epForShot, precheckTokens: precheckTokens, precheckContext: precheckContext, precheckRequest: precheckRequest, parsePrecheck: parsePrecheck, runPrecheck: runPrecheck, pcShape: pcShape };
module.exports._shotList = { styleFor: styleFor, snapDuration: snapDuration, usdFor: usdFor, tokensFor: tokensFor, shotListPrices: shotListPrices, estimateShotList: estimateShotList,
  shotListContext: shotListContext, shotListRequest: shotListRequest, parseShotList: parseShotList, moveBoxText: moveBoxText, runShotList: runShotList, retireLostJobs: retireLostJobs, BOOT: SL_BOOT, structureSig: structureSig };
