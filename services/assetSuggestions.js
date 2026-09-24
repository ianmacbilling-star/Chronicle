// =============================================================================================
// v3.1.9 -- TD-908. SUGGESTED ASSETS. Spec: claude/ASSET_SUGGESTIONS_SPEC.md.
//
// Ian, 2026-09-24: "if it sees some person, place or thing that is needed for multiple image
// panels, Campaignia could recommend assets for each of those things and generate them if the
// user agrees." And: "I'm trying to avoid another costly AI call."
//
// SO THE AI PART RIDES INSIDE GENERATE STORY. extract.js asks the model for one extra field,
// recurring_elements, in the call it already makes. EVERYTHING IN THIS FILE IS PLAIN CODE: no
// network, no database, no model. It decides which of the model's candidates are real, ranks
// them, and later tells the image prompt builders what to say about the ones nobody turned into
// an asset.
//
// THE MODEL PROPOSES, THE MATCHER DISPOSES. "Used in 4 panels" is never the model's claim. Each
// candidate is counted against the saved panels with the SAME assetNameMatches the image step
// uses, so a suggestion that is offered is one that WILL attach when it becomes an asset. The
// matchers are passed in rather than required, because routes/images.js calls this file and a
// require back into it would be circular -- and a second copy of the alias rule is the section 5c fault
// this project keeps paying for (TD-705: one convention, three implementations, two wrong).
// =============================================================================================

var MIN_PANELS = 2;          // Ian: "I think 2 panels is the right threshold."
var MAX_ITEMS = 8;           // Ian: "You can cap it to 8 items."
var MIN_NAME_LEN = 4;        // shorter names match inside ordinary words (TD-663): "Inn" in "inner"
var MAX_ALIASES = 5;
var MAX_DESC_CHARS = 1200;   // a verbose description in the transcript is used as written, within reason
var CATEGORIES = ['location', 'npc', 'item', 'character'];

function clean(s, max) {
  var v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return max ? v.slice(0, max) : v;
}

// Names are joined into the asset convention ("Canonical / alias / alias"), so a slash inside a
// name would split it into pieces nobody wrote.
function cleanName(s) { return clean(String(s == null ? '' : s).replace(/\//g, ' '), 80); }

function namesOf(item) {
  var out = [], seen = {};
  [item.name].concat(Array.isArray(item.aliases) ? item.aliases : []).forEach(function (n) {
    var v = cleanName(n);
    var k = v.toLowerCase();
    if (!v || v.length < MIN_NAME_LEN || seen[k]) return;
    seen[k] = 1;
    if (out.length < 1 + MAX_ALIASES) out.push(v);
  });
  return out;
}

// The stored asset name: canonical first, aliases after, in the app's own slash convention.
function assetNameFor(item) { return namesOf(item).join(' / '); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// How often the story mentions it. Non-overlapping, longest name first, so "Blackrock Keep" is
// one mention and not also a mention of "Blackrock". Used to RANK, never to qualify: Ian's rule
// is that something mentioned twenty times but drawn once is not worth an asset.
function countMentions(names, text) {
  if (!names.length || !text) return 0;
  var sorted = names.slice().sort(function (a, b) { return b.length - a.length; });
  var re = new RegExp(sorted.map(function (n) { return escapeRe(n.toLowerCase()); }).join('|'), 'g');
  var m = String(text).toLowerCase().match(re);
  return m ? m.length : 0;
}

function panelTextOf(m) {
  return ((m.prompt || '') + ' ' + (m.description || '') + ' ' + (m.title || '')).toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// filterSuggestions -- called by extract.js once the panels are saved.
//
//   raw        parsed.recurring_elements from the model (anything; junk is dropped)
//   panels     [{ panel_order, prompt, description, title }] exactly as inserted
//   transcript the session transcript (for ranking only)
//   assets     campaign_assets rows ({ name })
//   characters characters rows ({ name })
//   m          { assetNameMatches, characterNameMatches } from routes/images.js
//
// Returns the object stored in session_forks.asset_suggestions.
// ---------------------------------------------------------------------------------------------
function filterSuggestions(raw, panels, transcript, assets, characters, m) {
  var list = Array.isArray(raw) ? raw : [];
  var out = [], seenKey = {};
  list.forEach(function (r) {
    if (!r || typeof r !== 'object') return;
    var cat = clean(r.category).toLowerCase();
    if (CATEGORIES.indexOf(cat) === -1) return;
    var names = namesOf({ name: r.name, aliases: r.aliases });
    if (!names.length) return;
    var joined = names.join(' / ');
    var canonLower = names[0].toLowerCase();
    var namesLower = names.join(' ').toLowerCase();

    // ALREADY COVERED. An existing asset or character whose name (or an alias) sits inside this
    // candidate's names already attaches to the same panels, so suggesting it again would make a
    // duplicate. This is what makes a re-run of Generate Story "pick up the assets that were
    // already created" (Ian) -- they are passed to the model as known, and filtered here as well.
    if ((assets || []).some(function (a) { return a && a.name && m.assetNameMatches(a.name, namesLower); })) return;
    if ((characters || []).some(function (c) { return c && c.name && m.characterNameMatches(c.name, canonLower); })) return;

    var hit = [];
    (panels || []).forEach(function (p) {
      if (m.assetNameMatches(joined, panelTextOf(p))) hit.push(Number(p.panel_order) || 0);
    });
    if (hit.length < MIN_PANELS) return;

    var key = canonLower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!key || seenKey[key]) return;
    seenKey[key] = 1;

    out.push({
      key: key,
      name: names[0],
      aliases: names.slice(1),
      category: cat,
      description: clean(r.description, MAX_DESC_CHARS),
      panels: hit,
      mentions: countMentions(names, transcript),
      status: 'open',
      asset_id: null
    });
  });
  // Ian: rank by how often the story references it; the panel count breaks ties.
  out.sort(function (a, b) { return (b.mentions - a.mentions) || (b.panels.length - a.panels.length); });
  return { version: 1, generated_at: new Date().toISOString(), items: out.slice(0, MAX_ITEMS) };
}

function parseStored(text) {
  if (!text) return { version: 1, items: [] };
  try {
    var v = (typeof text === 'string') ? JSON.parse(text) : text;
    if (v && Array.isArray(v.items)) return v;
  } catch (e) {}
  return { version: 1, items: [] };
}

// ---------------------------------------------------------------------------------------------
// notesForPanel -- the "No" half. Ian: "on a No... add the description of the item to the prompt
// for the panel." Any suggestion WITHOUT a live asset (declined, unticked, or never answered) is
// described in words on every panel that names it, so it is drawn the same way each time. Once
// an asset exists for it, the reference image does that job and the words stop.
//
//   stored     parsed session_forks.asset_suggestions
//   assets     campaign_assets rows ({ id, name })
//   characters characters rows ({ name })
//   panelText  prompt + description + title, as buildAssetBlock is given (lower-cased here)
//   opts       { castExplicit } -- a panel whose cast was chosen by hand gets no PEOPLE notes:
//              its roster is authoritative, and a note naming someone outside it would argue
//              with it. Places and items are never people, so they are always described.
// ---------------------------------------------------------------------------------------------
function notesForPanel(stored, assets, characters, panelText, m, opts) {
  var castExplicit = !!(opts && opts.castExplicit);
  var items = (stored && Array.isArray(stored.items)) ? stored.items : [];
  var text = String(panelText || '').toLowerCase();
  var liveIds = {};
  (assets || []).forEach(function (a) { if (a && a.id != null) liveIds[String(a.id)] = 1; });
  var lines = [];
  items.forEach(function (it) {
    if (!it || !it.description) return;
    if (castExplicit && (it.category === 'npc' || it.category === 'character')) return;
    if (it.asset_id != null && liveIds[String(it.asset_id)]) return;
    var names = namesOf(it);
    if (!names.length) return;
    var namesLower = names.join(' ').toLowerCase();
    // Made into an asset or a character some other way since -- the reference image wins.
    if ((assets || []).some(function (a) { return a && a.name && m.assetNameMatches(a.name, namesLower); })) return;
    if ((characters || []).some(function (c) { return c && c.name && m.characterNameMatches(c.name, names[0].toLowerCase()); })) return;
    if (!m.assetNameMatches(names.join(' / '), text)) return;
    lines.push(names[0] + ': ' + it.description);
  });
  return lines;
}

function applyRecurringNotes(prompt, lines) {
  if (!lines || !lines.length) return prompt || '';
  return (prompt || '') + '\n\nRECURRING ELEMENTS (draw each exactly as described here, the same way in every panel it appears): ' + lines.join(' | ');
}

module.exports = {
  MIN_PANELS: MIN_PANELS, MAX_ITEMS: MAX_ITEMS, MIN_NAME_LEN: MIN_NAME_LEN,
  namesOf: namesOf, assetNameFor: assetNameFor, countMentions: countMentions,
  filterSuggestions: filterSuggestions, parseStored: parseStored,
  notesForPanel: notesForPanel, applyRecurringNotes: applyRecurringNotes
};
