const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getBalance } = require('./tokens');
const { getTier, ART_STYLE_MIN_RANK, NARRATIVE_STYLE_MIN_RANK } = require('../middleware/tiers');
const { listPacks } = require('../services/billing/packs');

// Contextual in-app help: a short, read-only CHAT. It can ask a
// clarifying question before answering. Short turns, so a lightweight model is
// plenty; overridable via HELP_MODEL without a code change.
const HELP_MODEL = process.env.HELP_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TURNS = 12;   // cap conversation history sent to the model

// The Campaignia Brain is the knowledge base for this assistant. It is loaded
// once at startup from routes/campaignia_brain.md -- to change what the help
// assistant knows, edit that doc (no code change). Falls back to a tiny basics
// note if the file is ever missing so help still answers.
const BRAIN = (function () {
  try { return fs.readFileSync(path.join(__dirname, 'campaignia_brain.md'), 'utf8'); }
  catch (e) { console.error('help: could not load campaignia_brain.md:', e.message); return ''; }
})();

// Style-by-tier and token-pack reference, built once from the live code maps /
// pack catalog (editing those + a restart updates these).
const STYLE_REF = (function () {
  function byTier(map, platinumExtra) {
    const labels = { 1: 'all tiers', 2: 'Silver and up', 3: 'Gold and up', 4: 'Platinum' };
    const buckets = { 1: [], 2: [], 3: [], 4: [] };
    Object.keys(map || {}).forEach(function (k) { const r = map[k] || 1; (buckets[r] || (buckets[r] = [])).push(k); });
    const parts = [];
    [1, 2, 3, 4].forEach(function (r) { if (buckets[r] && buckets[r].length) parts.push(labels[r] + ': ' + buckets[r].join(', ')); });
    if (platinumExtra) parts.push('Platinum: ' + platinumExtra);
    return parts.join('. ');
  }
  try {
    return 'ART & NARRATIVE STYLES BY TIER (a member sees the styles for their EFFECTIVE tier -- the higher of their own and their Story Master\'s):\n' +
      '- Art styles -- ' + byTier(ART_STYLE_MIN_RANK, 'plus your own custom art styles') + '.\n' +
      '- Narrative styles -- ' + byTier(NARRATIVE_STYLE_MIN_RANK, null) + '.';
  } catch (e) { return ''; }
})();

const PACK_REF = (function () {
  try {
    const packs = listPacks() || [];
    if (!packs.length) return '';
    return 'TOKEN PACKS (current catalog; pricing may be finalized at launch): ' +
      packs.map(function (p) { return p.name + ' = ' + p.tokens + ' tokens for $' + (p.price_cents / 100).toFixed(2); }).join('; ') +
      '. Purchased tokens are carry-over and never expire.';
  } catch (e) { return ''; }
})();

// In-memory per-user rate limit (sliding 60s window). Resets on restart, which
// is fine -- abuse / runaway-cost protection, not billing. No schema.
const RATE_MAX = 15;
const RATE_WINDOW_MS = 60000;
const _hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const arr = (_hits.get(userId) || []).filter(function(t){ return now - t < RATE_WINDOW_MS; });
  if (arr.length >= RATE_MAX) { _hits.set(userId, arr); return true; }
  arr.push(now);
  _hits.set(userId, arr);
  return false;
}

const VIEW_NAMES = {
  campaigns_view: 'Campaigns (home)',
  session_detail_view: 'Session detail',
  storyboard_view: 'Storyboard',
  publish_view: 'Publish / Library',
  asset_library_view: 'Asset Library',
  archives_view: 'Archives',
  account_view: 'Account / Billing'
};

// Normalize the client-sent chat history into a valid alternating message list
// that starts with a user turn and ends with a user turn.
function normalizeMessages(body) {
  let msgs = [];
  if (body && Array.isArray(body.messages)) {
    msgs = body.messages
      .filter(function(m){ return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
      .map(function(m){ return { role: m.role, content: String(m.content).trim().slice(0, 2000) }; });
  }
  if (!msgs.length && body && typeof body.question === 'string' && body.question.trim()) {
    msgs = [{ role: 'user', content: body.question.trim().slice(0, 2000) }];
  }
  msgs = msgs.slice(-MAX_TURNS);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // must start with user
  return msgs;
}

// POST /api/help/ask  { messages:[{role,content}], current_view_id?, current_campaign_id? }
router.post('/ask', requireAuth, async function(req, res) {
  const userId = req.session.userId;
  const msgs = normalizeMessages(req.body);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') {
    return res.json({ ok: false, error: 'Type a question first.' });
  }
  if (rateLimited(userId)) {
    return res.json({ ok: false, error: 'You are asking very quickly -- give it a moment and try again.' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'Help is not configured right now.' });

  // Enrich context authoritatively from the DB -- never trust client-sent values.
  let ctx = { name: 'there', tier: 'unknown', subscription_status: 'unknown', in_free_trial: false,
              utlt: 0, cot: 0, total: 0, role: null, vocab: 'ttrpg', cancel_at_period_end: false };
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT name, tier, subscription_status, vocab, trial_started_at, current_period_end, cancel_at_period_end FROM users WHERE id = ?').get(userId);
    if (u) {
      ctx.name = u.name || 'there';
      ctx.tier = u.tier || 'unknown';
      ctx.subscription_status = u.subscription_status || 'unknown';
      ctx.in_free_trial = (u.subscription_status === 'trialing');
      ctx.vocab = u.vocab || 'ttrpg';
      ctx.trial_started_at = u.trial_started_at || null;
      ctx.current_period_end = u.current_period_end || null;
      ctx.cancel_at_period_end = !!u.cancel_at_period_end;
    }
  } catch (e) {}
  try { const b = await getBalance(userId); if (b) { ctx.utlt = b.utlt; ctx.cot = b.cot; ctx.total = b.total; } } catch (e) {}

  // Live account facts (usage + key dates), read fresh each request.
  const accountFacts = [];
  try {
    const dbA = await getDb();
    const cc = await dbA.prepare('SELECT COUNT(*) AS n FROM campaigns WHERE user_id = ? AND is_active = true').get(userId);
    const sc = await dbA.prepare('SELECT COUNT(*) AS n FROM sessions WHERE campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)').get(userId);
    accountFacts.push('- You currently own ' + (((cc && cc.n) || 0)) + ' campaign(s) and ' + (((sc && sc.n) || 0)) + ' session(s).');
  } catch (e) {}
  try {
    if (ctx.in_free_trial && ctx.trial_started_at) {
      const td = (getTier('trial').trial_days) || 30;
      const ends = new Date(new Date(ctx.trial_started_at).getTime() + td * 86400000);
      accountFacts.push('- Your free trial ends on ' + ends.toISOString().slice(0, 10) + '.');
    }
    if (ctx.current_period_end && ctx.cancel_at_period_end) {
      const d = new Date(ctx.current_period_end).toISOString().slice(0, 10);
      accountFacts.push('- Your ' + ctx.tier + ' subscription is set to cancel on ' + d + ". You'll keep access until then, after which your account moves to Copper. (No further charges.)");
    } else if (ctx.current_period_end) {
      accountFacts.push('- Your next billing date is ' + new Date(ctx.current_period_end).toISOString().slice(0, 10) + '.');
    }
  } catch (e) {}

  const viewId = (req.body && typeof req.body.current_view_id === 'string') ? req.body.current_view_id : '';
  const campaignId = (req.body && req.body.current_campaign_id) ? req.body.current_campaign_id : null;
  const viewName = VIEW_NAMES[viewId] || 'the app';
  if (campaignId) { try { ctx.role = await getCampaignRole(userId, campaignId); } catch (e) {} }

  // Live, per-user context. The Brain (knowledge + behavior rules) is appended
  // below; the numbers here are authoritative and override anything generic.
  const vocabCampaign = (ctx.vocab === 'story') ? 'Stories' : 'Campaigns';
  const vocabSession  = (ctx.vocab === 'story') ? 'Chapters' : 'Sessions';
  const isFirstTurn = (msgs.length === 1);   // no prior assistant turn this session

  const header = [
    'You are the in-app help assistant for Campaignia, a tabletop-RPG-to-graphic-novel web app. You are in a short chat inside the app and can see the user account details below. Answer using the Campaignia Brain knowledge that follows. Keep every reply to 1-4 sentences, warm and practical; do not use a personal name for yourself; do not apologize or pad. If the Brain does not cover something, say you are not sure and point them to where to look in the app rather than inventing steps. You can only answer and guide -- you cannot change settings, spend tokens, or take actions.',
    '',
    'WHO YOU ARE HELPING (these live values are authoritative -- use them for any tier/token/billing answer):',
    '- Name: ' + ctx.name,
    '- Plan/tier: ' + ctx.tier + (ctx.in_free_trial ? ' (in the free trial)' : '') + '; subscription: ' + ctx.subscription_status,
    '- Tokens: ' + ctx.utlt + ' monthly (use-it-or-lose-it) plus ' + ctx.cot + ' carry-over, ' + ctx.total + ' total',
    '- Current screen: ' + viewName + (ctx.role ? '. Role in the current campaign: ' + ctx.role : ''),
    '- This user calls campaigns "' + vocabCampaign + '" and sessions "' + vocabSession + '" -- use those words regardless of how the Brain phrases them.',
    (isFirstTurn ? '- This is the user\u2019s first message this session: open with a brief, warm thank-you for trying Campaignia, then answer.' : ''),
    ''
  ].filter(function (l) { return l !== ''; });

  const fallback = 'CAMPAIGNIA BASICS: Campaignia turns tabletop-RPG sessions into AI-illustrated graphic novels. Users create a campaign, add characters, create sessions and paste a transcript, click Generate Story to extract panels, edit the storyboard, then publish to the public Library or order a printed book. Tokens pay for image generation. If unsure, suggest the user explore the relevant screen.';

  // Live tier matrix -- getTier() merges dashboard overrides, so these are the
  // current authoritative numbers for EVERY tier (not just the user's own).
  function _n(v){ return (v === null || v === undefined) ? 'unlimited' : v; }
  const _tierMatrix = ['trial','copper','silver','gold','platinum'].map(function (nm) {
    const t = getTier(nm) || {};
    if (nm === 'copper') {
      return '- Copper (free floor): 0 free tokens/month (token packs only); cannot create its own campaigns or sessions; archives/campaign ' + _n(t.max_archives_per_campaign) + '; assets/campaign ' + _n(t.max_assets) + '. A Copper member works inside a paid Story Master\'s campaign and inherits that campaign\'s creative options.';
    }
    const mom = Math.max(t.max_moments_short || 0, t.max_moments_medium || 0, t.max_moments_long || 0, t.max_moments_epic || 0);
    return '- ' + (t.name || nm) + ': ' + _n(t.monthly_utlt) + ' monthly use-it-or-lose-it + ' + _n(t.monthly_cot) + ' carry-over tokens/month; campaigns ' + _n(t.max_campaigns) + '; sessions/campaign ' + _n(t.max_sessions) + '; characters ' + _n(t.max_characters) + '; archives/campaign ' + _n(t.max_archives_per_campaign) + '; assets/campaign ' + _n(t.max_assets) + '; up to ' + mom + ' moments/session.';
  }).join('\n');
  const tierBlock = 'LIVE TIER NUMBERS (authoritative, pulled live from the dashboard -- use these for any "how many / which tier" question, for ANY tier, not just the user\'s own):\n' + _tierMatrix;

  const extras = [accountFacts.join('\n'), STYLE_REF, PACK_REF].filter(function (b) { return b; }).join('\n\n');
  const system = header.join('\n') + '\n\n' + tierBlock + '\n\n' + extras + '\n\n' + (BRAIN || fallback);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: HELP_MODEL, max_tokens: 500, system: system, messages: msgs })
    });
    const data = await response.json();
    if (data.error) {
      console.error('help/ask API error:', response.status, JSON.stringify(data.error));
      return res.json({ ok: false, error: 'Could not answer that right now.' });
    }
    const answer = (data.content || []).map(function(b){ return b.text || ''; }).join('').trim();
    if (!answer) {
      console.error('help/ask empty answer:', response.status, JSON.stringify(data).slice(0, 400));
      return res.json({ ok: false, error: 'Could not answer that right now.' });
    }
    return res.json({ ok: true, answer: answer });
  } catch (e) {
    console.error('help/ask error:', e.message);
    return res.json({ ok: false, error: 'Could not answer that right now.' });
  }
});

module.exports = router;
