const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const path = require('path');

// ============================================================
// Date helper - handles both PostgreSQL Date objects and SQLite strings
// ============================================================
function formatDate(dateVal, options) {
  if (!dateVal) return '';
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', options || {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// ============================================================
// LAYOUT BUILDERS
// Each takes (moments, sections, intro, outro) and returns panel HTML
// ============================================================

function buildPanelHTML(m, i, size) {
  // size: 'full' | 'half' | 'third'
  var widthMap = { full: '100%', half: '48%', third: '31%' };
  var heightMap = { full: '5in', half: '3.5in', third: '2.5in' };
  var w = widthMap[size] || '31%';
  var h = heightMap[size] || '2.5in';

  return '<div style="width:' + w + ';display:inline-block;vertical-align:top;margin-bottom:0.15in;margin-right:0.1in;page-break-inside:avoid;">' +
    (m.image
      ? '<img style="width:100%;height:' + h + ';object-fit:cover;display:block;border-radius:3px;border:1px solid rgba(201,168,76,0.2);" src="' + m.image + '" alt="' + m.title + '" />'
      : '<div style="width:100%;height:' + h + ';background:#f0e8d0;border:1px solid rgba(201,168,76,0.3);border-radius:3px;display:flex;align-items:center;justify-content:center;"><span style="font-size:24pt;opacity:0.3;">&#128444;</span></div>') +
    '<div style="padding:4px 6px;background:#f9f4e8;border-left:3px solid #c9a84c;margin-top:2px;">' +
      '<span style="font-family:Cinzel,serif;font-size:8pt;color:#8a6a2a;">Panel ' + (i+1) + '</span>' +
      '<span style="font-family:Cinzel,serif;font-size:9pt;font-weight:600;color:#2c1810;margin-left:8px;">' + m.title + '</span>' +
    '</div>' +
  '</div>';
}

// Comic-book style panel — thick black border, flush, optional overlaid caption.
// Designed to sit inside a flex row; `flex` controls how much width it takes.
function buildComicPanel(m, i, flexGrow, h, showCaption) {
  var caption = '';
  if (showCaption && m.title) {
    caption = '<div style="position:absolute;top:0;left:0;max-width:80%;' +
      'background:#f0e8d0;border:3px solid #0a0806;border-top:none;border-left:none;' +
      'padding:3px 9px 4px;font-family:Cinzel,serif;font-size:8.5pt;font-weight:600;' +
      'color:#0a0806;letter-spacing:0.02em;line-height:1.25;">' + m.title + '</div>';
  }

  var media = m.image
    ? '<img style="width:100%;height:' + h + ';object-fit:cover;display:block;" src="' + m.image + '" alt="' + m.title + '" />'
    : '<div style="width:100%;height:' + h + ';background:#1a0f06;display:flex;align-items:center;justify-content:center;">' +
        '<span style="font-size:30pt;opacity:0.25;color:#c9a84c;">&#128444;</span></div>';

  return '<div style="flex:' + flexGrow + ';box-sizing:border-box;' +
    'position:relative;overflow:hidden;border:5px solid #0a0806;' +
    'page-break-inside:avoid;background:#160e06;">' +
    media + caption +
  '</div>';
}

function buildNarrativeHTML(text, isIntro) {
  if (!text) return '';
  return '<p style="font-family:Crimson Text,Georgia,serif;font-size:12pt;line-height:1.8;color:#2a1a0e;' +
    (isIntro ? 'font-style:italic;font-size:13pt;' : '') +
    'margin:0.15in 0;text-indent:' + (isIntro ? '0' : '0.3in') + ';">' + text + '</p>';
}

// ---- BOOK FAMILY ----

// CLASSIC — clean uniform grid, the orderly "book" layout.
function layoutClassic(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);
  html += '<div style="line-height:0;">';
  moments.forEach(function(m, i) {
    html += buildPanelHTML(m, i, 'third');
  });
  html += '</div>';
  sections.forEach(function(s) {
    if (s.after) html += buildNarrativeHTML(s.after, false);
  });
  html += buildNarrativeHTML(outro, true);
  return html;
}

// STORYBOOK — one large image per beat with narrative flowing around it,
// like an illustrated novel. Fewer, bigger images; lots of prose.
function layoutStorybook(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);
  moments.forEach(function(m, i) {
    var h = '4.2in';
    var media = m.image
      ? '<img style="width:100%;height:' + h + ';object-fit:cover;display:block;border:1px solid rgba(201,168,76,0.25);" src="' + m.image + '" alt="' + m.title + '" />'
      : '<div style="width:100%;height:' + h + ';background:#f0e8d0;border:1px solid rgba(201,168,76,0.3);display:flex;align-items:center;justify-content:center;"><span style="font-size:28pt;opacity:0.3;">&#128444;</span></div>';
    html += '<div style="margin:0.3in 0 0.1in;page-break-inside:avoid;">' + media +
      '<div style="text-align:center;font-family:Cinzel,serif;font-size:9pt;font-style:italic;color:#8a6a2a;margin-top:5px;">' +
      (m.title || '') + '</div></div>';
    var section = sections.find(function(s) { return s.panel_index === i; }) || {};
    if (section.after) html += buildNarrativeHTML(section.after, false);
  });
  html += buildNarrativeHTML(outro, true);
  return html;
}

// ---- COMIC FAMILY ----

// COMIC BOOK — thick black borders, tight gutters, flush-packed panels in
// dynamic mixed-size rows, captions overlaid comic-style.
function layoutComicBook(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);

  // Row recipes: each defines how many panels and their flex ratios + height.
  // Mixing 1-, 2-, and 3-panel rows (some uneven) gives a real comic rhythm.
  var recipes = [
    { sizes: [1],        h: '4.6in' },          // full splash
    { sizes: [2, 1],     h: '3.0in' },          // big + small
    { sizes: [1, 1, 1],  h: '2.5in' },          // even trio
    { sizes: [1, 1],     h: '3.2in' },          // even pair
    { sizes: [1, 2],     h: '3.0in' },          // small + big
    { sizes: [1, 1],     h: '3.2in' }           // even pair
  ];

  function rowOpen() { return '<div style="display:flex;gap:6px;margin-bottom:6px;line-height:0;">'; }

  var idx = 0;            // moment index
  var recipeNum = 0;      // which recipe to use next
  while (idx < moments.length) {
    var recipe = recipes[recipeNum % recipes.length];
    recipeNum++;
    var count = recipe.sizes.length;
    var slice = moments.slice(idx, idx + count);
    // If fewer moments remain than the recipe wants, just lay them out evenly.
    var sizes = (slice.length === count) ? recipe.sizes : slice.map(function() { return 1; });

    html += rowOpen();
    slice.forEach(function(m, j) {
      html += buildComicPanel(m, idx + j, sizes[j], recipe.h, true);
    });
    html += '</div>';

    // Narrative that falls within this row's moments
    for (var k = 0; k < slice.length; k++) {
      var section = sections.find(function(s) { return s.panel_index === (idx + k); }) || {};
      if (section.after) html += buildNarrativeHTML(section.after, false);
    }
    idx += slice.length;
  }

  html += buildNarrativeHTML(outro, true);
  return html;
}

// ACTION — comic treatment, but combat/key beats become full-bleed splash
// panels; quieter moments stay small. No captions on the art — kinetic.
// ACTION — comic treatment, but combat/key beats become full-bleed splash
// panels; quieter moments stay small in flex rows. No captions — kinetic.
function layoutAction(moments, sections, intro, outro) {
  var html = buildNarrativeHTML(intro, true);
  var rowPanels = [];
  function flushRow() {
    if (rowPanels.length) {
      html += '<div style="display:flex;gap:6px;margin-bottom:6px;line-height:0;">' +
        rowPanels.join('') + '</div>';
      rowPanels = [];
    }
  }
  moments.forEach(function(m, i) {
    var isBig = m.type === 'combat' || i === 0 || i === moments.length - 1;
    if (isBig) {
      flushRow();
      html += '<div style="display:flex;margin-bottom:6px;line-height:0;">' +
        buildComicPanel(m, i, 1, '5.0in', false) + '</div>';
    } else {
      rowPanels.push(buildComicPanel(m, i, 1, '2.6in', false));
      if (rowPanels.length === 3) flushRow();   // up to 3 small panels per row
    }
    var section = sections.find(function(s) { return s.panel_index === i; }) || {};
    if (section.after) { flushRow(); html += buildNarrativeHTML(section.after, false); }
  });
  flushRow();
  html += buildNarrativeHTML(outro, true);
  return html;
}

function buildLayout(layoutStyle, moments, sections, intro, outro) {
  if (!moments || !moments.length) return '<p style="color:#6b5f55;font-style:italic;text-align:center;padding:1in;">No panels yet — generate your storyboard first.</p>';
  sections = sections || [];
  intro = intro || '';
  outro = outro || '';
  switch(layoutStyle) {
    case 'ComicBook':
    case 'Cinematic':  // legacy name — old saved sessions
      return layoutComicBook(moments, sections, intro, outro);
    case 'Action':
    case 'Dramatic':   // legacy name — old saved sessions
      return layoutAction(moments, sections, intro, outro);
    case 'Storybook':  return layoutStorybook(moments, sections, intro, outro);
    default:           return layoutClassic(moments, sections, intro, outro);
  }
}

// ============================================================
// Generate PDF HTML for a session
// ============================================================
function buildSessionHTML(session, moments, campaign, characters, narrative) {
  const intro = narrative.intro || '';
  const sections = narrative.sections || [];
  const outro = narrative.outro || '';

  const artStyle = session.art_style || campaign.art_style || 'High fantasy illustration';

  // Character roster for cast page
  const castHTML = characters.map(function(c) {
    var primaryImg = c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    return '<div class="cast-member">' +
      (primaryImg ? '<img class="cast-portrait" src="' + primaryImg + '" alt="' + c.name + '" />' : '<div class="cast-portrait cast-no-img">' + c.name.charAt(0) + '</div>') +
      '<div class="cast-name">' + c.name + '</div>' +
      '<div class="cast-cls">' + (c.cls || '') + '</div>' +
      (c.player_name ? '<div class="cast-player">Played by ' + c.player_name + '</div>' : '') +
    '</div>';
  }).join('');

  // Build panels using selected layout
  var layoutStyle = narrative.layout_style || 'Classic';
  var panelsHTML = buildLayout(layoutStyle, moments, sections, intro, outro);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Crimson Text', Georgia, serif;
    background: #fff;
    color: #1a1410;
    width: 8.5in;
    margin: 0 auto;
  }

  /* ===== COVER PAGE ===== */
  .cover-page {
    width: 8.5in;
    height: 11in;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #1a0f08;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover-bg {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, #3a2010 0%, #0a0604 70%);
  }
  .cover-border {
    position: absolute;
    inset: 0.4in;
    border: 2px solid rgba(201,168,76,0.4);
    pointer-events: none;
  }
  .cover-border-inner {
    position: absolute;
    inset: 0.5in;
    border: 1px solid rgba(201,168,76,0.2);
    pointer-events: none;
  }
  .cover-content {
    position: relative;
    z-index: 1;
    text-align: center;
    padding: 1in;
    width: 100%;
  }
  .cover-logo {
    width: 120px;
    height: 120px;
    object-fit: contain;
    margin-bottom: 0.4in;
  }
  .cover-eyebrow {
    font-family: 'Cinzel', serif;
    font-size: 11pt;
    color: rgba(201,168,76,0.5);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    margin-bottom: 0.15in;
  }
  .cover-campaign {
    font-family: 'Cinzel', serif;
    font-size: 28pt;
    font-weight: 700;
    color: #c9a84c;
    letter-spacing: 0.05em;
    line-height: 1.2;
    margin-bottom: 0.15in;
    text-shadow: 0 2px 20px rgba(201,168,76,0.3);
  }
  .cover-divider {
    width: 60px;
    height: 1px;
    background: rgba(201,168,76,0.5);
    margin: 0.2in auto;
  }
  .cover-session {
    font-family: 'Cinzel', serif;
    font-size: 16pt;
    color: rgba(201,168,76,0.8);
    margin-bottom: 0.1in;
  }
  .cover-date {
    font-family: 'Crimson Text', serif;
    font-size: 12pt;
    color: rgba(201,168,76,0.5);
    font-style: italic;
  }
  .cover-watermark {
    position: absolute;
    bottom: 0.5in;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: rgba(201,168,76,0.25);
    letter-spacing: 0.15em;
    z-index: 1;
  }

  /* ===== CONTENT PAGES ===== */
  .content-page {
    width: 8.5in;
    min-height: 11in;
    padding: 0.75in 0.85in;
    page-break-after: always;
    position: relative;
  }
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 0.15in;
    margin-bottom: 0.25in;
    border-bottom: 1px solid rgba(201,168,76,0.3);
  }
  .page-header-campaign {
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: #8a6a2a;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .page-header-session {
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: #8a6a2a;
    letter-spacing: 0.05em;
  }

  /* ===== NARRATIVE TEXT ===== */
  .narrative-text {
    font-family: 'Crimson Text', serif;
    font-size: 12pt;
    line-height: 1.7;
    color: #2a1a0e;
    margin: 0.2in 0;
    text-indent: 0.3in;
  }
  .intro-text {
    font-size: 13pt;
    font-style: italic;
    text-indent: 0;
    color: #3a2010;
  }
  .outro-text {
    font-size: 12pt;
    font-style: italic;
    text-indent: 0;
    color: #3a2010;
    border-top: 1px solid rgba(201,168,76,0.3);
    padding-top: 0.2in;
    margin-top: 0.3in;
  }

  /* ===== PANEL ===== */
  .panel-block {
    margin: 0.25in 0;
    page-break-inside: avoid;
  }
  .panel-image {
    width: 100%;
    max-height: 4.5in;
    object-fit: cover;
    display: block;
    border-radius: 4px;
    border: 1px solid rgba(201,168,76,0.2);
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  }
  .panel-placeholder {
    width: 100%;
    height: 3in;
    background: #f0e8d0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(201,168,76,0.3);
    border-radius: 4px;
  }
  .panel-placeholder-icon {
    font-size: 48pt;
    opacity: 0.3;
  }
  .panel-caption {
    display: flex;
    align-items: baseline;
    gap: 0.15in;
    margin-top: 0.08in;
    padding: 0.08in 0.12in;
    background: #f9f4e8;
    border-left: 3px solid #c9a84c;
  }
  .panel-num {
    font-family: 'Cinzel', serif;
    font-size: 7pt;
    color: #8a6a2a;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    white-space: nowrap;
  }
  .panel-title {
    font-family: 'Cinzel', serif;
    font-size: 10pt;
    font-weight: 600;
    color: #2c1810;
  }
  .panel-desc {
    font-family: 'Crimson Text', serif;
    font-size: 10pt;
    color: #5c3d2e;
    font-style: italic;
    margin-left: auto;
  }

  /* ===== WATERMARK ===== */
  .page-watermark {
    position: fixed;
    bottom: 0.35in;
    right: 0.5in;
    font-family: 'Cinzel', serif;
    font-size: 7pt;
    color: rgba(201,168,76,0.2);
    letter-spacing: 0.1em;
  }

  /* ===== PAGE NUMBERS ===== */
  .page-num {
    position: fixed;
    bottom: 0.35in;
    left: 50%;
    transform: translateX(-50%);
    font-family: 'Cinzel', serif;
    font-size: 8pt;
    color: rgba(44,24,16,0.4);
  }

  @media print {
    body { width: 8.5in; }
    .cover-page { height: 11in; }
    @page { size: 8.5in 11in; margin: 0; }
  }
</style>
</head>
<body>

<!-- COVER PAGE -->
<div class="cover-page">
  <div class="cover-bg"></div>
  <div class="cover-border"></div>
  <div class="cover-border-inner"></div>
  <div class="cover-content">
    <img class="cover-logo" src="/images/Chronicle_Logo.png" alt="Chronicle" />
    <div class="cover-eyebrow">A Chronicle of</div>
    <div class="cover-campaign">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-session">${session.name}</div>
    <div class="cover-date">${formatDate(session.session_date)}</div>
  </div>
  <div class="cover-watermark">CHRONICLEMYGAME.COM</div>
</div>

<!-- CONTENT PAGE -->
<div class="content-page">
  <div class="page-header">
    <div class="page-header-campaign">${campaign.name}</div>
    <div class="page-header-session">${session.name}</div>
  </div>
  ${panelsHTML}
</div>

<div class="page-watermark">CHRONICLEMYGAME.COM</div>

</body>
</html>`;
}

// ============================================================
// BUILD Graphic Novel HTML (all sessions)
// ============================================================
function buildNovelHTML(campaign, sessions, characters, layoutStyle, pageOpts) {
  layoutStyle = layoutStyle || 'Classic';
  pageOpts = pageOpts || {};
  // When paginated, render only one session. page is 1-indexed.
  var paginated = (typeof pageOpts.page === 'number' && pageOpts.page > 0);
  var totalSessions = sessions.length;
  var pageIndex = paginated ? (pageOpts.page - 1) : -1;
  // Slice down to a single session when paginated
  var renderSessions = paginated
    ? (sessions[pageIndex] ? [sessions[pageIndex]] : [])
    : sessions;
  // Date range
  const dates = sessions.map(function(s) { return new Date(s.session_date + 'T12:00:00'); });
  const minDate = new Date(Math.min.apply(null, dates));
  const maxDate = new Date(Math.max.apply(null, dates));
  const dateRange = minDate.toLocaleDateString('en-US', {month:'long', year:'numeric'}) +
    (minDate.getTime() !== maxDate.getTime() ? ' — ' + maxDate.toLocaleDateString('en-US', {month:'long', year:'numeric'}) : '');

  // Cast page
  const castHTML = characters.map(function(c) {
    var primaryImg = c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    return '<div class="cast-member">' +
      (primaryImg
        ? '<img class="cast-portrait" src="' + primaryImg + '" alt="' + c.name + '" />'
        : '<div class="cast-portrait cast-no-img">' + c.name.charAt(0) + '</div>') +
      '<div class="cast-name">' + c.name + '</div>' +
      '<div class="cast-cls">' + (c.cls || '') + '</div>' +
      (c.player_name ? '<div class="cast-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="cast-desc">' + ((c.description || '').slice(0, 80)) + (c.description && c.description.length > 80 ? '...' : '') + '</div>' +
    '</div>';
  }).join('');

  // Get DM name from campaign
  const dmName = campaign.dm_name || 'The Dungeon Master';

  // Build session content. When paginated, only one session is rendered,
  // but it keeps its real session number, and the chapter seam is suppressed
  // so a sequence spanning sessions reads continuously in the preview.
  var allSessionsHTML = renderSessions.map(function(s, localIdx) {
    var si = paginated ? pageIndex : localIdx;
    var moments = s.moments || [];
    var narrative = {
      intro: s.narrative_intro || '',
      sections: s.narrative_sections ? JSON.parse(s.narrative_sections) : [],
      outro: s.narrative_outro || ''
    };

    var panelsHTML = buildLayout(layoutStyle, moments, narrative.sections, narrative.intro, narrative.outro);

    var chapterHeading = paginated
      ? ''
      : '<div class="session-marker">' +
          '<div class="session-marker-ornament">&bull; &bull; &bull;</div>' +
          '<div class="session-marker-label">Session ' + (si+1) + ' &mdash; ' + s.name +
            ' &middot; ' + formatDate(s.session_date) + '</div>' +
        '</div>';

    return '<div class="content-page">' +
      '<div class="page-header">' +
        '<div class="page-header-campaign">' + campaign.name + '</div>' +
        '<div class="page-header-session">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '</div>' +
      chapterHeading +
      panelsHTML +
    '</div>';
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Crimson Text', Georgia, serif; background: #fff; color: #1a1410; width: 8.5in; margin: 0 auto; }

  .cover-page { width:8.5in;height:11in;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a0f08;page-break-after:always;position:relative;overflow:hidden; }
  .cover-bg { position:absolute;inset:0;background:radial-gradient(ellipse at center, #3a2010 0%, #0a0604 70%); }
  .cover-border { position:absolute;inset:0.4in;border:2px solid rgba(201,168,76,0.4);pointer-events:none; }
  .cover-border-inner { position:absolute;inset:0.5in;border:1px solid rgba(201,168,76,0.2);pointer-events:none; }
  .cover-content { position:relative;z-index:1;text-align:center;padding:1in;width:100%; }
  .cover-logo { width:130px;height:130px;object-fit:contain;margin-bottom:0.4in; }
  .cover-eyebrow { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.5);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:0.1in; }
  .cover-title { font-family:'Cinzel',serif;font-size:34pt;font-weight:700;color:#c9a84c;letter-spacing:0.05em;line-height:1.2;margin-bottom:0.15in;text-shadow:0 2px 20px rgba(201,168,76,0.3); }
  .cover-divider { width:80px;height:1px;background:rgba(201,168,76,0.5);margin:0.25in auto; }
  .cover-subtitle { font-family:'Crimson Text',serif;font-size:13pt;color:rgba(201,168,76,0.6);font-style:italic;margin-bottom:0.08in; }
  .cover-dates { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.4);letter-spacing:0.05em; }
  .cover-watermark { position:absolute;bottom:0.5in;left:50%;transform:translateX(-50%);font-family:'Cinzel',serif;font-size:8pt;color:rgba(201,168,76,0.25);letter-spacing:0.15em;z-index:1; }

  /* CAST PAGE */
  .cast-page { width:8.5in;min-height:11in;padding:0.75in 0.85in;page-break-after:always;background:#fdf8f0; }
  .cast-page-title { font-family:'Cinzel',serif;font-size:22pt;font-weight:700;color:#2c1810;text-align:center;margin-bottom:0.1in; }
  .cast-page-subtitle { font-family:'Crimson Text',serif;font-size:12pt;color:#6b5f55;text-align:center;font-style:italic;margin-bottom:0.05in; }
  .cast-page-dm { font-family:'Cinzel',serif;font-size:10pt;color:#8a6a2a;text-align:center;margin-bottom:0.35in;letter-spacing:0.05em; }
  .cast-divider { width:60px;height:1px;background:rgba(201,168,76,0.4);margin:0.2in auto; }
  .cast-grid { display:grid;grid-template-columns:repeat(3,1fr);gap:0.25in;margin-top:0.1in; }
  .cast-member { text-align:center;padding:0.15in;border:1px solid rgba(201,168,76,0.2);border-radius:6px;background:#fff; }
  .cast-portrait { width:1.2in;height:1.2in;object-fit:cover;border-radius:50%;border:2px solid rgba(201,168,76,0.3);margin-bottom:0.1in; }
  .cast-no-img { width:1.2in;height:1.2in;border-radius:50%;border:2px solid rgba(201,168,76,0.3);background:#c9a84c;color:#2c1810;display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;font-size:24pt;font-weight:700;margin:0 auto 0.1in; }
  .cast-name { font-family:'Cinzel',serif;font-size:11pt;font-weight:600;color:#2c1810;margin-bottom:0.03in; }
  .cast-cls { font-family:'Crimson Text',serif;font-size:10pt;color:#8a6a2a;font-style:italic;margin-bottom:0.03in; }
  .cast-player { font-family:'Cinzel',serif;font-size:8pt;color:#9e9088;letter-spacing:0.05em;margin-bottom:0.05in; }
  .cast-desc { font-family:'Crimson Text',serif;font-size:9pt;color:#6b5f55;line-height:1.4; }

  /* CONTENT */
  .content-page { width:8.5in;min-height:11in;padding:0.75in 0.85in;page-break-after:always;position:relative; }
  .page-header { display:flex;align-items:center;justify-content:space-between;padding-bottom:0.12in;margin-bottom:0.2in;border-bottom:1px solid rgba(201,168,76,0.3); }
  .page-header-campaign { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a;letter-spacing:0.1em;text-transform:uppercase; }
  .page-header-session { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a; }
  .session-chapter-title { font-family:'Cinzel',serif;font-size:18pt;font-weight:700;color:#2c1810;margin-bottom:0.05in; }
  .session-chapter-date { font-family:'Crimson Text',serif;font-size:11pt;color:#8a6a2a;font-style:italic;margin-bottom:0.2in;padding-bottom:0.15in;border-bottom:1px solid rgba(201,168,76,0.2); }
  /* Softened session marker — a quiet signal that a new play session begins,
     without a hard chapter break */
  .session-marker { text-align:center;margin:0.1in 0 0.28in; }
  .session-marker-ornament { font-family:'Cinzel',serif;font-size:10pt;color:rgba(201,168,76,0.55);letter-spacing:0.3em;margin-bottom:0.06in; }
  .session-marker-label { font-family:'Cinzel',serif;font-size:8.5pt;font-weight:600;color:#8a6a2a;letter-spacing:0.12em;text-transform:uppercase; }
  .narrative-text { font-family:'Crimson Text',serif;font-size:12pt;line-height:1.7;color:#2a1a0e;margin:0.18in 0;text-indent:0.3in; }
  .intro-text { font-size:13pt;font-style:italic;text-indent:0;color:#3a2010; }
  .outro-text { font-size:12pt;font-style:italic;text-indent:0;color:#3a2010;border-top:1px solid rgba(201,168,76,0.3);padding-top:0.2in;margin-top:0.25in; }
  .panel-block { margin:0.2in 0;page-break-inside:avoid; }
  .panel-image { width:100%;max-height:4.5in;object-fit:cover;display:block;border-radius:4px;border:1px solid rgba(201,168,76,0.2);box-shadow:0 2px 12px rgba(0,0,0,0.15); }
  .panel-placeholder { width:100%;height:2.5in;background:#f0e8d0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(201,168,76,0.3);border-radius:4px; }
  .panel-placeholder-icon { font-size:36pt;opacity:0.3; }
  .panel-caption { display:flex;align-items:baseline;gap:0.12in;margin-top:0.06in;padding:0.07in 0.1in;background:#f9f4e8;border-left:3px solid #c9a84c; }
  .panel-num { font-family:'Cinzel',serif;font-size:7pt;color:#8a6a2a;text-transform:uppercase;letter-spacing:0.1em;white-space:nowrap; }
  .panel-title { font-family:'Cinzel',serif;font-size:9pt;font-weight:600;color:#2c1810; }
  .page-watermark { position:fixed;bottom:0.35in;right:0.5in;font-family:'Cinzel',serif;font-size:7pt;color:rgba(201,168,76,0.2);letter-spacing:0.1em; }

  @media print {
    body { width:8.5in; }
    @page { size:8.5in 11in; margin:0; }
  }
</style>
</head>
<body>

${paginated ? '' : `<!-- COVER PAGE -->
<div class="cover-page">
  <div class="cover-bg"></div>
  <div class="cover-border"></div>
  <div class="cover-border-inner"></div>
  <div class="cover-content">
    <img class="cover-logo" src="/images/Chronicle_Logo.png" alt="Chronicle" />
    <div class="cover-eyebrow">The Chronicle of</div>
    <div class="cover-title">${campaign.name}</div>
    <div class="cover-divider"></div>
    <div class="cover-subtitle">${campaign.description || 'A tale of adventure and legend'}</div>
    <div class="cover-dates">${dateRange}</div>
  </div>
  <div class="cover-watermark">CHRONICLEMYGAME.COM</div>
</div>

<!-- CAST & CREW PAGE -->
<div class="cast-page">
  <div class="cast-page-title">The Company</div>
  <div class="cast-page-subtitle">${campaign.description || ''}</div>
  <div class="cast-divider"></div>
  <div class="cast-page-dm">Dungeon Master: ${dmName} &nbsp;&nbsp;|&nbsp;&nbsp; ${dateRange}</div>
  <div class="cast-grid">${castHTML}</div>
</div>`}

<!-- SESSIONS -->
${allSessionsHTML}

<div class="page-watermark">CHRONICLEMYGAME.COM</div>

</body>
</html>`;
}

// ============================================================
// ROUTES
// ============================================================

// GET session PDF HTML
router.get('/session/:campaignId/:sessionId', requireAuth, async function(req, res) {
  try {
    const db = await getDb();

    const session = await db.prepare(
      'SELECT s.* FROM sessions s JOIN campaigns c ON s.campaign_id = c.id WHERE s.id = ? AND c.user_id = ?'
    ).get(req.params.sessionId, req.session.userId);

    if (!session) return res.status(403).json({ error: 'Access denied' });

    const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(session.campaign_id);
    const moments = await db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(session.id);
    const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(session.campaign_id);

    const narrative = {
      intro: session.narrative_intro || '',
      sections: session.narrative_sections ? JSON.parse(session.narrative_sections) : [],
      outro: session.narrative_outro || '',
      layout_style: req.query.layout || session.layout_style || 'Classic'
    };

    const html = buildSessionHTML(session, moments, campaign, characters, narrative);
    res.send(html);
  } catch(e) {
    console.error('PDF session error:', e.message);
    res.status(500).send('<html><body style="background:#1a0f08;color:#c9a84c;font-family:serif;padding:2rem;"><h2>Error generating PDF</h2><p>' + e.message + '</p></body></html>');
  }
});

// GET graphic novel HTML (all sessions)
router.get('/novel/:campaignId', requireAuth, async function(req, res) {
  const db = await getDb();

  const campaign = await db.prepare(
    'SELECT c.* FROM campaigns c WHERE c.id = ? AND c.user_id = ?'
  ).get(req.params.campaignId, req.session.userId);

  if (!campaign) return res.status(403).json({ error: 'Access denied' });

  const sessions = await db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY session_date ASC').all(campaign.id);
  const characters = await db.prepare('SELECT * FROM characters WHERE campaign_id = ?').all(campaign.id);

  // Sort sessions ascending (oldest first) using a normalized YYYY-MM-DD key.
  // session_date may arrive as a string or a Date depending on the driver;
  // Date.toString() sorts by weekday name, so normalize before comparing.
  function sessionDateKey(s) {
    if (!s.session_date) return '';
    if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
    try { return s.session_date.toISOString().split('T')[0]; }
    catch (e) { return String(s.session_date); }
  }
  sessions.sort(function(a, b) {
    return sessionDateKey(a).localeCompare(sessionDateKey(b));
  });

  // Load moments and narrative for each session
  const sessionsWithData = await Promise.all(sessions.map(async function(s) {
    const moments = await db.prepare('SELECT * FROM moments WHERE session_id = ? ORDER BY panel_order ASC').all(s.id);
    return Object.assign({}, s, { moments: moments });
  }));

  const layoutStyle = req.query.layout || 'Classic';

  // Optional pagination: ?page=N renders only session N (1-indexed).
  // Total session count is returned in a header so the client can build a pager.
  var pageOpts = {};
  var pageNum = parseInt(req.query.page, 10);
  if (!isNaN(pageNum) && pageNum > 0) {
    pageOpts.page = pageNum;
  }
  res.set('X-Total-Sessions', String(sessionsWithData.length));

  const html = buildNovelHTML(campaign, sessionsWithData, characters, layoutStyle, pageOpts);
  res.send(html);
});

module.exports = router;
