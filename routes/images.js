const express = require('express');
const router = express.Router();
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getTier, getEffectiveTier, tierRank, accessRank, artStyleAllowed } = require('../middleware/tiers');
const { getDb, getDmForkId } = require('../database/db');
const { releaseImage, persistToR2 } = require('../storage/storage');
const { fal } = require('@fal-ai/client');
const { getTokenCost, canAfford, spendTokens, getBalance } = require('./tokens');
const crypto = require('crypto');

// Async image generation (fal queue + webhook). PUBLIC_BASE_URL is the app's
// public origin for THIS environment (set in Railway), e.g. https://campaignia.com
// or https://chronicle-staging.up.railway.app. fal posts results back there.
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
while (PUBLIC_BASE_URL.length && PUBLIC_BASE_URL.charAt(PUBLIC_BASE_URL.length - 1) === '/') PUBLIC_BASE_URL = PUBLIC_BASE_URL.slice(0, -1);
function falWebhookUrl() { return PUBLIC_BASE_URL ? (PUBLIC_BASE_URL + '/api/images/webhook/fal') : ''; }

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

// Optional Gemini "thinking" level for Nano Banana 2 ('minimal' | 'high'),
// off by default. Set NANO_THINKING_LEVEL in the environment to A/B test it;
// later this becomes a per-campaign "Render quality" dial (Campaign Settings).
const NANO_THINKING_LEVEL = (['minimal', 'high'].indexOf(process.env.NANO_THINKING_LEVEL) !== -1) ? process.env.NANO_THINKING_LEVEL : null;

function shapeAspectRatio(shape) {
  if (shape === 'wide') return '16:9';
  if (shape === 'tall') return '2:3';
  if (shape === 'square') return '1:1';
  if (shape === 'panoramic') return '21:9';
  if (shape === 'tower') return '1:4';  // nano-banana-2 has no '2:5' aspect; '1:4' is the closest valid tall ratio (the PDF layout displays towers in a 2:5 box via object-fit:cover)
  if (shape === 'fullpage') return '3:4';
  return '4:3';
}
function shapeFluxSize(shape) {
  if (shape === 'wide') return 'landscape_16_9';
  if (shape === 'tall') return 'portrait_16_9';
  if (shape === 'square') return 'square_hd';
  if (shape === 'panoramic') return 'landscape_16_9';
  if (shape === 'tower') return 'portrait_16_9';
  if (shape === 'fullpage') return 'portrait_4_3';
  return 'landscape_4_3';
}
function shapeCompHint(shape) {
  if (shape === 'wide') return ' COMPOSITION: a wide, sweeping establishing shot - a horizontal layout whose artwork fills the frame fully edge to edge and top to bottom, using the full width for an expansive view, with NO black bars.';
  if (shape === 'tall') return ' COMPOSITION: a tall, vertical composition - strong full-height framing that emphasizes height and verticality, with the subject arranged top to bottom in the frame.';
  if (shape === 'square') return ' COMPOSITION: a square, balanced composition centered tightly on a single focal subject, with intimate framing.';
  if (shape === 'panoramic') return ' COMPOSITION: an ultra-wide panoramic shot - an extremely wide, sweeping banner, vast and expansive, the artwork filling the full width AND full height edge to edge, with NO black bars and NO letterboxing.';
  if (shape === 'tower') return ' COMPOSITION: an extremely tall, narrow vertical composition - a towering full-height column emphasizing dramatic verticality and scale from top to bottom.';
  if (shape === 'fullpage') return ' COMPOSITION: an upright, full-page composition shaped like a whole printed page - a tall page-proportioned frame with the subject composed to fill the entire upright page top to bottom.';
  return '';
}

// Every generated panel must be borderless/full-bleed so the PDF LAYOUT owns all
// framing. Appended to the prompt body and the Nano Banana system_prompt.
var NO_BORDER = ' FULL-BLEED IMAGE: the artwork must fill the entire frame edge to edge and extend all the way to all four edges, with NO border, NO frame, NO white or colored margin, NO matte, NO bare paper or padding, and NO black bars, letterbox bars, or cinematic bars on any side.';

// Traditional-media styles fade out before the edge instead of going full-bleed.
// The uncovered area is PURE WHITE so the art reads as painted straight onto a
// white book page (the PDF layout still owns any actual frame).
var FADE_WHITE = ' EDGES: render as a loose vignette where the medium thins and breaks into ragged, feathered strokes toward the edges and does NOT reach the frame \u2014 the artist did not work all the way to the edge. Everywhere the artwork does not cover (the outer edges and corners especially) must be PURE WHITE (#ffffff) \u2014 never parchment, cream, beige, gray, or any tint or texture \u2014 so it looks painted straight onto a clean white page. NO drawn border, frame, box, or line.';
var FADE_STYLES = { 'Fantasy oil painting': 1, 'Fantasy pastel': 1, 'Charcoal drawing': 1, 'Classic pen and ink': 1 };
function isFadeStyle(s){ return !!FADE_STYLES[s]; }

var IP_GUARD_IMG = ' ORIGINAL CONTENT ONLY: depict ONLY the user\'s own original characters, creatures, locations, and items as described and as shown in any reference images. Do NOT draw, imitate, or incorporate any recognizable copyrighted or trademarked character, creature, mascot, logo, costume, vehicle, or branded design from any other franchise (films, video games, comics, anime, novels, toys, or another game publisher). If a name or description resembles a famous character or property from another franchise, treat it as the user\'s OWN original creation and render an original design \u2014 NEVER that franchise\'s likeness. A thematic motif (for example a bat, spider, or star) may appear ONLY as original armor or decoration; you must NEVER add that franchise\'s identifying marks: no chest emblem, logo, insignia, or symbol associated with a known character, and never copy a known character\'s signature silhouette such as a distinctive cowl, mask, cape, ear shape, or helmet. Keep the design generic-fantasy and original \u2014 evocative is fine, iconic is not.';

function buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel) {
  var ar = shapeAspectRatio(shape);
  var flux = shapeFluxSize(shape);
  var edgeDirective = isFadeStyle(style) ? FADE_WHITE : NO_BORDER;
  var hint = shapeCompHint(shape) + edgeDirective;

  // charBlock is { text, refs } (refs may include assets) from the
  // route. Tolerate a plain string or null for safety.
  var charText = '';
  var charTextTrimmed = '';
  var assetText = '';
  var charRefs = [];
  if (charBlock && typeof charBlock === 'object') {
    charText = charBlock.text || '';
    charTextTrimmed = charBlock.textTrimmed || charText;
    assetText = charBlock.assetText || '';
    charRefs = charBlock.refs || [];
  } else if (typeof charBlock === 'string') {
    charText = charBlock;
    charTextTrimmed = charBlock;
  }

  // Pass 2 — when a panel has an EXPLICIT cast, the cast roster is the source
  // of truth for WHO appears, overriding any character names in the scene
  // prose (which the extraction AI wrote and may not match the chosen cast).
  // Sits high in the prompt so it outweighs the scene text.
  var castExplicit = !!(charBlock && typeof charBlock === 'object' && charBlock.castExplicit);
  var castNames = (charBlock && charBlock.castNames) || [];
  var rosterDirective = '';
  if (castExplicit) {
    // NPC assets are people too — fold any cast NPC assets into the roster so
    // it lists them as PRESENT rather than suppressing them (NPCs are additive).
    // Locations/items aren't people, so they're never affected by the roster.
    var npcAssetNames = charRefs.filter(function(r){ return r && r.isAsset && r.category === 'npc'; }).map(function(r){ return r.name; });
    var presentPeople = castNames.concat(npcAssetNames);
    if (presentPeople.length) {
      rosterDirective = 'CAST (AUTHORITATIVE \u2014 overrides the scene text below): the ONLY characters present in this panel are: ' +
        presentPeople.join(', ') + '. Depict exactly these people and no others. The scene text may mention other names \u2014 IGNORE anyone not in this list and do not draw them. Use the scene text only for setting, action, and mood.\n\n';
    } else {
      rosterDirective = 'CAST (AUTHORITATIVE \u2014 overrides the scene text below): this panel has NO characters. Depict the scene with no people in it, ignoring any character names mentioned in the scene text.\n\n';
    }
  }

  // Art-style handling. For Nano Banana 2 the style now rides in a dedicated
  // `system_prompt` (styleSystem) rather than the prompt body — fal documents
  // system_prompt as steering output style, a separate/higher-priority channel
  // than the content prompt (which competes with scene text + reference images).
  // Flux has no system_prompt, so it keeps the style in the prompt (styleFinal).
  const stylePrefix = getStylePrefix(style);
  const styleSystem =
    'You are a graphic-novel illustrator.' + IP_GUARD_IMG + ' Render the ENTIRE image in ONE single, ' +
    'consistent art style — every character, NPC, location, and item included, ' +
    'not just the background — so everything looks genuinely DRAWN in this ' +
    'style rather than pasted on top of it. A consistent art style means one shared ' +
    'rendering MEDIUM and technique; it does NOT mean making the characters look ' +
    'alike — each character, NPC, and creature stays a separate, distinct individual ' +
    'with their own face, hair, build, and outfit, and must NEVER be blended, ' +
    'averaged, or merged with another. If reference images are provided, treat ' +
    'them ONLY as identity and content sources (who or what each element is); do ' +
    'NOT copy their rendering style — re-render every referenced element in ' +
    'this art style.' + edgeDirective + ' The required art style is: ' + stylePrefix;
  const styleFinal = stylePrefix
    ? '\n\nFINAL STEP — UNIFY THE ART STYLE ACROSS THE ENTIRE IMAGE (every character, NPC, location, and item included, not just the background): re-render the COMPLETE panel in the following single art style, applying it to every referenced element as well as the scene, so everything looks DRAWN in this style rather than placed on top of it. ' + stylePrefix
    : '';
  const CHAR_HEADING = '\n\nCHARACTERS IN THIS PANEL (each is a separate, distinct person — do NOT blend their features together; keep each one\'s hair, face, and outfit only on that character):\n';
  const charSection = charText ? CHAR_HEADING + charText : '';
  const charSectionTrim = charTextTrimmed ? CHAR_HEADING + charTextTrimmed : '';

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
    var editPrompt =
      IP_GUARD_IMG +
      'REFERENCE IMAGES — CONTENT & IDENTITY SOURCE ONLY (HIGHEST PRIORITY): ' + refMap + ' ' +
      'Use every reference image ONLY for WHAT each element is — for characters and ' +
      'NPCs, their exact face, hair, build, distinctive features, and gear; for ' +
      'locations and items, their structure, design, and distinctive details. ' +
      'Render EACH character as a SEPARATE INDIVIDUAL; do NOT blend, average, or ' +
      'merge features between characters — each person keeps only their own ' +
      'appearance. Keep the identity and design of every referenced character, NPC, ' +
      'location, and item EXACTLY as its reference shows. The references may be ' +
      'drawn in a different art style — do NOT copy that rendering style from ANY ' +
      'reference (characters, NPCs, locations, and items alike); re-render EVERY ' +
      'referenced element in the unified art style for this image (provided as a ' +
      'separate style instruction), changing ONLY the artistic medium, NEVER what ' +
      'each element actually is.\n\n' +
      rosterDirective +
      'Draw this comic panel: ' + prompt + charSectionTrim + assetSection + hint;
    input = {
      prompt: editPrompt,
      image_urls: charRefs.map(function(r) { return r.url; }),
      num_images: 1,
      aspect_ratio: ar,
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else if (key === 'nano2') {
    // Nano Banana 2 text-to-image — no reference images for this panel.
    input = {
      prompt: IP_GUARD_IMG + rosterDirective + prompt + charSection + hint,
      num_images: 1,
      aspect_ratio: ar,
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else {
    // Flux schnell: text-to-image only — no /edit endpoint, no references.
    input = {
      prompt: IP_GUARD_IMG + rosterDirective + prompt + charSection + hint + styleFinal,
      image_size: flux,
      num_inference_steps: 4,
      num_images: 1,
      enable_safety_checker: true
    };
    // A stable per-campaign seed keeps the overall look consistent.
    if (typeof seed === 'number' && !isNaN(seed)) {
      input.seed = seed;
    }
  }

  // Nano Banana 2 only: the art style rides in system_prompt (a dedicated style
  // channel) instead of the prompt body. thinking_level is off unless the env
  // dial is set — the hook for a future "Render quality" campaign setting.
  if (key === 'nano2') {
    input.system_prompt = styleSystem;
    var _tl = (thinkingLevel === 'minimal' || thinkingLevel === 'high') ? thinkingLevel : NANO_THINKING_LEVEL;
    if (_tl) input.thinking_level = _tl;
  }

  return { model: model, input: input };
}

// Synchronous generation (still used by generate-all / retouch until they
// move to the async queue flow in a later phase).
async function generateImage(prompt, style, falKey, charBlock, seed, modelKey, shape, thinkingLevel) {
  fal.config({ credentials: falKey });
  const built = buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel);
  const result = await fal.subscribe(built.model, { input: built.input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }
  return await persistToR2(result.data.images[0].url);
}

// Async generation: submit to fal's queue with our webhook and return the fal
// request id immediately. The webhook finishes the job when fal is done, so a
// slow or queued fal can never time out the user's HTTP request.
async function submitPanelGen(prompt, style, falKey, charBlock, seed, modelKey, webhookUrl, shape, thinkingLevel) {
  fal.config({ credentials: falKey });
  const built = buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model };
}

// retouchImage: in-context edit. Feed the CURRENT panel image back in as the
// SOLE reference and tell the model to keep everything identical except the
// one requested change. Always uses Nano Banana 2 /edit (the only model that
// conditions on an input image).
async function retouchImage(currentImageUrl, instruction, style, falKey, shape) {
  fal.config({ credentials: falKey });
  const ar = shapeAspectRatio(shape);
  // A falsy style means "no style prefix" (used by the style-neutral character
  // reference retouch). Moments always pass a real style, so they're unchanged.
  const stylePrefix = style ? getStylePrefix(style) : '';
  const editPrompt = (stylePrefix ? stylePrefix + '\n\n' : '') +
    'You are editing an EXISTING comic panel, provided as Image 1. Reproduce it '+
    'EXACTLY \u2014 identical composition, characters, faces, poses, framing, '+
    'background, colors, lighting, and art style \u2014 and change ONLY the '+
    'following, leaving everything else untouched:\n\n' + instruction;
  const result = await fal.subscribe('fal-ai/nano-banana-2/edit', {
    input: {
      prompt: editPrompt,
      image_urls: [currentImageUrl],
      num_images: 1,
      aspect_ratio: ar,
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    }
  });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }
  return await persistToR2(result.data.images[0].url);
}

// Async retouch: the same in-context edit as retouchImage, submitted to fal's
// queue with our webhook so the user's request returns immediately.
async function submitRetouch(currentImageUrl, instruction, style, falKey, webhookUrl, charBlock, shape) {
  fal.config({ credentials: falKey });
  const ar = shapeAspectRatio(shape);
  const stylePrefix = style ? getStylePrefix(style) : '';
  // Reference images for the characters/assets attached to this panel, so a
  // retouch like "add the other character" has those identities to draw from.
  // Image 1 is always the current panel; references follow as Image 2+.
  var refs = (charBlock && charBlock.refs) || [];
  var imageUrls = [currentImageUrl].concat(refs.map(function (r) { return r.url; }));
  var refSection = '';
  if (refs.length) {
    var refMap = refs.map(function (r, i) {
      var n = 'Image ' + (i + 2);
      if (r.isAsset) {
        if (r.category === 'location') return n + ' is the location/setting "' + r.name + '".';
        if (r.category === 'item') return n + ' is an item called "' + r.name + '".';
        if (r.category === 'npc') return n + ' is the reference for ' + r.name + '.';
        return n + ' is a reference for "' + r.name + '".';
      }
      return n + ' is the reference for ' + r.name + '.';
    }).join(' ');
    refSection =
      '\n\nREFERENCE IMAGES (identity and content source only \u2014 Image 1 is the panel being edited): ' + refMap + ' ' +
      'These are the characters, NPCs, locations, and items that belong in this panel. ' +
      'If the change above asks to add or include a character or element that is NOT already ' +
      'visible in Image 1, ADD it using its reference for exact face, hair, build, and gear, ' +
      'placed naturally into the existing scene. Keep each as a SEPARATE individual and never ' +
      'blend or merge features. Anyone already present in Image 1 stays exactly as they are; ' +
      'do not duplicate them. Re-render any added element in the existing art style of Image 1, ' +
      'matching its medium, lighting, and color.';
  }
  const editPrompt = (stylePrefix ? stylePrefix + '\n\n' : '') +
    'You are editing an EXISTING comic panel, provided as Image 1. Keep Image 1 the same \u2014 ' +
    'same composition, framing, background, the characters already present and their faces and ' +
    'poses, colors, lighting, and art style \u2014 and apply ONLY the following change, leaving ' +
    'everything else untouched:\n\n' + instruction + refSection;
  const submitted = await fal.queue.submit('fal-ai/nano-banana-2/edit', {
    input: {
      prompt: editPrompt,
      image_urls: imageUrls,
      num_images: 1,
      aspect_ratio: ar,
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    },
    webhookUrl: webhookUrl
  });
  return { request_id: submitted.request_id, model: 'fal-ai/nano-banana-2/edit' };
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
function buildCharacterBlock(chars, panelText, panelIndex, explicitCharIds) {
  if (!chars || !chars.length) return { text: '', refs: [] };
  var text = (panelText || '').toLowerCase();
  var pIdx = (typeof panelIndex === 'number' && !isNaN(panelIndex)) ? panelIndex : 0;

  // Pass 2 — explicit cast overrides name-match. When explicitCharIds is an
  // array, a character is "present" iff its id is in the set (an empty set is
  // honored: the panel was explicitly cast with no characters).
  var present;
  if (Array.isArray(explicitCharIds)) {
    var charIdSet = {};
    explicitCharIds.forEach(function(id) { charIdSet[String(id)] = true; });
    present = chars.filter(function(c) {
      var cid = (c.character_id != null) ? c.character_id : c.id;
      return charIdSet[String(cid)];
    });
  } else {
    present = chars.filter(function(c) {
      if (!c.name) return false;
      var full = c.name.toLowerCase();
      var first = full.split(/\s+/)[0];
      return text.indexOf(full) !== -1 || (first.length > 2 && text.indexOf(first) !== -1);
    });
  }

  if (!present.length) return { text: '', refs: [] };

  var lines = [];
  var refs = [];
  var linesTrim = [];

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

    var nameLine = c.name + (c.cls ? ' (' + c.cls + ')' : '');
    var desc, refUrl;
    if (beforeChange) {
      // Pre-change panel: snapshot prompt with the change text stripped off,
      // so the character shows their OLD look.
      var base = c.snapshot_prompt || c.canonical_prompt || c.description || '';
      if (c.change_note) base = base.split('\n\nRECENT CHANGE:')[0];
      desc = base;
      refUrl = c.prior_reference_url || c.canonical_reference_url || null;
    } else {
      // At/after the change (or no change at all): amended snapshot.
      desc = (c.snapshot_prompt && c.snapshot_prompt.trim())
        ? c.snapshot_prompt
        : (c.canonical_prompt && c.canonical_prompt.trim() ? c.canonical_prompt : c.description);
      refUrl = c.snapshot_reference_url || c.canonical_reference_url || null;
    }
    var hasRef = !!(refUrl && /^https?:\/\//.test(refUrl));
    if (hasRef) refs.push({ name: c.name, url: refUrl });

    // Full block: name + class + physical description (text-only model paths).
    lines.push(desc ? (nameLine + ' — ' + desc) : nameLine);
    // Trimmed block: when a reference image is sent it OWNS the look, so drop
    // the physical description (it only invites cross-character attribute
    // bleed). Keep the description only when there is NO reference image.
    linesTrim.push((hasRef || !desc) ? nameLine : (nameLine + ' — ' + desc));
  });

  return { text: lines.join('\n'), textTrimmed: linesTrim.join('\n'), refs: refs };
}

// Maximum reference images a single panel may send to the /edit endpoint.
var MAX_PANEL_REFS = 14;

// Name-match campaign assets into a panel. Same approach as characters:
// an asset is "present" if its name appears in the panel's text.
// Returns { text, refs } — each ref carries its category so the prompt
// can describe it correctly (Piece 5).
function buildAssetBlock(assets, panelText, explicitAssetIds) {
  if (!assets || !assets.length) return { text: '', refs: [] };
  var text = (panelText || '').toLowerCase();

  // Pass 2 — explicit cast overrides name-match (an asset still needs an image).
  var present;
  if (Array.isArray(explicitAssetIds)) {
    var assetIdSet = {};
    explicitAssetIds.forEach(function(id) { assetIdSet[String(id)] = true; });
    present = assets.filter(function(a) { return a.image_url && assetIdSet[String(a.id)]; });
  } else {
    present = assets.filter(function(a) {
      if (!a.name || !a.image_url) return false;
      return text.indexOf(a.name.toLowerCase()) !== -1;
    });
  }
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
    'Watercolor painterly': 'STYLE: Beautiful loose watercolor illustration. Soft wet-on-wet washes, organic flowing color, artistic brushwork, warm earthy tones, delicate linework. Painterly and expressive, like a fantasy storybook, in the watercolor tradition of John Singer Sargent, Winslow Homer, and Andrew Wyeth.',
    'Anime manga style': 'STYLE: High quality anime illustration. Clean bold linework, vibrant flat colors, dynamic composition, expressive characters, detailed backgrounds, studio Ghibli and JRPG inspired. Cinematic anime framing.',
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework on a clean white (#ffffff) background, reminiscent of vintage fantasy book illustrations and Tolkien-era artwork. Intricate detail.',
    'Fantasy oil painting': 'STYLE: Fantasy oil painting inspired by classic sword-and-sorcery cover art and old fantasy rulebook art plates, in the tradition of Frank Frazetta, Boris Vallejo, and Charles Marion Russell. LARGE, bold, loose brushstrokes with thick visible impasto and broad palette-knife marks, where each individual stroke of paint is clearly visible. Rich, saturated oil-paint textures, dramatic lighting, bold high-contrast highlights. Heroic anatomy, powerful poses, sculpted musculature. Epic, atmospheric backgrounds with mist, firelight, or stormy skies. Deep intense colors, warm skin tones, metallic reflections. The painting fades into loose, ragged brushstrokes toward the edges and does NOT reach the frame; everywhere the paint does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a painting set straight onto a clean white page.',
    'Comic book cel-shaded': 'STYLE: EXTREME comic-book cel-shaded art in the style of Borderlands. VERY THICK, heavy black ink outlines: bold brush-inked contours around every character, prop, and shape, plus strong interior ink linework. HARD cel shading with flat blocks of light and shadow, razor-sharp shadow edges and NO smooth gradients, dramatic high-contrast lighting. Visible halftone dots and crosshatching in the shadow areas. Punchy, saturated graphic-novel colors. Heavy hand-painted marker texture with visible strokes and sketch lines. Exaggerated silhouettes, dynamic angles, expressive faces, stylized proportions. Loud, graphic, over-the-top comic-book energy.',
    'Fantasy pastel': 'STYLE: Fantasy pastel and soft-chalk art in the great pastel tradition of Edgar Degas and Mary Cassatt. BOLD, large chalk and pastel strokes with thick, visible, grainy chalk marks and broad soft-pastel sweeps, generous smudging, and the texture of chalk dragged across rough paper. Soft, blended pastel colors with gentle gradients and a dreamy, magical atmosphere. Warm light, glowing highlights, a whimsical airy feeling. Lightly stylized, ethereal, expressive characters. The chalk and pastel work fades into loose, feathered strokes toward the edges and does NOT reach the frame; everywhere the chalk does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a drawing set straight onto a clean white page.',
    'Charcoal drawing': 'STYLE: Traditional charcoal drawing on rough white paper. Rich, textured charcoal strokes with deep velvety blacks, soft smudged mid-tones, and subtle blended shading. Hand-drawn edges that feel slightly rough, with visible charcoal grain and the tooth of the paper showing through. Bold, expressive shadows with dramatic high contrast and areas of heavy shading. Minimal highlights, created by leaving the bare white paper exposed rather than adding bright tones. A traditional, tactile, sketch-based monochrome charcoal look, like an artist working with charcoal sticks and blending stumps on rough paper, in the tradition of Old Master charcoal and chalk drawings by Leonardo da Vinci and Michelangelo Buonarroti.'
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
function buildReferenceInput(descriptionText, portraitUrl, modelKey) {
  const refPrompt =
    IP_GUARD_IMG +
    'Full-body character reference portrait. Neutral standing pose, ' +
    'facing forward, plain neutral background, even soft lighting, ' +
    'comic book art style.\n\n' +
    'CHARACTER: ' + descriptionText;
  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  let model = IMAGE_MODELS[key];
  let input;
  if (key === 'nano2' && portraitUrl && /^https?:\/\//.test(portraitUrl)) {
    model = 'fal-ai/nano-banana-2/edit';
    input = { prompt: refPrompt, image_urls: [portraitUrl], num_images: 1, aspect_ratio: '3:4', output_format: 'png', safety_tolerance: '5', resolution: '1K' };
  } else if (key === 'nano2') {
    input = { prompt: refPrompt, num_images: 1, aspect_ratio: '3:4', output_format: 'png', safety_tolerance: '5', resolution: '1K' };
  } else {
    input = { prompt: refPrompt, image_size: 'portrait_4_3', num_inference_steps: 4, num_images: 1, enable_safety_checker: true };
  }
  return { model: model, input: input };
}

async function generateReferenceImage(falKey, descriptionText, portraitUrl, modelKey) {
  fal.config({ credentials: falKey });
  const built = buildReferenceInput(descriptionText, portraitUrl, modelKey);
  const result = await fal.subscribe(built.model, { input: built.input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No reference image returned from fal.ai');
  }
  return await persistToR2(result.data.images[0].url);
}

// Async character reference: submit to fal's queue with our webhook.
async function submitReference(falKey, descriptionText, portraitUrl, modelKey, webhookUrl) {
  fal.config({ credentials: falKey });
  const built = buildReferenceInput(descriptionText, portraitUrl, modelKey);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model };
}

// Edit an EXISTING reference image to apply an amendment (Stage 3 Piece 5).
// Unlike generateReferenceImage (which builds from scratch), this takes
// the current reference image and changes ONLY the amended feature —
// the approach proven in the Nano Banana 2 prototype's cut-horn test.
//   baseImageUrl = the image to edit FROM (session ref preferred)
//   changeText   = the amendment, e.g. "skin and hair turned deathly white"
//   charName     = the character's name, for the instruction
function buildEditReferenceInput(baseImageUrl, changeText, charName, modelKey) {
  const name = charName || 'the character';
  const instruction =
    'This reference image shows ' + name + '. Keep ' + name + ' as the SAME ' +
    'character \u2014 identical face, body type, species, hair, horns, distinctive ' +
    'features, outfit, colors and pose as the reference image. ' +
    'Apply ONLY this one appearance change: ' + changeText + '. ' +
    'Do not add or draw any other creatures, characters, or objects. ' +
    'Comic book art style.';
  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  if (key === 'nano2' && baseImageUrl && /^https?:\/\//.test(baseImageUrl)) {
    return { model: 'fal-ai/nano-banana-2/edit', input: { prompt: instruction, image_urls: [baseImageUrl], num_images: 1, aspect_ratio: '3:4', output_format: 'png', safety_tolerance: '5', resolution: '1K' } };
  }
  const fallbackText = changeText ? (name + ' \u2014 ' + changeText) : name;
  return buildReferenceInput(fallbackText, baseImageUrl, key);
}

async function editReferenceImage(falKey, baseImageUrl, changeText, charName, modelKey) {
  fal.config({ credentials: falKey });
  const built = buildEditReferenceInput(baseImageUrl, changeText, charName, modelKey);
  const result = await fal.subscribe(built.model, { input: built.input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No edited reference image returned from fal.ai');
  }
  if (result.data.has_nsfw_concepts && result.data.has_nsfw_concepts[0] === true) {
    throw new Error('image was flagged by the safety filter (returned blank)');
  }
  return await persistToR2(result.data.images[0].url);
}

// Async amended session reference: submit to fal's queue with our webhook.
async function submitEditReference(falKey, baseImageUrl, changeText, charName, modelKey, webhookUrl) {
  fal.config({ credentials: falKey });
  const built = buildEditReferenceInput(baseImageUrl, changeText, charName, modelKey);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model };
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
  if (!ownsThisFork) return res.status(403).json({ error: 'You can only regenerate your own version' });
  if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to regenerate.' });

  // Tier gate: block generating with an art style locked at the caller's
  // effective tier (e.g. after an SM downgrade once the style was chosen).
  if (style) {
    const effRank = accessRank(await getEffectiveTier(req.session.userId, moment.campaign_id));
    if (!artStyleAllowed(effRank, style)) {
      return res.json({ error: 'STYLE_LOCKED', message: "That art style isn't available on your current plan. Pick another, or upgrade for more styles." });
    }
  }

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
    // Pass 2 — if this panel has an explicit cast, it overrides name-match.
    let explicitCharIds = null, explicitAssetIds = null;
    if (moment.cast_explicit) {
      explicitCharIds = (await db.prepare('SELECT character_id FROM moment_characters WHERE moment_id = ?').all(moment.id)).map(function(r){ return r.character_id; });
      explicitAssetIds = (await db.prepare('SELECT asset_id FROM moment_assets WHERE moment_id = ?').all(moment.id)).map(function(r){ return r.asset_id; });
    }
    const charList = buildCharacterBlock(chars, panelText, moment.panel_order, explicitCharIds);

    // Asset library: name-match campaign assets (maps, NPCs, items) into
    // this panel. Characters fill reference slots first, then assets, cap 14.
    const assets = await db.prepare(
      'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
    ).all(campId);
    const assetList = buildAssetBlock(assets, panelText, explicitAssetIds);
    // Roster of the explicit cast's names (authoritative WHO for this panel).
    let castNames = [];
    if (moment.cast_explicit && explicitCharIds) {
      const idset = {}; explicitCharIds.forEach(function(id){ idset[String(id)] = true; });
      castNames = chars.filter(function(c){ return idset[String(c.character_id)]; }).map(function(c){ return c.name; });
    }
    const panelBlock = {
      text: charList.text, textTrimmed: charList.textTrimmed,
      assetText: assetList.text,
      refs: combineRefs(charList.refs, assetList.refs),
      castExplicit: !!moment.cast_explicit,
      castNames: castNames
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

    // Async: submit to fal's queue with our webhook, record the job, and return
    // immediately. The webhook attaches the image + spends tokens on success
    // when fal finishes — so a slow or queued fal can never time out this
    // request (it used to block on fal.subscribe and 502 at the gateway).
    const webhookUrl = falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const prevImg = (await db.prepare('SELECT image FROM moments WHERE id = ?').get(moment_id) || {}).image;
    const userThinking = ((await db.prepare('SELECT render_thinking FROM users WHERE id = ?').get(req.session.userId) || {}).render_thinking) ? 'high' : null;
    const sub = await submitPanelGen(prompt, style, fal_key, panelBlock, randomSeed, modelKey, webhookUrl, moment.shape, userThinking);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, campId, moment_id, moment.fork_id, 'moment', 'queued', sub.model, style || null, cost, prevImg || null, nowTs, nowTs);
    // DM-bonus hook: stamp the player's most-recent campaign (read at Stripe
    // purchase time to credit the right DM).
    if (myRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(campId, req.session.userId); } catch (e) {}
    }
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch(e) {
    console.error('Image generation error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /api/images/retouch-moment
// In-context edit: keep the current panel image and change only what the user
// asks. Owner-only, blocked when locked, 1 token spend-on-success.
router.post('/retouch-moment', requireAuth, async function(req, res) {
  const { moment_id, instruction, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });
  if (!instruction || !String(instruction).trim()) return res.json({ error: 'Describe the change you want.' });
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.*, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
    'FROM moments m JOIN sessions s ON m.session_id = s.id JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ?'
  ).get(moment_id);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const myRole = await getCampaignRole(req.session.userId, moment.campaign_id);
  if (!myRole) return res.status(403).json({ error: 'Access denied' });
  if (String(moment.fork_owner) !== String(req.session.userId))
    return res.status(403).json({ error: 'You can only retouch your own version' });
  if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to retouch.' });
  if (!moment.image) return res.json({ error: 'This panel has no image to retouch yet.' });
  try {
    const modelKey = await getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' });
    }
    const webhookUrl = falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    // Gather the SAME references this panel was generated with — its attached
    // cast characters AND assets — so a retouch can add a character it would
    // otherwise have no reference for. Mirrors the generate-moment path.
    const campRowR = await db.prepare('SELECT campaign_id FROM sessions WHERE id = ?').get(moment.session_id);
    const campIdR = campRowR ? campRowR.campaign_id : moment.campaign_id;
    const charsR = await db.prepare(
      'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
      'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
      'sc.change_note, sc.change_moment_index, sc.change_status ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(moment.fork_id, campIdR);
    await attachPriorReferences(db, charsR, moment.session_id, campIdR);
    const panelTextR = (moment.prompt || '') + ' ' + (moment.description || '') + ' ' + (moment.title || '');
    let explicitCharIdsR = null, explicitAssetIdsR = null;
    if (moment.cast_explicit) {
      explicitCharIdsR = (await db.prepare('SELECT character_id FROM moment_characters WHERE moment_id = ?').all(moment.id)).map(function (r) { return r.character_id; });
      explicitAssetIdsR = (await db.prepare('SELECT asset_id FROM moment_assets WHERE moment_id = ?').all(moment.id)).map(function (r) { return r.asset_id; });
    }
    const charListR = buildCharacterBlock(charsR, panelTextR, moment.panel_order, explicitCharIdsR);
    const assetsR = await db.prepare('SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?').all(campIdR);
    const assetListR = buildAssetBlock(assetsR, panelTextR, explicitAssetIdsR);
    const refsR = combineRefs(charListR.refs, assetListR.refs);
    const sub = await submitRetouch(moment.image, instruction, style, fal_key, webhookUrl, { refs: refsR, text: charListR.text }, moment.shape);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, moment.campaign_id, moment.id, moment.fork_id, 'retouch', 'queued', sub.model, style || null, cost, moment.image || null, nowTs, nowTs);
    if (myRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(moment.campaign_id, req.session.userId); } catch (e) {}
    }
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('retouch error:', e.message);
    res.json({ error: e.message });
  }
});

// Build a deterministic "establishing shot" prompt for a session's title-card
// image: a wide, scene-setting view of the setting/mood, NOT a dramatic beat and
// NOT character-focused. Seeded from the session's opening narrative so it
// reflects this chapter's setting. Stored on sessions.establishing_prompt and
// thereafter editable + controllable like a panel image.
function buildEstablishingPrompt(session) {
  var src = (session.narrative_intro_summary || session.narrative_intro || session.session_notes || '').toString();
  src = src.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  var base = 'A wide, sweeping establishing shot that sets the scene for this chapter of the story: the location, environment, time of day, and overall atmosphere. This is a scene-setting title card, not a specific dramatic action moment, and it should not focus on any single character or show characters in close-up.';
  if (src) base += ' Setting and mood to depict: ' + src;
  return base;
}

// POST /api/images/generate-all
router.post('/generate-all', requireAuth, async function(req, res) {
  const { session_id, campaign_id, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });

  const db = await getDb();
  // Authorize the DM (canonical) OR a player generating their OWN version.
  const myRole = await getCampaignRole(req.session.userId, campaign_id);
  if (!myRole) return res.status(403).json({ error: 'Access denied' });
  // Tier gate: block generating with a locked art style.
  if (style) {
    const effRankAll = accessRank(await getEffectiveTier(req.session.userId, campaign_id));
    if (!artStyleAllowed(effRankAll, style)) {
      return res.json({ error: 'STYLE_LOCKED', message: "That art style isn't available on your current plan. Pick another, or upgrade for more styles." });
    }
  }
  let targetForkId;
  if (myRole === 'dm') {
    // DM always generates into the canonical (DM) fork - never a player's version.
    targetForkId = await getDmForkId(db, session_id);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ?').get(session_id, req.session.userId);
    if (!myFork) return res.status(403).json({ error: 'You have no version of this session' });
    targetForkId = myFork.id;
  }
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(targetForkId);
  if (!moments.length) return res.json({ error: 'No moments found for this session' });
  // Image locking — skip locked panels (don't regenerate, don't charge for them).
  const lockedCount = moments.filter(function(m){ return m.locked; }).length;
  const toGenerate = moments.filter(function(m){ return !m.locked; });

  // Stage 1: the session establishing image rides along with the panel batch.
  // Skipped when locked (exactly like a locked panel). Fetched here so its cost
  // is folded into the upfront token gate below.
  const sidInt = parseInt(session_id, 10);
  // Defensive: if the Stage 0 schema is not deployed yet, the establishing_*
  // columns are missing -> this SELECT throws. Swallow it so the panel batch is
  // never affected (the establishing feature simply no-ops until schema lands).
  let sessRow = {}, estColsOk = false;
  try {
    sessRow = (await db.prepare('SELECT establishing_image, establishing_prompt, establishing_locked, establishing_shape, narrative_intro, narrative_intro_summary, session_notes FROM sessions WHERE id = ?').get(sidInt)) || {};
    estColsOk = true;
  } catch (e) { console.error('establishing: session fetch failed (schema not deployed?):', e && e.message); }
  const estWillGen = estColsOk && !sessRow.establishing_locked;
  if (!toGenerate.length) {
    return res.json({ success: true, generated: [], count: 0, total: moments.length, skipped_locked: lockedCount, message: 'All panels are locked — nothing to generate. Unlock a panel to regenerate it.' });
  }

  // Load all campaign characters once; the per-panel block is built inside
  // the loop so each panel only includes the characters actually in it.
  const chars = await db.prepare(
    'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
    'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
    'sc.change_note, sc.change_moment_index, sc.change_status ' +
    'FROM characters ch ' +
    'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? ' +
    'WHERE ch.campaign_id = ?'
  ).all(targetForkId, campaign_id);
  // Stage 4: attach each changed character's prior-session reference image.
  await attachPriorReferences(db, chars, session_id, campaign_id);

  // Asset library: load campaign assets once; matched per-panel in the loop.
  const assets = await db.prepare(
    'SELECT id, name, category, image_url FROM campaign_assets WHERE campaign_id = ?'
  ).all(campaign_id);

  // Pass 2 — preload explicit casts for any panel the user cast manually
  // (cast_explicit). Panels without an explicit cast fall back to name-match.
  let castCharByMoment = {}, castAssetByMoment = {};
  {
    const mcRows = await db.prepare('SELECT mc.moment_id, mc.character_id FROM moment_characters mc JOIN moments m ON m.id = mc.moment_id WHERE m.fork_id = ?').all(targetForkId);
    mcRows.forEach(function(r){ (castCharByMoment[r.moment_id] = castCharByMoment[r.moment_id] || []).push(r.character_id); });
    const maRows = await db.prepare('SELECT ma.moment_id, ma.asset_id FROM moment_assets ma JOIN moments m ON m.id = ma.moment_id WHERE m.fork_id = ?').all(targetForkId);
    maRows.forEach(function(r){ (castAssetByMoment[r.moment_id] = castAssetByMoment[r.moment_id] || []).push(r.asset_id); });
  }

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
  const userThinkingAll = ((await db.prepare('SELECT render_thinking FROM users WHERE id = ?').get(req.session.userId) || {}).render_thinking) ? 'high' : null;
  const batchCost = perImageCost * toGenerate.length + (estWillGen ? perImageCost : 0);
  if (!(await canAfford(req.session.userId, batchCost))) {
    const bal = await getBalance(req.session.userId);
    return res.json({
      error: 'INSUFFICIENT_TOKENS',
      message: 'This batch would cost ' + batchCost + ' tokens. You have ' + bal.total + '. Generate panels individually or add more tokens.',
      needed: batchCost,
      balance: bal.total
    });
  }

  // Submit one queued fal job per panel; the webhook finishes each. Returning
  // immediately means a large batch can't time out at the gateway, and fal's
  // queue handles concurrency instead of us holding N live connections.
  const webhookUrl = falWebhookUrl();
  if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });

  const submitResults = await Promise.allSettled(
    toGenerate.map(async function(m) {
      const panelSeed = (baseSeed + sessionOffset + (m.panel_order || 0)) % 2147483647;
      const panelText = (m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '');
      const charList = buildCharacterBlock(chars, panelText, m.panel_order, m.cast_explicit ? (castCharByMoment[m.id] || []) : null);
      const assetList = buildAssetBlock(assets, panelText, m.cast_explicit ? (castAssetByMoment[m.id] || []) : null);
      let castNames = [];
      if (m.cast_explicit) {
        const idset = {}; (castCharByMoment[m.id] || []).forEach(function(id){ idset[String(id)] = true; });
        castNames = chars.filter(function(c){ return idset[String(c.character_id)]; }).map(function(c){ return c.name; });
      }
      const panelBlock = {
        text: charList.text, textTrimmed: charList.textTrimmed,
        assetText: assetList.text,
        refs: combineRefs(charList.refs, assetList.refs),
        castExplicit: !!m.cast_explicit,
        castNames: castNames
      };
      const sub = await submitPanelGen(m.prompt, style, fal_key, panelBlock, panelSeed, modelKey, webhookUrl, m.shape, userThinkingAll);
      const nowTs = new Date().toISOString();
      const jobIns = await db.prepare(
        'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(sub.request_id, req.session.userId, campaign_id, m.id, targetForkId, 'batch', 'queued', sub.model, style || null, perImageCost, m.image || null, nowTs, nowTs);
      return { moment_id: m.id, job_id: jobIns.lastInsertRowid };
    })
  );

  const jobs = [];
  let submitFailed = 0;
  for (var si = 0; si < submitResults.length; si++) {
    if (submitResults[si].status === 'fulfilled') jobs.push(submitResults[si].value);
    else { submitFailed++; console.error('generate-all submit failed:', submitResults[si].reason && submitResults[si].reason.message); }
  }

  // Stage 1: submit the session establishing image alongside the panels. Routed
  // through submitPanelGen so it inherits the same IP guard, style, and model.
  // Non-fatal: a failure here never breaks the panel batch.
  let establishingJob = null;
  if (estWillGen) {
    try {
      const estShape = sessRow.establishing_shape || 'wide';
      let estPrompt = (sessRow.establishing_prompt || '').trim();
      if (!estPrompt) {
        estPrompt = buildEstablishingPrompt(sessRow);
        try { await db.prepare('UPDATE sessions SET establishing_prompt = ? WHERE id = ?').run(estPrompt, sidInt); } catch (e) {}
      }
      const estSeed = (baseSeed + sessionOffset + 99991) % 2147483647;
      const estSub = await submitPanelGen(estPrompt, style, fal_key, null, estSeed, modelKey, webhookUrl, estShape, userThinkingAll);
      const nowTsE = new Date().toISOString();
      const estIns = await db.prepare(
        'INSERT INTO image_jobs (request_id, user_id, campaign_id, session_id, fork_id, kind, status, model, style, cost, prev_image, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(estSub.request_id, req.session.userId, campaign_id, sidInt, targetForkId, 'session_establishing', 'queued', estSub.model, style || null, perImageCost, sessRow.establishing_image || null, nowTsE, nowTsE);
      establishingJob = { session_id: sidInt, job_id: estIns.lastInsertRowid };
    } catch (e) {
      console.error('generate-all establishing submit failed (non-fatal):', e && e.message);
    }
  }

  if (myRole === 'player' && jobs.length) {
    try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(campaign_id, req.session.userId); } catch (e) {}
  }

  res.status(202).json({ status: 'queued', jobs: jobs, establishing: establishingJob, total: moments.length, to_generate: toGenerate.length, skipped_locked: lockedCount, submit_failed: submitFailed });
});

// Session establishing image -- simple (no-generation) actions: edit prompt + lock.
// DM-only. (Regenerate / Retouch / Archive are handled elsewhere.)
// POST /api/images/session-establishing/:sessionId/prompt  { prompt }
router.post('/session-establishing/:sessionId/prompt', requireAuth, async function(req, res) {
  const db = await getDb();
  const sess = await db.prepare('SELECT id, campaign_id FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  const role = await getCampaignRole(req.session.userId, sess.campaign_id);
  if (role !== 'dm') return res.status(403).json({ error: 'Only the DM can edit the title image.' });
  const prompt = (req.body && typeof req.body.prompt === 'string') ? req.body.prompt : '';
  await db.prepare('UPDATE sessions SET establishing_prompt = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(prompt, new Date().toISOString(), req.session.userId, sess.id);
  res.json({ success: true, establishing_prompt: prompt });
});

// POST /api/images/session-establishing/:sessionId/lock  (toggles establishing_locked)
router.post('/session-establishing/:sessionId/lock', requireAuth, async function(req, res) {
  const db = await getDb();
  const sess = await db.prepare('SELECT id, campaign_id, establishing_locked FROM sessions WHERE id = ?').get(req.params.sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  const role = await getCampaignRole(req.session.userId, sess.campaign_id);
  if (role !== 'dm') return res.status(403).json({ error: 'Only the DM can lock the title image.' });
  const newLocked = sess.establishing_locked ? 0 : 1;
  await db.prepare('UPDATE sessions SET establishing_locked = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .run(newLocked, new Date().toISOString(), req.session.userId, sess.id);
  res.json({ success: true, locked: newLocked });
});

// ============================================================
// ASYNC IMAGE DELIVERY — fal queue webhook + job polling
// fal POSTs here when a queued generation finishes; we persist the image,
// attach it to the moment, and spend tokens on success. Decoupled from the
// user's request so a slow/queued fal never times out at the gateway.
// ============================================================
const FAL_JWKS_URL = 'https://rest.alpha.fal.ai/.well-known/jwks.json';
let _falJwks = null, _falJwksAt = 0;
async function getFalJwks() {
  const now = Date.now();
  if (_falJwks && (now - _falJwksAt) < 24 * 60 * 60 * 1000) return _falJwks;
  const r = await fetch(FAL_JWKS_URL);
  const data = await r.json();
  _falJwks = (data && data.keys) || [];
  _falJwksAt = now;
  return _falJwks;
}
// Verify a fal webhook: ED25519 over a newline-joined request_id, user_id, timestamp, sha256hex(body).
async function verifyFalWebhook(req) {
  try {
    const reqId = req.get('x-fal-webhook-request-id');
    const userId = req.get('x-fal-webhook-user-id');
    const ts = req.get('x-fal-webhook-timestamp');
    const sigHex = req.get('x-fal-webhook-signature');
    if (!reqId || !userId || !ts || !sigHex) return false;
    const tsInt = parseInt(ts, 10);
    if (!tsInt || Math.abs(Math.floor(Date.now() / 1000) - tsInt) > 300) return false;
    const raw = (req.rawBody && req.rawBody.length) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');
    const message = Buffer.from([reqId, userId, ts, bodyHash].join(String.fromCharCode(10)), 'utf8');
    const sig = Buffer.from(sigHex, 'hex');
    const keys = await getFalJwks();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!k || !k.x) continue;
      try {
        const pub = crypto.createPublicKey({ key: { kty: k.kty || 'OKP', crv: k.crv || 'Ed25519', x: k.x }, format: 'jwk' });
        if (crypto.verify(null, message, pub, sig)) return true;
      } catch (e) { /* try the next key */ }
    }
    return false;
  } catch (e) { return false; }
}

const webhookRouter = express.Router();

// fal calls this when a queued generation finishes. Public (no session) —
// authenticity comes from the signature. Idempotent + always acks with 200.
webhookRouter.post('/webhook/fal', async function(req, res) {
  try {
    const ENFORCE = String(process.env.FAL_WEBHOOK_ENFORCE || '').toLowerCase() === 'true';
    const verified = await verifyFalWebhook(req);
    if (!verified) {
      console.warn('[fal webhook] signature NOT verified' + (ENFORCE ? ' — rejecting' : ' — processing anyway (FAL_WEBHOOK_ENFORCE is off)'));
      if (ENFORCE) return res.status(401).json({ error: 'invalid signature' });
    } else {
      console.log('[fal webhook] signature verified');
    }
    const body = req.body || {};
    const reqId = body.request_id || body.gateway_request_id || req.get('x-fal-webhook-request-id');
    if (!reqId) return res.status(200).json({ ok: true });
    const db = await getDb();
    const job = await db.prepare('SELECT * FROM image_jobs WHERE request_id = ? OR request_id = ?')
      .get(body.request_id || reqId, body.gateway_request_id || reqId);
    if (!job) { console.warn('[fal webhook] no job for request_id ' + reqId); return res.status(200).json({ ok: true }); }
    if (job.status === 'done' || job.status === 'failed') return res.status(200).json({ ok: true });
    const status = String(body.status || '').toUpperCase();
    if (status && status !== 'OK' && status !== 'COMPLETED') {
      const errMsg = (body.error && (body.error.message || JSON.stringify(body.error))) || 'generation failed';
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', String(errMsg).slice(0, 500), new Date().toISOString(), job.id);
      return res.status(200).json({ ok: true });
    }
    const payload = body.payload || body;
    const images = payload && payload.images;
    const falImg = images && images[0];
    const falUrl = falImg && falImg.url;
    // Real pixel size from fal's payload -> stored on the moment so layout can
    // size to the true aspect (kills most cropping). Null if fal omits it.
    let imgW = (falImg && Number(falImg.width)) || null;
    let imgH = (falImg && Number(falImg.height)) || null;
    // nano-banana-2 returns width/height as NULL in its webhook payload, so the real pixel
    // size is unknown. Fall back to the aspect ratio we REQUESTED for this moment's shape:
    // without it a tower's true 1:4 shape is lost and every layout collapses it to the
    // nominal 9:16 (cropping in Comic/Picture Book, letterboxing in Magazine). The stored
    // numbers are synthetic ratio markers (shape ratio * 256), used only for aspect math.
    if ((!imgW || !imgH) && job.moment_id) {
      try {
        const mShapeRow = await db.prepare('SELECT shape FROM moments WHERE id = ?').get(job.moment_id);
        const arParts = String(shapeAspectRatio((mShapeRow && mShapeRow.shape) || '')).split(':');
        const arW = Number(arParts[0]), arH = Number(arParts[1]);
        if (arW > 0 && arH > 0) { imgW = Math.round(arW * 256); imgH = Math.round(arH * 256); }
      } catch (e) { /* leave dims null -> renderer uses the nominal shape aspect */ }
    }
    // Same dims fallback for the session establishing image (nano-banana returns
    // null width/height): fall back to the requested establishing shape's aspect.
    if ((!imgW || !imgH) && job.session_id && job.kind === 'session_establishing') {
      try {
        const sShapeRow = await db.prepare('SELECT establishing_shape FROM sessions WHERE id = ?').get(job.session_id);
        const arPartsE = String(shapeAspectRatio((sShapeRow && sShapeRow.establishing_shape) || 'wide')).split(':');
        const arWe = Number(arPartsE[0]), arHe = Number(arPartsE[1]);
        if (arWe > 0 && arHe > 0) { imgW = Math.round(arWe * 256); imgH = Math.round(arHe * 256); }
      } catch (e) { /* leave dims null */ }
    }
    if (!falUrl) {
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', 'no image in webhook payload', new Date().toISOString(), job.id);
      return res.status(200).json({ ok: true });
    }
    if (payload.has_nsfw_concepts && payload.has_nsfw_concepts[0] === true) {
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', 'image was flagged by the safety filter (returned blank)', new Date().toISOString(), job.id);
      return res.status(200).json({ ok: true });
    }
    // Atomic claim: only the first delivery flips queued -> processing.
    const claim = await db.prepare("UPDATE image_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(new Date().toISOString(), job.id);
    if (!claim || claim.changes === 0) return res.status(200).json({ ok: true });
    try {
      const imageUrl = await persistToR2(falUrl);
      if (job.moment_id && (job.kind === 'moment' || job.kind === 'batch' || job.kind === 'retouch')) {
        const now = new Date().toISOString();
        if (job.kind === 'retouch') {
          await db.prepare('UPDATE moments SET image = ?, img_w = ?, img_h = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, imgW, imgH, now, job.user_id, job.moment_id);
        } else {
          await db.prepare('UPDATE moments SET image = ?, style = ?, img_w = ?, img_h = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, job.style || null, imgW, imgH, now, job.user_id, job.moment_id);
        }
        if (job.prev_image && job.prev_image !== imageUrl) await releaseImage(db, job.prev_image);
        await logImageGeneration(db, job.user_id, job.kind === 'retouch' ? 'retouch' : 'moment', job.moment_id, job.fork_id);
      }
        if (job.kind === 'char_ref' && job.character_id) {
          await db.prepare('UPDATE characters SET canonical_reference_url = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, new Date().toISOString(), job.user_id, job.character_id);
          if (job.prev_image && job.prev_image !== imageUrl) await releaseImage(db, job.prev_image);
          await logImageGeneration(db, job.user_id, 'character_reference', job.character_id);
        }
        if (job.kind === 'session_ref' && job.character_id) {
          await logImageGeneration(db, job.user_id, 'session_reference', job.character_id, job.fork_id);
        }
        if (job.kind === 'session_establishing' && job.session_id) {
          await db.prepare('UPDATE sessions SET establishing_image = ?, establishing_style = ?, establishing_img_w = ?, establishing_img_h = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, job.style || null, imgW, imgH, new Date().toISOString(), job.user_id, job.session_id);
          if (job.prev_image && job.prev_image !== imageUrl) await releaseImage(db, job.prev_image);
          await logImageGeneration(db, job.user_id, 'session_establishing', job.session_id, job.fork_id);
        }
      if (job.cost && job.cost > 0) {
        const spendSource = (job.kind === 'char_ref') ? 'character_reference'
          : (job.kind === 'session_ref') ? 'amendment_reference'
          : (job.kind === 'session_establishing') ? 'session_establishing'
          : (job.kind === 'retouch') ? 'panel_retouch'
          : (job.kind === 'batch') ? 'panel_batch' : 'panel_regen';
        await spendTokens(job.user_id, job.cost, { related_campaign_id: job.campaign_id, source: spendSource, event_type: 'generation_spend' });
      }
      await db.prepare('UPDATE image_jobs SET status = ?, image_url = ?, updated_at = ? WHERE id = ?')
        .run('done', imageUrl, new Date().toISOString(), job.id);
    } catch (e) {
      console.error('[fal webhook] processing error:', e.message);
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', String(e.message).slice(0, 500), new Date().toISOString(), job.id);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[fal webhook] handler error:', e.message);
    return res.status(200).json({ ok: true });
  }
});

// The browser polls this for its own job until status is done/failed.
// Batch poll: the browser asks for many job statuses at once (generate-all).
webhookRouter.get('/jobs-status', requireAuth, async function(req, res) {
  try {
    const ids = String(req.query.ids || '').split(',').map(function(x){ return parseInt(x, 10); }).filter(function(n){ return n > 0; }).slice(0, 200);
    if (!ids.length) return res.json({ jobs: [] });
    const db = await getDb();
    const ph = ids.map(function(){ return '?'; }).join(',');
    const rows = await db.prepare('SELECT id, status, image_url, error, moment_id FROM image_jobs WHERE id IN (' + ph + ') AND user_id = ?').all(ids.concat([req.session.userId]));
    res.json({ jobs: rows.map(function(j){ return { id: j.id, status: j.status, image_url: j.image_url || null, error: j.error || null, moment_id: j.moment_id }; }) });
  } catch (e) { res.json({ error: e.message }); }
});

webhookRouter.get('/jobs/:id', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const job = await db.prepare('SELECT id, status, image_url, error, moment_id FROM image_jobs WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.session.userId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ status: job.status, image_url: job.image_url || null, error: job.error || null, moment_id: job.moment_id });
  } catch (e) { res.json({ error: e.message }); }
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
module.exports.retouchImage = retouchImage;
module.exports.webhookRouter = webhookRouter;
module.exports.falWebhookUrl = falWebhookUrl;
module.exports.submitReference = submitReference;
module.exports.submitEditReference = submitEditReference;
module.exports.submitRetouch = submitRetouch;
