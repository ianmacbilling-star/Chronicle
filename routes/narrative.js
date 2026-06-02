const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb, getDmForkId, getOrCreateDmFork, getViewableForkId } = require('../database/db');
const { requireAuth, getCampaignRole } = require('../middleware/auth');

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
  const fkSteer = await db.prepare('SELECT fork_notes, narrative_directions FROM session_forks WHERE id = ?').get(targetForkId);
  if (fkSteer) {
    if (callerRole !== 'dm') directorNotes = fkSteer.fork_notes || '';
    if (fkSteer.narrative_directions) {
      try { gapDirections = JSON.parse(fkSteer.narrative_directions) || {}; } catch (e) { gapDirections = {}; }
    }
  }

  // Get moments in order (from the caller's version)
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(targetForkId);
  if (!moments.length) return res.json({ error: 'No moments found. Please extract key moments first.' });

  // Get campaign and characters
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(session.campaign_id);

  const charList = characters.map(function(c) {
    return c.name + (c.player_name ? ' (played by ' + c.player_name + ')' : '') + ' — ' + (c.cls || '') + ': ' + (c.description || '');
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

  // Explicit per-gap descriptions for the AI to fill. Each gap is
  // labeled with the two panels that bracket it.
  const gapsList = moments.map(function(m, i) {
    const isLast = (i === moments.length - 1);
    const nextLabel = isLast
      ? 'THE END OF THE SESSION'
      : 'PANEL ' + (i + 2) + ' — "' + moments[i + 1].title + '"';
    const dir = gapDirections['between:' + i];
    const dirLine = dir
      ? '\n  DIRECTOR STEERING for this gap (you MUST follow this): ' + dir
      : '';
    return 'GAP after panel ' + (i + 1) + ': sits between ' +
      'PANEL ' + (i + 1) + ' — "' + m.title + '" AND ' + nextLabel + '.\n' +
      '  Write prose describing ONLY the story events that occur AFTER panel ' + (i + 1) +
      ' and BEFORE ' + (isLast ? 'the session ends' : 'panel ' + (i + 2)) + '. ' +
      'Do not describe what panel ' + (i + 1) + ' itself shows — that is the image\'s job. ' +
      'Do not describe events that belong in other gaps.' + dirLine;
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
    'YOUR JOB — fill the gaps between panels:\n' +
    '═══════════════════════════════════════════════════════════\n\n' +
    'Each "after" block in your response covers ONE specific gap in the timeline. ' +
    'The panel sequence above is the authoritative chronology — events described ' +
    'in any narrative block MUST belong to the gap that block represents.\n\n' +
    'The gaps you need to fill:\n\n' +
    gapsList + '\n\n' +
    'You will also write an "intro" (before panel 1) and an "outro" (after the final panel).\n' +
    (gapDirections['opening'] ? 'DIRECTOR STEERING for the intro (you MUST follow this): ' + gapDirections['opening'] + '\n' : '') +
    (gapDirections['closing'] ? 'DIRECTOR STEERING for the outro (you MUST follow this): ' + gapDirections['closing'] + '\n' : '') +
    '\n' +
    (directorNotes ? 'Overall narrative direction (these may include instructions that informed the panel sequence above; honor the chronology of the panels regardless):\n' + directorNotes + '\n\n' : '') +
    'Full session transcript (reference for what actually happened — but the panel sequence above is the authoritative ORDER of events):\n' + session.transcript + '\n\n' +
    'Style:\n' +
    '- Read like a fantasy novel or comic book caption — vivid, dramatic, engaging\n' +
    '- NOT a transcription of what players said\n' +
    '- Use present tense, third person narrative voice\n' +
    '- 2-4 sentences per gap — punchy, not bloated\n' +
    '- Reference characters by name when relevant\n' +
    '- Capture mood, tension, and drama\n\n' +
    'CRITICAL — chronological correctness:\n' +
    '- Each gap\'s prose describes ONLY events between its two bracketing panels\n' +
    '- Do not place post-event prose before the panel that depicts that event\n' +
    '- Do not summarize panel content itself — that\'s what the image shows\n' +
    '- If the transcript covers events that the panels skip (travel, deliberation, side moments), THOSE go in the gaps\n\n' +
    'Return ONLY valid JSON, no markdown. The sections array must have EXACTLY ' + moments.length +
    ' entries (one per panel), in order, with panel_index 0 through ' + (moments.length - 1) + ':\n' +
    '{\n' +
    '  "intro": "Opening paragraph that sets the scene BEFORE panel 1 (2-3 sentences)",\n' +
    '  "intro_summary": "A terse outline of the opening — what the reader needs to know. Maximum 25 words; aim shorter.",\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "panel_index": 0,\n' +
    '      "before": "",\n' +
    '      "after": "Prose for the gap AFTER panel 1 and BEFORE panel 2 (2-3 sentences)",\n' +
    '      "after_summary": "A terse outline of what happens in this gap. Maximum 25 words; aim shorter. Do NOT pad to length."\n' +
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
      'UPDATE session_forks SET narrative_intro=?, narrative_intro_summary=?, ' +
      'narrative_sections=?, narrative_outro=?, narrative_outro_summary=?, ' +
      'edited_at=?, edited_by=? WHERE id=?'
    ).run(
      parsed.intro || '',
      parsed.intro_summary || '',
      JSON.stringify(parsed.sections || []),
      parsed.outro || '',
      parsed.outro_summary || '',
      now, req.session.userId, targetForkId
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
  const fk = await db.prepare('SELECT narrative_intro, narrative_sections, narrative_outro FROM session_forks WHERE id = ?').get(viewForkId);

  res.json({
    intro: fk && fk.narrative_intro ? fk.narrative_intro : '',
    sections: fk && fk.narrative_sections ? JSON.parse(fk.narrative_sections) : [],
    outro: fk && fk.narrative_outro ? fk.narrative_outro : ''
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
  if (!/^(opening|closing|between:\d+)$/.test(gap)) {
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

module.exports = router;
