const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getBalance } = require('./tokens');

// Contextual in-app help: a short, read-only CHAT. It can ask a
// clarifying question before answering. Short turns, so a lightweight model is
// plenty; overridable via HELP_MODEL without a code change.
const HELP_MODEL = process.env.HELP_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TURNS = 12;   // cap conversation history sent to the model

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

  const lines = [
    'You are the in-app help assistant for Campaignia, a tabletop-RPG-to-graphic-novel web app. You are in a short chat inside the app and can see the user account details below. Keep every message to 1-4 sentences, warm and practical; do not use a personal name for yourself; do not apologize or pad.',
    '',
    'BE INQUISITIVE: when a request could mean several different things, ask ONE short clarifying question (offer the likely options) before answering, instead of guessing. Use the current screen below as a strong hint about what they probably mean. Ask at most two clarifying questions in a row; after that, give your best concrete answer. If the request is already specific, just answer with the steps.',
    '',
    'WHO YOU ARE HELPING:',
    '- Name: ' + ctx.name,
    '- Plan/tier: ' + ctx.tier + (ctx.in_free_trial ? ' (in the free trial)' : '') + '; subscription: ' + ctx.subscription_status,
    '- Tokens: ' + ctx.utlt + ' monthly (use-it-or-lose-it) plus ' + ctx.cot + ' carry-over, ' + ctx.total + ' total',
    '- Current screen: ' + viewName + (ctx.role ? '. Role in the current campaign: ' + ctx.role : ''),
    '',
    'VOCABULARY: address the user in their own terms -- they call campaigns "' + (ctx.vocab === 'story' ? 'Stories' : 'Campaigns') + '" and sessions "' + (ctx.vocab === 'story' ? 'Chapters' : 'Sessions') + '". Use those words in your replies regardless of how the steps below are phrased.',
    '',
    'WHAT CAMPAIGNIA CAN DO (use these concrete steps when answering):',
    '- Create a campaign on the home screen; open it to add characters and sessions.',
    '- CAMPAIGN TILE IMAGE: open a campaign, click its three-dots menu (Campaign settings), and under "Campaign image" pick an image from the Archive. It shows on the campaign tile and becomes the default cover when publishing if no cover is set.',
    '- SESSIONS: inside a campaign, create a session and paste the game transcript, then Generate Story to extract the narrative and panel scenes; one image is generated per panel.',
    '- STORYBOARD: each panel has controls to Edit prompt, Regenerate, Retouch (an in-place edit of the current image), Replace from the Archive, Lock, and Archive.',
    '- ARCHIVE: the Archive is a manual store of saved image copies; images do NOT go there automatically. To save one, click the Archive (treasure-chest) button on a panel or character image. The images in the Archive are what you choose from when setting a Campaign image, a cover, or using Copy to Assets.',
    '- REVIEW TAB: each panel has a Direction button that steers BOTH the narrative and the image for that panel; it applies when the panel is generated or regenerated.',
    '- ASSETS: the Asset Library holds reference images (locations, NPCs, items) matched into panels by name or keyword (separate alternate names with a slash). You can also turn an archived image into an asset with the Copy to Assets button on the Archive screen.',
    '- COVERS: choose Cover, Back, and Title images in the Pre-Publish Prep panel when publishing.',
    '- PUBLISH: publish a finished story to the public Library as a web page, or order a printed book.',
    '- TOKENS: generating images spends tokens (monthly use-it-or-lose-it first, then carry-over). Tiers low to high: Free Trial, Copper, Silver, Gold, Platinum.',
    '',
    'RULES:',
    '- Use the actual tier and token numbers above when relevant.',
    '- If a feature needs a higher tier than theirs, say so.',
    '- If the question is not about Campaignia, briefly redirect.',
    '- Only describe features and steps listed above. If you are not certain how something works, say you are not sure and suggest where to look in the app, rather than inventing steps.',
    '- You can only answer and guide; you cannot change settings, spend tokens, or take actions.'
  ];
  const system = lines.join('\n');

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
