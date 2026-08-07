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
    panels: 'Favour the subject; frame everyone else in relation to them.' },
  { slug: 'mystery',    label: 'Mystery / Crime',
    prose:  'Withheld information. Plant what pays off. Let the reader work.',
    panels: 'Favour evidence, reaction, and the moment of noticing.' },
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
    panels: 'Favour the plain, legible depiction of events.' },
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
  campaignPrompt: campaignPrompt
};
