// v3.3.01 -- TD-1037 stage one. THE ARTIST MARKETPLACE, on the page.
// Spec: claude/ARTIST_MARKETPLACE_SPEC.md. One file for both pages that show it:
//   /library  -- the Marketplace tab: directory, a listing's window, Make contact, List yourself.
//   /app.html -- the listing editor (My Account), the in-app links, and the Dashboard review window.
//
// THE SWITCH. Nothing here shows until /api/marketplace/status says so. Every link and button that
// leads to the Marketplace carries class "mkt-link", and marketplace.css hides that class unless
// <html> has class "mkt-on" -- so a link app.js draws later (the art brief) is hidden too, with no
// code at the place it is drawn. An admin sees it all while it is off, with an amber preview line.
(function () {
  'use strict';
  // v3.3.15 -- 'editor' is shown as Campaignia Specialists (Ian); the stored key is unchanged
  var ROLE_NAMES = { artist: 'Artists & Illustrators', writer: 'Writers & Narrative Editors', editor: 'Campaignia Specialists' };
  var ROLE_HINT = { artist: 'you draw or paint the pictures', writer: 'you write or polish the words', editor: 'you build whole books in Campaignia for people' };
  var ROLE_ONE = { artist: 'Artist / Illustrator', writer: 'Writer / Narrative Editor', editor: 'Campaignia Specialist' };
  // v3.3.10 -- how the art is made (same list as MEDIA in routes/marketplace.js)
  var MEDIA_NAMES = { traditional: 'Traditional (paint, ink, pencil)', digital: 'Digital (drawn or painted on screen)', '3d': '3D', 'ai-generated': 'AI-generated', 'ai-assisted': 'AI-assisted (AI with my own drawing or painting)' };
  var MEDIA_SHORT = { traditional: 'Traditional', digital: 'Digital', '3d': '3D', 'ai-generated': 'AI-generated', 'ai-assisted': 'AI-assisted' };
  function mediaTags(media) {
    if (!media || !media.length) return '';
    return '<div class="mkt-media">' + media.map(function (m) { return '<span class="mkt-medium-tag' + (/^ai-/.test(m) ? ' mkt-medium-ai' : '') + '">' + esc(MEDIA_SHORT[m] || m) + '</span>'; }).join('') + '</div>';
  }
  function mediaBlock(p) {
    if ((!p.media || !p.media.length) && !p.medium) return '';
    return '<div class="mkt-label">Medium</div>' + mediaTags(p.media) + (p.medium ? '<div class="mkt-medium-text">' + esc(p.medium) + '</div>' : '');
  }
  var AVAIL_NAMES = { open: 'Taking work', limited: 'Limited availability', closed: 'Not taking work right now' };
  var KIND_NAMES = { commission: 'I\u2019d like to commission you', campaign: 'I\u2019d like you to join my campaign', question: 'I have a question' };
  var STATUS = null, statusWaiters = [];
  var onLibrary = false;
  var dir = { role: '', list: null, loading: false };

  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function $(id) { return document.getElementById(id); }
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) o.body = body;
    else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j || {} }; }, function () { return { ok: r.ok, status: r.status, j: {} }; });
    }, function () { return { ok: false, status: 0, j: { error: 'Could not reach Campaignia. Check your connection.' } }; });
  }
  function whenStatus(fn) { if (STATUS) fn(STATUS); else statusWaiters.push(fn); }

  // ---------------------------------------------------------------- status and the switch
  function loadStatus() {
    return api('GET', '/api/marketplace/status').then(function (x) {
      STATUS = x.ok ? x.j : { show: false };
      var root = document.documentElement;
      root.classList.toggle('mkt-on', !!STATUS.show);
      root.classList.toggle('mkt-preview', !!(STATUS.show && !STATUS.enabled));
      root.classList.toggle('mkt-live', !!STATUS.enabled);   // v3.3.05 -- the user menu item shows only when it is really on, admins too (Ian)
      paintAccount();
      paintAdmin();
      var w = statusWaiters; statusWaiters = [];
      w.forEach(function (fn) { try { fn(STATUS); } catch (e) {} });
      return STATUS;
    });
  }
  function previewLine() {
    return (STATUS && STATUS.show && !STATUS.enabled) ? '<div class="mkt-preview-line">The Marketplace is switched off. Only admins can see this.</div>' : '';
  }

  // ---------------------------------------------------------------- windows
  function modal(cls, html) {
    var ov = document.createElement('div');
    ov.className = 'mkt-overlay';
    ov.innerHTML = '<div class="mkt-modal ' + (cls || '') + '" role="dialog" aria-modal="true">' +
      '<button type="button" class="mkt-x" aria-label="Close">&times;</button>' + html + '</div>';
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.mkt-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    ov.close = close;
    return ov;
  }
  // v3.3.02 -- A PICTURE VIEWER. Ian: "if you click on an image it opens but it's really small". Clicking used
  // to open the file itself in a new tab, at its own pixel size. Now it opens over the page, scaled up or down
  // to fill the screen. Drawn as a background, not an <img>, so the app's rights marker leaves it alone.
  function zoom(url) {
    if (!url) return;
    var lb = document.createElement('div');
    lb.className = 'mkt-zoom';
    lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-label', 'Picture');
    lb.innerHTML = '<div class="mkt-zoom-pic"></div><button type="button" class="mkt-zoom-x" aria-label="Close">&times;</button>' +
      '<a class="mkt-zoom-file" href="' + esc(url) + '" target="_blank" rel="noopener">Open the file</a>';
    var pic = lb.querySelector('.mkt-zoom-pic');
    pic.style.backgroundImage = 'url("' + String(url).replace(/["\\\n\r]/g, '') + '")';
    // v3.3.05 -- AT MOST TWICE ITS REAL SIZE. Stretched further, a small picture goes soft and blocky (Ian: "when
    // you look at the pictures big they look bad"). Big pictures still shrink to fit the screen.
    try {
      var probe = new Image();
      probe.onload = function () {
        var w = probe.naturalWidth, h = probe.naturalHeight;
        if (!w || !h || !lb.parentNode) return;
        var fw = Math.max(100, (window.innerWidth || 1200) - 48), fh = Math.max(100, (window.innerHeight || 800) - 80);
        var k = Math.min(fw / w, fh / h, 2);
        pic.style.cssText += ';inset:auto;left:50%;top:calc(50% - 16px);transform:translate(-50%,-50%);width:' + Math.round(w * k) + 'px;height:' + Math.round(h * k) + 'px;';
      };
      probe.src = url;
    } catch (e) {}
    function close() { if (lb.parentNode) lb.parentNode.removeChild(lb); window.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }   // closes the picture, not the window under it
    lb.addEventListener('click', function (e) { if (!(e.target.classList && e.target.classList.contains('mkt-zoom-file'))) close(); });
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(lb);
  }
  // "This picture looks signed (\u201cFrazetta\u201d)." -> "Frazetta"; the words read on the picture.
  function signedWords(r) {
    var out = [];
    ((r && r.reasons) || []).forEach(function (t) { var m = /\u201c([^\u201d]+)\u201d/.exec(String(t || '')); if (m) out.push(m[1]); });
    return out;
  }

  // v3.3.07 -- THE SHAKE (claude/UI_CONVENTIONS.md section 1), for the Marketplace's own windows. The Library page does not
  // load app.js, so this is a copy of _prepAttestNag's behaviour rather than a call to it: amber outline, one shake, scroll
  // to the middle, focus, and an amber line by the button naming what to do. unNag clears only that line.
  function nag(row, statusEl, text, focusEl) {
    if (!row) { flash(statusEl, text, true); return; }
    row.classList.remove('mkt-nag'); void row.offsetWidth; row.classList.add('mkt-nag');
    try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    try { if (focusEl) focusEl.focus({ preventScroll: true }); } catch (e) {}
    if (statusEl) { statusEl.textContent = text; statusEl.className = 'mkt-msg mkt-nagmsg'; statusEl.setAttribute('data-nag', '1'); }
  }
  function unNag(row, statusEl) {
    if (row) row.classList.remove('mkt-nag');
    if (statusEl && statusEl.getAttribute('data-nag') === '1') { statusEl.textContent = ''; statusEl.className = 'mkt-msg'; statusEl.removeAttribute('data-nag'); }
  }

  // v3.3.08 -- EVERY LIVE LISTING HAS ITS OWN PAGE (/marketplace/<name>-<id>, built on the server so search engines
  // can read it). The listing window and the editor show its address with a Copy button, so artists can share it.
  function pageLinkHtml(path, name, mine) {
    if (!path) return '';
    var full = location.origin + path;
    return '<div class="mkt-fine mkt-pagelink">' + (mine ? 'Your page: ' : '') + '<a href="' + esc(path) + '" target="_blank" rel="noopener">' + esc(mine ? full.replace(/^https?:\/\//, '') : 'Open ' + name + '\u2019s own page') + '</a>' +
      ' &middot; <button type="button" class="mkt-linkbtn" data-share="' + esc(full) + '" data-title="' + esc(mine ? 'My page on the Campaignia Marketplace' : name + ' on the Campaignia Marketplace') + '">Share</button><span class="mkt-share-msg" role="status" aria-live="polite"></span>' + (mine ? ' <span class="mkt-sub">Share it on your website and social media.</span>' : '') + '</div>';
  }
  // v3.3.13 -- SHARE, the same behaviour as a published story's Share button (routes/story-pages.js): the device's own
  // share sheet where there is one (phones), otherwise the link is copied and "Link copied" shows beside the button.
  function shareLink(btn) {
    var url = btn.getAttribute('data-share'), title = btn.getAttribute('data-title') || document.title;
    var msg = btn.nextElementSibling && /mkt-share-msg/.test(btn.nextElementSibling.className) ? btn.nextElementSibling : null;
    function say(t) { if (msg) { msg.textContent = t; setTimeout(function () { msg.textContent = ''; }, 2500); } }
    function legacy() {
      var a = document.createElement('textarea'); a.value = url; a.setAttribute('readonly', '');
      a.style.position = 'absolute'; a.style.left = '-9999px'; document.body.appendChild(a); a.select();
      try { document.execCommand('copy'); say('Link copied'); } catch (e) { say('Copy this page address to share it'); }
      document.body.removeChild(a);
    }
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(function () { say('Link copied'); }, legacy); return; }
    legacy();
  }
  // Buttons on the server-built pages, and Copy link anywhere: one listener for the whole document.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-share],[data-contact],.mkt-page-pic[data-zoom]') : null;
    if (!t) return;
    if (t.getAttribute('data-share')) { e.preventDefault(); shareLink(t); }
    else if (t.getAttribute('data-contact')) { e.preventDefault(); whenStatus(function () { openListing(Number(t.getAttribute('data-contact'))); }); }
    else if (t.getAttribute('data-zoom')) { e.preventDefault(); zoom(t.getAttribute('data-zoom')); }
  });

  function flash(el, text, bad) {
    if (!el) return;
    el.removeAttribute && el.removeAttribute('data-nag');
    el.textContent = text || '';
    el.className = 'mkt-msg' + (bad ? ' mkt-bad' : (text ? ' mkt-good' : ''));
  }

  // ---------------------------------------------------------------- the directory (Library)
  function rolePills(roles) {
    return (roles || []).map(function (r) { return '<span class="mkt-pill mkt-pill-' + esc(r) + '">' + esc(ROLE_ONE[r] || r) + '</span>'; }).join('');
  }
  function cardHtml(p) {
    var pic = p.samples && p.samples[0]
      ? '<img class="mkt-card-img" src="' + esc(p.samples[0]) + '" alt="" loading="lazy">'
      : '<div class="mkt-card-img mkt-card-ph">' + esc((p.name || '?').charAt(0).toUpperCase()) + '</div>';
    // v3.3.09 -- a card is a link to the listing's own page (Ian: "if they click on the Artist tile... it opens the Artist's page")
    return '<a class="mkt-card" href="' + esc(p.path) + '" data-id="' + esc(p.id) + '">' + pic +
      '<div class="mkt-card-body"><div class="mkt-card-name">' + esc(p.name) + '</div>' +
      '<div class="mkt-card-head">' + esc(p.headline) + '</div>' +
      '<div class="mkt-pills">' + rolePills(p.roles) + '</div>' +
      mediaTags(p.media) + '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_NAMES[p.availability] || '') + '</div></div></a>';
  }
  function dirShell() {
    var host = $('market');
    if (!host) return null;
    if (!host.getAttribute('data-built')) {
      host.setAttribute('data-built', '1');
      host.innerHTML =
        '<div id="mkt-preview-slot"></div>' +
        '<div class="mkt-intro">Find people to help make your book: artists to draw it, writers and editors to polish the words, and Campaignia Specialists to build the whole book in Campaignia for you. ' +
          'Press <b>Make contact</b> and they will reply to your email. Campaignia takes no fee and is not part of any arrangement you make.</div>' +
        '<div class="mkt-bar"><div class="mkt-roles" id="mkt-roles"></div>' +
          '<button type="button" class="mkt-btn mkt-list-me" id="mkt-list-me">List yourself</button></div>' +
        '<div class="mkt-grid" id="mkt-grid"></div><div class="mkt-empty" id="mkt-empty"></div>';
      var roles = [['', 'Everyone'], ['artist', ROLE_NAMES.artist], ['writer', ROLE_NAMES.writer], ['editor', ROLE_NAMES.editor]];
      $('mkt-roles').innerHTML = roles.map(function (r) { return '<button type="button" class="mkt-role" data-role="' + r[0] + '">' + esc(r[1]) + '</button>'; }).join('');
      $('mkt-roles').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.mkt-role') : null;
        if (b) { dir.role = b.getAttribute('data-role') || ''; paintRoles(); loadDir(); }
      });
      $('mkt-grid').addEventListener('click', function (e) {
        var c = e.target.closest ? e.target.closest('.mkt-card') : null;
        if (c && !c.getAttribute('href')) openListing(Number(c.getAttribute('data-id')));   // a card with a page simply follows its link
      });
      $('mkt-list-me').addEventListener('click', function () {
        if (STATUS && STATUS.signedIn) openEditor();
        else location.href = '/login?next=' + encodeURIComponent('/library#marketplace');
      });
    }
    $('mkt-preview-slot').innerHTML = previewLine();
    $('mkt-list-me').textContent = (STATUS && STATUS.mine) ? 'Your listing' : 'List yourself';
    return host;
  }
  function paintRoles() {
    Array.prototype.forEach.call(document.querySelectorAll('.mkt-role'), function (b) { b.classList.toggle('active', (b.getAttribute('data-role') || '') === dir.role); });
  }
  function loadDir() {
    var grid = $('mkt-grid'), empty = $('mkt-empty');
    if (!grid) return;
    dir.loading = true;
    grid.innerHTML = '';
    empty.innerHTML = '<span class="mkt-spin"></span>';
    var role = dir.role;
    api('GET', '/api/marketplace/listings' + (role ? '?role=' + role : '')).then(function (x) {
      if (role !== dir.role) return;   // a newer filter is already loading
      dir.loading = false;
      if (!x.ok) { empty.textContent = x.j.error || 'Could not load the Marketplace right now.'; return; }
      dir.list = x.j.listings || [];
      grid.innerHTML = dir.list.map(cardHtml).join('');
      empty.textContent = dir.list.length ? '' : (role ? 'Nobody is listed for this yet.' : 'Nobody is listed yet. Be the first.');
    });
  }
  function showDirectory(role) {
    if (role !== undefined) dir.role = ROLE_NAMES[role] ? role : '';
    if (!dirShell()) return;
    paintRoles();
    loadDir();
  }

  // ---------------------------------------------------------------- one listing, and Make contact
  function openListing(id) {
    var ov = modal('mkt-modal-wide', '<div class="mkt-body"><span class="mkt-spin"></span></div>');
    api('GET', '/api/marketplace/listings/' + id).then(function (x) {
      var body = ov.querySelector('.mkt-body');
      if (!x.ok) { body.innerHTML = '<p>' + esc(x.j.error || 'That listing is not on the Marketplace.') + '</p>'; return; }
      var p = x.j.listing;
      var main = p.samples && p.samples[0];
      var thumbs = (p.samples || []).length > 1 ? '<div class="mkt-thumbs">' + p.samples.map(function (u, i) {
        return '<button type="button" class="mkt-thumb' + (i ? '' : ' on') + '" data-src="' + esc(u) + '"><img src="' + esc(u) + '" alt=""></button>';
      }).join('') + '</div>' : '';
      var links = (p.links || []).map(function (u) {
        var label = u.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
        return '<a href="' + esc(u) + '" target="_blank" rel="nofollow noopener noreferrer ugc">' + esc(label.length > 48 ? label.slice(0, 47) + '\u2026' : label) + '</a>';
      }).join('');
      var contact = contactHtml(p);
      body.innerHTML =
        '<div class="mkt-detail">' +
          '<div class="mkt-detail-pics">' + (main ? '<button type="button" class="mkt-main-a" data-zoom="' + esc(main) + '" title="Click to see it bigger"><img class="mkt-main" src="' + esc(main) + '" alt="Sample of ' + esc(p.name) + '\u2019s work"></button>' : '') + thumbs + '</div>' +
          '<div class="mkt-detail-text">' +
            '<div class="mkt-title">' + esc(p.name) + '</div>' +
            '<div class="mkt-head">' + esc(p.headline) + '</div>' +
            '<div class="mkt-pills">' + rolePills(p.roles) + '</div>' +
            '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_NAMES[p.availability] || '') + '</div>' + mediaBlock(p) +
            '<div class="mkt-bio">' + esc(p.bio) + '</div>' +
            (p.rates ? '<div class="mkt-label">Rates</div><div>' + esc(p.rates) + '</div>' : '') +
            (links ? '<div class="mkt-label">Links</div><div class="mkt-links">' + links + '</div>' : '') +
            contact + pageLinkHtml(p.path, p.name) +
          '</div></div>';
      body.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-src],[data-act],[data-zoom]') : null;
        if (!t) return;
        if (t.getAttribute('data-zoom')) zoom(t.getAttribute('data-zoom'));
        else if (t.getAttribute('data-src')) {
          var src = t.getAttribute('data-src');
          body.querySelector('.mkt-main').src = src; body.querySelector('.mkt-main-a').setAttribute('data-zoom', src);
          Array.prototype.forEach.call(body.querySelectorAll('.mkt-thumb'), function (b) { b.classList.toggle('on', b === t); });
        } else if (t.getAttribute('data-act') === 'edit') { ov.close(); openEditor(); }
        else if (t.getAttribute('data-act') === 'send') sendContact(p, t);
      });
    });
  }
  // The Make contact section: in the listing window and, since v3.3.09, on the listing's own page.
  function contactHtml(p) {
    if (p.own) return '<div class="mkt-note">This is your listing. <button type="button" class="mkt-linkbtn" data-act="edit">Edit it</button></div>';
    if (!STATUS || !STATUS.signedIn) return '<div class="mkt-contact"><div class="mkt-label">Make contact</div><a class="mkt-btn mkt-btn-gold" href="/login?next=' + encodeURIComponent(/^\/marketplace\//.test(location.pathname) ? location.pathname : '/library#marketplace') + '">Sign in to make contact</a>' +
      '<div class="mkt-fine">Sign in, or create a free account, to send ' + esc(p.name) + ' a message.</div></div>';
    return '<div class="mkt-contact"><div class="mkt-label">Make contact</div>' +
      '<select id="mkt-kind">' + Object.keys(KIND_NAMES).map(function (k) { return '<option value="' + k + '">' + esc(KIND_NAMES[k]) + '</option>'; }).join('') + '</select>' +
      '<textarea id="mkt-message" maxlength="2000" rows="5" placeholder="Say hello, describe your book and what you need, and when you need it."></textarea>' +
      '<div class="mkt-row"><button type="button" class="mkt-btn mkt-btn-gold" data-act="send">Send</button><span id="mkt-send-msg" class="mkt-msg"></span></div>' +
      '<div class="mkt-fine">' + esc(p.name) + ' gets your message by email and replies to your email address. Campaignia is not part of any arrangement you make. ' +
        'By sending you agree to the <a href="/marketplace-terms.html" target="_blank" rel="noopener">Marketplace Terms</a>.</div></div>';   // v3.3.07
  }
  // v3.3.09 -- the listing page's own contact section (#mkt-page-contact, left empty by the server)
  function pageContact() {
    var host = $('mkt-page-contact');
    if (!host) return;
    var id = Number(host.getAttribute('data-listing'));
    whenStatus(function () {
      api('GET', '/api/marketplace/listings/' + id).then(function (x) {
        if (!x.ok || !x.j.listing) { host.innerHTML = ''; return; }
        var p = x.j.listing;
        host.innerHTML = contactHtml(p);
        host.addEventListener('click', function (e) {
          var t = e.target.closest ? e.target.closest('[data-act]') : null;
          if (!t) return;
          if (t.getAttribute('data-act') === 'send') sendContact(p, t);
          else if (t.getAttribute('data-act') === 'edit') openEditor();
        });
      });
    });
  }
  function sendContact(p, btn) {
    var msgEl = $('mkt-send-msg'), ta = $('mkt-message');
    var text = (ta.value || '').trim();
    if (text.length < 20) { flash(msgEl, 'Say a little more about what you have in mind.', true); ta.focus(); return; }
    btn.disabled = true; flash(msgEl, 'Sending\u2026');
    api('POST', '/api/marketplace/listings/' + p.id + '/contact', { kind: $('mkt-kind').value, message: text }).then(function (x) {
      if (x.ok) { flash(msgEl, x.j.message || 'Sent.'); ta.disabled = true; $('mkt-kind').disabled = true; return; }
      btn.disabled = false; flash(msgEl, x.j.error || 'Could not send it right now.', true);
    });
  }

  // ---------------------------------------------------------------- your listing: the editor
  function statusSentence(m) {
    if (!m) return 'You are not on the Marketplace yet.';
    var s = '';
    if (m.status === 'draft') s = 'Draft. Not sent for review yet.';
    else if (m.status === 'pending') s = m.has_live ? 'Your changes are waiting for review. Your listing stays up as it was until then.' : 'Waiting for review. It appears on the Marketplace once it is approved.';
    else if (m.status === 'approved') s = m.changed ? 'Live on the Marketplace. You have saved changes that are not on it yet: press Update my listing to publish them.' : 'Live on the Marketplace.';
    else if (m.status === 'declined') s = (m.has_live ? 'Your changes were sent back' : 'Sent back') + (m.admin_note ? ': \u201c' + m.admin_note + '\u201d' : '.') + ' Edit and send it again.';
    else if (m.status === 'removed') s = 'Removed from the Marketplace' + (m.admin_note ? ': \u201c' + m.admin_note + '\u201d' : '.');
    if (m.paused && m.status !== 'removed') s += ' Paused: hidden from the Marketplace until you unpause it.';
    return s;
  }
  function openEditor() {
    var ov = modal('mkt-modal-wide', '<div class="mkt-body"><span class="mkt-spin"></span></div>');
    api('GET', '/api/marketplace/mine').then(function (x) {
      var body = ov.querySelector('.mkt-body');
      if (!x.ok) { body.innerHTML = '<p>' + esc(x.j.error || 'Could not open your listing right now.') + '</p>'; return; }
      buildEditor(ov, body, x.j);
    });
  }
  function buildEditor(ov, body, data) {
    var m = data.mine, d = m ? m.draft : { display_name: data.suggest_name || '', headline: '', roles: [], bio: '', links: [], rates: '', availability: 'open', samples: [] };
    var samples = (d.samples || []).slice();
    var removed = m && m.status === 'removed';
    var links = (d.links || []).concat(['', '', '']).slice(0, 3);
    body.innerHTML =
      previewLine() +
      '<div class="mkt-title">Your Marketplace listing</div>' +
      '<div class="mkt-state" id="mkt-state">' + esc(statusSentence(m)) + '</div>' +
      '<div id="mkt-page-link">' + (m && m.path ? pageLinkHtml(m.path, 'your listing', true) : '') + '</div>' +
      '<div class="mkt-form"' + (removed ? ' style="opacity:0.5;pointer-events:none;"' : '') + '>' +
        '<label class="mkt-label" for="mkt-f-name">Name shown on your listing</label><input id="mkt-f-name" maxlength="60" value="' + esc(d.display_name) + '">' +
        '<label class="mkt-label" for="mkt-f-head">Headline</label><input id="mkt-f-head" maxlength="120" placeholder="e.g. Ink-and-watercolour fantasy illustrator" value="' + esc(d.headline) + '">' +
        '<div class="mkt-label">What you offer</div><div class="mkt-checks">' + Object.keys(ROLE_NAMES).map(function (r) {
          return '<label><input type="checkbox" value="' + r + '"' + (d.roles.indexOf(r) >= 0 ? ' checked' : '') + '> ' + esc(ROLE_NAMES[r]) + ' <span class="mkt-sub">(' + esc(ROLE_HINT[r]) + ')</span></label>';
        }).join('') + '</div>' +
        // v3.3.10 -- shown only while "Artists & Illustrators" is ticked
        '<div id="mkt-media-box"' + (d.roles.indexOf('artist') >= 0 ? '' : ' hidden') + '>' +
          '<div class="mkt-label">How you make your art <span class="mkt-sub">(tick any that apply; AI work is welcome and is labelled as AI)</span></div>' +
          '<div class="mkt-checks mkt-media-checks">' + Object.keys(MEDIA_NAMES).map(function (k) {
            return '<label><input type="checkbox" value="' + k + '"' + ((d.media || []).indexOf(k) >= 0 ? ' checked' : '') + '> ' + esc(MEDIA_NAMES[k]) + '</label>';
          }).join('') + '</div>' +
          '<label class="mkt-label" for="mkt-f-medium">Medium, in your own words <span class="mkt-sub">(optional)</span></label>' +
          '<input id="mkt-f-medium" maxlength="80" placeholder="e.g. Ink and watercolour, coloured in Procreate" value="' + esc(d.medium || '') + '">' +
        '</div>' +
        '<label class="mkt-label" for="mkt-f-bio">About you and your work <span class="mkt-count" id="mkt-bio-count"></span></label><textarea id="mkt-f-bio" maxlength="2000" rows="6" placeholder="Who you are, what you like to make, what a project with you looks like.">' + esc(d.bio) + '</textarea>' +
        '<div class="mkt-label">Sample pictures <span class="mkt-sub">(up to 10, your own work; the first is your card picture; you can choose several at once)</span></div>' +
        '<div class="mkt-samples" id="mkt-samples"></div>' +
        '<div class="mkt-row"><label class="mkt-btn"><input type="file" id="mkt-file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" multiple hidden>Upload pictures</label><span class="mkt-msg" id="mkt-up-msg"></span></div>' +
        '<div class="mkt-label">Links <span class="mkt-sub">(portfolio, ArtStation, website; up to 3)</span></div>' +
        links.map(function (u, i) { return '<input class="mkt-f-link" maxlength="300" placeholder="https://" value="' + esc(u) + '">'; }).join('') +
        '<label class="mkt-label" for="mkt-f-rates">Rates <span class="mkt-sub">(optional)</span></label><input id="mkt-f-rates" maxlength="200" placeholder="e.g. From $40 a panel; ask me for a quote" value="' + esc(d.rates) + '">' +
        '<label class="mkt-label" for="mkt-f-avail">Availability</label><select id="mkt-f-avail">' + Object.keys(AVAIL_NAMES).map(function (k) {
          return '<option value="' + k + '"' + (d.availability === k ? ' selected' : '') + '>' + esc(AVAIL_NAMES[k]) + '</option>';
        }).join('') + '</select>' +
      '</div>' +
      // v3.3.07 -- the Marketplace Terms tick box. Needed for Send for review / Update my listing, not for Save draft.
      (removed ? '' : '<label class="mkt-terms-row" id="mkt-terms-row"><input type="checkbox" id="mkt-f-terms"' + (m && m.terms_ok ? ' checked' : '') + '> ' +
        '<span>I have read the <a href="/marketplace-terms.html" target="_blank" rel="noopener">Marketplace Terms</a></span></label>') +
      '<div class="mkt-row mkt-actions">' +
        (removed ? '' : '<button type="button" class="mkt-btn" data-act="save">Save draft</button><button type="button" class="mkt-btn mkt-btn-gold" data-act="submit">' + (m && m.has_reviewed ? 'Update my listing' : 'Send for review') + '</button>') +
        '<span class="mkt-msg" id="mkt-save-msg"></span></div>' +
      (m && !removed ? '<div class="mkt-row mkt-quiet">' +
        '<button type="button" class="mkt-linkbtn" data-act="pause">' + (m.paused ? 'Unpause my listing' : 'Pause my listing') + '</button>' +
        '<button type="button" class="mkt-linkbtn mkt-danger" data-act="delete">Delete my listing</button></div>' : '') +
      '<div class="mkt-fine">Your listing is public once approved. Your email address is never shown: Make contact emails you, and you reply directly. Campaignia takes no fee and is not part of any arrangement you make.</div>';

    function paintSamples() {
      $('mkt-samples').innerHTML = samples.length ? samples.map(function (u, i) {
        return '<div class="mkt-sample"><img src="' + esc(u) + '" alt="" data-zoom="' + esc(u) + '" title="Click to see it bigger" style="cursor:zoom-in;">' +
          '<button type="button" class="mkt-sx" data-del="' + i + '" title="Take this one off">&times;</button>' +
          (i ? '<button type="button" class="mkt-sfirst" data-first="' + i + '" title="Make this the card picture">Make first</button>' : '<span class="mkt-sfirst mkt-sfirst-on">Card picture</span>') + '</div>';
      }).join('') : '<div class="mkt-sub">No pictures yet.</div>';
    }
    function countBio() { var n = ($('mkt-f-bio').value || '').length; $('mkt-bio-count').textContent = n + ' / 2000'; }
    paintSamples(); countBio();
    $('mkt-f-bio').addEventListener('input', countBio);
    Array.prototype.forEach.call(body.querySelectorAll('.mkt-checks:not(.mkt-media-checks) input'), function (c) {
      c.addEventListener('change', function () { var art = body.querySelector('.mkt-checks:not(.mkt-media-checks) input[value="artist"]'); $('mkt-media-box').hidden = !(art && art.checked); });
    });
    $('mkt-samples').addEventListener('click', function (e) {
      var t = e.target;
      if (t.getAttribute('data-zoom')) zoom(t.getAttribute('data-zoom'));
      else if (t.getAttribute('data-del') != null) { samples.splice(Number(t.getAttribute('data-del')), 1); paintSamples(); }
      else if (t.getAttribute('data-first') != null) { var i = Number(t.getAttribute('data-first')); samples.unshift(samples.splice(i, 1)[0]); paintSamples(); }
    });
    // v3.3.04 -- SEVERAL AT ONCE (Ian: "let them upload them in bulk"). The files go up one after another, each
    // through the same upload and watermark check as before, in the order chosen; it stops when the listing is full.
    var upBusy = false;
    $('mkt-file').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []); this.value = '';
      if (!files.length || upBusy) return;
      var max = data.max_samples || 10, room = max - samples.length;
      if (room <= 0) { flash($('mkt-up-msg'), max + ' is the most. Take one off first.', true); return; }
      var skipped = files.length > room ? files.length - room : 0;
      files = files.slice(0, room);
      var added = 0, signed = 0, marked = 0, refused = [], i = 0;
      upBusy = true;
      (function next() {
        if (i >= files.length) {
          upBusy = false;
          var msg = added ? (added + ' added' + (signed ? ' (' + signed + ' look' + (signed === 1 ? 's' : '') + ' signed, which is fine if it is your signature)' : '') + '. Save to keep ' + (added === 1 ? 'it' : 'them') + '.') : 'Nothing added.';
          if (marked) msg += ' ' + marked + ' show' + (marked === 1 ? 's' : '') + ' a watermark or stock-library mark: fine if it is your own, and Campaignia will see it when reviewing.';   // v3.3.10: shown, not refused
          if (refused.length) msg += ' Not added: ' + refused.join(' ');
          if (skipped) msg += ' ' + skipped + ' more left out: ' + max + ' is the most.';
          flash($('mkt-up-msg'), msg, !added);
          return;
        }
        var f = files[i++];
        flash($('mkt-up-msg'), 'Uploading and checking ' + (files.length > 1 ? i + ' of ' + files.length : '') + '\u2026');
        var fd = new FormData(); fd.append('image', f);
        api('POST', '/api/marketplace/mine/samples', fd).then(function (x) {
          if (!x.ok) refused.push((f.name || 'A picture') + ': ' + (x.j.error || 'could not be uploaded.'));
          else { samples.push(x.j.url); added++; if (x.j.verdict === 'warn') signed++; if (x.j.verdict === 'reject') marked++; paintSamples(); }
          next();
        });
      })();
    });
    function collect(submit) {
      return {
        display_name: $('mkt-f-name').value, headline: $('mkt-f-head').value,
        roles: Array.prototype.filter.call(body.querySelectorAll('.mkt-checks:not(.mkt-media-checks) input'), function (c) { return c.checked; }).map(function (c) { return c.value; }),
        media: Array.prototype.filter.call(body.querySelectorAll('.mkt-media-checks input'), function (c) { return c.checked; }).map(function (c) { return c.value; }),
        medium: $('mkt-f-medium') ? $('mkt-f-medium').value : '',
        bio: $('mkt-f-bio').value,
        links: Array.prototype.map.call(body.querySelectorAll('.mkt-f-link'), function (i) { return i.value; }).filter(function (v) { return v.trim(); }),
        rates: $('mkt-f-rates').value, availability: $('mkt-f-avail').value, samples: samples.slice(), submit: !!submit,
        accept_terms: !!(submit && $('mkt-f-terms') && $('mkt-f-terms').checked)
      };
    }
    body.querySelector('.mkt-actions') && body.querySelector('.mkt-actions').addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act !== 'save' && act !== 'submit') return;
      var msg = $('mkt-save-msg');
      if (act === 'submit' && $('mkt-f-terms') && !$('mkt-f-terms').checked) { nag($('mkt-terms-row'), msg, 'Tick the box above first: \u201cI have read the Marketplace Terms\u201d.', $('mkt-f-terms')); return; }
      flash(msg, 'Saving\u2026');
      api('PUT', '/api/marketplace/mine', collect(act === 'submit')).then(function (x) {
        if (!x.ok) { if (x.j.terms) nag($('mkt-terms-row'), msg, x.j.error, $('mkt-f-terms')); else flash(msg, x.j.error || 'Could not save it right now.', true); return; }
        m = x.j.mine;
        $('mkt-state').textContent = statusSentence(m);
        if ($('mkt-page-link')) $('mkt-page-link').innerHTML = m.path ? pageLinkHtml(m.path, 'your listing', true) : '';
        flash(msg, act === 'submit' ? (m.status === 'approved' ? 'Updated. Your listing on the Marketplace shows these changes now.' : 'Sent for review. We will email you when it is decided.') : 'Saved. Press ' + (m.has_reviewed ? 'Update my listing' : 'Send for review') + ' when you are ready.');
        loadStatus();
      });
    });
    var tb = $('mkt-f-terms');
    if (tb) tb.addEventListener('change', function () { if (tb.checked) unNag($('mkt-terms-row'), $('mkt-save-msg')); });
    var quiet = body.querySelector('.mkt-quiet');
    if (quiet) quiet.addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'pause') {
        api('POST', '/api/marketplace/mine/pause', { paused: !m.paused }).then(function (x) {
          if (!x.ok) { flash($('mkt-save-msg'), x.j.error || 'Could not change it right now.', true); return; }
          m = x.j.mine; e.target.textContent = m.paused ? 'Unpause my listing' : 'Pause my listing';
          $('mkt-state').textContent = statusSentence(m); loadStatus();
        });
      } else if (act === 'delete') {
        if (e.target.getAttribute('data-sure') !== '1') { e.target.setAttribute('data-sure', '1'); e.target.textContent = 'Press again to delete it for good'; return; }
        api('DELETE', '/api/marketplace/mine').then(function (x) {
          if (!x.ok) { flash($('mkt-save-msg'), x.j.error || 'Could not delete it right now.', true); return; }
          loadStatus(); ov.close();
        });
      }
    });
  }

  // ---------------------------------------------------------------- My Account (app)
  function paintAccount() {
    var line = $('mkt-account-line');
    if (!line || !STATUS) return;
    var m = STATUS.mine;
    var txt = !m ? 'Artists, writers and Campaignia Specialists can list themselves so Story Masters can find them and get in touch.'
      : statusSentence({ status: m.status, paused: m.paused, has_live: m.has_live, changed: false, admin_note: '' });
    line.textContent = txt;
    var b = $('mkt-account-btn'); if (b) b.textContent = m ? 'Edit your listing' : 'Create your listing';
  }

  // ---------------------------------------------------------------- Dashboard: the switch and review (app)
  function paintAdmin() {
    var sec = $('admin-mkt-section');
    if (!sec || !STATUS) return;
    sec.style.display = STATUS.admin ? '' : 'none';
    if (!STATUS.admin) return;
    var sw = $('mkt-admin-switch'); if (sw) sw.checked = !!STATUS.enabled;
    var w = $('mkt-admin-waiting'); if (w) w.textContent = (STATUS.waiting ? (STATUS.waiting + ' waiting for review') : 'Nothing waiting for review') + (STATUS.altered ? (' \u00b7 ' + STATUS.altered + ' altered (already live)') : '');   // v3.3.06
  }
  function setSwitch(on) {
    var msg = $('mkt-admin-msg');
    flash(msg, 'Saving\u2026');
    api('PUT', '/api/marketplace/admin/settings', { enabled: !!on }).then(function (x) {
      if (!x.ok) { flash(msg, x.j.error || 'Could not change it.', true); var sw = $('mkt-admin-switch'); if (sw) sw.checked = !on; return; }
      flash(msg, x.j.enabled ? 'The Marketplace is ON for everyone.' : 'The Marketplace is off. Only admins can see it.');
      loadStatus();
    });
  }
  function openReview() {
    var ov = modal('mkt-modal-wide mkt-review', '<div class="mkt-title">Marketplace listings</div>' +
      '<div class="mkt-row"><select id="mkt-rv-filter"><option value="attention">Needing attention</option><option value="pending">Waiting for review</option><option value="altered">Altered (already live)</option><option value="approved">Live</option><option value="declined">Sent back</option><option value="draft">Drafts</option><option value="removed">Removed</option><option value="">All</option></select>' +
      '<span class="mkt-msg" id="mkt-rv-msg"></span></div><div class="mkt-body" id="mkt-rv-list"><span class="mkt-spin"></span></div>');
    var all = [];
    function paint() {
      var f = $('mkt-rv-filter').value;
      // v3.3.14 -- "Needing attention" (Ian), the default: everything waiting for review plus every live listing altered since approval
      var list = all.filter(function (m) { return !f || (f === 'attention' ? (m.status === 'pending' || !!m.altered) : (f === 'altered' ? m.altered : m.status === f)); });
      $('mkt-rv-list').innerHTML = list.length ? list.map(reviewCard).join('') : '<p class="mkt-sub">' + (f === 'attention' ? 'Nothing needs your attention.' : 'Nothing here.') + '</p>';
    }
    function load() {
      api('GET', '/api/marketplace/admin/listings').then(function (x) {
        if (!x.ok) { $('mkt-rv-list').innerHTML = '<p>' + esc(x.j.error || 'Could not load the listings.') + '</p>'; return; }
        all = x.j.listings || []; paint();
      });
    }
    $('mkt-rv-filter').addEventListener('change', paint);
    $('mkt-rv-list').addEventListener('click', function (e) {
      if (e.target.getAttribute && e.target.getAttribute('data-zoom')) { zoom(e.target.getAttribute('data-zoom')); return; }
      var act = e.target.getAttribute && e.target.getAttribute('data-rv');
      if (!act) return;
      var card = e.target.closest('.mkt-rv'); var id = card.getAttribute('data-id');
      var note = card.querySelector('textarea').value;
      e.target.disabled = true;
      api('POST', '/api/marketplace/admin/listings/' + id + '/review', { action: act, note: note }).then(function (x) {
        e.target.disabled = false;
        if (!x.ok) { flash($('mkt-rv-msg'), x.j.error || 'Could not do that.', true); return; }
        flash($('mkt-rv-msg'), act === 'unapprove' ? 'Back in Waiting for review. Nobody was emailed.' : ('Done: ' + act + (x.j.emailed ? ' (emailed them)' : '')));
        load(); loadStatus();
      });
    });
    load();
  }
  function reviewCard(m) {
    var d = m.draft, live = m.live;
    // v3.3.06 -- edits to an approved listing go live at once; what changed since Ian approved it is shown first
    var FIELDS = ['display_name', 'headline', 'roles', 'bio', 'links', 'rates', 'availability', 'samples', 'media', 'medium'];
    var DEF = { media: [], medium: '' };   // a copy saved before v3.3.10 has neither
    var val = function (o, k) { return JSON.stringify(o[k] === undefined ? DEF[k] : o[k]); };
    var diff = [], altered = [];
    if (live && m.changed) FIELDS.forEach(function (k) { if (val(d, k) !== val(live, k)) diff.push(k.replace('_', ' ')); });
    if (m.altered && m.reviewed) FIELDS.forEach(function (k) { if (val(live, k) !== val(m.reviewed, k)) altered.push(k.replace('_', ' ')); });
    // v3.3.02 -- each picture gets ONE plain label under it, and the card a summary line, so a signature
    // that is not the account's name stands out (Ian: "I don't really understand what's going on here").
    // Pictures are backgrounds, not <img>, so the app's own rights marker does not add its outline and
    // sentence on top (that is what squeezed the row).
    var signedAll = [], nSigned = 0, nWm = 0;
    var pics = (d.samples || []).map(function (u) {
      var r = m.sample_rights[u], words = signedWords(r), label = '', cls = '';
      if (r && r.verdict === 'reject') { nWm++; cls = ' mkt-rv-bad'; label = 'Watermark' + (words.length ? ': \u201c' + words.join('\u201d, \u201c') + '\u201d' : ''); }
      else if (r && r.verdict === 'warn') { nSigned++; cls = ' mkt-rv-warn'; signedAll = signedAll.concat(words); label = words.length ? 'Signed \u201c' + words.join('\u201d, \u201c') + '\u201d' : 'Looks signed'; }
      return '<div class="mkt-rv-cell"><button type="button" class="mkt-rv-pic' + cls + '" data-zoom="' + esc(u) + '" title="Click to see it bigger" style="background-image:url(&quot;' + esc(String(u).replace(/["\\\n\r]/g, '')) + '&quot;)"></button>' +
        '<div class="mkt-rv-label' + cls + '">' + esc(label || 'No signature or watermark seen') + '</div></div>';
    }).join('');
    var total = (d.samples || []).length;
    var summary = '';
    if (nSigned || nWm) {
      summary = '<div class="mkt-rv-summary">' +
        (nSigned ? esc(nSigned + ' of ' + total + ' picture' + (total === 1 ? '' : 's') + ' look' + (nSigned === 1 ? 's' : '') + ' signed') + (signedAll.length ? ': <b>\u201c' + signedAll.map(esc).join('\u201d, \u201c') + '\u201d</b>' : '') + '. ' : '') +
        (nWm ? esc(nWm + ' with a watermark or stock-library mark: check it is their own. ') : '') +
        'Account: <b>' + esc(m.owner.name || '') + (m.owner.pen_name ? ' (' + esc(m.owner.pen_name) + ')' : '') + '</b>. If the names don\u2019t match, it may not be their work.</div>';
    } else if (total) summary = '<div class="mkt-rv-summary mkt-rv-clean">No signatures or watermarks seen on the ' + total + ' picture' + (total === 1 ? '' : 's') + '. The check can\u2019t recognise well-known art, so look at them yourself.</div>';
    return '<div class="mkt-rv" data-id="' + esc(m.id) + '">' +
      '<div class="mkt-rv-top"><b>' + esc(d.display_name || '(no name)') + '</b> <span class="mkt-sub">' + esc(m.status) + (m.paused ? ', paused' : '') + (m.has_live ? ', has a live copy' : '') +
        ' &middot; ' + esc(m.contacts) + ' contact' + (m.contacts === 1 ? '' : 's') + '</span>' +
        '<div class="mkt-sub">Account: ' + esc(m.owner.name) + (m.owner.pen_name ? ' (' + esc(m.owner.pen_name) + ')' : '') + ' &lt;' + esc(m.owner.email) + '&gt;</div></div>' +
      (altered.length ? '<div class="mkt-rv-altered">ALTERED since you approved it, and already live: ' + esc(altered.join(', ')) + '. Accept the changes, or Send back to put the approved version back up.</div>' : '') +
      (diff.length ? '<div class="mkt-diff">Saved but not published by them yet: ' + esc(diff.join(', ')) + '</div>' : '') +
      '<div class="mkt-head">' + esc(d.headline) + '</div><div class="mkt-pills">' + rolePills(d.roles) + '</div>' + mediaBlock(d) +
      '<div class="mkt-bio">' + esc(d.bio) + '</div>' +
      (d.links.length ? '<div class="mkt-links">' + d.links.map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="nofollow noopener noreferrer">' + esc(u) + '</a>'; }).join('') + '</div>' : '') +
      (d.rates ? '<div class="mkt-sub">Rates: ' + esc(d.rates) + '</div>' : '') +
      '<div class="mkt-sub">Availability: ' + esc(AVAIL_NAMES[d.availability] || d.availability) + '</div>' +
      summary + '<div class="mkt-rv-pics">' + pics + '</div>' +
      (m.admin_note ? '<div class="mkt-sub">Last note: \u201c' + esc(m.admin_note) + '\u201d</div>' : '') +
      '<textarea rows="2" maxlength="1000" placeholder="Note (sent to them with Decline and Remove; optional with Approve)"></textarea>' +
      '<div class="mkt-row">' +
        (m.status !== 'removed' ? '<button type="button" class="mkt-btn mkt-btn-gold" data-rv="approve">' + (m.altered ? 'Accept changes' : 'Approve') + '</button><button type="button" class="mkt-btn" data-rv="decline">Send back</button><button type="button" class="mkt-btn mkt-danger" data-rv="remove">Remove</button>'
          : '<button type="button" class="mkt-btn" data-rv="restore">Restore</button>') +
        // v3.3.04 -- back to Waiting for review, live copy dropped, nobody emailed (for testing the approval again)
        (m.status !== 'pending' ? '<button type="button" class="mkt-btn mkt-btn-quiet" data-rv="unapprove" title="Puts it back in Waiting for review and takes it off the Marketplace. Nobody is emailed.">Back to review</button>' : '') +
      '</div></div>';
  }

  // ---------------------------------------------------------------- the Library tab
  // v3.3.12 -- WHERE BACK GOES on a listing's own page (Ian: "if they get there from inside the app it goes back there...
  // if they are just on the marketplace it goes back to that"). Came from a page of this site in this tab: step back to
  // it, wherever it was. Otherwise -- a new tab opened from the app, a search result, a shared link -- the app if this
  // tab was opened from the app (remembered for the tab), else the Marketplace page.
  function rememberFromApp() {
    try { if (/[?&]from=app\b/.test(location.search)) sessionStorage.setItem('mktFromApp', '1'); } catch (e) {}
  }
  function cameFromHere() {
    try { return !!document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1; } catch (e) { return false; }
  }
  function fromApp() { try { return sessionStorage.getItem('mktFromApp') === '1'; } catch (e) { return false; } }
  function wireBack() {
    var b = document.querySelector('a.mkt-back[data-back]');
    if (!b) return;
    var here = cameFromHere(), app = fromApp();
    var ref = ''; try { ref = here ? new URL(document.referrer).pathname : ''; } catch (e) {}
    var label = 'Back to the Marketplace';
    if (here) label = /^\/app(\.html)?$/.test(ref) ? 'Back to Campaignia' : (ref === '/library' ? 'Back to the Library' : (ref === '/marketplace' ? 'Back to the Marketplace' : 'Back'));
    else if (app) label = 'Back to Campaignia';
    b.innerHTML = '&larr; ' + label;
    b.addEventListener('click', function (e) {
      if (here) { e.preventDefault(); history.back(); }
      else if (app) { e.preventDefault(); location.href = '/app.html'; }
      // else: the link itself goes to /marketplace
    });
  }

  function libraryWire() {
    var tab = $('tab-market');
    if (!tab || typeof window.switchTab !== 'function') return;
    onLibrary = true;
    var orig = window.switchTab;
    var hiddenIds = ['lib-facets', 'stories-search', 'gallery', 'stories', 'sentinel', 'status'];
    var saved = null;
    window.switchTab = function (t) {
      if (t === 'market') {
        if (saved) { showDirectory(); return; }
        saved = {};
        hiddenIds.forEach(function (id) { var el = $(id); if (el) { saved[id] = el.style.display; el.style.display = 'none'; } });
        Array.prototype.forEach.call(document.querySelectorAll('.lib-tabs .tab-btn'), function (b) { b.classList.toggle('active', b === tab); });
        $('market').style.display = '';
        showDirectory();
        return;
      }
      if (saved) {
        hiddenIds.forEach(function (id) { var el = $(id); if (el) el.style.display = saved[id]; });
        saved = null;
        $('market').style.display = 'none';
        tab.classList.remove('active');
        var cur = (window.state && window.state.tab) || 'images';
        var curBtn = $('tab-' + cur); if (curBtn) curBtn.classList.add('active');
        if (t === cur) return;   // the original would do nothing; the page underneath is already right
      }
      return orig.apply(this, arguments);
    };
    function fromHash() {
      var h = String(location.hash || '');
      var m = /^#marketplace(?:-(artist|writer|editor))?$/.exec(h);
      if (!m) return;
      whenStatus(function (s) { if (!s.show) return; dir.role = m[1] || ''; window.switchTab('market'); });
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
  }

  window.Mkt = { zoom: zoom, openEditor: openEditor, openReview: openReview, openListing: openListing, setSwitch: setSwitch, refresh: loadStatus, showDirectory: showDirectory };

  function start() {
    rememberFromApp();
    wireBack();
    libraryWire();
    pageContact();
    loadStatus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
