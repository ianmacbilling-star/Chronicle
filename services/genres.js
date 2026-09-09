'use strict';

// ============================================================
// genres.js  -  SINGLE SOURCE OF TRUTH for campaign genre.
// Spec: GENRE_AND_CAMPAIGN_PROMPT_SPEC.md  (TD-217 + TD-189)
// ------------------------------------------------------------
// Genre is CAMPAIGN-level steering with two jobs: it steers the AI (prose in
// narrative.js, panel selection and image prompts in extract.js) and it
// categorises a published book in the Library.
//
// THE RULES, all four settled by Ian on 2026-08-06:
//   1. At most THREE genres, and ORDER IS MEANINGFUL - the first is primary.
//   2. 'other' is EXCLUSIVE. It emits no steering; it defers to the campaign
//      prompt. Selecting it clears the rest and vice versa.
//   3. Genre steers BOTH the prose and the panel extraction.
//   4. Style owns the VOICE; genre owns the SUBJECT and TONE. They compose and
//      neither overrides - and the prompt SAYS SO, because Horror plus
//      Children's Storybook will be attempted by a real user.
//   5. SAFETY IS A PROPERTY OF THE CAMPAIGN, NOT OF A GENRE  (v3.0.827, TD-665).
//      A campaign holds up to THREE genres, so a per-genre flag is not an answer
//      until something reduces the list to ONE verdict. campaignSafety() is that
//      reduction and it is the ONLY one: SENSITIVE IF ANY SELECTED GENRE IS
//      SENSITIVE. The gate exists to protect a real person who may appear in the
//      book, and adding a second genre cannot un-appear them. Nothing anywhere
//      may re-derive this - the same rule this file already applies to genres
//      themselves (TD-194), applied before the fact rather than after.
//      NO GENRE CARRIES 'sensitive' YET. v3.0.827 ships the reduction and its
//      consumers ONLY, so that every gate exists before anything can trip it.
//
// STORED as an ordered JSON array of SLUGS on campaigns.genres, so the display
// label can be reworded without a migration. NULL and [] must both READ as
// Fantasy - resolve through campaignGenres() and never re-derive it, which is
// the TD-194 lesson applied before the fact rather than after.
// ============================================================

var GENRES = [
  { slug: 'fantasy',    label: 'Fantasy',
    prose:  'Wonder and scale. Treat the impossible as real and unremarked.',
    panels: 'Favour spectacle, landscape, and creature reveals.' },
  { slug: 'romance',    label: 'Romance',
    prose:  'Interiority and wanting. Weight glances, proximity, and what is left unsaid.',
    panels: 'Favour two-person framing, faces, and held moments over action.' },
  { slug: 'thriller',   label: 'Thriller / Suspense',
    prose:  'Momentum and threat. Short sentences under pressure. Withhold.',
    panels: 'Favour pursuit, confrontation, and the beat just before danger lands.' },
  { slug: 'scifi',      label: 'Sci Fi',
    prose:  'Consequence and system. Treat technology as ordinary and load-bearing.',
    panels: 'Favour machinery, scale, and unfamiliar environments made concrete.' },
  { slug: 'horror',     label: 'Horror',
    prose:  'Dread over shock. Let the reader see it before the characters do.',
    panels: 'Favour restraint, partial reveals, and a wrong detail in an ordinary frame.' },
  { slug: 'biography',  label: 'Biography',
    prose:  'A real life recounted. Ground every event in one person\u2019s arc.',
    panels: 'Favour the subject; frame everyone else in relation to them. Real period dress, tools and places; never fantasy or costume.' },
  { slug: 'mystery',    label: 'Mystery / Crime',
    prose:  'Withheld information. Plant what pays off. Let the reader work.',
    panels: 'Favour evidence, reaction, and the moment of noticing.' },
  { slug: 'childrens',  label: "Children's",
    prose:  'Warm, simple and concrete. Short sentences, plain words, one clear feeling at a time. Frightening things are faced and resolved, never dwelt on.',
    panels: 'Favour clear, uncluttered frames with one thing happening. Keep faces friendly and readable; no gore, no dread.' },
  { slug: 'ya',         label: 'Young Adult',
    prose:  'Immediate and emotionally direct. First-person energy, clear stakes.',
    panels: 'Favour character over setting; keep faces in frame.' },
  { slug: 'historical', label: 'Historical Fiction',
    prose:  'Period texture, materially specific. No modern idiom.',
    panels: 'Favour period detail in dress, tools, and place.' },
  { slug: 'literary',   label: 'Literary Fiction',
    prose:  'Language carries the weight. Ambiguity is allowed to stand.',
    panels: 'Favour the quiet frame; resist the obvious dramatic beat.' },
  { slug: 'nonfiction', label: 'Nonfiction',
    prose:  'Report what happened. Clarity over ornament. No invented interiority.',
    panels: 'Favour the plain, legible depiction of events. Real period dress, tools and places; never fantasy or costume.' },
  { slug: 'family',     label: 'Family Story',
    prose:  'A real life, told warmly. Ordinary moments carry the weight; no fantasy idiom, no invented interiority.',
    panels: 'Favour real places, clothes and objects as they actually are. Faces readable and moments candid; never costume, never fantasy.',
    // v3.0.834 -- TD-668. THE LITERAL, NOT THE CONSTANT. SAFETY_SENSITIVE is declared
    // BELOW this array, so at the moment this literal is evaluated it is still undefined
    // and every one of these records would silently read as standard. The guard proves
    // these two reduce to sensitive precisely so that mistake cannot be made quietly.
    safety: 'sensitive',
    // v3.0.836 -- TD-681/TD-669. REPOINTED, because the previous pair could not be reached.
    // 'Watercolor painterly' is rank 3 (Gold) and 'storybook' is rank 4 (Platinum), so a
    // Silver user choosing one of these genres could use NEITHER and would land on the
    // floor -- High fantasy and Classic -- which is the exact failure these defaults exist
    // to prevent. A default nobody can reach is not a default.
    defaultArt: 'Everyday life illustration', defaultVoice: 'calm' },
  { slug: 'skillstory', label: 'Skill Story',
    prose:  'Calm, literal and first person, in the present tense, one step at a time. Say plainly what will happen, including the parts that are uncomfortable, and never promise that something will not hurt. Sparse guidance between steps. End on a calm, positive beat.',
    // v3.0.836 -- TD-681. THE SETTING CLAUSE THIS WAS MISSING. Family Story already ended
    // "never costume, never fantasy"; this did not, so when the art style said "epic high
    // fantasy" nothing here argued back and a real dentist surgery came out as a castle.
    panels: 'One clear step per frame, uncluttered and evenly lit, with the same person shown consistently throughout. An ordinary real place with ordinary real objects, exactly as it would actually look; never fantasy, never costume, never invented ornament. Nothing frightening, nothing ambiguous, no dramatic angles.',
    safety: 'sensitive',
    defaultArt: 'Everyday life illustration', defaultVoice: 'calm' },
  { slug: 'other',      label: 'Other (use Prompt)',
    prose:  '', panels: '' }
];

var MAX_GENRES = 3;
var DEFAULT_GENRES = ['fantasy'];
var EXCLUSIVE = 'other';
var CAMPAIGN_PROMPT_MAX = 500;

var BY_SLUG = {};
GENRES.forEach(function (g) { BY_SLUG[g.slug] = g; });

// Parse whatever is on the row into a clean ordered slug list. NULL, '', '[]',
// malformed JSON and unknown slugs all resolve to the default - a campaign can
// never fall through this feature, including one created between the ALTER and
// the backfill.
function campaignGenres(rowOrValue) {
  var raw = (rowOrValue && typeof rowOrValue === 'object' && !Array.isArray(rowOrValue))
    ? rowOrValue.genres : rowOrValue;
  var list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { var p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch (e) { list = []; }
  }
  var out = [], seen = {};
  list.forEach(function (s) {
    var k = String(s || '').trim().toLowerCase();
    if (!BY_SLUG[k] || seen[k]) return;
    seen[k] = 1; out.push(k);
  });
  if (out.indexOf(EXCLUSIVE) >= 0) return [EXCLUSIVE];
  out = out.slice(0, MAX_GENRES);
  return out.length ? out : DEFAULT_GENRES.slice();
}

// Validate a client submission. Same rules, but returns null for "not supplied"
// so a PUT that omits the field leaves the stored value alone.
function sanitizeGenres(value) {
  if (value === undefined || value === null) return null;
  return campaignGenres(value);
}

function genresToJson(list) { return JSON.stringify(campaignGenres(list)); }

function genreLabels(list) {
  return campaignGenres(list).map(function (s) { return BY_SLUG[s].label; });
}

// The steering block. `which` is 'prose' or 'panels'. Returns '' when there is
// nothing to say (i.e. 'other'), so the caller can omit the section entirely
// rather than emit an empty heading.
function genreSteering(list, which) {
  var slugs = campaignGenres(list);
  var lines = slugs.map(function (s) { return BY_SLUG[s][which] || ''; }).filter(Boolean);
  if (!lines.length) return '';
  var labels = slugs.map(function (s) { return BY_SLUG[s].label; });
  var head = 'STORY GENRE \u2014 this is a ' + labels[0] + ' story';
  if (labels.length === 2) head += ', with elements of ' + labels[1];
  else if (labels.length > 2) head += ', with elements of ' + labels.slice(1, -1).join(', ') + ' and ' + labels[labels.length - 1];
  head += '.';
  return head + '\n' + lines.join('\n') + '\n' +
    'Genre governs SUBJECT and TONE \u2014 what the story is about and how it feels. It does NOT govern ' +
    'the narrative voice, which is set separately and wins on any conflict of style.';
}

var SAFETY_STANDARD = 'standard';
var SAFETY_SENSITIVE = 'sensitive';

// Reduce a campaign's genre list to ONE safety verdict. See rule 5 in the header.
// Accepts a campaign row or a raw genres value, exactly like campaignGenres(), and
// resolves through it so NULL, '', '[]' and junk all behave identically here and
// there. A genre marks itself sensitive with `safety: SAFETY_SENSITIVE` on its
// record; anything else -- including a missing field -- is standard.
function campaignSafety(rowOrValue) {
  var slugs = campaignGenres(rowOrValue);
  for (var i = 0; i < slugs.length; i++) {
    var g = BY_SLUG[slugs[i]];
    if (g && g.safety === SAFETY_SENSITIVE) return SAFETY_SENSITIVE;
  }
  return SAFETY_STANDARD;
}

// The predicate every caller should use. Kept separate from campaignSafety so a
// future third level cannot silently turn every === comparison in the codebase
// into a wrong answer.
function isSensitive(rowOrValue) { return campaignSafety(rowOrValue) === SAFETY_SENSITIVE; }

// v3.0.834 -- TD-669. THE GENRE SUPPLIES A DEFAULT, NOT A LOCK (Ian, 2026-09-09).
// Order is meaningful, so the FIRST genre that declares defaults wins; a campaign that
// names Skill Story second is still primarily whatever it named first. Returns null when
// nothing declares them, so a caller can tell "no opinion" from "an opinion that happens
// to match the global default" -- those are different, and the difference is the whole
// reason this returns an object rather than filling in blanks itself.
//
// NOTHING CONSUMES THIS YET, DELIBERATELY. Wiring it means deciding where a member pref
// stops and a campaign default starts, and campaigns.art_style carries a DB default of
// 'High fantasy illustration' -- so an untouched campaign and one deliberately set to
// High fantasy are indistinguishable in the column. Guessing there would silently
// overwrite a real choice. The resolver ships now so there is ONE definition of what a
// genre prefers; the wiring point is chosen with that question answered. See TD-669.
function genreDefaults(rowOrValue) {
  var slugs = campaignGenres(rowOrValue);
  for (var i = 0; i < slugs.length; i++) {
    var gg = BY_SLUG[slugs[i]];
    if (gg && (gg.defaultArt || gg.defaultVoice)) {
      return { art: gg.defaultArt || null, narrative: gg.defaultVoice || null, from: gg.slug };
    }
  }
  return null;
}

// True for a slug on the fixed list. Used by the Library facet so an arbitrary
// query string can never reach the SQL.
function isGenre(slug) { return !!BY_SLUG[String(slug || '').trim().toLowerCase()]; }

function campaignPrompt(value) {
  return String(value || '').trim().slice(0, CAMPAIGN_PROMPT_MAX);
}

module.exports = {
  GENRES: GENRES,
  MAX_GENRES: MAX_GENRES,
  DEFAULT_GENRES: DEFAULT_GENRES,
  EXCLUSIVE: EXCLUSIVE,
  CAMPAIGN_PROMPT_MAX: CAMPAIGN_PROMPT_MAX,
  campaignGenres: campaignGenres,
  sanitizeGenres: sanitizeGenres,
  genresToJson: genresToJson,
  genreLabels: genreLabels,
  genreSteering: genreSteering,
  SAFETY_STANDARD: SAFETY_STANDARD,
  SAFETY_SENSITIVE: SAFETY_SENSITIVE,
  campaignSafety: campaignSafety,
  isSensitive: isSensitive,
  genreDefaults: genreDefaults,
  isGenre: isGenre,
  campaignPrompt: campaignPrompt
};
