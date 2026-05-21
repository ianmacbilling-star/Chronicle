const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getTier, getMomentRange } = require('../middleware/tiers');
const { getDb } = require('../database/db');

router.post('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { key, artStyle } = req.body;

  if (!key) return res.json({ error: 'API key required' });

  const db = await getDb();

  // Verify ownership
  const session = await db.prepare(
    'SELECT s.*, c.art_style as campaign_style FROM sessions s JOIN campaigns c ON s.campaign_id = c.id WHERE s.id = ? AND c.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found for this session' });

  // Get characters for this campaign
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(req.params.campaignId);
  const charList = characters.map(function(c) {
    var playerInfo = c.player_name ? ' (played by ' + c.player_name + ')' : '';
    return c.name + playerInfo + ' (' + c.cls + '): ' + c.description;
  }).join('\n');

  const style = artStyle || session.campaign_style || 'High fantasy illustration';

  // Scale moment count to transcript length based on user tier
  const wordCount = session.transcript.split(/\s+/).length;
  const db2 = await getDb();
  const userForTier = await db2.prepare('SELECT tier FROM users WHERE id = ?').get(req.session.userId);
  const userTier = userForTier ? userForTier.tier : 'copper';
  const momentCount = getMomentRange(userTier, wordCount);

  // Parse session notes into mandatory and optional directives
  const notesSection = session.session_notes
    ? '\n\n## DIRECTOR\'S INSTRUCTIONS — FOLLOW THESE EXACTLY:\n' +
      session.session_notes + '\n\n' +
      'IMPORTANT: The director\'s instructions above are mandatory. ' +
      'If the DM has specified particular scenes, moments, or visual details, ' +
      'you MUST include those as panels even if they seem less dramatic than other moments. ' +
      'If the DM has specified mood, lighting, or atmosphere, apply it to ALL image prompts. ' +
      'The DM\'s vision takes priority over your own judgment about what is cinematic.'
    : '';

  const systemPrompt = 'You are a graphic novel director and storyboard artist analyzing a TTRPG session transcript. ' +
    'Your job is to identify the key moments that will make the most compelling graphic novel panels. ' +
    'You follow the DM\'s director instructions precisely and without deviation. ' +
    'When a DM specifies a scene must be included, you include it. ' +
    'When a DM specifies a visual style or atmosphere, you apply it consistently to every panel.';

  const userPrompt =
    '## ART STYLE\n' + style + '\n\n' +
    '## KNOWN CHARACTERS (maintain exact appearance in all image prompts)\n' + charList +
    notesSection + '\n\n' +
    '## SESSION TRANSCRIPT\n' + session.transcript + '\n\n' +
    '## YOUR TASK\n' +
    'Extract 4-6 key moments for graphic novel panels. ' +
    'Focus on dramatic combat, emotional revelations, tense standoffs, and memorable character moments. ' +
    'If the director\'s instructions specify particular scenes, those MUST be included as panels.\n\n' +
    'Return ONLY valid JSON with no markdown fences or explanation:\n' +
    '{\n' +
    '  "title": "Session title (4-6 dramatic words)",\n' +
    '  "moments": [\n' +
    '    {\n' +
    '      "title": "Short evocative panel title",\n' +
    '      "description": "One sentence visual scene description for an artist",\n' +
    '      "type": "combat|drama|discovery|humor",\n' +
    '      "emphasis": "ONLY for combat moments: a punchy 1-3 word comic-style emphasis phrase that fits THIS specific moment (e.g. \\"Steel meets steel!\\", \\"The wards shatter!\\", \\"No escape!\\"). It must make sense for what actually happens in the moment — not a generic sound effect. For non-combat moments, use an empty string.",\n' +
    '      "prompt": "Detailed image generation prompt in ' + style + ' style. Describe composition, lighting, character positions, mood, and any specific visual details from the director\'s instructions. 2-3 sentences."\n' +
    '    }\n' +
    '  ]\n' +
    '}';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userPrompt
        }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const raw = data.content.map(function(b) { return b.text || ''; }).join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Auto-save moments to database
    if (parsed.moments && parsed.moments.length) {
      await db.prepare('DELETE FROM moments WHERE session_id = ?').run(session.id);
      const now = new Date().toISOString();

      // Save the art style used so future sessions can inherit it
      await db.prepare('UPDATE sessions SET art_style = ?, edited_at = ?, edited_by = ? WHERE id = ?')
        .run(style, now, req.session.userId, session.id);

      const insert = await db.prepare(
        'INSERT INTO moments (session_id, title, description, type, prompt, emphasis, panel_order, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      parsed.moments.forEach(function(m, i) {
        insert.run(session.id, m.title, m.description, m.type, m.prompt, m.emphasis || null, i, now, req.session.userId);
      });
    }

    res.json(parsed);
  } catch(e) {
    res.json({ error: e.message });
  }
});

module.exports = router;
