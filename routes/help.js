const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getBalance } = require('./tokens');

// Contextual "Ask Claudia" help: a read-only, one-shot Q&A. Short answers, so a
// lightweight model is plenty; overridable via HELP_MODEL without a code change.
const HELP_MODEL = process.env.HELP_MODEL || 'claude-haiku-4-5-20251001';

// In-memory per-user rate limit (sliding 60s window). Resets on restart, which
// is fine -- this is abuse / runaway-cost protection, not billing. No schema.
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

// POST /api/help/ask  { question, current_view_id?, current_campaign_id? }
router.post('/ask', requireAuth, async function(req, res) {
  const userId = req.session.userId;
  const question = (req.body && typeof req.body.question === 'string') ? req.body.question.trim() : '';
  if (!question) return res.json({ ok: false, error: 'Type a question first.' });
  if (question.length > 1000) return res.json({ ok: false, error: 'That question is a bit long -- try shortening it.' });
  if (rateLimited(userId)) {
    return res.json({ ok: false, error: 'You are asking very quickly -- give it a moment and try again.' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.json({ ok: false, error: 'Help is not configured right now.' });

  // Enrich context authoritatively from the DB -- never trust client-sent values.
  let ctx = { name: 'there', tier: 'unknown', subscription_status: 'unknown', in_free_trial: false,
              utlt: 0, cot: 0, total: 0, role: null };
  try {
    const db = await getDb();
    const u = await db.prepare('SELECT name, tier, subscription_status FROM users WHERE id = ?').get(userId);
    if (u) {
      ctx.name = u.name || 'there';
      ctx.tier = u.tier || 'unknown';
      ctx.subscription_status = u.subscription_status || 'unknown';
      ctx.in_free_trial = (u.subscription_status === 'trialing');
    }
  } catch (e) {}
  try { const b = await getBalance(userId); if (b) { ctx.utlt = b.utlt; ctx.cot = b.cot; ctx.total = b.total; } } catch (e) {}

  const viewId = (req.body && typeof req.body.current_view_id === 'string') ? req.body.current_view_id : '';
  const campaignId = (req.body && req.body.current_campaign_id) ? req.body.current_campaign_id : null;
  const viewName = VIEW_NAMES[viewId] || 'the app';
  if (campaignId) { try { ctx.role = await getCampaignRole(userId, campaignId); } catch (e) {} }

  const system =
    'You are Claudia, the in-app assistant for Campaignia, a tabletop-RPG-to-graphic-novel web app. ' +
    'Answer the question directly and concisely in 1-3 sentences, assuming they already know what Campaignia is. ' +
    'Be warm, confident, and practical. Do not apologize and do not pad the answer.\n\n' +
    'WHO YOU ARE HELPING:\n' +
    '- Name: ' + ctx.name + '\n' +
    '- Plan/tier: ' + ctx.tier + (ctx.in_free_trial ? ' (currently in the free trial)' : '') + '\n' +
    '- Subscription status: ' + ctx.subscription_status + '\n' +
    '- Token balance: ' + ctx.utlt + ' monthly (use-it-or-lose-it) plus ' + ctx.cot + ' carry-over, ' + ctx.total + ' total\n' +
    '- Current screen: ' + viewName + (ctx.role ? '. Role in the current campaign: ' + ctx.role : '') + '\n\n' +
    'HOW CAMPAIGNIA WORKS:\n' +
    'A user creates a campaign, adds characters, then creates sessions and pastes a game transcript. ' +
    'Generate Story extracts the narrative and panel scenes, and images are generated one per panel. ' +
    'On the Storyboard they can edit a panel prompt, regenerate, retouch (an in-place edit), replace from the Archive, ' +
    'lock, or archive an image, and set a per-panel Direction that steers both the prose and the image. ' +
    'Assets (locations, NPCs, items) are reference images matched into panels by name or keyword. ' +
    'Finished stories publish to the public Library or order a printed book. ' +
    'Image generation spends tokens: monthly use-it-or-lose-it tokens first, then carry-over tokens. ' +
    'Tiers from lowest to highest: Free Trial, Copper, Silver, Gold, Platinum.\n\n' +
    'RULES:\n' +
    '- Use the actual tier and token numbers above when the question is about what they can do or afford.\n' +
    '- If a feature needs a higher tier than theirs, say so plainly.\n' +
    '- If the question is not about Campaignia, briefly say so and point them elsewhere.\n' +
    '- You can only answer questions. You cannot change settings, spend tokens, or take any action.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HELP_MODEL,
        max_tokens: 400,
        system: system,
        messages: [{ role: 'user', content: question }]
      })
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
