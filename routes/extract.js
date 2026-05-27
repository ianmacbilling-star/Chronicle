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
    '## KNOWN CHARACTERS (appearance reference only)\n' + charList + '\n' +
    'IMPORTANT: the list above is an appearance reference, NOT a cast list for ' +
    'this session. Only include a character in a panel if they ACTUALLY APPEAR ' +
    'in the transcript below. Do NOT add a character to a scene just because ' +
    'they are on this list — many of them are not in this session. If a ' +
    'character is not present in the transcript, they must not appear in any panel.\n' +
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
    '      "prompt": "Detailed image generation prompt describing the SCENE ONLY. Describe composition, lighting, character positions, mood, and any specific visual details from the director\'s instructions. 2-3 sentences. Do NOT mention or name an art style, medium, or rendering technique - the art style is applied separately at image-generation time, so the prompt must stay style-neutral. CRITICAL FOR CHARACTER CONSISTENCY: every time a KNOWN named character appears in the prompt, you MUST refer to them BY THEIR EXACT NAME (e.g. write \\"Ruk, a massive half-orc with ritual scars\\" - never just \\"a half-orc\\" or \\"the warrior\\"). Always attach their name directly to their description. Never describe a known character anonymously or with an indefinite phrase - the name tells the system this is a specific recurring character, not a random one. Use the name even on later mentions in the same prompt. Only use generic descriptions like \\"a half-orc\\" for unnamed background figures who are NOT known characters."\n' +
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

      // Snapshot each character present in this session (self-contained).
      await snapshotSessionCharacters(db, session, req.params.campaignId, req.session.userId, now);

      // Stage 3: scan for major permanent changes and flag them for review.
      await detectCharacterChanges(db, session, req.params.campaignId, key, now);
    }

    // Tell the frontend whether any character changes need review, so it
    // can route to the Characters tab instead of the Storyboard tab.
    let pendingChanges = 0;
    try {
      const pc = await db.prepare(
        "SELECT COUNT(*) AS c FROM session_characters WHERE session_id = ? AND change_status = 'pending'"
      ).get(req.params.sessionId);
      pendingChanges = pc ? pc.c : 0;
    } catch(pcErr) { pendingChanges = 0; }

    parsed.pendingChanges = pendingChanges;
    res.json(parsed);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ============================================================
// STAGE 3 — per-session character snapshots (self-contained)
// Each session stores its OWN copy of prompt + reference_url.
// No walk-back at read time. Extraction copies the prior session's
// values forward, then a dedicated AI call flags major changes.
// ============================================================

// Detect whether a character is "present" in the session by name match.
function characterInText(character, text) {
  if (!character.name) return false;
  var lower = text.toLowerCase();
  var full = character.name.toLowerCase();
  var first = full.split(/\s+/)[0];
  return lower.indexOf(full) !== -1 || (first.length > 2 && lower.indexOf(first) !== -1);
}

// Resolve a character's prompt + reference_url to copy into THIS session,
// using the agreed priority:
//   1. that character's snapshot from the most recent PRIOR session (by date)
//   2. the character's canonical_prompt / canonical_reference_url
//   3. the character's raw description / null
async function resolveCarryForward(db, character, currentSession) {
  var prior = await db.prepare(
    'SELECT sc.prompt, sc.reference_url FROM session_characters sc ' +
    'JOIN sessions s ON sc.session_id = s.id ' +
    'WHERE sc.character_id = ? AND s.campaign_id = ? ' +
    'AND s.session_date < ? ' +
    'ORDER BY s.session_date DESC LIMIT 1'
  ).get(character.id, currentSession.campaign_id, currentSession.session_date);

  var prompt = (prior && prior.prompt)
    ? prior.prompt
    : (character.canonical_prompt && character.canonical_prompt.trim()
        ? character.canonical_prompt
        : (character.description || ''));

  var referenceUrl = (prior && prior.reference_url)
    ? prior.reference_url
    : (character.canonical_reference_url || null);

  return { prompt: prompt, referenceUrl: referenceUrl };
}

// Build snapshot rows for every character present in this session.
// Each row is self-contained: its own prompt + reference_url, copied
// forward. change_flag / change_detail are filled by detectCharacterChanges.
async function snapshotSessionCharacters(db, session, campaignId, userId, now) {
  try {
    const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaignId);
    if (!characters.length) return;

    // Name-match against transcript + session notes combined.
    const text = (session.transcript || '') + '\n' + (session.session_notes || '');

    // Full refresh — but PRESERVE rows the DM has already decided on
    // (accepted OR rejected). An accepted amendment must survive; a
    // rejected one must keep its detail so the AI won't re-flag the same
    // change. Only un-decided ('none'/'pending') rows are rebuilt.
    await db.prepare(
      "DELETE FROM session_characters WHERE session_id = ? AND (change_status IS NULL OR change_status NOT IN ('accepted','rejected'))"
    ).run(session.id);

    // Which characters already have a decided row this session — skip them.
    const acceptedRows = await db.prepare(
      "SELECT character_id FROM session_characters WHERE session_id = ? AND change_status IN ('accepted','rejected')"
    ).all(session.id);
    const acceptedIds = {};
    acceptedRows.forEach(function(r) { acceptedIds[r.character_id] = true; });

    for (const ch of characters) {
      if (!characterInText(ch, text)) continue;
      if (acceptedIds[ch.id]) continue; // decided — leave its row untouched
      const carry = await resolveCarryForward(db, ch, session);
      await db.prepare(
        'INSERT INTO session_characters ' +
        '(session_id, character_id, prompt, reference_url, change_note, change_flag, change_status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(session.id, ch.id, carry.prompt, carry.referenceUrl, null, 0, 'none', now);
    }
  } catch(e) {
    console.error('snapshotSessionCharacters error:', e.message);
  }
}

// Dedicated AI call: scan the transcript for MAJOR PERMANENT physical
// changes to known characters. Flags the session_characters row.
// Conservative — temporary states (Long Rest, bloodied, etc) are ignored.
async function detectCharacterChanges(db, session, campaignId, apiKey, now) {
  try {
    if (!apiKey) return;
    const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaignId);
    if (!characters.length) return;

    // Scan transcript + session notes together.
    const transcript = session.transcript || '';
    const notes = session.session_notes || '';
    const text = transcript + '\n' + notes;
    // Only characters actually present in this session.
    let present = characters.filter(function(ch) { return characterInText(ch, text); });

    // Characters whose change this session is already ACCEPTED — skip
    // entirely (settled). Characters whose change is REJECTED stay in the
    // scan, but we pass the rejected detail to the AI so it won't re-flag
    // the SAME change (a genuinely different change still flags).
    const decidedRows = await db.prepare(
      "SELECT character_id, change_status, change_detail FROM session_characters " +
      "WHERE session_id = ? AND change_status IN ('accepted','rejected')"
    ).all(session.id);
    const acceptedIds = {};
    const rejectedDetail = {};
    decidedRows.forEach(function(r) {
      if (r.change_status === 'accepted') acceptedIds[r.character_id] = true;
      else if (r.change_status === 'rejected') rejectedDetail[r.character_id] = r.change_detail || '';
    });
    present = present.filter(function(ch) { return !acceptedIds[ch.id]; });

    if (!present.length) return;

    // Stage 4: fetch this session's moments in order, so the AI can say
    // WHICH moment a change happens at. moments[].panel_order is 0-based.
    const moments = await db.prepare(
      'SELECT title, description, panel_order FROM moments WHERE session_id = ? ORDER BY panel_order ASC'
    ).all(session.id);
    const momentListText = moments.length
      ? moments.map(function(m) {
          return 'Moment ' + m.panel_order + ': ' + (m.title || '') +
            (m.description ? ' — ' + m.description : '');
        }).join('\n')
      : '(no moments)';

    const charListText = present.map(function(ch) {
      return '- ' + ch.name + (ch.cls ? ' (' + ch.cls + ')' : '');
    }).join('\n');

    // Stage 3/4: any changes the DM previously REJECTED for this session.
    // The AI must NOT re-flag these same changes — but a genuinely
    // different new change for the same character SHOULD still be flagged.
    var rejectedText = '';
    present.forEach(function(ch) {
      if (rejectedDetail[ch.id]) {
        rejectedText += '- ' + ch.name + ': "' + rejectedDetail[ch.id] + '"\n';
      }
    });

    const instruction =
      'You are reviewing a tabletop RPG session for PERMANENT physical changes to characters. ' +
      'You are given the session transcript AND the DM\'s session notes — check BOTH.\n\n' +
      'CHARACTERS IN THIS SESSION:\n' + charListText + '\n\n' +
      'Flag ONLY *significant permanent physical changes* — anything that changes how a ' +
      'character LOOKS from now on. This includes, but is not limited to:\n' +
      '- Injuries and losses: a lasting scar, a lost limb or eye, a cut or broken horn.\n' +
      '- Colour changes: skin, hair, or eyes permanently changing colour.\n' +
      '- Curses and magical effects that alter appearance (e.g. skin turns deathly white, ' +
      'petrified patches, glowing eyes).\n' +
      '- Transformations: partial or full (e.g. turning undead, growing scales).\n' +
      '- New permanent signature features or gear that becomes part of their look.\n' +
      'ALSO flag *restorations* — a previously lost feature being healed or restored ' +
      '(e.g. a lost eye regrown) — these are permanent changes too.\n\n' +
      'DO NOT flag temporary states. Ignore anything a night\'s rest or a D&D Long Rest ' +
      'would undo: bloodied, wounded-but-healing, bruised, muddy, exhausted, poisoned, ' +
      'frightened, disguised, or any short-term condition. The change must be clearly ' +
      'PERMANENT — usually the text will say so, or the nature of it makes it obvious.\n' +
      'If genuinely unsure whether something is permanent, DO NOT flag it.\n\n' +
      'Return ONLY a JSON object, no preamble:\n' +
      '{\n  "changes": [\n    { "character": "exact name from the list", ' +
      '"detail": "...", "moment_index": <number> }\n  ]\n}\n\n' +
      'CRITICAL — the "detail" field must describe ONLY the resulting VISIBLE ' +
      'APPEARANCE, as if writing a costume/makeup note. It is fed directly to an ' +
      'image generator.\n' +
      '- DO include: what the character now looks like (e.g. "skin and hair are ' +
      'deathly pale albino-white", "left horn is broken off to a jagged stump").\n' +
      '- DO NOT include the CAUSE or any lore: no monster names, no spell or ability ' +
      'names, no "from...", no "because...", no story context. An image model will ' +
      'wrongly draw those words as objects.\n' +
      '- Example of WRONG: "skin turned white from a Pale Stalker necrotic shriek".\n' +
      '- Example of RIGHT: "skin and hair are deathly albino-white".\n' +
      'Keep it short — one descriptive phrase.\n\n' +
      'The "moment_index" field is the number of the moment (from the MOMENTS ' +
      'list below) where the change BECOMES VISIBLE on the character.\n' +
      '- Pick the moment in which the change actually HAPPENS TO the character — ' +
      'the moment the scar is cut, the spell lands, the horn breaks, the ' +
      'transformation occurs. The character should look NORMAL in every moment ' +
      'before it, and CHANGED in that moment and every moment after.\n' +
      '- Do NOT pick the moment a fight or scene merely BEGINS. A battle can ' +
      'start several moments before the blow that actually causes the change. ' +
      'Pin it to the exact moment of the change itself, not its lead-up.\n' +
      '- If a moment\'s description shows the change already in effect but an ' +
      'earlier moment shows it actually occurring, use the moment it occurs.\n' +
      '- Only if the change is already true from the very start, or you truly ' +
      'cannot place it, use 0.\n\n' +
      (rejectedText
        ? 'PREVIOUSLY REJECTED CHANGES — the DM has already reviewed and REJECTED ' +
          'these specific changes. Do NOT flag them again:\n' + rejectedText +
          'However, if a character above has a genuinely DIFFERENT permanent change ' +
          '(not the rejected one), you SHOULD still flag that new change.\n\n'
        : '') +
      'MOMENTS IN THIS SESSION (in order):\n' + momentListText + '\n\n' +
      'If there are no permanent changes, return { "changes": [] }.\n\n' +
      'SESSION TRANSCRIPT:\n' + transcript + '\n\n' +
      'DM SESSION NOTES:\n' + (notes || '(none)');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: instruction }]
      })
    });

    const data = await response.json();
    if (data.error) { console.error('detectCharacterChanges API error:', data.error.message); return; }

    var raw = data.content.map(function(b) { return b.text || ''; }).join('').trim();
    raw = raw.replace(/```json|```/g, '').trim();
    var parsed = JSON.parse(raw);
    if (!parsed.changes || !parsed.changes.length) return;

    for (const change of parsed.changes) {
      const match = characters.find(function(ch) {
        return ch.name && ch.name.toLowerCase() === String(change.character || '').toLowerCase();
      });
      if (!match || !change.detail) continue;
      // Stage 4: clamp the moment index to a sane value (default 0).
      var mi = parseInt(change.moment_index, 10);
      if (isNaN(mi) || mi < 0) mi = 0;
      // Flag this character's snapshot row for the DM to review.
      await db.prepare(
        'UPDATE session_characters SET change_flag = ?, change_detail = ?, ' +
        'change_moment_index = ?, change_status = ?, edited_at = ? ' +
        'WHERE session_id = ? AND character_id = ?'
      ).run(1, change.detail, mi, 'pending', now, session.id, match.id);
    }
  } catch(e) {
    console.error('detectCharacterChanges error (non-fatal):', e.message);
  }
}

module.exports = router;
