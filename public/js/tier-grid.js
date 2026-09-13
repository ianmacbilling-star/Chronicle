/* ============================================================================
   COMPARE THE TIERS -- the landing page's tier comparison grid (v3.0.891, v3.0.892, v3.0.893, v3.0.894).

   Ian, 2026-09-13: "Can you create a web page or Modal that lists in grid style
   all the different features each tier has. 4 columns Copper, Silver, Gold,
   Platinum... We will put a button under the tiers on the landing page that
   says Compare the Tiers and it should open that grid."

   WHAT LIVES WHERE. index.html carries ONE button and two includes; everything
   else -- the overlay, the table, the copy -- is built here, and every colour is
   in tier-grid.css. A second landing page therefore needs the button and the two
   tags, and can restyle the whole thing by shipping its own CSS file.

   AND EVERY NUMBER IS THE LIVE ONE. The grid renders /api/public/tier-grid,
   which reads getTier() -- the code defaults merged with the admin overrides in
   app_settings.tier_config -- so what a visitor reads is what the Dashboard says
   and what the server will actually enforce. Nothing on this page is a second
   copy of the tier table, because a hand-written copy is exactly how a landing
   page ends up promising 5 sessions the server refuses.

   NO TIER NAME DECIDES ANYTHING BELOW. Copper's cells read "Invite only" and
   "N/A" because can_create is false and not because the string is 'copper': the
   route reports the fact, this file renders the consequence. If another tier
   ever became invite-only it would read correctly without an edit here.
   ============================================================================ */
(function () {
  'use strict';

  var ENDPOINT = '/api/public/tier-grid';
  var data = null;          // cached payload -- fetched once per page load
  var overlay = null;
  var lastFocus = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // null / undefined means "no cap" everywhere in the tier config (see
  // NULLABLE_TIER_FIELDS in middleware/tiers.js), so it is Unlimited and not zero.
  function cap(v) {
    return (v === null || v === undefined) ? 'Unlimited' : String(v);
  }
  function val(main, sub) {
    return '<span class="tg-val">' + main + '</span>' +
           (sub ? '<span class="tg-sub">' + sub + '</span>' : '');
  }
  function mark(ok) {
    return ok ? '<span class="tg-yes" aria-label="yes">\u2713</span>'
              : '<span class="tg-no" aria-label="no">\u2717</span>';
  }
  function na() { return '<span class="tg-na">N/A</span>'; }
  function dash(sub) { return val('\u2014', sub); }

  // ---- the rows, top to bottom --------------------------------------------
  var ROWS = [
    { label: 'Monthly Price', cell: function (t) {
        return t.price ? val('$' + esc(t.price)) : val('$0', 'no subscription');
      } },
    { label: 'Monthly Tokens', sub: 'expiring + carry-over', cell: function (t) {
        var k = t.tokens || {};
        if (!k.total) return dash('purchased tokens only');
        return val(esc(k.total), esc(k.utlt) + ' expiring + ' + esc(k.cot) + ' carry-over');
      } },
    { label: 'Campaigns', cell: function (t) {
        return t.can_create ? val(esc(cap(t.max_campaigns))) : dash('invite only');
      } },
    { label: 'Sessions per Campaign', cell: function (t) {
        return t.can_create ? val(esc(cap(t.max_sessions))) : dash('your own version of each');
      } },
    { label: 'Image Panels per Session', cell: function (t) {
        return val(esc(cap(t.max_panels)));
      } },
    { label: 'Art Styles', cell: function (t) {
        // v3.0.892 -- Ian: "In the art styles for platinum say 11 + Custom". Driven by the
        // SAME field the Custom Art Styles row renders, so the count and the row cannot
        // disagree, and a tier name still decides nothing here.
        if (!t.can_create) return na();
        return val(esc(t.art_styles) + (t.custom_art_styles ? ' + Custom' : ''));
      } },
    { label: 'Narrative Styles', cell: function (t) {
        return t.can_create ? val(esc(t.narrative_styles)) : na();
      } },
    { label: 'Archived Images per Campaign', cell: function (t) {
        return val(esc(cap(t.max_archives_per_campaign)));
      } },
    { label: 'Characters', cell: function (t) {
        return val(esc(cap(t.max_characters)));
      } },
    { label: 'Assets', cell: function (t) {
        return val(esc(cap(t.max_assets)));
      } },
    // v3.0.893 -- N/A FOR A TIER THAT CREATES NOTHING OF ITS OWN, exactly like the two style
    // rows above. *(Ian, 2026-09-13: "it's not really true that copper can't download a pdf.
    // They can if the DM allows them to publish.")* He is right, and the cross was describing
    // the wrong thing: can_export gates ONE client-side button (a single session's PDF), while
    // publishing -- and with it the book PDF -- is gated on the EFFECTIVE tier, which flows the
    // Story Master's plan down to a Copper in their campaign. A boolean cannot say that, so this
    // says nothing and the Copper footnote carries the inheritance.
    { label: 'Export to PDF', cell: function (t) {
        if (!t.can_create) return na();
        return mark(t.can_export);
      } },
    { label: 'More than One Version', cell: function (t) { return mark(t.multi_version); } },
    { label: 'Custom Art Styles', cell: function (t) { return mark(t.custom_art_styles); } },
    { label: 'Title Builder', cell: function (t) { return mark(t.title_builder); } }
  ];

  var COINS = {
    copper: '/images/Copper_Pieces.png',
    silver: '/images/Sliver_Pieces.png',     // the file is spelled this way in public/images
    gold: '/images/Gold_Pieces.png',
    platinum: '/images/Platinum_Pieces.png'
  };

  function tableHtml(d) {
    var order = (d && d.order) || [];
    var tiers = (d && d.tiers) || {};
    var head = '<tr><th class="tg-feat" scope="col">Feature</th>';
    order.forEach(function (k) {
      var t = tiers[k] || {};
      var coin = COINS[k];
      head += '<th class="tg-t-' + esc(k) + '" scope="col">' +
        (coin ? '<img class="tg-coin" src="' + esc(coin) + '" alt="" />' : '') +
        '<span class="tg-tier-name">' + esc(t.label || k) + '</span></th>';
    });
    head += '</tr>';

    var body = '';
    ROWS.forEach(function (r) {
      body += '<tr><th class="tg-feat" scope="row">' + esc(r.label) +
        (r.sub ? '<span class="tg-feat-sub">' + esc(r.sub) + '</span>' : '') + '</th>';
      order.forEach(function (k) {
        var t = tiers[k];
        body += '<td>' + (t ? r.cell(t) : na()) + '</td>';
      });
      body += '</tr>';
    });

    return '<table class="tg-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function panelHtml() {
    return '<div class="tg-panel" role="dialog" aria-modal="true" aria-label="Compare the tiers">' +
      '<div class="tg-head">' +
        '<div class="tg-title">COMPARE THE TIERS</div>' +
        '<button type="button" class="tg-close" data-tg-close="1" aria-label="Close">CLOSE \u2715</button>' +
      '</div>' +
      '<div class="tg-scroll" id="tg-scroll"><div class="tg-loading">Reading the current plans\u2026</div></div>' +
      '<div class="tg-foot">' +
        '<div class="tg-note tg-note-coin">' +
          '<img src="' + COINS.copper + '" alt="" />' +
          '<span><b>Copper is invite only.</b> No monthly subscription \u2014 token purchases only, to ' +
          'make your own version of the story. Copper inherits its Story Master\u2019s tier features.' +
          '</span></div>' +
        '<div class="tg-note">More than one version needs <b>Gold or higher on your own plan</b>. ' +
          'Unlike the creative options, it is not inherited from your Story Master.</div>' +
      '</div>' +
    '</div>';
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'tg-root tg-overlay';
    overlay.id = 'tg-overlay';
    overlay.hidden = true;
    overlay.innerHTML = panelHtml();
    // Backdrop click closes; a click inside the panel must not.
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay || (ev.target.getAttribute && ev.target.getAttribute('data-tg-close'))) close();
    });
    var sc = overlay.querySelector('.tg-scroll');
    if (sc) sc.addEventListener('scroll', updateScrollCue);
    window.addEventListener('resize', updateScrollCue);
    document.body.appendChild(overlay);
    return overlay;
  }

  function paint(html) {
    var el = document.getElementById('tg-scroll');
    if (el) el.innerHTML = html;
    updateScrollCue();
  }

  // v3.0.892 -- MORE BELOW.
  //
  // Ian asked for a Title Builder row that had been there since v3.0.891 -- because on a
  // laptop window fourteen rows do not fit, the panel scrolls inside itself, and the
  // footnotes sitting under the scroll region read as the end of the table. A scrollbar is
  // not a cue; it is a mechanism. So the panel says so, and stops saying it at the bottom.
  //
  // The arithmetic is its own function because that is the part worth testing: a cue that
  // shows when there is nothing more below is worse than no cue.
  function moreBelow(scrollTop, clientHeight, scrollHeight) {
    return (scrollHeight - (scrollTop + clientHeight)) > 8;   // 8px of slack for sub-pixel heights
  }
  function updateScrollCue() {
    if (!overlay) return;
    var el = overlay.querySelector('.tg-scroll');
    var panel = overlay.querySelector('.tg-panel');
    if (!el || !panel) return;
    if (moreBelow(el.scrollTop, el.clientHeight, el.scrollHeight)) panel.classList.add('tg-more');
    else panel.classList.remove('tg-more');
  }

  function load() {
    if (data) { paint(tableHtml(data)); return; }
    fetch(ENDPOINT, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.order || !d.order.length) throw new Error('empty');
        data = d;
        paint(tableHtml(data));
      })
      .catch(function () {
        // Never leave the spinner spinning: say so, and the tier rows are still
        // on the page behind this.
        paint('<div class="tg-error">The plan details could not be loaded just now. ' +
              'The tiers and prices are listed on the page behind this window.</div>');
      });
  }

  function onKey(ev) {
    if (ev.key === 'Escape' || ev.keyCode === 27) close();
  }

  function open() {
    var ov = ensureOverlay();
    lastFocus = document.activeElement;
    ov.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    var btn = ov.querySelector('.tg-close');
    if (btn) btn.focus();
    load();
    // The table arrives asynchronously on the first open, so paint() calls this again.
    updateScrollCue();
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  function init() {
    var btn = document.getElementById('tg-open-btn');
    if (!btn) return;            // a landing page without the button: do nothing, quietly
    btn.addEventListener('click', function (ev) { ev.preventDefault(); open(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Named handles so a page can open or close the grid from its own markup.
  window.campaigniaTierGrid = { open: open, close: close };
})();
