const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../database/db');

router.post('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { key, artStyle } = req.body;

  if (!key) return res.json({ error: 'API key required' });

  const db = getDb();

  // Verify ownership
  const session = db.prepare(
    'SELECT s.*, c.art_style as campaign_style FROM sessions s JOIN campaigns c ON s.campaign_id = c.id WHERE s.id = ? AND c.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found for this session' });

  // Get characters for this campaign
  const characters = db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(req.params.campaignId);
  const charList = characters.map(function(c) {
    return c.name + ' (' + c.cls + '): ' + c.description;
  }).join('\n');

  const style = artStyle || session.campaign_style || 'High fantasy illustration';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: 'You are a graphic novel director analyzing a TTRPG session transcript. Extract 4-6 key cinematic moments that would make the best graphic novel panels. Focus on dramatic combat, emotional revelations, tense standoffs, and memorable character moments.\n\nArt style: ' + style + '\n\nKnown characters:\n' + charList + '\n\nTranscript:\n' + session.transcript + '\n\nReturn ONLY valid JSON with no markdown fences or explanation:\n{\n  "title": "Session title (4-6 dramatic words)",\n  "moments": [\n    {\n      "title": "Short evocative panel title",\n      "description": "One sentence visual scene description for an artist",\n      "type": "combat|drama|discovery|humor",\n      "prompt": "Detailed image generation prompt in ' + style + ' style. Describe composition, lighting, character positions, mood. 2-3 sentences."\n    }\n  ]\n}'
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
      db.prepare('DELETE FROM moments WHERE session_id = ?').run(session.id);
      const now = new Date().toISOString();
      const insert = db.prepare(
        'INSERT INTO moments (session_id, title, description, type, prompt, panel_order, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      parsed.moments.forEach(function(m, i) {
        insert.run(session.id, m.title, m.description, m.type, m.prompt, i, now, req.session.userId);
      });
    }

    res.json(parsed);
  } catch(e) {
    res.json({ error: e.message });
  }
});

module.exports = router;
