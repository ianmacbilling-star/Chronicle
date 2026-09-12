const express = require('express');
const router = express.Router({ mergeParams: true });

// v3.0.558 -- TD-345: character height, in feet.
// PARSED, CLAMPED AND ROUNDED HERE so a value can never reach the database that the UI could not
// have produced -- the slider is one client and the API is another, and only this is authoritative.
// NULL IS A REAL STATE. An empty string, an absent field and a non-number all mean "not set", which
// is what every existing character is and what the Company page must keep rendering unchanged.
// The range is Ian s: 1ft to 25ft. Below that is not a character; above it is a set piece, not a
// member of the party. One decimal, because 5.5 is a common height and 5.53 is noise.
function parseHeightFt(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = parseFloat(v);
  if (!isFinite(n)) return null;
  if (n < 1) n = 1;
  if (n > 25) n = 25;
  return Math.round(n * 10) / 10;
}
const { getDb } = require('../database/db');
const { friendlyAnthropicError, friendlyImageError, friendlyError } = require('../middleware/friendlyErrors');
const { requireAuth, verifyCampaignDM, verifyCampaignMember, verifyCampaignDmOrCharacterOwner, isCampaignLocked } = require('../middleware/auth');
const { uploadFile, deleteFile, releaseImage } = require('../storage/storage');
const { TEXT_MODEL } = require('../config/models');
const imageHelpers = require('./images');
const { getTokenCost, canAfford, spendTokens, getBalance, characterReserveStatus,
        computeGenCharge, recordGeneration } = require('./tokens');   // v3.0.868 -- TD-735(a)
const { checkCharacterLimit } = require('../middleware/tiers');
const multer = require('multer');
const { imageFileFilter, guardUpload } = require('../middleware/uploadGuard');
const path = require('path');

// Use memory storage - we handle the upload ourselves via storage layer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter
});

const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'image_portrait', maxCount: 1 },
  { name: 'image_fullbody', maxCount: 1 },
  { name: 'image_action', maxCount: 1 },
  { name: 'image_other', maxCount: 1 }
]);

async function handleFileUpload(files, fieldname, oldUrl) {
  if (!files || !files[fieldname] || !files[fieldname][0]) return null;
  const file = files[fieldname][0];
  // Generate unique filename
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = 'char-' + Date.now() + '-' + fieldname + ext;
  return await uploadFile(file.buffer, filename, file.mimetype);
}

// GET all characters
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  // LEFT JOIN to users to resolve owner_user_id → owner_name for the
  // "Played by X" badge on the Characters tab. Owner is NULL for NPCs,
  // unowned PCs, and stub characters still awaiting their invitee.
  const characters = await db.prepare(
    'SELECT c.*, u.name AS owner_name, ' +
    'EXISTS(SELECT 1 FROM campaign_archives ca WHERE ca.character_id = c.id AND ca.fork_id IS NULL AND ca.source_url = c.canonical_reference_url AND ca.archived_by = ?) AS archived ' +
    'FROM characters c ' +
    'LEFT JOIN users u ON u.id = c.owner_user_id ' +
    'WHERE c.campaign_id = ? ORDER BY c.created_at ASC'
  ).all(req.session.userId, req.params.campaignId);
  res.json(characters);
});

// POST create character
router.post('/', requireAuth, verifyCampaignDM, checkCharacterLimit, guardUpload(uploadFields, 'characters'), async function(req, res) {
  const { name, player_name, cls, description, is_npc } = req.body;
  if (!name) return res.json({ error: 'Character name is required' });

  try {
    const db = await getDb();
    const now = new Date().toISOString();

    const image = await handleFileUpload(req.files, 'image', null);
    const image_portrait = await handleFileUpload(req.files, 'image_portrait', null);
    const image_fullbody = await handleFileUpload(req.files, 'image_fullbody', null);
    const image_action = await handleFileUpload(req.files, 'image_action', null);
    const image_other = await handleFileUpload(req.files, 'image_other', null);

    const npcFlag = (is_npc === true || is_npc === 'true' || is_npc === 1 || is_npc === '1');
    const result = await db.prepare(
      'INSERT INTO characters (campaign_id, name, player_name, cls, description, image, image_portrait, image_fullbody, image_action, image_other, is_npc, height_ft, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name.trim(), player_name || '', cls || '', description || '', image, image_portrait, image_fullbody, image_action, image_other, npcFlag, parseHeightFt(req.body.height_ft), now, req.session.userId);

    const character = await db.prepare('SELECT * FROM characters WHERE id = ?').get(result.lastInsertRowid);
    res.json(character);
  } catch(e) {
    console.error('Character create error:', e.message);
    res.json({ error: friendlyError(e, 'Could not create the character. Please try again.') });
  }
});

// PUT update character
router.put('/:id', requireAuth, verifyCampaignDmOrCharacterOwner, guardUpload(uploadFields, 'characters'), async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Phase 3 Deploy 3 — campaign lock check. Players can't canonical-edit
    // once any session is Ready (fork-editing in Phase 4 will replace
    // this path). DM always bypasses the lock.
    if (req.campaignRole === 'player') {
      if (await isCampaignLocked(req.params.campaignId)) {
        return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
      }
    }

    const now = new Date().toISOString();
    const imageFields = ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other'];
    const images = {};
    const oldImages = {};

    for (const field of imageFields) {
      if (req.body['clear_' + field] === 'true') {
        oldImages[field] = char[field];
        images[field] = null;
      } else if (req.files && req.files[field] && req.files[field][0]) {
        oldImages[field] = char[field];
        images[field] = await handleFileUpload(req.files, field);
      } else {
        images[field] = char[field];
      }
    }

    // is_npc toggle stays DM-only — silently preserve the existing value
    // when a player is editing. NPC conversion is a campaign authoring
    // act, not a player one.
    var npcVal = char.is_npc;
    if (req.campaignRole === 'dm' && req.body.is_npc !== undefined) {
      npcVal = (req.body.is_npc === true || req.body.is_npc === 'true' || req.body.is_npc === 1 || req.body.is_npc === '1');
    }
    await db.prepare(
      'UPDATE characters SET name=?, player_name=?, cls=?, description=?, image=?, image_portrait=?, image_fullbody=?, image_action=?, image_other=?, is_npc=?, height_ft=?, edited_at=?, edited_by=? WHERE id=?'
    ).run(
      req.body.name ? req.body.name.trim() : char.name,
      req.body.player_name !== undefined ? req.body.player_name.trim() : (char.player_name || ''),
      // v3.0.747 -- TD-546. `!== undefined`, matching player_name and description directly above
      // and below. Absent leaves it alone; an empty string clears it, which is what Ian was
      // trying to do and what the truthiness test made impossible.
      req.body.cls !== undefined ? String(req.body.cls).trim() : (char.cls || ''),
      req.body.description !== undefined ? req.body.description.trim() : (char.description || ''),
      images.image, images.image_portrait, images.image_fullbody, images.image_action, images.image_other,
      npcVal,
      // v3.0.558 -- TD-345. ABSENT means UNCHANGED, not cleared. A PUT that omits height_ft must
      // leave the stored value alone, because several callers update a character without ever having
      // seen this field -- the reference regenerate path among them. An EMPTY STRING is different:
      // that is the user deliberately clearing it, and it stores NULL.
      (req.body.height_ft === undefined ? (char.height_ft == null ? null : char.height_ft) : parseHeightFt(req.body.height_ft)),
      now, req.session.userId, char.id
    );

    // Release replaced/cleared images now that the row points elsewhere
    // (refcounted — a shared reference still in use is spared).
    for (const field of imageFields) {
      if (oldImages[field] && oldImages[field] !== images[field]) await releaseImage(db, oldImages[field]);
    }

    const updated = await db.prepare('SELECT * FROM characters WHERE id = ?').get(char.id);
    res.json(updated);
  } catch(e) {
    console.error('Character update error:', e.message);
    res.json({ error: friendlyError(e, 'Could not update the character. Please try again.') });
  }
});

// DELETE character
router.delete('/:id', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // TF-26: a character can only be deleted if it isn't woven into any session.
    // session_characters / moment_characters record the character appearing in
    // play; clearing them would silently rewrite existing sessions, so we refuse
    // the delete in that case rather than mutate the chronicle.
    const scN = await db.prepare('SELECT COUNT(*) AS n FROM session_characters WHERE character_id = ?').get(char.id);
    const mcN = await db.prepare('SELECT COUNT(*) AS n FROM moment_characters WHERE character_id = ?').get(char.id);
    if (((Number(scN && scN.n) || 0) + (Number(mcN && mcN.n) || 0)) > 0) {
      return res.status(409).json({
        error: 'This character appears in one or more sessions and cannot be deleted. Remove it from those sessions first.',
        code: 'CHARACTER_IN_SESSIONS'
      });
    }

    // Session-free (e.g. an invite-created stub): clear the only blocking binding
    // (an invite that created or targeted this character), then delete.
    // moment_characters CASCADEs and campaign_archives SET NULLs on their own.
    await db.prepare('DELETE FROM campaign_invites WHERE character_id = ?').run(char.id);
    await db.prepare('DELETE FROM characters WHERE id = ?').run(char.id);
    // Release this character's images (refcounted — a generated reference
    // still used by a session snapshot in another fork is spared).
    for (const field of ['image', 'image_portrait', 'image_fullbody', 'image_action', 'image_other', 'canonical_reference_url', 'revert_reference_url']) {
      await releaseImage(db, char[field]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('Character delete error:', e.message);
    res.status(500).json({ error: friendlyError(e, 'Could not delete the character. Please try again.') });
  }
});

// POST rebuild canonical character prompt — uses vision on uploaded images
// =====================================================================================================
// v3.0.868 -- TD-735(a). READ A CHARACTER SHEET AND FILL THE FORM.
//
// Ian, 2026-09-12: "It needs to be smart, read the file and place the appropriate info into the
// correct boxes... Then it should go ahead and generate the character reference image... All in one
// shot."
//
// THIS ROUTE IS THE ONLY NEW PIECE OF THAT SENTENCE. Everything after it already exists:
// rebuildCharPrompt(null) on the client creates the character from the form, saves the image slots,
// and calls /rebuild-prompt, which builds the canonical prompt AND generates the reference, with the
// affordability check and the free-trial character reserve already done up front. So the one shot is
// this parse, the form fill, and a call that has been shipping since v3.0.860.
//
// IT TAKES TEXT, NOT A FILE. The browser has already read the PDF, the .docx or the .txt (v3.0.865),
// so nothing is uploaded, there is no multer here, and a 40MB PDF never crosses the wire -- only the
// words that came out of it.
//
// IT DOES NOT WRITE TO THE DATABASE. It answers with fields; the client puts them in the form, where
// they are visible and editable before anything is saved. A wrong extraction costs a glance, and the
// tier and character-limit checks stay where they already are, on the create route.
//
// CHARGING, IAN'S RULE, 2026-09-12: "If the reading of the file costs me AI tokens we should pass a
// charge along to the user, 1 token floor. If it doesn't cost me then keep it free." So the Story and
// Lore imports stay free -- they make no model call at all -- and this one charges, with the rate and
// the floor in app_settings so the price can be retuned without a deploy. The floor is enforced at 1
// even when the settings are missing, because a model call that costs nothing is not a thing.
//
// AND IT CHARGES ONLY ON A PARSE THAT FOUND SOMEBODY. A rules PDF with no character in it, an empty
// answer, a model error: all free. A token burned on a shrug is the complaint you actually get.
// =====================================================================================================
var CHAR_SHEET_MAX_CHARS = 60000;

function _csClampStr(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}
// The model is asked for decimal feet; anything else it invents is dropped rather than argued with.
// parseHeightFt above is the authority on range, exactly as it is for the form and the API.
function _csHeight(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return null;
  return parseHeightFt(n);
}

router.post('/parse-sheet', requireAuth, verifyCampaignDM, async function (req, res) {
  try {
    var raw = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    var text = raw.replace(/ /g, '').trim();
    if (!text) return res.json({ error: 'EMPTY', message: 'There was no text in that file to read.' });

    var truncated = false;
    if (text.length > CHAR_SHEET_MAX_CHARS) { text = text.slice(0, CHAR_SHEET_MAX_CHARS); truncated = true; }

    var key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ error: 'AI service is not configured.' });

    // WHAT IT COSTS IS SETTLED BEFORE THE MODEL IS CALLED, so a shortage cannot leave someone having
    // spent nothing and received nothing, or vice versa.
    var charge = 0;
    try { charge = await computeGenCharge(Math.ceil(text.length / 5), 'char_sheet_words_per_token', 'char_sheet_floor'); } catch (e) { charge = 0; }
    if (!(charge >= 1)) charge = 1;
    if (!(await canAfford(req.session.userId, charge))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS',
        message: 'Reading a character sheet costs ' + charge + ' token' + (charge === 1 ? '' : 's') + '. Add more tokens to continue.' });
    }

    var system = [
      'You read a tabletop RPG character sheet, a character write-up, or a piece of prose about a',
      'character, and return the fields a Campaignia character record needs. You return JSON and',
      'nothing else -- no preamble, no code fence, no commentary.',
      '',
      'Answer with an ARRAY of objects, one per character the document is actually about:',
      '[{"name":"","player_name":"","cls":"","height_ft":null,"description":"","is_npc":false}]',
      '',
      'name          The character\'s own name. If they have a nickname or alias, write it as',
      '              "Theron Ashwood / Ash" -- one field, the full name, then a slash, then the alias.',
      'player_name   The real person who plays them, if the document says. Otherwise "".',
      'cls           Role, title, species or class, as the document puts it. "Half-elf Ranger".',
      'height_ft     Height in DECIMAL FEET as a number: 6 ft 1 in is 6.1, 5\'6" is 5.5, 180cm is 5.9.',
      '              null if the document does not say. Never guess a height from a species.',
      'description   Appearance AND personality in one piece of prose, in the document\'s own detail:',
      '              hair, skin, build, clothing, what they carry, distinctive marks, then temperament,',
      '              manner and how they speak. This is what an illustrator will draw from, so keep',
      '              concrete visual detail and drop dice, stat blocks, spell lists and equipment',
      '              weights. Do not invent detail that is not in the document.',
      'is_npc        true only if the document clearly presents them as an NPC or supporting character.',
      '',
      'RULES THAT MATTER:',
      '- Copy, do not embellish. Every fact must be traceable to the document.',
      '- Unknown fields are "" or null. An empty field is a correct answer; an invented one is not.',
      '- A party roster or a group write-up returns several objects, most prominent first.',
      '- If the document is not about a character at all -- a rulebook, an invoice, a blank form --',
      '  return []. An empty array is the right answer and is expected.'
    ].join('\n');

    var response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: TEXT_MODEL,
        max_tokens: 3000,
        system: system,
        messages: [{ role: 'user', content: text }]
      })
    });
    var data = await response.json();
    if (data.error) return res.json({ error: friendlyAnthropicError(data.error) });

    var out = (data.content || []).map(function (b) { return b.text || ''; }).join('').trim();
    var clean = out.replace(/```json|```/g, '').trim();
    var parsed = null;
    try { parsed = JSON.parse(clean); } catch (e) {
      // One salvage attempt: the first bracketed array in the answer. Beyond that it is a failure,
      // and a failure is free.
      var m = clean.match(/\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
    }
    if (!Array.isArray(parsed)) {
      return res.json({ error: 'UNREADABLE', message: 'That file could not be read as a character sheet.' });
    }

    var chars = [];
    parsed.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var name = _csClampStr(c.name, 120);
      if (!name) return;   // a character with no name is not a character we can create
      chars.push({
        name: name,
        player_name: _csClampStr(c.player_name, 120),
        cls: _csClampStr(c.cls, 120),
        height_ft: _csHeight(c.height_ft),
        description: String(c.description === undefined || c.description === null ? '' : c.description).trim().slice(0, 4000),
        is_npc: (c.is_npc === true || c.is_npc === 'true')
      });
    });

    if (!chars.length) {
      return res.json({ ok: true, characters: [], truncated: truncated, charged: 0,
                        message: 'No character could be found in that file.' });
    }

    try {
      await spendTokens(req.session.userId, charge, { source: 'character_sheet_import', event_type: 'generation_spend',
                                                     related_campaign_id: req.params.campaignId });
    } catch (e) { console.error('character_sheet_import spend failed:', e.message); }
    try {
      await recordGeneration(req.session.userId, { event_type: 'character_sheet_import', tokens_redeemed: charge,
                                                   quantity: text.length, unit: 'characters', model: TEXT_MODEL,
                                                   related_campaign_id: req.params.campaignId });
    } catch (e) {}

    return res.json({ ok: true, characters: chars, truncated: truncated, charged: charge });
  } catch (e) {
    console.error('parse-sheet error:', e && e.message);
    return res.json({ error: friendlyAnthropicError(e) });
  }
});

router.post('/:id/rebuild-prompt', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    // Phase 3 Deploy 3 — lock check. Player can't rebuild prompt once
    // any session is Ready. DM bypasses.
    if (req.campaignRole === 'player') {
      if (await isCampaignLocked(req.params.campaignId)) {
        return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
      }
    }
    const key = process.env.ANTHROPIC_API_KEY || req.body.key;
    if (!key) return res.json({ error: 'AI service is not configured.' });

    // Token gate (upfront check): building a character prompt also generates
    // a reference image, which costs tokens. Check affordability BEFORE we
    // call Anthropic or save anything, so a token shortage doesn't leave
    // the user with a half-saved prompt and no image.
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    const modelKey = await imageHelpers.getSelectedModel(db);
    const refCost = await getTokenCost(modelKey);
    if (falKey && !(await canAfford(req.session.userId, refCost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Building a character prompt generates a reference image. Add more tokens to continue.' });
    }
    const _resv = falKey ? await characterReserveStatus(req.session.userId, refCost) : { blocked: false };
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }

    // Collect any uploaded reference images (public R2 URLs) for vision input
    const imageUrls = [char.image_portrait, char.image_fullbody, char.image_action, char.image_other, char.image]
      .filter(function(u) { return u && /^https?:\/\//.test(u); });

    // Build the message content: the images first, then the instruction
    const content = [];
    imageUrls.forEach(function(url) {
      content.push({ type: 'image', source: { type: 'url', url: url } });
    });

    const textInfo =
      'Character name: ' + char.name + '\n' +
      // v3.0.746 -- TD-545. OMITTED when empty, not defaulted. 'Class/role: ' with nothing after
      // it is worse than no line at all -- it invites the model to fill the blank itself, which is
      // how a 1932 ballplayer ended up in plate armour (TD-543).
      (char.cls ? ('Class/role: ' + char.cls + '\n') : '') +
      'Player-written description: ' + (char.description || '(none)') + '\n\n' +
      (imageUrls.length
        ? 'Above are reference image(s) of this character. Study them carefully.'
        : 'No reference images were provided — work from the text description only.') +
      '\n\nWrite a single, tight CANONICAL APPEARANCE PROMPT for this character: a ' +
      'style-neutral physical description used to keep them visually consistent across ' +
      'comic panels. Lead with the most distinctive feature. Include hair, face/build, ' +
      'skin tone, signature outfit and its colors, and any notable gear or markings. ' +
      'Do NOT describe personality, backstory, pose, background, or art style — physical ' +
      'appearance only. 2-4 sentences, dense with concrete visual detail. ' +
      'Return ONLY the description text, no preamble or labels.';

    content.push({ type: 'text', text: textInfo });

    // v3.0.860 -- TD-724. THE INSTRUMENT. Ian reported a single reference image
    // looking ignored while two worked, and nothing in this route could say how many
    // it had actually sent -- so the answer was a theory rather than a fact. One
    // number per source (5b), because a total cannot say WHICH slot was empty.
    try {
      console.log('[char rebuild-prompt] char=' + char.id +
        ' images_sent=' + imageUrls.length +
        ' portrait=' + (char.image_portrait ? 1 : 0) +
        ' fullbody=' + (char.image_fullbody ? 1 : 0) +
        ' action=' + (char.image_action ? 1 : 0) +
        ' other=' + (char.image_other ? 1 : 0) +
        ' main=' + (char.image ? 1 : 0));
    } catch (e) {}

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: content }]
      })
    });

    const data = await response.json();
    if (data.error) return res.json({ error: friendlyAnthropicError(data.error) });

    const promptText = data.content.map(function(b) { return b.text || ''; }).join('').trim();
    if (!promptText) return res.json({ error: 'No description was generated.' });

    const now = new Date().toISOString();
    await db.prepare('UPDATE characters SET canonical_prompt = ?, canonical_prompt_at = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(promptText, now, now, req.session.userId, char.id);

    // Also generate a canonical REFERENCE IMAGE from the new prompt \u2014 but
    // ASYNC: queue it with our webhook and return the prompt immediately. The
    // webhook attaches the image + spends on success; the client polls for it.
    let imageJobId = null;
    try {
      const webhookUrl = imageHelpers.falWebhookUrl();
      if (falKey && webhookUrl) {
        const portrait = char.image_portrait || char.image_fullbody || char.image || null;
        const sub = await imageHelpers.submitReference(falKey, promptText, portrait, modelKey, webhookUrl);
        const ts = new Date().toISOString();
        const jobIns = await db.prepare(
          'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, refCost, char.canonical_reference_url || null, ts, ts);
        imageJobId = jobIns.lastInsertRowid;
      }
    } catch(imgErr) {
      console.error('Canonical reference image submit failed (non-fatal):', imgErr.message);
    }

    res.json({ success: true, canonical_prompt: promptText, canonical_prompt_at: now, image_job_id: imageJobId });
  } catch(e) {
    console.error('Rebuild prompt error:', e.message);
    res.json({ error: friendlyAnthropicError(e) });
  }
});

// PUT update just the canonical prompt. Same access as editing the reference
// image: the DM, or the character's owner (player blocked once a session is Ready).
router.put('/:id/canonical-prompt', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });

    const { canonical_prompt } = req.body;
    if (typeof canonical_prompt !== 'string') return res.json({ error: 'Prompt required' });

    const now = new Date().toISOString();
    await db.prepare('UPDATE characters SET canonical_prompt = ?, canonical_prompt_at = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(canonical_prompt, now, now, req.session.userId, char.id);

    res.json({ success: true, canonical_prompt: canonical_prompt, canonical_prompt_at: now });
  } catch(e) {
    res.json({ error: friendlyError(e, 'Could not save the prompt. Please try again.') });
  }
});

// POST /:id/regenerate-reference — re-roll the canonical reference IMAGE only,
// from the EXISTING canonical prompt. Does NOT rewrite the description (that's
// rebuild-prompt). DM or character owner; player blocked once a session is
// Ready. Costs one image's worth of tokens, spend-on-success.
router.post('/:id/regenerate-reference', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    if (req.campaignRole === 'player' && await isCampaignLocked(req.params.campaignId)) {
      return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
    }
    if (!char.canonical_prompt || !char.canonical_prompt.trim()) {
      return res.json({ error: 'Build the character prompt first, then you can re-roll the reference image.' });
    }
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    if (!falKey) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You’re out of tokens. Re-rolling the reference image costs tokens. Add more to continue.' });
    }
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }
    // Generate from the EXISTING prompt. A failure throws to the catch below,
    // so tokens are never spent on a failed generation.
    const portrait = char.image_portrait || char.image_fullbody || char.image || null;
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const sub = await imageHelpers.submitReference(falKey, char.canonical_prompt, portrait, modelKey, webhookUrl);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, cost, char.canonical_reference_url || null, nowTs, nowTs);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('Regenerate reference error:', e.message);
    res.json({ error: friendlyImageError(e) });
  }
});

// POST /:id/retouch-reference — in-context edit of the canonical reference
// image: keep it exactly and change ONLY the typed instruction. Reuses the
// shared retouchImage() helper with NO style prefix (the reference is
// style-neutral). DM or character owner; player blocked once Ready.
router.post('/:id/retouch-reference', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    if (req.campaignRole === 'player' && await isCampaignLocked(req.params.campaignId)) {
      return res.status(423).json({ error: 'This campaign has a Ready session — character editing is locked. Forking support coming soon.' });
    }
    if (!char.canonical_reference_url) return res.json({ error: 'There is no reference image to retouch yet.' });
    const instruction = req.body.instruction;
    if (!instruction || !String(instruction).trim()) return res.json({ error: 'Describe the change you want.' });
    const falKey = process.env.FAL_API_KEY || req.body.fal_key;
    if (!falKey) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You’re out of tokens. Add more to keep generating.' });
    }
    const _resv = await characterReserveStatus(req.session.userId, cost);
    if (_resv.blocked) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', code: 'session_reserve', message: 'You have used your character budget for the free trial. ' + _resv.reserve + ' tokens are held back so you can still create a session -- buy more tokens to keep generating characters.' });
    }
    // Empty style => no style prefix; retouchImage keeps the existing look and
    // changes only the instruction. Failure throws -> no spend.
    const prevUrl = char.canonical_reference_url;
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const sub = await imageHelpers.submitRetouch(prevUrl, String(instruction).trim(), '', falKey, webhookUrl, null, 'reference');
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, character_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), char.id, 'char_ref', 'queued', sub.model, cost, prevUrl || null, nowTs, nowTs);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('Retouch reference error:', e.message);
    res.json({ error: friendlyImageError(e) });
  }
});

// POST /:id/revert-reference -- one-deep undo of the last canonical retouch/
// regenerate: restore the retained prior reference and release the current one.
// Free (no token spend). DM or character owner; player blocked once Ready.
router.post('/:id/revert-reference', requireAuth, verifyCampaignDmOrCharacterOwner, async function(req, res) {
  try {
    const db = await getDb();
    const char = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.id, req.params.campaignId);
    if (!char) return res.status(404).json({ error: 'Character not found' });
    if (req.campaignRole === 'player' && await isCampaignLocked(req.params.campaignId)) {
      return res.status(423).json({ error: 'This campaign has a Ready session -- character editing is locked. Forking support coming soon.' });
    }
    if (!char.revert_reference_url) return res.json({ error: 'There is no previous reference image to revert to.' });
    const current = char.canonical_reference_url;
    const now = new Date().toISOString();
    await db.prepare('UPDATE characters SET canonical_reference_url = ?, revert_reference_url = NULL, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(char.revert_reference_url, now, req.session.userId, char.id);
    if (current && current !== char.revert_reference_url) await releaseImage(db, current);
    res.json({ success: true, canonical_reference_url: char.revert_reference_url });
  } catch(e) {
    console.error('Revert reference error:', e.message);
    res.json({ error: friendlyError(e, 'Could not revert the reference image. Please try again.') });
  }
});

module.exports = router;
