// v3.6.76 -- TD-1148 stage 1 (Ian, 2026-11-17: "anywhere we can record the actual cost along with the token spend
// would be great... That way we can run real numbers going forward"). Spec: claude/TOKEN_COST_BASIS_SPEC.md.
//
// Three jobs, one place:
// 1. THE COST BASIS. cost_cents_per_token (dashboard, Financial tab) is how many cents of our provider cost one token
//    covers. Missing or bad, each caller keeps its old setting (shotlist_cents_per_token for video,
//    layout_loop_cost_cents for layout), then 8. So nothing changes until Ian sets it.
// 2. OUR PROVIDER COSTS, as settings with defaults: a picture per image model, a minute of transcription, Claude's
//    rates per model family. Edited on the Financial tab.
// 3. WHAT CLAUDE REALLY COST. Every call to api.anthropic.com/v1/messages goes through global fetch; a hook reads the
//    usage Anthropic returns, prices it, keeps it on the current request (AsyncLocalStorage) and writes one ai_calls
//    row. recordGeneration then takes what the request has used so far and stores it on its generation_events row.
//    Never throws into a caller: a missed cost record must never block a generation.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const DEFAULTS = {
  cents: 8,
  audioMinute: 0.008,                          // fal Scribe v2, $ a minute (2026-11-13)
  claude: { sonnet: [3, 15], haiku: [1, 5], opus: [5, 25] },   // $ per million tokens, in / out (list prices)
  images: { 'nano-banana-2.1': 0.04, 'nano-banana-2': 0.08 }   // $ a picture (Ian, 2026-11-16/17: 2.1 is 4 cents)
};

let _db = null;
async function db() { if (!_db) _db = await require('../database/db').getDb(); return _db; }

// ---- settings, cached for a minute (every Claude call reads the rates) -------------------------------------------
let _cache = null, _cacheAt = 0;
async function loadSettings(force) {
  if (!force && _cache && Date.now() - _cacheAt < 60000) return _cache;
  const s = { cents: null, oldShot: null, oldLayout: null, audioMinute: DEFAULTS.audioMinute,
    claude: JSON.parse(JSON.stringify(DEFAULTS.claude)), images: Object.assign({}, DEFAULTS.images) };
  try {
    const d = await db();
    const rows = await d.prepare("SELECT setting_key, value FROM app_settings WHERE setting_key IN ('cost_cents_per_token','shotlist_cents_per_token','layout_loop_cost_cents','unit_cost:audio_minute') OR setting_key LIKE 'unit_cost:image:%' OR setting_key LIKE 'claude_rate:%'").all();
    for (const r of rows || []) {
      const k = r.setting_key, v = String(r.value == null ? '' : r.value).trim();
      const n = parseFloat(v);
      if (k === 'cost_cents_per_token' && n >= 1) s.cents = n;
      else if (k === 'shotlist_cents_per_token' && n > 0) s.oldShot = n;
      else if (k === 'layout_loop_cost_cents' && n >= 1) s.oldLayout = n;
      else if (k === 'unit_cost:audio_minute' && n >= 0) s.audioMinute = n;
      else if (k.indexOf('unit_cost:image:') === 0 && n >= 0) s.images[k.slice(16)] = n;
      else if (k.indexOf('claude_rate:') === 0) {
        const p = v.split('/').map(parseFloat);
        if (p.length === 2 && p[0] >= 0 && p[1] >= 0) s.claude[k.slice(12)] = p;
      }
    }
  } catch (e) { /* defaults */ }
  _cache = s; _cacheAt = Date.now();
  return s;
}
function forget() { _cache = null; }

// The basis, in cents a token. scope: 'video' or 'layout' fall back to their old setting; anything else to 8.
async function centsPerToken(scope) {
  const s = await loadSettings();
  if (s.cents) return s.cents;
  if (scope === 'video' && s.oldShot) return s.oldShot;
  if (scope === 'layout' && s.oldLayout) return s.oldLayout;
  return DEFAULTS.cents;
}
// Tokens for a cost: nearest, half up (Ian, 2026-11-17: "1.2 ... round down. 1.5 ... round up"), never below min.
function tokensFor(usd, cents, min) {
  const c = Number(cents) > 0 ? Number(cents) : DEFAULTS.cents;
  const t = Math.floor(Number(usd || 0) * 100 / c + 0.5 + 1e-9);
  return Math.max(min == null ? 1 : min, Number.isFinite(t) ? t : 0);
}

// ---- prices -------------------------------------------------------------------------------------------------------
function family(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('haiku') >= 0) return 'haiku';
  if (m.indexOf('opus') >= 0) return 'opus';
  return 'sonnet';
}
function claudeUsd(s, model, u) {
  const r = (s.claude[family(model)] || DEFAULTS.claude.sonnet);
  const inT = Number(u.input_tokens) || 0, outT = Number(u.output_tokens) || 0;
  const cw = Number(u.cache_creation_input_tokens) || 0, cr = Number(u.cache_read_input_tokens) || 0;
  // cache writes at 1.25x the input rate, cache reads at 0.1x (Anthropic's list multipliers)
  return (inT * r[0] + cw * r[0] * 1.25 + cr * r[0] * 0.1 + outT * r[1]) / 1e6;
}
// A picture's model as logged ('nano2', a fal endpoint, an edit endpoint) to a price key.
function imageKey(model) {
  let m = String(model || '').toLowerCase();
  if (m === 'nano2' || m === '') {
    try { m = String(require('../config/models').IMAGE_MODELS.nano2 || '').toLowerCase(); } catch (e) {}
  }
  m = m.replace(/\/edit$/, '');
  if (m.indexOf('nano-banana-2.1') >= 0) return 'nano-banana-2.1';
  if (m.indexOf('nano-banana-2') >= 0) return 'nano-banana-2';
  return m.split('/').pop() || null;
}
function imageUsdSync(model) {
  const s = _cache || { images: DEFAULTS.images };
  const k = imageKey(model);
  return (k && s.images[k] != null) ? Number(s.images[k]) : null;
}
async function imageUsd(model) { await loadSettings(); return imageUsdSync(model); }
async function audioMinuteUsd() { return (await loadSettings()).audioMinute; }

// ---- the per-request record ---------------------------------------------------------------------------------------
function middleware(req, res, next) { als.run({ req: req, calls: [] }, next); }
function store() { return als.getStore() || null; }

// Take the Claude usage this request has run up since the last take. { calls, in, out, usd }
function takeClaude() {
  const st = store();
  const out = { calls: 0, in: 0, out: 0, usd: 0 };
  if (!st || !st.calls.length) return out;
  for (const c of st.calls.splice(0)) { out.calls++; out.in += c.in; out.out += c.out; out.usd += c.usd; }
  return out;
}

async function noteClaude(json) {
  try {
    if (!json || !json.usage) return;
    const s = await loadSettings();
    const u = json.usage;
    const usd = claudeUsd(s, json.model, u);
    const inAll = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
    const st = store();
    if (st) st.calls.push({ in: inAll, out: Number(u.output_tokens) || 0, usd: usd });
    const req = st && st.req;
    const uid = req && req.session && req.session.userId ? req.session.userId : null;
    const where = req ? String((req.method || '') + ' ' + (req.baseUrl || '') + (req.path || '')).slice(0, 200) : 'background';
    // the row is written in the background: the caller gets its answer without waiting for our bookkeeping
    db().then(function (d) { return d.prepare('INSERT INTO ai_calls (user_id, route, model, in_tokens, out_tokens, cache_write_tokens, cache_read_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, where, String(json.model || ''), Number(u.input_tokens) || 0, Number(u.output_tokens) || 0,
        Number(u.cache_creation_input_tokens) || 0, Number(u.cache_read_input_tokens) || 0, Math.round(usd * 1e6) / 1e6); })
      .catch(function (e) { try { console.warn('[aiCost] ai_calls row not written:', e.message); } catch (_e) {} });
  } catch (e) { try { console.warn('[aiCost] not recorded:', e.message); } catch (_e) {} }
}

// Wrap global fetch once: a successful Anthropic messages call has its usage read from a copy of the response.
let _hooked = false;
function hookFetch() {
  if (_hooked || typeof globalThis.fetch !== 'function') return;
  _hooked = true;
  const orig = globalThis.fetch;
  globalThis.fetch = async function (url, init) {
    const res = await orig.apply(this, arguments);
    try {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (res && res.ok && u.indexOf('api.anthropic.com/v1/messages') >= 0 && u.indexOf('count_tokens') < 0) {
        const json = await res.clone().json().catch(function () { return null; });
        await noteClaude(json);
      }
    } catch (e) { /* never in the way */ }
    return res;
  };
}

module.exports = { DEFAULTS, loadSettings, forget, centsPerToken, tokensFor, claudeUsd, family, imageKey, imageUsd, imageUsdSync,
  audioMinuteUsd, middleware, store, takeClaude, noteClaude, hookFetch };
