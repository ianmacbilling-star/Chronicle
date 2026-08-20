const express = require('express');
// v3.0.586 -- TD-345(d). The height marker is DEFINED in images.js and read from there, so the
// writer and the reader cannot drift apart. See the note above buildCharacterBlock.
const charHeight = require('./images');
const genresvc = require('../services/genres');   // v3.0.488 -- stage 4 steering
const router = express.Router();
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getTier, getMomentRange, getEffectiveTier } = require('../middleware/tiers');
const { getDb, getOrCreateDmFork, getDmForkId, resolveActingFork, requestedForkIdOf } = require('../database/db');
const { releaseImage } = require('../storage/storage');
const { computeGenCharge, getBalance, spendTokens, recordGeneration } = require('./tokens');
const { TEXT_MODEL } = require('../config/models');

// v3.0.507 -- TITLE LENGTH IS A FUNCTION OF THE PICTURE'S WIDTH.
// Ian, 2026-08-07: "keep the titles short based on the size of the image. So Tower Titles need to
// be short, the others don't necessarily." The caption is printed the width of the picture, so a
// tower gets roughly a third of the room a full-width panel does. Measured against a 2.57in tower
// at 9pt Cinzel, with the panel number now gone (v3.0.498): about 33 characters fit on one line,
// against ~92 across a 6.8in full-width panel.
// The prompt above states the rule; this ENFORCES it, because a prompt instruction is a request.
// Nothing enforced title length at all before this -- not client, not server -- and the observed
// spread on The Strangers was median 23, mean 25, MAX 43 characters.
// Trims on a WORD boundary and never adds an ellipsis: a stored title is content the user can now
// edit on the Storyboard, so it should read as a title rather than as truncated output. The cap is
// deliberately looser than the measured fit so it only ever catches a runaway.
function capTitleForShape(title, shape) {
  var t = String(title == null ? '' : title).trim().replace(/\s+/g, ' ');
  if (!t) return t;
  var narrow = (shape === 'tower' || shape === 'tall');
  var maxChars = narrow ? 36 : 64;
  if (t.length <= maxChars) return t;
  var cut = t.slice(0, maxChars);
  var sp = cut.lastIndexOf(' ');
  if (sp > Math.floor(maxChars * 0.5)) cut = cut.slice(0, sp);   // whole words, unless the first word is itself huge
  return cut.replace(/[\s,;:.\-]+$/, '');
}

router.post('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const { artStyle } = req.body;
  const key = process.env.ANTHROPIC_API_KEY || req.body.key;

  if (!key) return res.json({ error: 'AI service is not configured. Please contact support.' });

  const db = await getDb();

  // Verify membership (any member can load; the fork resolution below
  // decides what they may write to).
  const session = await db.prepare(
    'SELECT s.*, c.art_style as campaign_style, c.lore as campaign_lore, c.genres as campaign_genres, c.campaign_prompt as campaign_prompt FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found for this session' });

  // Phase 4 — the DM re-extracts the CANONICAL version; a player re-extracts
  // THEIR OWN version. The transcript is always the DM's (read-only to the
  // player); the notes that steer extraction are the caller's own (the DM's
  // session notes, or the player's per-version fork notes).
  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  // v3.0.445 -- EXTRACT INTO THE VERSION ON SCREEN (TD-194). Resolve the version first, then let it
  // decide -- the canonical keeps the session's own notes, any other version uses its fork notes.
  // Was: canonical if you are the Story Master, otherwise your FIRST version.
  let targetForkId = await resolveActingFork(db, session.id, req.session.userId, callerRole, requestedForkIdOf(req));
  if (!targetForkId && requestedForkIdOf(req)) {
    return res.status(403).json({ error: 'That version is not yours to extract into.' });
  }
  if (!targetForkId && callerRole === 'dm') {
    targetForkId = await getOrCreateDmFork(db, session.id, req.session.userId);
  }
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });
  const actRow = await db.prepare('SELECT id, role, fork_notes FROM session_forks WHERE id = ?').get(targetForkId);
  if (actRow && actRow.role !== 'dm') {
    session.session_notes = actRow.fork_notes || '';
  }

  // Image locking — Generate Story re-extracts by DELETEing and rebuilding
  // every moment on this version, which would destroy locked panels. Refuse
  // up front (before the AI call) if this version has any locked moment.
  const lockedHere = await db.prepare('SELECT COUNT(*) AS n FROM moments WHERE fork_id = ? AND locked = 1').get(targetForkId);
  if (lockedHere && lockedHere.n > 0) {
    return res.json({ error: 'LOCKED_MOMENTS', message: 'Locked moments exist, so you can’t regenerate the story. Unlock them first to rebuild this version.' });
  }

  // The session title (establishing) image is locked. Like a locked panel, a
  // locked title image stops a story regeneration (re-extraction would rewrite
  // its scene). Only the DM owns the canonical title image, so gate on the DM.
  if (callerRole === 'dm' && session.establishing_locked) {
    return res.json({ error: 'ESTABLISHING_LOCKED', message: 'The session title image is locked, so the story cannot be regenerated. Unlock the title image first to rebuild this version.' });
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

  // Optional size-based charge for Generate Story (admin-configured; scales with
  // transcript words). Verified here; spent only after a successful extraction.
  // Charge meters on total USER-authored words (transcript + notes + lore),
  // never our behind-the-scenes prompt scaffolding.
  var _wc = function (t) { var v = (t == null ? '' : String(t)).trim(); return v ? v.split(/\s+/).length : 0; };
  var _userWords = _wc(session.transcript) + _wc(session.session_notes) + _wc(session.campaign_lore);
  var _storyCharge = 0;
  try { _storyCharge = await computeGenCharge(_userWords, 'gen_story_words_per_token', 'gen_story_floor'); } catch (e) { _storyCharge = 0; }
  if (_storyCharge > 0) {
    const _bal = await getBalance(req.session.userId);
    if (_bal.total < _storyCharge) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'Generating this story costs ' + _storyCharge + ' token' + (_storyCharge === 1 ? '' : 's') + ', but you have ' + _bal.total + '. Add tokens and try again.' });
    }
  }

  // Parse session notes into mandatory and optional directives
  const notesSection = session.session_notes
    ? '\n\n## DIRECTOR\'S INSTRUCTIONS — FOLLOW THESE EXACTLY:\n' +
      session.session_notes + '\n\n' +
      'IMPORTANT: The director\'s instructions above are mandatory. ' +
      'If the DM has specified particular scenes, moments, or visual details, ' +
      'you MUST include those as panels even if they seem less dramatic than other moments. ' +
      'If the DM has specified mood, lighting, or atmosphere, apply it to ALL image prompts. ' +
      'The DM\'s vision takes priority over your own judgment about what is cinematic.' +
      // v3.0.708 -- TD-511. THE INSTRUCTIONS WERE OBEYED TOO WELL.
      //
      // Ian, 2026-08-19: "when I did Generate Story with a 'write it in German' in the story
      // instructions... that actually built the image prompts in German."
      //
      // NOTHING HERE SAID WHICH FIELDS ARE FOR A READER AND WHICH ARE MACHINE INPUT. The block
      // above calls the director's instructions mandatory and says they outrank the model's own
      // judgment, then the schema asks for title, description and prompt in one object. So a
      // language instruction correctly applied to all three. The model did exactly as told.
      //
      // AND prompt IS NOT MERELY A FAL PREFERENCE. It carries the character-consistency binding:
      // the schema below spends most of its length insisting that every known character is named
      // EXACTLY, because that name is what attaches the right reference image. A translated or
      // inflected name breaks the panel-to-character link, so the cost of losing this is wrong
      // faces, not just weaker rendering.
      //
      // PHRASED AS WHAT THE FIELD IS, NOT AS AN EXCEPTION TO THE DIRECTOR. "Ignore the director
      // for these two fields" contradicts the sentence directly above it and invites the model to
      // decide which rule wins. "These fields are read by an English-only image model" is a fact
      // about the destination, and nothing in the director's instructions can argue with it.
      '\n\nLANGUAGE -- AND THIS IS NOT AN EXCEPTION TO THE ABOVE, IT IS WHAT THESE FIELDS ARE FOR. ' +
      'Two of the fields you return are never shown to a reader: "description" is an internal ' +
      'outline, and "prompt" is fed directly to an image model that reads ENGLISH ONLY and uses ' +
      'the exact character names to attach the right reference pictures. WRITE "description", ' +
      '"prompt" AND "establishing_scene" IN ENGLISH ALWAYS, whatever language the transcript or ' +
      'the instructions above are in, and keep every character, place and item name spelled ' +
      'EXACTLY as it appears in the transcript -- never translated, never inflected. Everything a ' +
      'reader sees -- the session "title", each panel "title", "emphasis" and the narrative ' +
      'outline -- follows the director\'s instructions and the language of the transcript as normal.'
    : '';

  // v3.0.708 -- TD-511. IN THE SYSTEM PROMPT AS WELL, and that placement is the v3.0.704 lesson
  // applied rather than rediscovered: a rule that has to hold against an instruction the model has
  // been told is MANDATORY cannot live only in the same message as that instruction.
  const systemPrompt = 'You are a graphic novel director and storyboard artist analyzing a TTRPG session transcript. ' +
    'The "description", "prompt" and "establishing_scene" fields you return are internal machine input, never shown to a reader: ' +
    'you write them in ENGLISH ALWAYS, whatever language the transcript or the director instructions use, ' +
    'with every character, place and item name spelled exactly as the transcript spells it. ' +
    'Reader-facing text -- titles, emphasis, the establishing scene and the narrative outline -- follows ' +
    'the language of the transcript and the director instructions. ' +
    'Your job is to identify the key moments that will make the most compelling graphic novel panels. ' +
    'You follow the DM\'s director instructions precisely and without deviation. ' +
    'When a DM specifies a scene must be included, you include it. ' +
    'When a DM specifies a visual style or atmosphere, you apply it consistently to every panel. ' +
    'COPYRIGHT & ORIGINALITY \u2014 CRITICAL: Treat this campaign as the user\'s own original fictional world. Keep the names the user gives their characters, creatures, places, and items EXACTLY as written \u2014 a name is the user\'s choice, so use it as-is even when it happens to match something from another franchise. What you must NOT do is borrow that franchise\'s identity: if a name matches a character or property from a third-party copyrighted or trademarked work (for example a video game, film, comic, anime, novel, or another game publisher), treat it as the user\'s OWN original creation that merely shares the name, and never reproduce that franchise\'s visual design, likeness, costume, logo, signature equipment, setting, backstory, or lore. Also, any name YOU invent for a new character, creature, place, or item must be your own original creation \u2014 never a name, character, ally, sidekick, rival, location, or term drawn from a real franchise; when a user-provided name happens to match a franchise character, do NOT add that franchise\'s known companions, sidekicks, enemies, places, or terms. Build only on what the transcript actually contains. Image prompts must describe ONLY the user\'s own characters and scene as referenced, never a recognizable franchise character\'s design. Do NOT copy verbatim or near-verbatim text from any published source (such as a published adventure module, rulebook, or novel) into any title, description, or image prompt \u2014 always describe events in your own original words.';

  // Resolved through services/genres.js and nowhere else.
  const _genrePanels = genresvc.genreSteering(session && session.campaign_genres, 'panels');
  const _campPrompt = genresvc.campaignPrompt(session && session.campaign_prompt);
  const userPrompt =
    '## ART STYLE\n' + style + '\n\n' +
    '## KNOWN CHARACTERS (appearance reference only)\n' + charList + '\n' +
    'IMPORTANT: the list above is an appearance reference, NOT a cast list for ' +
    'this session. Only include a character in a panel if they ACTUALLY APPEAR ' +
    'in the transcript below. Do NOT add a character to a scene just because ' +
    'they are on this list — many of them are not in this session. If a ' +
    'character is not present in the transcript, they must not appear in any panel.\n' +
    notesSection + '\n\n' +
    ((session.campaign_lore && session.campaign_lore.trim()) ? ('## WORLD / LORE (background for consistency and continuity \u2014 NOT events of this session; the transcript below is the sole source of what actually happened)\n' + session.campaign_lore.trim() + '\n\n') : '') +
    '## SESSION TRANSCRIPT\n' + session.transcript + '\n\n' +
    '## YOUR TASK\n' +
    'This transcript is approximately ' + wordCount + ' words long. ' +
    'Extract the moments that genuinely deserve their own graphic novel panel, up to a MAXIMUM of ' + momentCount + ' panels. ' +
    'That maximum is a CEILING, not a target: do NOT pad to reach it. Use only as many panels as the story actually earns -- ' +
    'a shorter set of strong, distinct panels is better than a long set with filler or near-duplicate beats. ' +
    'If the session is short on real events, return correspondingly fewer panels. ' +
    'Focus on dramatic combat, emotional revelations, tense standoffs, and memorable character moments. ' +
    'If the director\'s instructions specify particular scenes, those MUST be included as panels.\n\n' +
    // v3.0.488 -- STAGE 4. These sit at the END of the task, after the transcript,
    // because the transcript is often thousands of words and anything that must be
    // live while CHOOSING panels has to come after it. The top of this prompt is
    // reference material (art style, cast, lore); this is an instruction.
    // Spec: GENRE_AND_CAMPAIGN_PROMPT_SPEC.md section 5.2.
    (_genrePanels ? ('## ' + _genrePanels + '\n\n') : '') +
    (_campPrompt ? ('## GENERAL CAMPAIGN PROMPT (applies to every session in this campaign; follow it unless it conflicts with the COPYRIGHT rule, which always wins)\n' + _campPrompt + '\n\n') : '') +
    'Return ONLY valid JSON with no markdown fences or explanation:\n' +
    '{\n' +
    '  "title": "Session title (4-6 dramatic words)",\n' +
    '  "establishing_scene": "IN ENGLISH ALWAYS, whatever language the transcript is in -- this string is glued to English scaffolding and sent straight to an image model as the session title picture prompt; it is never shown to a reader. A vivid 2-3 sentence WIDE ESTABLISHING SHOT that opens the session - the setting, location, environment, time of day, weather, and overall mood as the story begins. A scene-setting TITLE CARD: keep it a wide, scene-setting view, not a close-up portrait. If characters are genuinely present in this opening view you MAY include them, but refer to each KNOWN character BY THEIR EXACT NAME (e.g. \\"Ruk\\", \\"Zara\\") and NEVER by a group term (\\"the party\\") or an anonymous label (\\"a warrior\\") - the exact name lets the system attach the matching reference image so they look like themselves. Name only the characters actually in this opening frame, and show them within the wider scene rather than as a posed portrait. If the opening is an empty landscape or location with no one present, describe it with no people. Style-neutral (do NOT name an art style or medium).",\n' +
    '  "moments": [\n' +
    '    {\n' +
    '      "title": "Short evocative panel title. HARD LIMITS, and they depend on the shape you chose for this panel: a TOWER or TALL panel is narrow, so its title must be at most 4 words and 30 characters; every other shape may use up to 7 words and 60 characters. The title is printed as a caption the width of the picture, so a long title on a narrow panel wraps or is cut. Shorter is always safer.",\n' +
    '      "description": "IN ENGLISH ALWAYS, whatever language the transcript is in -- this is an internal outline and is never shown to a reader. A terse OUTLINE of the panel key facts as short bullet points (one per line, each starting with a dash), NOT prose sentences. Establish who is present, what happens, and the setting. Preserve the EXACT names of any known characters or assets in this panel (this text drives name-matching). Facts and sequence only; leave the flavor to the narration.",\n' +
    '      "type": "combat|drama|discovery|humor",\n' +
    '      "shape": "The frame shape for this panel - choose EXACTLY one of: square, standard, wide, panoramic, tall, tower, or fullpage. Pick the shape that best fits the scene composition, so the printed graphic novel can vary panel sizes for a dynamic, cinematic page. From widest to tallest: panoramic is an ultra-wide cinematic banner - use it only for grand sweeping vistas, a long horizon, or a landscape or army stretching across the view; wide is a broad establishing or action shot; standard is the default balanced frame and should be the most common choice; square is an intimate close-up on a single face or object, or a tight two-shot; tall is a vertical, full-height framing; tower is an extremely tall and narrow shot - use it only for towering subjects, a great height or fall, a dramatic full-body reveal, or a narrow vertical space; fullpage is an upright, full-page proportioned frame (shaped like a whole printed page) for a striking image worth showing large at page size. Reserve the dramatic extremes panoramic, tower, and fullpage for moments whose composition genuinely earns them, and do not overuse any single shape.",\n' +
    '      \"prominence\": \"How much visual weight this beat deserves on the page, an integer 1 to 5 (1 = a minor or background beat, 3 = a normal beat, 5 = a major hero or splash moment). Most panels are 2 to 4; reserve 5 for genuinely pivotal beats and do not overuse it.\",\\n' +
    '      \"focal\": \"Where the main subject sits in the frame: exactly one of center, top, bottom, left, or right. Use center when the subject is centered or you are unsure.\",\\n' +
    '      \"crop_safe\": \"Boolean true or false. true if this image can be cropped to fill a panel without losing the important subject; false if the whole frame matters and the image should be shown complete.\",\\n' +
    '      \"group_break\": \"Boolean true or false. true if this moment begins a new scene or visual group (a shift of location, time, or topic from the previous moment); false if it continues the current scene.\",\\n' +
    '      "emphasis": "ONLY for combat moments: a punchy 1-3 word comic-style emphasis phrase that fits THIS specific moment (e.g. \\"Steel meets steel!\\", \\"The wards shatter!\\", \\"No escape!\\"). It must make sense for what actually happens in the moment — not a generic sound effect. For non-combat moments, use an empty string.",\n' +
    '      "prompt": "IN ENGLISH ALWAYS, whatever language the transcript or the director instructions are in -- this string is sent to an image model that reads English only, and the character names in it are what attach the correct reference pictures, so never translate or inflect a name. Detailed image generation prompt describing the SCENE ONLY. Describe composition, lighting, character positions, mood, and any specific visual details from the director\'s instructions. 2-3 sentences. Do NOT mention or name an art style, medium, or rendering technique - the art style is applied separately at image-generation time, so the prompt must stay style-neutral. CRITICAL FOR CHARACTER CONSISTENCY: every time a KNOWN named character appears, refer to them BY THEIR EXACT NAME (e.g. \\"Ruk\\", \\"Zara\\") - never anonymously like \\"a half-orc\\" or \\"the warrior\\". The name tells the system this is a specific recurring character. WHO IS ACTUALLY IN THE PANEL — CRITICAL: each panel is a SINGLE CINEMATIC SHOT, not an inventory of who is in the room. Name ONLY the characters whose faces or bodies would be IN THE VISUAL FRAME of this specific panel — the ones doing the action, reacting, or close enough to be visually prominent. Varied panel composition is what makes a graphic novel feel like a graphic novel — a close-up on one character\'s hands working magic, a two-shot of a heated argument, a wide group shot of the whole party entering a hall — each panel earns its character count from the dramatic moment, not from who happens to be present in the room. If a moment is intimate or focused, name 1 or 2 characters. If it is a group moment, name the group. AVOID the failure mode of \\"name everyone every time to be safe\\" — that produces bland, identical-cast panels and over-inclusion is just as wrong as under-inclusion. GROUP REFERENCES — CRITICAL: when the transcript uses a group term (\\"the party\\", \\"the group\\", \\"the adventurers\\", \\"the heroes\\", \\"the team\\", \\"the companions\\", \\"the fellowship\\", \\"everyone\\") or plural pronouns (\\"they\\", \\"them\\") that refer to multiple characters, NEVER pass the group term through to the prompt — group terms produce generic faces in the rendered image. Resolve the group term into the EXPLICIT NAMES of the characters who are visually in this panel\'s frame. For example, do not write \\"the party fights the dragon\\" — write \\"Ruk, Zara, and Thorin fight the dragon\\" if those three are the ones engaging. If only one or two characters from the group are the visual focus of this panel, name only those. Resolving a group term does NOT mean including every party member — it means replacing the vague term with the specific names of who is actually IN this shot. CHARACTER DESCRIPTIONS - KEEP THEM LEAN: a reference image supplies each known character\'s permanent appearance (face, build, features), so do NOT re-describe their fixed physical traits at length. For a known character, focus their text on what they are DOING in this panel (pose, action, expression) and any TEMPORARY visible state from the transcript (bloodied, muddy, exhausted, frightened, soaked). A brief identifying tag is fine the first time (\\"Ruk, the half-orc barbarian\\") but keep it short - the image carries the look. Only describe full physical appearance for UNNAMED background figures who are not known characters."\n' +
    '    }\n' +
    '  ],\n' +
    '  "narrative_outline": {\n' +
    '    "intro": "A terse outline as short bullet points (each on its own line, starting with a dash), NOT a prose sentence: the key beats the OPENING narration (before panel 1) will cover. A PLAN of the prose, not the prose itself.",\n' +
    '    "panels": [\n' +
    '      {\n' +
    '        "narration": "One short sentence describing the events THIS panel\'s image depicts and how they come about - the narration that leads INTO the picture.",\n' +
    '        "bridge": "A terse outline as short bullet points (each on its own line, starting with a dash), NOT a prose sentence: the connective events that bridge THIS panel to the NEXT one - travel, deliberation, side events. Leave this EMPTY for the final panel. The panels array MUST contain EXACTLY one entry per panel in the moments array above, in the same order, pairing each panel with the bridge that FOLLOWS it."\n' +
    '      }\n' +
    '    ],\n' +
    '    "outro": "A terse outline as short bullet points (each on its own line, starting with a dash), NOT a prose sentence: the key beats the CLOSING narration (after the final panel) will cover."\n' +
    '  }\n' +
    '}';

  // Async: create a pending job, respond immediately, then run the slow Claude
  // extraction in the background. Express does not await this handler, so the AI
  // call finishes AFTER the response is sent -- no gateway (Cloudflare 100s) timeout.
  const _ejNow = new Date().toISOString();
  const _ejIns = await db.prepare(
    "INSERT INTO extract_jobs (user_id, campaign_id, session_id, fork_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
  ).run(req.session.userId, req.params.campaignId, req.params.sessionId, targetForkId, _ejNow, _ejNow);
  const extractJobId = _ejIns.lastInsertRowid;
  res.json({ job_id: extractJobId });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: userPrompt
        }]
      })
    });

    const data = await response.json();
    if (data.error) { await db.prepare("UPDATE extract_jobs SET status='error', error=?, updated_at=? WHERE id=?").run(String((data.error && data.error.message) || 'AI service error'), new Date().toISOString(), extractJobId); return; }

    const raw = data.content.map(function(b) { return b.text || ''; }).join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (perr) {
      // The model occasionally truncates (hit max_tokens) or emits a stray char.
      // Conservative recovery: parse up to the last closing brace, accept only if
      // it has the expected shape (a moments array).
      let recovered = null;
      try { const lb = clean.lastIndexOf('}'); if (lb > 0) { const cand = JSON.parse(clean.slice(0, lb + 1)); if (cand && Array.isArray(cand.moments)) recovered = cand; } } catch (e2) { recovered = null; }
      if (recovered) { parsed = recovered; }
      else {
        try { console.error('[extract] JSON parse failed: ' + perr.message + ' | RAW(1200): ' + clean.slice(0, 1200)); } catch (_ce) {}
        await db.prepare("UPDATE extract_jobs SET status='error', error=?, updated_at=? WHERE id=?").run(('The story came back in an unexpected format (' + perr.message + ').'), new Date().toISOString(), extractJobId);
        return;
      }
    }

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

      // Approach B: the AI's establishing-scene description becomes the title
      // moment's prompt (for every caller's fork, not just the DM).
      var estScene = (parsed.establishing_scene && String(parsed.establishing_scene).trim()) ? String(parsed.establishing_scene).trim() : null;

      // Save the art style used so future sessions can inherit it (canonical
      // session field is DM-owned; a player's style choice stays on their fork).
      if (callerRole === 'dm') {
        // Heavy option for the title image: the extraction writes a dedicated
        // establishing-scene description; store it as the (editable) establishing
        // prompt. COALESCE keeps any existing prompt if the model omits the field.
        // The story changed, so the old title IMAGE no longer matches it - clear
        // it (like the panels above) so it regenerates on the next Generate Images.
        // The lock check earlier already refused if it was locked, so this is safe.
        var oldEst = session.establishing_image || null;
        await db.prepare('UPDATE sessions SET art_style = ?, establishing_prompt = COALESCE(?, establishing_prompt), establishing_image = NULL, establishing_img_w = NULL, establishing_img_h = NULL, edited_at = ?, edited_by = ? WHERE id = ?')
          .run(style, estScene, now, req.session.userId, session.id);
        if (oldEst) { try { await releaseImage(db, oldEst); } catch (e) {} }
      }

      const insert = await db.prepare(
        'INSERT INTO moments (session_id, fork_id, title, description, type, prompt, emphasis, shape, layout_meta, kind, panel_order, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      // v3.0.709 -- TD-511(2). establishing_scene IS AN IMAGE PROMPT, AND ITS NAME SAYS OTHERWISE.
      //
      // Ian, 2026-08-19, quoting a prompt back after v3.0.708 shipped: the panel prompts came
      // back English and THIS one was still German, with the English scaffolding below bolted to
      // the front of it -- "Starts in english????"
      //
      // v3.0.708 PUT establishing_scene ON THE READER-FACING LIST. That was wrong, and it was
      // wrong for the reason this project keeps paying for: it was classified by its NAME and by
      // a schema description that reads like prose ("A vivid 2-3 sentence WIDE ESTABLISHING
      // SHOT"), rather than by tracing where the value lands. It lands HERE -- concatenated onto
      // fixed English scaffolding and written into moments.prompt as the session title picture.
      // A reader never sees it.
      //
      // THE GUARD THAT NOW EXISTS keys off the INSERT below rather than off any wording: every
      // model-authored field written into moments.prompt must be named in the English-always
      // rule. v3.0.708's guards all passed while this was broken because every one of them
      // checked what the rule SAID and none checked which fields feed a prompt.
      //
      // estScene is written to moments.description as well; both columns are internal, so English
      // is right for both.
      // Approach B: the title image is the FIRST moment (kind='establishing'),
      // wide + high-prominence with wide-shot scaffolding so it renders as the
      // session/chapter title image; editable like any panel.
      var _estMomentPrompt = ('Wide establishing shot of the setting, seen from a distance; any characters appear small and far away, never in close-up. ' + (estScene || '')).trim();
      insert.run(session.id, dmForkId, (session.name || 'Title Image'), (estScene || ''), null, _estMomentPrompt, null, 'wide', JSON.stringify({ prominence: 5, focal: 'center', crop_safe: true, group_break: false }), 'establishing', 0, now, req.session.userId);
      parsed.moments.forEach(function(m, i) {
        var _shp = (['wide','tall','square','panoramic','tower','fullpage'].indexOf(m.shape) >= 0) ? m.shape : 'standard';
        insert.run(session.id, dmForkId, capTitleForShape(m.title, _shp), m.description, m.type, m.prompt, m.emphasis || null, _shp, JSON.stringify({ prominence: (Number(m.prominence) >= 1 && Number(m.prominence) <= 5) ? Math.round(Number(m.prominence)) : 3, focal: (['center','top','bottom','left','right'].indexOf(m.focal) >= 0) ? m.focal : 'center', crop_safe: m.crop_safe === false ? false : true, group_break: m.group_break === true }), 'normal', i + 1, now, req.session.userId);
      });

      // Pass 1 — store the per-gap narrative OUTLINE produced in this same
      // extraction call (free), and clear any stale narrative prose from a
      // prior extraction of this version (the panels just changed, so the old
      // prose no longer matches). Per-gap DIRECTIONS are deliberately preserved
      // (narrative_directions untouched) — they are the user's steering intent
      // and should survive a re-extract.
      var outlineObj = parsed.narrative_outline || {};
      // Each panel object pairs its OWN narration (-> before) with the bridge
      // that FOLLOWS it (-> outline). Pairing them in one object keeps the
      // bridge aligned to its panel (no shift). Final panel's bridge stays empty.
      var outlinePanels = Array.isArray(outlineObj.panels) ? outlineObj.panels : [];
      var outlineSections = [{ panel_index: 0, before: '', outline: '' }];
      for (var gi = 0; gi < parsed.moments.length; gi++) {
        var op = outlinePanels[gi] || {};
        outlineSections.push({ panel_index: gi + 1, before: op.narration || '', outline: (gi < parsed.moments.length - 1) ? (op.bridge || '') : '' });
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
    if (_storyCharge > 0) {
      try { await spendTokens(req.session.userId, _storyCharge, { source: 'generate_story', event_type: 'generation_spend', related_campaign_id: req.params.campaignId }); } catch (e) { console.error('generate_story spend failed:', e.message); }
    }
    try { await recordGeneration(req.session.userId, { event_type: 'generate_story', tokens_redeemed: _storyCharge, quantity: _userWords, unit: 'words', model: TEXT_MODEL, related_campaign_id: req.params.campaignId, related_session_id: req.params.sessionId }); } catch (e) {}
    await db.prepare("UPDATE extract_jobs SET status='done', result=?, updated_at=? WHERE id=?").run(JSON.stringify(parsed), new Date().toISOString(), extractJobId);
  } catch(e) {
    try { await db.prepare("UPDATE extract_jobs SET status='error', error=?, updated_at=? WHERE id=?").run(String((e && e.message) || 'Story generation failed'), new Date().toISOString(), extractJobId); } catch (_je) {}
  }
});

// Poll an extraction (Generate Story) job. Owner-scoped. Returns the parsed result
// (moments + pendingChanges) when done, a friendly error when failed, else pending.
router.get('/job/:jobId', requireAuth, async function (req, res) {
  const db = await getDb();
  const job = await db.prepare('SELECT * FROM extract_jobs WHERE id = ? AND user_id = ?').get(req.params.jobId, req.session.userId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'done') {
    var result = {};
    try { result = JSON.parse(job.result || '{}'); } catch (e) { result = {}; }
    return res.json(Object.assign({ status: 'done' }, result));
  }
  if (job.status === 'error') return res.json({ status: 'error', error: job.error || 'Story generation failed' });
  return res.json({ status: job.status || 'pending' });
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
// v3.0.467 -- SCOPED TO THE VERSION (TD-270). This is the PULL half, and it carried the same flaw
// as every other backward-looking query in this codebase: the WHERE named only the campaign, so a
// re-extraction took the most recent look from ANY version. It is now the fifth such query found
// today (TD-194, TD-252, TD-268, the approve-change push, this).
//
// The rule matches everything else: the most recent earlier session IN THIS VERSION, else the
// CANONICAL's, else the character's campaign-level look. forkId is passed by the one caller;
// without it this falls back to the canonical rather than guessing across versions.
async function resolveCarryForward(db, character, currentSession, forkId) {
  var versionId = null;
  if (forkId) {
    var vr = await db.prepare('SELECT version_id FROM session_forks WHERE id = ?').get(forkId);
    versionId = vr ? vr.version_id : null;
  }
  var prior = null;
  if (versionId) {
    prior = await db.prepare(
      'SELECT sc.prompt, sc.reference_url FROM session_characters sc ' +
      'JOIN session_forks sf ON sf.id = sc.fork_id ' +
      'JOIN sessions s ON s.id = sf.session_id ' +
      'WHERE sc.character_id = ? AND sf.version_id = ? AND s.session_date < ? ' +
      'ORDER BY s.session_date DESC, sf.id DESC LIMIT 1'
    ).get(character.id, versionId, currentSession.session_date);
  }
  if (!prior) {
    // FALLTHROUGH to the canonical, the same rule the book uses for an unbranched session.
    prior = await db.prepare(
      'SELECT sc.prompt, sc.reference_url FROM session_characters sc ' +
      'JOIN session_forks sf ON sf.id = sc.fork_id ' +
      'JOIN sessions s ON s.id = sf.session_id ' +
      "WHERE sc.character_id = ? AND sf.role = 'dm' AND s.campaign_id = ? " +
      'AND s.session_date < ? ' +
      'ORDER BY s.session_date DESC LIMIT 1'
    ).get(character.id, currentSession.campaign_id, currentSession.session_date);
  }

  var prompt = (prior && prior.prompt)
    ? prior.prompt
    : (character.canonical_prompt && character.canonical_prompt.trim()
        ? character.canonical_prompt
        : (character.description || ''));

  // v3.0.586 -- TD-345(d). THE HEIGHT IS WRITTEN INTO THE SNAPSHOT, WHICH IS WHAT CARRIES IT.
  // Ian: "make sure their heights are written into the character prompts. That get copied from
  // session to session." This row IS the per-session snapshot and the branch above already
  // carries the previous session's prompt forward, so writing the height here means it travels
  // with the character for free -- and every session already created keeps the height it was
  // built with, which is TD-345(f): "if a character that's tall in session 6 gets shrunk, we
  // would be screwed."
  // NORMALISED, NOT APPENDED. charPromptWithHeight strips any existing marker before adding the
  // current one, so a prompt carried forward cannot accumulate a stack of them, and a height
  // CHANGED today is picked up by sessions created from now on rather than being frozen out.
  // A character with no height set is returned untouched (TD-345(e)).
  try { prompt = charHeight.charPromptWithHeight(prompt, character.height_ft); } catch (e) {}

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
      const carry = await resolveCarryForward(db, ch, session, forkId);
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
        model: TEXT_MODEL,
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
