const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

// ============================================================
// GENERATE narrative prose for a session
// ============================================================
router.post('/generate/:campaignId/:sessionId', requireAuth, async function(req, res) {
  // Use platform key from env, fall back to request body key
  const key = process.env.ANTHROPIC_API_KEY || req.body.key;
  if (!key) return res.json({ error: 'AI service not configured. Please contact support.' });

  const db = await getDb();

  // Verify ownership and get session
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ? AND cm.role = \'dm\''
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found. Please add a transcript first.' });

  // Get moments in order
  const moments = await db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(session.id);
  if (!moments.length) return res.json({ error: 'No moments found. Please extract key moments first.' });

  // Get campaign and characters
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(session.campaign_id);

  const charList = characters.map(function(c) {
    return c.name + (c.player_name ? ' (played by ' + c.player_name + ')' : '') + ' — ' + (c.cls || '') + ': ' + (c.description || '');
  }).join('\n');

  const momentsList = moments.map(function(m, i) {
    return 'Panel ' + (i + 1) + ': ' + m.title + '\n' + m.description;
  }).join('\n\n');

  const prompt =
    'You are a skilled fantasy author writing the narrative for a graphic novel based on a real TTRPG session.\n\n' +
    'Campaign: ' + campaign.name + '\n' +
    'Session: ' + session.name + '\n' +
    'Date: ' + session.session_date + '\n\n' +
    'Characters:\n' + charList + '\n\n' +
    'The session has been broken into ' + moments.length + ' key illustrated panels:\n\n' +
    momentsList + '\n\n' +
    (session.session_notes ? 'DM Notes:\n' + session.session_notes + '\n\n' : '') +
    'Full session transcript:\n' + session.transcript + '\n\n' +
    'Your task: Write narrative prose for this graphic novel session. The prose should:\n' +
    '- Read like a fantasy novel or comic book caption — vivid, dramatic, engaging\n' +
    '- NOT be a transcription of what players said\n' +
    '- Bridge the story between illustrated panels naturally\n' +
    '- Use present tense, third person narrative voice\n' +
    '- Be 2-4 sentences per section — punchy, not bloated\n' +
    '- Capture the mood, tension, and drama of each moment\n' +
    '- Reference characters by name\n\n' +
    'Return ONLY valid JSON, no markdown:\n' +
    '{\n' +
    '  "intro": "Opening paragraph that sets the scene before the first panel (2-3 sentences)",\n' +
    '  "intro_summary": "A terse outline of the opening — what the reader needs to know. As short as possible while capturing the key beats. Maximum 25 words; aim shorter if you can.",\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "panel_index": 0,\n' +
    '      "before": "",\n' +
    '      "after": "Prose that bridges FROM this panel to the next (2-3 sentences)",\n' +
    '      "after_summary": "A terse outline of what happens between this panel and the next — captures real story events the panels skip (travel, debate, side encounters). As short as possible. Maximum 25 words; aim shorter if you can. Do NOT pad to length."\n' +
    '    }\n' +
    '  ],\n' +
    '  "outro": "Closing paragraph after the final panel (2-3 sentences)",\n' +
    '  "outro_summary": "A terse outline of the closing — how the session ends. As short as possible. Maximum 25 words; aim shorter if you can."\n' +
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
        max_tokens: 3000,
        system: 'You are a skilled fantasy author writing graphic novel narrative prose. You write in a vivid, dramatic style appropriate for fantasy graphic novels. You always return valid JSON.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const raw = data.content.map(function(b) { return b.text || ''; }).join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Save to database — sections JSON already carries each panel's
    // after_summary; intro/outro summaries get their own columns.
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE sessions SET narrative_intro=?, narrative_intro_summary=?, ' +
      'narrative_sections=?, narrative_outro=?, narrative_outro_summary=?, ' +
      'edited_at=?, edited_by=? WHERE id=?'
    ).run(
      parsed.intro || '',
      parsed.intro_summary || '',
      JSON.stringify(parsed.sections || []),
      parsed.outro || '',
      parsed.outro_summary || '',
      now, req.session.userId, session.id
    );

    res.json({
      success: true,
      intro: parsed.intro || '',
      sections: parsed.sections || [],
      outro: parsed.outro || ''
    });

  } catch(e) {
    console.error('Narrative generation error:', e.message);
    res.json({ error: e.message });
  }
});

// ============================================================
// SAVE narrative (after DM edits)
// ============================================================
router.put('/save/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { intro, sections, outro } = req.body;

  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ? AND cm.role = \'dm\''
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE sessions SET narrative_intro=?, narrative_sections=?, narrative_outro=?, edited_at=?, edited_by=? WHERE id=?'
  ).run(
    intro || '',
    JSON.stringify(sections || []),
    outro || '',
    now, req.session.userId, session.id
  );

  res.json({ success: true });
});

// ============================================================
// GET narrative for a session
// ============================================================
router.get('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ? AND cm.role = \'dm\''
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  res.json({
    intro: session.narrative_intro || '',
    sections: session.narrative_sections ? JSON.parse(session.narrative_sections) : [],
    outro: session.narrative_outro || ''
  });
});

module.exports = router;
