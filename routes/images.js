const express = require('express');
const genresvc = require('../services/genres');   // v3.0.488 -- stage 4, campaign prompt at GENERATION time
const assetSuggest = require('../services/assetSuggestions');   // v3.1.9 -- TD-908 recurring-element notes
const router = express.Router();
const { requireAuth, getCampaignRole, requireAdmin, isAdminEmail } = require('../middleware/auth');   // v3.4.13 -- isAdminEmail
const { getTier, getEffectiveTier, isTruePlatinum, tierRank, accessRank, artStyleAllowed } = require('../middleware/tiers');
const { getDb, getDmForkId, resolveActingFork, requestedForkIdOf, forkSelfIllustrated } = require('../database/db');   // v3.0.636 -- the prefs helpers left with resolveOwnBuiltTitle
const { releaseImage, persistToR2, fetchFile, isOurPublicUrl, deleteFile } = require('../storage/storage');   // deleteFile: v3.2.66, TD-1006   // isOurPublicUrl: v3.1.85, TD-954
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
const rightsCheck = require('../services/rightsCheck');   // v3.1.90 -- TD-979
// v3.1.90 -- TD-979. THE ONE QUERY FOR ASSET REFERENCES. Six places loaded campaign assets with the same
// SQL (three here, three in sessions.js); they now share this, so an asset whose picture is REJECTED
// (a watermark or a stock picture, image_rights) comes back with no image_url. buildAssetBlock already
// skips an asset with no picture, so it is left out of every generation and every reference picker
// until its picture is replaced -- and the previews cannot disagree with what is generated.
const ASSET_REF_SQL = "SELECT a.id, a.name, a.category, CASE WHEN r.id IS NULL THEN a.image_url ELSE NULL END AS image_url " +
  "FROM campaign_assets a LEFT JOIN image_rights r ON r.image_url = a.image_url AND r.verdict = 'reject' WHERE a.campaign_id = ?";
const titleRefUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');
// v3.0.757 -- the marked overlay: the same panel with the reader's rings drawn
// on it, used by the image model as a LOCATION diagram only. Same multer shape.
const markedUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');
// v3.1.14 -- TD-909. HEIC to JPEG for the BROWSER. Chrome and Edge cannot display a HEIC, so a
// picked iPhone photo would preview as a broken image. The page sends it here first and swaps in the
// JPEG, so the preview and the later upload are both the JPEG. guardUpload does the conversion.
const heicUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 }, fileFilter: imageFileFilter }).single('image');

// Async image generation (fal queue + webhook). PUBLIC_BASE_URL is the app's
// public origin for THIS environment (set in Railway), e.g. https://campaignia.com
// or https://chronicle-staging.up.railway.app. fal posts results back there.
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
while (PUBLIC_BASE_URL.length && PUBLIC_BASE_URL.charAt(PUBLIC_BASE_URL.length - 1) === '/') PUBLIC_BASE_URL = PUBLIC_BASE_URL.slice(0, -1);
function falWebhookUrl() { return PUBLIC_BASE_URL ? (PUBLIC_BASE_URL + '/api/images/webhook/fal') : ''; }

// v3.3.69 -- TD-1031 / TD-1032. WHAT FAL KEEPS. fal stores every request's JSON (our prompts and its
// results) for its request history unless told not to, and keeps the generated picture on its CDN for
// its own default period unless told otherwise. fal's written answer of 2026-10-26: X-Fal-Store-IO 0 stops the first, and
// X-Fal-Object-Lifecycle-Preference sets the second per request. Neither is a dashboard setting for us.
// EVERY FAL CALL IN THIS FILE GOES THROUGH falSetup, so no call can leave without the headers (the
// v3.3.69 guard counts the raw client set-up call and allows exactly one, the one below).
// The headers go on POST only: the queue submit, which fal.subscribe also uses. The status checks
// and the result read are GETs and are left alone. With storage off fal still keeps a finished result
// for at least 6 minutes (its queue docs), and fal.subscribe reads it within seconds of completion;
// the queued calls get theirs in the webhook body and never read it back.
// 30 days, not shorter: persistToR2 keeps the fal address when the copy to R2 fails, and an expiry
// turns that failure into a missing picture (TD-1032). Shorten only after that fallback is changed.
// Railway switches, read at start-up: FAL_STORE_IO=1 lets fal store payloads again; FAL_CDN_EXPIRY_DAYS
// sets the days (unset = 30; 0, off or blank = no expiry header, fal's own default).
const FAL_STORE_IO_ALLOWED = String(process.env.FAL_STORE_IO || '').trim() === '1';
const FAL_CDN_EXPIRY_DAYS = (function () {
  const raw = process.env.FAL_CDN_EXPIRY_DAYS;
  if (raw === undefined) return 30;
  const n = Number(String(raw).trim());
  return (isFinite(n) && n > 0) ? n : 0;
})();
function falExtraHeaders() {
  const h = {};
  if (!FAL_STORE_IO_ALLOWED) h['x-fal-store-io'] = '0';
  if (FAL_CDN_EXPIRY_DAYS > 0) h['x-fal-object-lifecycle-preference'] = JSON.stringify({ expiration_duration_seconds: Math.round(FAL_CDN_EXPIRY_DAYS * 86400) });
  return h;
}
function falRequestMiddleware(request) {
  if (String(request && request.method || '').toUpperCase() !== 'POST') return Promise.resolve(request);
  return Promise.resolve(Object.assign({}, request, { headers: Object.assign({}, (request && request.headers) || {}, falExtraHeaders()) }));
}
function falSetup(key) {
  fal.config({ credentials: key, requestMiddleware: falRequestMiddleware });
}
console.log('[fal] payload storage ' + (FAL_STORE_IO_ALLOWED ? 'ON (FAL_STORE_IO=1)' : 'off (X-Fal-Store-IO 0)') + '; CDN expiry ' + (FAL_CDN_EXPIRY_DAYS > 0 ? FAL_CDN_EXPIRY_DAYS + ' days' : 'not sent (fal default)'));

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

// v3.2.71 -- always Nano (Ian, 2026-10-25). The dashboard's Image Generation Model setting is gone; which Nano is
// called is the Railway variable (config/models.js). The old app_settings 'image_model' row is no longer read.
// Kept as a function (async, taking db) so its eighteen callers are unchanged.
async function getSelectedModel(db) {
  return 'nano2';
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
// v3.2.22 -- Watercolor joins the fade styles (Ian, 2026-10-20: "it's full bleed... I don't think it should be").
// Its card always promised loose edges; it was simply never on this list. Tested as a custom style with Soft edges on.
var FADE_STYLES = { 'Fantasy oil painting': 1, 'Fantasy pastel': 1, 'Charcoal drawing': 1, 'Classic pen and ink': 1, 'Watercolor painterly': 1 };
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
// v3.2.22 -- ANIME LEAVES THE COMIC SIDE. The new Anime paragraph is a soft, glowing, digitally PAINTED look
// (Ian's examples, 2026-10-20), and it was tested as a custom style -- which is neutral, so it was drawn by a
// "narrative illustrator" as one UNIFIED picture. Left here it would be told "graphic-novel illustrator" and
// "DRAWN", the line-art pull TD-634 documents. The other three keep the v3.0.814 wording exactly.
var COMIC_STYLES = { 'High fantasy illustration': 1, 'Dark gritty comic book': 1, 'Comic book cel-shaded': 1 };
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

// v3.0.821 -- TD-654. THE MODEL SIGNS THE PICTURE AND NOTHING SAID NOT TO.
// A fabricated artist signature printed in a customer's book (panel 22 of
// "The Strangers"). All 36 interiors were corner-scanned and it was the only
// one -- which is the danger: one in thirty-six clears a page-turn review
// every time, and then it is on paper. NO_BORDER governs edges and bars,
// IP_GUARD_IMG governs other people's IP; nothing governed marks.
//
// IN-WORLD TEXT IS DELIBERATELY EXEMPT. A ban on "text" would take carved
// runes, tavern signs, banners and the page of an open book with it, and
// fantasy panels are full of those. The rule is about a mark laid ON TOP of
// the artwork, not about what the depicted world contains.
//
// NOT the place for an "AI" corner mark. Tiny legible text is the least
// reliable thing a diffusion model can be asked for -- it arrives as a smudge,
// in a different corner each time. If that mark is wanted it is stamped at
// layout time, where it is exact, identical on every plate and switchable.
//
// RETOUCH IS NOT COVERED: retouchImage() does not call buildPanelInput. A
// retouch preserves the image it is given, so it cannot introduce a mark that
// was not already there -- but it cannot remove one either.
// v3.3.83 -- an Image Builder picture with a title its maker typed: the same rule, except the one title asked for.
var NO_MARKS_TITLED = ' NO ARTIST MARKS: never sign the artwork. Do NOT add a signature, artist\'s mark, monogram, initials, watermark, stamp, seal, logo, date or credit anywhere in the image, in any corner or along any edge. The ONLY lettering laid over the picture is the title the prompt asks for, spelled exactly as given.';
var NO_MARKS = ' NO ARTIST MARKS: never sign the artwork. Do NOT add a signature, artist\'s mark, monogram, initials, watermark, stamp, seal, logo, date, caption, title, or credit anywhere in the image, in any corner or along any edge. Text that genuinely belongs to the scene itself \u2014 a sign, a banner, runes carved in stone, writing on an open page \u2014 is fine; a mark laid on top of the picture is not.';

// v3.2.52 -- TD-966. A CUSTOM STYLE'S COMIC PAGE AND SOUND EFFECTS (Ian, 2026-10-23: "In picture Panels.. comic style",
// "in picture sound effects only... (no other text)", "Yes on the Black Gutters only"). Read from the style's SAVED
// answers to questions 19 and 20, not from its description, so the rules hold whatever the description says. They
// reach buildPanelInput as an OBJECT in the isFadeOverride slot ({ fade, panels, sfx }); a style without them still
// passes true / false / null exactly as before, so every other picture's prompt is byte-for-byte unchanged.
//
// Ian's book "Marooned on Chult" (a panels instruction written into the style text) showed why: the edge-to-edge
// NO_BORDER rule fought the black gutters (some came out white), and the scene description was lettered into a
// caption box. COMIC_PAGE replaces NO_BORDER; NO_LETTERING / SFX_ONLY tighten NO_MARKS.
var COMIC_PAGE = ' COMIC PAGE LAYOUT: compose this image as ONE comic-book page divided into several panels inside it, ' +
  'arranged as the art style describes (if it gives no arrangement: 3 to 6 panels of varied sizes, one large hero panel ' +
  'carrying the main moment, the others showing details, close-ups or the moments just before or after; inset panels may ' +
  'overlap a larger one). Separate every panel with solid BLACK gutters and black panel borders, never white, cream or ' +
  'coloured, with a thin black border around the whole page; the artwork inside each panel runs to that panel\'s border. ' +
  // v3.2.53 -- Ian's first previews: the Group page left white page showing below its hero panel. Gutters were black, but
  // the page background was never said, so the model left it as blank paper.
  'The page itself is black: any space not covered by a panel is solid black, never white or blank paper; the panels ' +
  'tile the whole image with no empty area. ' +
  'Every person who appears in more than one panel is the SAME person each time, with an identical face, hair, build, ' +
  'clothing and gear, matching their reference. Do not add people, creatures or characters the scene does not call for ' +
  'to fill extra panels.';
var NO_LETTERING = ' NO LETTERING: no caption boxes, narration boxes, titles, speech or thought balloons, sound effects, ' +
  'labels or any other written words laid over the picture, in any panel. Never write any part of the scene description ' +
  'into the picture.';
var SFX_ONLY = ' SOUND EFFECTS ONLY: you may draw bold, hand-lettered comic sound effects (short onomatopoeia such as BOOM, ' +
  'CRACK or KRAK) worked into the art where the action makes a sound, spelled correctly. NO other text of any kind: no ' +
  'caption boxes, narration, titles, speech or thought balloons or labels, and never any part of the scene description ' +
  'written into the picture.';
function styleFlagOn(answer) {
  var a = String(answer == null ? '' : answer).trim();
  if (!a) return false;
  return !/^(none|no\b|n\/a|nothing|not\b|single\b|one\s+(single\s+)?(picture|image|panel)\b|1\s+(picture|image|panel)\b)/i.test(a);
}
function styleFlags(answers) {
  var a = answers;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
  if (!a || typeof a !== 'object') return { panels: false, sfx: false };
  return { panels: styleFlagOn(a.panels), sfx: styleFlagOn(a.sfx) };
}

function buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText) {
  var ar = shapeAspectRatio(shape);
  var flux = shapeFluxSize(shape);
  var _flags = (isFadeOverride && typeof isFadeOverride === 'object') ? isFadeOverride : null;   // v3.2.52 -- TD-966
  var _fadeIn = _flags ? _flags.fade : isFadeOverride;
  var _fade = (_fadeIn === true || _fadeIn === false) ? _fadeIn : isFadeStyle(style);
  var _panels = !!(_flags && _flags.panels), _sfx = !!(_flags && _flags.sfx);
  var edgeDirective = _panels ? COMIC_PAGE : (_fade ? FADE_WHITE : NO_BORDER);
  var marksDirective = ((_flags && _flags.titled) ? NO_MARKS_TITLED : NO_MARKS) + (_sfx ? SFX_ONLY : (_panels ? NO_LETTERING : ''));   // v3.3.83 -- titled: Image Builder only
  // v3.3.71 -- TD-1080. noCandid: an Image Builder poster, portrait or token may face the viewer. Panels never set it.
  var hint = ((_flags && _flags.noCandid) ? '' : COMPOSITION_IMG) + RANGED_ATTACK_IMG + shapeCompHint(shape) + edgeDirective + marksDirective;
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
    'this art style.' + edgeDirective + marksDirective + ' The required art style is: ' + stylePrefix;
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
        if (r.category === 'scene') return n + ' is an earlier moment from this story, "' + r.name + '"' + ((r.people && r.people.length) ? ', showing ' + r.people.join(', ') : '') + '. ' + (r.note || '') + ' Redraw it in this picture\u2019s art style.';   // v3.4.19 -- TD-1095, Image Builder only
        if (r.category === 'plan') return n + ' is a flat, top-down plan of the place "' + r.name + '". It is not an object in the scene and is never drawn itself: use it only for the layout of the place you draw.';   // v3.4.11 -- TD-1091, Map to Scene only
        return n + ' is a reference for "' + r.name + '".';
      }
      return n + ' is the reference for ' + r.name + '.';
    }).join(' ') + (charRefs.some(function (r) { return r && r.isAsset && r.category === 'plan'; }) ? ' The plan is the one exception to the rules below: draw the real place it describes, never the plan itself, its paper or anything it lies on.' : '') + (charRefs.some(function (r) { return r && r.isAsset && r.category === 'scene'; }) ? ' The earlier moments are scene references: use each one only as its own line above says, never copying its art style.' : '');   // v3.4.11; v3.4.19 -- scenes
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
      'Draw this ' + _voice.panel + ': ' + prompt + charSectionTrim + assetSection + hint + styleFinal;
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
      prompt: IP_GUARD_IMG + rosterDirective + prompt + charSection + hint + styleFinal,
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

  // v3.0.824 -- TD-658. THE ART STYLE NOW RIDES IN BOTH CHANNELS, NOT ONE.
  //
  // Ian: "We need to make sure that every image gets the art style, period."
  // Measured rate before this change: about one image in three off-style.
  //
  // WHAT THIS LINE USED TO BE THE WHOLE OF. styleFinal was built for every panel
  // and then handed ONLY to the Flux branch, so on nano2 -- which is what
  // production runs -- the art style existed in system_prompt and NOWHERE ELSE.
  // The /edit body merely POINTED at it ("the unified art style for this image
  // (provided as a separate style instruction)"), and the text-to-image body did
  // not mention style at all. Everything rested on one field.
  //
  // WHAT PROVED IT. A wagon-camp panel with NO characters and NO assets -- no
  // reference images of any kind, so the text-to-image branch, so a prompt body
  // with not one word about art style -- came back a flat inked cartoon. Ian
  // regenerated the identical scene and got a fully painted, low-key, atmospheric
  // version. SAME PROMPT, DIFFERENT SAMPLE. Not content, not the references, not
  // the palette: a one-channel instruction honoured intermittently.
  //
  // IT COULD ALSO BE server-side truncation of system_prompt at fal, which we
  // cannot observe -- the debug log records what we SENT, and that was complete
  // and correct every time. From outside, "dropped" and "weakly honoured" are
  // indistinguishable, AND THEY DO NOT NEED DISTINGUISHING: stating the style in
  // the body as well defeats both.
  //
  // WHY TD-649 DID NOT ALREADY CATCH THIS. channel-ab.js measured body-above
  // VERSUS system and Ian called them "about even", so the swap was dropped.
  // Nobody tested body AND system, which is strictly more signal than either --
  // and that A/B took ONE sample per cell, so it could not have detected an
  // intermittent fault even had it been the right comparison. Measure a RATE.
  //
  // ADDITIVE, NOT A SWAP. system_prompt is unchanged and still carries the style;
  // styleFinal is now appended to both nano2 prompt bodies as well, where it lands
  // LAST -- which in the /edit branch is the only position after a reference block
  // that declares itself HIGHEST PRIORITY. styleFinal is '' when there is no style
  // prefix, so a styleless render is byte-identical to before. Flux is untouched:
  // it has always had styleFinal in its body and has no system_prompt at all.
  //
  // thinking_level is off unless the env dial is set -- the hook for a future
  // "Render quality" campaign setting.
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
  falSetup(falKey);
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
// v3.1.9 -- TD-908. THE "NO" HALF OF SUGGESTED ASSETS. Ian: "on a No... add the description of the
// item to the prompt for the panel. It just uses the panel's prompt text from there." Generate Story
// stores its suggestions on the version; any suggestion WITHOUT a live asset is described in words on
// the panels that name it, so it is drawn the same way every time. Two call sites, both below:
// single Regenerate and Generate Images. Retouch is deliberately NOT one of them, for the reason the
// campaign prompt is not (buildPanelInput): a retouch changes one thing and keeps the rest.
// A read fault returns no suggestions, which is exactly the behaviour before this feature.
async function loadAssetSuggestions(db, forkId) {
  try {
    const r = await db.prepare('SELECT asset_suggestions FROM session_forks WHERE id = ?').get(forkId);
    return assetSuggest.parseStored(r && r.asset_suggestions);
  } catch (e) { return assetSuggest.parseStored(null); }
}
var ASSET_SUGGEST_MATCHERS = { assetNameMatches: assetNameMatches, characterNameMatches: characterNameMatches };

function applyMomentDirection(basePrompt, dirText) {
  if (!dirText) return basePrompt || '';
  return (basePrompt || '') + '\n\nDIRECTOR STEERING (you MUST follow this): ' + dirText;
}

async function submitPanelGen(prompt, style, falKey, charBlock, seed, modelKey, webhookUrl, shape, thinkingLevel, isFadeOverride, campaignPromptText) {
  falSetup(falKey);
  const built = buildPanelInput(prompt, style, charBlock, seed, modelKey, shape, thinkingLevel, isFadeOverride, campaignPromptText);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model, prompt: built.input.prompt, system_prompt: built.input.system_prompt || '' };
}

// retouchImage: in-context edit. Feed the CURRENT panel image back in as the
// SOLE reference and tell the model to keep everything identical except the
// one requested change. Always uses Nano Banana 2 /edit (the only model that
// conditions on an input image).
async function retouchImage(currentImageUrl, instruction, style, falKey, shape) {
  falSetup(falKey);
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
  falSetup(falKey);
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
    var sess = await db.prepare('SELECT session_date, sort_order FROM sessions WHERE id = ?').get(sessionId);
    if (!sess) return;
    var _pos = (sess.sort_order != null) ? Number(sess.sort_order) : null;   // v3.4.91 -- TD-933: earlier means earlier in the list
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
          'WHERE sc.character_id = ? AND sf.version_id = ? AND ' + (_pos != null ? 's.sort_order < ? ' : 's.session_date < ? ') +
          'AND sc.reference_url IS NOT NULL ' +
          'ORDER BY s.sort_order DESC, s.session_date DESC, sf.id DESC LIMIT 1'
        ).get(c.character_id, versionId, (_pos != null ? _pos : sess.session_date));
      }
      if (!prior) {
        // FALLTHROUGH to the canonical, the same rule the book itself uses for a session this
        // version has not branched.
        prior = await db.prepare(
          'SELECT sc.reference_url FROM session_characters sc ' +
          'JOIN session_forks sf ON sf.id = sc.fork_id ' +
          'JOIN sessions s ON s.id = sf.session_id ' +
          "WHERE sc.character_id = ? AND sf.role = 'dm' AND s.campaign_id = ? AND " + (_pos != null ? 's.sort_order < ? ' : 's.session_date < ? ') +
          'AND sc.reference_url IS NOT NULL ' +
          'ORDER BY s.sort_order DESC, s.session_date DESC LIMIT 1'
        ).get(c.character_id, campaignId, (_pos != null ? _pos : sess.session_date));
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
    // v3.0.836 -- TD-681. HIGH FANTASY WITHOUT THE FANTASY, and this is the whole reason
    // it exists. Read the paragraph above: "Epic high fantasy", "fantasy concept art and
    // book covers", "heroic compositions". None of those describe a TECHNIQUE -- they
    // describe SUBJECT MATTER, and the model is relentlessly literal (the v3.0.815 lesson).
    // Asked for a fantasy book cover it produced a real boy at a real dentist inside a
    // stone castle, with Celtic knotwork on the walls, RUNES on the monitors and an
    // apothecary shelf labelled NUMBING SALVES. Ian, 2026-09-09, on the Watercolor control:
    // "I tried Water Color and didn't get all the Fantasy stylings. It looked great."
    //
    // So this keeps every technique word from High fantasy and drops every genre word.
    // High fantasy itself is DELIBERATELY UNTOUCHED -- it is the look most of the product
    // depends on and there is no reason to disturb it.
    //
    // NO PERIOD IS NAMED, deliberately. A Family Story is often historical -- Ian's own
    // example was a farm in 1961 -- so "present-day" would be wrong on exactly the genre
    // that needs this style. Name the CLASS (the real world, as it actually is) and let the
    // scene supply the period, which is the same rule the Dark Fantasy atmosphere clause
    // follows for airborne matter.
    // AND IT IS WRITTEN ENTIRELY IN THE POSITIVE. The first draft ended "no fantasy
    // architecture, no runes or heraldry, no heroic framing" and the guard rejected it --
    // correctly. TD-552 rule 4: these models ADD reliably and SUBTRACT unreliably, and the
    // v3.0.821 atmosphere clause is on record that naming snow puts snow in the tavern.
    // Forbidding runes is a way to get runes. So every clause here names what to PAINT --
    // printed signage, plain materials, an unposed moment -- and the fantasy simply has
    // nowhere to attach.
    'Everyday life illustration': 'STYLE: Richly painted illustration of the real world. Painterly, highly detailed, natural cinematic lighting, rich true-to-life colour, fully realised backgrounds. Every place, object, vehicle, garment and surface is an ordinary one that genuinely exists, drawn exactly as it really looks, with the period and setting taken from the scene itself. Plain everyday materials and finishes throughout \u2014 painted walls, plastic, glass, metal, fabric, printed signage and ordinary lettering. An unposed, ordinary moment, painted well.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Dark gritty comic book': 'STYLE: Dark gritty comic book art. Heavy ink lines, deep shadows, high contrast black and white with selective color, noir atmosphere. Stark graphic shapes: large slabs of solid black that swallow whole areas of the figures and background, chunky simplified forms, bold silhouettes and hard-edged shadow shapes, with only a few key details picked out. Gritty textures, dramatic angles.',
    // v3.2.22 -- the edge sentence Ian tested 2026-10-20 (custom style, Soft edges on). Rest unchanged.
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Watercolor painterly': 'STYLE: Beautiful loose watercolor illustration. Soft wet-on-wet washes, organic flowing color, artistic brushwork, warm earthy tones, delicate linework. Painterly and expressive, like a fantasy storybook, in the tradition of classic plein-air watercolor: confident, economical brushstrokes, luminous transparent washes, and the white of the paper left showing for highlights. The washes bloom and bleed into soft, irregular edges toward the sides of the picture and do NOT reach the frame; everywhere the paint does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a watercolor painted straight onto a clean white page.',
    // v3.2.22 -- ANIME REWRITTEN FROM IAN'S EXAMPLES AND TESTS (2026-10-20). The old paragraph named the QUALITY of
    // anime and not its LOOK, so faces came out as Western comic faces. This names the conventions -- big gem-like
    // eyes on EVERY character (without that sentence only the young woman got them: anime's own convention), soft
    // painted shading, coloured cinematic light, haze and bloom. No studio is named. Twelve runs through fal with
    // and without the IP guard showed the guard is not what held it back (6/6 on-style with it; one of six without
    // it came back photographic), so the guard is unchanged. Small faces in wide group shots stay small: the look
    // shows best in closer shots.
    'Anime manga style': 'STYLE: Polished modern anime illustration, digitally painted in the glossy, luminous look of contemporary anime key art and light-novel covers. Draw every face with strong anime conventions: huge, glistening eyes, about a third of the height of the face, with layered, gem-like irises in vivid colour, several bright white catch-lights and long upper lashes; small, simple noses; small mouths; smooth, softly blushed cheeks; and slim, graceful proportions. Give every character the same large, sparkling anime eyes \u2014 men, women, young and old alike \u2014 so the whole cast shares one look. Every character keeps the age the scene gives them, drawn in this style. Hair flows in long, silky, sculpted locks with glossy ribbons of shine and fine strands catching the light. Render with soft, airbrushed painted shading and thin, delicate linework that melts into the colour. Light is the star of every picture: strong, cinematic and coloured. A bright light from behind turns the edges of hair, faces and shoulders into glowing rims; every screen, lamp, sign and flame casts its own coloured light onto the faces and hands nearest to it; the lit side of each face is bright and the far side falls into deep, coloured shadow. The air holds a soft, glowing haze, the brightest lights bloom and flare gently as if seen through a camera lens, and a few tiny motes of light drift in the air. A dreamy, vivid palette of saturated jewel tones and soft pastels, rich with pinks, purples, teals and glowing golds. Backgrounds are detailed and softly lit, with shallow depth of field that blurs the far distance. Sweet, expressive, emotional and charming.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Classic pen and ink': 'STYLE: Classic pen and ink illustration with sepia wash. Fine crosshatching, detailed linework on a clean white (#ffffff) background, reminiscent of vintage fantasy book illustrations of the early twentieth century. Intricate detail. Colour is limited to warm sepia and brown ink washes with only the faintest touches of muted tint. The drawing is a vignette that stops short of the frame on every side: toward its edges the linework and wash thin out into loose, broken hatching and fade away completely, leaving a margin of clean, smooth, PURE WHITE (#ffffff) all around, with no tint, no cream or aged paper tone, no drawn box, frame or border line.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Fantasy oil painting': 'STYLE: Fantasy oil painting inspired by classic sword-and-sorcery cover art and old fantasy rulebook art plates, in the tradition of 1970s and 1980s fantasy paperback cover painting: muscular, larger-than-life figures in dynamic, twisting poses, swirling painted backgrounds that dissolve into loose brushwork, and a raw, primal energy. LARGE, bold, loose brushstrokes with thick visible impasto and broad palette-knife marks, where each individual stroke of paint is clearly visible. Rich, saturated oil-paint textures, dramatic lighting, bold high-contrast highlights. Heroic anatomy, powerful poses, sculpted musculature. Epic, atmospheric backgrounds with mist, firelight, or stormy skies. Deep intense colors, warm skin tones, metallic reflections. The painting fades into loose, ragged brushstrokes toward the edges and does NOT reach the frame; everywhere the paint does not cover is PURE WHITE (#ffffff), with NO rectangular frame or border, like a painting set straight onto a clean white page.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Comic book cel-shaded': 'STYLE: EXTREME comic-book cel-shaded art in a loud, stylised video-game look: every shape outlined in thick, uneven, brush-inked black, rough hand-drawn hatching scratched across every surface, flat bold colour, and caricatured, exaggerated faces and proportions. VERY THICK, heavy black ink outlines: bold brush-inked contours around every character, prop, and shape, plus strong interior ink linework. HARD cel shading with flat blocks of light and shadow, razor-sharp shadow edges and NO smooth gradients, dramatic high-contrast lighting. Visible halftone dots and crosshatching in the shadow areas. Punchy, saturated graphic-novel colors. Heavy hand-painted marker texture with visible strokes and sketch lines. Exaggerated silhouettes, dynamic angles, expressive faces, stylized proportions. Loud, graphic, over-the-top comic-book energy.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead, and reworked into a paler, chalkier
    // pastel that Ian chose over the old one (2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Fantasy pastel': 'STYLE: Fantasy pastel and soft-chalk painting in the great tradition of nineteenth-century pastel painting: loose, impressionistic and suggestive rather than detailed. Inside the drawing, the coarse grain of toothy pastel paper shows through every stroke, faces and hands included, breaking the chalk into fine speckles and tiny flecks of bare paper. Build every form from soft masses of chalk colour, not from lines: NO pencil or ink outlines, NO crisp contour lines and NO smooth flat fills; edges are made where one patch of chalk colour meets another, softened by smudging. Lay the colour in short, visible, directional strokes and hatched layers, one colour scumbled over another, with broad soft-pastel sweeps for larger areas. Keep detail for the faces and hands of the main figures; everything else, furniture, walls, objects and background, is only suggested with a few loose strokes and smudges of colour and light, never drawn out in full. Use a light, airy, powdery palette: soft chalky tints mixed with white, matte and slightly dusty, with gentle, low-contrast values; even the shadows are soft lilac, blue-grey and warm grey rather than deep or black, and the darkest marks are small accents only. Warm light, glowing highlights, a dreamy, whimsical, airy feeling. Lightly stylized, ethereal, expressive characters. The drawing is a soft vignette that stops well short of the frame on every side: toward its edges the chalk thins into a hazy, blurred, finger-smudged glow and fades away completely, leaving a wide margin of clean, smooth, PURE WHITE (#ffffff) all around, with no texture, tint or grain in it and NO rectangular frame or border, like a pastel sketch set straight onto a clean white page.',
    // v3.2.24 -- TD-997. No artist or brand names: the look is described instead (Ian, 2026-10-20). Tested by Ian on the
    // group scene as a custom style. The retired wording is kept in claude/RETIRED_ART_STYLE_WORDING.md.
    'Charcoal drawing': 'STYLE: Traditional charcoal drawing on rough white paper. Rich, textured charcoal strokes with deep velvety blacks, soft smudged mid-tones, and subtle blended shading. Hand-drawn edges that feel slightly rough, with visible charcoal grain and the tooth of the paper showing through. Bold, expressive shadows with dramatic high contrast and areas of heavy shading. Minimal highlights, created by leaving the bare white paper exposed rather than adding bright tones. A traditional, tactile, sketch-based monochrome charcoal look, like an artist working with charcoal sticks and blending stumps on rough paper, in the tradition of Renaissance Old Master charcoal drawing. The drawing is a vignette that stops short of the frame on every side: toward its edges the charcoal thins into loose, smudged, feathered strokes and fades away completely, leaving a margin of clean, smooth, PURE WHITE (#ffffff) all around, with no tint, no cream or grey paper tone, no drawn box, frame or border line.',
    // v3.2.21 -- TD-641 / TD-642. DARK FANTASY IS GROUNDED, NOT DARK. REWRITTEN FROM IAN'S OWN TESTS.
    //
    // Ian, 2026-10-20: "My original intention for Dark Fantasy was a more realistic, heavier style
    // than High Fantasy which looks more comic like. Not necessarily darker in color" -- and "more
    // moody and dramatic", and "it just shouldn't look like everything is night time".
    //
    // THE OLD PARAGRAPH (v3.0.815, v3.0.821) read DARK as DARK VALUES: "low-key with deep near-black
    // shadow occupying most of the value range", "let everything it does not reach fall away into
    // gloom", and a near-monochrome palette with amber-gold the only colour. Wherever a scene did not
    // name its own hour, those three clauses chose night. Measured, not argued: on The Long Way Down
    // (a farm road, no hour named) it painted sunset twice, and on Free Fall Joy, whose scene text says
    // "bright midday sun in a clear blue sky", it drew a blazing sun in a black sky over a dim field.
    // That was TD-641's "this style needs gloom", and it was the wording, not the subject.
    //
    // HOW THIS ONE WAS CHOSEN. Ian ran five candidates as custom styles (same slot in the prompt as a
    // preset: getStylePrefix passes a custom STYLE: paragraph through unchanged) against the built-in
    // on seven real panels: The Frozen Hall, Three Walkers and a Blue Light, The Last Cultist Falls,
    // The Handoff, The Brass Bird Speaks, The Long Way Down and Free Fall Joy. This paragraph
    // ("Grounded 2") was the only one that never defaulted to night and still read as heavy, real and
    // dramatic indoors, underground and outdoors. Shipped word for word as Ian tested it.
    //
    // WHAT CARRIES THE LOOK NOW: realism of form (anatomy, faces with age, gear with weight), the
    // scene's own light painted directionally with full tonal range, the surface-history clause and
    // the airborne-matter clause from v3.0.821 (kept verbatim), and the darkest values at the frame
    // edges. Drama comes from the DIRECTION and CONTRAST of light, not from its absence.
    //
    // TWO CLAUSES ARE WORDED TO ADD NOTHING TO A SCENE (TD-552 rule 4, the model adds what it is
    // told about): the flame clause applies only to "any flame the scene itself contains", and the
    // daylight clause speaks of "whatever stands in the light" rather than naming trees or walls.
    //
    // KNOWN LIMITS, SEEN IN THE SAME TESTS: at a scene that literally asks for bright noon the colour
    // runs louder than the rest of the style (Ian chose the tested wording over an untested mute
    // line); and small-folk characters whose reference pictures are rounded still come out storybook
    // in every style (TD-124 -- the reference, not this paragraph). The ink-outline fault (TD-653)
    // did not appear in any of the seven Grounded 2 panels but is not proven gone.
    //
    // is_fade NO -- full bleed, as before. Name, id, tier (Gold, TD-659) and catalog entry unchanged.
    'Dark Fantasy': 'STYLE: Paint in rich, opaque oils with the weight, realism and drama of a classical history painting brought into a fantasy world. Give every figure believable anatomy and natural proportions, faces with age, character and weathering, and armour, cloth and gear that hang with real weight and show wear, mending and use. Take the time of day, the weather and the light from the scene itself, and paint that light dramatically: strong and directional, raking across forms, carving them out with bold contrast between lit planes and deep shadow, light breaking through haze, dust or smoke, and skies that carry weather and movement. Keep the drama in full daylight too: sunlight slanting through hazy air, shifting patches of light and shade across the land, and deep shade cast by whatever stands in the light. Keep the full tonal range, from luminous highlights to rich, deep shadows, at every hour. Any flame the scene itself contains, a fire, a torch, a lamp or a candle, glows warm and golden against the cooler world around it. Render every surface to a fine, dry-brushed, almost etched precision, and give every surface a history \u2014 individual strands of hair and fur, worn, pitted and scratched metal, damp skin, frayed and torn cloth, grain in wood and stone \u2014 so nothing looks new or clean. Fill the air with fine suspended matter, whatever this particular scene\'s own air would carry, caught and lit by the scene\'s own light and thickening with distance; never add airborne matter the scene would not have. Use grounded, naturalistic colour, earthy and slightly muted, true to the materials and the hour, with the light itself carrying the strongest colour in the picture. Build every form from paint and tonal value alone: no ink outlines, no contour lines, no linework, no sketch showing through. Keep the mood brooding, cinematic and heavy: a lived-in, dangerous, real world caught at a moment that matters. Separate near, middle and far with atmospheric haze, the darkest values gathering toward the edges of the frame and the far distance softening into the air.'
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
        const row = await db.prepare('SELECT id, owner_id, name, style_prompt, is_fade, style_answers FROM custom_art_styles WHERE id = ?').get(rowId);   // v3.2.52 style_answers
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
            // v3.2.52 -- TD-966. With a comic page or sound effects answered, isFade carries all three flags.
            var _fl = styleFlags(row.style_answers);
            var _isf = (_fl.panels || _fl.sfx) ? { fade: !!row.is_fade, panels: _fl.panels, sfx: _fl.sfx } : !!row.is_fade;
            return { styleForGen: _sp, isFade: _isf, name: row.name || null };
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
    // v3.0.819 -- TD-644 CLOSED, AND v3.0.815's REPLACEMENT WAS THE FAULT.
    //
    // v3.0.815 removed the hardcoded 'comic book art style' from here and put
    // 'in a clean, neutral illustration style' in its place, to stop the model
    // drifting photoreal -- the canonical reference is the one image that is
    // DISPLAYED, on the Company page. TD-644 recorded it as the only edit in
    // that batch whose visual result had not been checked, and marked it
    // VERIFY FIRST. It was checked on 2026-09-01, by opening a real reference.
    //
    // IT IS OUTLINED LINE ART. For this model a 'clean illustration' is line
    // and fill -- black contours round the coat, the straps, the boots and the
    // face, over flat shading. That is barely distinguishable from what the
    // comic wording produced. One instruction was swapped for a synonym.
    //
    // AND IT COSTS TWICE. The reference is fed to every panel as the identity
    // source, and the system prompt then unifies the whole picture toward it,
    // so the contours spread onto the rocks and the sky (TD-645). Second, the
    // panel is told to keep the character EXACTLY as the reference shows --
    // and a reference with smooth, unworn surfaces CAPS THE DETAIL of every
    // panel that character appears in. Ian, comparing a panel with the art he
    // wants: "It's good but no where near as good as those." You cannot render
    // detail the reference does not have.
    //
    // SO: still neutral, still an illustration rather than a photograph, but
    // fully rendered and WITHOUT CONTOURS. Note what is asked for and what is
    // not: surface MATERIAL (weave, grain, pitting) is a rendering instruction
    // and is safe; a mood, a palette or a light source would not be -- this
    // image must stay re-renderable into watercolour or charcoal as easily as
    // into an oil (TD-644: the canonical reference stays STYLE-NEUTRAL).
    'Full-body character reference portrait. Neutral standing pose, facing forward, ' +
    'even soft lighting. Render the figure FULLY and in HIGH DETAIL in a neutral ' +
    'painted style, modelled with soft tonal shading: NO ink outlines, NO contour ' +
    'lines drawn around shapes, NO flat cel shading, and nothing left simplified ' +
    'or flat. Give every material its real surface \u2014 the weave and folds of ' +
    'cloth, the grain and wear of leather, the pitting and scratches on metal, ' +
    'individual strands of hair.\n\n' +
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
  falSetup(falKey);
  const built = buildReferenceInput(descriptionText, portraitUrl, modelKey);
  const result = await fal.subscribe(built.model, { input: built.input });
  if (!result.data || !result.data.images || !result.data.images[0]) {
    throw new Error('No reference image returned from fal.ai');
  }
  return await persistToR2(result.data.images[0].url);
}

// Async character reference: submit to fal's queue with our webhook.
async function submitReference(falKey, descriptionText, portraitUrl, modelKey, webhookUrl) {
  falSetup(falKey);
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
    // v3.0.819 -- the same fault and the same fix as the character reference
    // above. These are the griffons, the locations and the items, and on a
    // panel like a four-griffon flight they occupy far more of the frame than
    // the characters do (TD-648).
    'background, even soft lighting, rendered FULLY and in HIGH DETAIL in a ' +
    'neutral painted style with soft tonal shading: NO ink outlines, NO contour ' +
    'lines drawn around shapes, NO flat cel shading. Give every material its ' +
    'real surface \u2014 grain, wear, pitting, scratches and weave. Show only the ' + catWord +
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
  falSetup(falKey);
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
  falSetup(falKey);
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
  falSetup(falKey);
  const built = buildEditReferenceInput(baseImageUrl, changeText, charName, modelKey);
  const submitted = await fal.queue.submit(built.model, { input: built.input, webhookUrl: webhookUrl });
  return { request_id: submitted.request_id, model: built.model };
}

// ============================================================
// ROUTES
// ============================================================

// v3.2.91 -- TD-1025. ONE JOB PER PICTURE AT A TIME. Ian, 2026-10-26: with the Storyboard spinner lost he
// pressed Regen again, and paid for two pictures where the second overwrote the first. A picture that
// already has a regenerate or retouch queued or drawing (in the last 10 minutes, so a job whose webhook never
// came does not lock it for good) is refused here, before anything is submitted or charged; the page keeps
// its spinner and follows the running job (job_id). Generate Images is unchanged.
const PANEL_JOB_WINDOW_MS = 10 * 60 * 1000;
async function pendingMomentJob(db, momentId) {
  try {
    const since = new Date(Date.now() - PANEL_JOB_WINDOW_MS).toISOString();
    return (await db.prepare("SELECT id, kind, user_id FROM image_jobs WHERE moment_id = ? AND status IN ('queued', 'processing') AND created_at > ? ORDER BY id DESC LIMIT 1").get(momentId, since)) || null;
  } catch (e) { return null; }   // the check must never stop a picture being drawn
}
function panelBusyReply(res, job, userId) {
  return res.json({ error: 'PANEL_BUSY', message: 'This picture is still being worked on. It will appear here when it\u2019s ready. Nothing was charged.', job_id: (job && String(job.user_id) === String(userId)) ? job.id : null });
}

// POST /api/images/generate-moment
// v3.1.30 -- TD-921. The refusal the two drawing routes give for a self-illustrated version. The page
// never asks (it hides Regenerate and skips Generate Images), so this is the backstop, not the path.
const SELF_ILLUSTRATED_MSG = "This version is set to \u201cI\u2019ll illustrate it myself\u201d, so Campaignia doesn\u2019t draw its pictures. Switch that off in the Art style window to draw again.";

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
  // v3.1.30 -- TD-921. A version set to "I'll illustrate it myself" is never drawn, whatever the page sends.
  if (await forkSelfIllustrated(db, moment.fork_id)) return res.json({ error: 'SELF_ILLUSTRATED', message: SELF_ILLUSTRATED_MSG });
  { const _busy = await pendingMomentJob(db, moment.id); if (_busy) return panelBusyReply(res, _busy, req.session.userId); }   // v3.2.91 -- TD-1025

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
    const assets = await db.prepare(ASSET_REF_SQL).all(campId);   // v3.1.90 -- TD-979
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
    const _recNotesS = assetSuggest.notesForPanel(await loadAssetSuggestions(db, moment.fork_id), assets, chars, panelText, ASSET_SUGGEST_MATCHERS, { castExplicit: !!moment.cast_explicit });   // v3.1.9 -- TD-908
    const sub = await submitPanelGen(applyMomentDirection(assetSuggest.applyRecurringNotes(prompt, _recNotesS), momentDirsS[moment.id]), _rs.styleForGen, fal_key, panelBlock, randomSeed, modelKey, webhookUrl, moment.shape, userThinking, _rs.isFade, _campPromptS);

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
    // v3.0.883 -- TD-760. The list now carries assets too, so the sentence naming it must
    // not say "Characters" -- a model told these are characters will not treat a location
    // or an item as a nameable subject, which is the whole point of sending them.
    if (cast.length) parts.push('Named references cast on this panel -- characters, locations and items, whose identity reference pictures are sent with the edit: ' + cast.join(', '));

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
  { const _busy = await pendingMomentJob(db, moment.id); if (_busy) return panelBusyReply(res, _busy, req.session.userId); }   // v3.2.91 -- TD-1025
  if (await rightsCheck.refuseRejected(res, [moment.image], 'It can\u2019t be retouched. Replace it with a picture you have the rights to. Nothing was charged.')) return;   // v3.1.98 -- TD-979
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
    const assetsR = await db.prepare(ASSET_REF_SQL).all(campIdR);   // v3.1.90 -- TD-979
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
    if (_markedUrl && !isOurPublicUrl(_markedUrl)) _markedUrl = '';   // v3.1.85 -- TD-954, any of our addresses
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
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, moment_id, fork_id, kind, status, model, style, cost, prev_image, crop_meta, temp_inputs, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, moment.campaign_id, moment.id, moment.fork_id, 'retouch', 'queued', sub.model, style || null, cost, moment.image || null, _cropMeta,
      // v3.2.66 -- TD-1006: the marker copy and the tile, deleted by releaseJobTemps when the job ends
      ([_markedUrl || null, _isTile ? _sendUrl : null].filter(Boolean).length ? JSON.stringify([_markedUrl || null, _isTile ? _sendUrl : null].filter(Boolean)) : null),
      nowTs, nowTs);
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
    // v3.1.15 -- TD-910. THE SHAPE SWAPS WITH THE PICTURE. Uploading your own picture (and applying an
    // archived one) can change the panel's shape; the shape that went with the displaced picture is
    // recorded as layout_meta.prev_shape, TIED TO THAT IMAGE URL. It is used only while it still
    // describes the picture in the undo slot -- a later Regenerate re-arms the slot at the current
    // shape and leaves a stale record that simply no longer matches -- and it swaps like the rest.
    var _revShape = null, _revStyle = null;
    if (_rMeta && _rMeta.prev_shape && _rMeta.prev_shape.image && _rMeta.prev_shape.image === moment.revert_image && _rMeta.prev_shape.shape) {
      _revShape = _rMeta.prev_shape.shape;
      // v3.1.30 -- TD-921. The label swaps with the picture when the slot recorded it (uploads do), so
      // reverting an upload does not leave a Campaignia picture labelled Self Illustrated.
      if (Object.prototype.hasOwnProperty.call(_rMeta.prev_shape, 'style')) _revStyle = { v: _rMeta.prev_shape.style };
      _rMeta.prev_shape = { shape: moment.shape || 'standard', image: current || null, style: (moment.style == null ? null : moment.style) };
    } else if (_rMeta && _rMeta.prev_shape) {
      delete _rMeta.prev_shape;
    }
    await db.prepare('UPDATE moments SET image = ?, img_w = ?, img_h = ?, shape = COALESCE(?, shape), revert_image = ?, revert_img_w = ?, revert_img_h = ?, layout_meta = COALESCE(?, layout_meta), edited_at = ?, edited_by = ? WHERE id = ?')
      .run(moment.revert_image, moment.revert_img_w || null, moment.revert_img_h || null, _revShape,
           current || null, moment.img_w || null, moment.img_h || null,
           _rMeta ? JSON.stringify(_rMeta) : null, now, req.session.userId, moment.id);
    if (_revStyle) await db.prepare('UPDATE moments SET style = ? WHERE id = ?').run(_revStyle.v, moment.id);   // v3.1.30
    res.json({ success: true, image: moment.revert_image });
  } catch (e) {
    console.error('revert-moment error:', e.message);
    res.json({ error: friendlyError(e, 'Could not revert the image. Please try again.') });
  }
});

// v3.0.822 -- TD-656. A DRAWN CHAPTER TITLE IS NOT A PANEL THE BATCH MAY REDRAW.
//
// Ian: "If there is an image build with the title builder then don't overwrite it
// with a full Session Generate Image button. Everything else stays the same."
//
// THE TEST IS PROVENANCE, NOT POSITION. It is the opening panel that carries a
// built title in practice, but the rule asks whether the Title Builder made this
// image -- a title panel anywhere is the same object, and a panel_order === 0
// test would quietly stop protecting it the moment anyone reordered a session.
//
// LIVE IMAGE ONLY, AND THAT CONDITION IS LOAD-BEARING. layout_meta.built_title
// SURVIVES a later regenerate -- the regenerate path writes image and leaves the
// record behind. Testing built_title alone would therefore lock a panel out of
// every future batch on the strength of a title it no longer holds. It counts
// only while built_title.url IS the image on the panel right now.
//
// THIS IS TD-444's RULE, COPIED ON PURPOSE RATHER THAN REINVENTED. The retouch
// route (v3.0.653) decides the same question the same way; two different answers
// to "is this a title panel" is the fault that would actually hurt. The guard
// asserts the retouch route still carries its own copy unchanged.
//
// SINGLE-PANEL REGENERATE IS UNTOUCHED, AND THAT IS DELIBERATE. Ian, 2026-08-12:
// "I had chapter text in the panel... I regenerated and got an actual picture."
// Regenerate is the documented way back from a title to a scene. If the batch and
// the button both refused, a title panel would be unrecoverable. Batch protects;
// the button is the escape hatch.
function momentHoldsBuiltTitle(m) {
  if (!m || !m.image) return false;
  var blt = null;
  try {
    var lm = m.layout_meta ? (typeof m.layout_meta === 'object' ? m.layout_meta : JSON.parse(m.layout_meta)) : {};
    blt = lm && lm.built_title;
  } catch (e) { blt = null; }
  return !!(blt && blt.url && String(blt.url) === String(m.image));
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
  // v3.1.30 -- TD-921. Nothing is drawn, and nothing is charged, for a self-illustrated version.
  if (await forkSelfIllustrated(db, targetForkId)) return res.json({ error: 'SELF_ILLUSTRATED', message: SELF_ILLUSTRATED_MSG });
  const moments = await db.prepare('SELECT * FROM moments WHERE fork_id = ? ORDER BY panel_order ASC').all(targetForkId);
  if (!moments.length) return res.json({ error: 'No moments found for this session' });
  // Image locking — skip locked panels (don't regenerate, don't charge for them).
  const lockedCount = moments.filter(function(m){ return m.locked; }).length;
  // v3.0.822 -- TD-656. Counted among the UNLOCKED only, so a panel that is both
  // locked and a title is reported once, under the reason the user chose.
  const titleCount = moments.filter(function(m){ return !m.locked && momentHoldsBuiltTitle(m); }).length;
  const toGenerate = moments.filter(function(m){ return !m.locked && !momentHoldsBuiltTitle(m); });

  if (!toGenerate.length) {
    // The message must name the reason that actually applies: after TD-656 an
    // empty batch is no longer proof that everything was locked.
    var _emptyMsg;
    if (lockedCount && titleCount) _emptyMsg = 'Nothing to generate — every panel is either locked or holds a chapter title. Unlock a panel, or use Regenerate on a title panel to draw the scene instead.';
    else if (titleCount)           _emptyMsg = 'Nothing to generate — the only panel here holds a chapter title from the Title Builder, and Generate Images leaves those alone. Use Regenerate on it to draw the scene instead.';
    else                           _emptyMsg = 'All panels are locked — nothing to generate. Unlock a panel to regenerate it.';
    return res.json({ success: true, generated: [], count: 0, total: moments.length, skipped_locked: lockedCount, skipped_title: titleCount, message: _emptyMsg });
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
  const assets = await db.prepare(ASSET_REF_SQL).all(campaign_id);   // v3.1.90 -- TD-979

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
  const _recStoredAll = await loadAssetSuggestions(db, targetForkId);   // v3.1.9 -- TD-908, read once per batch
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
      const _recNotes = assetSuggest.notesForPanel(_recStoredAll, assets, chars, panelText, ASSET_SUGGEST_MATCHERS, { castExplicit: !!m.cast_explicit });   // v3.1.9 -- TD-908
      const sub = await submitPanelGen(applyMomentDirection(assetSuggest.applyRecurringNotes(m.prompt, _recNotes), momentDirs[m.id]), _rs.styleForGen, fal_key, panelBlock, panelSeed, modelKey, webhookUrl, m.shape, userThinkingAll, _rs.isFade, _campPromptAll);
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

  res.status(202).json({ status: 'queued', jobs: jobs, total: moments.length, to_generate: toGenerate.length, skipped_locked: lockedCount, skipped_title: titleCount, submit_failed: submitFailed });
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

// v3.2.66 -- TD-1006. A RETOUCH'S WORKING FILES GO WHEN IT ENDS. Each panel Retouch stores a copy of the picture
// with the reader's markers drawn on (marked-...) and, for a confined change, the cropped tile (tile-...), only so
// the image model can fetch them. Nothing ever showed or needed them again, and nothing deleted them: about 116
// a month, two thirds of the bucket's steady leak (the unused-picture report, 2026-10-24). The job row now names
// them (image_jobs.temp_inputs) and this deletes them once the job is over, done or failed -- by then the model has
// read them. Only those two kinds of file are ever deleted here, whatever the column says; the column is then
// cleared so the unused-picture report does not count them as in use. Never fatal.
async function releaseJobTemps(db, job) {
  try {
    if (!job || !job.temp_inputs) return;
    let list = [];
    try { list = JSON.parse(job.temp_inputs) || []; } catch (e) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (typeof u === 'string' && /\/uploads\/(marked|tile)-[A-Za-z0-9._-]+$/.test(u) && isOurPublicUrl(u)) await deleteFile(u);
    }
    await db.prepare('UPDATE image_jobs SET temp_inputs = NULL WHERE id = ?').run(job.id);
  } catch (e) { try { console.warn('[retouch temps] left in place:', e && e.message); } catch (_e) {} }
}

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
      await releaseJobTemps(db, job);   // v3.2.66 -- TD-1006
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
      await releaseJobTemps(db, job);   // v3.2.66 -- TD-1006
      try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image result (fal webhook)', fn: 'webhook /webhook/fal', message: 'Generation returned no image', detail: { moment_id: job.moment_id, kind: job.kind, style: job.style || null } }); } catch (_le) {}
      return res.status(200).json({ ok: true });
    }
    if (payload.has_nsfw_concepts && payload.has_nsfw_concepts[0] === true) {
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyImageError({ message: 'image was flagged by the safety filter (returned blank)' }), new Date().toISOString(), job.id);
      await releaseJobTemps(db, job);   // v3.2.66 -- TD-1006
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
      // v3.1.98 -- TD-979. A RETOUCH IS AN EDIT OF ITS SOURCE, and keeps the source's rejection, as a copy does
      // (inherit). The routes refuse a rejected source before charging; this is the net under them, so no edit
      // can ever turn a rejected picture into an unmarked one. Never throws.
      if ((job.kind === 'retouch' || job.kind === 'asset_retouch' || job.kind === 'keyframe') && job.prev_image && imageUrl) await rightsCheck.inherit(job.prev_image, imageUrl);   // v3.5.09: a video keyframe's retouch too
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
        const _priorM = await db.prepare('SELECT image, img_w, img_h, revert_image, shape, style FROM moments WHERE id = ?').get(job.moment_id);   // v3.2.21 -- style too (TD-995)
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
        // v3.2.37 -- TD-1006. A REGEN NEVER DELETED THE PICTURE LEAVING THE UNDO SLOT. Since v3.2.21 the slot's
        // picture is also named in layout_meta.prev_shape, and releaseImage keeps any file layout_meta mentions.
        // The release ran BEFORE prev_shape was rewritten, so it always found the picture still "in use" and kept
        // it: every Regen past the first left a file in R2 that nothing points at. Now the slot and prev_shape are
        // brought up to date FIRST, a prev_shape still naming the leaving picture is dropped, and only then is it
        // released -- so releaseImage's checks see the row as it really is.
        var _wtDropPrevShape = async function (urls) {
          try {
            var _dr = await db.prepare('SELECT layout_meta FROM moments WHERE id = ?').get(job.moment_id);
            var _dm = null;
            try { _dm = (_dr && _dr.layout_meta) ? (typeof _dr.layout_meta === 'object' ? _dr.layout_meta : JSON.parse(_dr.layout_meta)) : null; } catch (_dpe) { _dm = null; }
            if (_dm && typeof _dm === 'object' && !Array.isArray(_dm) && _dm.prev_shape && urls.indexOf(_dm.prev_shape.image) >= 0) {
              delete _dm.prev_shape;
              await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(_dm), job.moment_id);
            }
          } catch (_dre) { console.error('clearing the old undo-slot record failed (the file is kept):', _dre && _dre.message); }
        };
        if (job.kind === 'retouch' || job.kind === 'moment') {
          var _leaving = (_priorM && _priorM.revert_image && _priorM.revert_image !== job.prev_image && _priorM.revert_image !== imageUrl) ? _priorM.revert_image : null;
          if (job.prev_image && job.prev_image !== imageUrl) {
            var _rw = (_priorM && _priorM.image === job.prev_image) ? _priorM.img_w : null;
            var _rh = (_priorM && _priorM.image === job.prev_image) ? _priorM.img_h : null;
            await db.prepare('UPDATE moments SET revert_image = ?, revert_img_w = ?, revert_img_h = ? WHERE id = ?').run(job.prev_image, _rw || null, _rh || null, job.moment_id);
            // v3.2.21 -- TD-995. THE UNDO SLOT REMEMBERS WHICH STYLE ITS PICTURE WAS DRAWN IN.
            // A Regenerate writes the NEW style onto the moment (above) and moves the old picture into
            // revert_image -- but nothing recorded the old picture's style, so Revert brought the old
            // picture back still labelled with the new style. revert-moment already swaps the label
            // when layout_meta.prev_shape describes the picture in the slot (v3.1.30, for uploads);
            // this writes that same record for a Regenerate. Only a regenerate ('moment'): a retouch
            // keeps the style it started with, so its undo slot has nothing to swap.
            if (job.kind === 'moment' && _priorM && _priorM.image === job.prev_image) {
              try {
                var _psRow = await db.prepare('SELECT layout_meta FROM moments WHERE id = ?').get(job.moment_id);
                var _psMeta = null;
                try { _psMeta = (_psRow && _psRow.layout_meta) ? (typeof _psRow.layout_meta === 'object' ? _psRow.layout_meta : JSON.parse(_psRow.layout_meta)) : null; } catch (_pe) { _psMeta = null; }
                if (!_psMeta || typeof _psMeta !== 'object' || Array.isArray(_psMeta)) _psMeta = {};
                _psMeta.prev_shape = { shape: _priorM.shape || 'standard', image: job.prev_image, style: (_priorM.style == null ? null : _priorM.style) };
                await db.prepare('UPDATE moments SET layout_meta = ? WHERE id = ?').run(JSON.stringify(_psMeta), job.moment_id);
              } catch (_pse) { console.error('recording the undo slot style failed (Revert keeps the current label):', _pse && _pse.message); }
            }
          } else {
            await db.prepare('UPDATE moments SET revert_image = NULL, revert_img_w = NULL, revert_img_h = NULL WHERE id = ?').run(job.moment_id);
          }
          if (_leaving) {   // v3.2.37 -- TD-1006: released AFTER the slot and its record moved on
            await _wtDropPrevShape([_leaving]);
            await releaseImage(db, _leaving);
          }
        } else {
          // v3.2.37 -- TD-1006. A batch run clears the undo slot: clear its record too, before the releases.
          var _batchOut = [];
          if (job.prev_image && job.prev_image !== imageUrl) _batchOut.push(job.prev_image);
          if (_priorM && _priorM.revert_image && _priorM.revert_image !== imageUrl) {
            await db.prepare('UPDATE moments SET revert_image = NULL, revert_img_w = NULL, revert_img_h = NULL WHERE id = ?').run(job.moment_id);
            _batchOut.push(_priorM.revert_image);
          }
          if (_batchOut.length) await _wtDropPrevShape(_batchOut);
          for (var _bi = 0; _bi < _batchOut.length; _bi++) await releaseImage(db, _batchOut[_bi]);
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
        // v3.3.71 -- TD-1080. An Image Builder picture: its gallery row takes the picture and its measured size.
        if (job.kind === 'builder' && job.builder_image_id) {
          // v3.3.74 -- a Regen: the picture on show moves into the one-deep undo slot (with its size) and the one
          // that was there is released AFTER the row stops naming it (TD-1006's order), so Revert can swap back.
          const _bi = await db.prepare('SELECT image_url, img_w, img_h, prev_image_url, clean_image_url, prev_clean_image_url, refs FROM builder_images WHERE id = ?').get(job.builder_image_id);
          // v3.3.85 -- a title with Title Builder lettering is laid on now; what the model drew is kept as the clean copy.
          // If the overlay fails the picture still lands, untitled, and the failure is logged.
          let _shown = imageUrl, _clean = null;
          const _ov = _bi ? ibLayersOf(_bi.refs) : null;   // v3.3.92 -- the handout's writing and the title
          if (_ov) {
            try { const _t = await ibCompose(imageUrl, _ov, job.builder_image_id); if (_t) { _shown = _t; _clean = imageUrl; } }
            catch (_oe) { try { await logDebug(job.user_id, { level: 'error', source: 'generation', page: 'Image Builder', fn: 'webhook builder title', message: 'Could not lay the title on Image Builder picture ' + job.builder_image_id + ': ' + (_oe && _oe.message) }); } catch (_le) {} }
          }
          if (_bi && _bi.image_url && _bi.image_url !== imageUrl) {
            let _bref = {}; try { _bref = _bi.refs ? (typeof _bi.refs === 'string' ? JSON.parse(_bi.refs) : _bi.refs) : {}; } catch (_pe) { _bref = {}; }
            _bref.prevLayers = ibSnapLayers(_bref);   // v3.4.01 -- the picture going to the undo slot had the same layers
            await db.prepare('UPDATE builder_images SET image_url = ?, img_w = ?, img_h = ?, clean_image_url = ?, prev_image_url = ?, prev_img_w = ?, prev_img_h = ?, prev_clean_image_url = ?, refs = ?, updated_at = ? WHERE id = ?')
              .run(_shown, imgW, imgH, _clean, _bi.image_url, _bi.img_w || null, _bi.img_h || null, _bi.clean_image_url || null, JSON.stringify(_bref), new Date().toISOString(), job.builder_image_id);
            // Released AFTER the row stops naming them; releaseImage keeps anything still named anywhere.
            if (_bi.prev_image_url) await releaseImage(db, _bi.prev_image_url);
            if (_bi.prev_clean_image_url) await releaseImage(db, _bi.prev_clean_image_url);
          } else {
            await db.prepare('UPDATE builder_images SET image_url = ?, img_w = ?, img_h = ?, clean_image_url = ?, updated_at = ? WHERE id = ?')
              .run(_shown, imgW, imgH, _clean, new Date().toISOString(), job.builder_image_id);
          }
          await logImageGeneration(db, job.user_id, 'builder_image', job.builder_image_id, null);
        }
        // v3.5.09 -- TD-090. A KEYFRAME OF A VIDEO EPISODE (Retouch on the Video tab). Only the episode's own copy changes:
        // every keyframe of that episode still showing the picture that was retouched takes the new one, and keeps the
        // old one in its one-step Revert slot. The book, the storyboard and the Archive are not touched. (Keyframe rows
        // are rewritten by each save, so they are found by episode and picture, not by id; the page also swaps the
        // picture in when it sees the job done, so a save in the meantime cannot put the old one back for good.)
        if (job.kind === 'keyframe' && job.episode_id) {
          const _kr = await db.prepare('UPDATE keyframes SET image_url = ?, prev_image_url = ? WHERE episode_id = ? AND image_url = ?')
            .run(imageUrl, job.prev_image, job.episode_id, job.prev_image);
          await logImageGeneration(db, job.user_id, 'video_keyframe', job.episode_id, null);
          try { await logDebug(job.user_id, { level: 'info', source: 'generation', page: 'Video tab', fn: 'webhook keyframe retouch', message: 'Keyframe retouched in episode ' + job.episode_id + ' (' + (_kr && _kr.changes) + ' keyframe(s) now show it)', detail: { episode_id: job.episode_id, image_url: imageUrl } }); } catch (_ke) {}
        }
      const genSource = (job.kind === 'char_ref') ? 'character_reference'
        : (job.kind === 'session_ref') ? 'amendment_reference'
        : (job.kind === 'asset_ref') ? 'asset_reference'
        : (job.kind === 'asset_retouch') ? 'asset_retouch'
        : (job.kind === 'retouch') ? 'panel_retouch'
        : (job.kind === 'batch') ? 'panel_batch'
        : (job.kind === 'builder') ? 'builder_image'
        : (job.kind === 'keyframe') ? 'video_keyframe_retouch' : 'panel_regen';   // v3.3.71 -- TD-1080; v3.5.09 keyframe
      if (job.cost && job.cost > 0) {
        await spendTokens(job.user_id, job.cost, { related_campaign_id: job.campaign_id, source: genSource, event_type: 'generation_spend' });
      }
      try { await recordGeneration(job.user_id, { event_type: genSource, tokens_redeemed: (job.cost || 0), quantity: 1, unit: 'images', model: job.model, related_campaign_id: job.campaign_id }); } catch (e) {}
      await db.prepare('UPDATE image_jobs SET status = ?, image_url = ?, updated_at = ? WHERE id = ?')
        .run('done', imageUrl, new Date().toISOString(), job.id);
      await releaseJobTemps(db, job);   // v3.2.66 -- TD-1006
    } catch (e) {
      console.error('[fal webhook] processing error:', e.message);
      await db.prepare('UPDATE image_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', friendlyImageError(e), new Date().toISOString(), job.id);
      await releaseJobTemps(db, job);   // v3.2.66 -- TD-1006
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

// v3.2.91 -- TD-1025. Which of this session's pictures still have one of YOUR jobs queued or drawing, so the
// Storyboard can put their spinners back after a refresh or a redraw, and follow them.
webhookRouter.get('/moment-jobs', requireAuth, async function(req, res) {
  try {
    const sid = parseInt(req.query.session_id, 10);
    if (!(sid > 0)) return res.json({ jobs: [] });
    const db = await getDb();
    const since = new Date(Date.now() - PANEL_JOB_WINDOW_MS).toISOString();
    const rows = await db.prepare(
      "SELECT j.id, j.moment_id, j.kind FROM image_jobs j JOIN moments m ON m.id = j.moment_id " +
      "WHERE j.user_id = ? AND m.session_id = ? AND j.status IN ('queued', 'processing') AND j.created_at > ? " +
      "AND j.kind IN ('moment', 'retouch', 'batch') ORDER BY j.id"
    ).all(req.session.userId, sid, since);
    res.json({ jobs: (rows || []).map(function (r) { return { id: r.id, moment_id: r.moment_id, kind: r.kind }; }) });
  } catch (e) { res.json({ jobs: [] }); }
});

webhookRouter.get('/jobs/:id', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const job = await db.prepare('SELECT id, status, image_url, error, moment_id FROM image_jobs WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.session.userId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    // v3.2.21 -- TD-995. A FINISHED MOMENT JOB ALSO SAYS WHICH STYLE THE PANEL NOW CARRIES, read from the
    // moment itself -- the same value the Archive copies -- so the Storyboard can relabel the panel the
    // moment its new picture lands, instead of showing the style it had before until a reload. Absent
    // (never null-for-unknown) when there is nothing to report, so an older page simply ignores it.
    var _jobStyle;
    if (job.status === 'done' && job.moment_id) {
      try {
        var _jm = await db.prepare('SELECT style FROM moments WHERE id = ?').get(job.moment_id);
        if (_jm) _jobStyle = (_jm.style == null ? null : _jm.style);
      } catch (_je) { /* the picture still lands; only the label waits for a reload */ }
    }
    var _jobOut = { status: job.status, image_url: job.image_url || null, error: job.error || null, moment_id: job.moment_id };
    if (_jobStyle !== undefined) _jobOut.moment_style = _jobStyle;
    res.json(_jobOut);
  } catch (e) { res.json({ error: friendlyError(e, 'Could not check image status.') }); }
});

// v3.1.66 -- TD-964. THE THREE PREVIEW SCENES (Ian, 2026-10-13: "One with people close up. One of
// outside, big scene, one with several people in it mid distance."). The old preview drew one fixed
// scene -- a lone knight before a misty forest, ruins and mountains -- which asked for a detailed landscape
// whatever the style, and showed nothing of faces or groups. Each scene tests something different. They
// go through generateImage like any panel, so a preview is what a story panel would get. A request with no
// scene is the old one-picture screen and keeps the old scene and its saving, unchanged.
const STYLE_PREVIEW_SCENES = {
  // v3.1.68 -- Ian: the close up should have ONE person, about 15% tighter; and the people varied too much
  // between previews, so each is described precisely (a specific description holds steadier than "four
  // companions"). No reference pictures: they pull the drawing toward their own style.
  // v3.1.70 -- Ian: v3.1.68's "weathered... in his fifties... scar... stocky bald... older" asked for realistic,
  // lined faces and beat the style (Anime Fantasy lost its anime faces). People are described only by things
  // that do not decide how a face is drawn -- hair, clothes, what they are doing -- and the close up is a man in
  // his thirties with no hood, so his hair shows, and a dramatic expression (Ian).
  closeup:  { shape: 'square', prompt: 'A close head-and-shoulders portrait of one person only: a man in his thirties with tousled shoulder-length dark brown hair and a deep green travelling coat, sitting alone at a small table lit by a single lamp, with a dramatic expression: eyes wide, brow tight, lips parted, as if he has just heard something terrible. No hood, no hat. No one else is in the picture.' },
  // v3.1.72 -- Ian: the wagons came out with horses facing the wrong way or harnessed to both ends. Animals in
  // harness are the image model's weak spot, so the outdoors scene is people on foot; the valley, town and sky
  // are still the subject.
  outdoors: { shape: 'wide',   prompt: 'Three travellers on foot follow a winding road through a wide valley toward a walled town on a far hill, under a vast evening sky.' },
  group:    { shape: 'wide',   prompt: 'Four companions gather around a table in a firelit hall, arguing over a map: a woman with short red hair in a leather coat, a man with a braided black beard in a brown jerkin, a young man with long silver hair in a blue robe, and a woman with grey curls and round spectacles.' }
};

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
    const _scene = (req.body && typeof req.body.scene === 'string' && Object.prototype.hasOwnProperty.call(STYLE_PREVIEW_SCENES, req.body.scene)) ? STYLE_PREVIEW_SCENES[req.body.scene] : null;   // v3.1.66
    // v3.1.70 -- the style decides how people look (big anime eyes, ink-carved faces), never the scene text.
    const SAMPLE_PROMPT = _scene ? (_scene.prompt + ' Draw every face, eye and body entirely in the required art style\'s own way; nothing in this description changes how people are drawn.') : 'A lone armored adventurer stands at the edge of a misty ancient forest at dawn, sword in hand, with crumbling ruins and a distant mountain range behind them.';
    // v3.1.68 -- the screen sends one seed per scene so the three descriptions start from the same picture
    // and differ in style, not in who is in it. Anything else gets a random seed, as before.
    const _askSeed = (_scene && req.body) ? Number(req.body.seed) : NaN;
    const seed = (Number.isInteger(_askSeed) && _askSeed >= 1 && _askSeed <= 2147483646) ? _askSeed : crypto.randomInt(1, 2147483647);
    // v3.2.52 -- TD-966. The builder sends its answers to 19 and 20, so a preview shows the comic page as panels will.
    const _pfl = styleFlags(req.body && req.body.answers);
    const _pOverride = (_pfl.panels || _pfl.sfx) ? { fade: isFade, panels: _pfl.panels, sfx: _pfl.sfx } : isFade;
    const url = await generateImage(SAMPLE_PROMPT, stylePrompt, fal_key, null, seed, modelKey, _scene ? _scene.shape : 'wide', null, _pOverride);
    try { await spendTokens(req.session.userId, cost, { source: 'custom_style_preview', event_type: 'generation_spend' }); } catch (e) { console.error('preview spend failed:', e.message); }
    try { await recordGeneration(req.session.userId, { event_type: 'custom_style_preview', tokens_redeemed: cost, quantity: 1, unit: 'images', model: (IMAGE_MODELS[modelKey] || modelKey) }); } catch (e) {}
    // Persist the preview to the style so reopening shows the last render.
    // v3.1.66 -- only for the old one-picture screen: the questions screen stores each scene's picture
    // under its option and saves it with the style, so writing preview_url here would fight it.
    const styleId = _scene ? null : (req.body && req.body.style_id);
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
    // v3.3.83 -- target kind 'ib': the Image Builder's Title section. Its words are the ones typed there.
    const _ibTgt = !!(req.body && req.body.target && req.body.target.kind === 'ib');
    if (_ibTgt && !(await ibAllowed(req.session.userId, campaignId))) return res.status(403).json({ error: 'The Image Builder is a Platinum feature.' });
    const tgt = _ibTgt ? { current: { words: { title: ibClip(req.body.ibTitle, 100), subtitle: ibClip(req.body.ibSubtitle, 140) } } }
      : await resolveTitleTarget(db, req, targetFromRequest(req, campaignId));
    if (tgt.error) return res.status(403).json({ error: tgt.error });
    const bookTitle = String((tgt.current.words && tgt.current.words.title) || (_ibTgt ? '' : campaign.name) || '').trim();
    if (!bookTitle) return res.json({ error: 'This has no title yet. Name it first, then draw it.' });
    const subtitle = String((tgt.current.words && tgt.current.words.subtitle) || '').trim();
    const description = String((req.body && req.body.description) || '').trim();
    const refUrl = String((req.body && req.body.referenceUrl) || '').trim();

    // v3.1.99 -- TD-979. THE REFERENCE IS LOOKED AT HERE, when Generate is pressed (Ian), before the image model
    // is called and before anything is charged. Told it is lettering, so the lettering is not taken for a
    // watermark. A watermark refuses; a signature warns and the title is still drawn. Looked at once per picture.
    let _refRights = [];
    if (refUrl) {
      const _rr = await rightsCheck.checkReference(refUrl, { kind: 'title-ref', userId: req.session.userId, campaignId: campaignId, hint: rightsCheck.LETTERING_HINT });
      const _rk = rightsCheck.normUrl(refUrl);
      if (_rr.verdict === 'reject') {
        const _why = (_rr.reasons || []).filter(function (x) { return x && x.kind !== 'signature' && x.kind !== 'copyright'; })[0];
        return res.json({ error: ((_why && _why.text) || 'This reference picture has a watermark.') + ' It can\u2019t be used as a reference. Choose another picture. Nothing was charged.',
          code: 'RIGHTS_REJECTED', rights: [{ url: _rk, verdict: 'reject', reasons: _rr.reasons || [] }] });
      }
      if (_rr.verdict === 'warn') _refRights = [{ url: _rk, verdict: 'warn', reasons: _rr.reasons || [] }];
    }

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
    return res.json({ image: cutRes.url, source: srcUrl, title: bookTitle, subtitle: subtitle, cut: cutFinal, rights: _refRights });   // v3.1.99: a signed reference warns
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

    // v3.3.87 -- target kind 'ib': the Image Builder's lettering, sent by the window (our own files only).
    const _ibRt = !!(req.body && req.body.target && req.body.target.kind === 'ib');
    if (_ibRt && !(await ibAllowed(req.session.userId, campaignId))) return res.status(403).json({ error: 'The Image Builder is a Platinum feature.' });
    const _ibCur = (req.body && req.body.ibCur) || {};
    const own = _ibRt ? { current: { url: isOurPublicUrl(String(_ibCur.url || '')) ? String(_ibCur.url) : '', src: isOurPublicUrl(String(_ibCur.src || '')) ? String(_ibCur.src) : '' } }
      : await resolveTitleTarget(db, req, targetFromRequest(req, campaignId));
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
    if (await rightsCheck.refuseRejected(res, [_rtSrc.src, _rtSrc.url], 'It can\u2019t be retouched. Replace it with a picture you have the rights to. Nothing was charged.')) return;   // v3.1.98 -- TD-979

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

    falSetup(fal_key);
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
    // v3.1.85 -- TD-954. Any of OUR public addresses, old or new: after the switch every picture stored
    // before it still carries the old one, and refusing those would break every older panel.
    if (!u || !isOurPublicUrl(u)) return res.status(400).send('bad url');
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

// POST /api/images/heic-to-jpeg -- v3.1.14, TD-909. Nothing is stored and no token is spent: the
// converted bytes go straight back. A file that is not HEIC is refused rather than echoed.
// v3.1.90 -- TD-979. VERDICTS FOR PICTURES ON SCREEN. The page sends the addresses it is showing and gets
// back only those with something to say (warn or reject), to mark them. A verdict says nothing about
// whose picture it is, and only addresses the caller already holds are answered.
router.post('/rights', requireAuth, async function (req, res) {
  try {
    const raw = (req.body && Array.isArray(req.body.urls)) ? req.body.urls : [];
    const urls = raw.filter(function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 2000; }).slice(0, 200);
    const found = await rightsCheck.lookup(urls);
    const verdicts = {};
    urls.forEach(function (u) { var k = rightsCheck.normUrl(u); if (found[k]) verdicts[k] = found[k]; });
    return res.json({ verdicts: verdicts });
  } catch (e) {
    return res.json({ verdicts: {} });
  }
});

router.post('/heic-to-jpeg', requireAuth, guardUpload(heicUpload, 'heic-to-jpeg', 25), function (req, res) {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No image received.' });
  if (!req.file.heicConverted) {
    return res.status(400).json({ error: 'That is not an iPhone (HEIC) photo.' });
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  return res.send(req.file.buffer);
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
    // v3.1.90 -- TD-979. A title reference whose file details name a stock library is refused before it
    // is stored (it is only ever a transient reference, so there is no slot to leave it in).
    const _tm = req.file.rightsMeta || rightsCheck.metadataCheck(req.file.buffer);
    if (_tm && _tm.verdict === 'reject') return res.json({ error: ((_tm.reasons[0] && _tm.reasons[0].text) || 'That picture has a watermark.') + ' Please use a picture you have the rights to.' });
    const url = await uploadFile(req.file.buffer, name, ct);
    const _tr = await rightsCheck.checkUpload(url, req.file, null, { kind: 'title-ref', userId: req.session.userId });
    const _tri = {}; _tri[url] = _tr;
    return res.json({ url: url, rights: rightsCheck.responseRights(_tri) });
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
// =====================================================================================================
// v3.3.71 -- TD-1080. THE IMAGE BUILDER, stage 1 (spec claude/IMAGE_BUILDER_SPEC.md). Pictures made outside any
// story panel, kept per campaign in builder_images with their whole recipe. A campaign is open to the Builder for
// a user whose EFFECTIVE tier there is Platinum: their own plan, or the Story Master's (Ian: "inheritable from a
// SM on platinum"). Every route asks that question for the campaign it touches; the page asking it too only saves
// a round trip. The generation itself is the panel pipeline (buildPanelInput through submitPanelGen and the fal
// webhook), so styles, references, the campaign standing instruction and the fal headers all behave as on a panel.
// =====================================================================================================
const IB_SHAPES = { panoramic: 1, wide: 1, standard: 1, square: 1, fullpage: 1, tall: 1, tower: 1 };
const IB_NAME_MAX = 80, IB_DESC_MAX = 1500, IB_LORE_MAX = 2000, IB_WORDS_MAX = 6000;
const IB_JOB_WINDOW_MS = 15 * 60 * 1000;   // the same 15 minutes as job_stale in IB_LIST_SQL
const IB_LOST = 'This picture did not come back from the image service. Nothing was charged. Delete it and try again.';
// One sentence per image type, added before the description. candid:false drops the story-panel rule that people
// never face the viewer (COMPOSITION_IMG), which a poster, a portrait or a token needs to break.
const IB_TYPES = [
  // v3.3.86 -- Movie Poster / Book Cover and Character Study rewritten from Ian's examples (key-art montage posters; a
  // character sheet: full figure plus three close-ups).
  { key: 'poster', label: 'Movie Poster / Book Cover', candid: false, text: 'IMAGE TYPE: a cinematic movie poster or book cover in classic key-art style, one continuous composition with no frames, borders or panels. The main characters form a montage: the most important as large head-and-shoulders portraits in the upper half, overlapping and scaled by importance, gazing intently at the viewer or into the distance. The hero stands in the foreground, centred and larger than life, holding their signature weapon or object, with supporting figures smaller around and behind them, building a pyramid. Below and behind them, a key moment from the story and glimpses of its places blend into one another through light, smoke and cloud. Dramatic, high-contrast lighting with strong backlight and rim light, a glowing light source, and a bold split of warm and cool colour. Embers, sparks, rain, snow or dust fill the air. With only one character, they alone dominate the poster in a powerful stance, the setting rising behind them. Keep one band of the picture calm and uncluttered for a title laid on later: the bottom fifth, unless a title space is given below. Draw no title, lettering, names or credits.' },
  // v3.3.92 -- Character Study and Creature Study are ONE type (Ian, 2026-11-01). The old key 'creature' still opens
  // pictures made with it; ibType maps it here.
  { key: 'character', label: 'Character / Creature Study', candid: false, text: 'IMAGE TYPE: a character sheet of ONE character or creature, painted as a single continuous illustration with no frames, borders or dividing lines. The subject appears whole and large: a person head to toe, a creature nose to tail. Its pose shows who or what it is, taken from the description when there is one; with none, an action pose with their signature weapon or gear for a fighter, a calmer, characterful stance for a scholar, a bard or a mystic, and for a beast a natural pose that shows its shape, size and features. Every piece of clothing, armour, equipment, hide, scale and feather is clearly visible. Alongside, three close-ups of the SAME subject\'s head (front view, three-quarter view and near-profile), each with a different expression, fading softly into the background. On a wide or square picture the full figure fills the left two-thirds and the close-ups are stacked down the right side; on a tall picture the full figure fills the top and the close-ups sit in a row along the bottom. Behind everything, an atmospheric setting from its world, darker and softer than the figure so it never competes with it. The face, markings, scars, colouring, clothing and gear match exactly in every view.' },
  { key: 'group', label: 'Group Portrait', candid: false, text: 'IMAGE TYPE: a group portrait of the named characters together, every one clearly visible and recognisable, arranged with depth and a variety of poses, as if gathered for a memorable moment.' },
  { key: 'location', label: 'Location / Establishing Shot', candid: true, text: 'IMAGE TYPE: an establishing shot of a place. The location itself is the subject: its architecture or landscape, light and atmosphere. People, if any, are small in the scene.' },
  { key: 'action', label: 'Action Scene', candid: true, text: 'IMAGE TYPE: an action scene full of motion and drama, such as a battle, a chase or a moment of danger, with a strong diagonal composition and a clear focal point.' },
  { key: 'map', label: 'Map', candid: true, text: 'IMAGE TYPE: a hand-drawn illustrated map seen from directly above, as if drawn on parchment by a cartographer: coastlines, rivers, roads, forests, mountains and settlements drawn as small illustrations. Place names, if any, are short and written in a simple hand.' },
  // v3.4.10 -- TD-1091. Map to Scene (Ian, 2026-11-02): a flat map, given as ONE Location asset, rebuilt as a low angled
  // bird's-eye scene. Ian's tests: a storybook map and a top-down battle map both kept their layout; "masts" brought
  // antennas and "continue beyond the edges" a second town, so the wording names neither. needsMap: ibBuildAndSubmit.
  // v3.4.11 -- {{MAP}} is the map's own name, filled in by ibMapType. Outdoor paragraph as Ian tested it on the harbour;
  // the interior cutaway paragraph added after the Forbidden Cave map came back as a map on a table.
  { key: 'mapscene', label: 'Map to Scene', candid: true, needsMap: true, adminOnly: true, text: 'IMAGE TYPE: a real place in three dimensions, built from a plan. The reference picture for "{{MAP}}" is a flat, top-down map or plan of this place; it is only the plan to build from. The finished picture shows the real place that plan describes: the place itself.\n\nIf the plan shows open country, a town, a harbour or a coast, rebuild it as a real, three-dimensional landscape seen from a low vantage point about 30 degrees above the ground, as if from a nearby hilltop at the near edge of the plan, looking out across the whole area toward the horizon. Use strong perspective: the plan\'s bottom edge is close to the viewer, large and detailed at the bottom of the picture; its top edge is far away, smaller and softened by haze. Buildings show their front walls, doors, windows and the sides facing the viewer as well as their roofs; trees, rocks, boats and figures stand upright and cast long shadows across the ground. Beyond the plan\'s edges lies only open, natural country, water and sky, stretching quietly to a distant horizon, with a wide sky across the top of the picture. Light the scene with natural directional sunlight.\n\nIf the plan shows an interior (a dungeon, cave, mine, castle, temple or building), rebuild it as a three-dimensional cutaway illustration seen from above at about 45 degrees, with the ceiling and roof lifted away so every room and corridor is visible at once. Every wall stands at its full height with rough stone faces, doorways and arches; floors are real flagstones, packed earth and scattered rubble; stairs climb and descend; statues, chests and rubble stand upright and cast shadows; the rooms are lit from within by torches and braziers, with deep shadow in the corners. Around the outside of the walls is solid rock and earth, cut away cleanly.\n\nKeep the plan\'s layout and contents exactly: every wall, room, corridor, stair, coastline, river, pier, road, building, boat, forest and hill sits in the same place relative to the others as on the plan, with the same shapes and proportions, seen in perspective. Each symbol on the plan becomes the real thing it stands for, at its true scale, and the place holds exactly what the plan shows. Everything keeps the era, materials and technology the plan itself shows.\n\nThe whole picture is a painted scene of the place itself: the plan\'s paper, border, grid, compass rose, legend, labels and lettering all become ground, floor and wall.' },
  // v3.3.97 -- Item Showcase as a still life (Ian's mirror-and-goblet example).
  { key: 'item', label: 'Item Showcase', candid: false, text: 'IMAGE TYPE: an item showcase painted as a still life. The item, or each item when there are several, rests on a fitting surface (a stone plinth, a table, an altar, the ground), large and in sharp focus, filling most of the picture, with its materials, wear, markings and craftsmanship clearly visible. Several items are arranged together naturally, overlapping a little, none hidden. Behind them, a softly suggested setting from where they were found, darker and less detailed so it never competes, with one clear light falling on the items.' },
  { key: 'handout', label: 'In-world Handout', candid: false, text: 'IMAGE TYPE: an in-world handout seen flat and filling the picture: a single document such as a wanted poster, letter, scroll or notice, aged and weathered to suit the setting. Any writing on it is short.' },
  { key: 'token', label: 'Portrait / Headshot', candid: false, text: 'IMAGE TYPE: a head-and-shoulders portrait of one figure, centered and facing the viewer, on a plain background, with the head and shoulders well inside the picture so it can be cropped to a circle for use as a game token.' }   // v3.3.97 -- renamed (Ian); key unchanged
];
var IB_TYPE_TEXT_MAX = 2500;   // v3.3.86
// v3.4.19 -- TD-1095. SCENES FROM THE ARCHIVE AS REFERENCES (Ian, 2026-11-03: "pull in Archived scenes as additional
// references... Another set of pills"). What a scene is FOR depends on the image type (Ian), so each type has one line
// here and the line rides on the reference itself (so Regen and Edit Prompt words keep it). Always a suggestion. A type
// with no line (Group Portrait, Location, Map, Map to Scene) does not send its scenes; they stay on the picture's list.
var IB_SCENE_NOTES = {
  poster: 'Fit it into the montage as one of the smaller vignettes, among and below the main portraits, showing its people, their action and its setting.',
  token: 'Show it as a small vignette softly in the background, behind and beside the figure, keeping the head and shoulders clear and well inside the picture.',
  handout: 'Show it as a printed illustration on the document itself, like the picture on a wanted poster or a sketch on a letter.',
  item: 'Show it as a small inset vignette behind the still life, a glimpse of the item\u2019s story.',
  character: 'Show it in place of one of the close-ups, so the sheet shows the full figure, the other close-ups and this moment.',
  action: 'It is a guide to what its characters are doing: in this action scene, have them doing the same kind of action, movement and energy, drawn from their own character references, in this picture\u2019s own setting and composition. Use it only as a guide to the action, never for its layout or framing.',
  '': 'Include it as a small vignette in this picture, showing its people, their action and its setting.'
};
var IB_SCENE_MAYBE = ' Include it only where it fits naturally; leave it out if it would crowd the picture.';
function ibSceneNote(type) {
  var k = type ? (type.key === 'creature' ? 'character' : type.key) : '';
  if (!Object.prototype.hasOwnProperty.call(IB_SCENE_NOTES, k)) return null;
  return IB_SCENE_NOTES[k] + (k === 'action' ? '' : IB_SCENE_MAYBE);
}
// Who a scene shows, from what the Archive recorded -- the user never types names. A story panel: its cast as set by hand,
// else the campaign's characters named in the panel's own words (the matcher panels are drawn with). A Builder picture:
// its References. Neither (the panel deleted, an upload): no names, and the model works it out from the picture.
async function ibScenePeople(db, cid, a) {
  try {
    var uniq = function (xs) { return xs.filter(function (x, i) { return x && xs.indexOf(x) === i; }); };
    if (a.moment_id) {
      const named = await db.prepare('SELECT ch.name FROM moment_characters mc JOIN characters ch ON ch.id = mc.character_id WHERE mc.moment_id = ? ORDER BY ch.name').all(a.moment_id);
      if (named && named.length) return uniq(named.map(function (r) { return characterCanonicalName(r.name); }));
      const m = await db.prepare('SELECT title, description, prompt FROM moments WHERE id = ?').get(a.moment_id);
      if (m) {
        const text = [m.title, m.description, m.prompt].filter(Boolean).join(' ').toLowerCase();
        const cs = await db.prepare('SELECT name FROM characters WHERE campaign_id = ?').all(cid);
        return uniq((cs || []).filter(function (c) { return c.name && characterNameMatches(c.name, text); }).map(function (c) { return characterCanonicalName(c.name); }));
      }
    }
    const src = a.source_url || a.image_url;
    const b = src ? await db.prepare('SELECT refs FROM builder_images WHERE campaign_id = ? AND (image_url = ? OR clean_image_url = ?) LIMIT 1').get(cid, src, src) : null;
    if (b && b.refs) { let r = {}; try { r = JSON.parse(b.refs) || {}; } catch (e) { r = {}; } return uniq((r.characters || []).map(function (c) { return characterCanonicalName(c.name); })); }
  } catch (e) { console.error('[image-builder] scene people error:', e.message); }
  return [];
}
// v3.4.20 -- TD-1097. ibScenePeople for a whole Archive at once: the same three sources in the same order (a panel's cast
// set by hand; else the campaign's characters named in the panel's words; else a Builder picture's References), read in
// four queries instead of up to three per picture. A read that fails leaves its source empty, as ibScenePeople does.
async function ibSceneIndex(db, cid) {
  const idx = { named: {}, moments: {}, chars: [], builder: [] };
  const read = async function (sql, args) { try { const st = db.prepare(sql); return (await st.all.apply(st, args)) || []; } catch (e) { console.error('[image-builder] scene index error:', e.message); return []; } };
  (await read("SELECT DISTINCT mc.moment_id, ch.name FROM moment_characters mc JOIN characters ch ON ch.id = mc.character_id " +
    "JOIN campaign_archives a ON a.moment_id = mc.moment_id WHERE a.campaign_id = ? AND a.image_type = 'moment' ORDER BY ch.name", [cid])).forEach(function (r) {
    (idx.named[r.moment_id] = idx.named[r.moment_id] || []).push(r.name);
  });
  (await read("SELECT DISTINCT m.id, m.title, m.description, m.prompt FROM moments m JOIN campaign_archives a ON a.moment_id = m.id " +
    "WHERE a.campaign_id = ? AND a.image_type = 'moment'", [cid])).forEach(function (m) { idx.moments[m.id] = m; });
  idx.chars = await read('SELECT name FROM characters WHERE campaign_id = ?', [cid]);
  idx.builder = await read('SELECT image_url, clean_image_url, refs FROM builder_images WHERE campaign_id = ? ORDER BY id', [cid]);
  return idx;
}
function ibScenePeopleIn(idx, a) {
  try {
    var uniq = function (xs) { return xs.filter(function (x, i) { return x && xs.indexOf(x) === i; }); };
    if (a.moment_id) {
      const named = idx.named[a.moment_id];
      if (named && named.length) return uniq(named.map(function (n) { return characterCanonicalName(n); }));
      const m = idx.moments[a.moment_id];
      if (m) {
        const text = [m.title, m.description, m.prompt].filter(Boolean).join(' ').toLowerCase();
        return uniq((idx.chars || []).filter(function (c) { return c.name && characterNameMatches(c.name, text); }).map(function (c) { return characterCanonicalName(c.name); }));
      }
    }
    const src = a.source_url || a.image_url;
    const b = src ? (idx.builder || []).find(function (x) { return x.image_url === src || x.clean_image_url === src; }) : null;
    if (b && b.refs) { let r = {}; try { r = JSON.parse(b.refs) || {}; } catch (e) { r = {}; } return uniq((r.characters || []).map(function (c) { return characterCanonicalName(c.name); })); }
  } catch (e) { console.error('[image-builder] scene people error:', e.message); }
  return [];
}
// The scenes a picture asks for, checked: archived pictures (image_type 'moment': story panels and Builder pictures) of THIS
// campaign, which every member may see. In the order given, each once.
async function ibResolveScenes(db, cid, list) {
  const ids = (Array.isArray(list) ? list : []).map(function (x) { return parseInt((x && typeof x === 'object') ? x.id : x, 10); }).filter(function (x, i, a) { return x > 0 && a.indexOf(x) === i; });
  const out = [];
  for (const id of ids) {
    const a = await db.prepare("SELECT id, title, image_url, source_url, moment_id FROM campaign_archives WHERE id = ? AND campaign_id = ? AND image_type = 'moment'").get(id, cid);
    if (!a || !a.image_url) return { error: 'One of the scenes is no longer in the Archive.' };
    out.push({ id: a.id, name: String(a.title || '').trim().slice(0, 80) || 'Scene', url: a.image_url, people: await ibScenePeople(db, cid, a) });
  }
  return { scenes: out };
}
// v3.4.13 -- TD-1091. adminOnly types (Map to Scene, while Ian tests it: "Make it so Admin's can see it still while we
// test it more") are listed and accepted for a NEW picture only for an admin (ADMIN_EMAILS). Pictures already made with
// one keep working: Regen, Retouch and Make My Copy do not ask. A support session is the customer, so it is not admin.
async function ibIsAdmin(req) {
  try { const db = await getDb(); const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId); return !!(u && isAdminEmail(u.email)); }
  catch (e) { return false; }
}
// v3.4.11 -- TD-1091. Map to Scene names the map: {{MAP}} in the type's words becomes the map asset's name, for the prompt
// only (the stored type_text keeps the placeholder).
function ibMapType(type, map) {
  if (!type || !map || String(type.text || '').indexOf('{{MAP}}') < 0) return type;
  return Object.assign({}, type, { text: type.text.split('{{MAP}}').join(assetCanonicalName(map.name)) });
}
function ibType(key) { if (key === 'creature') key = 'character'; return IB_TYPES.filter(function (t) { return t.key === key; })[0] || null; }   // v3.3.92 -- creature is character

async function ibAllowed(userId, campaignId) {
  if (!userId || !campaignId) return false;
  try {
    if (!(await getCampaignRole(userId, campaignId))) return false;
    return (await getEffectiveTier(userId, campaignId)) === 'platinum';
  } catch (e) { return false; }   // never fail OPEN on an entitlement question
}
async function ibGate(req, res) {
  if (await ibAllowed(req.session.userId, req.params.cid)) return true;
  res.status(403).json({ error: 'NOT_PLATINUM', message: 'The Image Builder is a Platinum feature. It is open in your own Platinum campaigns, and in campaigns whose Story Master is on Platinum.' });
  return false;
}
function ibRow(r) {
  if (!r) return null;
  var refs = null; try { refs = r.refs ? JSON.parse(r.refs) : null; } catch (e) { refs = null; }
  if (refs && refs.prevLayers) delete refs.prevLayers;   // v3.4.01 -- the undo slot's layers stay on the server
  // No sweeper ends a job whose webhook never came, so a picture still pending after IB_JOB_WINDOW_MS is shown as
  // failed (and can be deleted). Nothing was charged: tokens are spent only when the picture arrives.
  // v3.3.74 -- a Regen draws over a picture already on show, so "drawing" comes from the latest job, not from a
  // missing picture: a live job means drawing; otherwise a picture means done; a lost or failed first job, failed.
  var js = r.job_status || null;
  var live = (js === 'queued' || js === 'processing') && r.job_stale !== true;
  var st = live ? js : (r.image_url ? 'done' : ((js === 'queued' || js === 'processing') ? 'failed' : (js || 'queued')));
  // The last Regen of a picture that is still on show did not work (failed, or never came back).
  var lastErr = (r.image_url && !live && js && js !== 'done') ? (js === 'failed' ? (r.job_error || IB_LOST) : 'It did not come back from the image service. Nothing was charged.') : null;
  return { id: r.id, campaign_id: r.campaign_id, user_id: r.user_id, maker: r.maker_name || '', name: r.name || '', description: r.description || '',
    image_type: r.image_type || '', shape: r.shape || '', art_style: r.art_style || '', art_style_name: r.art_style_name || '', include_lore: !!r.include_lore,
    refs: refs || { characters: [], assets: [] }, prompt: r.prompt || '', image_url: r.image_url || null, img_w: r.img_w || null, img_h: r.img_h || null,
    status: st, error: r.image_url ? null : (st === 'failed' ? (r.job_error || IB_LOST) : null), job_id: r.job_id || null,
    created_at: r.created_at || null, ready: r.is_ready !== false,   // v3.3.73 -- a NULL (never set) counts as Ready
    words: r.words || '', has_prev: !!r.prev_image_url, has_clean: !!r.clean_image_url, clean_url: r.clean_image_url || null, copied_from: r.copied_from || null, last_error: lastErr };   // v3.3.74
}
const IB_LIST_SQL = 'SELECT b.*, u.name AS maker_name, ' +
  '(SELECT j.status FROM image_jobs j WHERE j.builder_image_id = b.id ORDER BY j.id DESC LIMIT 1) AS job_status, ' +
  '(SELECT j.error FROM image_jobs j WHERE j.builder_image_id = b.id ORDER BY j.id DESC LIMIT 1) AS job_error, ' +
  '(SELECT j.id FROM image_jobs j WHERE j.builder_image_id = b.id ORDER BY j.id DESC LIMIT 1) AS job_id, ' +
  // Stale is decided in SQL: created_at holds a UTC time with no zone, which the driver would read in the server's zone.
  "(SELECT (j.created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '15 minutes') FROM image_jobs j WHERE j.builder_image_id = b.id ORDER BY j.id DESC LIMIT 1) AS job_stale " +
  'FROM builder_images b LEFT JOIN users u ON u.id = b.user_id ';

// The campaigns this user may use here, with the image types for the form.
router.get('/builder/campaigns', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      // v3.4.17 -- TD-1094: the My Campaigns order (Ian: "It should also dictate the order for the Campaign Selector").
      'SELECT c.id, c.name, c.campaign_image_url, c.cover_image_url, cm.role, cm.pinned_at, (SELECT COUNT(*) FROM characters ch WHERE ch.campaign_id = c.id) AS character_count ' +
      'FROM campaign_members cm JOIN campaigns c ON c.id = cm.campaign_id WHERE cm.user_id = ? ORDER BY (cm.pinned_at IS NULL) ASC, cm.pinned_at ASC, cm.last_opened_at DESC NULLS LAST, c.created_at DESC'
    ).all(req.session.userId);
    const out = [];
    for (const r of (rows || [])) {
      // v3.4.03 -- image: the picture its My Campaigns card shows (campaign picture, else the book cover)
      if (await ibAllowed(req.session.userId, r.id)) out.push({ id: r.id, name: r.name, role: r.role, character_count: Number(r.character_count) || 0, image: r.campaign_image_url || r.cover_image_url || '', pinned: !!r.pinned_at && rows.length > 4 });   // v3.4.17 -- pinned; v3.4.18 -- marked only with more than 4 campaigns (all of them, before the Platinum filter)
    }
    let cost = 1; try { cost = await getTokenCost(await getSelectedModel(db)); } catch (_ce) { cost = 1; }
    const _ibAdm = await ibIsAdmin(req);   // v3.4.13
    res.json({ campaigns: out, types: IB_TYPES.filter(function (t) { return !t.adminOnly || _ibAdm; }).map(function (t) { return { key: t.key, label: t.label, text: t.text }; }), max_refs: MAX_PANEL_REFS, cost: cost });
  } catch (e) {
    console.error('[image-builder] campaigns error:', e.message);
    res.json({ error: 'Could not load your campaigns.' });
  }
});

// The character steps of the Import Character picker, read from the chosen campaign itself. Same answers as
// /characters/import (routes/characters.js), which is Story Master only and reads another campaign.
router.get('/builder/campaigns/:cid/characters', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb();
    const rows = await db.prepare('SELECT id, name, cls, is_npc, canonical_reference_url, image_portrait, image FROM characters WHERE campaign_id = ? ORDER BY created_at ASC, id ASC').all(req.params.cid);
    res.json({ characters: (rows || []).map(function (c) {
      return { id: c.id, name: c.name, cls: c.cls || '', is_npc: !!c.is_npc, thumb: c.canonical_reference_url || c.image_portrait || c.image || null };
    }) });
  } catch (e) { console.error('[image-builder] characters error:', e.message); res.json({ error: 'Could not load the characters.' }); }
});
router.get('/builder/campaigns/:cid/characters/:charId/looks', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb();
    const { versionsForCampaign } = require('../database/db');
    const { importLooksForVersion } = require('./characters');
    const ch = await db.prepare('SELECT * FROM characters WHERE id = ? AND campaign_id = ?').get(req.params.charId, req.params.cid);
    if (!ch) return res.status(404).json({ error: 'That character is no longer in the campaign.' });
    const visible = await versionsForCampaign(db, req.params.cid, req.session.userId, null);
    if (req.query.version_id) {
      const v = visible.filter(function (x) { return String(x.version_id) === String(req.query.version_id); })[0];
      if (!v) return res.status(403).json({ error: 'That version is not shared with you.' });
      return res.json({ version_id: v.version_id, looks: await importLooksForVersion(db, ch.id, v.version_id) });
    }
    res.json({
      character: { id: ch.id, name: ch.name, cls: ch.cls || '' },
      original: ch.canonical_reference_url ? { key: 'original', label: 'Original', url: ch.canonical_reference_url } : null,
      versions: visible.map(function (v) { return { version_id: v.version_id, label: v.label, is_canonical: v.is_canonical, is_mine: v.is_mine }; })
    });
  } catch (e) { console.error('[image-builder] looks error:', e.message); res.json({ error: 'Could not load that character\u2019s pictures.' }); }
});
// v3.4.12 -- TD-1092. The picture behind a References pill: a character's chosen look (ibResolveCharacters, the same check
// Generate makes: in the campaign, a look the viewer may use) or an asset's picture (ASSET_REF_SQL: a rejected one has none).
router.get('/builder/campaigns/:cid/ref-picture', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb(), cid = parseInt(req.params.cid, 10), uid = req.session.userId;
    if (req.query.char) {
      const rc = await ibResolveCharacters(db, cid, uid, [{ id: req.query.char, look: String(req.query.look || 'original') }]);
      if (rc.error) return res.json({ error: rc.error });
      const c = rc.chars[0];
      if (!c || !c.snapshot_reference_url) return res.json({ error: 'That character has no reference picture yet.' });
      return res.json({ url: c.snapshot_reference_url });
    }
    if (req.query.scene) {   // v3.4.19 -- TD-1095
      const _s = await ibResolveScenes(db, cid, [req.query.scene]);
      if (_s.error || !_s.scenes.length) return res.json({ error: 'That scene is no longer in the Archive.' });
      return res.json({ url: _s.scenes[0].url });
    }
    const id = parseInt(req.query.asset, 10);
    const a = id > 0 ? (await db.prepare(ASSET_REF_SQL).all(cid)).filter(function (x) { return Number(x.id) === id; })[0] : null;
    if (!a || !a.image_url) return res.json({ error: 'That asset has no picture.' });
    res.json({ url: a.image_url });
  } catch (e) { console.error('[image-builder] ref-picture error:', e.message); res.json({ error: 'Could not load that picture.' }); }
});
// v3.4.19 -- TD-1095. The scene picker: the campaign's archived pictures (story panels and Image Builder pictures), newest
// first, with the session each came from.
// v3.4.20 -- TD-1097. With what the Archive's own filter bar reads (Ian: "have the filtering at the top"): the version,
// who archived it, the art style, the shape, the moment's title -- the Archive list's columns -- and the people in it,
// found as a scene reference finds them (ibScenePeople), so All characters can narrow panels too. Four reads in all,
// whatever the Archive's size: ibSceneIndex loads what ibScenePeople would ask per picture, ibScenePeopleIn answers.
router.get('/builder/campaigns/:cid/scenes', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb();
    const cid = parseInt(req.params.cid, 10);
    const rows = await db.prepare("SELECT a.id, a.title, a.image_url, a.source_url, a.moment_id, a.session_id, a.fork_id, a.archived_by, a.art_style, a.art_style_name, " +
      "a.shape, a.img_w, a.img_h, a.created_at, s.name AS session_name, u.name AS archived_by_name, sf.role AS fork_role, fu.name AS fork_owner_name, " +
      "m.title AS moment_title, m.panel_order AS moment_panel_order FROM campaign_archives a LEFT JOIN sessions s ON s.id = a.session_id " +
      "LEFT JOIN users u ON u.id = a.archived_by LEFT JOIN session_forks sf ON sf.id = a.fork_id LEFT JOIN users fu ON fu.id = sf.user_id " +
      "LEFT JOIN moments m ON m.id = a.moment_id " +
      "WHERE a.campaign_id = ? AND a.image_type = 'moment' AND a.image_url IS NOT NULL ORDER BY a.created_at DESC, a.id DESC").all(cid);
    const idx = await ibSceneIndex(db, cid);
    res.json({ scenes: (rows || []).map(function (r) {
      return { id: r.id, name: String(r.title || '').trim().slice(0, 80) || 'Scene', image_url: r.image_url, session: r.session_name || '',
        session_id: r.session_id || null, session_title: r.session_name || null, moment_id: r.moment_id || null, title: r.title || null,
        moment_title: r.moment_title || null, moment_panel_order: (r.moment_panel_order === undefined ? null : r.moment_panel_order),
        fork_id: r.fork_id || null, fork_role: r.fork_role || null, fork_owner_name: r.fork_owner_name || null,
        archived_by: r.archived_by || null, archived_by_name: r.archived_by_name || null, art_style: r.art_style || null, art_style_name: r.art_style_name || null,
        shape: r.shape || null, img_w: r.img_w || null, img_h: r.img_h || null, created_at: r.created_at || null, people: ibScenePeopleIn(idx, r) };
    }) });
  } catch (e) { console.error('[image-builder] scenes error:', e.message); res.json({ error: 'Could not load the Archive.' }); }
});
router.get('/builder/campaigns/:cid/assets', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb();
    const rows = await db.prepare(ASSET_REF_SQL + ' ORDER BY LOWER(a.name) ASC').all(req.params.cid);
    res.json({ assets: (rows || []).filter(function (a) { return !!a.image_url; }).map(function (a) { return { id: a.id, name: a.name, category: a.category || 'location', image_url: a.image_url }; }) });
  } catch (e) { console.error('[image-builder] assets error:', e.message); res.json({ error: 'Could not load the assets.' }); }
});
// The gallery: every image in the campaign, everyone's (Ian: visible to the whole campaign), newest first.
router.get('/builder/campaigns/:cid/images', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const db = await getDb();
    // v3.3.73 -- a Draft is seen by its maker only (not the Story Master either); Ready pictures by the whole campaign.
    const rows = await db.prepare(IB_LIST_SQL + 'WHERE b.campaign_id = ? AND (b.is_ready IS NOT FALSE OR b.user_id = ?) ORDER BY b.id DESC LIMIT 200').all(req.params.cid, req.session.userId);
    res.json({ images: (rows || []).map(ibRow), me: req.session.userId });
  } catch (e) { console.error('[image-builder] list error:', e.message); res.json({ error: 'Could not load the Image Builder gallery.' }); }
});

// Character references are a character id and a look ('original' or 'sc:<session_characters id>'), resolved HERE
// from the database: a picture address from the page is a claim, not proof. A session look must belong to a
// version this user may see. Returns rows shaped like generate-moment's chars, or { error }.
async function ibResolveCharacters(db, cid, uid, list) {
  const out = [], seen = {};
  const { versionsForCampaign } = require('../database/db');
  let visible = null;
  for (const it of (Array.isArray(list) ? list : [])) {
    const id = parseInt(it && it.id, 10); if (!(id > 0) || seen[id]) continue; seen[id] = 1;
    const ch = await db.prepare('SELECT id, name, cls, description, canonical_prompt, canonical_reference_url, height_ft FROM characters WHERE id = ? AND campaign_id = ?').get(id, cid);
    if (!ch) return { error: 'One of the characters is no longer in this campaign.' };
    const look = String((it && it.look) || 'original');
    let url = ch.canonical_reference_url || null, prompt = null, label = 'Original';
    if (look !== 'original') {
      const m = /^sc:(\d+)$/.exec(look);
      if (!m) return { error: 'That character look is not recognised.' };
      const sc = await db.prepare('SELECT sc.reference_url, sc.prompt, sf.version_id, s.name AS session_name FROM session_characters sc JOIN session_forks sf ON sf.id = sc.fork_id JOIN sessions s ON s.id = sf.session_id WHERE sc.id = ? AND sc.character_id = ? AND s.campaign_id = ?').get(parseInt(m[1], 10), id, cid);
      if (!sc || !sc.reference_url) return { error: 'That look of ' + ch.name + ' is no longer available.' };
      if (visible === null) visible = await versionsForCampaign(db, cid, uid, null);
      if (!visible.some(function (v) { return String(v.version_id) === String(sc.version_id); })) return { error: 'That look of ' + ch.name + ' is in a version that is not shared with you.' };
      url = sc.reference_url; prompt = sc.prompt || null; label = sc.session_name || 'Session';
    }
    // v3.3.82 -- THE CHARACTER'S HEIGHT, as set on the character now. Story panels get it from the session snapshot
    // (extract.js writes the HEIGHT: marker); the canonical prompt never carries one, so an Original look went without.
    // charPromptWithHeight replaces any older marker, and buildCharacterBlock puts it on the character's name line.
    if (ch.height_ft != null && Number(ch.height_ft) > 0) prompt = charPromptWithHeight(prompt || ch.canonical_prompt || ch.description || '', ch.height_ft);
    out.push({ character_id: ch.id, name: ch.name, cls: ch.cls, description: ch.description, canonical_prompt: ch.canonical_prompt,
      canonical_reference_url: ch.canonical_reference_url, snapshot_prompt: prompt, snapshot_reference_url: url, _look: look, _label: label });
  }
  return { chars: out };
}

// The words sent to the image model, before buildPanelInput adds the style, references and house rules.
// v3.3.83 -- the Title section (Ian: "Drawn In with warning", typed freely, "let the art style decide", with the
// cover's placement and size). Clean: one line, no double quotes (they would close the quoted title), capped.
function ibClip(v, max) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/"/g, '\'').replace(/\s{2,}/g, ' ').trim().slice(0, max); }
var IB_TITLE_PLACE = { top: 'across the TOP of the picture', middle: 'across the MIDDLE of the picture', bottom: 'across the BOTTOM of the picture' };
var IB_TITLE_SIZE = { small: 'SMALL, about a third of the picture\'s width', medium: 'MEDIUM, about two thirds of the picture\'s width', large: 'LARGE, nearly the full width of the picture' };
// The stored form, or null when there is no title text. The lettering (Title Builder artwork) is kept only when it is
// one of our own files; src is the uncut original on its black ground, which is what the model is shown.
function ibCleanTitle(t) {
  if (!t || typeof t !== 'object') return null;
  var title = ibClip(t.title, 100);
  if (!title) return null;
  var out = { title: title, subtitle: ibClip(t.subtitle, 140), place: IB_TITLE_PLACE[t.place] ? t.place : 'top', size: IB_TITLE_SIZE[t.size] ? t.size : 'medium',
    desc: ibClip(t.desc, 300), url: '', src: '' };
  // v3.3.89 -- a hand-placed title: its box as fractions of the picture (left, top, width; the height follows the
  // lettering). Kept inside the picture; place and size are worked out from it for the model's title-space line.
  const p = (t.pos && typeof t.pos === 'object') ? t.pos : null;
  if (p) {
    let w = Number(p.w), x = Number(p.x), y = Number(p.y);
    if (isFinite(w) && isFinite(x) && isFinite(y) && w > 0) {
      w = Math.min(1, Math.max(0.05, w)); x = Math.min(1 - w, Math.max(0, x)); y = Math.min(0.98, Math.max(0, y));
      out.pos = { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, w: Math.round(w * 10000) / 10000 };
      out.size = w < 0.45 ? 'small' : (w < 0.75 ? 'medium' : 'large');
      out.place = y < 0.3 ? 'top' : (y > 0.55 ? 'bottom' : 'middle');
    }
  }
  var u = String(t.url || '').trim(), s = String(t.src || '').trim();
  if (u && isOurPublicUrl(u)) out.url = u;
  if (out.url && s && isOurPublicUrl(s)) out.src = s;
  return out;
}
// v3.3.85 -- THE LETTERING GOES ON LAST. Ian: "it's not putting the image from the title builder on the image." Handed
// to the model as a reference, the lettering was treated as what every reference is -- something to redraw in the
// picture's style -- and was redrawn, or dropped. So the model draws the picture with the title's band left calm, and
// the Title Builder's own artwork (transparent, trimmed) is laid over it here, centred, at the placement and size
// chosen; the picture before that is kept as the clean copy. The box is a share of the picture's width and height.
var IB_TITLE_BOX = { small: [0.38, 0.16], medium: [0.62, 0.24], large: [0.88, 0.32] };
async function ibFetchImage(u) {
  let buf = null;
  try { buf = await fetchFile(u); } catch (e) { buf = null; }
  if (buf) return buf;
  const r = await fetch(u);
  if (!r.ok) throw new Error('could not fetch ' + u + ' (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}
// v3.3.92 -- the title alone (Apply title, older callers).
async function ibOverlayTitle(pictureUrl, t, imageId) { return ibCompose(pictureUrl, { title: t, handout: null }, imageId); }
// v3.3.92 -- everything laid on a finished picture, in order: the handout's writing, then the title (with its haze and
// halo). Returns the new file's address.
async function ibCompose(pictureUrl, layersOf, imageId) {
  const sharp = require('sharp');
  const pic = await ibFetchImage(pictureUrl);
  const meta0 = await sharp(pic).metadata();
  const lay = [];
  if (layersOf && layersOf.handout) lay.push(await ibHandoutLayer(sharp, layersOf.handout, meta0.width, meta0.height));
  const t = layersOf && layersOf.title;
  if (t) lay.push.apply(lay, await ibTitleLayers(sharp, t, meta0.width, meta0.height));
  if (!lay.length) throw new Error('nothing to lay on');
  const out = await sharp(pic).composite(lay.filter(Boolean)).png().toBuffer();
  return uploadFile(out, 'ibtitled-' + imageId + '-' + Date.now() + '.png', 'image/png');
}
// v3.3.92 -- the title's layers (haze, halo, lettering), as ibOverlayTitle built them since v3.3.88.
async function ibTitleLayers(sharp, t, W, H) {
  let lettering = await ibFetchImage(t.url);
  try { lettering = await sharp(lettering).trim().png().toBuffer(); } catch (e) {}   // transparent margins off, so the size is the lettering's
  if (!W || !H) throw new Error('the picture has no size');
  const box = IB_TITLE_BOX[t.size] || IB_TITLE_BOX.medium;
  // v3.3.89 -- hand-placed: the width chosen (never taller than the picture); otherwise the old place / size box.
  const lt = t.pos
    ? await sharp(lettering).resize({ width: Math.max(1, Math.round(W * t.pos.w)), height: H, fit: 'inside' }).png().toBuffer({ resolveWithObject: true })
    : await sharp(lettering).resize({ width: Math.max(1, Math.round(W * box[0])), height: Math.max(1, Math.round(H * box[1])), fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
  const lw = lt.info.width, lh = lt.info.height, m = Math.round(Math.min(W, H) * 0.04);
  const top = t.pos ? Math.round(H * t.pos.y) : (t.place === 'middle' ? Math.round((H - lh) / 2) : (t.place === 'bottom' ? H - lh - m : m));   // v3.3.89 -- pos
  // v3.3.88 -- THE COVER'S DARK FADE. Ian: "we now need the dark fade under it same as what we do on the cover." The
  // cover puts two things behind a built title (services/printing/scrimRamp.js): a soft dark HAZE, full strength over
  // the lettering's box and falling away outside it, and a HALO, three dark drop-shadows on the lettering's own alpha,
  // tight to wide. The same image, the same semi-axes, the same colour and strengths are used here, so a titled
  // picture reads like a cover. The CSS blur radii (0.035in, 0.09in, 0.22in on a ~6in cover) are taken as shares of the
  // picture's width; a CSS blur radius is two standard deviations.
  const L = t.pos ? Math.max(0, Math.min(W - lw, Math.round(W * t.pos.x))) : Math.max(0, Math.round((W - lw) / 2)), T = Math.max(0, Math.min(H - lh, top));   // v3.3.89 -- pos
  const scrim = require('../services/printing/scrimRamp');
  const layers = [];
  const hw = Math.max(1, Math.round(lw * scrim.HAZE_RX)), hh = Math.max(1, Math.round(lh * scrim.HAZE_RY));
  const haze = await sharp(scrim.hazePng()).resize(hw, hh, { fit: 'fill' }).png().toBuffer();
  layers.push(await ibClipLayer(sharp, haze, hw, hh, L + Math.round((lw - hw) / 2), T + Math.round((lh - hh) / 2), W, H));
  const alpha = await sharp(lt.data).ensureAlpha().extractChannel(3).raw().toBuffer();
  const rgb = scrim.SCRIM_RGB;
  for (const pass of IB_TITLE_HALO) {
    const sigma = Math.max(0.5, W * pass[0] / 2), M = Math.ceil(sigma * 3);
    const rgba = Buffer.alloc(lw * lh * 4);
    for (let i = 0, j = 0; i < lw * lh; i++, j += 4) { rgba[j] = rgb[0]; rgba[j + 1] = rgb[1]; rgba[j + 2] = rgb[2]; rgba[j + 3] = Math.round(alpha[i] * pass[1]); }
    const padded = await sharp(rgba, { raw: { width: lw, height: lh, channels: 4 } }).extend({ top: M, bottom: M, left: M, right: M, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 0 } }).png().toBuffer();
    const shadow = await sharp(padded).blur(sigma).png().toBuffer();
    layers.push(await ibClipLayer(sharp, shadow, lw + 2 * M, lh + 2 * M, L - M, T - M, W, H));
  }
  layers.push({ input: lt.data, left: L, top: T });
  return layers;
}
// v3.3.88 -- the halo's three passes: [blur radius as a share of the picture's width, opacity], tight to wide, as the
// cover's drop-shadows (0.035in at 0.95, 0.09in at 0.8, 0.22in at 0.5, on a cover about 6in wide).
var IB_TITLE_HALO = [[0.0058, 0.95], [0.015, 0.8], [0.037, 0.5]];
// A layer for sharp's composite, cut to the picture: composite refuses anything that reaches past the edges.
async function ibClipLayer(sharp, buf, bw, bh, left, top, W, H) {
  const x0 = Math.max(0, left), y0 = Math.max(0, top), x1 = Math.min(W, left + bw), y1 = Math.min(H, top + bh);
  if (x1 <= x0 || y1 <= y0) return null;
  const whole = (x0 === left && y0 === top && x1 - x0 === bw && y1 - y0 === bh);
  const part = whole ? buf : await sharp(buf).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return { input: part, left: x0, top: y0 };
}
// =====================================================================================================
// v3.3.92 -- THE HANDOUT'S WRITING, LAID ON. Ian chose "Laid on, exact text": image models misspell anything longer
// than a few words, so the model draws the document with a clear writing area and the words are set by the browser in
// one of the book faces (it has all nine, /css/fonts.css), uploaded as a transparent PNG, and laid over the picture here
// with a multiply blend, so the ink takes the paper's grain. The box is fractions of the picture (x, y, w, h). The clean
// copy is kept exactly as for a title, and the two are laid on together, text first.
// =====================================================================================================
var IB_HO_FONTS = ['garamond', 'cinzel', 'crimson-text', 'journal', 'script', 'lora', 'merriweather', 'bangers'];
var IB_HO_INKS = ['brown', 'black', 'red', 'blue'];
var IB_HO_TEXT_MAX = 1500;
function ibCleanHandout(h) {
  if (!h || typeof h !== 'object') return null;
  const text = String(h.text == null ? '' : h.text).replace(/\r/g, '').replace(/\t/g, ' ').slice(0, IB_HO_TEXT_MAX).trim();
  if (!text) return null;
  const out = { text: text, font: IB_HO_FONTS.indexOf(h.font) >= 0 ? h.font : 'garamond', ink: IB_HO_INKS.indexOf(h.ink) >= 0 ? h.ink : 'brown',
    align: h.align === 'left' ? 'left' : 'center', heading: h.heading !== false, url: '', pos: null };
  const u = String(h.url || '').trim();
  if (u && isOurPublicUrl(u)) out.url = u;
  const p = (h.pos && typeof h.pos === 'object') ? h.pos : null;
  if (p) {
    let x = Number(p.x), y = Number(p.y), w = Number(p.w), hh = Number(p.h);
    if ([x, y, w, hh].every(isFinite) && w > 0 && hh > 0) {
      w = Math.min(1, Math.max(0.08, w)); hh = Math.min(1, Math.max(0.08, hh));
      x = Math.min(1 - w, Math.max(0, x)); y = Math.min(1 - hh, Math.max(0, y));
      const r4 = function (v) { return Math.round(v * 10000) / 10000; };
      out.pos = { x: r4(x), y: r4(y), w: r4(w), h: r4(hh) };
    }
  }
  return out;
}
// What the model is told when the writing will be laid on: a clear, EMPTY writing area where the box is.
function ibHandoutSpaceText(h) {
  const p = h.pos || { x: 0.12, y: 0.22, w: 0.76, h: 0.6 };
  const cy = p.y + p.h / 2;
  const where = cy < 0.38 ? 'the upper part' : (cy > 0.62 ? 'the lower part' : 'the middle');
  return 'WRITING AREA: the writing on this document is added afterwards, so leave a large, clear area of plain, EMPTY paper for it in ' + where +
    ' of the picture, about ' + Math.round(p.w * 100) + ' percent of the width and ' + Math.round(p.h * 100) + ' percent of the height. Draw no words, letters, numbers or scribbles anywhere on it; a drawing, seal, stain or border may frame the writing area but never cross it.';
}
// v3.4.01 -- WHAT WAS LAID ON THE PICTURE NOW IN THE UNDO SLOT. Testers 2026-11-01: Remove title, then Revert, brought
// the picture back with its title showing while the recipe still said the title was off, so the next Apply rebuilt from
// the clean copy and dropped the title. Every change that moves the picture on show into the undo slot now keeps the
// title and writing as they were (refs.prevLayers), and Revert swaps them back with the picture.
function ibSnapLayers(refs) { return { title: (refs && refs.title) || null, handout: (refs && refs.handout) || null }; }
function ibSwapLayers(refs) {
  if (!refs || !Object.prototype.hasOwnProperty.call(refs, 'prevLayers') || !refs.prevLayers) return false;
  const was = refs.prevLayers, now = ibSnapLayers(refs);
  if (was.title) refs.title = was.title; else delete refs.title;
  if (was.handout) refs.handout = was.handout; else delete refs.handout;
  refs.prevLayers = now;
  return true;
}
// The layers a picture gets once it is drawn: the handout's writing and the title, each only when ready to lay on.
function ibLayersOf(refsJson) {
  let refs = null; try { refs = typeof refsJson === 'string' ? JSON.parse(refsJson) : refsJson; } catch (e) { refs = null; }
  if (!refs) return null;
  const t = refs.title, h = refs.handout;
  const title = (t && t.title && t.url && !t.off) ? t : null, handout = (h && h.text && h.url && h.pos && !h.off) ? h : null;   // v3.3.93 -- off: taken off the picture
  return (title || handout) ? { title: title, handout: handout } : null;
}
// The handout's writing as a composite layer: the uploaded PNG fitted to its box, multiplied onto the paper.
async function ibHandoutLayer(sharp, h, W, H) {
  const buf = await ibFetchImage(h.url);
  const bw = Math.max(1, Math.round(W * h.pos.w)), bh = Math.max(1, Math.round(H * h.pos.h));
  const fitted = await sharp(buf).resize(bw, bh, { fit: 'fill' }).png().toBuffer();
  const L = Math.max(0, Math.min(W - bw, Math.round(W * h.pos.x))), T = Math.max(0, Math.min(H - bh, Math.round(H * h.pos.y)));
  return { input: fitted, left: L, top: T, blend: 'multiply' };
}
// The recipe's title when it has lettering to lay on, else null.
function ibOverlayOf(refsJson) {
  let refs = null; try { refs = typeof refsJson === 'string' ? JSON.parse(refsJson) : refsJson; } catch (e) { refs = null; }
  const t = refs && refs.title;
  return (t && t.title && t.url) ? t : null;
}
// What the model is told when the lettering will be laid on afterwards: keep the band calm, draw no title.
function ibTitleSpaceText(t) {
  return 'TITLE SPACE: a title will be laid over the ' + t.place + ' of this picture afterwards, ' + IB_TITLE_SIZE[t.size] +
    '. Keep that part of the picture calm and uncluttered (sky, ground, mist or shadow), with no faces or important detail in it. Do not draw any title, lettering or text yourself.';
}
function ibTitleText(t, hasRef) {
  var s = 'TITLE LETTERING (part of this picture): letter exactly this title into the picture, spelled letter for letter: "' + t.title + '".';
  if (t.subtitle) s += ' Underneath it, smaller, letter exactly: "' + t.subtitle + '".';
  s += ' Place the title ' + IB_TITLE_PLACE[t.place] + ', ' + IB_TITLE_SIZE[t.size] + ', and keep it clear of faces.';
  if (hasRef) s += ' Copy the lettering design (the letter shapes, colours and ornament) from the title lettering reference image, but not its plain black background: the lettering sits on this picture.';
  if (t.desc) s += ' Lettering style: ' + t.desc + '.';
  return s + ' Add no other words over the picture.';
}
function ibPrompt(o) {
  var parts = [];
  var typeText = o.type ? o.type.text : '';
  // A poster is told to leave the title out; with a title asked for, it is part of the design instead.
  // v3.3.86 -- a typed title (drawn by the art style) replaces any "no lettering" sentence in the type's text.
  if (typeText && o.title && !o.titleOver) typeText = typeText.replace(/Draw no title, lettering, names or credits\.|Do not draw any title, lettering or text\./g, 'The only lettering is the title described below.');
  if (typeText && o.handout) typeText = typeText.replace(' Any writing on it is short.', ' Its writing area is left blank.');   // v3.3.92
  if (typeText) parts.push(typeText);
  if (o.description) parts.push('THE PICTURE: ' + o.description);   // v3.3.81 -- none when an image type stands alone
  if (o.handout) parts.push(ibHandoutSpaceText(o.handout));   // v3.3.92
  if (o.title) parts.push(o.titleOver ? ibTitleSpaceText(o.title) : ibTitleText(o.title, false));   // v3.3.83; v3.3.85 -- lettering is laid on afterwards
  if (o.genreLabels && o.genreLabels.length) parts.push('GENRE: this picture belongs to a ' + o.genreLabels.join(', ') + ' story; keep its subject and setting true to that.');
  if (o.lore) parts.push('WORLD / LORE (background only; use what fits this picture, never illustrate all of it): ' + o.lore);
  return parts.join('\n\n');
}

// v3.3.74 -- stage 2. Generate and Regen build the picture the SAME way, here: references resolved from the database,
// style locks, the prompt words, the flags, and the submit. Returns null when it has already answered (an error,
// or a rights refusal written by refuseRejected). recipe: { description, shape, style, type (key or null),
// include_lore, refs: { characters: [{ id, look }], assets: [ids] } }; words: the picture's own words to send instead
// of building them from the recipe (Edit Prompt, and every Regen once the words are stored).
async function ibBuildAndSubmit(req, res, db, uid, cid, recipe, words) {
  const fal_key = process.env.FAL_API_KEY;
  if (!fal_key) { res.json({ error: 'Image generation is not configured. Please contact support.' }); return null; }
  const webhookUrl = falWebhookUrl();
  if (!webhookUrl) { res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' }); return null; }
  const style = recipe.style, shape = recipe.shape;
  let type = recipe.type ? ibType(String(recipe.type)) : null;
  // v3.3.86 -- the type's instructions as edited for this picture (Ian: "see and edit the prompt for that selection just
  // for that image generation"). Kept only when it differs from the type's own text.
  const typeText = type ? ibClip(recipe.type_text || (recipe.refs && recipe.refs.type_text), IB_TYPE_TEXT_MAX) : '';
  if (type && typeText && typeText !== type.text) type = Object.assign({}, type, { text: typeText, edited: true });
  if (recipe.type && !type) { res.json({ error: 'That image type is not recognised.' }); return null; }
  if (!IB_SHAPES[shape]) { res.json({ error: 'Choose a shape for the picture.', field: 'shape' }); return null; }
  if (!style) { res.json({ error: 'Choose an art style.', field: 'style' }); return null; }
  const effRank = accessRank(await getEffectiveTier(uid, cid));
  if (style.indexOf('custom:') !== 0 && !artStyleAllowed(effRank, style)) { res.json({ error: 'STYLE_LOCKED', message: 'That art style isn\u2019t available on your current plan.' }); return null; }
  const _rs = await resolveGenStyle(db, style, uid, cid);
  if (_rs.locked) { res.json({ error: 'STYLE_LOCKED', message: 'That custom art style isn\u2019t available right now. It needs an active Platinum plan.' }); return null; }

  const refsIn = (recipe.refs && typeof recipe.refs === 'object') ? recipe.refs : {};
  const rc = await ibResolveCharacters(db, cid, uid, refsIn.characters);
  if (rc.error) { res.json({ error: rc.error }); return null; }
  const chars = rc.chars;
  const assetIds = (Array.isArray(refsIn.assets) ? refsIn.assets : []).map(function (x) { return parseInt(x, 10); }).filter(function (x, i, a) { return x > 0 && a.indexOf(x) === i; });
  const allAssets = assetIds.length ? await db.prepare(ASSET_REF_SQL).all(cid) : [];
  const assets = allAssets.filter(function (a) { return assetIds.indexOf(Number(a.id)) >= 0 && a.image_url; });
  if (assets.length !== assetIds.length) { res.json({ error: 'One of the assets is no longer available, or its picture was removed.' }); return null; }
  const ttl = ibCleanTitle(refsIn.title);   // v3.3.83
  const ho = (type && type.key === 'handout') ? ibCleanHandout(refsIn.handout) : null;   // v3.3.92 -- the handout's writing
  const ttlOver = !!(ttl && ttl.url);   // v3.3.85 -- Title Builder lettering is laid over the finished picture, not drawn by the model
  const _sceneNote = ibSceneNote(type);   // v3.4.19 -- TD-1095: null = this type does not send scenes
  const _rsn = await ibResolveScenes(db, cid, refsIn.scenes);
  if (_rsn.error) { res.json({ error: _rsn.error, field: 'refs' }); return null; }
  const scenes = _rsn.scenes, sent = (_sceneNote !== null) ? scenes : [];
  if (chars.length + assets.length + sent.length > MAX_PANEL_REFS) { res.json({ error: 'Use at most ' + MAX_PANEL_REFS + ' reference pictures in one image.' }); return null; }
  let _ibMap = null;   // v3.4.11 -- Map to Scene: the asset that is the map
  if (type && type.needsMap) {   // v3.4.10/11 -- TD-1091: the map is the one Item or Location asset (Ian: in the story a map is an item); nothing is charged when it is missing
    const _maps = assets.filter(function (a) { var c = a.category || 'location'; return c === 'item' || c === 'location'; });
    if (_maps.length === 0) { res.json({ error: 'Map to Scene needs the map: add it to References as an Item asset (or a Location).', field: 'refs' }); return null; }
    if (_maps.length > 1) { res.json({ error: 'Map to Scene uses one map: leave just one Item or Location asset in References.', field: 'refs' }); return null; }
    _ibMap = _maps[0];
  }
  if (await rightsCheck.refuseRejected(res, chars.map(function (c) { return c.snapshot_reference_url; }), 'It can\u2019t be used as a reference. Choose another look.')) return null;
  if (sent.length && await rightsCheck.refuseRejected(res, sent.map(function (s) { return s.url; }), 'One of the scenes can\u2019t be used as a reference. Remove it from References.')) return null;   // v3.4.19

  const charIds = chars.map(function (c) { return c.character_id; });
  const charList = buildCharacterBlock(chars, '', 0, charIds);
  const assetList = buildAssetBlock(_ibMap ? assets.map(function (a) { return a === _ibMap ? Object.assign({}, a, { category: 'plan' }) : a; }) : assets, '', assetIds);   // v3.4.11 -- the map is a plan
  if (_ibMap) assetList.text = String(assetList.text || '').split('\n').filter(function (l) { return !/ \(plan\)$/.test(l); }).join('\n');   // and not a scene asset to match
  // v3.4.19 -- scenes go after the assets, each carrying its type's line; the people they show join the cast list, so the
  // roster rule does not forbid a vignette's own people.
  const _sceneRefs = sent.map(function (s) { return { name: s.name, url: s.url, category: 'scene', isAsset: true, people: s.people, note: _sceneNote }; });
  const _castNames = chars.map(function (c) { return c.name; });
  sent.forEach(function (s) { (s.people || []).forEach(function (p) { if (_castNames.map(function (x) { return characterCanonicalName(x); }).indexOf(p) < 0) _castNames.push(p); }); });
  const panelBlock = { text: charList.text, textTrimmed: charList.textTrimmed, assetText: assetList.text,
    refs: combineRefs(charList.refs, assetList.refs.concat(_sceneRefs)), castExplicit: true, castNames: _castNames };

  let prompt = (typeof words === 'string' && words.trim()) ? words.trim().slice(0, IB_WORDS_MAX) : '';
  if (!prompt) {
    const camp = await db.prepare('SELECT id, genres, lore FROM campaigns WHERE id = ?').get(cid);
    const lore = (recipe.include_lore !== false && camp && camp.lore && String(camp.lore).trim()) ? String(camp.lore).trim().slice(0, IB_LORE_MAX) : '';
    prompt = ibPrompt({ type: ibMapType(type, _ibMap), description: recipe.description, genreLabels: genresvc.genreLabels(camp && camp.genres), lore: lore, title: ttlOver ? ttl : null, titleOver: ttlOver, handout: ho });   // v3.3.93 -- only Title Builder lettering
  }
  // A poster, portrait or token drops the story-panel rule that people never face the viewer. Otherwise the style's
  // own flags pass through untouched, exactly as a panel would send them.
  let flags = _rs.isFade;
  if (type && type.candid === false) flags = Object.assign((_rs.isFade && typeof _rs.isFade === 'object') ? Object.assign({}, _rs.isFade) : { fade: _rs.isFade }, { noCandid: true });
  // v3.3.93 -- no 'titled' flag: only Title Builder lettering makes a title, and it is laid on, never drawn.

  const modelKey = await getSelectedModel(db);
  const cost = await getTokenCost(modelKey);
  if (!(await canAfford(uid, cost))) { res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' }); return null; }
  const _campPrompt = await loadCampaignPrompt(db, cid);
  const seed = Math.floor(Math.random() * 2147483647);
  const sub = await submitPanelGen(prompt, _rs.styleForGen, fal_key, panelBlock, seed, modelKey, webhookUrl, shape, null, flags, _campPrompt);
  const refsOut = { characters: chars.map(function (c) { return { id: c.character_id, name: c.name, look: c._look, label: c._label }; }),
    assets: assets.map(function (a) { return { id: a.id, name: a.name, category: a.category || 'location' }; }) };
  if (scenes.length) refsOut.scenes = scenes.map(function (s) { return { id: s.id, name: s.name }; });   // v3.4.19 -- kept even when this type does not send them
  if (ttl) refsOut.title = ttl;   // v3.3.83
  if (ho) refsOut.handout = ho;   // v3.3.92
  if (type && type.edited) refsOut.type_text = type.text;   // v3.3.86
  return { sub: sub, cost: cost, words: prompt, refsOut: refsOut, styleName: _rs.name || null, type: type, panelBlock: panelBlock };
}
async function ibQueueJob(db, uid, cid, sub, style, cost, imageId, prevImage) {
  const now = new Date().toISOString();
  return db.prepare(
    'INSERT INTO image_jobs (request_id, user_id, campaign_id, kind, status, model, style, cost, builder_image_id, prev_image, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sub.request_id, uid, cid, 'builder', 'queued', sub.model, style, cost, imageId, prevImage || null, now, now);
}
// The maker's own picture, in a campaign they may still use the Builder in, with nothing being drawn for it.
async function ibOwnIdle(req, res, db) {
  const r = await db.prepare('SELECT * FROM builder_images WHERE id = ?').get(req.params.id);
  if (!r) { res.status(404).json({ error: 'That picture is no longer in the gallery.' }); return null; }
  if (String(r.user_id) !== String(req.session.userId)) { res.status(403).json({ error: 'Only the person who made a picture can change it. Make your own copy to work on it.' }); return null; }
  if (!(await ibAllowed(req.session.userId, r.campaign_id))) { res.status(403).json({ error: 'NOT_PLATINUM', message: 'The Image Builder is a Platinum feature.' }); return null; }
  const busy = await db.prepare("SELECT id FROM image_jobs WHERE builder_image_id = ? AND status IN ('queued', 'processing') AND created_at > ? LIMIT 1").get(r.id, new Date(Date.now() - IB_JOB_WINDOW_MS).toISOString());
  if (busy) { res.json({ error: 'That picture is still being drawn. Try again once it has finished.' }); return null; }
  return r;
}
function ibRecipeOf(r) {
  let refs = null; try { refs = r.refs ? JSON.parse(r.refs) : null; } catch (e) { refs = null; }
  refs = refs || {};
  return { description: r.description || '', shape: r.shape, style: r.art_style, type: r.image_type || null, include_lore: r.include_lore !== false,
    refs: { characters: (refs.characters || []).map(function (c) { return { id: c.id, look: c.look }; }), assets: (refs.assets || []).map(function (a) { return a.id; }), scenes: (refs.scenes || []).map(function (s) { return s.id; }), title: refs.title || null, type_text: refs.type_text || null, handout: refs.handout || null } };   // v3.3.92 -- handout   // v3.3.86 -- type_text   // v3.3.83 -- title
}

router.post('/builder/campaigns/:cid/generate', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const b = req.body || {}, uid = req.session.userId, cid = parseInt(req.params.cid, 10);
    const name = String(b.name || '').trim().slice(0, IB_NAME_MAX);
    const description = String(b.description || '').trim().slice(0, IB_DESC_MAX);
    if (!name) return res.json({ error: 'Give the picture a name.', field: 'name' });
    // v3.3.81 -- an image type is enough on its own (Ian); the description is required only without one.
    if (!description && !b.image_type) return res.json({ error: 'Describe the picture you want, or choose an image type.', field: 'description' });
    const db = await getDb();
    const style = String(b.art_style || '').trim(), shape = String(b.shape || '');
    const recipe = { description: description, shape: shape, style: style, type: b.image_type || null, include_lore: b.include_lore !== false,
      refs: (b.refs && typeof b.refs === 'object') ? b.refs : {}, type_text: b.type_text || null };   // v3.3.86 -- type_text
    // v3.4.01 -- A NEW HANDOUT LANDS CLEAN. Ian: "Don't do it automatically... You need to drag and drop the text on
    // there." Its words still shape the prompt (the empty writing area); the writing goes on when it is placed and applied.
    if (recipe.refs.handout && typeof recipe.refs.handout === 'object') recipe.refs.handout = Object.assign({}, recipe.refs.handout, { url: '' });
    const _ibT = recipe.type ? ibType(String(recipe.type)) : null;   // v3.4.13 -- an admin-only type, for a new picture
    if (_ibT && _ibT.adminOnly && !(await ibIsAdmin(req))) return res.json({ error: 'That image type is not recognised.' });
    const built = await ibBuildAndSubmit(req, res, db, uid, cid, recipe, null);
    if (!built) return;
    const sub = built.sub, type = built.type, now = new Date().toISOString();
    const ins = await db.prepare(
      'INSERT INTO builder_images (campaign_id, user_id, name, description, image_type, shape, art_style, art_style_name, include_lore, refs, prompt, words, is_ready, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(cid, uid, name, description, type ? type.key : null, shape, style, built.styleName, recipe.include_lore, JSON.stringify(built.refsOut), sub.prompt || built.words, built.words, false, now, now);   // v3.3.73 -- starts as a Draft
    const imageId = ins.lastInsertRowid;
    const job = await ibQueueJob(db, uid, cid, sub, style, built.cost, imageId, null);
    await logDebug(uid, { level: 'info', source: 'generation', page: 'Image Builder', fn: 'POST /builder/generate',
      message: 'Submitted Image Builder picture ' + imageId + ' (request ' + sub.request_id + ')',
      detail: { campaign_id: cid, image_type: type ? type.key : null, shape: shape, style: style, refs: (built.panelBlock.refs || []).map(function (r) { return r.name; }), finalPrompt: sub.prompt || '', systemPrompt: sub.system_prompt || '' } });
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(imageId);
    res.status(202).json({ status: 'queued', job_id: job.lastInsertRowid, image: ibRow(row) });
  } catch (e) {
    console.error('[image-builder] generate error:', e.message);
    try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Image Builder', fn: 'POST /builder/generate', message: 'Image Builder generation failed: ' + (e && e.message) }); } catch (_le) {}
    res.json({ error: friendlyImageError(e) });
  }
});

// v3.3.87 -- the Title Builder's Archive, pointed at an Image Builder title: the lettering (and its uncut original) into
// the campaign's Archive as a title, exactly as archive-title does for a cover, so it can be reused anywhere.
router.post('/builder/campaigns/:cid/title-archive', requireAuth, async function (req, res) {
  try {
    if (!(await isTruePlatinum(req.session.userId))) return res.status(403).json({ error: 'The Title Builder is a Platinum feature. Upgrade to Platinum to draw your title as artwork.' });
    if (!(await ibGate(req, res))) return;
    const cid = parseInt(req.params.cid, 10), b = req.body || {};
    const url = String(b.url || '').trim(), src = String(b.src || '').trim();
    if (!url || !isOurPublicUrl(url)) return res.json({ error: 'There is no lettering to archive yet.' });
    const db = await getDb();
    const already = await db.prepare("SELECT * FROM campaign_archives WHERE campaign_id = ? AND image_type = 'title' AND source_url = ? LIMIT 1").get(cid, url);
    if (already) return res.json({ success: true, archive: already });
    if (await rightsCheck.refuseRejected(res, [url], 'It can\u2019t be archived. Replace it with a picture you have the rights to.')) return;
    try {
      const effTier = getTier(await getEffectiveTier(req.session.userId, cid));
      const cap = effTier ? effTier.max_archives_per_campaign : null;
      if (cap !== null && cap !== undefined) {
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_archives WHERE campaign_id = ?').get(cid);
        if (cnt && Number(cnt.c) >= cap) return res.json({ error: 'This campaign has hit its archive limit of ' + cap + ' images on the ' + effTier.name + ' tier. Remove an archived image to make room, or upgrade for more.' });
      }
    } catch (capErr) { console.error('[image-builder] title archive cap check error:', capErr.message); }
    const { archiveCopy } = require('../storage/storage');
    const archivedUrl = await archiveCopy(url);
    let archivedSrc = '';
    if (src && isOurPublicUrl(src)) { try { archivedSrc = await archiveCopy(src); } catch (e) { console.error('[image-builder] archive title source failed (keeping the cut copy):', e.message); } }
    const meta = JSON.stringify({ subtitle: ibClip(b.subtitle, 140), src: archivedSrc || null });
    const ins = await db.prepare(
      'INSERT INTO campaign_archives (campaign_id, fork_id, image_type, title, image_url, source_url, image_prompt, layout_meta, archived_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(cid, null, 'title', ibClip(b.title, 100) || null, archivedUrl, url, ibClip(b.prompt, 300) || null, meta, req.session.userId, new Date().toISOString());
    const row = await db.prepare('SELECT * FROM campaign_archives WHERE id = ?').get(ins.lastInsertRowid);
    res.json({ success: true, archive: row });
  } catch (e) { console.error('[image-builder] title archive error:', e.message); res.json({ error: 'Could not archive the title. Please try again.' }); }
});

// v3.3.92 -- the handout's writing, as the browser set it: a transparent PNG, checked, stored. Only a PNG, at most
// 4096 pixels a side and 8 MB; its metadata is checked as every upload's is.
router.post('/builder/campaigns/:cid/handout-image', requireAuth, async function (req, res) {
  try {
    if (!(await ibGate(req, res))) return;
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
    if (!m) return res.json({ error: 'The writing did not come through. Please try again.' });
    const buf = Buffer.from(m[1], 'base64');
    if (!buf.length || buf.length > 8 * 1024 * 1024) return res.json({ error: 'The writing is too large. Make the text box smaller and try again.' });
    let meta = null; try { meta = await require('sharp')(buf).metadata(); } catch (e) { meta = null; }
    if (!meta || meta.format !== 'png' || !(meta.width > 0) || !(meta.height > 0) || meta.width > 4096 || meta.height > 4096) return res.json({ error: 'The writing did not come through. Please try again.' });
    const _tm = rightsCheck.metadataCheck(buf);
    if (_tm && _tm.verdict === 'reject') return res.json({ error: 'That picture can\u2019t be used.' });
    const url = await uploadFile(buf, 'ibtext-' + req.session.userId + '-' + Date.now() + '.png', 'image/png');
    res.json({ url: url });
  } catch (e) { console.error('[image-builder] handout image error:', e.message); res.json({ error: 'Could not store the writing. Please try again.' }); }
});
// v3.3.92 -- lay the handout's writing on the clean copy (with the title, if the picture has one). Free; Revert undoes.
router.post('/builder/images/:id/handout', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    if (!r.image_url) return res.json({ error: 'The picture has to finish drawing first.' });
    const ho = ibCleanHandout(req.body && req.body.handout);
    if (!ho) return res.json({ error: 'Type the handout\u2019s text first.' });
    if (!ho.url || !ho.pos) return res.json({ error: 'Place the text on the picture first.' });
    let refs = {}; try { refs = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { refs = {}; }
    const base = r.clean_image_url || r.image_url;
    const _tl = ibLayersOf(refs);
    let shown;
    try { shown = await ibCompose(base, { handout: ho, title: _tl && _tl.title }, r.id); } catch (e) {
      console.error('[image-builder] apply handout error:', e.message);
      try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Image Builder', fn: 'POST /builder/images/:id/handout', message: 'Could not lay the writing on picture ' + r.id + ': ' + (e && e.message), detail: { picture: base, writing: ho.url, pos: ho.pos } }); } catch (_le) {}
      return res.json({ error: 'Could not lay the writing on the picture. Please try again.' });
    }
    refs.prevLayers = ibSnapLayers(refs);   // v3.4.01
    refs.handout = ho;
    await db.prepare('UPDATE builder_images SET image_url = ?, clean_image_url = ?, prev_image_url = ?, prev_img_w = ?, prev_img_h = ?, prev_clean_image_url = ?, refs = ?, updated_at = ? WHERE id = ?')
      .run(shown, base, r.image_url, r.img_w || null, r.img_h || null, r.clean_image_url || null, JSON.stringify(refs), new Date().toISOString(), r.id);
    if (r.prev_image_url) await releaseImage(db, r.prev_image_url);
    if (r.prev_clean_image_url) await releaseImage(db, r.prev_clean_image_url);
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] apply handout error:', e.message); res.json({ error: 'Could not lay the writing on the picture.' }); }
});

// v3.3.93 -- TAKE THE WRITING OR THE TITLE OFF. Ian: "I'm having trouble removing the text from the picture once it's
// on it." The picture is laid again from the clean copy with only what is left (or becomes the clean copy itself when
// nothing is). The recipe keeps the words and the lettering, marked off, so Place or Apply puts them back; Regen and
// Retouch leave them off. Free; the picture before goes to Revert.
router.post('/builder/images/:id/layer-off', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    const what = (req.body && req.body.what === 'title') ? 'title' : ((req.body && req.body.what === 'handout') ? 'handout' : '');
    if (!what) return res.json({ error: 'Nothing to take off.' });
    let refs = {}; try { refs = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { refs = {}; }
    const before = ibLayersOf(refs);
    if (!r.clean_image_url || !before || !before[what]) return res.json({ error: what === 'title' ? 'There is no title on this picture to take off.' : 'There is no writing on this picture to take off.' });
    refs.prevLayers = ibSnapLayers(refs);   // v3.4.01
    refs[what] = Object.assign({}, refs[what], { off: true });
    const after = ibLayersOf(refs);
    let shown = r.clean_image_url, clean = null;
    if (after) {
      try { shown = await ibCompose(r.clean_image_url, after, r.id); clean = r.clean_image_url; } catch (e) {
        console.error('[image-builder] layer off error:', e.message);
        return res.json({ error: 'Could not take it off. Please try again.' });
      }
    }
    await db.prepare('UPDATE builder_images SET image_url = ?, clean_image_url = ?, prev_image_url = ?, prev_img_w = ?, prev_img_h = ?, prev_clean_image_url = ?, refs = ?, updated_at = ? WHERE id = ?')
      .run(shown, clean, r.image_url, r.img_w || null, r.img_h || null, r.clean_image_url || null, JSON.stringify(refs), new Date().toISOString(), r.id);
    if (r.prev_image_url) await releaseImage(db, r.prev_image_url);
    if (r.prev_clean_image_url) await releaseImage(db, r.prev_clean_image_url);
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] layer off error:', e.message); res.json({ error: 'Could not take it off.' }); }
});

// v3.3.85 -- Apply title: the Title section's lettering, laid on the clean copy at its placement and size, with no
// redraw and no token. A picture with no clean copy is used as it is and becomes the clean copy -- unless its title was
// drawn by the art style (typed, with no lettering), which cannot be lifted off. The picture before goes to Revert.
router.post('/builder/images/:id/title', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    if (!r.image_url) return res.json({ error: 'The picture has to finish drawing first.' });
    const ttl = ibCleanTitle(req.body && req.body.title);
    if (!ttl || !ttl.url) return res.json({ error: 'Design the lettering with the Title Builder first.' });
    let refs = {}; try { refs = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { refs = {}; }
    // v3.3.93 -- a typed title is no longer drawn by the art style, so there is no drawn-in title to refuse over.
    const base = r.clean_image_url || r.image_url;
    let shown;
    const _hoL = ibLayersOf(refs); // v3.3.92 -- the handout's writing goes back on too
    try { shown = await ibCompose(base, { title: ttl, handout: _hoL && _hoL.handout }, r.id); } catch (e) {
      console.error('[image-builder] apply title error:', e.message);
      try { await logDebug(req.session.userId, { level: 'error', source: 'generation', page: 'Image Builder', fn: 'POST /builder/images/:id/title', message: 'Could not lay the title on picture ' + r.id + ': ' + (e && e.message), detail: { picture: base, lettering: ttl.url, place: ttl.place, size: ttl.size } }); } catch (_le) {}   // v3.3.87
      return res.json({ error: 'Could not lay the title on the picture. Please try again.' });
    }
    refs.prevLayers = ibSnapLayers(refs);   // v3.4.01
    refs.title = ttl;
    await db.prepare('UPDATE builder_images SET image_url = ?, clean_image_url = ?, prev_image_url = ?, prev_img_w = ?, prev_img_h = ?, prev_clean_image_url = ?, refs = ?, updated_at = ? WHERE id = ?')
      .run(shown, base, r.image_url, r.img_w || null, r.img_h || null, r.clean_image_url || null, JSON.stringify(refs), new Date().toISOString(), r.id);
    if (r.prev_image_url) await releaseImage(db, r.prev_image_url);
    if (r.prev_clean_image_url) await releaseImage(db, r.prev_clean_image_url);
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] apply title error:', e.message); res.json({ error: 'Could not lay the title on the picture.' }); }
});

// v3.3.83 -- Rename: Ian, "The name change save should happen on blur". The maker only; allowed while it is drawing,
// since the name is not part of the picture.
router.post('/builder/images/:id/name', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare('SELECT id, user_id, campaign_id FROM builder_images WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'That picture is no longer in the gallery.' });
    if (String(r.user_id) !== String(req.session.userId)) return res.status(403).json({ error: 'Only the person who made a picture can rename it.' });
    if (!(await ibAllowed(req.session.userId, r.campaign_id))) return res.status(403).json({ error: 'NOT_PLATINUM', message: 'The Image Builder is a Platinum feature.' });
    const name = String((req.body && req.body.name) || '').trim().slice(0, IB_NAME_MAX);
    if (!name) return res.json({ error: 'Give the picture a name.' });
    await db.prepare('UPDATE builder_images SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), r.id);
    res.json({ success: true, name: name });
  } catch (e) { console.error('[image-builder] rename error:', e.message); res.json({ error: 'Could not rename the picture.' }); }
});

// v3.3.74 -- Edit Prompt: the picture's own words (what follows the house rules, style and references in the
// prompt). Saved here; Regen sends them. The whole assembled prompt stays read-only (builder_images.prompt).
router.post('/builder/images/:id/words', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    const words = String((req.body && req.body.words) || '').trim().slice(0, IB_WORDS_MAX);
    if (!words) return res.json({ error: 'The prompt can\u2019t be empty.' });
    await db.prepare('UPDATE builder_images SET words = ?, updated_at = ? WHERE id = ?').run(words, new Date().toISOString(), r.id);
    res.json({ success: true, words: words });
  } catch (e) { console.error('[image-builder] words error:', e.message); res.json({ error: 'Could not save the prompt.' }); }
});

// v3.3.74 -- Regen: the same recipe and words, a new seed, one token (spent when the picture arrives). The picture
// on show goes to the one-deep undo slot (prev_image_url) when the new one lands, so Revert can bring it back.
router.post('/builder/images/:id/regen', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    const uid = req.session.userId, cid = r.campaign_id;
    const built = await ibBuildAndSubmit(req, res, db, uid, cid, ibRecipeOf(r), r.words || null);
    if (!built) return;
    const sub = built.sub;
    await db.prepare('UPDATE builder_images SET prompt = ?, words = ?, refs = ?, art_style_name = ?, updated_at = ? WHERE id = ?')
      .run(sub.prompt || built.words, built.words, JSON.stringify(built.refsOut), built.styleName, new Date().toISOString(), r.id);
    const job = await ibQueueJob(db, uid, cid, sub, r.art_style, built.cost, r.id, r.image_url || null);
    await logDebug(uid, { level: 'info', source: 'generation', page: 'Image Builder', fn: 'POST /builder/regen',
      message: 'Regenerating Image Builder picture ' + r.id + ' (request ' + sub.request_id + ')', detail: { finalPrompt: sub.prompt || '', systemPrompt: sub.system_prompt || '' } });
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.status(202).json({ status: 'queued', job_id: job.lastInsertRowid, image: ibRow(row) });
  } catch (e) {
    console.error('[image-builder] regen error:', e.message);
    res.json({ error: friendlyImageError(e) });
  }
});

// v3.3.74 -- Revert: swap the picture and the one in the undo slot (so a second Revert goes forward again).
router.post('/builder/images/:id/revert', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    if (!r.prev_image_url) return res.json({ error: 'There is no earlier picture to go back to.' });
    // v3.4.01 -- the title and writing go back with the picture (a picture from before v3.4.01 keeps the recipe as it is).
    let _rrefs = {}; try { _rrefs = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { _rrefs = {}; }
    const _swapped = ibSwapLayers(_rrefs);
    await db.prepare('UPDATE builder_images SET image_url = ?, img_w = ?, img_h = ?, clean_image_url = ?, prev_image_url = ?, prev_img_w = ?, prev_img_h = ?, prev_clean_image_url = ?, refs = ?, updated_at = ? WHERE id = ?')
      .run(r.prev_image_url, r.prev_img_w || null, r.prev_img_h || null, r.prev_clean_image_url || null, r.image_url, r.img_w || null, r.img_h || null, r.clean_image_url || null, _swapped ? JSON.stringify(_rrefs) : (r.refs || null), new Date().toISOString(), r.id);   // v3.3.85 -- the clean copies swap too
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] revert error:', e.message); res.json({ error: 'Could not go back to the earlier picture.' }); }
});

// v3.4.07 -- TD-1088. THE REFERENCES SAVE TO THE PICTURE AS THEY CHANGE (Ian, 2026-11-02: "They should behave just like
// the story panels"). A Story panel's cast is saved the moment it is edited and Retouch reads it from the panel; the
// Builder kept its References in the form only, while Retouch and Regen read the picture's saved list, so a character
// added after the picture was drawn was never offered or sent. The page now posts the whole list here on every add or
// remove while one of the maker's own pictures is open. Checked exactly as Generate checks it (ibResolveCharacters: in
// the campaign, a look the maker may use; assets in the campaign with a picture; the reference cap; the rights check).
// Only refs.characters and refs.assets change: the title, the handout, the type text and the undo slot's layers stay.
// Removing a character removes their reference from the next Retouch or Regen (Ian: "that's what they get").
router.post('/builder/images/:id/refs', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    const uid = req.session.userId, cid = r.campaign_id, b = req.body || {};
    const rc = await ibResolveCharacters(db, cid, uid, Array.isArray(b.characters) ? b.characters : []);
    if (rc.error) return res.json({ error: rc.error });
    const chars = rc.chars;
    const assetIds = (Array.isArray(b.assets) ? b.assets : []).map(function (x) { return parseInt(x, 10); }).filter(function (x, i, a) { return x > 0 && a.indexOf(x) === i; });
    const allAssets = assetIds.length ? await db.prepare(ASSET_REF_SQL).all(cid) : [];
    const assets = assetIds.map(function (id) { return allAssets.filter(function (a) { return Number(a.id) === id && a.image_url; })[0]; }).filter(Boolean);
    if (assets.length !== assetIds.length) return res.json({ error: 'One of the assets is no longer available, or its picture was removed.' });
    const _rsn = await ibResolveScenes(db, cid, b.scenes);   // v3.4.19 -- TD-1095
    if (_rsn.error) return res.json({ error: _rsn.error });
    if (chars.length + assets.length + _rsn.scenes.length > MAX_PANEL_REFS) return res.json({ error: 'Use at most ' + MAX_PANEL_REFS + ' reference pictures in one image.' });
    if (await rightsCheck.refuseRejected(res, chars.map(function (c) { return c.snapshot_reference_url; }), 'It can\u2019t be used as a reference. Choose another look.')) return;
    let refs = {}; try { refs = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { refs = {}; }
    if (!refs || typeof refs !== 'object') refs = {};
    refs.characters = chars.map(function (c) { return { id: c.character_id, name: c.name, look: c._look, label: c._label }; });   // as Generate stores them
    refs.assets = assets.map(function (a) { return { id: a.id, name: a.name, category: a.category || 'location' }; });
    refs.scenes = _rsn.scenes.map(function (s) { return { id: s.id, name: s.name }; });   // v3.4.19
    await db.prepare('UPDATE builder_images SET refs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(refs), new Date().toISOString(), r.id);
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] refs error:', e.message); res.json({ error: 'Could not save the references to this picture.' }); }
});

// v3.3.74 -- Archive: a copy of the picture into the campaign's Archive (as a picture, image_type 'moment' with no
// session, so the cover, title and Replace pickers take it like any archived panel). The archive cap and the rights
// check apply as on every other Archive button. The maker only.
router.post('/builder/images/:id/archive', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    if (!r.image_url) return res.json({ error: 'The picture has to finish drawing before it can be archived.' });
    // v3.3.85 -- clean: the copy without the title (Archive asks which, when there is one).
    const _src = (req.body && req.body.clean && r.clean_image_url) ? r.clean_image_url : r.image_url;
    const already = await db.prepare("SELECT id FROM campaign_archives WHERE campaign_id = ? AND source_url = ? LIMIT 1").get(r.campaign_id, _src);
    if (already) return res.json({ success: true, already: true });
    try {
      const effTier = getTier(await getEffectiveTier(req.session.userId, r.campaign_id));
      const cap = effTier ? effTier.max_archives_per_campaign : null;
      if (cap !== null && cap !== undefined) {
        const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_archives WHERE campaign_id = ?').get(r.campaign_id);
        if (cnt && Number(cnt.c) >= cap) return res.json({ error: 'This campaign has hit its archive limit of ' + cap + ' images on the ' + effTier.name + ' tier. Remove an archived image to make room, or upgrade for more.' });
      }
    } catch (capErr) { console.error('[image-builder] archive cap check error:', capErr.message); }
    if (await rightsCheck.refuseRejected(res, [_src], 'It can\u2019t be archived. Replace it with a picture you have the rights to.')) return;
    const { archiveCopy } = require('../storage/storage');
    const archivedUrl = await archiveCopy(_src);
    await db.prepare(
      'INSERT INTO campaign_archives (campaign_id, image_type, title, image_url, source_url, image_prompt, art_style, art_style_name, img_w, img_h, shape, archived_by, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(r.campaign_id, 'moment', (r.name || 'Image Builder picture') + (_src !== r.image_url ? ' (clean copy)' : ''), archivedUrl, _src, r.words || r.description || null, r.art_style || null, r.art_style_name || null, r.img_w || null, r.img_h || null, r.shape || null, req.session.userId, new Date().toISOString());
    // v3.4.24 -- TD-1100. Archived WITH its title: remember the words it was laid on with, for the cover word check.
    if (_src === r.image_url) {
      try {
        let _rf = {}; try { _rf = r.refs ? JSON.parse(r.refs) : {}; } catch (e) { _rf = {}; }
        const _t = _rf && _rf.title;
        if (_t && _t.url && !_t.off && String(_t.title || '').trim() && r.clean_image_url)
          await db.prepare('INSERT INTO image_title_words (url, campaign_id, title, subtitle) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO NOTHING')
            .run(archivedUrl, r.campaign_id, String(_t.title).trim().slice(0, 200), String(_t.subtitle || '').trim().slice(0, 200) || null);
      } catch (e) { console.error('[image-builder] title words error:', e.message); }
    }
    res.json({ success: true });
  } catch (e) { console.error('[image-builder] archive error:', e.message); res.json({ error: 'Could not archive the picture.' }); }
});

// v3.3.74 -- Make My Copy: anyone in the campaign who can see the picture (Ready, or their own) gets their own copy
// of its recipe, words and current picture, as a new Draft of theirs in the same campaign. Free: nothing is drawn.
// The picture file is shared, which releaseImage already allows for (it keeps a file any row still names).
router.post('/builder/images/:id/copy', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const uid = req.session.userId;
    const r = await db.prepare('SELECT * FROM builder_images WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'That picture is no longer in the gallery.' });
    if (!(await ibAllowed(uid, r.campaign_id))) return res.status(403).json({ error: 'NOT_PLATINUM', message: 'The Image Builder is a Platinum feature.' });
    if (r.is_ready === false && String(r.user_id) !== String(uid)) return res.status(404).json({ error: 'That picture is no longer in the gallery.' });
    if (!r.image_url) return res.json({ error: 'The picture has to finish drawing before it can be copied.' });
    const now = new Date().toISOString();
    const ins = await db.prepare(
      'INSERT INTO builder_images (campaign_id, user_id, name, description, image_type, shape, art_style, art_style_name, include_lore, refs, prompt, words, image_url, img_w, img_h, clean_image_url, is_ready, copied_from, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(r.campaign_id, uid, String(r.name || 'Picture').slice(0, IB_NAME_MAX - 7) + ' (copy)', r.description, r.image_type, r.shape, r.art_style, r.art_style_name, r.include_lore, r.refs, r.prompt, r.words, r.image_url, r.img_w, r.img_h, r.clean_image_url || null, false, r.id, now, now);   // v3.3.85 -- with its clean copy
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(ins.lastInsertRowid);
    res.json({ success: true, image: ibRow(row) });
  } catch (e) { console.error('[image-builder] copy error:', e.message); res.json({ error: 'Could not copy the picture.' }); }
});

// v3.3.82 -- Retouch a Builder picture, through the same submitRetouch the Story panels use: the picture is Image 1,
// the recipe's references follow, the reader's markers ride along as a location diagram (marked_url), and a picked
// reference narrows the payload to that one (ref_name). One token, spent when the picture arrives; the picture on
// show moves into the Revert slot (the 'builder' webhook branch). The maker only, nothing being drawn.
router.post('/builder/images/:id/retouch', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await ibOwnIdle(req, res, db); if (!r) return;
    const uid = req.session.userId, cid = r.campaign_id;
    const instruction = String((req.body && req.body.instruction) || '').trim();
    if (!instruction) return res.json({ error: 'Describe the change you want.' });
    if (!r.image_url) return res.json({ error: 'The picture has to finish drawing before it can be retouched.' });
    if (await rightsCheck.refuseRejected(res, [r.image_url], 'It can\u2019t be retouched. Replace it with a picture you have the rights to. Nothing was charged.')) return;
    const fal_key = process.env.FAL_API_KEY;
    if (!fal_key) return res.json({ error: 'Image generation is not configured. Please contact support.' });
    const webhookUrl = falWebhookUrl();
    if (!webhookUrl) return res.json({ error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' });
    const _rs = await resolveGenStyle(db, r.art_style, uid, cid);
    if (_rs.locked) return res.json({ error: 'STYLE_LOCKED', message: 'That custom art style isn\u2019t available right now. It needs an active Platinum plan.' });
    // The references this picture was drawn with, resolved again from the database (a removed one is left out
    // rather than refusing the retouch: the picture itself is what is being changed).
    const recipe = ibRecipeOf(r);
    const chars = [];
    for (const c of (recipe.refs.characters || [])) {
      const one = await ibResolveCharacters(db, cid, uid, [c]);
      if (!one.error && one.chars.length) chars.push(one.chars[0]);
    }
    const assetIds = (recipe.refs.assets || []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; });
    const assets = assetIds.length ? (await db.prepare(ASSET_REF_SQL).all(cid)).filter(function (a) { return assetIds.indexOf(Number(a.id)) >= 0 && a.image_url; }) : [];
    const charList = buildCharacterBlock(chars, '', 0, chars.map(function (c) { return c.character_id; }));
    const assetList = buildAssetBlock(assets, '', assets.map(function (a) { return a.id; }));
    const _rsnR = (ibSceneNote(ibType(r.image_type)) !== null) ? await ibResolveScenes(db, cid, recipe.refs.scenes) : { scenes: [] };   // v3.4.19 -- TD-1095
    const refs = combineRefs(charList.refs, assetList.refs.concat((_rsnR.scenes || []).map(function (s) { return { name: s.name, url: s.url, category: 'scene', isAsset: true }; })));
    // {{REF:Name}} placeholders and a picked reference, worded exactly as the panel route words them.
    let instr = instruction;
    if (instr.indexOf('{{REF:') !== -1) {
      instr = instr.replace(/\{\{REF:([^}]*)\}\}/g, function (m, nm) {
        const want = String(nm || '').trim().toLowerCase();
        for (let i = 0; i < refs.length; i++) {
          const rn = refs[i] && refs[i].name;
          if (rn && String(rn).trim().toLowerCase() === want) return 'the single reference picture supplied with this request, which is the reference for ' + rn + ',';
        }
        return 'the supplied reference image for ' + nm;
      });
    }
    const pick = String((req.body && req.body.ref_name) || '').trim();
    if (pick) {
      const hit = refs.filter(function (x) { return x && x.name && String(x.name).trim().toLowerCase() === pick.toLowerCase(); })[0];
      if (hit) instr = 'The character or object being corrected is ' + hit.name + '. The single reference picture supplied with this request is the reference for ' + hit.name +
        ', and it is the only one supplied. Apply the change to ' + hit.name + ' and to no one else.\n\n' + instr;
    }
    let marked = String((req.body && req.body.marked_url) || '').trim();
    if (marked && !isOurPublicUrl(marked)) marked = '';
    const modelKey = await getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(uid, cost))) return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' });
    // v3.3.85 -- the clean copy is retouched; the lettering goes back on when it lands.
    const sub = await submitRetouch(r.clean_image_url || r.image_url, instr, _rs.styleForGen, fal_key, webhookUrl, { refs: refs, text: charList.text }, r.shape, marked || null, pick || null, false, null);
    const now = new Date().toISOString();
    const job = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, kind, status, model, style, cost, builder_image_id, prev_image, temp_inputs, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, uid, cid, 'builder', 'queued', sub.model, r.art_style, cost, r.id, r.image_url, marked ? JSON.stringify([marked]) : null, now, now);
    await logDebug(uid, { level: 'info', source: 'generation', page: 'Image Builder', fn: 'POST /builder/retouch',
      message: 'Retouching Image Builder picture ' + r.id + ' (request ' + sub.request_id + ')', detail: { instruction_raw: instruction, ref_name_picked: pick || null, refs: refs.map(function (x) { return x && x.name; }), marked_url: marked ? 'yes' : 'no', instruction_sent: instr,
      art_style: r.art_style, art_style_name: _rs.name || null } });   // v3.4.05 -- TD-1085: the style this retouch sent
    const row = await db.prepare(IB_LIST_SQL + 'WHERE b.id = ?').get(r.id);
    res.status(202).json({ status: 'queued', job_id: job.lastInsertRowid, image: ibRow(row) });
  } catch (e) {
    console.error('[image-builder] retouch error:', e.message);
    res.json({ error: friendlyImageError(e) });
  }
});

// v3.3.73 -- Draft / Ready: the maker only, in a campaign they may still use the Builder in, and only once the
// picture has arrived (a picture still drawing, or one that failed, stays a draft).
router.post('/builder/images/:id/ready', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare('SELECT id, user_id, campaign_id, image_url FROM builder_images WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'That picture is no longer in the gallery.' });
    if (String(r.user_id) !== String(req.session.userId)) return res.status(403).json({ error: 'Only the person who made a picture can change whether it is ready.' });
    if (!(await ibAllowed(req.session.userId, r.campaign_id))) return res.status(403).json({ error: 'NOT_PLATINUM', message: 'The Image Builder is a Platinum feature.' });
    const ready = !!(req.body && req.body.ready === true);
    if (ready && !r.image_url) return res.json({ error: 'The picture has to finish drawing before it can be marked Ready.' });
    await db.prepare('UPDATE builder_images SET is_ready = ?, updated_at = ? WHERE id = ?').run(ready, new Date().toISOString(), r.id);
    res.json({ success: true, ready: ready });
  } catch (e) { console.error('[image-builder] ready error:', e.message); res.json({ error: 'Could not change the picture.' }); }
});

router.delete('/builder/images/:id', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare('SELECT * FROM builder_images WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'That picture is no longer in the gallery.' });
    if (String(r.user_id) !== String(req.session.userId)) return res.status(403).json({ error: 'Only the person who made a picture can delete it.' });
    const busy = await db.prepare("SELECT id FROM image_jobs WHERE builder_image_id = ? AND status IN ('queued', 'processing') AND created_at > ? LIMIT 1").get(r.id, new Date(Date.now() - IB_JOB_WINDOW_MS).toISOString());
    if (busy) return res.json({ error: 'That picture is still being drawn. Delete it once it has finished.' });
    await db.prepare('DELETE FROM builder_images WHERE id = ?').run(r.id);
    if (r.image_url) await releaseImage(db, r.image_url);
    if (r.prev_image_url) await releaseImage(db, r.prev_image_url);
    if (r.clean_image_url) await releaseImage(db, r.clean_image_url);   // v3.3.85
    if (r.prev_clean_image_url) await releaseImage(db, r.prev_clean_image_url);
    res.json({ success: true });
  } catch (e) { console.error('[image-builder] delete error:', e.message); res.json({ error: 'Could not delete the picture.' }); }
});

// v3.5.09 -- TD-090. RETOUCH ON A VIDEO KEYFRAME, started by routes/videoLab.js (which checks video access, the episode
// and the picture first). The same retouch the Story panels use: the picture is Image 1; a keyframe from a storyboard
// panel brings that panel's cast and assets as references (as retouch-moment gathers them); one from the Archive has
// none. The reader's markers ride along (marked_url) and a picked reference narrows the payload (ref_name). The usual
// retouch price, spent when the picture arrives (the 'keyframe' webhook branch). Returns { job_id } or { error }.
async function startKeyframeRetouch(db, o) {
  const fal_key = process.env.FAL_API_KEY;
  if (!fal_key) return { error: 'Image generation is not configured. Please contact support.' };
  const webhookUrl = falWebhookUrl();
  if (!webhookUrl) return { error: 'Image service is not fully configured (PUBLIC_BASE_URL is unset).' };
  const instruction = String(o.instruction || '').trim();
  if (!instruction) return { error: 'Describe the change you want.' };
  const modelKey = await getSelectedModel(db);
  const cost = await getTokenCost(modelKey);
  if (!(await canAfford(o.userId, cost))) return { error: 'INSUFFICIENT_TOKENS', message: 'You\u2019re out of tokens. Add more to keep generating.' };
  let refs = [], charText = '', shape = o.shape || null, style = o.style || null;   // shape: the Archive row's, for a picture from the Archive
  const moment = o.momentId ? await db.prepare('SELECT m.*, s.campaign_id AS campaign_id FROM moments m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?').get(o.momentId) : null;
  if (moment && Number(moment.campaign_id) === Number(o.campaignId)) {
    const chars = await db.prepare(
      'SELECT ch.id AS character_id, ch.name, ch.cls, ch.description, ch.canonical_prompt, ch.canonical_reference_url, ' +
      'sc.prompt AS snapshot_prompt, sc.reference_url AS snapshot_reference_url, ' +
      'sc.change_note, sc.change_moment_index, sc.change_status ' +
      'FROM characters ch ' +
      'LEFT JOIN session_characters sc ON sc.character_id = ch.id AND sc.fork_id = ? ' +
      'WHERE ch.campaign_id = ?'
    ).all(moment.fork_id, o.campaignId);
    await attachPriorReferences(db, chars, moment.session_id, o.campaignId, moment.fork_id);
    const text = (moment.prompt || '') + ' ' + (moment.description || '') + ' ' + (moment.title || '');
    let ec = null, ea = null;
    if (moment.cast_explicit) {
      ec = (await db.prepare('SELECT character_id FROM moment_characters WHERE moment_id = ?').all(moment.id)).map(function (r) { return r.character_id; });
      ea = (await db.prepare('SELECT asset_id FROM moment_assets WHERE moment_id = ?').all(moment.id)).map(function (r) { return r.asset_id; });
    }
    const cl = buildCharacterBlock(chars, text, moment.panel_order, ec);
    const al = buildAssetBlock(await db.prepare(ASSET_REF_SQL).all(o.campaignId), text, ea);
    refs = combineRefs(cl.refs, al.refs); charText = cl.text; shape = moment.shape || shape;
    if (!style) style = moment.style || null;
  }
  if (o.forceShape) shape = o.forceShape;   // v3.5.14 -- Expand on the Video tab: drawn wide (16:9) whatever shape the picture was
  let instr = instruction;
  if (instr.indexOf('{{REF:') !== -1) {
    instr = instr.replace(/\{\{REF:([^}]*)\}\}/g, function (m, nm) {
      const want = String(nm || '').trim().toLowerCase();
      for (let i = 0; i < refs.length; i++) {
        const rn = refs[i] && refs[i].name;
        if (rn && String(rn).trim().toLowerCase() === want) return 'the single reference picture supplied with this request, which is the reference for ' + rn + ',';
      }
      return 'the supplied reference image for ' + nm;
    });
  }
  const pick = String(o.refName || '').trim();
  if (pick) {
    const hit = refs.filter(function (x) { return x && x.name && String(x.name).trim().toLowerCase() === pick.toLowerCase(); })[0];
    if (hit) instr = 'The character or object being corrected is ' + hit.name + '. The single reference picture supplied with this request is the reference for ' + hit.name +
      ', and it is the only one supplied. Apply the change to ' + hit.name + ' and to no one else.\n\n' + instr;
  }
  const _rs = await resolveGenStyle(db, style, o.userId, o.campaignId);
  if (_rs.locked) return { error: 'STYLE_LOCKED', message: 'That custom art style isn\u2019t available right now. It needs an active Platinum plan.' };
  let marked = String(o.markedUrl || '').trim();
  if (marked && !isOurPublicUrl(marked)) marked = '';
  const sub = await submitRetouch(o.imageUrl, instr, _rs.styleForGen, fal_key, webhookUrl, { refs: refs, text: charText }, shape, marked || null, (pick && refs.some(function (x) { return x && x.name && String(x.name).trim().toLowerCase() === pick.toLowerCase(); })) ? pick : null, false, null);
  const now = new Date().toISOString();
  const job = await db.prepare(
    'INSERT INTO image_jobs (request_id, user_id, campaign_id, kind, status, model, style, cost, episode_id, prev_image, temp_inputs, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sub.request_id, o.userId, o.campaignId, 'keyframe', 'queued', sub.model, style, cost, o.episodeId, o.imageUrl, marked ? JSON.stringify([marked]) : null, now, now);
  try { await logDebug(o.userId, { level: 'info', source: 'generation', page: 'Video tab', fn: 'POST keyframe retouch', message: 'Retouching a keyframe of episode ' + o.episodeId + ' (request ' + sub.request_id + ')',
    detail: { instruction_raw: instruction, instruction_sent: instr, refs: refs.map(function (x) { return x && x.name; }), ref_name_picked: pick || null, marked_url: marked ? 'yes' : 'no', moment_id: o.momentId || null, style: style } }); } catch (_le) {}
  return { job_id: job.lastInsertRowid, cost: cost };
}

module.exports = router;
module.exports.startKeyframeRetouch = startKeyframeRetouch;   // v3.5.09 -- TD-090
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
// v3.0.849 -- TD-705. THE ALIAS CONVENTION NOW HAS ONE IMPLEMENTATION AND THREE CALLERS.
// These three functions were correct and private, so extract.js and sessions.js each grew
// their own alias handling and BOTH got it wrong -- see the note above characterInText in
// extract.js. Exporting them is additive: nothing in this file changes.
module.exports.characterTokens = characterTokens;
module.exports.characterCanonicalName = characterCanonicalName;
module.exports.characterNameMatches = characterNameMatches;
module.exports.assetTokens = assetTokens;
module.exports.assetNameMatches = assetNameMatches;   // v3.1.9 -- TD-908: suggestions are counted with the SAME matcher the image step uses
module.exports.buildAssetBlock = buildAssetBlock;
module.exports.combineRefs = combineRefs;
module.exports.attachPriorReferences = attachPriorReferences;
module.exports.retouchImage = retouchImage;
module.exports.webhookRouter = webhookRouter;
module.exports.falWebhookUrl = falWebhookUrl;
module.exports.falSetup = falSetup;   // v3.4.86 -- TD-090: the Video Lab sets fal up through the same function, so its calls carry the same privacy headers
module.exports.submitReference = submitReference;
module.exports.submitAssetReference = submitAssetReference;
module.exports.submitEditReference = submitEditReference;
module.exports.submitRetouch = submitRetouch;
// v3.0.817 -- TD-645. The session-character restyle in routes/sessions.js needs
// BOTH of these.
//   resolveGenStyle -- an art style id can be 'custom:<n>', and handing that
//     straight to getStylePrefix returns High fantasy SILENTLY (TD-647). A
//     Platinum user's own custom style would therefore have restyled every
//     character into the default and looked like the button did nothing.
//   getStylePrefix -- the style paragraph has to be placed INSIDE the restyle
//     instruction, scoped to the figure, instead of riding at the top of the
//     prompt where it paints a background over the white reference staging.
module.exports.resolveGenStyle = resolveGenStyle;
module.exports.styleFlags = styleFlags;            // v3.2.52 -- TD-966
module.exports.buildPanelInput = buildPanelInput;  // v3.2.52 -- for the guard
module.exports.getStylePrefix = getStylePrefix;
module.exports.ASSET_REF_SQL = ASSET_REF_SQL;   // v3.1.90 -- TD-979, shared with sessions.js
