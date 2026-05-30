const express = require('express');
const router = express.Router();
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getTier } = require('../middleware/tiers');
const { getDb, getDmForkId } = require('../database/db');
const { fal } = require('@fal-ai/client');
const { getTokenCost, canAfford, spendTokens, getBalance } = require('./tokens');

// ============================================================
// PROVIDER ABSTRACTION LAYER
// generateImage builds the correct API call for whichever model
// is selected (the two models need different call shapes).
// ============================================================

// The image models the app can switch between. Add new entries here.
// 'nano2' is the default (production). Each call shape differs, so each
// model gets its own input builder. nano2 uses the /edit endpoint when
// a panel has character/asset references (Lever 3) and the plain
// text-to-image endpoint when it doesn't.
const IMAGE_MODELS = {
  schnell: 'fal-ai/flux/schnell',
  nano2: 'fal-ai/nano-banana-2'
};

// Read the currently-selected model key from app_settings.
// Falls back to 'nano2' if unset or on any error (the production model).
async function getSelectedModel(db) {
  try {
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'image_model'").get();
    const key = row && row.value ? row.value : 'nano2';
    return IMAGE_MODELS[key] ? key : 'nano2';
  } catch (e) {
    return 'nano2';
  }
}

async function generateImage(prompt, style, falKey, charBlock, seed, modelKey) {
  fal.config({ credentials: falKey });

  // charBlock is { text, refs } (refs may include assets) from the
  // route. Tolerate a plain string or null for safety.
  var charText = '';
  var assetText = '';
  var charRefs = [];
  if (charBlock && typeof charBlock === 'object') {
    charText = charBlock.text || '';
    assetText = charBlock.assetText || '';
    charRefs = charBlock.refs || [];
  } else if (typeof charBlock === 'string') {
    charText = charBlock;
  }

  // Style goes FIRST so the model treats it as the primary instruction
  const stylePrefix = getStylePrefix(style);
  const charSection = charText
    ? '\n\nCHARACTERS IN THIS PANEL (each is a separate, distinct person — do NOT blend their features together; keep each one\'s hair, face, and outfit only on that character):\n' + charText
    : '';

  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  let input;
  let model = IMAGE_MODELS[key];

  if (key === 'nano2' && charRefs.length) {
    // Nano Banana 2 /edit — condition the panel on each present
    // character's reference image. Map each image to its character by
    // position so the model knows which reference is who (fal's
    // recommended technique for multi-subject scenes).
    //
    // PROMPT ORDERING NOTE: the reference-image block sits HIGH in the
    // prompt (right after the style prefix, BEFORE the scene description)
    // because models weight earlier instructions more heavily. On busy
    // panels with magical effects + many characters, putting the
    // reference instruction last meant it competed with all that visual
    // language for attention — and lost. Putting it first establishes
    // "match these references" as the dominant rule before the scene
    // complexity is introduced.
    model = 'fal-ai/nano-banana-2/edit';
    var refMap = charRefs.map(function(r, i) {
      var n = 'Image ' + (i + 1);
      if (r.isAsset) {
        if (r.category === 'location') return n + ' is the location/setting "' + r.name + '".';
        if (r.category === 'item') return n + ' is an item called "' + r.name + '".';
        if (r.category === 'npc') return n + ' is the reference for ' + r.name + '.';
        return n + ' is a reference for "' + r.name + '".';
      }
      return n + ' is the reference for ' + r.name + '.';
    }).join(' ');
    var assetSection = assetText
      ? '\n\nSCENE ASSETS (match these to their reference images): ' + assetText
      : '';
    var editPrompt = stylePrefix + '\n\n' +
      'REFERENCE IMAGES (HIGHEST PRIORITY): ' + refMap + ' ' +
      'Render EACH character as a SEPARATE INDIVIDUAL whose face, hair, ' +
      'build, and distinctive features EXACTLY match their own reference ' +
      'image. Do NOT blend, average, or merge features between characters ' +
      '— each person keeps only their own appearance. Match any location ' +
      'or item to its reference image too.\n\n' +
      'Draw this comic panel: ' + prompt + charSection + assetSection;
    input = {
      prompt: editPrompt,
      image_urls: charRefs.map(function(r) { return r.url; }),
      num_images: 1,
      aspect_ratio: '4:3',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else if (key === 'nano2') {
    // Nano Banana 2 text-to-image — no reference images for this panel.
    input = {
      prompt: stylePrefix + '\n\n' + prompt + charSection,
      num_images: 1,
      aspect_ratio: '4:3',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else {
    // Flux schnell: text-to-image only — no /edit endpoint, no references.
    input = {
      prompt: stylePrefix + '\n\n' + prompt + charSection,
      image_size: 'landscape_4_3',
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true
    };
    // A stable per-campaign seed keeps the overall look consistent.
    if (typeof seed === 'number' && !isNaN(seed)) {
      input.seed = seed;
    }
  }

  const result = await fal.subscribe(model, { input: input });

  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }

  return result.data.images[0].url;
}

// Deterministic seed from a campaign id — same campaign, same seed every time.
function campaignSeed(campaignId) {
  var n = parseInt(campaignId, 10);
  if (isNaN(n)) return 12345;
  // Spread the id across the seed space so small ids aren't all clustered.
  return ((n * 2654435761) % 2147483647 + 2147483647) % 2147483647;
}

// Build a character block containing ONLY the characters actually present
// in this panel. Sending the full roster to every panel causes the image
// model to merge features between characters ("concept bleed"), so we
// detect presence from the panel text and include just those characters.
// Stage 4: for each character that has an ACCEPTED mid-session change,
// look up the prior session's reference image. Pre-change panels use it
// so the character shows their OLD look before the change moment.
// Mutates each char row, adding `prior_reference_url`.
async function attachPriorReferences(db, chars, sessionId, campaignId) {
  try {
    var sess = await db.prepare('SELECT session_date FROM sessions WHERE id = ?').get(sessionId);
    if (!sess) return;
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      // Only relevant if this character has an accepted change this session.
      if (c.change_status !== 'accepted') continue;
      var prior = await db.prepare(
        'SELECT sc.reference_url FROM session_characters sc ' +
        'JOIN sessions s ON sc.session_id = s.id ' +
        'WHERE sc.character_id = ? AND s.campaign_id = ? AND s.session_date < ? ' +
        'AND sc.reference_url IS NOT NULL ' +
        'ORDER BY s.session_date DESC LIMIT 1'
      ).get(c.character_id, campaignId, sess.session_date);
      c.prior_reference_url = (prior && prior.reference_url) ? prior.reference_url : null;
    }
  } catch (e) {
    console.error('attachPriorReferences error (non-fatal):', e.message);
  }
}

// Returns { text, refs } for the characters present in a panel.
//   text = the per-character description block (amended snapshot preferred)
//   refs = [{ name, url }] reference images for present characters
// panelIndex (0-based) drives Stage 4 mid-session precision: a character
// with an accepted change at change_moment_index shows their OLD look
// (prior text + prior reference) for panels BEFORE that index, and the
// amended look from that index onward.
function buildCharacterBlock(chars, panelText, panelIndex) {
  if (!chars || !chars.length) return { text: '', refs: [] };
  var text = (panelText || '').toLowerCase();
  var pIdx = (typeof panelIndex === 'number' && !isNaN(panelIndex)) ? panelIndex : 0;

  var present = chars.filter(function(c) {
    if (!c.name) return false;
    var full = c.name.toLowerCase();
    var first = full.split(/\s+/)[0];
    return text.indexOf(full) !== -1 || (first.length > 2 && text.indexOf(first) !== -1);
  });

  if (!present.length) return { text: '', refs: [] };

  var lines = [];
  var refs = [];

  present.forEach(function(c) {
    // Does this character have an accepted change?
    var hasChange = (c.change_status === 'accepted');
    // The moment the change starts. A NULL/missing index means the change
    // has no mid-session precision — treat it as moment 0 (session-wide),
    // the safe Stage 3 fallback. A real number gives Stage 4 precision.
    var changeIdx = 0;
    if (hasChange && typeof c.change_moment_index === 'number' && c.change_moment_index >= 0) {
      changeIdx = c.change_moment_index;
    }
    // "Before the change" = accepted change exists AND this panel is earlier.
    var beforeChange = hasChange && (pIdx < changeIdx);

    var line = c.name;
    if (c.cls) line += ' (' + c.cls + ')';

    if (beforeChange) {
      // Pre-change panel: use the snapshot prompt with the change text
      // stripped off, so the character shows their OLD look.
      var base = c.snapshot_prompt || c.canonical_prompt || c.description || '';
      if (c.change_note) {
        // The approve route appended "\n\nRECENT CHANGE: <detail>" — remove it.
        base = base.split('\n\nRECENT CHANGE:')[0];
      }
      if (base) line += ' — ' + base;
      // Pre-change reference = the prior session's image (old look).
      var oldUrl = c.prior_reference_url || c.canonical_reference_url || null;
      if (oldUrl && /^https?:\/\//.test(oldUrl)) {
        refs.push({ name: c.name, url: oldUrl });
      }
    } else {
      // At/after the change (or no change at all): amended snapshot.
      var desc = (c.snapshot_prompt && c.snapshot_prompt.trim())
        ? c.snapshot_prompt
        : (c.canonical_prompt && c.canonical_prompt.trim() ? c.canonical_prompt : c.description);
      if (desc) line += ' — ' + desc;
      var url = c.snapshot_reference_url || c.canonical_reference_url || null;
      if (url && /^https?:\/\//.test(url)) {
        refs.push({ name: c.name, url: url });
      }
    }
    lines.push(line);
  });

  return { text: lines.join('\n'), refs: refs };
}

// Maximum reference images a single panel may send to the /edit endpoint.
var MAX_PANEL_REFS = 14;

// Name-match campaign assets into a panel. Same approach as characters:
// an asset is "present" if its name appears in the panel's text.
// Returns { text, refs } — each ref carries its category so the prompt
// can describe it correctly (Piece 5).
function buildAssetBlock(assets, panelText) {
  if (!assets || !assets.length) return { text: '', refs: [] };
  var text = (panelText || '').toLowerCase();

  var present = assets.filter(function(a) {
    if (!a.name || !a.image_url) return false;
    return text.indexOf(a.name.toLowerCase()) !== -1;
  });
  if (!present.length) return { text: '', refs: [] };

  var lines = [];
  var refs = [];
  present.forEach(function(a) {
    var cat = a.category || 'location';
    if (/^https?:\/\//.test(a.image_url)) {
      refs.push({ name: a.name, url: a.image_url, category: cat, isAsset: true });
      lines.push(a.name + ' (' + cat + ')');
    }
  });
  return { text: lines.join('\n'), refs: refs };
}

// Merge character refs and asset refs under the 14-image hard cap.
// Characters take priority — they fill slots first; assets fill the
// remainder. Never exceeds MAX_PANEL_REFS total.
function combineRefs(charRefs, assetRefs) {
  charRefs = charRefs || [];
  assetRefs = assetRefs || [];
  var combined = charRefs.slice(0, MAX_PANEL_REFS);
  var room = MAX_PANEL_REFS - combined.length;
  if (room > 0 && assetRefs.length) {
    combined = combined.concat(assetRefs.slice(0, room));
  }
  return combined;
}

function getStylePrefix(style) {
  var prefixes = {
    'High fantasy illustration': 'STYLE: Epic high fantasy illustration. Painterly, highly detailed, dramatic cinematic lighting, rich colors, in the style of fantasy concept art and book covers. Detailed backgrounds, heroic compositions.',
    'Dark gritty comic book': 'STYLE: Dark gritty comic book art. Heavy ink lines, deep shadows, high contrast black and white with selective color, noir atmosphere, Frank Miller and Mike Mignola inspired. Gritty textures, dramatic angles.',
    'Watercolor painterly': 'STYLE: Beautiful loose watercolor illustration. Soft wet-on-wet washes, organic flowing color, artistic brushwork, warm earthy tones, delicate linework. Painterly and expressive, like a fantasy storybook.',
    'Anime manga style': 'STYLE: High quality anime illustration. Clean bold linework, vibrant flat colors, dynamic composition, expressive characters, detailed backgrounds, studio Ghibli and JRPG inspired. Cinematic anime framing.',
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework, old parchment tones, reminiscent of vintage fantasy book illustrations and Tolkien-era artwork. Intricate detail.'
  };
  return prefixes[style] || prefixes['High fantasy illustration'];
}

// Log one image generation for usage counting. month_key is 'YYYY-MM'.
// source = what kind of image ('moment', 'character_reference', etc).
// refId = id of whatever it was for; interpret it using source.
// Failures here must never break image generation — wrapped in try/catch.
async function logImageGeneration(db, userId, source, refId, forkId) {
  try {
    var d = new Date();
    var monthKey = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    await db.prepare(
      'INSERT INTO image_generations (user_id, source, ref_id, fork_id, month_key, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, source || 'moment', refId || null, forkId || null, monthKey, d.toISOString());
  } catch (e) {
    console.error('logImageGeneration failed (non-fatal):', e.message);
  }
}

// Generate a clean, neutral REFERENCE image for a character — used for
// the canonical reference (Piece 2) and amendment regeneration (Piece 5).
// Built from the canonical/amended text. If the character has an uploaded
// portrait, the editing model conditions on it; otherwise it's pure
// text-to-image. Returns the image URL. Caller stores it + logs it.
async function generateReferenceImage(falKey, descriptionText, portraitUrl, modelKey) {
  fal.config({ credentials: falKey });

  // Neutral framing — a plain, consistent reference, not a scene.
  const refPrompt =
    'Full-body character reference portrait. Neutral standing pose, ' +
    'facing forward, plain neutral background, even lighting, comic book art style.\n\n' +
    'CHARACTER: ' + descriptionText;

  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  let model = IMAGE_MODELS[key];
  let input;

  if (key === 'nano2' && portraitUrl && /^https?:\/\//.test(portraitUrl)) {
    // Editing model + a real portrait to anchor identity.
    model = 'fal-ai/nano-banana-2/edit';
    input = {
      prompt: refPrompt,
      image_urls: [portraitUrl],
      num_images: 1,
      aspect_ratio: '3:4',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else if (key === 'nano2') {
    // No portrait — Nano Banana 2 text-to-image.
    input = {
      prompt: refPrompt,
      num_images: 1,
      aspect_ratio: '3:4',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else {
    // schnell text-to-image.
    input = {
      prompt: refPrompt,
      image_size: 'portrait_4_3',
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true
    };
  }

  const result = await fal.subscribe(model, { input: input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No reference image returned from fal.ai');
  }
  return result.data.images[0].url;
}

// Edit an EXISTING reference image to apply an amendment (Stage 3 Piece 5).
// Unlike generateReferenceImage (which builds from scratch), this takes
// the current reference image and changes ONLY the amended feature —
// the approach proven in the Nano Banana 2 prototype's cut-horn test.
//   baseImageUrl = the image to edit FROM (session ref preferred)
//   changeText   = the amendment, e.g. "skin and hair turned deathly white"
//   charName     = the character's name, for the instruction
async function editReferenceImage(falKey, baseImageUrl, changeText, charName, modelKey) {
  fal.config({ credentials: falKey });

  const name = charName || 'the character';
  // Instruction shape proven in the Nano Banana 2 prototype's cut-horn test,
  // tightened: the change is framed strictly as an appearance edit, and the
  // identity-preservation clause is emphatic so stray words can't redraw
  // the character as something else.
  const instruction =
    'This reference image shows ' + name + '. Keep ' + name + ' as the SAME ' +
    'character — identical face, body type, species, hair, horns, distinctive ' +
    'features, outfit, colors and pose as the reference image. ' +
    'Apply ONLY this one appearance change: ' + changeText + '. ' +
    'Do not add or draw any other creatures, characters, or objects. ' +
    'Comic book art style.';

  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';

  // Editing genuinely needs the /edit endpoint + a real base image.
  if (key === 'nano2' && baseImageUrl && /^https?:\/\//.test(baseImageUrl)) {
    const input = {
      prompt: instruction,
      image_urls: [baseImageUrl],
      num_images: 1,
      aspect_ratio: '3:4',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
    const result = await fal.subscribe('fal-ai/nano-banana-2/edit', { input: input });
    if (!result.data || !result.data.images || !result.data.images[0]) {
      throw new Error('No edited reference image returned from fal.ai');
    }
    // A flagged image comes back blanked — report it instead of saving black.
    if (result.data.has_nsfw_concepts && result.data.has_nsfw_concepts[0] === true) {
      throw new Error('image was flagged by the safety filter (returned blank)');
    }
    return result.data.images[0].url;
  }

  // Fallback: no editing model or no base image — build from text instead.
  // (generateReferenceImage handles schnell / no-portrait cases.)
  const fallbackText = changeText
    ? (name + ' — ' + changeText)
    : name;
  return await generateReferenceImage(falKey, fallbackText, baseImageUrl, key);
}

// ============================================================
// ROUTES
// ============================================================

// POST /api/images/generate-moment
router.post('/generate-moment', requireAuth, async function(req, res) {
  const { moment_id, session_id, campaign_id, prompt, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });
  if (!prompt) return res.json({ error: 'Prompt required' });

  const db = await getDb();
  // Authorize the DM (canonical) OR the player who owns this moment's fork.
  const moment = await db.prepare(
    'SELECT m.*, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
    'FROM moments m ' +
    'JOIN sessions s ON m.session_id = s.id ' +
    'JOIN session_forks sf ON sf.id = m.fork_id ' +
    'WHERE m.id = ?'
  ).get(moment_id);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const myRole = await getCampaignRole(req.session.userId, moment.campaign_id);
  if (!myRole) return res.status(403).json({ error: 'Access denied' });
  const ownsThisFork = String(moment.fork_owner) === String(req.session.userId);
  if (myRole !== 'dm' && !ownsThisFork) return res.status(403).json({ error: 'You can only regenerate your own version' });

  try {
    // Get characters for this campaign for consistency
    const campRow = await db.prepare('SELECT campaign_id FROM sessions WHERE id = ?').get(moment.session_id);
    const campId = campRow ? campRow.campaign_id : campaign_id;
    const chars = await db.prepare(
      'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
      'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
      'sc.change_note, sc.change_moment_index, sc.change_status ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(moment.fork_id, campId);
    // Stage 4: for any character with an accepted mid-session change, fetch
    // the PRIOR session's reference so pre-change panels show the old look.
    await attachPriorReferences(db, chars, moment.session_id, campId);
    // Only include characters actually named in this panel's text
    const panelText = (prompt || '') + ' ' + (moment.description || '') + ' ' + (moment.title || '');
    const charList = buildCharacterBlock(chars, panelText, moment.panel_order);

    // Asset library: name-match campaign assets (maps, NPCs, items) into
    // this panel. Characters fill reference slots first, then assets, cap 14.
    const assets = await db.prepare(
      'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
    ).all(campId);
    const assetList = buildAssetBlock(assets, panelText);
    const panelBlock = {
      text: charList.text,
      assetText: assetList.text,
      refs: combineRefs(charList.refs, assetList.refs)
    };

    // Single regenerate = user wants a different take, so use a fresh
    // random seed each time rather than the fixed campaign seed.
    const randomSeed = Math.floor(Math.random() * 2147483647);
    const modelKey = await getSelectedModel(db);

    // Token gate (spend-on-success): make sure the user can afford one
    // image before we generate. We only DEBIT after a successful result.
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' });
    }

    const imageUrl = await generateImage(prompt, style, fal_key, panelBlock, randomSeed, modelKey);
    const now = new Date().toISOString();
    await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(imageUrl, now, req.session.userId, moment_id);
    await logImageGeneration(db, req.session.userId, 'moment', moment_id, moment.fork_id);
    // Spend AFTER success — failed generations never reach here.
    await spendTokens(req.session.userId, cost, {
      related_campaign_id: campId,
      source: 'panel_regen',
      event_type: 'generation_spend'
    });
    // DM-bonus hook: stamp the player's most-recent campaign (read at
    // Stripe purchase time to credit the right DM).
    if (myRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(campId, req.session.userId); } catch (e) {}
    }
    const balance = await getBalance(req.session.userId);
    res.json({ success: true, image_url: imageUrl, moment_id: moment_id, balance: balance });
  } catch(e) {
    console.error('Image generation error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /api/images/generate-all
router.post('/generate-all', requireAuth, async function(req, res) {
  const { session_id, campaign_id, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });

  const db = await getDb();
  const session = await db.prepare(
    'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id ' +
    'JOIN campaign_members cm ON cm.campaign_id = c.id WHERE s.id = ? AND cm.user_id = ? AND cm.role = \'dm\''
  ).get(session_id, req.session.userId);

  if (!session) return res.status(403).json({ error: 'Access denied' });

  const dmForkId = await getDmForkId(db, session_id);
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(dmForkId);
  if (!moments.length) return res.json({ error: 'No moments found for this session' });

  // Load all campaign characters once; the per-panel block is built inside
  // the loop so each panel only includes the characters actually in it.
  const chars = await db.prepare(
    'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
    'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
    'sc.change_note, sc.change_moment_index, sc.change_status ' +
    'FROM characters ch ' +
    'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.session_id = ? ' +
    'WHERE ch.campaign_id = ?'
  ).all(session_id, campaign_id);
  // Stage 4: attach each changed character's prior-session reference image.
  await attachPriorReferences(db, chars, session_id, campaign_id);

  // Asset library: load campaign assets once; matched per-panel in the loop.
  const assets = await db.prepare(
    'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
  ).all(campaign_id);

  // Stable campaign base seed — every session of a campaign renders from the
  // same visual DNA, so characters stay consistent across sessions. Each panel
  // offsets from it by panel_order so panels within a session still vary.
  // (Single-panel Regenerate uses a random seed, preserving per-panel variety.)
  const baseSeed = campaignSeed(campaign_id);
  // Offset by session so two sessions don't render panel-for-panel identical,
  // while still sharing the campaign's overall visual DNA.
  const sessionOffset = (parseInt(session_id, 10) || 0) * 1000;

  // Resolve the selected image model once for the whole batch.
  const modelKey = await getSelectedModel(db);

  // Token gate (all-or-nothing for batches, per design): the user must be
  // able to afford the WHOLE batch before we start. We still only DEBIT for
  // images that actually succeed (spend-on-success), so failures aren't
  // charged — but the upfront check guarantees they can cover a full run.
  const perImageCost = await getTokenCost(modelKey);
  const batchCost = perImageCost * moments.length;
  if (!(await canAfford(req.session.userId, batchCost))) {
    const bal = await getBalance(req.session.userId);
    return res.json({
      error: 'INSUFFICIENT_TOKENS',
      message: 'This batch would cost ' + batchCost + ' tokens. You have ' + bal.total + '. Generate panels individually or add more tokens.',
      needed: batchCost,
      balance: bal.total
    });
  }

  // Generate all images in parallel
  const results = await Promise.allSettled(
    moments.map(async function(m) {
      try {
        const panelSeed = (baseSeed + sessionOffset + (m.panel_order || 0)) % 2147483647;
        // Only the characters named in THIS panel — prevents feature bleed
        const panelText = (m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '');
        const charList = buildCharacterBlock(chars, panelText, m.panel_order);
        // Name-match campaign assets into the panel; characters fill ref
        // slots first, assets fill the remainder, hard cap 14.
        const assetList = buildAssetBlock(assets, panelText);
        const panelBlock = {
          text: charList.text,
          assetText: assetList.text,
          refs: combineRefs(charList.refs, assetList.refs)
        };
        const imageUrl = await generateImage(m.prompt, style, fal_key, panelBlock, panelSeed, modelKey);
        const now = new Date().toISOString();
        await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
          .run(imageUrl, now, req.session.userId, m.id);
        return { moment_id: m.id, image_url: imageUrl, success: true };
      } catch(e) {
        console.error('Error generating image for moment', m.id, e.message);
        return { moment_id: m.id, error: e.message, success: false };
      }
    })
  );

  const generated = results.map(function(r) { return r.value || { success: false, error: r.reason }; });
  const successCount = generated.filter(function(r) { return r.success; }).length;

  // Log one usage row per successfully generated image.
  for (var i = 0; i < generated.length; i++) {
    if (generated[i] && generated[i].success) {
      await logImageGeneration(db, req.session.userId, 'moment', generated[i].moment_id);
    }
  }

  // Spend-on-success: charge only for images that actually generated.
  // Failures (NSFW false-positives, API errors) are not charged.
  let balance = null;
  if (successCount > 0) {
    await spendTokens(req.session.userId, perImageCost * successCount, {
      related_campaign_id: campaign_id,
      source: 'panel_batch',
      event_type: 'generation_spend'
    });
  }
  balance = await getBalance(req.session.userId);

  res.json({ success: true, generated: generated, count: successCount, total: moments.length, balance: balance });
});

module.exports = router;
module.exports.generateReferenceImage = generateReferenceImage;
module.exports.editReferenceImage = editReferenceImage;
module.exports.getSelectedModel = getSelectedModel;
module.exports.logImageGeneration = logImageGeneration;
// Matching logic — exported so the Review endpoint shows EXACTLY what the
// storyboard will do (one source of truth, no drift).
module.exports.buildCharacterBlock = buildCharacterBlock;
module.exports.buildAssetBlock = buildAssetBlock;
module.exports.combineRefs = combineRefs;
module.exports.attachPriorReferences = attachPriorReferences;
