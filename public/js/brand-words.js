'use strict';
// v3.4.77 -- TD-1105. BRAND WORDS, the quick way (Ian, 2026-11-06: "Go with A for now").
//
// Story calls a campaign a STORY and a session a CHAPTER. Rather than change the 300-500 places the app
// writes those words, this script swaps them on screen, for brands that have a word list below. Campaignia
// has none, so on Campaignia the script reads one cookie and stops: nothing is walked, nothing observed.
//
// WHAT IT SWAPS: whole words only (Campaignia is never touched), in the page's own text, its tooltips,
// placeholders and button labels, keeping the case: Campaign -> Story, campaigns -> stories, SESSION -> CHAPTER.
// New text is caught as it appears (pop-ups, messages, redrawn screens) by one MutationObserver.
//
// WHAT IT NEVER TOUCHES: what people wrote. Text boxes and form fields, and the places that show a person's
// own words -- story and chapter names, descriptions, character names, panel titles, narrative and captions --
// are listed in KEEP below. A new place that shows people's words gets its class added there, or
// data-no-words on the element. Native browser pop-ups (confirm, alert) are not swapped.
//
// THE LONG-TERM PLAN (option B): each place asks the brand for its word. The lists below carry over as they are.
(function () {
  var WORDS = {
    brand2: [['campaign', 'campaigns', 'story', 'stories'], ['session', 'sessions', 'chapter', 'chapters']]
  };

  var brand = null;
  try { var m = document.cookie.match(/(?:^|;\s*)cmp_brand=([^;]+)/); brand = m ? decodeURIComponent(m[1]) : null; } catch (e) { brand = null; }
  var list = brand && Object.prototype.hasOwnProperty.call(WORDS, brand) ? WORDS[brand] : null;
  if (!list || !list.length) return;

  var MAP = {}; var keys = [];
  list.forEach(function (w) { MAP[w[0]] = w[2]; MAP[w[1]] = w[3]; keys.push(w[1], w[0]); });
  var RX = new RegExp('\\b(' + keys.join('|') + ')\\b', 'gi');
  var TEST = new RegExp('\\b(' + keys.join('|') + ')\\b', 'i');
  function swap(s) {
    return s.replace(RX, function (hit) {
      var to = MAP[hit.toLowerCase()];
      if (hit === hit.toUpperCase()) return to.toUpperCase();
      if (hit.charAt(0) === hit.charAt(0).toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1);
      return to;
    });
  }

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, SELECT: 1, OPTION: 1 };
  var KEEP = [
    '[data-no-words]', '[contenteditable]', '[contenteditable="true"]',
    '.campaign-card-name', '.campaign-card-desc', '.session-card-title',
    '#sidebar-campaign-name', '#sessions-camp-name', '#sessions-camp-desc', '#novel-cover-title', '#novel-cover-sub',
    '.char-name', '.char-desc', '.moment-title', '.review-panel-title', '.review-nar-text', '.archive-title',
    '.member-row-name', '.review-chip', '.style-card-name', '.style-card-desc',
    '.wc-ba-text', '.wc-opt-text', '.gs-text',
    '.novel-caption', '.novel-panel-inner', '.novel-chapter-header',
    '.breadcrumb-link', '.breadcrumb-current'
  ].join(',');
  // The breadcrumb mixes our words ("My Campaigns") with people's names, one per piece: swap a piece only
  // when the whole piece is one of our own labels.
  var CRUMB = /^\s*(my\s+)?(campaigns?|sessions?)\s*$/i;

  function kept(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP_TAGS[e.tagName]) return true;
    }
    return !!(el && el.closest && el.closest(KEEP));
  }
  function doText(t) {
    var v = t.nodeValue; if (!v || !TEST.test(v)) return;
    var p = t.parentElement; if (!p) return;
    if (kept(p)) {
      if (p.matches && p.matches('.breadcrumb-link,.breadcrumb-current') && CRUMB.test(v) && !p.closest('[data-no-words]')) t.nodeValue = swap(v);
      return;
    }
    t.nodeValue = swap(v);
  }
  var ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip'];
  function doAttrs(el) {
    if (kept(el) && !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.parentElement && el.parentElement.closest(KEEP)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = el.getAttribute(ATTRS[i]); if (a && TEST.test(a)) el.setAttribute(ATTRS[i], swap(a));
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value && TEST.test(el.value)) el.value = swap(el.value);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (SKIP_TAGS[root.tagName] && root.tagName !== 'INPUT' && root.tagName !== 'TEXTAREA') return; doAttrs(root); }
    var w = document.createTreeWalker(root, 5, null); var n;   // 5 = elements and text
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) doText(n);
      else if (n.nodeType === 1) {
        if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') doAttrs(n);
        else if (!SKIP_TAGS[n.tagName]) doAttrs(n);
      }
    }
  }

  function start() {
    walk(document.body);
    var title = document.title; if (title && TEST.test(title)) document.title = swap(title);
    new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') { if (r.target.nodeType === 1) doAttrs(r.target); }
        else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  window.cmpBrandWord = swap;   // for code that builds a native confirm()/alert() later (option B)
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
