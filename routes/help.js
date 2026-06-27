const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getDb } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getBalance } = require('./tokens');

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
              utlt: 0, cot: 0, total: 0, role: null, vocab: 'ttrpg' };
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT name, tier, subscription_status, vocab FROM users WHERE id = ?').get(userId);
    if (u) {
      ctx.name = u.name || 'there';
      ctx.tier = u.tier || 'unknown';
      ctx.subscription_status = u.subscription_status || 'unknown';
      ctx.in_free_trial = (u.subscription_status === 'trialing');
      ctx.vocab = u.vocab || 'ttrpg';
    }
  } catch (e) {}
  try { const b = await getBalance(userId); if (b) { ctx.utlt = b.utlt; ctx.cot = b.cot; ctx.total = b.total; } } catch (e) {}

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

  const system = header.join('\n') + '\n\n' + (BRAIN || fallback);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: HELP_MODEL, max_tokens: 500, system: system, messages: msgs })
    });
    const data = await response.json();
    if (data.error) return res.json({ ok: false, error: 'Could not answer that right now.' });
    const answer = (data.content || []).map(function(b){ return b.text || ''; }).join('').trim();
    if (!answer) return res.json({ ok: false, error: 'Could not answer that right now.' });
    return res.json({ ok: true, answer: answer });
  } catch (e) {
    console.error('help/ask error:', e.message);
    return res.json({ ok: false, error: 'Could not answer that right now.' });
  }
});

module.exports = router;
