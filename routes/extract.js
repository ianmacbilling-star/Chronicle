const express = require('express');
const router = express.Router();
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getTier, getMomentRange, getEffectiveTier } = require('../middleware/tiers');
const { getDb, getOrCreateDmFork, getDmForkId } = require('../database/db');
const { releaseImage } = require('../storage/storage');

router.post('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { artStyle } = req.body;
  const key = process.env.ANTHROPIC_API_KEY || req.body.key;

  if (!key) return res.json({ error: 'AI service is not configured. Please contact support.' });

  const db = await getDb();

  // Verify membership (any member can load; the fork resolution below
  // decides what they may write to).
  const session = await db.prepare(
    'SELECT s.*, c.art_style as campaign_style FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found for this session' });

  // Phase 4 — the DM re-extracts the CANONICAL version; a player re-extracts
  // THEIR OWN version. The transcript is always the DM's (read-only to the
  // player); the notes that steer extraction are the caller's own (the DM's
  // session notes, or the player's per-version fork notes).
  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  let targetForkId;
  if (callerRole === 'dm') {
    targetForkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  } else {
    const myFork = await db.prepare('SELECT id, fork_notes FROM session_forks WHERE session_id = ? AND user_id = ?').get(session.id, req.session.userId);
    if (!myFork) return res.status(403).json({ error: 'You have no version of this session' });
    targetForkId = myFork.id;
    session.session_notes = myFork.fork_notes || '';
  }

  // Image locking — Generate Story re-extracts by DELETEing and rebuilding
  // every moment on this version, which would destroy locked panels. Refuse
  // up front (before the AI call) if this version has any locked moment.
  const lockedHere = await db.prepare('SELECT COUNT(*) AS n FROM moments WHERE fork_id = ? AND locked = 1').get(targetForkId);
  if (lockedHere && lockedHere.n > 0) {
    return res.json({ error: 'LOCKED_MOMENTS', message: 'Locked moments exist, so you can’t regenerate the story. Unlock them first to rebuild this version.' });
  }

  // An accepted character change pinned to a specific panel (change_moment_index)
  // anchors to a moment that re-extraction would rebuild from scratch — the
  // change would land on the wrong beat. Refuse up front, same as locked images.
  const pinnedChange = await db.prepare(
    "SELECT COUNT(*) AS n FROM session_characters WHERE fork_id = ? AND change_status = 'accepted' AND change_moment_index IS NOT NULL AND change_moment_index >= 0"
  ).get(targetForkId);
  if (pinnedChange && pinnedChange.n > 0) {
    return res.json({ error: 'PINNED_CHANGE', message: 'An approved character change is pinned to a specific Moment Panel, so regenerating the story would put it on the wrong panel. To rebuild this version, open the Characters tab and set that change\u2019s Moment Panel dropdown to Empty first.' });
  }

  // Get characters for this campaign
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(req.params.campaignId);
  const charList = characters.map(function(c) {
    var playerInfo = c.player_name ? ' (played by ' + c.player_name + ')' : '';
    return c.name + playerInfo + ' (' + c.cls + '): ' + c.description;
  }).join('\n');

  const style = artStyle || session.campaign_style || 'High fantasy illustration';

  // Scale moment count to transcript length based on user tier
  const wordCount = session.transcript.split(/\s+/).length;
  // Campaign features resolve to the EFFECTIVE tier (the higher of the player's
  // own tier and the campaign SM's), so a Copper player under a Platinum SM gets
  // Platinum's moment counts — and a Gold player under a Silver SM keeps Gold.
  const effectiveTier = await getEffectiveTier(req.session.userId, req.params.campaignId);
  const momentCount = getMomentRange(effectiveTier, wordCount);

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
    'When a DM specifies a visual style or atmosphere, you apply it consistently to every panel. ' +
    'COPYRIGHT & ORIGINALITY \u2014 CRITICAL: Treat this campaign as the user\'s own original fictional world. Keep the names the user gives their characters, creatures, places, and items EXACTLY as written \u2014 a name is the user\'s choice, so use it as-is even when it happens to match something from another franchise. What you must NOT do is borrow that franchise\'s identity: if a name matches a character or property from a third-party copyrighted or trademarked work (for example a video game, film, comic, anime, novel, or another game publisher), treat it as the user\'s OWN original creation that merely shares the name, and never reproduce that franchise\'s visual design, likeness, costume, logo, signature equipment, setting, backstory, or lore. Image prompts must describe ONLY the user\'s own characters and scene as referenced, never a recognizable franchise character\'s design. Do NOT copy verbatim or near-verbatim text from any published source (such as a published adventure module, rulebook, or novel) into any title, description, or image prompt \u2014 always describe events in your own original words.';

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
    '      "shape": "The frame shape for this panel - choose EXACTLY one of: square, standard, wide, panoramic, tall, tower, or fullpage. Pick the shape that best fits the scene composition, so the printed graphic novel can vary panel sizes for a dynamic, cinematic page. From widest to tallest: panoramic is an ultra-wide cinematic banner - use it only for grand sweeping vistas, a long horizon, or a landscape or army stretching across the view; wide is a broad establishing or action shot; standard is the default balanced frame and should be the most common choice; square is an intimate close-up on a single face or object, or a tight two-shot; tall is a vertical, full-height framing; tower is an extremely tall and narrow shot - use it only for towering subjects, a great height or fall, a dramatic full-body reveal, or a narrow vertical space; fullpage is an upright, full-page proportioned frame (shaped like a whole printed page) for a striking image worth showing large at page size. Reserve the dramatic extremes panoramic, tower, and fullpage for moments whose composition genuinely earns them, and do not overuse any single shape.",\n' +
    '      \"prominence\": \"How much visual weight this beat deserves on the page, an integer 1 to 5 (1 = a minor or background beat, 3 = a normal beat, 5 = a major hero or splash moment). Most panels are 2 to 4; reserve 5 for genuinely pivotal beats and do not overuse it.\",\\n' +
    '      \"focal\": \"Where the main subject sits in the frame: exactly one of center, top, bottom, left, or right. Use center when the subject is centered or you are unsure.\",\\n' +
    '      \"crop_safe\": \"Boolean true or false. true if this image can be cropped to fill a panel without losing the important subject; false if the whole frame matters and the image should be shown complete.\",\\n' +
    '      \"group_break\": \"Boolean true or false. true if this moment begins a new scene or visual group (a shift of location, time, or topic from the previous moment); false if it continues the current scene.\",\\n' +
    '      "emphasis": "ONLY for combat moments: a punchy 1-3 word comic-style emphasis phrase that fits THIS specific moment (e.g. \\"Steel meets steel!\\", \\"The wards shatter!\\", \\"No escape!\\"). It must make sense for what actually happens in the moment — not a generic sound effect. For non-combat moments, use an empty string.",\n' +
    '      "prompt": "Detailed image generation prompt describing the SCENE ONLY. Describe composition, lighting, character positions, mood, and any specific visual details from the director\'s instructions. 2-3 sentences. Do NOT mention or name an art style, medium, or rendering technique - the art style is applied separately at image-generation time, so the prompt must stay style-neutral. CRITICAL FOR CHARACTER CONSISTENCY: every time a KNOWN named character appears, refer to them BY THEIR EXACT NAME (e.g. \\"Ruk\\", \\"Zara\\") - never anonymously like \\"a half-orc\\" or \\"the warrior\\". The name tells the system this is a specific recurring character. WHO IS ACTUALLY IN THE PANEL — CRITICAL: each panel is a SINGLE CINEMATIC SHOT, not an inventory of who is in the room. Name ONLY the characters whose faces or bodies would be IN THE VISUAL FRAME of this specific panel — the ones doing the action, reacting, or close enough to be visually prominent. Varied panel composition is what makes a graphic novel feel like a graphic novel — a close-up on one character\'s hands working magic, a two-shot of a heated argument, a wide group shot of the whole party entering a hall — each panel earns its character count from the dramatic moment, not from who happens to be present in the room. If a moment is intimate or focused, name 1 or 2 characters. If it is a group moment, name the group. AVOID the failure mode of \\"name everyone every time to be safe\\" — that produces bland, identical-cast panels and over-inclusion is just as wrong as under-inclusion. GROUP REFERENCES — CRITICAL: when the transcript uses a group term (\\"the party\\", \\"the group\\", \\"the adventurers\\", \\"the heroes\\", \\"the team\\", \\"the companions\\", \\"the fellowship\\", \\"everyone\\") or plural pronouns (\\"they\\", \\"them\\") that refer to multiple characters, NEVER pass the group term through to the prompt — group terms produce generic faces in the rendered image. Resolve the group term into the EXPLICIT NAMES of the characters who are visually in this panel\'s frame. For example, do not write \\"the party fights the dragon\\" — write \\"Ruk, Zara, and Thorin fight the dragon\\" if those three are the ones engaging. If only one or two characters from the group are the visual focus of this panel, name only those. Resolving a group term does NOT mean including every party member — it means replacing the vague term with the specific names of who is actually IN this shot. CHARACTER DESCRIPTIONS - KEEP THEM LEAN: a reference image supplies each known character\'s permanent appearance (face, build, features), so do NOT re-describe their fixed physical traits at length. For a known character, focus their text on what they are DOING in this panel (pose, action, expression) and any TEMPORARY visible state from the transcript (bloodied, muddy, exhausted, frightened, soaked). A brief identifying tag is fine the first time (\\"Ruk, the half-orc barbarian\\") but keep it short - the image carries the look. Only describe full physical appearance for UNNAMED background figures who are not known characters."\n' +
    '    }\n' +
    '  ],\n' +
    '  "narrative_outline": {\n' +
    '    "intro": "One short sentence describing what the OPENING narration (before panel 1) will cover. A PLAN of the prose, not the prose itself.",\n' +
    '    "moments": ["One short sentence per PANEL describing the events that panel\'s image depicts and how they come about - the narration that leads INTO the picture. Return EXACTLY (number of panels) entries, in order."],\n' +
    '    "gaps": ["One short sentence per BETWEEN-panel gap describing the connective narration that bridges one panel\'s moment to the next. Return EXACTLY (number of panels minus 1) entries, in order."],\n' +
    '    "outro": "One short sentence describing what the CLOSING narration (after the final panel) will cover."\n' +
    '  }\n' +
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
      // Phase 4 — regenerate replaces only the CALLER's version's moments.
      const dmForkId = targetForkId;
      // Release the about-to-be-orphaned images of this version's old moments
      // (reference-counted: copies shared with other forks are spared).
      const oldImgs = await db.prepare('SELECT image FROM moments WHERE fork_id = ?').all(dmForkId);
      await db.prepare('DELETE FROM moments WHERE fork_id = ?').run(dmForkId);
      for (let oi = 0; oi < oldImgs.length; oi++) { await releaseImage(db, oldImgs[oi].image); }
      const now = new Date().toISOString();

      // Save the art style used so future sessions can inherit it (canonical
      // session field is DM-owned; a player's style choice stays on their fork).
      if (callerRole === 'dm') {
        await db.prepare('UPDATE sessions SET art_style = ?, edited_at = ?, edited_by = ? WHERE id = ?')
          .run(style, now, req.session.userId, session.id);
      }

      const insert = await db.prepare(
        'INSERT INTO moments (session_id, fork_id, title, description, type, prompt, emphasis, shape, layout_meta, panel_order, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      parsed.moments.forEach(function(m, i) {
        insert.run(session.id, dmForkId, m.title, m.description, m.type, m.prompt, m.emphasis || null, (['wide','tall','square','panoramic','tower','fullpage'].indexOf(m.shape) >= 0 ? m.shape : 'standard'), JSON.stringify({ prominence: (Number(m.prominence) >= 1 && Number(m.prominence) <= 5) ? Math.round(Number(m.prominence)) : 3, focal: (['center','top','bottom','left','right'].indexOf(m.focal) >= 0) ? m.focal : 'center', crop_safe: m.crop_safe === false ? false : true, group_break: m.group_break === true }), i, now, req.session.userId);
      });

      // Pass 1 — store the per-gap narrative OUTLINE produced in this same
      // extraction call (free), and clear any stale narrative prose from a
      // prior extraction of this version (the panels just changed, so the old
      // prose no longer matches). Per-gap DIRECTIONS are deliberately preserved
      // (narrative_directions untouched) — they are the user's steering intent
      // and should survive a re-extract.
      var outlineObj = parsed.narrative_outline || {};
      var outlineGaps = Array.isArray(outlineObj.gaps) ? outlineObj.gaps : [];
      var outlineMoments = Array.isArray(outlineObj.moments) ? outlineObj.moments : [];
      var outlineSections = [];
      for (var gi = 0; gi < parsed.moments.length; gi++) {
        outlineSections.push({ panel_index: gi, before: outlineMoments[gi] || '', outline: (gi < parsed.moments.length - 1) ? (outlineGaps[gi] || '') : '' });
      }
      var outlineToStore = JSON.stringify({
        intro: outlineObj.intro || '',
        sections: outlineSections,
        outro: outlineObj.outro || ''
      });
      await db.prepare(
        'UPDATE session_forks SET narrative_outline = ?, ' +
        'narrative_intro = NULL, narrative_sections = NULL, narrative_outro = NULL, ' +
        'narrative_intro_summary = NULL, narrative_outro_summary = NULL, ' +
        'edited_at = ?, edited_by = ? WHERE id = ?'
      ).run(outlineToStore, now, req.session.userId, dmForkId);

      // Snapshot each character present in this session (self-contained).
      await snapshotSessionCharacters(db, session, req.params.campaignId, req.session.userId, now, dmForkId);

      // Stage 3: scan for major permanent changes and flag them for review.
      await detectCharacterChanges(db, session, req.params.campaignId, key, now, targetForkId);
    }

    // Tell the frontend whether any character changes need review, so it
    // can route to the Characters tab instead of the Storyboard tab.
    let pendingChanges = 0;
    try {
      const pcForkId = targetForkId;
      const pc = await db.prepare(
        "SELECT COUNT(*) AS c FROM session_characters WHERE fork_id = ? AND change_status = 'pending'"
      ).get(pcForkId);
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
async function snapshotSessionCharacters(db, session, campaignId, userId, now, forkId) {
  // Deploy 4.0 — resolve the DM fork if not passed in (single call site
  // passes it, but stay robust).
  if (!forkId) forkId = await getOrCreateDmFork(db, session.id, userId);
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
      "DELETE FROM session_characters WHERE fork_id = ? AND (change_status IS NULL OR change_status NOT IN ('accepted','rejected'))"
    ).run(forkId);

    // Which characters already have a decided row this session — skip them.
    const acceptedRows = await db.prepare(
      "SELECT character_id FROM session_characters WHERE fork_id = ? AND change_status IN ('accepted','rejected')"
    ).all(forkId);
    const acceptedIds = {};
    acceptedRows.forEach(function(r) { acceptedIds[r.character_id] = true; });

    for (const ch of characters) {
      if (!characterInText(ch, text)) continue;
      if (acceptedIds[ch.id]) continue; // decided — leave its row untouched
      const carry = await resolveCarryForward(db, ch, session);
      await db.prepare(
        'INSERT INTO session_characters ' +
        '(session_id, fork_id, character_id, prompt, reference_url, change_note, change_flag, change_status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(session.id, forkId, ch.id, carry.prompt, carry.referenceUrl, null, 0, 'none', now);
    }
  } catch(e) {
    console.error('snapshotSessionCharacters error:', e.message);
  }
}

// Dedicated AI call: scan the transcript for MAJOR PERMANENT physical
// changes to known characters. Flags the session_characters row.
// Conservative — temporary states (Long Rest, bloodied, etc) are ignored.
async function detectCharacterChanges(db, session, campaignId, apiKey, now, forkId) {
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
    const ddForkId = forkId || await getDmForkId(db, session.id);
    const decidedRows = await db.prepare(
      "SELECT character_id, change_status, change_detail FROM session_characters " +
      "WHERE fork_id = ? AND change_status IN ('accepted','rejected')"
    ).all(ddForkId);
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
      'SELECT title, description, panel_order FROM moments WHERE fork_id = ? ORDER BY panel_order ASC'
    ).all(ddForkId);
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
