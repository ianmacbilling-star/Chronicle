const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getTier, getMomentRange } = require('../middleware/tiers');
const { getDb } = require('../database/db');

router.post('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { artStyle } = req.body;
  const key = process.env.ANTHROPIC_API_KEY || req.body.key;

  if (!key) return res.json({ error: 'AI service is not configured. Please contact support.' });

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
    'This transcript is approximately ' + wordCount + ' words long. ' +
    'Based on its length and the level of detail, extract ' + momentCount + ' key moments ' +
    'for graphic novel panels (aim within that range). ' +
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
    '      "prompt": "Detailed image generation prompt describing the SCENE ONLY. Describe composition, lighting, character positions, mood, and any specific visual details from the director\'s instructions. 2-3 sentences. Do NOT mention or name an art style, medium, or rendering technique - the art style is applied separately at image-generation time, so the prompt must stay style-neutral. IMPORTANT for character consistency: whenever a known character appears, restate their key physical descriptors (hair, build, distinctive features, signature outfit and colors) right in the prompt - do not just use their name, because the image model has no memory between panels."\n' +
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
        max_tokens: 8000,
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

      // Snapshot each character present in this session (Stage 2)
      await snapshotSessionCharacters(db, session, req.params.campaignId, req.session.userId, now);
    }

    res.json(parsed);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ============================================================
// STAGE 2 — per-session character snapshots
// ============================================================

// Detect whether a character is "present" in the session by name match.
function characterInText(character, text) {
  if (!character.name) return false;
  var lower = text.toLowerCase();
  var full = character.name.toLowerCase();
  var first = full.split(/\s+/)[0];
  return lower.indexOf(full) !== -1 || (first.length > 2 && lower.indexOf(first) !== -1);
}

// Resolve the snapshot prompt for a character, using the agreed priority:
//   1. that character's snapshot from the most recent PRIOR session (by date)
//   2. the character's canonical_prompt
//   3. the character's raw description
async function resolveSnapshotPrompt(db, character, currentSession) {
  // 1. Walk prior sessions by date for the most recent snapshot of this character
  var prior = await db.prepare(
    'SELECT sc.prompt FROM session_characters sc ' +
    'JOIN sessions s ON sc.session_id = s.id ' +
    'WHERE sc.character_id = ? AND s.campaign_id = ? ' +
    'AND s.session_date < ? AND sc.prompt IS NOT NULL ' +
    'ORDER BY s.session_date DESC LIMIT 1'
  ).get(character.id, currentSession.campaign_id, currentSession.session_date);
  if (prior && prior.prompt) return prior.prompt;

  // 2. Canonical prompt
  if (character.canonical_prompt && character.canonical_prompt.trim()) {
    return character.canonical_prompt;
  }
  // 3. Raw description
  return character.description || '';
}

// Build/refresh snapshot rows for every character present in this session.
async function snapshotSessionCharacters(db, session, campaignId, userId, now) {
  try {
    const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaignId);
    if (!characters.length) return;

    const text = session.transcript || '';

    // Full refresh — re-extraction rebuilds snapshots for this session
    await db.prepare('DELETE FROM session_characters WHERE session_id = ?').run(session.id);

    for (const ch of characters) {
      if (!characterInText(ch, text)) continue;
      const prompt = await resolveSnapshotPrompt(db, ch, session);
      await db.prepare(
        'INSERT INTO session_characters (session_id, character_id, prompt, change_note, created_at) ' +
        'VALUES (?, ?, ?, ?, ?)'
      ).run(session.id, ch.id, prompt, null, now);
    }
  } catch(e) {
    console.error('snapshotSessionCharacters error:', e.message);
  }
}

module.exports = router;
