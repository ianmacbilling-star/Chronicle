const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { friendlyAnthropicError } = require('../middleware/friendlyErrors');
const { requireAuth, getCampaignRole } = require('../middleware/auth');
const { getEffectiveTier } = require('../middleware/tiers');
const { TEXT_MODEL } = require('../config/models');
const { canAfford, spendTokens, recordGeneration } = require('./tokens');
const { uploadFile, releaseImage } = require('../storage/storage');
const multer = require('multer');
const { imageFileFilter, friendlyUploadMsg, ACCEPTED_MIME } = require('../middleware/uploadGuard');
const rightsCheck = require('../services/rightsCheck');   // v3.1.90 -- TD-979 (and v3.1.91: inside Analyze)
const path = require('path');

// Custom Art Styles are account-wide and owned by the user. CREATE / manage is
// gated on the owner's TRUE account tier being Platinum (their own users.tier),
// NOT effective tier: joining a higher-tier SM's campaign never grants
// account-level allowances. getEffectiveTier(userId, null) returns the user's
// own tier. Free-Trial (tier 'trial') and extended members are excluded.
async function requireTruePlatinum(req, res, next) {
  try {
    const own = await getEffectiveTier(req.session.userId, null);
    if (own !== 'platinum') {
      return res.status(403).json({ error: 'NOT_PLATINUM', message: 'Building your own art style is a Platinum feature.' });
    }
    next();
  } catch (e) {
    console.error('platinum gate error:', e.message);
    res.status(500).json({ error: 'Could not verify your plan.' });
  }
}

function parseSamples(raw) {
  try { return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}

function rowOut(r) {
  if (!r) return r;
  return {
    id: r.id,
    name: r.name,
    style_prompt: r.style_prompt,
    is_fade: r.is_fade ? 1 : 0,
    sample_urls: parseSamples(r.sample_urls),
    preview_url: r.preview_url || null,
    answers: parseJsonCol(r.style_answers),          // v3.1.66 -- TD-964
    options: parseJsonCol(r.style_options),
    winner: (r.style_winner === null || r.style_winner === undefined) ? null : r.style_winner,
    group_url: winnerGroupUrl(r),   // v3.2.22
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

function fadeFromBody(v, fallback) {
  if (v === undefined) return fallback;
  return (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
}

// GET /api/art-styles/custom -- list the caller's own custom styles.
// Not Platinum-gated for reads: a user who lapses from Platinum keeps seeing
// (and can delete) styles they already built; CREATE/EDIT stay gated.
router.get('/custom', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT * FROM custom_art_styles WHERE owner_id = ? ORDER BY created_at ASC'
    ).all(req.session.userId);
    res.json((rows || []).map(rowOut));
  } catch (e) {
    console.error('list custom styles error:', e.message);
    res.json({ error: 'Could not load your custom styles.' });
  }
});

// GET /api/art-styles/custom/available/:campaignId -- styles the caller may USE
// for generation in this campaign: their OWN styles (only while the caller is
// currently true Platinum) PLUS the campaign SM's styles (only while the SM is
// currently true Platinum and the caller is a member). Never peer members'
// styles. Lean output (no style_prompt) so the SM's directive text isn't exposed
// to members; the picker only needs id/name/thumbnail. shared_by_sm flags the
// SM group in the UI.
// v3.2.22 -- the card picture. Ian, 2026-10-20: show the CHOSEN winner's group preview if one was made, else
// fall back to the first reference picture (the page does the fallback). Winner only: an unchosen option's
// preview is not the style. URL-checked like every stored preview. No style text goes out with it.
function winnerGroupUrl(r) {
  try {
    const opts = parseJsonCol(r && r.style_options);
    const w = (r && r.style_winner !== null && r.style_winner !== undefined) ? Number(r.style_winner) : NaN;
    if (!Array.isArray(opts) || !Number.isInteger(w) || w < 0 || w >= opts.length) return null;
    const o = opts[w] || {};
    return cleanPreviewUrl(o.previews && o.previews.group);
  } catch (e) { return null; }
}
function pickRowOut(r, sharedBySm) {
  if (!r) return r;
  return { id: r.id, name: r.name, is_fade: r.is_fade ? 1 : 0, sample_urls: parseSamples(r.sample_urls), shared_by_sm: sharedBySm ? 1 : 0, group_url: winnerGroupUrl(r) };
}

router.get('/custom/available/:campaignId', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const campaignId = req.params.campaignId;
    const out = [];
    const seen = {};

    // Caller's own styles -- only if the caller is currently true Platinum.
    const ownTier = await getEffectiveTier(req.session.userId, null);
    if (ownTier === 'platinum') {
      const mine = await db.prepare(
        'SELECT * FROM custom_art_styles WHERE owner_id = ? ORDER BY created_at ASC'
      ).all(req.session.userId);
      for (const r of (mine || [])) { if (!seen[r.id]) { seen[r.id] = 1; out.push(pickRowOut(r, false)); } }
    }

    // The campaign SM's styles -- only if the caller is a member and the SM is
    // currently true Platinum. (If the caller IS the SM, their styles already
    // appeared above and are deduped here.)
    if (campaignId) {
      const role = await getCampaignRole(req.session.userId, campaignId);
      if (role) {
        const dm = await db.prepare(
          "SELECT user_id FROM campaign_members WHERE campaign_id = ? AND role = 'dm'"
        ).get(campaignId);
        if (dm && String(dm.user_id) !== String(req.session.userId)) {
          const dmTier = await getEffectiveTier(dm.user_id, null);
          if (dmTier === 'platinum') {
            const smStyles = await db.prepare(
              'SELECT * FROM custom_art_styles WHERE owner_id = ? ORDER BY created_at ASC'
            ).all(dm.user_id);
            for (const r of (smStyles || [])) { if (!seen[r.id]) { seen[r.id] = 1; out.push(pickRowOut(r, true)); } }
          }
        }
      }
    }

    res.json(out);
  } catch (e) {
    console.error('available custom styles error:', e.message);
    res.json([]);
  }
});

// POST /api/art-styles/custom -- save a new custom style. Platinum-gated.
router.post('/custom', requireAuth, requireTruePlatinum, async function(req, res) {
  try {
    const name = (req.body && req.body.name || '').trim();
    const stylePrompt = (req.body && req.body.style_prompt || '').trim();
    const isFade = fadeFromBody(req.body && req.body.is_fade, 0);
    const sampleUrls = (req.body && Array.isArray(req.body.sample_urls)) ? req.body.sample_urls : [];
    let previewUrl = (req.body && typeof req.body.preview_url === 'string' && req.body.preview_url) ? req.body.preview_url : null;
    // v3.1.66 -- TD-964. The questions screen sends answers, up to three options and a winner. The text
    // story panels use (style_prompt) is the winner's, or the first option's until one is chosen.
    const answers = cleanAnswers(req.body && req.body.answers);
    const options = cleanOptions(req.body && req.body.options);
    const winner = cleanWinner(req.body && req.body.winner, options);
    const chosen = chosenText(options, winner);
    if (options && options.length) previewUrl = thumbOf(options, winner);   // with options, the thumbnail is always one of their pictures (or none)
    if (!name) return res.json({ error: 'Please name your style.' });
    if (!stylePrompt && !chosen) return res.json({ error: 'The style description is empty. Analyze your samples or write one first.' });
    const stylePromptN = chosen || normStyle(stylePrompt);
    const db = await getDb();
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO custom_art_styles (owner_id, name, style_prompt, is_fade, sample_urls, preview_url, style_answers, style_options, style_winner, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.session.userId, name, stylePromptN, isFade, JSON.stringify(sampleUrls), previewUrl,
      answers ? JSON.stringify(answers) : null, options ? JSON.stringify(options) : null, winner, now, now);
    const row = await db.prepare('SELECT * FROM custom_art_styles WHERE id = ?').get(result.lastInsertRowid);
    res.json(rowOut(row));
  } catch (e) {
    console.error('save custom style error:', e.message);
    res.json({ error: 'Could not save your custom style.' });
  }
});

// PUT /api/art-styles/custom/:id -- edit name / paragraph / fade. Owner + Platinum.
router.put('/custom/:id', requireAuth, requireTruePlatinum, async function(req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare(
      'SELECT * FROM custom_art_styles WHERE id = ? AND owner_id = ?'
    ).get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    const name = (req.body && req.body.name !== undefined) ? String(req.body.name).trim() : row.name;
    const stylePrompt = (req.body && req.body.style_prompt !== undefined) ? String(req.body.style_prompt).trim() : row.style_prompt;
    const isFade = fadeFromBody(req.body && req.body.is_fade, row.is_fade ? 1 : 0);
    let previewUrl = (req.body && req.body.preview_url !== undefined) ? (req.body.preview_url || null) : row.preview_url;
    // v3.1.66 -- TD-964. Answers, options and winner; each kept as stored when the body leaves it out.
    const hasOpts = !!(req.body && req.body.options !== undefined);
    const answers = (req.body && req.body.answers !== undefined) ? cleanAnswers(req.body.answers) : parseJsonCol(row.style_answers);
    const options = hasOpts ? cleanOptions(req.body.options) : parseJsonCol(row.style_options);
    const winner = (req.body && req.body.winner !== undefined) ? cleanWinner(req.body.winner, options)
      : cleanWinner(row.style_winner, options);
    const sampleUrls = (req.body && Array.isArray(req.body.sample_urls))
      ? req.body.sample_urls.filter(function (u) { return typeof u === 'string' && /^https:\/\//.test(u); }).slice(0, 4)
      : null;
    // v3.1.67 -- until a winner is chosen, stories keep the style as it was last saved (spec section 3):
    // after Rewrite or Convert the old text stays in force, and only Use this one changes it.
    const chosen = hasOpts ? ((winner === null && row.style_prompt) ? row.style_prompt : chosenText(options, winner)) : '';
    if (hasOpts && options && options.length) previewUrl = thumbOf(options, winner);   // always one of the options' pictures, or none
    if (!name) return res.json({ error: 'Please name your style.' });
    if (!stylePrompt && !chosen) return res.json({ error: 'The style description is empty.' });
    const stylePromptN = chosen || normStyle(stylePrompt);
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE custom_art_styles SET name = ?, style_prompt = ?, is_fade = ?, preview_url = ?, style_answers = ?, style_options = ?, style_winner = ?, ' +
      'sample_urls = COALESCE(?, sample_urls), updated_at = ? WHERE id = ? AND owner_id = ?'
    ).run(name, stylePromptN, isFade, previewUrl, answers ? JSON.stringify(answers) : null, options ? JSON.stringify(options) : null, winner,
      sampleUrls ? JSON.stringify(sampleUrls) : null, now, row.id, req.session.userId);
    // Release only what the style no longer points at (thumbnail and every option's previews together).
    await releaseDropped(db, imagesOf(row), imagesOf({ preview_url: previewUrl, style_options: options ? JSON.stringify(options) : null }));
    const updated = await db.prepare('SELECT * FROM custom_art_styles WHERE id = ?').get(row.id);
    res.json(rowOut(updated));
  } catch (e) {
    console.error('update custom style error:', e.message);
    res.json({ error: 'Could not update your custom style.' });
  }
});

// DELETE /api/art-styles/custom/:id -- owner only. Sample-image cleanup is
// handled in the analyze/upload pass (step 2) once samples are persisted.
router.delete('/custom/:id', requireAuth, async function(req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare(
      'SELECT id, preview_url, style_options FROM custom_art_styles WHERE id = ? AND owner_id = ?'
    ).get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    await db.prepare('DELETE FROM custom_art_styles WHERE id = ? AND owner_id = ?').run(row.id, req.session.userId);
    await releaseDropped(db, imagesOf(row), []);   // v3.1.66 -- the thumbnail and every option preview
    res.json({ success: true });
  } catch (e) {
    console.error('delete custom style error:', e.message);
    res.json({ error: 'Could not delete your custom style.' });
  }
});

// ---- Sample upload + the analyze vision call (Platinum-gated) ----
const sampleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter
}).array('images', 4);

// One token covers the analyze vision call (a cheap Claude text call); the style
// is then free on every later panel since it is just text in system_prompt.
const COST_ANALYZE = 1;

// =====================================================================================================
// v3.1.66 -- TD-964. THE QUESTIONS (spec claude/CUSTOM_ART_STYLE_QUESTIONS_SPEC.md).
// =====================================================================================================
//
// Ian, 2026-10-13: custom styles "aren't near as different as I think they should be". Testing showed
// the image model follows the STYLE description almost word for word, and the analyzer wrote that
// description once, unpredictably, leaving out exactly what makes a style itself: the background, where
// the detail goes, finish, faces and figures, energy. Its one worked example (a backlit silhouette with a
// warm glow) leaked into every analysis, which is why the bright styles failed worst.
//
// So every analysis now answers the same 18 questions, in this order, and the descriptions are written
// FROM the answers. The user can edit the answers and ask for fresh descriptions. "None" is a real answer
// and is stated outright, because silence is where the image model falls back on its own habits.
// The keys are stored with the style (custom_art_styles.style_answers); never rename one.
// v3.2.52 -- now 20: Comic paneling and Sound effects joined (TD-966).
const STYLE_QUESTIONS = [
  ['tradition', 'Tradition', 'The broad genre or tradition it belongs to (for example comic ink, anime, watercolor illustration, oil painting, cinematic concept art, collage). Never an artist, studio, franchise or title.'],
  ['medium', 'Medium and technique', 'What it is made with: ink, watercolor, oil, digital paint, pencil, woodcut, mixed media, collage, photographic.'],
  ['finish', 'Finish', 'Polished, crisp, sketchy, loose, or deliberately unfinished.'],
  ['line', 'Line work', 'Outlines or none; thick, thin, even or varied; the color of the line. If edges are made by light against shadow rather than by lines, say so.'],
  ['tones', 'Tonal range', 'Two-tone (black and white only), limited, or full; high-key (mostly light) or low-key (mostly dark).'],
  ['black', 'Black and the darkest areas', 'Large solid masses, small accents, or none; if not black, what the darkest color is.'],
  ['shading', 'Shading', 'Flat hard shapes, cel steps, hatching, soft blending, washes, or none.'],
  ['colour', 'Color', 'The colors by name; bright and saturated or muted; how many; laid flat, washed or textured. If there is no color, say so.'],
  ['light', 'Light and light effects', 'Where light comes from and its color; its effects (glows, rim light, rays, flares, neon, bloom) and HOW they are drawn (flat shapes or soft gradients), or none.'],
  ['surfaces', 'Surfaces', 'Wet, glossy, matte, reflective, translucent.'],
  ['texture', 'Texture', 'Paper grain, brush marks, halftone, grit, or perfectly clean.'],
  ['detail', 'Detail, and where it goes', 'On the main figure only, evenly spread, or minimal everywhere; and how much.'],
  ['background', 'Background', 'A flat color, solid black, simplified shapes, loose and suggestive, full scenery, or bare paper.'],
  ['edges', 'Edges and framing', 'Full bleed to every edge, fading to pure white, fading into paper, or a drawn border.'],
  ['figures', 'Characters: faces, eyes and bodies', 'How people are drawn: eyes (size, shape, highlights), faces, proportions and body type, realistic or stylised, expression.'],   // v3.1.68 -- label made obvious (Ian: "how people should look... Anime... big eyes")
  ['energy', 'Energy and drama', 'Movement (still and calm, or sweeping and dynamic) and intensity (quiet and gentle, or charged and theatrical), described as how things are drawn, never as what happens.'],
  ['atmosphere', 'Atmosphere', 'Fog, smoke, rain, haze, particles, sparkle, or clear air.'],
  // v3.2.52 -- TD-966 (Ian, 2026-10-23): "In picture Panels.. comic style" and "in picture sound effects only... (no
  // other text)". Empty or "none" means one single picture and no lettering, exactly as before. routes/images.js reads
  // these two saved answers itself (styleFlags) and adds fixed rules: black gutters, same people in every panel, and
  // no text except sound effects when asked.
  ['panels', 'Comic paneling', 'Whether each picture is ONE image (none) or a comic page divided into several panels inside it: how many, their sizes, inset panels. Answer "none" unless the images themselves are divided into comic panels.'],
  ['sfx', 'Sound effects', 'Hand-drawn comic sound effects inside the art (BOOM, CRACK) and how they are lettered, or none. Never captions, titles or speech balloons. Answer "none" unless the images contain drawn sound effects.'],
  // v3.2.53 -- Ian: "What the questions missed" is always LAST.
  ['missed', 'What the questions missed', 'Anything else that makes these images look the way they do. Empty if nothing.']
];
const STYLE_ANSWER_MAX = 600;
const STYLE_TEXT_MAX = 4000;
const STYLE_SCENES = ['closeup', 'outdoors', 'group'];

function questionList() {
  return STYLE_QUESTIONS.map(function (q, i) { return (i + 1) + '. ' + q[0] + ' -- ' + q[1] + ': ' + q[2]; }).join('\n');
}

// The rules every description follows, whoever writes it: the analyzer, Rewrite, or Convert. ONE text,
// so the three routes can never drift apart.
const DESCRIPTION_RULES =
  'HOW TO WRITE A DESCRIPTION. It is a directive the image generator must OBEY, applied to scenes that have ' +
  'nothing to do with the reference images. ' +
  '(a) Begin with the literal token "STYLE:". ' +
  '(b) Cover EVERY answer, in the order of the questions, so the defining traits come first. ' +
  '(c) Turn an answer of "none" into an outright prohibition: "no outlines", "no texture", "no glows", "no black". ' +
  '(d) Write COMMANDS in the imperative (Render, Keep, Use only, Fill, Spend) and state traits at their extreme: ' +
  'prefer "stark", "flat", "only", "no detail", "pure", "saturated" over "almost", "fairly", "somewhat". ' +
  '(e) NEVER name or imply any subject, character, figure type, object, animal, plant, building, place or ' +
  'scene element from the reference images; where a shape matters, describe it only by role and tone ' +
  '("the main figure", "large dark masses", "an open upper field"). ' +
  '(f) Never name an artist, studio, franchise or title. Broad traditions (comic ink, anime, oil painting) are fine. ' +
  '(g) Mention edges, frames or borders ONLY as the Edges answer says. Never write words like "consuming the ' +
  'edges", "vignette" or "frame" unless that answer calls for them. ' +
  '(h) Describe light effects exactly as the images draw them. ' +
  '(i) Energy and drama describe HOW things are drawn (sweeping curves, hard contrast, tension in the pose), ' +
  'never events: a calm scene in a dramatic style gets dramatic treatment, not invented danger. ' +
  '(j) Roughly 6 to 10 sentences. Every word is a directive; no art criticism, no preamble. ' +
  // v3.2.52 -- TD-966. The two layout answers are handled by fixed rules at drawing time; the description only adds
  // the arrangement or the lettering look, and stays silent when they are none.
  '(k) Comic paneling: if the answer is empty or none, say NOTHING about panels (one picture is the default). ' +
  'Otherwise add ONE sentence describing the panel arrangement (how many panels, their sizes, any insets); do not ' +
  'mention gutter colour, which is set elsewhere. ' +
  '(l) Sound effects: if the answer is empty or none, say NOTHING about lettering. Otherwise add ONE sentence on how ' +
  'the sound effects are lettered (bold, hand-drawn, coloured, outlined). Never ask for captions, titles or speech balloons.';

// v3.1.68 -- FAITHFUL, BOLDER, SOFTER (Ian, 2026-10-13: the three "seem pretty similar"; "those are good
// options for choices. Label them as such"). Three wordings of the same answers looked alike, so the three
// are now one style at three intensities. Each stays inside the answers: a style with no outlines does not
// grow outlines in the bold one. The order is fixed; the screen labels them by position.
const VARIANTS = [
  'FAITHFUL: follow the answers exactly as written, at the strength they state.',
  'BOLDER: the same answers with every defining trait pushed further -- harder contrast, more saturated colour, ' +
    'stronger and more decisive line or brushwork, more drama in the light -- without adding anything the answers rule out.',
  'SOFTER: the same answers rendered gentler -- lighter shadows, quieter and more harmonious colour, finer line, ' +
    'more air and calm -- without removing any defining trait or adding anything the answers rule out.'
];
const THREE_WAYS =
  'Write THREE descriptions of the SAME style from the same answers, in this order:\n' + VARIANTS.join('\n') + '\n' +
  'All three must agree with every answer; they differ only in intensity.';

const STYLE_ANALYZE_SYSTEM =
  'You are an art director turning reference images into a REUSABLE, CONTENT-FREE art-style directive. It ' +
  'will be applied to completely different scenes, so it describes ONLY how the images are drawn and painted, ' +
  'never what they show.\n\n' +
  'FIRST, answer every one of these questions about how the images are rendered:\n' + questionList() + '\n\n' +
  'Answer each in one or two short, concrete phrases. Answer EVERY question; if something is absent, say so ' +
  '("none", "no outlines", "clear air"). Answers obey the same content rule as the descriptions: no subjects, ' +
  'no objects, no places, no names.\n\n' +
  'If the reference images clearly do NOT share one style (for example some are watercolour and some are glossy ' +
  'digital paintings), say what differs in "samples_disagree", and answer for the look most of them share.\n\n' +
  DESCRIPTION_RULES + '\n\n' + THREE_WAYS + '\n\n' +
  'Set "fade" to true ONLY if the images characteristically fade to clean pure white (#ffffff) at the edges with ' +
  'no frame; otherwise false.\n\n' +
  // v3.1.91 -- TD-979. The same look answers the watermark/signature question, one entry per image.
  'Also fill "rights" with one object per reference image, in the order given. ' + rightsCheck.RIGHTS_DEFINITIONS + '\n\n' +
  'Reply with ONLY this JSON, no markdown, no preamble:\n' +
  '{"answers": {' + STYLE_QUESTIONS.map(function (q) { return '"' + q[0] + '": "..."'; }).join(', ') + '}, ' +
  '"samples_disagree": "", "fade": false, "descriptions": ["STYLE: ...", "STYLE: ...", "STYLE: ..."], ' +
  '"rights": [{"watermark": false, "watermark_text": "", "signature": false, "signature_text": ""}]}';   // v3.1.91

const STYLE_REWRITE_SYSTEM =
  'You write art-style directives for an image generator from a set of answers about how a style is drawn. ' +
  'The answers were written or edited by the user: follow them exactly, and add nothing they do not say.\n\n' +
  'The questions the answers belong to:\n' + questionList() + '\n\n' +
  DESCRIPTION_RULES + '\n\n' +
  'Set "fade" to true ONLY if the Edges answer says the image fades to clean pure white; otherwise false.\n\n' +
  'Reply with ONLY this JSON, no markdown: {"fade": false, "descriptions": ["STYLE: ...", ...]} with exactly ' +
  'the number of descriptions asked for.';

const STYLE_CONVERT_SYSTEM =
  'You are an art director. A user already has an art-style directive written as one paragraph, and the ' +
  'reference images it was made from (if any are attached). Answer these questions about how the style is drawn:\n' +
  questionList() + '\n\n' +
  'Answer from the images where they are clear and from the paragraph otherwise; where the two disagree, the ' +
  'images win. Answer EVERY question in one or two short, concrete phrases; say "none" outright when something ' +
  'is absent. No subjects, no objects, no places, no names.\n\n' +
  DESCRIPTION_RULES + '\n\n' +
  'Then write TWO new descriptions from your answers, in this order:\n' + VARIANTS[1] + '\n' + VARIANTS[2] + '\n' +
  'The user keeps their own paragraph as the faithful first option, so do not repeat it.\n\n' +
  'Reply with ONLY this JSON, no markdown: {"answers": {' + STYLE_QUESTIONS.map(function (q) { return '"' + q[0] + '": "..."'; }).join(', ') + '}, ' +
  '"samples_disagree": "", "fade": false, "descriptions": ["STYLE: ...", "STYLE: ..."]}';

// ---- shaping what comes back and what is saved ----
function normStyle(t) {
  const s = String(t == null ? '' : t).trim().slice(0, STYLE_TEXT_MAX);
  if (!s) return '';
  return /^STYLE:/i.test(s) ? s : ('STYLE: ' + s);
}
function cleanAnswers(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  STYLE_QUESTIONS.forEach(function (q) { out[q[0]] = (typeof a[q[0]] === 'string' ? a[q[0]] : '').trim().slice(0, STYLE_ANSWER_MAX); });
  return out;
}
function cleanPreviewUrl(u) {
  return (typeof u === 'string' && u.length < 600 && /^https:\/\/[^\s"'<>]+$/.test(u)) ? u : null;
}
function cleanOptions(o) {
  if (!Array.isArray(o)) return null;
  return o.slice(0, 3).map(function (x) {
    x = (x && typeof x === 'object') ? x : {};
    const p = (x.previews && typeof x.previews === 'object') ? x.previews : {};
    const pv = {};
    STYLE_SCENES.forEach(function (s) { const u = cleanPreviewUrl(p[s]); if (u) pv[s] = u; });
    return { text: normStyle(x.text), edited: !!x.edited, previews: pv };
  });
}
function cleanWinner(w, options) {
  const n = (typeof w === 'number') ? w : (typeof w === 'string' && /^\d$/.test(w)) ? parseInt(w, 10) : NaN;
  return (Array.isArray(options) && Number.isInteger(n) && n >= 0 && n < options.length && options[n].text) ? n : null;
}
// THE SAFETY POINT (spec section 4): style_prompt keeps holding the text story panels use, so nothing on the
// generation path changes. With options, it is the winner's text, or the first option until one is chosen.
function chosenText(options, winner) {
  if (!Array.isArray(options) || !options.length) return '';
  if (winner !== null && winner !== undefined && options[winner] && options[winner].text) return options[winner].text;
  for (let i = 0; i < options.length; i++) if (options[i].text) return options[i].text;
  return '';
}
function thumbOf(options, winner) {
  if (!Array.isArray(options) || !options.length) return null;
  const o = options[(winner !== null && winner !== undefined && options[winner]) ? winner : 0] || {};
  const p = o.previews || {};
  for (let i = 0; i < STYLE_SCENES.length; i++) if (p[STYLE_SCENES[i]]) return p[STYLE_SCENES[i]];
  return null;
}
function parseJsonCol(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
function imagesOf(row) {
  // every stored image a style row points at: its card thumbnail and every option's previews
  const out = [];
  if (row.preview_url) out.push(row.preview_url);
  const opts = parseJsonCol(row.style_options);
  if (Array.isArray(opts)) opts.forEach(function (o) { const p = (o && o.previews) || {}; STYLE_SCENES.forEach(function (s) { if (p[s]) out.push(p[s]); }); });
  return out;
}
// Release the images a style no longer points at. A set difference, so an image that moved from one slot to
// another (an option's preview becoming the card thumbnail) is never deleted while still in use.
async function releaseDropped(db, before, after) {
  const keep = {};
  after.forEach(function (u) { keep[u] = 1; });
  const seen = {};
  for (const u of before) {
    if (keep[u] || seen[u]) continue;
    seen[u] = 1;
    try { await releaseImage(db, u); } catch (e) {}
  }
}

// Pull the JSON object out of a model reply. Null when there is none.
function parseModelJson(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
// Shape an analysis, a convert or a rewrite reply. `want` is how many descriptions were asked for. Returns
// null if the reply is unusable, so the caller refuses rather than saving half an answer.
function shapeReply(obj, want, needAnswers) {
  if (!obj || typeof obj !== 'object') return null;
  const d = Array.isArray(obj.descriptions) ? obj.descriptions.map(normStyle).filter(Boolean) : [];
  if (d.length < want) return null;
  const out = { descriptions: d.slice(0, want), fade: (obj.fade === true || obj.fade === 'true' || obj.fade === 'yes') };
  if (needAnswers) {
    const a = cleanAnswers(obj.answers);
    if (!a) return null;
    const filled = STYLE_QUESTIONS.filter(function (q) { return q[0] !== 'missed' && a[q[0]]; }).length;
    if (filled < STYLE_QUESTIONS.length - 1) return null;   // every question but "missed" must be answered
    out.answers = a;
    out.samples_disagree = (typeof obj.samples_disagree === 'string') ? obj.samples_disagree.trim().slice(0, 600) : '';
  }
  return out;
}

// Rewrite and Convert are free (Ian, 2026-10-13) but text calls still cost us, so each user gets
// FREE_DAILY of them per day. Held in memory: a deploy resets the count, which errs toward the user.
const FREE_DAILY = 20;
const _freeUse = new Map();
function freeCallAllowed(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const k = String(userId);
  const e = _freeUse.get(k);
  if (!e || e.day !== day) { _freeUse.set(k, { day: day, n: 1 }); return true; }
  if (e.n >= FREE_DAILY) return false;
  e.n++;
  return true;
}

async function askClaude(system, content, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('Style analysis is not configured. Please contact support.'); e.friendly = true; throw e; }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: TEXT_MODEL, max_tokens: maxTokens || 4000, system: system, messages: [{ role: 'user', content: content }] })
  });
  const data = await response.json();
  if (data.error) { const e = new Error(friendlyAnthropicError(data.error)); e.friendly = true; throw e; }
  return (data.content || []).map(function (b) { return b.text || ''; }).join('').trim();
}

// Fetch saved sample images (R2 urls) into image blocks for a vision call.
async function sampleBlocks(urls) {
  const out = [];
  for (const u of (urls || []).slice(0, 4)) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const mt0 = (r.headers.get('content-type') || '').split(';')[0];
      out.push({ type: 'image', source: { type: 'base64', media_type: ACCEPTED_MIME.indexOf(mt0) >= 0 ? mt0 : 'image/jpeg', data: buf.toString('base64') } });
    } catch (e) { console.error('sample fetch failed:', e.message); }
  }
  return out;
}

// POST /api/art-styles/custom/analyze (multipart: images[]) -- one Claude vision
// call writes a house-format STYLE: paragraph + fade flag from 2-4 samples.
router.post('/custom/analyze', requireAuth, requireTruePlatinum, function(req, res) {
  sampleUpload(req, res, async function(uploadErr) {
    if (uploadErr) {
      try { console.warn('[upload-reject] route=art-styles code=' + ((uploadErr && uploadErr.code) || 'THROWN') + ' type=' + ((uploadErr && uploadErr.rejectedMime) || 'unknown') + ((uploadErr && uploadErr.rejectedName) ? ' file=' + uploadErr.rejectedName : '')); } catch (_e) {}
      return res.status(400).json({ error: friendlyUploadMsg(uploadErr) });
    }
    try {
      const files = req.files || [];
      let existingUrls = [];
      try { existingUrls = JSON.parse((req.body && req.body.sample_urls) || '[]'); } catch (e) { existingUrls = []; }
      if (!Array.isArray(existingUrls)) existingUrls = [];
      existingUrls = existingUrls.filter(function(u){ return typeof u === 'string' && /^https?:/i.test(u); }).slice(0, 4);
      if ((files.length + existingUrls.length) < 2) return res.json({ error: 'Add at least 2 reference images so the style can be read reliably.' });
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return res.json({ error: 'Style analysis is not configured. Please contact support.' });
      if (!(await canAfford(req.session.userId, COST_ANALYZE))) {
        return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Add more to analyze a style.' });
      }
      // v3.1.90 -- TD-979. Samples whose file details name a stock library are refused before anything
      // is stored or spent, and so is a saved sample already marked rejected. Warnings ride along.
      // v3.2.00 -- AND THE QUICK LOOK, FIRST. Ian: the refusal took seventeen seconds inside the full analysis --
      // "can you do it quicker?". Every reference gets the small Haiku look at once, side by side, before
      // anything is stored or the analysis starts; a watermark refuses in a few seconds, nothing charged. The
      // analysis still answers the question too (the second check). Each picture is looked at once.
      // References are named by their SLOT (Reference 1-4), which the page sends: the slot is what the person
      // sees, and "Sample 1" made them guess which of four boxes was meant (testers).
      let _slots = [];
      try { _slots = JSON.parse((req.body && req.body.slots) || '[]'); } catch (e) { _slots = []; }
      if (!Array.isArray(_slots)) _slots = [];
      const _slotNo = function (i) { var n = parseInt(_slots[i], 10); return (n >= 1 && n <= 4) ? n : (i + 1); };
      const _why = function (r) { var x = (r.reasons || []).filter(function (y) { return y && y.kind !== 'signature' && y.kind !== 'copyright'; })[0]; return (x && x.text) || 'This picture has a watermark.'; };
      const _sampleRights = files.map(function (f) { return rightsCheck.metadataCheck(f.buffer); });
      const _lookCtx = { kind: 'style-sample', userId: req.session.userId };
      const _quick = await Promise.all(files.map(function (f) { return rightsCheck.quickLook(f.buffer, _lookCtx); })
        .concat(existingUrls.map(function (u) { return rightsCheck.checkReference(u, _lookCtx); })));
      const _slotRights = [];
      let _refusal = null;
      for (let _k = 0; _k < files.length + existingUrls.length; _k++) {
        const _r = _k < files.length ? rightsCheck.combine(_sampleRights[_k], _quick[_k]) : _quick[_k];
        if (_r.verdict === 'warn' || _r.verdict === 'reject') _slotRights.push({ slot: _slotNo(_k), verdict: _r.verdict, reasons: _r.reasons || [] });
        if (!_refusal && _r.verdict === 'reject') _refusal = 'Reference ' + _slotNo(_k) + ': ' + _why(_r);
      }
      if (_refusal) return res.json({ error: _refusal + ' Replace it with a picture you have the rights to. Nothing was charged.', code: 'RIGHTS_REJECTED', rights_slots: _slotRights });
      const content = [];
      const sampleUrls = [];
      const _imgUrlOrder = [];   // v3.1.91 -- TD-979: the stored address of each image block, in order (null if not stored)
      const _imgSlot = [];       // v3.2.00: and the slot each image block came from
      for (const f of files) {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mimetype, data: f.buffer.toString('base64') } });
        const _slot = _imgUrlOrder.push(null) - 1;   // v3.1.91
        _imgSlot.push(_slotNo(files.indexOf(f)));   // v3.2.00
        try {
          const ext = path.extname(f.originalname) || '.jpg';
          const url = await uploadFile(f.buffer, 'style-sample-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext, f.mimetype);
          if (url) sampleUrls.push(url);
          _imgUrlOrder[_slot] = url || null;   // v3.1.91
          if (url) await rightsCheck.record(url, rightsCheck.combine(_sampleRights[files.indexOf(f)], _quick[files.indexOf(f)]), { kind: 'style-sample', userId: req.session.userId });   // v3.1.90/v3.2.00 -- TD-979
        } catch (e) { console.error('sample upload failed:', e.message); }
      }
      for (const u of existingUrls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          const mt0 = (r.headers.get('content-type') || '').split(';')[0];
          const okTypes = ACCEPTED_MIME;
          const mt = okTypes.indexOf(mt0) >= 0 ? mt0 : 'image/jpeg';
          content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: buf.toString('base64') } });
          sampleUrls.push(u);
          _imgUrlOrder.push(u);   // v3.1.91
          _imgSlot.push(_slotNo(files.length + existingUrls.indexOf(u)));   // v3.2.00
        } catch (e) { console.error('existing sample fetch failed:', e.message); }
      }
      if (content.filter(function(c){ return c.type === 'image'; }).length < 2) {
        return res.json({ error: 'Could not read enough reference images. Try re-uploading them.' });
      }
      content.push({ type: 'text', text: 'Answer the questions about how these reference images are drawn, then write the three descriptions.' });

      // v3.1.66 -- TD-964. One call answers the 18 questions and writes three descriptions. Nothing is spent
      // unless the reply is usable: a malformed reply costs the user nothing and asks them to try again.
      let raw = '';
      try { raw = await askClaude(STYLE_ANALYZE_SYSTEM, content, 4000); }
      catch (e) { return res.json({ error: e.friendly ? e.message : friendlyAnthropicError(e) }); }
      if (!raw) return res.json({ error: 'The analysis came back empty. Try clearer style samples.' });
      const shaped = shapeReply(parseModelJson(raw), 3, true);
      if (!shaped) {
        try { console.warn('[art-styles] analyze reply unusable (len ' + raw.length + ')'); } catch (_w) {}
        return res.json({ error: 'The analysis came back in an unexpected shape. Nothing was charged; please try again.' });
      }

      // v3.1.91 -- TD-979. Each sample's watermark/signature answer joins what its file details said. A
      // watermark stops here, before the token is spent. A missing answer is unchecked and stops nothing.
      const _rv = (parseModelJson(raw) || {}).rights;
      let _styleRefusal = null;
      for (let _i = 0; _i < _imgUrlOrder.length; _i++) {
        const _v = rightsCheck.verdictFromAnswer(Array.isArray(_rv) ? (_rv[_i] || null) : null);
        const _u = _imgUrlOrder[_i];
        if (_u) {
          const _prev = (await rightsCheck.lookup([_u]))[rightsCheck.normUrl(_u)];
          await rightsCheck.record(_u, rightsCheck.combine(_prev, _v), { kind: 'style-sample', userId: req.session.userId });
        }
        if (_v.verdict === 'reject' && !_slotRights.some(function (x) { return x.slot === _imgSlot[_i]; })) _slotRights.push({ slot: _imgSlot[_i], verdict: 'reject', reasons: _v.reasons });   // v3.2.00
        if (!_styleRefusal && _v.verdict === 'reject') _styleRefusal = 'Reference ' + (_imgSlot[_i] || (_i + 1)) + ': ' + _v.reasons[0].text;   // v3.2.00: the slot's name
      }
      if (_styleRefusal) return res.json({ error: _styleRefusal + ' Replace it with a picture you have the rights to. Nothing was charged.', code: 'RIGHTS_REJECTED', rights_slots: _slotRights });

      try { await spendTokens(req.session.userId, COST_ANALYZE, { source: 'custom_style_analyze', event_type: 'generation_spend' }); } catch (e) { console.error('analyze spend failed:', e.message); }
      try { await recordGeneration(req.session.userId, { event_type: 'custom_style_analyze', tokens_redeemed: COST_ANALYZE, quantity: 1, unit: 'analysis', model: TEXT_MODEL }); } catch (e) {}

      res.json({
        style_prompt: shaped.descriptions[0],          // the old one-paragraph screen reads these two
        is_fade: shaped.fade ? 1 : 0,
        sample_urls: sampleUrls,
        answers: shaped.answers,
        descriptions: shaped.descriptions,
        samples_disagree: shaped.samples_disagree,
        rights: rightsCheck.responseRights(await rightsCheck.lookup(sampleUrls)),   // v3.1.90 -- TD-979
        rights_slots: _slotRights,   // v3.2.00: a signed reference is noted on its box
        questions: STYLE_QUESTIONS.map(function (q) { return { key: q[0], label: q[1], help: q[2] }; })
      });
    } catch (e) {
      console.error('analyze custom style error:', e.message);
      res.json({ error: friendlyAnthropicError(e) });
    }
  });
});

// GET /api/art-styles/questions -- the 18 questions, so the screen labels them from one place.
router.get('/questions', requireAuth, function (req, res) {
  res.json(STYLE_QUESTIONS.map(function (q) { return { key: q[0], label: q[1], help: q[2] }; }));
});

// POST /api/art-styles/custom/rewrite -- v3.1.66, TD-964. Answers in, fresh descriptions out (1 to 3).
// Free (Ian, 2026-10-13), FREE_DAILY a day. Text only; nothing is saved here -- the screen saves.
router.post('/custom/rewrite', requireAuth, requireTruePlatinum, async function (req, res) {
  try {
    const answers = cleanAnswers(req.body && req.body.answers);
    if (!answers) return res.json({ error: 'There are no answers to write from.' });
    const filled = STYLE_QUESTIONS.filter(function (q) { return answers[q[0]]; }).length;
    if (filled < 3) return res.json({ error: 'Fill in at least 3 of the answers first.' });   // v3.2.51 -- says how many (TD-1000)
    const count = (req.body && (req.body.count === 1 || req.body.count === '1')) ? 1 : 3;
    const variant = (req.body && /^[012]$/.test(String(req.body.variant))) ? parseInt(req.body.variant, 10) : 0;   // v3.1.68
    if (!freeCallAllowed(req.session.userId)) return res.json({ error: 'That is ' + FREE_DAILY + ' free rewrites today. Try again tomorrow.' });
    const lines = STYLE_QUESTIONS.map(function (q) { return q[1] + ': ' + (answers[q[0]] || '(not answered)'); }).join('\n');
    const ask = 'The answers:\n' + lines + '\n\n' + (count === 1
      ? ('Write ONE description: ' + VARIANTS[variant])
      : THREE_WAYS);
    let raw = '';
    try { raw = await askClaude(STYLE_REWRITE_SYSTEM, [{ type: 'text', text: ask }], 3000); }
    catch (e) { return res.json({ error: e.friendly ? e.message : friendlyAnthropicError(e) }); }
    const shaped = shapeReply(parseModelJson(raw), count, false);
    if (!shaped) return res.json({ error: 'The rewrite came back in an unexpected shape. Please try again.' });
    res.json({ descriptions: shaped.descriptions, is_fade: shaped.fade ? 1 : 0 });
  } catch (e) {
    console.error('rewrite custom style error:', e.message);
    res.json({ error: 'Could not rewrite the descriptions.' });
  }
});

// POST /api/art-styles/custom/:id/convert -- v3.1.66, TD-964. A style made before the questions has only a
// paragraph: answer the questions from that paragraph and the saved samples, and write two more options.
// Nothing is saved here and nothing changes in any book; the screen saves when the user does.
router.post('/custom/:id/convert', requireAuth, requireTruePlatinum, async function (req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare('SELECT * FROM custom_art_styles WHERE id = ? AND owner_id = ?').get(req.params.id, req.session.userId);
    if (!row) return res.status(404).json({ error: 'Style not found' });
    if (!freeCallAllowed(req.session.userId)) return res.json({ error: 'That is ' + FREE_DAILY + ' free rewrites today. Try again tomorrow.' });
    const content = await sampleBlocks(parseSamples(row.sample_urls));
    content.push({ type: 'text', text: 'The user\'s current paragraph:\n' + String(row.style_prompt || '') + '\n\nAnswer the questions and write the two new descriptions.' });
    let raw = '';
    try { raw = await askClaude(STYLE_CONVERT_SYSTEM, content, 4000); }
    catch (e) { return res.json({ error: e.friendly ? e.message : friendlyAnthropicError(e) }); }
    const shaped = shapeReply(parseModelJson(raw), 2, true);
    if (!shaped) return res.json({ error: 'The conversion came back in an unexpected shape. Please try again.' });
    res.json({ answers: shaped.answers, descriptions: [normStyle(row.style_prompt)].concat(shaped.descriptions), samples_disagree: shaped.samples_disagree, is_fade: row.is_fade ? 1 : 0 });
  } catch (e) {
    console.error('convert custom style error:', e.message);
    res.json({ error: 'Could not convert this style.' });
  }
});

// Exported for the guard; the router is what server.js mounts.
router._td964 = { VARIANTS, STYLE_QUESTIONS, cleanAnswers, cleanOptions, cleanWinner, chosenText, thumbOf, imagesOf, shapeReply, parseModelJson, normStyle, freeCallAllowed, releaseDropped, STYLE_ANALYZE_SYSTEM, STYLE_REWRITE_SYSTEM, STYLE_CONVERT_SYSTEM };

module.exports = router;
