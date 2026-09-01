const express = require('express');
const genresvc = require('../services/genres');   // v3.0.488 -- stage 4, campaign prompt at GENERATION time
const router = express.Router();
const { requireAuth, getCampaignRole, requireAdmin } = require('../middleware/auth');
const { getTier, getEffectiveTier, isTruePlatinum, tierRank, accessRank, artStyleAllowed } = require('../middleware/tiers');
const { getDb, getDmForkId, resolveActingFork, requestedForkIdOf } = require('../database/db');   // v3.0.636 -- the prefs helpers left with resolveOwnBuiltTitle
const { releaseImage, persistToR2, fetchFile } = require('../storage/storage');
const imageCrop = require('../services/imageCrop');
const { cutGroundToAlpha, trimToInk, flattenOntoColour } = require('../storage/alpha');
const { resolveTitleTarget, targetFromRequest, demoteBuiltTitle } = require('../services/titleTarget');   // v3.0.636 -- TD-422   // v3.0.622 -- the title cut, now run as its own step
const { imageSize } = require('../storage/imageSize');
const { IMAGE_MODELS, IMAGE_EDIT_MODELS, RETOUCH_MODEL } = require('../config/models');
const { friendlyImageError, friendlyError } = require('../middleware/friendlyErrors');
const { fal } = require('@fal-ai/client');
const { getTokenCost, canAfford, spendTokens, getBalance, recordGeneration } = require('./tokens');
const crypto = require('crypto');
const { logDebug } = require('./debug');
// v3.0.618 -- the title reference upload. Same multer shape and the same shared guard the asset
// upload uses, so one policy covers both rather than a second set of limits to drift.
const multer = require('multer');
const { uploadFile } = require('../storage/storage');
const { imageFileFilter, guardUpload } = require('../middleware/uploadGuard');
const titleRefUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');
// v3.0.757 -- the marked overlay: the same panel with the reader's rings drawn
// on it, used by the image model as a LOCATION diagram only. Same multer shape.
const markedUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');

// Async image generation (fal queue + webhook). PUBLIC_BASE_URL is the app's
// public origin for THIS environment (set in Railway), e.g. https://campaignia.com
// or https://chronicle-staging.up.railway.app. fal posts results back there.
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
while (PUBLIC_BASE_URL.length && PUBLIC_BASE_URL.charAt(PUBLIC_BASE_URL.length - 1) === '/') PUBLIC_BASE_URL = PUBLIC_BASE_URL.slice(0, -1);
function falWebhookUrl() { return PUBLIC_BASE_URL ? (PUBLIC_BASE_URL + '/api/images/webhook/fal') : ''; }

// Fetch an image URL and read its true pixel dimensions from the header bytes. Returns
// { width, height } or null. Only the first ~64KB is needed to parse any header, but some
// CDNs ignore Range, so we cap the body defensively and measure whatever we get.
async function measureImageDims(url) {
  if (!url) return null;
  try {
    const axios = require('axios');
    const https = require('https');
    const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      httpsAgent: agent,
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      headers: { Range: 'bytes=0-65535' },
      validateStatus: function (s) { return s >= 200 && s < 400; }
    });
    return imageSize(Buffer.from(resp.data));
  } catch (e) {
    return null;
  }
}

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

// Gemini "thinking" level for Nano Banana 2 ('minimal' | 'high'), read SOLELY
// from the NANO_THINKING_LEVEL environment variable (set to 'high' on staging
// and production). TF-04 removed the per-user UI toggle, so this env var is the
// single source of truth for the feature -- unset/invalid => off.
const NANO_THINKING_LEVEL = (['minimal', 'high'].indexOf(process.env.NANO_THINKING_LEVEL) !== -1) ? process.env.NANO_THINKING_LEVEL : null;

function shapeAspectRatio(shape) {
  if (shape === 'wide') return '16:9';
  if (shape === 'tall') return '2:3';
  if (shape === 'square') return '1:1';
  if (shape === 'panoramic') return '21:9';
  if (shape === 'tower') return '1:4';  // nano-banana-2 has no '2:5' aspect; '1:4' is the closest valid tall ratio (the PDF layout displays towers in a 2:5 box via object-fit:cover)
  if (shape === 'reference') return '3:4';  // char reference retouch keeps its native 3:4 portrait
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

// v3.0.815 -- TD-634. THE COMIC VOCABULARY IS PER-STYLE, NOT GLOBAL.
// Five places used to tell nano-banana-2 it was drawing a COMIC on every single
// image, whatever style the user had actually chosen: the illustrator role in the
// system prompt, the noun in the panel prompt, that same noun in both retouch
// paths, and a capitalised DRAWN that was written to mean INTEGRATED and reads as
// LINE ART. A watercolour book was therefore asked for comics four times before
// its own style paragraph ever spoke, and the four went first.
// PROVEN ON 2026-09-01, not theorised: the same model, at the same size, with none
// of this wording, painted an image with no contour line anywhere in it. See
// CUSTOM_ART_STYLE_SPEC.md section 1.
//
// The words were never wrong -- they were in the wrong place. They belong to the
// styles that ARE comics. Ian chose the membership on 2026-09-01:
//   comic   : High fantasy illustration, Dark gritty comic book,
//             Comic book cel-shaded, Anime manga style
//   neutral : Watercolor painterly, Fantasy oil painting, Classic pen and ink,
//             Fantasy pastel, Charcoal drawing, Dark Fantasy
//
// HIGH FANTASY IS DELIBERATELY ON THE COMIC SIDE. It is the Campaignia default and
// very nearly every book in existence is drawn in it, so it keeps the v3.0.814
// wording EXACTLY. This batch must not repaint books that already shipped. All
// four comic styles assemble BYTE-IDENTICAL prompts to v3.0.814 and the apply
// script asserts exactly that against the pre-image.
//
// A CUSTOM STYLE ARRIVES AS A RAW 'STYLE:' PARAGRAPH AND MUST LAND NEUTRAL. It
// does, because it is not a key in this map. DO NOT rewrite this as a test against
// the prefixes map in getStylePrefix() -- that would put every custom style back on
// the comic side and undo the entire point of the change.
var COMIC_STYLES = { 'High fantasy illustration': 1, 'Dark gritty comic book': 1, 'Comic book cel-shaded': 1, 'Anime manga style': 1 };
function isComicStyle(s){ return !!COMIC_STYLES[s]; }
// role  -- the illustrator the model is told it is. Probably load-bearing for scene
//          staging, so it is REPLACED, never removed.
// panel -- the noun for one picture.
// unify -- the word meaning 'one medium throughout'. Accurate for a comic,
//          actively misleading for paint.
function styleVoice(style) {
  var comic = isComicStyle(style);
  return {
    role:  comic ? 'graphic-novel illustrator' : 'narrative illustrator',
    panel: comic ? 'comic panel' : 'illustrated panel',
    unify: comic ? 'DRAWN' : 'UNIFIED'
  };
}

var IP_GUARD_IMG = ' ORIGINAL CONTENT ONLY: depict ONLY the user\'s own original characters, creatures, locations, and items as described and as shown in any reference images. Do NOT draw, imitate, or incorporate any recognizable copyrighted or trademarked character, creature, mascot, logo, costume, vehicle, or branded design from any other franchise (films, video games, comics, anime, novels, toys, or another game publisher). If a name or description resembles a famous character or property from another franchise, treat it as the user\'s OWN original creation and render an original design \u2014 NEVER that franchise\'s likeness. A thematic motif (for example a bat, spider, or star) may appear ONLY as original armor or decoration; you must NEVER add that franchise\'s identifying marks: no chest emblem, logo, insignia, or symbol associated with a known character, and never copy a known character\'s signature silhouette such as a distinctive cowl, mask, cape, ear shape, or helmet. Keep the design generic-fantasy and original \u2014 evocative is fine, iconic is not.';

// Balanced composition steer for STORY PANELS ONLY (injected via the panel `hint`,
// which every panel branch appends). Fights the image model's strong 'face the
// camera / make eye contact' bias so characters engage the scene, while still
// allowing a deliberate direct-to-camera shot. Character/asset builders never use
// this, so reference-image generation stays posed.
var COMPOSITION_IMG = ' COMPOSITION AND EYELINES (IMPORTANT): stage each panel as a candid scene the reader observes from the outside, NEVER a posed photo. Characters MUST engage the action and the focal point WITHIN the frame, with their gaze, faces, and body directed at what is happening in the scene and at each other. Do NOT have characters face forward toward the viewer, look into the camera, make eye contact with the viewer, or point or gesture outward toward the lens. Show characters from three-quarter, side, or profile angles, or from behind, with eyelines that follow the action inside the frame. This is a firm default; the ONLY exception is a rare, deliberate dramatic beat that truly demands a direct-to-camera look (such as a cold villain staring down the lens or a single triumphant hero shot) -- reserve camera-facing framing for those uncommon moments only.';

// Ranged-attack framing for STORY PANELS ONLY (appended to the panel `hint`). The image model
// tends to stage every fight at melee range, so an archer, gunner, or spellcaster ends up drawn
// nose-to-nose with the target. Push ranged/projectile attacks apart across the frame. Fires off
// scene-text cues only (the extraction prose must name the ranged action); melee stays close.
var RANGED_ATTACK_IMG = ' RANGED ATTACKS: when the scene shows a character or creature making a ranged or projectile attack \u2014 bow, crossbow, thrown spear or knife, sling, firearm, or a ranged spell such as a fireball, lightning bolt, magic missile, or eldritch blast \u2014 stage the attacker and the target SEPARATED BY A CLEAR DISTANCE across the frame, with open ground, air, or terrain between them, and show the projectile, bolt, or spell effect travelling across that gap. Do NOT place a ranged attacker and their target at melee/hand-to-hand range as if trading blows, UNLESS the scene text specifically says they are in close range (a rare, deliberate case). Melee attacks (swords, claws, fists) stay close; ranged attacks read at range.';

function buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText) {
  var ar = shapeAspectRatio(shape);
  var flux = shapeFluxSize(shape);
  var _fade = (isFadeOverride === true || isFadeOverride === false) ? isFadeOverride : isFadeStyle(style);
  var edgeDirective = _fade ? FADE_WHITE : NO_BORDER;
  var hint = COMPOSITION_IMG + RANGED_ATTACK_IMG + shapeCompHint(shape) + edgeDirective;
  // v3.0.488 -- THE GENERAL CAMPAIGN PROMPT, AT GENERATION TIME.
  // It must land here and not only in extract.js, because extract writes each
  // panel prompt ONCE: a regenerate, a hand-edited prompt, or an image made before
  // the field was filled in would all miss it otherwise. Ian's own example -- put a
  // bird in every image -- fails on every one of those paths without this.
  // Appended to `hint` deliberately: all THREE prompt builders below (nano2 edit,
  // nano2 text-to-image, flux) already end with `hint`, so this is ONE injection
  // point rather than three copies of the same rule. It therefore lands AFTER
  // IP_GUARD_IMG and AFTER the reference block in every branch, which is required:
  // user free text must never outrank the copyright guard or a canonical reference.
  // RETOUCH IS DELIBERATELY EXCLUDED -- retouchImage() does not call this function.
  // A retouch means keep this image and change ONE thing; a standing instruction
  // would fight the single change being asked for. Spec section 5.3.
  var _cpTxt = genresvc.campaignPrompt(campaignPromptText);
  if (_cpTxt) hint = hint + ' CAMPAIGN STANDING INSTRUCTION (applies to every image in this campaign, but never at the expense of the rules above): ' + _cpTxt;

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
      rosterDirective = 'CAST (AUTHORITATIVE \u2014 overrides the scene text below): NONE of the campaign\u2019s named characters appear in this panel \u2014 do not draw any of them, and ignore any specific character names mentioned in the scene text. You MAY still include generic, unnamed people that the scene itself describes (background crowds, extras, a band, passers-by); if the scene describes no people, depict it empty.\n\n';
    }
  }

  // Art-style handling. For Nano Banana 2 the style now rides in a dedicated
  // `system_prompt` (styleSystem) rather than the prompt body — fal documents
  // system_prompt as steering output style, a separate/higher-priority channel
  // than the content prompt (which competes with scene text + reference images).
  // Flux has no system_prompt, so it keeps the style in the prompt (styleFinal).
  const stylePrefix = getStylePrefix(style);
  const _voice = styleVoice(style);
  const styleSystem =
    'You are a ' + _voice.role + '.' + IP_GUARD_IMG + ' Render the ENTIRE image in ONE single, ' +
    'consistent art style — every character, NPC, location, and item included, ' +
    'not just the background — so everything looks genuinely ' + _voice.unify + ' in this ' +
    'style rather than pasted on top of it. A consistent art style means one shared ' +
    'rendering MEDIUM and technique; it does NOT mean making the characters look ' +
    'alike — each character, NPC, and creature stays a separate, distinct individual ' +
    'with their own face, hair, build, and outfit, and must NEVER be blended, ' +
    'averaged, or merged with another. If reference images are provided, treat ' +
    'them ONLY as identity and content sources (who or what each element is); do ' +
    'NOT copy their rendering style — re-render every referenced element in ' +
    'this art style.' + edgeDirective + ' The required art style is: ' + stylePrefix;
  const styleFinal = stylePrefix
    ? '\n\nFINAL STEP — UNIFY THE ART STYLE ACROSS THE ENTIRE IMAGE (every character, NPC, location, and item included, not just the background): re-render the COMPLETE panel in the following single art style, applying it to every referenced element as well as the scene, so everything looks ' + _voice.unify + ' in this style rather than placed on top of it. ' + stylePrefix
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
    model = IMAGE_EDIT_MODELS.nano2;
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
      'Draw this ' + _voice.panel + ': ' + prompt + charSectionTrim + assetSection + hint;
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

  if (process.env.DEBUG_PROMPT) {
    try {
      console.log('[DEBUG_PROMPT] buildPanelInput model=' + model +
        ' castExplicit=' + castExplicit +
        ' rosterDirective=' + (rosterDirective ? JSON.stringify(rosterDirective.slice(0, 90)) : 'none'));
      console.log('[DEBUG_PROMPT] FINAL fal prompt sent:\n' + input.prompt);
    } catch (_e) {}
  }

  return { model: model, input: input };
}

// Synchronous generation (still used by generate-all / retouch until they
// move to the async queue flow in a later phase).
// v3.0.617 -- THE TRAILING OPTIONS ARGUMENT, and why it is here rather than a second function.
// The Title Builder needs exactly this call with ONE difference: the stored image must have its white
// ground cut to real alpha, because a title overlay with an opaque rectangle behind it is worse than
// no feature (TITLE_BUILDER_SPEC 5.1). Copying generateImage to change one argument would have been a
// second fal call to keep in step with buildPanelInput, the model switch and the persist -- the fault
// this project keeps paying for. Existing callers pass fewer arguments, so genOpts is undefined and
// persistToR2 is called exactly as before.
async function generateImage(prompt, style, falKey, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText, genOpts) {
  fal.config({ credentials: falKey });
  const built = buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText);
  const result = await fal.subscribe(built.model, { input: built.input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No image returned from fal.ai');
  }
  // v3.0.619 -- FORWARD THE WHOLE OBJECT. v3.0.617 named ONE field here, cutWhite, and it worked
  // because the title asked for cutWhite. v3.0.618 switched the title to cutGround and this line
  // was not touched, so the flag was silently dropped and NO CUT RAN AT ALL -- proved by decoding
  // the stored PNG, which came back colour type 2 with no alpha channel and the model own metadata
  // chunks still attached. A pass-through that names one field is a pass-through that loses the
  // next one.
  return await persistToR2(result.data.images[0].url, genOpts || {});
}

// Async generation: submit to fal's queue with our webhook and return the fal
// request id immediately. The webhook finishes the job when fal is done, so a
// slow or queued fal can never time out the user's HTTP request.
// Per-panel "Direction" set on the Review tab. It is stored on the fork's
// narrative_directions JSON under 'moment:<rank>' -- the SAME entry the
// narrative MOMENT-block steering reads -- so one direction drives both the
// prose and the image. Here we map it onto each moment by panel_order rank and
// tack it onto the image prompt at generate/regenerate time.
// v3.0.488 -- the campaign standing instruction, read once per request. Returns ''
// for a missing campaign or an empty field, so a caller can pass the result straight
// through without a guard.
async function loadCampaignPrompt(db, campaignId) {
  try {
    const row = await db.prepare('SELECT campaign_prompt FROM campaigns WHERE id = ?').get(campaignId);
    return genresvc.campaignPrompt(row && row.campaign_prompt);
  } catch (e) { return ''; }
}

async function loadMomentDirections(db, forkId) {
  let dirs = {};
  try {
    const fk = await db.prepare('SELECT narrative_directions FROM session_forks WHERE id = ?').get(forkId);
    if (fk && fk.narrative_directions) dirs = JSON.parse(fk.narrative_directions) || {};
  } catch (e) { dirs = {}; }
  const ms = await db.prepare('SELECT id FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(forkId);
  const byMomentId = {};
  ms.forEach(function(m, i) {
    const d = dirs['moment:' + i];
    if (d && String(d).trim()) byMomentId[m.id] = String(d).trim();
  });
  return byMomentId;
}
function applyMomentDirection(basePrompt, dirText) {
  if (!dirText) return basePrompt || '';
  return (basePrompt || '') + '\n\nDIRECTOR STEERING (you MUST follow this): ' + dirText;
}

async function submitPanelGen(prompt, style, falKey, charBlock, seed, modelKey, webhookUrl, shape, thinkingLevel, isFadeOverride, campaignPromptText) {
  fal.config({ credentials: falKey });
  const built = buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model, prompt: built.input.prompt, system_prompt: built.input.system_prompt || '' };
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
    'You are editing an EXISTING ' + styleVoice(style).panel + ', provided as Image 1. Reproduce it '+
    'EXACTLY \u2014 identical composition, characters, faces, poses, framing, '+
    'background, colors, lighting, and art style \u2014 and change ONLY the '+
    'following, leaving everything else untouched:\n\n' + instruction;
  const result = await fal.subscribe(IMAGE_EDIT_MODELS.nano2, {
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
async function submitRetouch(currentImageUrl, instruction, style, falKey, webhookUrl, charBlock, shape, markedUrl, onlyRefName, isTile, wholeUrl) {
  fal.config({ credentials: falKey });
  // v3.0.773 -- a tile is square, and saying so is what stops the model
  // stacking duplicates to fill an extreme aspect.
  const ar = isTile ? '1:1' : shapeAspectRatio(shape);
  const stylePrefix = style ? getStylePrefix(style) : '';
  // Reference images for the characters/assets attached to this panel, so a
  // retouch like "add the other character" has those identities to draw from.
  // Image 1 is always the current panel; references follow as Image 2+.
  var refs = (charBlock && charBlock.refs) || [];
  // v3.0.772 -- a correction narrows the payload to the ONE chosen reference.
  // Falls back to the full list if the name does not resolve, so a lookup miss
  // degrades to the old behaviour rather than to no reference at all.
  var narrowed = false;
  if (onlyRefName) {
    var _want = String(onlyRefName).trim().toLowerCase();
    var _only = refs.filter(function (r) { return r && r.name && String(r.name).trim().toLowerCase() === _want; });
    if (_only.length) { refs = [_only[0]]; narrowed = true; }
  }
  var imageUrls = [currentImageUrl].concat(refs.map(function (r) { return r.url; }));
  // v3.0.757 -- the marked overlay is a DIAGRAM, not content. It is appended
  // LAST so the Image 2..N reference numbering above it never shifts.
  var wholeSection = '';
  if (isTile && wholeUrl) {
    var wholeN = 'Image ' + (imageUrls.length + 1);
    imageUrls = imageUrls.concat([wholeUrl]);
    wholeSection = '\n\n' + wholeN + ' IS THE COMPLETE PICTURE THAT IMAGE 1 WAS CUT OUT OF. It is provided for CONTEXT ONLY and must never be edited, redrawn, copied, shrunk or included in your output. ' +
      'Find the region of ' + wholeN + ' that matches Image 1: that is where your result will be pasted back. ' +
      'Image 1 is a FRAGMENT of a larger picture, not a picture in its own right. It has no composition of its own and needs none: it does not need a subject, a focal point, a horizon, a sky, a border or a balanced arrangement, and any empty or flat area in it is a real part of the larger picture that simply continues past the edge of the crop. ' +
      'Do not add anything to fill space. Do not draw a smaller copy of the picture inside it. Do not re-compose, re-frame or re-imagine the fragment. Return the SAME fragment with only the requested change made, so that it still lines up seamlessly with ' + wholeN + ' on all four sides.';
  }
  var markSection = '';
  if (markedUrl) {
    var markN = 'Image ' + (imageUrls.length + 1);
    imageUrls = imageUrls.concat([markedUrl]);
    markSection = '\n\n' + markN + ' IS NOT CONTENT AND IS NOT PART OF THE PICTURE. It is a copy of Image 1 with coloured rings drawn on top by the person requesting this change, to show WHERE they mean. ' +
      'A RED ring marks the thing being referred to. A GREEN ring marks the destination or the target. ' +
      'Read it ONLY to work out which part of the picture the instruction is about. ' +
      'NEVER copy, trace or reproduce the rings, their colours, or any circle, outline, arrow or highlight into the output: the finished picture contains no rings of any kind. ' +
      'Edit Image 1, which is the real picture.';
  }
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
    refSection = narrowed
      ? ('\n\nREFERENCE IMAGE: exactly ONE reference picture is supplied with this request, and it is the reference for ' +
         refs[0].name + '. There is no other reference and no choice to make. The change described above applies to ' +
         refs[0].name + ' and to no one else. Use that reference picture for identity only -- face, hair, skin, build and gear -- and never copy its pose, framing, background or level of finish.')
      :
      '\n\nREFERENCE IMAGES (identity and content source only \u2014 Image 1 is the panel being edited): ' + refMap + ' ' +
      'These are the characters, NPCs, locations, and items that belong in this panel. ' +
      'If the change above asks to add or include a character or element that is NOT already ' +
      'visible in Image 1, ADD it using its reference for exact face, hair, build, and gear, ' +
      'placed naturally into the existing scene. Keep each as a SEPARATE individual and never ' +
      'blend or merge features. Anyone already present in Image 1 stays exactly as they are; ' +
      'do not duplicate them. Re-render any added element in the existing art style of Image 1, ' +
      'matching its medium, lighting, and color.';
  }
  var refFraming = (shape === 'reference');
  const editPrompt = (stylePrefix ? stylePrefix + '\n\n' : '') +
    (refFraming
      // v3.0.587 -- "a plain background" IS THE PHRASE THAT COST TD-342, and it was still here.
      // The canonical generator was fixed on 2026-08-08 by naming the colour; this path kept the
      // adjective, so a retouch could hand back a figure on a grey sweep or a floor. The staging
      // is now dictated here too, from the one shared string.
      ? 'You are editing an EXISTING single-character reference image, provided as Image 1. It shows ONE character. Keep that SAME single figure: identical face, body type, species, hair, distinctive features, outfit, colors, and pose, and change ONLY the following, leaving everything else untouched. Output exactly ONE figure: do NOT create a model sheet, turnaround, or multiple side-by-side copies, and do not add any other characters, creatures, or objects.\n\n' + CHAR_REF_STAGING
      : isTile
      ? 'You are editing a CLOSE-UP CROP cut out of a larger picture, provided as Image 1. Reproduce Image 1 EXACTLY as it is \u2014 every figure, every part of the background, the ground, the sky, the scenery, the lighting and every detail \u2014 and change ONLY what is described below. Everything you are not asked to change must come back identical. ' +
        'This crop will be pasted straight back into the larger picture in the exact place it was cut from, so it must line up: keep the same art style, medium, brushwork, line weight, texture, palette and lighting right up to all four borders, and do not move, rescale, reframe or re-compose anything. ' +
        'The background continues across the WHOLE crop, behind and around and beneath every figure, right to all four edges. NEVER leave any area flat, empty, blank, black or filled with a plain colour, and never replace the surroundings with a backdrop: the ground beneath the figures and the scenery behind them must be drawn in full, exactly as they are now. ' +
        'Apply ONLY the following change:\n\n'
      : 'You are editing an EXISTING ' + styleVoice(style).panel + ', provided as Image 1. Keep Image 1 the same \u2014 ' +
        'same composition, framing, background, the characters already present and their faces and ' +
        'poses, colors, lighting, and art style \u2014 and apply ONLY the following change, leaving ' +
        'everything else untouched. Output ONE single continuous image: do not divide the picture into panels, do not stack or repeat the composition, and do not produce more than one version of the scene.\n\n') + instruction + refSection + markSection + wholeSection;
  const submitted = await fal.queue.submit(IMAGE_EDIT_MODELS.nano2, {
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
  return { request_id: submitted.request_id, model: IMAGE_EDIT_MODELS.nano2 };
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
// v3.0.466 -- SCOPED TO THE VERSION (TD-268). The query below used to name only the CAMPAIGN:
//
//     WHERE sc.character_id = ? AND s.campaign_id = ? AND s.session_date < ?
//
// no fork, no version, no user. It scanned EVERY fork of every earlier session and took the most
// recent -- so the instant a character was changed in ONE version, that row became the "prior look"
// for every OTHER version's later sessions, the canonical included. Ian found it on Gnomes: Frumble
// is pale on the canonical and dark in Watercolor, and sessions two and three came out dark on
// BOTH. Not a display fault -- the generator really did use the wrong reference.
//
// Correct when a session had one fork. Third time today that a backward-looking query outlived the
// uniqueness assumption it was written under (TD-194, TD-252, this).
//
// The rule now matches everything else in the feature: the most recent earlier session IN THIS
// VERSION, else the canonical's. forkId is passed by every caller; without it this falls back to
// the canonical rather than guessing across versions.
async function attachPriorReferences(db, chars, sessionId, campaignId, forkId) {
  try {
    var sess = await db.prepare('SELECT session_date FROM sessions WHERE id = ?').get(sessionId);
    if (!sess) return;
    var vRow = forkId ? await db.prepare('SELECT version_id FROM session_forks WHERE id = ?').get(forkId) : null;
    var versionId = vRow ? vRow.version_id : null;
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      // Only relevant if this character has an accepted change this session.
      if (c.change_status !== 'accepted') continue;
      var prior = null;
      if (versionId) {
        prior = await db.prepare(
          'SELECT sc.reference_url FROM session_characters sc ' +
          'JOIN session_forks sf ON sf.id = sc.fork_id ' +
          'JOIN sessions s ON s.id = sf.session_id ' +
          'WHERE sc.character_id = ? AND sf.version_id = ? AND s.session_date < ? ' +
          'AND sc.reference_url IS NOT NULL ' +
          'ORDER BY s.session_date DESC, sf.id DESC LIMIT 1'
        ).get(c.character_id, versionId, sess.session_date);
      }
      if (!prior) {
        // FALLTHROUGH to the canonical, the same rule the book itself uses for a session this
        // version has not branched.
        prior = await db.prepare(
          'SELECT sc.reference_url FROM session_characters sc ' +
          'JOIN session_forks sf ON sf.id = sc.fork_id ' +
          'JOIN sessions s ON s.id = sf.session_id ' +
          "WHERE sc.character_id = ? AND sf.role = 'dm' AND s.campaign_id = ? AND s.session_date < ? " +
          'AND sc.reference_url IS NOT NULL ' +
          'ORDER BY s.session_date DESC LIMIT 1'
        ).get(c.character_id, campaignId, sess.session_date);
      }
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
// A character's Name field may hold slash-separated aliases, e.g.
// "Superman / Clark Kent / Clark". The FIRST alias is canonical -- the only
// name shown to the image model and used as the cast label. ANY alias found in
// the panel prose marks the character present. The canonical keeps the original
// match behavior (full name, or first word > 2 chars) so existing single-name
// characters are unchanged; extra aliases need >= 3 chars to avoid short,
// common substrings. Mirrors the asset alias convention.
function characterTokens(name) {
  return String(name || '').split('/').map(function(t){ return t.trim(); }).filter(function(t){ return t.length > 0; });
}
function characterCanonicalName(name) {
  var t = characterTokens(name);
  return t.length ? t[0] : String(name || '').trim();
}
function characterNameMatches(name, lowerText) {
  var t = characterTokens(name);
  if (!t.length) return false;
  var canon = t[0].toLowerCase();
  var canonFirst = canon.split(/\s+/)[0];
  if (lowerText.indexOf(canon) !== -1) return true;
  if (canonFirst.length > 2 && lowerText.indexOf(canonFirst) !== -1) return true;
  for (var i = 1; i < t.length; i++) {
    var a = t[i].toLowerCase();
    if (a.length >= 3 && lowerText.indexOf(a) !== -1) return true;
  }
  return false;
}
// ===============================================================================================
// CHARACTER HEIGHT IN THE PROMPTS -- TD-345(d), v3.0.586.
//
// Ian, 2026-08-08: "I struggled keeping character heights accurate in scenes." And 2026-08-09:
// "just make sure their heights are written into the character prompts. That get copied from
// session to session."
//
// WHERE IT IS STORED: as a marked line inside `session_characters.prompt`. That row is a
// per-session SNAPSHOT and it is carried forward from the previous session's snapshot, so a height
// written into it copies session to session by the mechanism that already exists -- which is
// exactly what Ian described, and it is what makes TD-345(f) true without a schema change:
// "if a character that's tall in session 6 gets shrunk, we would be screwed."
//
// WHERE IT IS DELIVERED, AND THIS IS THE PART THAT IS NOT OBVIOUS: on the NAME LINE, not in the
// description. When a character has a reference image, buildCharacterBlock deliberately DROPS the
// description (see linesTrim below -- it "only invites cross-character attribute bleed"), and a
// reference image is the normal case. A height left in the description would therefore never reach
// the model on the very path that matters. So it is parsed out of the stored prompt and promoted
// onto the name line, which survives both the full and the trimmed forms.
//
// THE MARKER IS LOAD-BEARING and must be normalised at every write and read point -- the same rule
// the `STYLE:` token carries in the custom art styles. It lives here, once, and extract.js reads it
// through the export rather than repeating the string.
var CHAR_HEIGHT_TAG = 'HEIGHT:';
var CHAR_HEIGHT_RE = /^[ \t]*HEIGHT:[ \t]*(.+)$/mi;
// Feet as a decimal to words a model reads well. 5.5 -> "about 5 feet 6 inches tall".
// Rounded to the nearest inch: the slider is free-sliding, and "5 feet 5.97 inches" is noise.
function charHeightPhrase(ft) {
  var n = parseFloat(ft);
  if (!(n > 0)) return '';
  var inches = Math.round(n * 12);
  var f = Math.floor(inches / 12), i = inches % 12;
  if (f <= 0) return 'about ' + inches + ' inches tall';
  return 'about ' + f + (f === 1 ? ' foot' : ' feet') + (i ? ' ' + i + (i === 1 ? ' inch' : ' inches') : '') + ' tall';
}
// Strip any existing marker, then add the current one. IDEMPOTENT BY CONSTRUCTION: a prompt carried
// forward already carries a marker, and appending a second would stack them for as long as the
// campaign runs. Stripping first also means a height CHANGED today is picked up by sessions created
// from now on, while every session already snapshotted keeps the height it was built with.
function charPromptWithHeight(prompt, heightFt) {
  var base = String(prompt == null ? '' : prompt).replace(CHAR_HEIGHT_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  var phrase = charHeightPhrase(heightFt);
  if (!phrase) return base;                 // no height set: the prompt is untouched (TD-345(e))
  return (base ? base + '\n' : '') + CHAR_HEIGHT_TAG + ' ' + phrase;
}
// Split a stored prompt into the description the model should read and the height phrase, so the
// caller can put each where it belongs.
function charSplitHeight(prompt) {
  var raw = String(prompt == null ? '' : prompt);
  var m = CHAR_HEIGHT_RE.exec(raw);
  return {
    desc: raw.replace(CHAR_HEIGHT_RE, '').replace(/\n{3,}/g, '\n\n').trim(),
    height: m ? String(m[1]).trim() : ''
  };
}
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
      return characterNameMatches(c.name, text);
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

    var nameLine = characterCanonicalName(c.name) + (c.cls ? ' (' + c.cls + ')' : '');
    // v3.0.586 -- TD-345(d). The height rides the NAME LINE so it survives the trimmed form
    // below, which drops the description whenever a reference image is present.
    var _hSplit = charSplitHeight(c.snapshot_prompt || c.canonical_prompt || c.description || '');
    if (_hSplit.height) nameLine += ', ' + _hSplit.height;
    var desc, refUrl;
    if (beforeChange) {
      // Pre-change panel: snapshot prompt with the change text stripped off,
      // so the character shows their OLD look.
      var base = charSplitHeight(c.snapshot_prompt || c.canonical_prompt || c.description || '').desc;
      if (c.change_note) base = base.split('\n\nRECENT CHANGE:')[0];
      desc = base;
      refUrl = c.prior_reference_url || c.canonical_reference_url || null;
    } else {
      // At/after the change (or no change at all): amended snapshot.
      desc = charSplitHeight((c.snapshot_prompt && c.snapshot_prompt.trim())
        ? c.snapshot_prompt
        : (c.canonical_prompt && c.canonical_prompt.trim() ? c.canonical_prompt : c.description)).desc;
      refUrl = c.snapshot_reference_url || c.canonical_reference_url || null;
    }
    var hasRef = !!(refUrl && /^https?:\/\//.test(refUrl));
    if (hasRef) refs.push({ name: characterCanonicalName(c.name), url: refUrl });

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
// An asset's Name field may hold several slash-separated aliases, e.g.
// "Blackrock Keep / The Sundered Hold / the fortress". The FIRST alias is the
// canonical name -- the only one shown to the image model. ANY alias found in
// the panel prose marks the asset present. The canonical alias matches at any
// length (so existing single-name assets are unchanged); extra aliases need
// >= 3 chars to avoid matching short, common substrings.
function assetTokens(name) {
  return String(name || '').split('/').map(function(t){ return t.trim(); }).filter(function(t){ return t.length > 0; });
}
function assetCanonicalName(name) {
  var t = assetTokens(name);
  return t.length ? t[0] : String(name || '').trim();
}
function assetNameMatches(name, lowerText) {
  var t = assetTokens(name);
  for (var i = 0; i < t.length; i++) {
    var tok = t[i].toLowerCase();
    if (i === 0 || tok.length >= 3) {
      if (lowerText.indexOf(tok) !== -1) return true;
    }
  }
  return false;
}

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
      return assetNameMatches(a.name, text);
    });
  }
  if (!present.length) return { text: '', refs: [] };

  var lines = [];
  var refs = [];
  present.forEach(function(a) {
    var cat = a.category || 'location';
    if (/^https?:\/\//.test(a.image_url)) {
      var canon = assetCanonicalName(a.name);
      refs.push({ name: canon, url: a.image_url, category: cat, isAsset: true });
      lines.push(canon + ' (' + cat + ')');
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
  // A custom style is resolved at the route into its STYLE: paragraph and
  // passed through here as-is; presets map by display name.
  if (typeof style === 'string' && /^STYLE:/i.test(style)) return style;
  var prefixes = {
    'High fantasy illustration': 'STYLE: Epic high fantasy illustration. Painterly, highly detailed, dramatic cinematic lighting, rich colors, in the style of fantasy concept art and book covers. Detailed backgrounds, heroic compositions.',
    'Dark gritty comic book': 'STYLE: Dark gritty comic book art. Heavy ink lines, deep shadows, high contrast black and white with selective color, noir atmosphere, Frank Miller and Mike Mignola inspired. Gritty textures, dramatic angles.',
    'Watercolor painterly': 'STYLE: Beautiful loose watercolor illustration. Soft wet-on-wet washes, organic flowing color, artistic brushwork, warm earthy tones, delicate linework. Painterly and expressive, like a fantasy storybook, in the watercolor tradition of John Singer Sargent, Winslow Homer, and Andrew Wyeth.',
    'Anime manga style': 'STYLE: High quality anime illustration. Clean bold linework, vibrant flat colors, dynamic composition, expressive characters, detailed backgrounds, studio Ghibli and JRPG inspired. Cinematic anime framing.',
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework on a clean white (#ffffff) background, reminiscent of vintage fantasy book illustrations and Tolkien-era artwork. Intricate detail.',
    'Fantasy oil painting': 'STYLE: Fantasy oil painting inspired by classic sword-and-sorcery cover art and old fantasy rulebook art plates, in the tradition of Frank Frazetta, Boris Vallejo, and Charles Marion Russell. LARGE, bold, loose brushstrokes with thick visible impasto and broad palette-knife marks, where each individual stroke of paint is clearly visible. Rich, saturated oil-paint textures, dramatic lighting, bold high-contrast highlights. Heroic anatomy, powerful poses, sculpted musculature. Epic, atmospheric backgrounds with mist, firelight, or stormy skies. Deep intense colors, warm skin tones, metallic reflections. The painting fades into loose, ragged brushstrokes toward the edges and does NOT reach the frame; everywhere the paint does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a painting set straight onto a clean white page.',
    'Comic book cel-shaded': 'STYLE: EXTREME comic-book cel-shaded art in the style of Borderlands. VERY THICK, heavy black ink outlines: bold brush-inked contours around every character, prop, and shape, plus strong interior ink linework. HARD cel shading with flat blocks of light and shadow, razor-sharp shadow edges and NO smooth gradients, dramatic high-contrast lighting. Visible halftone dots and crosshatching in the shadow areas. Punchy, saturated graphic-novel colors. Heavy hand-painted marker texture with visible strokes and sketch lines. Exaggerated silhouettes, dynamic angles, expressive faces, stylized proportions. Loud, graphic, over-the-top comic-book energy.',
    'Fantasy pastel': 'STYLE: Fantasy pastel and soft-chalk art in the great pastel tradition of Edgar Degas and Mary Cassatt. BOLD, large chalk and pastel strokes with thick, visible, grainy chalk marks and broad soft-pastel sweeps, generous smudging, and the texture of chalk dragged across rough paper. Soft, blended pastel colors with gentle gradients and a dreamy, magical atmosphere. Warm light, glowing highlights, a whimsical airy feeling. Lightly stylized, ethereal, expressive characters. The chalk and pastel work fades into loose, feathered strokes toward the edges and does NOT reach the frame; everywhere the chalk does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a drawing set straight onto a clean white page.',
    'Charcoal drawing': 'STYLE: Traditional charcoal drawing on rough white paper. Rich, textured charcoal strokes with deep velvety blacks, soft smudged mid-tones, and subtle blended shading. Hand-drawn edges that feel slightly rough, with visible charcoal grain and the tooth of the paper showing through. Bold, expressive shadows with dramatic high contrast and areas of heavy shading. Minimal highlights, created by leaving the bare white paper exposed rather than adding bright tones. A traditional, tactile, sketch-based monochrome charcoal look, like an artist working with charcoal sticks and blending stumps on rough paper, in the tradition of Old Master charcoal and chalk drawings by Leonardo da Vinci and Michelangelo Buonarroti.',
    // v3.0.815 -- TD-642. Approved by Ian on 2026-09-01 from a ONE-PASS
    // analysis of a wolf-rider reference ("Very Usable!"); shipped exactly as
    // tested. is_fade NO -- this one runs full bleed. KNOWN CONSTRAINT: it
    // needs a single warm source in gloom, so taverns, caves and night camps
    // suit it and a bright afternoon meadow fights it (TD-641). KNOWN AND
    // UNTESTED: dropping the word "oils" and cooling the palette is the
    // round-2 edit -- the reference has no canvas weave and this does.
    'Dark Fantasy': 'STYLE: Paint in dense, opaque dark-fantasy oils, keeping the whole image low-key with deep near-black shadow occupying most of the value range and a single warm amber light source leaving everything else in gloom. Render every surface to a fine, dry-brushed, almost etched precision \u2014 individual hairs of fur, bark grain, worn and pitted metal, ragged torn cloth. Use an extremely limited near-monochrome palette of charcoal, soot black, cold grey and warm brown, with amber-gold the only true colour anywhere. Build every form from paint and tonal value alone: no ink outlines, no contour lines, no linework, no sketch showing through, and let smoke and atmospheric haze thicken and soften the far distance.'
  };
  return prefixes[style] || prefixes['High fantasy illustration'];
}

// Resolve a style id for generation. Custom styles arrive as 'custom:<rowId>'.
// Access (v2.2 campaign-sharing): a custom style is usable by its OWNER in any
// campaign they're in, OR by a MEMBER of a campaign whose SM (the 'dm' member)
// owns it -- members may render with the SM's styles to contribute to the
// canonical story, but never with a peer member's styles.
// Tier (lapse): usable only while the OWNING party is currently true Platinum
// (own use: the owner; member use: the SM). A recognized + accessible but lapsed
// style returns { locked:true } so the caller can surface STYLE_LOCKED. A
// foreign/unknown id still falls back silently to the base style (defensive:
// that should only ever arrive from a tampered client).
async function resolveGenStyle(db, style, userId, campaignId) {
  if (typeof style === 'string' && style.indexOf('custom:') === 0) {
    const rowId = parseInt(style.slice(7), 10);
    if (rowId) {
      try {
        const row = await db.prepare('SELECT id, owner_id, name, style_prompt, is_fade FROM custom_art_styles WHERE id = ?').get(rowId);
        if (row && row.style_prompt) {
          let allowed = (String(row.owner_id) === String(userId));
          if (!allowed && campaignId) {
            // Member use: the style's owner must be THIS campaign's SM (dm), and
            // the caller must be a member of the campaign.
            const myRole = await getCampaignRole(userId, campaignId);
            if (myRole) {
              const dm = await db.prepare("SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'dm'").get(campaignId);
              if (dm && String(dm.user_id) === String(row.owner_id)) allowed = true;
            }
          }
          if (allowed) {
            // Lapse gate: the OWNING party must currently be true Platinum.
            const ownerTier = await getEffectiveTier(row.owner_id, null);
            if (ownerTier !== 'platinum') return { locked: true };
            var _sp = /^STYLE:/i.test(row.style_prompt) ? row.style_prompt : ('STYLE: ' + row.style_prompt);
            return { styleForGen: _sp, isFade: !!row.is_fade, name: row.name || null };
          }
        }
      } catch (e) { console.error('custom style resolve error:', e.message); }
    }
    return { styleForGen: 'High fantasy illustration', isFade: null };
  }
  return { styleForGen: style, isFade: null };
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
// v3.0.587 -- THE STAGING IS ONE STRING, USED BY EVERY PATH THAT PRODUCES A CHARACTER REFERENCE.
// It was written once, inline, for the canonical generator (TD-342) -- and the other two paths never
// got it. The Session Characters page has a Regenerate button AND a Retouch button, and both write
// a reference image that the Company page composites:
//   buildEditReferenceInput  said nothing about staging at all;
//   submitRetouch            said "ONE character on a plain background" -- and "plain" is the exact
//                            loose word TD-342 identified as the cause of grey studio sweeps, warm
//                            backdrops, and worst of all A FLOOR.
// So a character regenerated from that page came back standing on a ground, and no amount of alpha
// cutting downstream can rescue that -- the floor is part of the drawing.
// Ian, 2026-08-09: "if a user hits the regenerate button on the Session Character page... it should
// still build the character using the new transparent format."
// ONE STRING, THREE CALLERS. Three copies of a staging spec is three chances for the next one to
// drift -- which is exactly what happened here, at the scale of a whole feature.
var CHAR_REF_STAGING =
    'STAGING - follow exactly:\n' +
    '- Background must be PURE WHITE (#FFFFFF), completely empty, edge to edge.\n' +
    '- NO floor, NO ground, NO stage, NO horizon line, NO cast shadow on the ground, ' +
    'NO scenery, NO props, NO texture, NO gradient, NO vignette.\n' +
    '- The character is cut out against white, as if on a blank page.\n' +
    '- Show the ENTIRE body from the top of the head to the soles of both feet.\n' +
    // v3.0.562 -- ASK FOR THE MARGIN, DO NOT FORBID IT. v3.0.559 demanded feet flush to the bottom
    // edge; the model left 4.8 percent of white beneath them anyway, and Ian was right that flush
    // would look CROPPED on the character card where the image is seen on its own.
    // A PROPORTION, NOT A PIXEL COUNT. The model does not reason reliably in pixels but composes
    // well, and one twentieth is almost exactly what it produced unprompted -- so this asks for the
    // thing it already does rather than for a thing it ignores.
    // IT DOES NOT NEED TO BE EXACT. The Company page assumes this margin and the contact shadow is a
    // soft ellipse the boots overlap, so a percent or two of variance disappears into the shadow
    // instead of showing as a float. Deliberately no pixel-scanning of the image: a scan that is
    // right most of the time would eventually put one character through the floor, and nobody would
    // know until the book was printed.
    '- Both feet must be visible, and there must be a SMALL EVEN MARGIN of empty white below ' +
    'them -- roughly one twentieth of the image height. Do not let the feet touch the bottom edge.\n' +
    '- Do not crop any part of the character. Do not add text, labels or borders.\n\n';

function buildReferenceInput(descriptionText, portraitUrl, modelKey) {
  // v3.0.559 -- TD-342: THE STAGING IS DICTATED, NOT SUGGESTED.
  // It used to say 'plain neutral background', and 'neutral' was read loosely -- grey studio
  // sweeps, warm backdrops, and worst of all A FLOOR. Shumble came back standing on stone tiles,
  // Frumble on a grey floor. That is the root cause of BOTH open Company-page faults:
  //   TD-343 feet float above the contact shadow -- object-position:center bottom puts the bottom
  //          of the IMAGE on the stage floor, so a figure whose art includes ground sits however
  //          high the artist's ground happens to be, and the gap differs per image so no single
  //          crop constant can fix it;
  //   TD-343 the grey haze around every figure -- there is nothing to cut out cleanly against.
  // WHY THIS CAN BE DICTATED AT ALL, which is what makes it cheap. Ian: "the Canonical image only
  // appears here. It is used as a reference everywhere else." It is DISPLAYED in exactly one place,
  // the Company page; everywhere else it is an INPUT to generation, where a plain white ground is
  // if anything better because no backdrop bleeds into the scene it seeds. So there is no user
  // preference to respect here and no reason to offer one.
  // PURE WHITE, NOT 'NEUTRAL'. A named colour is checkable and cut-outable; an adjective is neither.
  // FEET ON THE BOTTOM EDGE is the other half: it is what lets the Company page place a figure on
  // the shadow by construction instead of by per-image nudging.
  const refPrompt =
    IP_GUARD_IMG +
    'Full-body character reference portrait. Neutral standing pose, facing forward, ' +
    'in a clean, neutral illustration style, even soft lighting.\n\n' +
    CHAR_REF_STAGING +
    'CHARACTER: ' + descriptionText;
  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  let model = IMAGE_MODELS[key];
  let input;
  if (key === 'nano2' && portraitUrl && /^https?:\/\//.test(portraitUrl)) {
    model = IMAGE_EDIT_MODELS.nano2;
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

// Asset reference from a text description ("from scratch"). Unlike the
// character builder above, this uses an ASSET-appropriate prompt (an item,
// location, or NPC on a neutral background) rather than a full-body character
// portrait, and a square aspect. Pure text-to-image: no input reference image.
function buildAssetReferenceInput(descriptionText, category, modelKey) {
  const cat = String(category || 'location').toLowerCase();
  const catWord = (cat === 'item') ? 'item or object' : (cat === 'npc') ? 'character (NPC)' : 'location or place';
  const catLabel = (cat === 'item') ? 'ITEM' : (cat === 'npc') ? 'NPC' : 'LOCATION';
  const refPrompt =
    IP_GUARD_IMG +
    'Reference image of a single ' + catWord + ', centered on a plain neutral ' +
    'background, even soft lighting, in a clean, neutral illustration style. Show only the ' + catWord +
    ' itself, with no extra characters, text, logos, or watermarks.\n\n' +
    catLabel + ': ' + descriptionText;
  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  const model = IMAGE_MODELS[key];
  let input;
  if (key === 'nano2') {
    input = { prompt: refPrompt, num_images: 1, aspect_ratio: '1:1', output_format: 'png', safety_tolerance: '5', resolution: '1K' };
  } else {
    input = { prompt: refPrompt, image_size: 'square_hd', num_inference_steps: 4, num_images: 1, enable_safety_checker: true };
  }
  return { model: model, input: input };
}

async function submitAssetReference(falKey, descriptionText, category, modelKey, webhookUrl) {
  fal.config({ credentials: falKey });
  const built = buildAssetReferenceInput(descriptionText, category, modelKey);
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
// =================================================================================================
// DEAD CODE -- NOTHING CAN REACH THIS. TD-381, noted 2026-08-09 at Ian's request.
//
// Ian: "there actually isn't a Regenerate button on the Characters Tab on the Session screen. There
// is a retouch." He is right. The chain is:
//     regenerateReference()  in public/js/app.js   -- DEFINED, ZERO CALLERS
//       -> POST /:id/characters/:characterId/regenerate-reference  in routes/sessions.js
//         -> submitEditReference()  ->  buildEditReferenceInput()  (this function)
// and editReferenceImage(), the synchronous variant, is exported and likewise called by nothing.
// A whole feature -- client function, route, submit helper, prompt builder, sync variant -- that
// nothing can reach.
//
// IT IS NOT HURTING ANYTHING, which is why it is being LEFT rather than deleted (Ian's call). But it
// read as live long enough that v3.0.587 fixed a real bug in it and described the fix in terms of a
// button on screen -- so the note is here to stop the next reader making the same mistake.
//
// THE LIVE PATH ON THAT PAGE IS RETOUCH: submitRetouch() with shape 'reference'. That one carries
// CHAR_REF_STAGING and its results are alpha-cut, and it is what actually converts a character.
//
// FIFTH MEMBER OF A FAMILY THAT HAS NOW COST REAL TIME: TD-329 (paneSafeHtml), TD-337 (coFloatImg),
// TD-344 (buildSessionHTML's cast block), TD-349 (bronzeFrame's comment), and this.
// TD-381 holds the decision: either wire a Regenerate button to it -- the path is correct and ready
// -- or delete all five pieces together.
// =================================================================================================
function buildEditReferenceInput(baseImageUrl, changeText, charName, modelKey) {
  const name = charName || 'the character';
  const instruction =
    'This reference image shows ' + name + '. Keep ' + name + ' as the SAME ' +
    'character \u2014 identical face, body type, species, hair, horns, distinctive ' +
    'features, outfit, colors and pose as the reference image. ' +
    'Apply ONLY this one appearance change: ' + changeText + '. ' +
    'Do not add or draw any other creatures, characters, or objects. ' +
    'Comic book art style.\n\n' +
    // v3.0.587 -- THE SAME STAGING THE CANONICAL GENERATOR DICTATES. Without it this path kept
    // whatever ground the source image happened to carry, so regenerating an OLD character from
    // the Session Characters page reproduced its floor -- and the alpha cut cannot remove a floor
    // that is drawn into the picture. Restating it here is also what CONVERTS an old character:
    // the figure is preserved, the stage is replaced.
    CHAR_REF_STAGING;
  const key = IMAGE_MODELS[modelKey] ? modelKey : 'nano2';
  if (key === 'nano2' && baseImageUrl && /^https?:\/\//.test(baseImageUrl)) {
    return { model: IMAGE_EDIT_MODELS.nano2, input: { prompt: instruction, image_urls: [baseImageUrl], num_images: 1, aspect_ratio: '3:4', output_format: 'png', safety_tolerance: '5', resolution: '1K' } };
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
    await attachPriorReferences(db, chars, moment.session_id, campId, moment.fork_id);
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
    const userThinking = null;   // TF-04: smarter rendering is a system default now (NANO_THINKING_LEVEL); no per-user toggle.
    const momentDirsS = await loadMomentDirections(db, moment.fork_id);
    const _campPromptS = await loadCampaignPrompt(db, moment.campaign_id);
    const _rs = await resolveGenStyle(db, style, req.session.userId, moment.campaign_id);
    if (_rs.locked) return res.json({ error: 'STYLE_LOCKED', message: "That custom art style isn't available right now. It needs an active Platinum plan. Pick another, or upgrade for custom styles." });
    if (process.env.DEBUG_PROMPT) {
      try {
        var _md = momentDirsS[moment.id];
        console.log('[DEBUG_PROMPT] generate-moment moment_id=' + moment_id +
          ' bodyPromptChars=' + (prompt || '').length +
          ' cast_explicit=' + (!!moment.cast_explicit) +
          ' castNames=' + JSON.stringify(castNames || []) +
          ' matchedRefs=' + JSON.stringify((panelBlock.refs || []).map(function(r){ return r.name; })) +
          ' momentDirection=' + (_md ? JSON.stringify(_md) : 'none'));
        console.log('[DEBUG_PROMPT] body prompt (first 160): ' + (prompt || '').slice(0, 160));
      } catch (_e) {}
    }
    const sub = await submitPanelGen(applyMomentDirection(prompt, momentDirsS[moment.id]), _rs.styleForGen, fal_key, panelBlock, randomSeed, modelKey, webhookUrl, moment.shape, userThinking, _rs.isFade, _campPromptS);

    await logDebug(req.session.userId, {
      level: 'info', source: 'generation', page: 'Storyboard / moment image', fn: 'POST /generate-moment',
      message: 'Submitted moment image generation (request ' + sub.request_id + ')',
      detail: {
        moment_id: moment_id,
        model: sub.model,
        style: style || null,
        cast_explicit: !!moment.cast_explicit,
        castNames: castNames,
        matchedRefs: (panelBlock.refs || []).map(function(r){ return r.name; }),
        momentDirection: momentDirsS[moment.id] || null,
        bodyPrompt: applyMomentDirection(prompt, momentDirsS[moment.id]),
        finalPrompt: sub.prompt || '',
        systemPrompt: sub.system_prompt || ''
      }
    });
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
    try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Storyboard / moment image', fn: 'POST /generate-moment', message: 'Image generation failed: ' + (e && e.message), detail: { moment_id: (req.body && req.body.moment_id) || null, status: (e && e.status) || null, falBody: (e && e.body) || null, stack: (e && e.stack) || '' } }); } catch (_le) {}
    res.json({ error: friendlyImageError(e) });
  }
});

// POST /api/images/retouch-prompt -- v3.0.751.
//
// Turns what the reader typed into an instruction the IMAGE model can follow.
// This is NOT a fal call: it costs no token and generates no picture. The
// client has already built a template version and sends it along, so a failure
// here degrades to that rather than to nothing.
//
// EVERY RULE BELOW WAS PAID FOR IN FAILED GENERATIONS ON 2026-08-22. They are
// stated once here rather than once per template, and they are the reason this
// route exists at all.
router.post('/retouch-prompt', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const b = req.body || {};
    const typed = String(b.typed || '').trim();
    const template = String(b.template || '').trim();
    if (!typed && !template) return res.json({ error: 'nothing to rewrite' });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ error: 'not configured' });

    // The panel is only used for context, and only if the caller owns it.
    let shape = null, panelText = '';
    if (b.moment_id) {
      const mrow = await db.prepare(
        'SELECT m.shape, m.description, m.title, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
        'FROM moments m JOIN sessions s ON m.session_id = s.id ' +
        'LEFT JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ?'
      ).get(b.moment_id);
      if (!mrow) return res.json({ error: 'not found' });
      const myRole = await getCampaignRole(req.session.userId, mrow.campaign_id);
      if (!myRole) return res.status(403).json({ error: 'Access denied' });
      shape = mrow.shape || null;
      panelText = String(mrow.title || '') + ' ' + String(mrow.description || '');
    }

    const cast = Array.isArray(b.cast) ? b.cast.filter(function (x) { return !!x; }).slice(0, 20) : [];
    const place = String(b.place || '').trim();

    const system = [
      'You rewrite a reader\u2019s request into a single instruction for an image-editing model that is editing an existing picture (referred to as Image 1). Output ONLY the instruction. No preamble, no explanation, no quotation marks, no lists.',
      '',
      'RULES, all of which come from observed failures:',
      '1. Describe every LOCATION relative to the FRAME only \u2014 thirds, halves, percentages across and down, corners, edges. NEVER relative to a person or an object. A phrase like \u201cleft of the giant\u201d gets resolved as the giant\u2019s own left and lands on the wrong side.',
      '2. NEVER use a character or object as a landmark for position or scale. Naming one makes the model draw an extra copy of it. If you need a size, give it as a fraction of the image height.',
      '3. Depth is not a position. If something must look further away, say it is smaller, softer-edged, lower in contrast, hazier, and that something in the foreground crosses in front of it. If nearer, say larger, sharper, higher contrast, in front of the scenery. Never just say \u201cfurther back\u201d.',
      '4. A removal must be phrased as PAINTING, never as deleting: name the background that should occupy the area and state that nothing stands there. These models add reliably and subtract unreliably.',
      '5. A move must also state that the place the subject came from becomes empty ground, painted over with the surrounding scenery.',
      '6. Unless the reader is explicitly adding someone, end with an instruction that no new people, figures or creatures are added, that every existing figure stays where it is at its current size, and that the background, lighting, colours and art style are unchanged.',
      '7. Preserve whatever the reader did not ask to change. Say so explicitly.',
      '8. Never mention grid cells, cell numbers, or any interface terminology. Those are input devices and mean nothing to an image model.',
      '9. Write plain declarative English regardless of the language the reader wrote in.',
      '10. RESOLVE PRONOUNS AGAINST THE FIGURE THE READER INDICATED, and name that figure explicitly in your output. Never pass a bare he, she, they or it through when more than one figure is in the picture: the image model attaches it to the most prominent figure, not the intended one. This has put a costume change onto the wrong character.',
      '11. If the reader has asked for more than one distinct change at once, still produce ONE instruction, but keep the changes clearly separated and state for each one exactly which figure or object it applies to.',
      '12. If the draft contains a token of the form {{REF:Name}}, reproduce it EXACTLY as it appears, unchanged and unmoved. It is resolved later into a specific image number and rewriting it breaks that.',
      '',
      'A draft built from a fixed template may be supplied. If the reader\u2019s own words ask for something the draft does not cover, prefer the reader and keep the draft\u2019s protective clauses. If the reader typed nothing beyond the draft, return the draft essentially unchanged.'
    ].join('\n');

    const parts = [];
    if (typed) parts.push('What the reader asked for, in their words:\n' + typed);
    if (template) parts.push('Template draft:\n' + template);
    if (place) parts.push('The place they indicated on the picture: ' + place);
    if (shape) parts.push('Panel shape: ' + shape);
    if (panelText.trim()) parts.push('What this panel depicts: ' + panelText.trim().slice(0, 600));
    if (cast.length) parts.push('Characters cast on this panel (identity references are sent with the edit): ' + cast.join(', '));

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: RETOUCH_MODEL, max_tokens: 700, system: system, messages: [{ role: 'user', content: parts.join('\n\n') }] })
    });
    if (!resp.ok) {
      try { await logDebug(req.session.userId, { level: 'warn', source: 'generation', page: 'Retouch prompt', fn: 'POST /retouch-prompt', message: 'Rewrite call failed with status ' + resp.status, detail: { moment_id: b.moment_id || null, status: resp.status } }); } catch (_e) {}
      return res.json({ error: 'rewrite unavailable' });
    }
    const data = await resp.json();
    const out = ((data && data.content) || [])
      .map(function (c) { return (c && c.type === 'text') ? c.text : ''; })
      .join('').trim();
    if (!out) return res.json({ error: 'empty rewrite' });

    // TD-513: the diagnosis belongs in debug_logs, never in what the reader sees.
    // The EXPANDED prompt is logged because a bad picture is untraceable without
    // the words that actually produced it.
    try { await logDebug(req.session.userId, { level: 'info', source: 'generation', page: 'Retouch prompt', fn: 'POST /retouch-prompt', message: 'Rewrote a retouch instruction', detail: { moment_id: b.moment_id || null, action: b.action || null, cell: b.cell || null, typed: typed, template: template, expanded: out, model: RETOUCH_MODEL } }); } catch (_e) {}

    return res.json({ prompt: out });
  } catch (e) {
    try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Retouch prompt', fn: 'POST /retouch-prompt', message: 'Rewrite threw: ' + (e && e.message), detail: { stack: (e && e.stack) || '' } }); } catch (_e) {}
    return res.json({ error: 'rewrite failed' });
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
  // v3.0.653 -- TD-444. A DRAWN TITLE IS NOT RETOUCHED FROM HERE.
  //
  // Ian, 2026-08-12: "the retouch option should not show... if the image in the panel came from
  // the title builder. that is the safest thing to do."
  //
  // WHAT IT USED TO DO, AND WHY IT LOOKED FINE. This route and its webhook write image, img_w and
  // img_h and never touch layout_meta -- so built_title survived and the row went on being drawn
  // as a chapter head while the artwork underneath had become something else entirely: opaque,
  // because nothing runs the ground cut here; the wrong size, because the object name carries no
  // dimensions and the renderer falls back to the canvas ratio; and with built_title.src still
  // pointing at the OLD uncut source, so a later Title Builder retouch would quietly discard this
  // one. An opaque block, at the wrong size, that prints.
  //
  // The button is hidden in app.js. This is the rule.
  var _blt = null;
  try { var _lm = moment.layout_meta ? (typeof moment.layout_meta === 'object' ? moment.layout_meta : JSON.parse(moment.layout_meta)) : {}; _blt = _lm && _lm.built_title; } catch (e) { _blt = null; }
  // Only when the LIVE image is the built title. A stale built_title left behind
  // by a later regenerate or replace must not lock the panel out of retouching.
  if (_blt && _blt.url && moment.image && String(_blt.url) === String(moment.image)) {
    return res.json({ error: 'TITLE_PANEL', message: 'This panel holds a chapter title from the Title Builder. Open the Title Builder to change it, or Regenerate to draw the scene instead.' });
  }
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
    await attachPriorReferences(db, charsR, moment.session_id, campIdR, moment.fork_id);
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
    // v3.0.766 -- resolve {{REF:Name}} placeholders to the actual image number.
    // Falls back to the old wording when a name does not resolve, so an
    // unmatched placeholder degrades to a working prompt rather than leaking.
    let instructionR = instruction;
    if (instructionR && instructionR.indexOf('{{REF:') !== -1) {
      instructionR = instructionR.replace(/\{\{REF:([^}]*)\}\}/g, function (m, nm) {
        var want = String(nm || '').trim().toLowerCase();
        for (var ri = 0; ri < refsR.length; ri++) {
          var rn = refsR[ri] && refsR[ri].name;
          if (rn && String(rn).trim().toLowerCase() === want) {
            return 'the single reference picture supplied with this request, which is the reference for ' + rn + ',';
          }
        }
        return 'the supplied reference image for ' + nm;
      });
    }
    // v3.0.770 -- the reference the reader PICKED, stated as fact and pinned
    // to its image number. A token in prose did not survive the rewrite route;
    // this is assembled here, after refsR exists, and cannot be edited away.
    var _pickName = String((req.body && req.body.ref_name) || '').trim();
    var _pinOutcome = _pickName ? 'not evaluated' : 'nothing picked';
    if (_pickName) {
      var _pickIdx = -1;
      for (var pi = 0; pi < refsR.length; pi++) {
        var pn = refsR[pi] && refsR[pi].name;
        if (pn && String(pn).trim().toLowerCase() === _pickName.toLowerCase()) { _pickIdx = pi; break; }
      }
      _pinOutcome = (_pickIdx >= 0)
        ? ('matched ' + refsR[_pickIdx].name + ' -- payload narrowed to that one reference')
        : 'NO MATCH -- the picked name is not in this route\'s reference list';
      if (_pickIdx >= 0) {
        instructionR = 'The character or object being corrected is ' + refsR[_pickIdx].name +
          '. The single reference picture supplied with this request is the reference for ' + refsR[_pickIdx].name +
          ', and it is the only one supplied. Apply the change to ' + refsR[_pickIdx].name + ' and to no one else.\n\n' + instructionR;
      }
    }
    const _rs = await resolveGenStyle(db, style, req.session.userId, moment.campaign_id);
    if (_rs.locked) return res.json({ error: 'STYLE_LOCKED', message: "That custom art style isn't available right now. It needs an active Platinum plan. Pick another, or upgrade for custom styles." });
    var _markedUrl = String(req.body.marked_url || '').trim();
    var _r2base = process.env.R2_PUBLIC_URL || '';
    if (_markedUrl && (!_r2base || _markedUrl.indexOf(_r2base + '/') !== 0)) _markedUrl = '';
    // v3.0.773 -- CROP. When the reader marked a spot and asked for the change
    // to be confined to it, the model is sent a TILE, not the whole picture.
    // Everything outside the tile is then untouched by arithmetic rather than
    // by instruction -- measured at zero changed pixels.
    var _cropMeta = null, _sendUrl = moment.image, _isTile = false;
    try {
      var _cm = (req.body && req.body.crop) || null;
      if (_cm && typeof _cm.x === 'number' && typeof _cm.y === 'number') {
        var _panelBuf = await fetchFile(moment.image);
        if (_panelBuf) {
          // A second point means the change travels: span both.
          var _cut = await imageCrop.cropTile(_panelBuf, _cm, _cm.to || null);
          var _tileUrl = await uploadFile(_cut.buffer, 'tile-' + moment.id + '-' + Date.now() + '.png', 'image/png');
          if (_tileUrl) {
            _sendUrl = _tileUrl;
            _isTile = true;
            _cropMeta = JSON.stringify({ box: _cut.box, base: moment.image, panel: _cut.panel });
          }
        }
      }
    } catch (_ce) {
      // A crop that fails falls back to the whole picture: a degraded retouch
      // beats a retouch the reader paid for and did not get.
      _cropMeta = null; _sendUrl = moment.image; _isTile = false;
      try { await logDebug(req.session.userId, { level: 'warn', source: 'generation', page: 'Retouch moment', fn: 'POST /retouch-moment', message: 'Crop failed, sending the whole picture: ' + (_ce && _ce.message), detail: { moment_id: moment.id } }); } catch (_le2) {}
    }
    const sub = await submitRetouch(_sendUrl, instructionR, _rs.styleForGen, fal_key, webhookUrl, { refs: refsR, text: charListR.text }, moment.shape, _markedUrl || null, _pickName || null, _isTile, _isTile ? moment.image : null);
    const nowTs = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, crop_meta, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, moment.campaign_id, moment.id, moment.fork_id, 'retouch', 'queued', sub.model, style || null, cost, moment.image || null, _cropMeta, nowTs, nowTs);
    try { await logDebug(req.session.userId, { level: 'info', source: 'generation', page: 'Retouch moment', fn: 'POST /retouch-moment', message: 'Submitted retouch for moment ' + moment.id + ' (request ' + sub.request_id + ')', detail: { moment_id: moment.id, model: sub.model, style: style || null, fork_id: moment.fork_id, instruction_raw: (req.body && req.body.instruction) || null, ref_name_picked: _pickName || null, ref_pin: _pinOutcome, ref_url_sent: (function(){ for (var q=0;q<refsR.length;q++){ var rq=refsR[q]; if (rq && rq.name && _pickName && String(rq.name).trim().toLowerCase()===_pickName.toLowerCase()) return rq.url; } return null; })(), picker_saw: (req.body && req.body.picker_saw) || null, picker_fork: (req.body && req.body.picker_fork) || null, refs: (refsR || []).map(function(r){ return r && r.name; }), marked_url: _markedUrl ? 'yes' : 'no', cropped: _isTile ? _cropMeta : 'no -- whole picture sent', instruction_sent: instructionR } }); } catch (_le) {}
    if (myRole === 'player') {
      try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(moment.campaign_id, req.session.userId); } catch (e) {}
    }
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('retouch error:', e.message);
    try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Retouch moment', fn: 'POST /retouch-moment', message: 'Retouch failed: ' + (e && e.message), detail: { moment_id: (req.body && req.body.moment_id) || null, status: (e && e.status) || null, falBody: (e && e.body) || null, stack: (e && e.stack) || '' } }); } catch (_le) {}
    res.json({ error: friendlyImageError(e) });
  }
});

// POST /api/images/revert-moment
// One-deep undo of the last retouch/regenerate: restore the retained prior image
// and release the current one. Free (no token spend). Owner-only, blocked when locked.
router.post('/revert-moment', requireAuth, async function(req, res) {
  const { moment_id } = req.body;
  const db = await getDb();
  const moment = await db.prepare(
    'SELECT m.*, s.campaign_id AS campaign_id, sf.user_id AS fork_owner ' +
    'FROM moments m JOIN sessions s ON m.session_id = s.id JOIN session_forks sf ON sf.id = m.fork_id WHERE m.id = ?'
  ).get(moment_id);
  if (!moment) return res.status(404).json({ error: 'Moment not found' });
  const myRole = await getCampaignRole(req.session.userId, moment.campaign_id);
  if (!myRole) return res.status(403).json({ error: 'Access denied' });
  if (String(moment.fork_owner) !== String(req.session.userId))
    return res.status(403).json({ error: 'You can only revert your own version' });
  if (moment.locked) return res.json({ error: 'MOMENT_LOCKED', message: 'This panel is locked. Unlock it to revert.' });
  if (!moment.revert_image) return res.json({ error: 'There is no previous image to revert to.' });
  try {
    const current = moment.image;
    const now = new Date().toISOString();
    // v3.0.656 -- REVERT RESTORES THE PAIR. An image and its marker are one previous state; putting
    // back the pixels alone returns a chapter title to the panel dressed as a scene, with a frame, a
    // caption and full column width. prev_built_title is consumed here whether or not it is set --
    // absent means the previous state was an ordinary picture, and the marker must go.
    var _rMeta = null;
    try {
      _rMeta = moment.layout_meta ? (typeof moment.layout_meta === 'object' ? moment.layout_meta : JSON.parse(moment.layout_meta)) : {};
      var _prevBT = _rMeta.prev_built_title || null;
      // v3.0.660 -- reverting TO a picture demotes the title that was live rather than dropping
      // it, so it stays in the builder and its bytes stay referenced.
      // v3.0.700 -- TD-501. REVERT IS A TOGGLE NOW, NOT A ONE-WAY DOOR.
      //
      // Ian, 2026-08-18: the Revert pill "should pretty much always show if anything has ever
      // been there and been changed."
      //
      // IT WORKED ONCE AND THEN VANISHED. The undo slot was armed on the way IN and cleared on the
      // way BACK -- revert_image = NULL -- so one press restored the picture and left nothing to
      // return to. The pill is drawn from that column, so it disappeared with it. Worse, the image
      // being reverted AWAY from was handed to releaseImage, so its bytes could be collected and
      // the choice was not merely hidden, it was gone.
      //
      // THE SLOTS SWAP. What was on the panel becomes what Revert restores next, which makes the
      // control mean the same thing every time it is pressed and keeps BOTH pictures referenced.
      // That is also why releaseImage is no longer called here: nothing has stopped being used.
      //
      // THE MARKER SWAPS WITH IT (the v3.0.655 pair rule). revert_image and prev_built_title
      // describe ONE previous state and are written together; putting the pixels back without the
      // marker would return lettering to the panel dressed as a scene.
      var _liveBT = (_rMeta.built_title && _rMeta.built_title.url) ? _rMeta.built_title : null;
      if (_prevBT) _rMeta.built_title = _prevBT; else demoteBuiltTitle(_rMeta);
      if (_liveBT) _rMeta.prev_built_title = _liveBT; else delete _rMeta.prev_built_title;
    } catch (e) { _rMeta = null; }
    await db.prepare('UPDATE moments SET image = ?, img_w = ?, img_h = ?, revert_image = ?, revert_img_w = ?, revert_img_h = ?, layout_meta = COALESCE(?, layout_meta), edited_at = ?, edited_by = ? WHERE id = ?')
      .run(moment.revert_image, moment.revert_img_w || null, moment.revert_img_h || null,
           current || null, moment.img_w || null, moment.img_h || null,
           _rMeta ? JSON.stringify(_rMeta) : null, now, req.session.userId, moment.id);
    res.json({ success: true, image: moment.revert_image });
  } catch (e) {
    console.error('revert-moment error:', e.message);
    res.json({ error: friendlyError(e, 'Could not revert the image. Please try again.') });
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
  // Tier gate: block generating with a locked art style.
  if (style) {
    const effRankAll = accessRank(await getEffectiveTier(req.session.userId, campaign_id));
    if (!artStyleAllowed(effRankAll, style)) {
      return res.json({ error: 'STYLE_LOCKED', message: "That art style isn't available on your current plan. Pick another, or upgrade for more styles." });
    }
  }
  // v3.0.445 -- GENERATE INTO THE VERSION ON SCREEN (TD-194).
  // The old comment read "DM always generates into the canonical (DM) fork - never a player's
  // version", and the intent behind it still stands: a Story Master must never write into somebody
  // else's version. But it was expressed as "always the canonical", which with several versions per
  // person means a Story Master pressing Generate on their OWN second version filled the canonical
  // instead -- tokens spent, and the wrong book changed.
  // The shared resolver keeps the protection (it refuses a version that is not yours) and drops the
  // assumption. Null means refuse, never fall back.
  let targetForkId = await resolveActingFork(db, session_id, req.session.userId, myRole, requestedForkIdOf(req));
  if (!targetForkId && requestedForkIdOf(req)) {
    return res.status(403).json({ error: 'That version is not yours to generate into.' });
  }
  if (targetForkId) { /* resolved from the request */ }
  else if (myRole === 'dm') {
    targetForkId = await getDmForkId(db, session_id);
  } else {
    const myFork = await db.prepare('SELECT id FROM session_forks WHERE session_id = ? AND user_id = ? ORDER BY id ASC').get(session_id, req.session.userId);
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
  await attachPriorReferences(db, chars, session_id, campaign_id, targetForkId);

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
  const userThinkingAll = null;   // TF-04: smarter rendering is a system default now (NANO_THINKING_LEVEL); no per-user toggle.
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

  // Submit one queued fal job per panel; the webhook finishes each. Returning
  // immediately means a large batch can't time out at the gateway, and fal's
  // queue handles concurrency instead of us holding N live connections.
  const webhookUrl = falWebhookUrl();
  if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });

  const momentDirs = await loadMomentDirections(db, targetForkId);
  const _campPromptAll = await loadCampaignPrompt(db, campaign_id);
  // Whole batch shares one art style: resolve + lapse-check once, before the
  // concurrent map (a return inside the map would not abort the batch).
  const _rsAll = await resolveGenStyle(db, style, req.session.userId, campaign_id);
  if (_rsAll.locked) return res.json({ error: 'STYLE_LOCKED', message: "That custom art style isn't available right now. It needs an active Platinum plan. Pick another, or upgrade for custom styles." });
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
      const _rs = _rsAll;
      const sub = await submitPanelGen(applyMomentDirection(m.prompt, momentDirs[m.id]), _rs.styleForGen, fal_key, panelBlock, panelSeed, modelKey, webhookUrl, m.shape, userThinkingAll, _rs.isFade, _campPromptAll);
      const nowTs = new Date().toISOString();
      const jobIns = await db.prepare(
        'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(sub.request_id, req.session.userId, campaign_id, m.id, targetForkId, 'batch', 'queued', sub.model, style || null, perImageCost, m.image || null, nowTs, nowTs);
      try { await logDebug(req.session.userId, { level: 'info', source: 'generation', page: 'Generate Story (all panels)', fn: 'POST /generate-all', message: 'Submitted panel ' + m.id + ' (request ' + sub.request_id + ')', detail: { moment_id: m.id, model: sub.model, style: style || null, cast_explicit: !!m.cast_explicit, castNames: castNames, matchedRefs: (panelBlock.refs || []).map(function(r){ return r && r.name; }), momentDirection: momentDirs[m.id] || null, finalPrompt: sub.prompt || '', systemPrompt: sub.system_prompt || '' } }); } catch (_le) {}
      return { moment_id: m.id, job_id: jobIns.lastInsertRowid };
    })
  );

  const jobs = [];
  let submitFailed = 0;
  for (var si = 0; si < submitResults.length; si++) {
    if (submitResults[si].status === 'fulfilled') jobs.push(submitResults[si].value);
    else { submitFailed++; console.error('generate-all submit failed:', submitResults[si].reason && submitResults[si].reason.message); }
  }

  try { await logDebug(req.session.userId, { level: submitFailed ? 'error' : 'info', source: 'generation', page: 'Generate Story (all panels)', fn: 'POST /generate-all', message: 'Generate Story submitted: ' + jobs.length + ' queued, ' + submitFailed + ' failed', detail: { queued: jobs.length, failed: submitFailed, campaign_id: campaign_id } }); } catch (_le) {}
  if (myRole === 'player' && jobs.length) {
    try { await db.prepare('UPDATE users SET last_active_campaign_id = ? WHERE id = ?').run(campaign_id, req.session.userId); } catch (e) {}
  }

  res.status(202).json({ status: 'queued', jobs: jobs, total: moments.length, to_generate: toGenerate.length, skipped_locked: lockedCount, submit_failed: submitFailed });
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
      const friendlyMsg = friendlyImageError({ message: errMsg, status: (body.error && (body.error.status || body.error.code)) || null });
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyMsg, new Date().toISOString(), job.id);
      try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Generation failed: ' + String(errMsg).slice(0, 200), detail: { moment_id: job.moment_id, kind: job.kind, style: job.style || null } }); } catch (_le) {}
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
    let dimsSource = (imgW && imgH) ? 'real' : 'synthetic';
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
    if (!falUrl) {
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyImageError({ message: 'no image in webhook payload' }), new Date().toISOString(), job.id);
      try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Generation returned no image', detail: { moment_id: job.moment_id, kind: job.kind, style: job.style || null } }); } catch (_le) {}
      return res.status(200).json({ ok: true });
    }
    if (payload.has_nsfw_concepts && payload.has_nsfw_concepts[0] === true) {
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyImageError({ message: 'image was flagged by the safety filter (returned blank)' }), new Date().toISOString(), job.id);
      try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Image flagged by safety filter (returned blank)', detail: { moment_id: job.moment_id, kind: job.kind, style: job.style || null } }); } catch (_le) {}
      return res.status(200).json({ ok: true });
    }
    // Atomic claim: only the first delivery flips queued -> processing.
    const claim = await db.prepare("UPDATE image_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(new Date().toISOString(), job.id);
    if (!claim || claim.changes === 0) return res.status(200).json({ ok: true });
    try {
      // v3.0.573 -- TD-362. A character reference is generated on a white ground BY SPEC and is the
      // only image this product composites over another, so it is the only one whose ground is cut to
      // real alpha. A scene image has a real background and must keep every pixel of it.
      // v3.0.587 -- session_ref IS A CHARACTER REFERENCE. The Session Characters page writes one
      // with Regenerate and with Retouch, and the Company page composites it exactly like the
      // canonical -- so it needs the same real alpha. Gating on char_ref alone meant those two
      // buttons handed back an opaque white box that erased its neighbours on the line-up.
      // A SCENE image still keeps every pixel: it has a real background and must not be cut.
      const _cutWhite = (job.kind === 'char_ref' || job.kind === 'session_ref');
      // v3.0.773 -- a TILE job hands back a tile. Paste it into the picture it
      // was cut from, and store THAT. Everything outside the box is untouched
      // because it was never sent anywhere.
      var imageUrl = null;
      var _cropDone = false;
      if (job.crop_meta) {
        try {
          var _cj = JSON.parse(job.crop_meta);
          if (_cj && _cj.box && _cj.base) {
            var _baseBuf = await fetchFile(_cj.base);
            var _tileRes = await fetch(falUrl);
            var _tileBuf = _tileRes && _tileRes.ok ? Buffer.from(await _tileRes.arrayBuffer()) : null;
            if (_baseBuf && _tileBuf) {
              var _merged = await imageCrop.compositeTile(_baseBuf, _tileBuf, _cj.box);
              imageUrl = await uploadFile(_merged, 'merged-' + (job.moment_id || 0) + '-' + Date.now() + '.png', 'image/png');
              _cropDone = !!imageUrl;
            }
          }
        } catch (_xe) {
          try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Composite failed, storing the tile as-is: ' + (_xe && _xe.message), detail: { moment_id: job.moment_id, crop_meta: job.crop_meta } }); } catch (_le3) {}
        }
      }
      // No crop, or the composite failed: the original path, unchanged.
      if (!imageUrl) imageUrl = await persistToR2(falUrl, { cutWhite: _cutWhite });
      // Measure the REAL pixel dimensions from the image bytes. nano-banana-2 returns null
      // width/height in its webhook, so without this the layout uses the nominal shape aspect
      // (e.g. every "Standard" panel treated as 4:3) -- and a portrait image forced into a 4:3
      // box gets cropped by object-fit:cover. Measuring the bytes gives the true aspect so the
      // box fits exactly. Falls through to whatever imgW/imgH already hold if measuring fails.
      try {
        const _measured = await measureImageDims(imageUrl) || (_cropDone ? null : await measureImageDims(falUrl));
        if (_measured && _measured.width > 0 && _measured.height > 0) {
          imgW = _measured.width; imgH = _measured.height; dimsSource = 'measured';
        }
      } catch (_me) { /* keep existing imgW/imgH */ }
      if (job.moment_id && (job.kind === 'moment' || job.kind === 'batch' || job.kind === 'retouch')) {
        const now = new Date().toISOString();
        const _priorM = await db.prepare('SELECT image, img_w, img_h, revert_image, shape FROM moments WHERE id = ?').get(job.moment_id);
        if (job.kind === 'retouch') {
          await db.prepare('UPDATE moments SET image = ?, img_w = ?, img_h = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, imgW, imgH, now, job.user_id, job.moment_id);
        } else {
          // v3.0.653 -- TD-444. A SCENE HAS BEEN DRAWN, SO THE ROW STOPS CLAIMING TO BE LETTERING.
          //
          // Regenerate is the way back from a chapter title to a picture -- Ian: "the Regenerate
          // button on the picture should actually use the picture prompt and regenerate the
          // picture." It always drew the right thing and then left built_title in place, so the
          // result was rendered as a chapter head: no frame, no caption, half column, letterboxed
          // in a 21:9 box, and opaque. The escape hatch produced exactly the state it was supposed
          // to escape.
          //
          // ONLY ON THE NON-RETOUCH PATH. A retouch keeps whatever the panel already was, and a
          // built title can no longer reach retouch at all (see the refusal in retouch-moment).
          // A title BUILD never comes through here -- it is synchronous and writes through
          // titleTarget -- so nothing this clears was ever set by the title path itself.
          await db.prepare('UPDATE moments SET image = ?, style = ?, img_w = ?, img_h = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, job.style || null, imgW, imgH, now, job.user_id, job.moment_id);
          // v3.0.656 -- STASHED, NOT DELETED. THIS CORRECTS v3.0.653.
          //
          // Ian, 2026-08-12: "I had chapter text in the panel... I regenerated and got an actual
          // picture... Then I opened up the title builder... and my text picture was gone."
          //
          // v3.0.653 was right that the row must stop claiming to be lettering, and wrong about what
          // to do with the claim. It deleted built_title -- and with it the uncut source, the words
          // the drawing spelled and the prompt that drew it. The ARTWORK survived, because the same
          // webhook arms revert_image with it. So Revert restored the pixels and nothing else, and
          // the lettering came back rendered as an ordinary framed, captioned scene. I split one
          // thing into two and only undid half of it.
          //
          // THE UNDO SLOT IS A PAIR. revert_image and prev_built_title describe the same previous
          // state, so they are written together, always, and read together in revert-moment. Storing
          // the marker anywhere else would let the two drift -- which is the whole fault above, in a
          // different field.
          //
          // AND IT IS OVERWRITTEN EVERY TIME, INCLUDING WITH NOTHING. Regenerate twice and the undo
          // slot holds the intermediate SCENE, not the title -- so the marker must be cleared on the
          // second pass or Revert would flag a photograph as lettering. Absent is a value here.
          try {
            var _pm = await db.prepare('SELECT layout_meta FROM moments WHERE id = ?').get(job.moment_id);
            var _pmeta = (_pm && _pm.layout_meta) ? (typeof _pm.layout_meta === 'object' ? _pm.layout_meta : JSON.parse(_pm.layout_meta)) : null;
            if (_pmeta) {
              var _wasTitle = _pmeta.built_title || null;
              // v3.0.660 -- demote rather than delete: prev_built_title is the ONE-DEEP undo and
              // is consumed by the next Revert, so on its own it is not somewhere a title lives.
              if (_wasTitle) demoteBuiltTitle(_pmeta);
              if (_wasTitle) _pmeta.prev_built_title = _wasTitle; else delete _pmeta.prev_built_title;
              if (_wasTitle || _pm.layout_meta !== JSON.stringify(_pmeta)) {
                await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(_pmeta), job.moment_id);
              }
            }
          } catch (e) { console.error('stashing built_title after regenerate failed:', e && e.message); }
        }
        try { await logDebug(job.user_id, { level: 'info', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Image ready for moment ' + job.moment_id + ' (' + job.kind + ')', detail: { moment_id: job.moment_id, kind: job.kind, shape: _priorM ? (_priorM.shape || null) : null, img_w: imgW, img_h: imgH, dims: dimsSource, file_size: (falImg && falImg.file_size) || null, nsfw: (payload && payload.has_nsfw_concepts) || null, style: job.style || null } }); } catch (_le) {}
        // Revert undo-slot (one-deep): retouch + single regenerate retain the prior
        // image so the user can undo. Bulk 'batch' does not arm; it clears any stale
        // slot. Superseded slot images are released; the retained one is NOT.
        if (job.kind === 'retouch' || job.kind === 'moment') {
          if (_priorM && _priorM.revert_image && _priorM.revert_image !== job.prev_image && _priorM.revert_image !== imageUrl) {
            await releaseImage(db, _priorM.revert_image);
          }
          if (job.prev_image && job.prev_image !== imageUrl) {
            var _rw = (_priorM && _priorM.image === job.prev_image) ? _priorM.img_w : null;
            var _rh = (_priorM && _priorM.image === job.prev_image) ? _priorM.img_h : null;
            await db.prepare('UPDATE moments SET revert_image = ?, revert_img_w = ?, revert_img_h = ? WHERE id = ?').run(job.prev_image, _rw || null, _rh || null, job.moment_id);
          } else {
            await db.prepare('UPDATE moments SET revert_image = NULL, revert_img_w = NULL, revert_img_h = NULL WHERE id = ?').run(job.moment_id);
          }
        } else {
          if (job.prev_image && job.prev_image !== imageUrl) await releaseImage(db, job.prev_image);
          if (_priorM && _priorM.revert_image && _priorM.revert_image !== imageUrl) {
            await releaseImage(db, _priorM.revert_image);
            await db.prepare('UPDATE moments SET revert_image = NULL, revert_img_w = NULL, revert_img_h = NULL WHERE id = ?').run(job.moment_id);
          }
        }
        await logImageGeneration(db, job.user_id, job.kind === 'retouch' ? 'retouch' : 'moment', job.moment_id, job.fork_id);
      }
        if (job.kind === 'char_ref' && job.character_id) {
          await db.prepare('UPDATE characters SET canonical_reference_url = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, new Date().toISOString(), job.user_id, job.character_id);
          // Revert undo-slot (one-deep) for the canonical reference.
          const _priorC = await db.prepare('SELECT revert_reference_url FROM characters WHERE id = ?').get(job.character_id);
          if (_priorC && _priorC.revert_reference_url && _priorC.revert_reference_url !== job.prev_image && _priorC.revert_reference_url !== imageUrl) {
            await releaseImage(db, _priorC.revert_reference_url);
          }
          if (job.prev_image && job.prev_image !== imageUrl) {
            await db.prepare('UPDATE characters SET revert_reference_url = ? WHERE id = ?').run(job.prev_image, job.character_id);
          } else {
            await db.prepare('UPDATE characters SET revert_reference_url = NULL WHERE id = ?').run(job.character_id);
          }
          await logImageGeneration(db, job.user_id, 'character_reference', job.character_id);
        }
        if (job.kind === 'session_ref' && job.character_id) {
          await logImageGeneration(db, job.user_id, 'session_reference', job.character_id, job.fork_id);
        }
        if ((job.kind === 'asset_ref' || job.kind === 'asset_retouch') && job.asset_id) {
          await db.prepare('UPDATE campaign_assets SET image_url = ?, edited_at = ?, edited_by = ? WHERE id = ?')
            .run(imageUrl, new Date().toISOString(), job.user_id, job.asset_id);
          // Revert undo-slot (one-deep): regenerate/retouch retain the prior image.
          const _priorA = await db.prepare('SELECT revert_image_url FROM campaign_assets WHERE id = ?').get(job.asset_id);
          if (_priorA && _priorA.revert_image_url && _priorA.revert_image_url !== job.prev_image && _priorA.revert_image_url !== imageUrl) {
            await releaseImage(db, _priorA.revert_image_url);
          }
          if (job.prev_image && job.prev_image !== imageUrl) {
            await db.prepare('UPDATE campaign_assets SET revert_image_url = ? WHERE id = ?').run(job.prev_image, job.asset_id);
          } else {
            await db.prepare('UPDATE campaign_assets SET revert_image_url = NULL WHERE id = ?').run(job.asset_id);
          }
          await logImageGeneration(db, job.user_id, 'asset_reference', job.asset_id, null);
        }
      const genSource = (job.kind === 'char_ref') ? 'character_reference'
        : (job.kind === 'session_ref') ? 'amendment_reference'
        : (job.kind === 'asset_ref') ? 'asset_reference'
        : (job.kind === 'asset_retouch') ? 'asset_retouch'
        : (job.kind === 'retouch') ? 'panel_retouch'
        : (job.kind === 'batch') ? 'panel_batch' : 'panel_regen';
      if (job.cost && job.cost > 0) {
        await spendTokens(job.user_id, job.cost, { related_campaign_id: job.campaign_id, source: genSource, event_type: 'generation_spend' });
      }
      try { await recordGeneration(job.user_id, { event_type: genSource, tokens_redeemed: (job.cost || 0), quantity: 1, unit: 'images', model: job.model, related_campaign_id: job.campaign_id }); } catch (e) {}
      await db.prepare('UPDATE image_jobs SET status = ?, image_url = ?, updated_at = ? WHERE id = ?')
        .run('done', imageUrl, new Date().toISOString(), job.id);
    } catch (e) {
      console.error('[fal webhook] processing error:', e.message);
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyImageError(e), new Date().toISOString(), job.id);
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
  } catch (e) { res.json({ error: friendlyError(e, 'Could not check image status.') }); }
});

webhookRouter.get('/jobs/:id', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const job = await db.prepare('SELECT id, status, image_url, error, moment_id FROM image_jobs WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.session.userId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ status: job.status, image_url: job.image_url || null, error: job.error || null, moment_id: job.moment_id });
  } catch (e) { res.json({ error: friendlyError(e, 'Could not check image status.') }); }
});

// POST /api/images/custom-style-preview -- render ONE sample panel in a (possibly
// unsaved) custom STYLE: paragraph so the builder can preview before saving.
// Platinum-gated; costs one image token on success.
router.post('/custom-style-preview', requireAuth, async function(req, res) {
  try {
    const own = await getEffectiveTier(req.session.userId, null);
    if (own !== 'platinum') return res.status(403).json({ error: 'NOT_PLATINUM', message: 'Custom styles are a Platinum feature.' });
    let stylePrompt = (req.body && req.body.style_prompt || '').trim();
    if (!stylePrompt) return res.json({ error: 'Add a style description first.' });
    if (!/^STYLE:/i.test(stylePrompt)) stylePrompt = 'STYLE: ' + stylePrompt;
    const isFade = !!(req.body && (req.body.is_fade === true || req.body.is_fade === 1 || req.body.is_fade === '1' || req.body.is_fade === 'true'));
    const fal_key = process.env.FAL_API_KEY || req.body.fal_key;
    if (!fal_key) return res.json({ error: 'Image generation is not configured.' });
    const db = await getDb();
    const modelKey = await getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Add more to preview a style.' });
    }
    const SAMPLE_PROMPT = 'A lone armored adventurer stands at the edge of a misty ancient forest at dawn, sword in hand, with crumbling ruins and a distant mountain range behind them.';
    const seed = crypto.randomInt(1, 2147483647);
    const url = await generateImage(SAMPLE_PROMPT, stylePrompt, fal_key, null, seed, modelKey, 'wide', null, isFade);
    try { await spendTokens(req.session.userId, cost, { source: 'custom_style_preview', event_type: 'generation_spend' }); } catch (e) { console.error('preview spend failed:', e.message); }
    try { await recordGeneration(req.session.userId, { event_type: 'custom_style_preview', tokens_redeemed: cost, quantity: 1, unit: 'images', model: (IMAGE_MODELS[modelKey] || modelKey) }); } catch (e) {}
    // Persist the preview to the style so reopening shows the last render.
    const styleId = req.body && req.body.style_id;
    if (styleId) {
      try {
        const srow = await db.prepare('SELECT id, preview_url FROM custom_art_styles WHERE id = ? AND owner_id = ?').get(styleId, req.session.userId);
        if (srow) {
          await db.prepare('UPDATE custom_art_styles SET preview_url = ?, updated_at = ? WHERE id = ?').run(url, new Date().toISOString(), srow.id);
          if (srow.preview_url && srow.preview_url !== url) { try { await releaseImage(db, srow.preview_url); } catch (e) {} }
        }
      } catch (e) { console.error('preview persist failed:', e.message); }
    }
    res.json({ image: url });
  } catch (e) {
    console.error('custom style preview error:', (e && e.status) || '', e.message, (e && e.body && (e.body.detail || JSON.stringify(e.body))) || '');
    res.json({ error: friendlyImageError(e) });
  }
});

// =================================================================================================
// =====================================================================================================
// TITLE BUILDER SHARED PARTS (TD-357, TD-401, TD-402)
// =====================================================================================================

// TB_REF_BACK -- the colour painted behind a CUT title when we have no uncut original to hand back.
// Titles built before v3.0.622 have no original, so they get one reconstructed here.
//
// BLACK, and this is the one place that decides it. The generate prompt below demands a flat solid
// black field, so black is exactly what the cut removed: repainting it restores the picture rather
// than inventing one. A distinctive colour (green was considered) would make every part of the
// artwork visible against the backing, but the cut RAMPS alpha across letter edges -- so those pixels
// are part-ground by construction and a green backing would tint the soft edge of every letterform,
// which is the thing that makes lettering read as drawn rather than stamped.
//
// The `name` is here so the prompt sentence and the pixels come from ONE declaration. Two places that
// must agree about a colour will eventually disagree about a colour.
const TB_REF_BACK = { r: 0, g: 0, b: 0, name: 'flat solid black' };

// cutStoredTitle: fetch a stored title, run the ground cut, and store the RESULT as its own object.
//
// Returns { url, cut }. When the cut declines -- a photographic result, an interlaced PNG, anything it
// cannot safely handle -- cutGroundToAlpha hands back THE SAME BUFFER, so nothing is uploaded and the
// original URL is returned unchanged. Identity is the signal; there is no second guess about it.
async function cutStoredTitle(sourceUrl) {
  const axios = require('axios');
  const https = require('https');
  const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
  const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
  const buf = Buffer.from(resp.data);
  const out = cutGroundToAlpha(buf);
  if (out === buf) return { url: sourceUrl, cut: false };
  // v3.0.660 -- RESTORED. v3.0.653 was built from a pre-648 copy of this file and silently
  // reverted the trim: every title built between 653 and 660 is untrimmed and carries no size in
  // its name, so estCell cannot read its shape and falls back to the canvas ratio.
  // v3.0.648 -- TRIM, AND THEN PUT THE SIZE IN THE NAME.
  //
  // The renderer has to know the shape of this artwork WITHOUT LOADING IT.
  // services/printing/measureLayout.js aborts every image request so layout never waits on R2, so
  // an element sized from an image measures zero during the measure pass and full size in the
  // render -- which is what pushed pictures off the page in v3.0.645.
  //
  // WHY THE FILENAME AND NOT THE DATABASE. The alternative was to carry the numbers back through
  // the JSON response, into the modal, into title-write, into titleTarget and onto the moment row.
  // Four hand-offs. Every fault in this run of builds -- 640, 642, 643, 644 -- has been a value that
  // went missing between hand-offs while every individual step still looked correct. This has one
  // writer and one reader, and the URL is something the renderer already holds. The cover reads the
  // same object, so it gets the same answer for free.
  //
  // A title stored before this simply does not match the pattern, and the renderer falls back to
  // the canvas ratio it used before. No migration, and nothing to backfill.
  const t = trimToInk(out);
  const dims = (t.width > 0 && t.height > 0) ? ('-' + t.width + 'x' + t.height) : '';
  const name = 'titlecut-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + dims + '.png';
  const url = await uploadFile(t.buf, name, 'image/png');
  return { url: url, cut: true, trimmed: t.trimmed, width: t.width, height: t.height };
}

// chargeForTitleCall: one token per fal call, and a failed charge is LOUD.
//
// Ian, 2026-08-10: "every call to FAL should cost the user a token." By the time this runs the call
// has been made and the picture exists, so throwing here would take the artwork away and STILL not
// charge for it. What it does instead is refuse to be quiet: a spend that throws is written to the
// debug log the admin screen reads, not just to a console line on Railway. TD-400 exists because
// nobody had ever watched a real balance move; this is what makes the failure case discoverable.
async function chargeForTitleCall(req, cost, modelKey, source) {
  let spendOk = true;
  try {
    await spendTokens(req.session.userId, cost, { source: source, event_type: 'generation_spend' });
  } catch (e) {
    spendOk = false;
    console.error(source + ' spend FAILED (image was delivered free):', e && e.message);
    try {
      await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Title Builder', fn: source,
        message: 'Token spend FAILED after a fal call succeeded -- the user received an image without being charged.',
        detail: { cost: cost, model: modelKey, error: (e && e.message) || String(e) } });
    } catch (_le) {}
  }
  try {
    await recordGeneration(req.session.userId, { event_type: source, tokens_redeemed: spendOk ? cost : 0, quantity: 1, unit: 'images', model: modelKey });
  } catch (e) {}
  return spendOk;
}

// v3.0.636 -- resolveOwnBuiltTitle is gone. It and titleScope in routes/campaigns.js did the same
// three things in their own words -- resolve the scope, prove ownership, read the prefs -- and
// differed only in the shape they returned. Both now call resolveTitleTarget, which answers in
// neutral field names so that a chapter title can be stored somewhere else entirely (TD-422).

// titleModelInput: the picture the MODEL should look at, which is not always the picture we store.
//
// Prefers the uncut original kept since v3.0.622. Falls back to painting TB_REF_BACK behind the cut
// one for titles built before that, uploading the flattened copy as its own object so the model is
// handed a plain URL like any other. Returns { url, painted } -- painted is FALSE when the flatten
// declined, and the caller must not then tell the model about a backing that was never laid down.
async function titleModelInput(srcUrl, cutUrl) {
  if (srcUrl) return { url: srcUrl, painted: false };
  if (!cutUrl) return { url: '', painted: false };
  try {
    const axios = require('axios');
    const https = require('https');
    const agent = new https.Agent({ minVersion: 'TLSv1.2', rejectUnauthorized: false });
    const resp = await axios.get(cutUrl, { responseType: 'arraybuffer', httpsAgent: agent, timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity });
    const buf = Buffer.from(resp.data);
    const out = flattenOntoColour(buf, TB_REF_BACK.r, TB_REF_BACK.g, TB_REF_BACK.b);
    if (out === buf) return { url: cutUrl, painted: false };   // nothing transparent, or it declined
    const name = 'titleflat-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.png';
    const url = await uploadFile(out, name, 'image/png');
    return { url: url, painted: true };
  } catch (e) {
    console.error('titleModelInput flatten failed, using the cut image as-is:', e && e.message);
    return { url: cutUrl, painted: false };
  }
}

// POST /api/images/title-build -- TITLE BUILDER, STAGE ONE (TD-357).
//
// Ian, 2026-08-10: a modal like the Assets one. A label with the title and another with the subtitle,
// a description, optionally a reference image, and a Generate button that "reads your description and
// looks at the reference image if there is one, then creates a transparent image containing the title
// and subtitle". A token every time, regenerate as often as you like.
//
// WHAT THIS STAGE DOES NOT DO: compose the result onto the cover. That is stage two, and it touches
// all three cover paths at once. Splitting here means the LETTERING can be judged before anything is
// built on top of it -- which is the one open question about this feature that no amount of reading
// can answer. If nano-banana-2 cannot spell a six-word title reliably, that is far cheaper to learn
// now than after the composition work.
//
// THE WORDS COME FROM THE TARGET, NOT FROM THE USER. Since v3.0.638 they are genuinely read from
// the version being edited, exactly as every render path reads them. A client-supplied string would
// let the overlay say something the book does not, and the overlay is the thing a reader believes.
//
// A PLAIN WHITE GROUND IS DEMANDED IN THE PROMPT, then cut server-side. Both, not either: asking for
// transparency does not reliably produce it, and the cut is only tractable on a flat ground. This is
// the same pairing that made character references work in v3.0.559 plus v3.0.573.
//
// IMPERATIVE AND ABSOLUTE, because that register measurably outperforms description for this model
// (ART_STYLES_HANDOFF 8). Hence commands rather than an evocative paragraph.
router.post('/title-build', requireAuth, async function (req, res) {
  try {
    // v3.0.634 -- PLATINUM ONLY, AND CHECKED HERE AS WELL AS ON THE BUTTON. The modal refuses to
    // open for anyone else, but a button is a courtesy and a route is the rule.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const campaignId = req.body && req.body.campaignId;
    if (!campaignId) return res.json({ error: 'No campaign.' });
    const db = await getDb();
    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.json({ error: 'Campaign not found.' });

    // v3.0.638 -- THE WORDS NOW REALLY DO COME FROM THE TARGET. The note above this route has said
    // so since v3.0.617 while the line beneath it read req.body.bookTitle -- true only because the
    // client happened to send the right thing. Resolving the target answers it properly AND is what
    // lets a chapter draw its session name instead (TD-422).
    const tgt = await resolveTitleTarget(db, req, targetFromRequest(req, campaignId));
    if (tgt.error) return res.status(403).json({ error: tgt.error });
    const bookTitle = String((tgt.current.words && tgt.current.words.title) || campaign.name || '').trim();
    if (!bookTitle) return res.json({ error: 'This has no title yet. Name it first, then draw it.' });
    const subtitle = String((tgt.current.words && tgt.current.words.subtitle) || '').trim();
    const description = String((req.body && req.body.description) || '').trim();
    const refUrl = String((req.body && req.body.referenceUrl) || '').trim();

    const fal_key = process.env.FAL_API_KEY;
    if (!fal_key) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Add more to build a title.' });
    }

    // The subtitle is only mentioned when there IS one. An instruction to draw an empty string is how
    // a model ends up inventing words to fill it.
    // v3.0.618 -- REBUILT AROUND IAN REFERENCES. He sent six book titles -- silver, white, pale gold, a
    // red gradient -- every one LIGHT LETTERING ON A BLACK FIELD. Those looks exist BECAUSE of the dark
    // ground: the metallic edges and the glow have nothing to sit against on white. So the ground is
    // black now, and the cut that follows decides by connectivity rather than colour.
    //
    // AND THE REFERENCE FIGHTS BACK. A sheet of six titles is exactly the input that makes a model draw
    // STARLESS KINGDOM instead of the book title, so the split is stated twice and in both directions:
    // the LOOK comes from the reference, the WORDS come only from here.
    let words = 'Draw exactly this text and nothing else: "' + bookTitle + '".';
    if (subtitle) words += ' Underneath it, smaller, draw exactly: "' + subtitle + '".';
    const prompt = [
      'A book title logo: the words below drawn as ARTWORK, hand-lettered, not typed.',
      words,
      'Spell every word exactly as given, letter for letter.',
      refUrl ? 'Take the lettering style, the palette and any ornament from the reference image. Do NOT copy any words from the reference image -- use only the text given above.' : '',
      'Add no other text, no signature, no border, no frame, no page edges.',
      'Fill the frame with the lettering and centre it.',
      'Place it on a FLAT SOLID BLACK background, evenly lit, with nothing else on the background at all.',
      description ? ('Style direction: ' + description) : ''
    ].filter(Boolean).join(' ');

    // A reference steers the LOOK. It rides the same slot a character reference uses, so it costs no
    // extra call and contends with nothing -- there are no character refs on a title.
    // v3.0.619 -- {text, refs}, NOT a bare array. buildPanelInput reads charBlock.refs; a plain array
    // has no .refs, so the model never received Ian uploaded reference at all. It was not ignoring the
    // poster -- it was never sent one.
    const refBlock = refUrl ? { text: '', refs: [{ url: refUrl, name: 'the lettering reference' }] } : null;
    const seed = crypto.randomInt(1, 2147483647);

    // PANORAMIC, because a title band is far wider than it is tall and the model has no ratio closer.
    // Generating square and cropping later would waste most of the pixels the print size needs.
    // v3.0.622 -- THE UNCUT ORIGINAL IS KEPT, and the cut is now a SECOND step rather than a flag
    // handed to persistToR2. Ian asked for Retouch on a built title, and a retouch has to show the
    // model the picture it is editing -- but what we store is CUT, and a transparent PNG has no
    // background at all. Whatever fal paints behind the alpha is not ours to choose or to see.
    //
    // Reconstructing the ground was the alternative and it is very nearly exact -- the prompt above
    // demands a flat black field, so black is provably what the cut removed. Very nearly is the
    // problem: the cut RAMPS alpha across the letter edges, so those pixels are part ground by
    // construction and any repaint is an approximation of the thing we could simply have kept.
    //
    // So the generation is persisted UNCUT and cut afterwards into a second object. The cut one goes
    // on the cover; the original is what Retouch and Reference are handed. One extra stored file per
    // title, and persistToR2 -- which every image in the product goes through -- is not touched.
    const srcUrl = await generateImage(prompt, '', fal_key, refBlock, seed, modelKey, 'panoramic', null, false, null, {});
    const cutRes = await cutStoredTitle(srcUrl);

    // v3.0.622 -- Ian: "every call to FAL should cost the user a token." The call has been made by
    // this line, so refusing to answer would take the picture away AND still not charge for it. The
    // fix is therefore not to fail the request but to make a failed spend IMPOSSIBLE TO MISS: it goes
    // to the debug log the admin screen reads, not only to a Railway line nobody is watching. A free
    // image is a bug; a free image nobody ever hears about is the bug that lasts (TD-400).
    await chargeForTitleCall(req, cost, modelKey, 'title_build');

    // v3.0.619 -- SAY WHETHER THE GROUND CAME OFF. cutGroundToAlpha returns the ORIGINAL bytes when
    // it cannot find a ground -- which is right, but means a photographic reference yields an opaque
    // rectangle that looks exactly like every other result. The stored file is re-encoded as RGBA
    // only when the cut ran, so the colour type IS the answer, read back from the bytes rather than
    // inferred from what we asked for.
    // v3.0.622 -- TWO ANSWERS TO ONE QUESTION, AND BOTH ARE ASKED. cutStoredTitle knows whether the
    // cut function rewrote the buffer; imageHasAlpha reads the colour type back off the object that
    // was actually STORED. The first is what we authored, the second is what is painted, and the
    // second is the one a reader will meet. They are ANDed: a disagreement means something between
    // the cut and the bucket lost the alpha, and that is a failure, not a success.
    let cutOk = null;
    try { cutOk = await imageHasAlpha(cutRes.url); } catch (e) {}
    if (cutRes.cut && cutOk === false) {
      console.error('title-build: cut ran but the stored object has no alpha channel -- ' + cutRes.url);
    }
    const cutFinal = (cutOk === null) ? cutRes.cut : (cutRes.cut && cutOk);
    return res.json({ image: cutRes.url, source: srcUrl, title: bookTitle, subtitle: subtitle, cut: cutFinal });
  } catch (e) {
    console.error('title-build error:', e && e.message);
    return res.json({ error: friendlyImageError(e) });
  }
});

// Read the stored PNG header and report whether it carries an alpha channel. Colour type 6 is RGBA,
// which our cut is the only thing that produces here -- fal returns type 2. Cheap: it reads the
// first bytes, not the image.
async function imageHasAlpha(url) {
  try {
    const axios = require('axios');
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, headers: { Range: 'bytes=0-63' }, validateStatus: function (s) { return s === 200 || s === 206; } });
    const b = Buffer.from(r.data);
    if (b.length < 26 || b[0] !== 0x89 || b[1] !== 0x50) return null;   // not a PNG: cannot tell
    return b[25] === 6 || b[25] === 4;                                  // IHDR colour type byte
  } catch (e) { return null; }
}
// POST /api/images/title-retouch -- CHANGE ONE THING ABOUT A BUILT TITLE (TD-405).
//
// Ian, 2026-08-10: "Add the Retouch to it as well! That's how we get the new lettering for the
// subtitle." The case is THE ANOMALIES / Episode 1 becoming THE ANOMALIES / Episode 2 -- and a
// reference cannot do that job, because a reference carries the LOOK and this needs the artwork.
//
// SYNCHRONOUS, unlike every other Retouch in the product. Panel, character and asset retouches go to
// fal's queue and come back through the webhook with an image_jobs row, because a panel edit is slow
// enough to time out a request. This one matches its own neighbour instead: Generate in this modal
// already blocks and returns the picture, and making Retouch behave differently from the button next
// to it would be a worse answer than the plumbing it saves.
//
// THE PICTURE IS NOT NAMED BY THE CALLER. It is read from the version on screen, by the owner of that
// version, through resolveTitleTarget -- otherwise any URL at all could be pushed through fal on
// this user's token.
router.post('/title-retouch', requireAuth, async function (req, res) {
  try {
    // v3.0.634 -- PLATINUM ONLY, AND CHECKED HERE AS WELL AS ON THE BUTTON. The modal refuses to
    // open for anyone else, but a button is a courtesy and a route is the rule.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    const campaignId = req.body && req.body.campaignId;
    if (!campaignId) return res.json({ error: 'No campaign.' });
    const instruction = String((req.body && req.body.instruction) || '').trim();
    if (!instruction) return res.json({ error: 'Describe the change you want.' });

    const db = await getDb();
    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) return res.json({ error: 'Campaign not found.' });

    const own = await resolveTitleTarget(db, req, targetFromRequest(req, campaignId));
    if (own.error) return res.status(403).json({ error: own.error });
    // v3.0.729 -- TD-527. THE DRAFT WINS, BECAUSE THE DRAFT IS WHAT THE READER CAN SEE.
    // It lives INSIDE current rather than beside it -- app.js has read d.current.draft since
    // v3.0.656, so that is the established shape. A first cut of this fix read own.draft and would
    // have done nothing at all for a chapter, which is the case Ian was actually testing.
    // Falling back to the live title keeps Retouch working on a book promoted in an earlier
    // session with no draft; the result still returns as a draft, because retouching straight
    // onto the cover would put artwork there that nobody approved.
    const _rtDraft = (own.current && own.current.draft) || null;
    const _rtSrc = (_rtDraft && (_rtDraft.url || _rtDraft.src)) ? _rtDraft : own.current;
    if (!_rtSrc.url && !_rtSrc.src) return res.json({ error: 'There is no built title to retouch yet. Generate one first.' });

    const fal_key = process.env.FAL_API_KEY;
    if (!fal_key) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Add more to retouch a title.' });
    }

    // The uncut original when we have one, else the cut image with its ground painted back on.
    const input = await titleModelInput(_rtSrc.src, _rtSrc.url);
    if (!input.url) return res.json({ error: 'There is no built title to retouch yet. Generate one first.' });

    // IMPERATIVE AND ABSOLUTE, the same register the generate prompt uses. The ground instruction is
    // repeated because the cut that follows depends on it: an edit that quietly returns a scene, a
    // gradient or a vignette is an edit whose ground cannot be found, and the result is an opaque
    // rectangle on the cover.
    const editPrompt = [
      'You are editing an EXISTING book title logo, provided as Image 1.',
      'Reproduce it EXACTLY -- identical lettering style, letterforms, weight, palette, ornament, texture and layout -- and change ONLY the following, leaving everything else untouched:',
      instruction,
      'Keep the background a ' + TB_REF_BACK.name + ' field, evenly lit, with nothing else on it at all.',
      'Add no other text, no signature, no border, no frame and no page edges.'
    ].join(' ');

    fal.config({ credentials: fal_key });
    const result = await fal.subscribe(IMAGE_EDIT_MODELS.nano2, {
      input: {
        prompt: editPrompt,
        image_urls: [input.url],
        num_images: 1,
        aspect_ratio: shapeAspectRatio('panoramic'),
        output_format: 'png',
        safety_tolerance: '5',
        resolution: '1K'
      }
    });
    if (!result.data || !result.data.images || !result.data.images[0]) {
      throw new Error('No image returned from fal.ai');
    }
    const srcUrl = await persistToR2(result.data.images[0].url, {});
    const cutRes = await cutStoredTitle(srcUrl);

    await chargeForTitleCall(req, cost, modelKey, 'title_retouch');

    let cutOk = null;
    try { cutOk = await imageHasAlpha(cutRes.url); } catch (e) {}
    if (cutRes.cut && cutOk === false) {
      console.error('title-retouch: cut ran but the stored object has no alpha channel -- ' + cutRes.url);
    }
    const cutFinal = (cutOk === null) ? cutRes.cut : (cutRes.cut && cutOk);
    return res.json({ image: cutRes.url, source: srcUrl, cut: cutFinal });
  } catch (e) {
    console.error('title-retouch error:', e && e.message);
    return res.json({ error: friendlyImageError(e) });
  }
});

// GET /api/images/proxy -- stream one of OUR OWN stored images from our own
// origin. Strictly limited to R2_PUBLIC_URL: an open fetcher would be an SSRF
// hole, and this exists only so a canvas can read a panel it is already showing.
router.get('/proxy', requireAuth, async function (req, res) {
  try {
    const u = String(req.query.u || '');
    const base = process.env.R2_PUBLIC_URL || '';
    if (!base || !u || u.indexOf(base + '/') !== 0) return res.status(400).send('bad url');
    const r = await fetch(u);
    if (!r.ok) return res.status(502).send('upstream ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (e) {
    return res.status(500).send('proxy failed');
  }
});

// POST /api/images/marked -- store a marked overlay and return its URL. No
// generation and no token: this only persists a diagram so the next retouch
// can point at it.
router.post('/marked', requireAuth, guardUpload(markedUpload, 'marked'), async function (req, res) {
  try {
    if (!req.file || !req.file.buffer) return res.json({ error: 'No image received.' });
    const name = 'marked-' + req.session.userId + '-' + Date.now() + '.png';
    const url = await uploadFile(req.file.buffer, name, 'image/png');
    return res.json({ url: url });
  } catch (e) {
    console.error('marked upload failed:', e && e.message);
    return res.json({ error: 'Could not store that overlay.' });
  }
});

// POST /api/images/title-ref -- store ONE reference image for the Title Builder and return its URL.
// Ian: "the plan would be to drop an image in there that had lettering similar to what I want my title
// to look like." A URL field alone could not serve that -- the images he wants to use are on his disk.
// No generation, no token: this only persists a file so the generator can look at it.
router.post('/title-ref', requireAuth, guardUpload(titleRefUpload, 'title-ref'), async function (req, res) {
  try {
    // v3.0.634 -- PLATINUM ONLY, AND CHECKED HERE AS WELL AS ON THE BUTTON. The modal refuses to
    // open for anyone else, but a button is a courtesy and a route is the rule.
    if (!(await isTruePlatinum(req.session.userId))) {
      return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    }
    if (!req.file || !req.file.buffer) return res.json({ error: 'No image received.' });
    const ct = req.file.mimetype || 'image/png';
    const ext = ct.indexOf('jpeg') !== -1 ? 'jpg' : ct.indexOf('webp') !== -1 ? 'webp' : ct.indexOf('gif') !== -1 ? 'gif' : 'png';
    const name = 'titleref-' + req.session.userId + '-' + Date.now() + '.' + ext;
    const url = await uploadFile(req.file.buffer, name, ct);
    return res.json({ url: url });
  } catch (e) {
    console.error('title-ref upload failed:', e && e.message);
    return res.json({ error: 'Could not store that image.' });
  }
});

// Backfill true pixel dimensions for existing moment images. The image model returns null
// width/height, so older images stored the NOMINAL shape aspect (e.g. a portrait "Standard"
// saved as 4:3) -- which crops them via object-fit:cover. This measures each image's real
// bytes and stores true img_w/img_h so every box fits its image. Admin-only; batched and
// resumable via ?limit= and ?onlyNull=1 (default measures ALL to correct synthetic values too).
router.post('/backfill-dims', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200));
    const onlyNull = (req.query.onlyNull === '1' || req.query.onlyNull === 'true');
    const where = onlyNull ? 'image IS NOT NULL AND (img_w IS NULL OR img_h IS NULL)' : 'image IS NOT NULL';
    const rows = await db.prepare('SELECT id, image, img_w, img_h FROM moments WHERE ' + where + ' ORDER BY id ASC LIMIT ?').all(limit);
    let measured = 0, changed = 0, failed = 0;
    const now = new Date().toISOString();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const dims = await measureImageDims(r.image);
      if (!dims || !(dims.width > 0) || !(dims.height > 0)) { failed++; continue; }
      measured++;
      if (Number(r.img_w) === dims.width && Number(r.img_h) === dims.height) continue;   // already correct
      try {
        await db.prepare('UPDATE moments SET img_w = ?, img_h = ? WHERE id = ?').run(dims.width, dims.height, r.id);
        changed++;
      } catch (e) { failed++; }
    }
    return res.json({ scanned: rows.length, measured: measured, changed: changed, failed: failed, limit: limit, onlyNull: onlyNull, note: 'Re-run with a higher offset/limit if scanned == limit (more may remain). Re-optimize books afterward so boxes rebuild to the true image aspect.' });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'backfill-dims failed' });
  }
});
module.exports = router;
module.exports.generateReferenceImage = generateReferenceImage;
// v3.0.586 -- TD-345(d). extract.js writes the marker; this file reads it. ONE definition.
module.exports.charPromptWithHeight = charPromptWithHeight;
module.exports.charSplitHeight = charSplitHeight;
module.exports.charHeightPhrase = charHeightPhrase;
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
module.exports.submitAssetReference = submitAssetReference;
module.exports.submitEditReference = submitEditReference;
module.exports.submitRetouch = submitRetouch;
