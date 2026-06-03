const express = require('express');
const router = express.Router();
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getTier } = require('../middleware/tiers');
const { getDb, getDmForkId } = require('../database/db');
const { releaseImage, persistToR2 } = require('../storage/storage');
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

// Optional Gemini "thinking" level for Nano Banana 2 ('minimal' | 'high'),
// off by default. Set NANO_THINKING_LEVEL in the environment to A/B test it;
// later this becomes a per-campaign "Render quality" dial (Campaign Settings).
const NANO_THINKING_LEVEL = (['minimal', 'high'].indexOf(process.env.NANO_THINKING_LEVEL) !== -1) ? process.env.NANO_THINKING_LEVEL : null;

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
    'You are a graphic-novel illustrator. Render the ENTIRE image in ONE single, ' +
    'consistent art style — every character, NPC, location, and item included, ' +
    'not just the background — so everything looks genuinely DRAWN in this ' +
    'style rather than pasted on top of it. A consistent art style means one shared ' +
    'rendering MEDIUM and technique; it does NOT mean making the characters look ' +
    'alike — each character, NPC, and creature stays a separate, distinct individual ' +
    'with their own face, hair, build, and outfit, and must NEVER be blended, ' +
    'averaged, or merged with another. If reference images are provided, treat ' +
    'them ONLY as identity and content sources (who or what each element is); do ' +
    'NOT copy their rendering style — re-render every referenced element in ' +
    'this art style. The required art style is: ' + stylePrefix;
  const styleFinal = stylePrefix
    ? '\n\nFINAL STEP — UNIFY THE ART STYLE ACROSS THE ENTIRE IMAGE (every character, NPC, location, and item included, not just the background): re-render the COMPLETE panel in the following single art style, applying it to every referenced element as well as the scene, so everything looks DRAWN in this style rather than placed on top of it. ' + stylePrefix
    : '';
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
    var editPrompt =
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
      prompt: rosterDirective + prompt + charSection,
      num_images: 1,
      aspect_ratio: '4:3',
      output_format: 'png',
      safety_tolerance: '5',
      resolution: '1K'
    };
  } else {
    // Flux schnell: text-to-image only — no /edit endpoint, no references.
    input = {
      prompt: rosterDirective + prompt + charSection + styleFinal,
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

  // Nano Banana 2 only: the art style rides in system_prompt (a dedicated style
  // channel) instead of the prompt body. thinking_level is off unless the env
  // dial is set — the hook for a future "Render quality" campaign setting.
  if (key === 'nano2') {
    input.system_prompt = styleSystem;
    if (NANO_THINKING_LEVEL) input.thinking_level = NANO_THINKING_LEVEL;
  }

  const result = await fal.subscribe(model, { input: input });

  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }

  return await persistToR2(result.data.images[0].url);
}

// retouchImage: in-context edit. Feed the CURRENT panel image back in as the
// SOLE reference and tell the model to keep everything identical except the
// one requested change. Always uses Nano Banana 2 /edit (the only model that
// conditions on an input image).
async function retouchImage(currentImageUrl, instruction, style, falKey) {
  fal.config({ credentials: falKey });
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
      aspect_ratio: '4:3',
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
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework, old parchment tones, reminiscent of vintage fantasy book illustrations and Tolkien-era artwork. Intricate detail.',
    'Fantasy oil painting': 'STYLE: Fantasy oil painting inspired by classic sword-and-sorcery cover art and old fantasy rulebook art plates, in the tradition of Frank Frazetta, Boris Vallejo, and Charles Marion Russell. LARGE, bold, loose brushstrokes with thick visible impasto and broad palette-knife marks, where each individual stroke of paint is clearly visible. Rich, saturated oil-paint textures, dramatic lighting, bold high-contrast highlights. Heroic anatomy, powerful poses, sculpted musculature. Epic, atmospheric backgrounds with mist, firelight, or stormy skies. Deep intense colors, warm skin tones, metallic reflections. UNFRAMED vignette composition: the painting is fully rendered on only ONE or TWO edges and dissolves into bare, unpainted parchment on the remaining edges, with loose ragged fading borders and NO rectangular frame, like an illustration printed in the margin of a fantasy rulebook page.',
    'Comic book cel-shaded': 'STYLE: EXTREME comic-book cel-shaded art in the style of Borderlands. VERY THICK, heavy black ink outlines: bold brush-inked contours around every character, prop, and shape, plus strong interior ink linework. HARD cel shading with flat blocks of light and shadow, razor-sharp shadow edges and NO smooth gradients, dramatic high-contrast lighting. Visible halftone dots and crosshatching in the shadow areas. Punchy, saturated graphic-novel colors. Heavy hand-painted marker texture with visible strokes and sketch lines. Exaggerated silhouettes, dynamic angles, expressive faces, stylized proportions. Loud, graphic, over-the-top comic-book energy.',
    'Fantasy pastel': 'STYLE: Fantasy pastel and soft-chalk art in the great pastel tradition of Edgar Degas and Mary Cassatt. BOLD, large chalk and pastel strokes with thick, visible, grainy chalk marks and broad soft-pastel sweeps, generous smudging, and the texture of chalk dragged across rough paper. Soft, blended pastel colors with gentle gradients and a dreamy, magical atmosphere. Warm light, glowing highlights, a whimsical airy feeling. Lightly stylized, ethereal, expressive characters. UNFRAMED vignette composition: fully drawn on only ONE or TWO edges and dissolving into bare, untouched paper on the remaining edges, with loose feathered fading chalk borders and NO rectangular frame, like an illustration in the margin of a fantasy rulebook page.',
    'Charcoal drawing': 'STYLE: Traditional charcoal drawing on rough paper. Rich, textured charcoal strokes with deep velvety blacks, soft smudged mid-tones, and subtle blended shading. Hand-drawn edges that feel slightly rough, with visible charcoal grain and the tooth of the paper showing through. Bold, expressive shadows with dramatic high contrast and areas of heavy shading. Minimal highlights, created by leaving the bare paper exposed rather than adding bright tones. A traditional, tactile, sketch-based monochrome charcoal look, like an artist working with charcoal sticks and blending stumps on rough paper, in the tradition of Old Master charcoal and chalk drawings by Leonardo da Vinci and Michelangelo Buonarroti.'
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

  // Comic-style reference — a plain, consistent reference image, not a scene.
  // (Reverted from the short-lived "style-neutral model sheet" experiment: the
  // neutral refs looked worse and barely helped style transfer, so we keep the
  // good-looking comic reference and address per-panel style separately.)
  const refPrompt =
    'Full-body character reference portrait. Neutral standing pose, ' +
    'facing forward, plain neutral background, even soft lighting, ' +
    'comic book art style.\n\n' +
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
  return await persistToR2(result.data.images[0].url);
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
    return await persistToR2(result.data.images[0].url);
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
  if (!ownsThisFork) return res.status(403).json({ error: 'You can only regenerate your own version' });
  if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to regenerate.' });

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
      text: charList.text,
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

    const imageUrl = await generateImage(prompt, style, fal_key, panelBlock, randomSeed, modelKey);
    const now = new Date().toISOString();
    const prevImg = (await db.prepare('SELECT image FROM moments WHERE id = ?').get(moment_id) || {}).image;
    await db.prepare('UPDATE moments SET image = ?, style = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(imageUrl, style || null, now, req.session.userId, moment_id);
    if (prevImg && prevImg !== imageUrl) await releaseImage(db, prevImg);
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
    'SELECT m.id, m.image, m.locked, m.session_id, m.fork_id, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
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
    const imageUrl = await retouchImage(moment.image, instruction, style, fal_key);
    const now = new Date().toISOString();
    const prevImg = moment.image;
    await db.prepare('UPDATE moments SET image = ?, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(imageUrl, now, req.session.userId, moment.id);
    if (prevImg && prevImg !== imageUrl) await releaseImage(db, prevImg);
    await logImageGeneration(db, req.session.userId, 'retouch', moment.id, moment.fork_id);
    await spendTokens(req.session.userId, cost, {
      related_campaign_id: moment.campaign_id,
      source: 'panel_retouch',
      event_type: 'generation_spend'
    });
    if (myRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(moment.campaign_id, req.session.userId); } catch (e) {}
    }
    const balance = await getBalance(req.session.userId);
    res.json({ success: true, image_url: imageUrl, moment_id: moment.id, balance: balance });
  } catch (e) {
    console.error('retouch error:', e.message);
    res.json({ error: e.message });
  }
});

// POST /api/images/generate-all
router.post('/generate-all', requireAuth, async function(req, res) {
  const { session_id, campaign_id, style } = req.body;
  const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
  if (!fal_key) return res.json({ error: 'Image generation not configured. Please contact support.' });

  const db = await getDb();
  // Authorize the DM (canonical) OR a player generating their OWN version.
  const myRole = await getCampaignRole(req.session.userId, campaign_id);
  if (!myRole) return res.status(403).json({ error: 'Access denied' });
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
  const batchCost = perImageCost * toGenerate.length;
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
    toGenerate.map(async function(m) {
      try {
        const panelSeed = (baseSeed + sessionOffset + (m.panel_order || 0)) % 2147483647;
        // Only the characters named in THIS panel — prevents feature bleed
        const panelText = (m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '');
        const charList = buildCharacterBlock(chars, panelText, m.panel_order, m.cast_explicit ? (castCharByMoment[m.id] || []) : null);
        // Explicit cast (Pass 2) overrides name-match when set; otherwise
        // name-match campaign assets into the panel. Characters fill ref
        // slots first, assets fill the remainder, hard cap 14.
        const assetList = buildAssetBlock(assets, panelText, m.cast_explicit ? (castAssetByMoment[m.id] || []) : null);
        // Roster of the explicit cast's names (authoritative WHO for this panel).
        let castNames = [];
        if (m.cast_explicit) {
          const idset = {}; (castCharByMoment[m.id] || []).forEach(function(id){ idset[String(id)] = true; });
          castNames = chars.filter(function(c){ return idset[String(c.character_id)]; }).map(function(c){ return c.name; });
        }
        const panelBlock = {
          text: charList.text,
          assetText: assetList.text,
          refs: combineRefs(charList.refs, assetList.refs),
          castExplicit: !!m.cast_explicit,
          castNames: castNames
        };
        const imageUrl = await generateImage(m.prompt, style, fal_key, panelBlock, panelSeed, modelKey);
        const now = new Date().toISOString();
        const prevImg = m.image;
        await db.prepare('UPDATE moments SET image = ?, style = ?, edited_at = ?, edited_by = ? WHERE id = ?')
          .run(imageUrl, style || null, now, req.session.userId, m.id);
        if (prevImg && prevImg !== imageUrl) await releaseImage(db, prevImg);
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
      await logImageGeneration(db, req.session.userId, 'moment', generated[i].moment_id, targetForkId);
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
  if (myRole === 'player' && successCount > 0) {
    try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(campaign_id, req.session.userId); } catch (e) {}
  }
  balance = await getBalance(req.session.userId);

  res.json({ success: true, generated: generated, count: successCount, total: moments.length, skipped_locked: lockedCount, balance: balance });
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
