const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getDmForkId, getOrCreateDmFork, getViewableForkId } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getEffectiveTier, tierRank, accessRank, narrativeStyleAllowed } = require('../middleware/tiers');
const { logDebug } = require('./debug');

// ============================================================
// NARRATIVE STYLES — the prose analog of art styles.
// Each entry supplies the VOICE LAYER (tone, tense, person, diction + an
// example) that gets injected into the narrative-generation prompt. The
// mechanical rules (chronology, gap anchoring, JSON structure, "don't
// summarize the panel") stay fixed in the prompt regardless of voice.
//
// The stored selection is just the id string (on session_forks.narrative_style,
// per version). 'classic' is the default and preserves the original behavior
// exactly, so existing sessions do not change voice unless a style is picked.
//
// IMPORTANT: the ids here are the source of truth for what is VALID. The
// frontend keeps a parallel display list (name/description/example) keyed by
// these same ids — keep the ids in sync.
// ============================================================
const NARRATIVE_STYLES = (function () {
  const IP_GUARD = ' COPYRIGHT \u2014 write entirely original prose. Never reproduce verbatim or near-verbatim text from any published source, including published adventure modules, rulebooks, or novels, even if such text appears in the transcript; always retell events in your own words. Keep the character and place names the user gives EXACTLY as written, even when a name matches another franchise; treat each such name as the user\'s OWN original creation that merely shares the name, and never borrow that franchise\'s backstory, lore, setting, relationships, or signature details \u2014 write only the user\'s own story. Any name you invent yourself must be your own original creation, never drawn from a real franchise \u2014 do not add a same-named character\'s known companions, sidekicks, enemies, or settings.'; const SYS = 'You are a skilled fantasy author writing graphic novel narrative prose in the narrative voice described by the user. You always return valid JSON.' + IP_GUARD;
  const DIALOGUE_IP_GUARD = ' COPYRIGHT \u2014 You MAY quote or lightly adapt what the players and characters actually say and do in THIS session\'s transcript; that is the user\'s own gameplay and is fair to use. But never reproduce verbatim or near-verbatim passages of PUBLISHED source text (published adventure modules, rulebooks, or novels); if such material is pasted into the transcript, retell it in your own words. Keep the character and place names the user gives EXACTLY as written, even when a name matches another franchise; treat each such name as the user\'s OWN original creation that merely shares the name, and never borrow that franchise\'s backstory, lore, setting, relationships, or signature details \u2014 write only the user\'s own story. Any name you invent yourself must be your own original creation, never drawn from a real franchise.';
  const DIALOGUE_SYS = 'You are a comic-book script writer turning a real tabletop RPG session into dialogue-driven graphic-novel script. You always return valid JSON.' + DIALOGUE_IP_GUARD;
  return {
    classic: {
      name: 'Classic',
      voice: `Vivid, dramatic, and engaging — like a fantasy novel or comic-book caption. Use PRESENT tense and THIRD-PERSON narrative voice. Capture mood, tension, and drama.\nExample: "Torchlight trembles against the cavern wall as the party edges forward, every breath held, every shadow a possible threat."`,
      system: 'You are a skilled fantasy author writing graphic novel narrative prose. You write in a vivid, dramatic style appropriate for fantasy graphic novels. You always return valid JSON.' + IP_GUARD
    },
    epic: {
      name: 'Epic Saga',
      voice: `Mythic, poetic, sweeping, and dramatic. Describe events as if part of a legendary saga recorded by ancient historians. Use elevated language, poetic phrasing, and a sense of destiny or grandeur. Focus on atmosphere, symbolism, and the weight of events. Avoid modern slang. Keep the narration concise but powerful. PAST tense, THIRD person.\nExample: "Thus the companions pressed onward, their footsteps echoing through the hollow places of the world, unaware that fate watched them with patient eyes."`,
      system: SYS
    },
    journal: {
      name: "Adventurer's Journal",
      voice: `Personal and grounded, with occasional dry humor or self-reflection, as if taken from an adventurer's personal journal. Focus on what the characters notice, feel, or think in the moment. You may use FIRST person ("I") or close THIRD person ("Zara thought..."). Keep it readable and human.\nExample: "We thought the forest would be quiet after the fight. Turns out the turnips were louder than the monsters."`,
      system: SYS
    },
    cinematic: {
      name: 'Cinematic Script',
      voice: `Visual, fast, and minimal — like a storyboard description. Focus on action, motion, and sensory detail. Use SHORT, punchy sentences. Describe what the "camera" sees: lighting, movement, framing. Avoid internal monologue or flowery language.\nExample: "The torchlight flickers. Shadows stretch across the stone. Ruk stumbles, pale and shaking, as the shriek fades into the dark."`,
      system: SYS
    },
    lorekeeper: {
      name: 'Lorekeeper / Historian',
      voice: `Scholarly, mysterious, and world-building heavy, as if recorded by an in-world historian or lorekeeper. Use formal, slightly archaic language. Provide context, hints of ancient knowledge, or commentary on the significance of events. Avoid humor unless it fits the lorekeeper's personality.\nExample: "In the annals of the Third Era, the incident of the SoupMaster is noted with both caution and curiosity, for few mortals have tampered with arcane gastronomy and lived."`,
      system: SYS
    },
    noir: {
      name: 'Noir',
      voice: `Fantasy-noir: gritty, moody, cynical, and atmospheric. Use weary, suspicious language. Focus on shadows, tension, and the emotional weight of the moment. Use metaphors and punchy, hard-boiled phrasing. The narrator sounds like they have seen too much and trust too little.\nExample: "The cave breathed cold air like a liar exhaling excuses, and the torchlight was not bright enough to chase off the truth hiding in the corners."`,
      system: SYS
    },
    grim: {
      name: 'Dark Fantasy / Grim',
      voice: `Dark fantasy: bleak, heavy, ominous, and visceral. Emphasize dread, decay, and the harshness of the world. Use vivid, unsettling imagery and weighty descriptions. Avoid humor. Highlight the danger and cost of every choice.\nExample: "Blood soaked into the stone, vanishing as if the earth itself were thirsty. In the silence that followed, even hope felt like a dying ember."`,
      system: SYS
    },
    storybook: {
      name: "Children's Storybook",
      voice: `Whimsical, gentle, and playful — like a children's fantasy story. Use warm, friendly language and a sense of wonder. Keep sentences simple, rhythmic, and imaginative. Avoid violence or describe it softly. Emphasize friendship, bravery, and curiosity.\nExample: "And so the brave friends tip-toed into the twinkly cave, where shadows danced like shy little creatures waiting to say hello."`,
      system: SYS
    },
    anime: {
      name: 'High-Drama Anime',
      voice: `High-drama anime: intense, emotional, exaggerated, and heroic. Use heightened emotion, dramatic pacing, and bold, expressive language. Emphasize power, determination, and the emotional stakes of the moment. Use dynamic phrasing and vivid action.\nExample: "Ruk's heartbeat thundered like a war drum as the darkness closed in — but his spirit refused to fall. Not here. Not now."`,
      system: SYS
    },
    dialogue: {
      name: 'Comic Dialogue',
      voice: `Comic-book script with a balanced mix of dialogue and narration \u2014 aim for ROUGHLY HALF spoken dialogue and half narrative prose in every block. Narrate what each panel shows in short, vivid prose, and weave the characters' spoken lines through it so the two are about even. Put EACH spoken line on its OWN line, beginning with the speaker's name, a colon, and the quoted line; keep narration on its own lines between them. Give every character a distinct voice and hit the emotional turns of the exchange. Use PRESENT tense for narration. You may quote or adapt what was said in the transcript; invent dialogue where the scene needs it; never copy lines from any published source.\nFormat each block like this (narration prose interleaved with one line per speaker):\nThe hall falls silent as the doors groan open.\nGARRICK: "Hold the line \u2014 they break on three."\nVENA: "You said that last time."\nSteel scrapes free of leather as the dark rolls in.\nGARRICK: "And were we wrong?"`,
      system: DIALOGUE_SYS
    }
  };
})();

// Phase 4 — resolve the caller's version: DM -> canonical (DM fork);
// player -> their own version (null if they have none).
async function callerForkId(db, sessionId, userId, role) {
  if (role === 'dm') return await getOrCreateDmFork(db, sessionId, userId);
  const f = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
  return f ? f.id : null;
}

// ============================================================
// GENERATE narrative prose for a session
// ============================================================
// Outline value helpers. narrative_outlines stores either a plain string (a
// user-authored outline, the Stage-1 shape) or { text, edited }. A plain string
// counts as user-edited; a seeded object carries edited:false.
function outlineText(v) { return (v && typeof v === 'object') ? (v.text || '') : (v || ''); }
function outlineEdited(v) { return (v && typeof v === 'object') ? !!v.edited : (typeof v === 'string' && v.length > 0); }

router.post('/generate/:campaignId/:sessionId', requireAuth, async function(req, res) {
  // Use platform key from env, fall back to request body key
  const key = process.env.ANTHROPIC_API_KEY || req.body.key;
  if (!key) return res.json({ error: 'AI service not configured. Please contact support.' });

  const db = await getDb();

  // Verify membership and get session
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });
  if (!session.transcript) return res.json({ error: 'No transcript found. Please add a transcript first.' });

  // Phase 4 — the DM generates the canonical narrative; a player generates
  // their OWN version's narrative. Each writes only to its own fork row.
  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  const targetForkId = await callerForkId(db, session.id, req.session.userId, callerRole);
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });

  // Steering inputs (Pass 1):
  //  - OVERALL direction: the DM steers with the session's notes; a player
  //    steers their OWN version with their fork notes.
  //  - PER-GAP direction: optional steering text per gap, set on the Review
  //    tab, stored on this fork. Injected into each gap's instruction below so
  //    the first generation AND every per-gap Regen honor it.
  let directorNotes = session.session_notes || '';
  let gapDirections = {};
  let gapOutlines = {};
  const fkSteer = await db.prepare('SELECT fork_notes, narrative_directions, narrative_outlines, narrative_style FROM session_forks WHERE id = ?').get(targetForkId);
  if (fkSteer) {
    if (callerRole !== 'dm') directorNotes = fkSteer.fork_notes || '';
    if (fkSteer.narrative_directions) {
      try { gapDirections = JSON.parse(fkSteer.narrative_directions) || {}; } catch (e) { gapDirections = {}; }
    }
    if (fkSteer.narrative_outlines) {
      try { gapOutlines = JSON.parse(fkSteer.narrative_outlines) || {}; } catch (e) { gapOutlines = {}; }
    }
  }

  // Narrative Style (Narrative Styles feature) — this version's VOICE preset.
  // Null/unknown falls back to 'classic' (the original behavior).
  const narrStyleId = (fkSteer && fkSteer.narrative_style) ? fkSteer.narrative_style : 'classic';
  const styleBundle = NARRATIVE_STYLES[narrStyleId] || NARRATIVE_STYLES['classic'];
  const isDialogue = (narrStyleId === 'dialogue');

  // Get moments in order (from the caller's version)
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(targetForkId);
  if (!moments.length) return res.json({ error: 'No moments found. Please extract key moments first.' });

  // Get campaign and characters
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(session.campaign_id);

  const charList = characters.map(function(c) {
    var _toks = String(c.name || '').split('/').map(function(t){ return t.trim(); }).filter(function(t){ return t.length; });
    var _canon = _toks.length ? _toks[0] : String(c.name || '').trim();
    var _aka = _toks.slice(1);
    return _canon + (_aka.length ? ' (also known as: ' + _aka.join(', ') + ')' : '') + (c.player_name ? ' (played by ' + c.player_name + ')' : '') + ' — ' + (c.cls || '') + ': ' + (c.description || '');
  }).join('\n');

  // Build the panel sequence with EXPLICIT per-gap anchoring. The
  // previous version handed the AI a flat list of panels and left it to
  // infer chronology from transcript context. That broke when a DM-note
  // instruction inserted a panel into a new slot: the surrounding
  // narrative blocks ended up describing events in the wrong order
  // (e.g. the post-event prose appeared BEFORE the panel that depicted
  // the event itself).
  //
  // The fix: structure the prompt as a sequence of GAPS, each gap
  // explicitly bracketed by the panel before it and the panel after it.
  // The AI is told to write prose for the EVENTS THAT OCCUR BETWEEN
  // those two specific panels — nothing else. This forces the narrative
  // to track the actual chronological position of each block.
  const momentsList = moments.map(function(m, i) {
    return 'PANEL ' + (i + 1) + ' — ' + m.title + '\n' +
      '  Depicts: ' + m.description;
  }).join('\n\n');

  // Each panel gets TWO continuous narrative blocks that, with intro/outro,
  // leave no hole in the story: a MOMENT block ("before") that narrates the
  // events the panel's image depicts and how they come about, and a BRIDGE
  // block ("after") that carries the story from this moment to the next. The
  // chain reads intro -> moment(0) -> bridge(0) -> moment(1) -> bridge(1) ->
  // ... -> outro, each block resuming exactly where the previous one ended.
  const beatsList = moments.map(function(m, i) {
    const isLast = (i === moments.length - 1);
    const prevRef = (i === 0) ? 'the intro' : 'the BRIDGE block of panel ' + i;
    const nextLabel = isLast
      ? 'THE END OF THE SESSION'
      : 'PANEL ' + (i + 2) + ' - "' + moments[i + 1].title + '"';
    const mDir = gapDirections['moment:' + i];
    const mDirLine = mDir
      ? '\n    DIRECTOR STEERING for this moment (you MUST follow this): ' + mDir
      : '';
    const aDir = gapDirections['between:' + i];
    const aDirLine = aDir
      ? '\n    DIRECTOR STEERING for this bridge (you MUST follow this): ' + aDir
      : '';
    const aOutline = gapOutlines['between:' + i];
    const aOutlineLine = outlineEdited(aOutline)
      ? '\n    REQUIRED CONTENT for this bridge (you MUST cover these facts, in your own prose): ' + outlineText(aOutline)
      : '';
    return 'PANEL ' + (i + 1) + ' - "' + m.title + '" -- THIS panel\'s image depicts: ' + m.description + '\n' +
      '  MOMENT block ("before"): its PRIMARY job is to narrate THIS panel\'s image -- the scene just described above -- telling what is happening in THIS picture and how it comes about. Connect smoothly from ' + prevRef + ', but do NOT spend this block continuing the previous panel\'s action; the bulk of it must describe and lead INTO this specific image, and THIS panel\'s depicted action MUST be told here in this block, not deferred to the bridge.' + mDirLine + '\n' +
      '  BRIDGE block ("after"): ONLY after this panel\'s depicted action has been told in the MOMENT block above, carry the story forward to ' + (isLast ? 'the end of the session' : 'just before ' + nextLabel) + '. Cover only travel, deliberation, and side events between this panel and the next. Do NOT narrate this panel\'s own depicted action here (that belongs in the MOMENT block above), and do NOT jump ahead into the next panel\'s depicted action (its own MOMENT block covers that).' + aDirLine + aOutlineLine;
  }).join('\n\n');

  const prompt =
    'You are a skilled fantasy author writing the narrative for a graphic novel based on a real TTRPG session.\n\n' +
    'Campaign: ' + campaign.name + '\n' +
    'Session: ' + session.name + '\n' +
    'Date: ' + session.session_date + '\n\n' +
    'Characters:\n' + charList + '\n\n' +
    '═══════════════════════════════════════════════════════════\n' +
    'THE PANEL SEQUENCE (in chronological order — do NOT reorder):\n' +
    '═══════════════════════════════════════════════════════════\n\n' +
    momentsList + '\n\n' +
    '═══════════════════════════════════════════════════════════\n' +
    'YOUR JOB - write the continuous narrative:\n\n' +
    'The story is ONE continuous narrative told in alternating blocks. For each ' +
    'panel you write a MOMENT block ("before") and a BRIDGE block ("after"). ' +
    'Read end to end, the chain is: intro -> moment(1) -> bridge(1) -> moment(2) ' +
    '-> bridge(2) -> ... -> outro, with NO gaps and NO repetition. Each block ' +
    'MUST resume exactly where the previous block ended, so the reader never hits ' +
    'a hole where a picture is shown but its events were never told.\n\n' +
    'The panel sequence above is the authoritative chronology - do not reorder, ' +
    'and keep every block in its correct place in the timeline.\n\n' +
    'The blocks you need to write, panel by panel:\n\n' +
    beatsList + '\n\n' +
    'You will also write an "intro" (before panel 1) and an "outro" (after the final panel).\n' +
    (outlineEdited(gapOutlines['opening']) ? 'REQUIRED CONTENT for the intro (you MUST cover these facts, in your own prose): ' + outlineText(gapOutlines['opening']) + '\n' : '') +
    (gapDirections['opening'] ? 'DIRECTOR STEERING for the intro (you MUST follow this): ' + gapDirections['opening'] + '\n' : '') +
    (outlineEdited(gapOutlines['closing']) ? 'REQUIRED CONTENT for the outro (you MUST cover these facts, in your own prose): ' + outlineText(gapOutlines['closing']) + '\n' : '') +
    (gapDirections['closing'] ? 'DIRECTOR STEERING for the outro (you MUST follow this): ' + gapDirections['closing'] + '\n' : '') +
    '\n' +
    (directorNotes ? 'Overall narrative direction (these may include instructions that informed the panel sequence above; honor the chronology of the panels regardless):\n' + directorNotes + '\n\n' : '') +
    'Full session transcript (reference for what actually happened — but the panel sequence above is the authoritative ORDER of events):\n' + session.transcript + '\n\n' +
    'Style:\n' +
    (isDialogue
      ? '- Balance each block ROUGHLY 50/50 between character dialogue and narrative prose\n' +
        '- Narrate what the panel shows in short prose, and weave in the characters\' spoken lines so the two are about even\n' +
        '- Put each spoken line on its OWN line, led by the speaker\'s name and a colon, e.g.  GARRICK: "Hold the line."\n' +
        '- Keep narration lines on their own lines between the dialogue\n'
      : '- Roughly 2-4 sentences per block — punchy, not bloated\n'
    ) +
    '- Reference characters by name when relevant\n\n' +
    'COPYRIGHT \u2014 keep the character and place names from the transcript EXACTLY as written, but treat each as the user\'s own original creation: do NOT reproduce any verbatim copyrighted text, and do NOT borrow the backstory, lore, setting, or signature details of any same-named character or world from another franchise, and never invent a new name lifted from a real franchise (do not borrow a same-named character\'s known allies, sidekicks, or places). Tell only the user\'s own story, in your own original words.\n\n' +
    'NARRATIVE VOICE — write the prose in THIS style. This governs tone, tense, and person; the chronological and structural rules still apply regardless of voice:\n' +
    styleBundle.voice + '\n\n' +
    'CRITICAL - continuity and chronology:\n' +
    '- The MOMENT block of each panel narrates what that panel\'s image depicts; describing the picture in prose is REQUIRED here, not forbidden\n' +
    '- Every block picks up exactly where the previous block left off - no gaps, and do not restate what an earlier block already covered\n' +
    '- Keep events in chronological order; never place a later event before the panel that depicts it\n' +
    '- A BRIDGE block covers ONLY what happens between its panel\'s moment and the next panel\'s moment (travel, deliberation, side events the panels skip)\n' +
    '- If the transcript covers events the panels skip, those belong in the BRIDGE blocks\n\n' +
    'Return ONLY valid JSON, no markdown. The sections array must have EXACTLY ' + moments.length +
    ' entries (one per panel), in order, with panel_index 0 through ' + (moments.length - 1) + ':\n' +
    'IMPORTANT: panel_index is ZERO-BASED \u2014 PANEL 1 above is panel_index 0, PANEL 2 is panel_index 1, and so on. List the sections in panel order, PANEL 1 first.\n' +
    '{\n' +
    '  "intro": "Opening paragraph that sets the scene BEFORE panel 1 (2-3 sentences)",\n' +
    '  "intro_summary": "A terse outline of the opening — what the reader needs to know. Maximum 25 words; aim shorter.",\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "panel_index": 0,\n' +
    '      "before": "MOMENT prose: narrate what panel 1\'s image depicts and how it comes about, picking up from the intro (2-4 sentences). REQUIRED and non-empty.",\n' +
    '      "before_summary": "A terse outline of the moment block. Maximum 25 words; aim shorter. Do NOT pad to length.",\n' +
    '      "after": "BRIDGE prose: carry the story from panel 1\'s moment forward to just before panel 2 (2-4 sentences).",\n' +
    '      "after_summary": "A terse outline of the bridge. Maximum 25 words; aim shorter. Do NOT pad to length."\n' +
    '    }\n' +
    '  ],\n' +
    '  "outro": "Closing paragraph after the final panel (2-3 sentences)",\n' +
    '  "outro_summary": "A terse outline of the closing. Maximum 25 words; aim shorter."\n' +
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
        system: styleBundle.system,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const raw = data.content.map(function(b) { return b.text || ''; }).join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Defensive alignment: the prompt labels panels 1-based but asks for a
    // 0-based panel_index, an easy off-by-one that shifts every section in
    // the UI. Reordering is forbidden, so trust array ORDER over the model's
    // index: sort by the reported panel_index, clamp to the moment count,
    // then re-key to 0..N-1 by position so sections always line up.
    try {
      var _secs = Array.isArray(parsed.sections) ? parsed.sections.slice() : [];
      _secs.sort(function (a, b) {
        var ai = (a && typeof a.panel_index === 'number') ? a.panel_index : 0;
        var bi = (b && typeof b.panel_index === 'number') ? b.panel_index : 0;
        return ai - bi;
      });
      if (_secs.length > moments.length) _secs = _secs.slice(0, moments.length);
      parsed.sections = _secs.map(function (sec, i) { sec = sec || {}; sec.panel_index = i; return sec; });
    } catch (e) { /* leave parsed.sections as-is on any unexpected shape */ }

    // Save to database — sections JSON already carries each panel's
    // after_summary; intro/outro summaries get their own columns.
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE session_forks SET narrative_intro=?, narrative_intro_summary=?, ' +
      'narrative_sections=?, narrative_outro=?, narrative_outro_summary=?, ' +
      'narrative_style_used=?, edited_at=?, edited_by=? WHERE id=?'
    ).run(
      parsed.intro || '',
      parsed.intro_summary || '',
      JSON.stringify(parsed.sections || []),
      parsed.outro || '',
      parsed.outro_summary || '',
      narrStyleId, now, req.session.userId, targetForkId
    );

    try { await logDebug(req.session.userId, { level: 'info', source: 'generation', page: 'Generate narrative', fn: 'POST /narrative/generate', message: 'Narrative generated (' + narrStyleId + ', ' + ((parsed.sections || []).length) + ' sections)', detail: { style: narrStyleId, sections: (parsed.sections || []).length, moments: moments.length, campaign_id: req.params.campaignId, session_id: req.params.sessionId } }); } catch (_le) {}

    res.json({
      success: true,
      intro: parsed.intro || '',
      sections: parsed.sections || [],
      outro: parsed.outro || ''
    });

  } catch(e) {
    console.error('Narrative generation error:', e.message);
    try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Generate narrative', fn: 'POST /narrative/generate', message: 'Narrative generation failed: ' + (e && e.message), detail: { campaign_id: req.params.campaignId, session_id: req.params.sessionId, stack: (e && e.stack) || '' } }); } catch (_le) {}
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
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  const targetForkId = await callerForkId(db, session.id, req.session.userId, callerRole);
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });

  const now = new Date().toISOString();
  await db.prepare(
    'UPDATE session_forks SET narrative_intro=?, narrative_sections=?, narrative_outro=?, edited_at=?, edited_by=? WHERE id=?'
  ).run(
    intro || '',
    JSON.stringify(sections || []),
    outro || '',
    now, req.session.userId, targetForkId
  );

  res.json({ success: true });
});

// ============================================================
// GET narrative for a session
// ============================================================
router.get('/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const db = await getDb();
  // Phase 3: narrative READ is open to any campaign member (DM or
  // player) — players need this to see the Review tab and storyboard.
  // Writes (regenerate, save) remain DM-only via inline checks in
  // those endpoints.
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id ' +
    'WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  // Read the narrative from the VIEWED version (DM canonical by default, or
  // a ?fork_id= the caller is allowed to see).
  const viewForkId = await getViewableForkId(db, session.id, req.session.userId, req.query.fork_id);
  if (!viewForkId) return res.status(403).json({ error: 'Access denied' });
  const fk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro, narrative_style FROM session_forks WHERE id = ?').get(viewForkId);

  res.json({
    intro: fk && fk.narrative_intro ? fk.narrative_intro : '',
    sections: fk && fk.narrative_sections ? JSON.parse(fk.narrative_sections) : [],
    outro: fk && fk.narrative_outro ? fk.narrative_outro : '',
    narrative_style: fk && fk.narrative_style ? fk.narrative_style : 'classic'
  });
});

// ============================================================
// SAVE a per-gap narrative direction (Pass 1)
// Body: { gap: 'opening' | 'between:<i>' | 'closing', text: '...' }
// Merges into this version's narrative_directions JSON. Owner-scoped:
// the caller writes only their OWN version (DM -> DM fork, player -> own).
// Empty text clears that gap's direction. Returns the merged map so the
// frontend can update its lit-pill state.
// ============================================================
router.put('/direction/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.id FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);
  if (!session) return res.status(403).json({ error: 'Access denied' });

  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  const targetForkId = await callerForkId(db, session.id, req.session.userId, callerRole);
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });

  const gap = (req.body && req.body.gap) ? String(req.body.gap) : '';
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
  if (!/^(opening|closing|between:\d+|moment:\d+)$/.test(gap)) {
    return res.json({ error: 'Invalid gap key' });
  }

  const row = await db.prepare('SELECT narrative_directions FROM session_forks WHERE id = ?').get(targetForkId);
  let directions = {};
  if (row && row.narrative_directions) {
    try { directions = JSON.parse(row.narrative_directions) || {}; } catch (e) { directions = {}; }
  }
  if (text) directions[gap] = text;
  else delete directions[gap];

  const now = new Date().toISOString();
  await db.prepare('UPDATE session_forks SET narrative_directions = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(JSON.stringify(directions), now, req.session.userId, targetForkId);

  res.json({ success: true, gap: gap, text: text, directions: directions });
});

// ============================================================
// SAVE a gap OUTLINE (facts/sequence) for this version. Mirrors the direction
// PUT but writes narrative_outlines. The outline is the required CONTENT a gap
// must cover; Direction is the flavor steer. Owner-scoped; empty text clears.
// ============================================================
router.put('/outline/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.id FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);
  if (!session) return res.status(403).json({ error: 'Access denied' });

  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  const targetForkId = await callerForkId(db, session.id, req.session.userId, callerRole);
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });

  const gap = (req.body && req.body.gap) ? String(req.body.gap) : '';
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
  if (!/^(opening|closing|between:\d+)$/.test(gap)) {
    return res.json({ error: 'Invalid gap key' });
  }

  const row = await db.prepare('SELECT narrative_outlines FROM session_forks WHERE id = ?').get(targetForkId);
  let outlines = {};
  if (row && row.narrative_outlines) {
    try { outlines = JSON.parse(row.narrative_outlines) || {}; } catch (e) { outlines = {}; }
  }
  if (text) outlines[gap] = { text: text, edited: true };
  else delete outlines[gap];

  const now = new Date().toISOString();
  await db.prepare('UPDATE session_forks SET narrative_outlines = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(JSON.stringify(outlines), now, req.session.userId, targetForkId);

  res.json({ success: true, gap: gap, text: text, outlines: outlines });
});

// ============================================================
// SAVE this version's narrative STYLE (Narrative Styles feature)
// Body: { style: '<id>' }  where id is a key of NARRATIVE_STYLES.
// Owner-scoped exactly like /direction: the caller writes only their OWN
// version (DM -> DM fork, player -> own fork). Validated server-side.
// ============================================================
router.put('/style/:campaignId/:sessionId', requireAuth, async function(req, res) {
  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.id FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ?'
  ).get(req.params.sessionId, req.session.userId);
  if (!session) return res.status(403).json({ error: 'Access denied' });

  const callerRole = await getCampaignRole(req.session.userId, req.params.campaignId);
  if (!callerRole) return res.status(403).json({ error: 'Access denied' });
  const targetForkId = await callerForkId(db, session.id, req.session.userId, callerRole);
  if (!targetForkId) return res.status(403).json({ error: 'You have no version of this session' });

  const styleId = (req.body && typeof req.body.style === 'string') ? req.body.style.trim() : '';
  if (!NARRATIVE_STYLES[styleId]) {
    return res.json({ error: 'Unknown narrative style' });
  }

  // Tier gate: the chosen narrative style must be unlocked at the caller's
  // effective tier (max of their own tier and the SM's).
  const effRank = accessRank(await getEffectiveTier(req.session.userId, req.params.campaignId));
  if (!narrativeStyleAllowed(effRank, styleId)) {
    return res.status(403).json({ error: "That narrative style isn't available on your current plan. Pick another, or upgrade for more styles.", code: 'STYLE_LOCKED' });
  }

  const now = new Date().toISOString();
  await db.prepare('UPDATE session_forks SET narrative_style = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(styleId, now, req.session.userId, targetForkId);

  res.json({ success: true, style: styleId });
});

module.exports = router;
