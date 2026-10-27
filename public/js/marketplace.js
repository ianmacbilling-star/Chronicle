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
  var ROLE_NAMES = { artist: 'Artists & Illustrators', writer: 'Writers & Narrative Editors', editor: 'Campaignia Editors' };
  var ROLE_ONE = { artist: 'Artist / Illustrator', writer: 'Writer / Narrative Editor', editor: 'Campaignia Editor' };
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
  function flash(el, text, bad) {
    if (!el) return;
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
    return '<button type="button" class="mkt-card" data-id="' + esc(p.id) + '">' + pic +
      '<div class="mkt-card-body"><div class="mkt-card-name">' + esc(p.name) + '</div>' +
      '<div class="mkt-card-head">' + esc(p.headline) + '</div>' +
      '<div class="mkt-pills">' + rolePills(p.roles) + '</div>' +
      '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_NAMES[p.availability] || '') + '</div></div></button>';
  }
  function dirShell() {
    var host = $('market');
    if (!host) return null;
    if (!host.getAttribute('data-built')) {
      host.setAttribute('data-built', '1');
      host.innerHTML =
        '<div id="mkt-preview-slot"></div>' +
        '<div class="mkt-intro">Find people to help make your book: artists to draw it, writers and editors to polish the words, and Campaignia editors to put it together. ' +
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
        if (c) openListing(Number(c.getAttribute('data-id')));
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
      var contact;
      if (p.own) contact = '<div class="mkt-note">This is your listing. <button type="button" class="mkt-linkbtn" data-act="edit">Edit it</button></div>';
      else if (!STATUS || !STATUS.signedIn) contact = '<a class="mkt-btn mkt-btn-gold" href="/login?next=' + encodeURIComponent('/library#marketplace') + '">Sign in to make contact</a>';
      else contact =
        '<div class="mkt-contact"><div class="mkt-label">Make contact</div>' +
        '<select id="mkt-kind">' + Object.keys(KIND_NAMES).map(function (k) { return '<option value="' + k + '">' + esc(KIND_NAMES[k]) + '</option>'; }).join('') + '</select>' +
        '<textarea id="mkt-message" maxlength="2000" rows="5" placeholder="Say hello, describe your book and what you need, and when you need it."></textarea>' +
        '<div class="mkt-row"><button type="button" class="mkt-btn mkt-btn-gold" data-act="send">Send</button><span id="mkt-send-msg" class="mkt-msg"></span></div>' +
        '<div class="mkt-fine">' + esc(p.name) + ' gets your message by email and replies to your email address. Campaignia is not part of any arrangement you make.</div></div>';
      body.innerHTML =
        '<div class="mkt-detail">' +
          '<div class="mkt-detail-pics">' + (main ? '<a class="mkt-main-a" href="' + esc(main) + '" target="_blank" rel="noopener"><img class="mkt-main" src="' + esc(main) + '" alt="Sample of ' + esc(p.name) + '\u2019s work"></a>' : '') + thumbs + '</div>' +
          '<div class="mkt-detail-text">' +
            '<div class="mkt-title">' + esc(p.name) + '</div>' +
            '<div class="mkt-head">' + esc(p.headline) + '</div>' +
            '<div class="mkt-pills">' + rolePills(p.roles) + '</div>' +
            '<div class="mkt-avail mkt-avail-' + esc(p.availability) + '">' + esc(AVAIL_NAMES[p.availability] || '') + '</div>' +
            '<div class="mkt-bio">' + esc(p.bio) + '</div>' +
            (p.rates ? '<div class="mkt-label">Rates</div><div>' + esc(p.rates) + '</div>' : '') +
            (links ? '<div class="mkt-label">Links</div><div class="mkt-links">' + links + '</div>' : '') +
            contact +
          '</div></div>';
      body.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-src],[data-act]') : null;
        if (!t) return;
        if (t.getAttribute('data-src')) {
          var src = t.getAttribute('data-src');
          body.querySelector('.mkt-main').src = src; body.querySelector('.mkt-main-a').href = src;
          Array.prototype.forEach.call(body.querySelectorAll('.mkt-thumb'), function (b) { b.classList.toggle('on', b === t); });
        } else if (t.getAttribute('data-act') === 'edit') { ov.close(); openEditor(); }
        else if (t.getAttribute('data-act') === 'send') sendContact(p, t);
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
    else if (m.status === 'approved') s = m.changed ? 'Live on the Marketplace. You have changes that are not sent yet: press Send for review to update it.' : 'Live on the Marketplace.';
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
      '<div class="mkt-form"' + (removed ? ' style="opacity:0.5;pointer-events:none;"' : '') + '>' +
        '<label class="mkt-label" for="mkt-f-name">Name shown on your listing</label><input id="mkt-f-name" maxlength="60" value="' + esc(d.display_name) + '">' +
        '<label class="mkt-label" for="mkt-f-head">Headline</label><input id="mkt-f-head" maxlength="120" placeholder="e.g. Ink-and-watercolour fantasy illustrator" value="' + esc(d.headline) + '">' +
        '<div class="mkt-label">What you offer</div><div class="mkt-checks">' + Object.keys(ROLE_NAMES).map(function (r) {
          return '<label><input type="checkbox" value="' + r + '"' + (d.roles.indexOf(r) >= 0 ? ' checked' : '') + '> ' + esc(ROLE_NAMES[r]) + '</label>';
        }).join('') + '</div>' +
        '<label class="mkt-label" for="mkt-f-bio">About you and your work <span class="mkt-count" id="mkt-bio-count"></span></label><textarea id="mkt-f-bio" maxlength="2000" rows="6" placeholder="Who you are, what you like to make, what a project with you looks like.">' + esc(d.bio) + '</textarea>' +
        '<div class="mkt-label">Sample pictures <span class="mkt-sub">(up to 6, your own work; the first is your card picture)</span></div>' +
        '<div class="mkt-samples" id="mkt-samples"></div>' +
        '<div class="mkt-row"><label class="mkt-btn"><input type="file" id="mkt-file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden>Upload a picture</label><span class="mkt-msg" id="mkt-up-msg"></span></div>' +
        '<div class="mkt-label">Links <span class="mkt-sub">(portfolio, ArtStation, website; up to 3)</span></div>' +
        links.map(function (u, i) { return '<input class="mkt-f-link" maxlength="300" placeholder="https://" value="' + esc(u) + '">'; }).join('') +
        '<label class="mkt-label" for="mkt-f-rates">Rates <span class="mkt-sub">(optional)</span></label><input id="mkt-f-rates" maxlength="200" placeholder="e.g. From $40 a panel; ask me for a quote" value="' + esc(d.rates) + '">' +
        '<label class="mkt-label" for="mkt-f-avail">Availability</label><select id="mkt-f-avail">' + Object.keys(AVAIL_NAMES).map(function (k) {
          return '<option value="' + k + '"' + (d.availability === k ? ' selected' : '') + '>' + esc(AVAIL_NAMES[k]) + '</option>';
        }).join('') + '</select>' +
      '</div>' +
      '<div class="mkt-row mkt-actions">' +
        (removed ? '' : '<button type="button" class="mkt-btn" data-act="save">Save draft</button><button type="button" class="mkt-btn mkt-btn-gold" data-act="submit">Send for review</button>') +
        '<span class="mkt-msg" id="mkt-save-msg"></span></div>' +
      (m && !removed ? '<div class="mkt-row mkt-quiet">' +
        '<button type="button" class="mkt-linkbtn" data-act="pause">' + (m.paused ? 'Unpause my listing' : 'Pause my listing') + '</button>' +
        '<button type="button" class="mkt-linkbtn mkt-danger" data-act="delete">Delete my listing</button></div>' : '') +
      '<div class="mkt-fine">Your listing is public once approved. Your email address is never shown: Make contact emails you, and you reply directly. Campaignia takes no fee and is not part of any arrangement you make.</div>';

    function paintSamples() {
      $('mkt-samples').innerHTML = samples.length ? samples.map(function (u, i) {
        return '<div class="mkt-sample"><img src="' + esc(u) + '" alt="">' +
          '<button type="button" class="mkt-sx" data-del="' + i + '" title="Take this one off">&times;</button>' +
          (i ? '<button type="button" class="mkt-sfirst" data-first="' + i + '" title="Make this the card picture">Make first</button>' : '<span class="mkt-sfirst mkt-sfirst-on">Card picture</span>') + '</div>';
      }).join('') : '<div class="mkt-sub">No pictures yet.</div>';
    }
    function countBio() { var n = ($('mkt-f-bio').value || '').length; $('mkt-bio-count').textContent = n + ' / 2000'; }
    paintSamples(); countBio();
    $('mkt-f-bio').addEventListener('input', countBio);
    $('mkt-samples').addEventListener('click', function (e) {
      var t = e.target;
      if (t.getAttribute('data-del') != null) { samples.splice(Number(t.getAttribute('data-del')), 1); paintSamples(); }
      else if (t.getAttribute('data-first') != null) { var i = Number(t.getAttribute('data-first')); samples.unshift(samples.splice(i, 1)[0]); paintSamples(); }
    });
    $('mkt-file').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (samples.length >= (data.max_samples || 6)) { flash($('mkt-up-msg'), 'Six is the most. Take one off first.', true); return; }
      var fd = new FormData(); fd.append('image', f);
      flash($('mkt-up-msg'), 'Uploading and checking\u2026');
      api('POST', '/api/marketplace/mine/samples', fd).then(function (x) {
        if (!x.ok) { flash($('mkt-up-msg'), x.j.error || 'Could not upload that picture.', true); return; }
        samples.push(x.j.url); paintSamples();
        flash($('mkt-up-msg'), x.j.verdict === 'warn' ? 'Added. It looks signed, which is fine if it is your signature.' : 'Added. Save to keep it.');
      });
    });
    function collect(submit) {
      return {
        display_name: $('mkt-f-name').value, headline: $('mkt-f-head').value,
        roles: Array.prototype.filter.call(body.querySelectorAll('.mkt-checks input'), function (c) { return c.checked; }).map(function (c) { return c.value; }),
        bio: $('mkt-f-bio').value,
        links: Array.prototype.map.call(body.querySelectorAll('.mkt-f-link'), function (i) { return i.value; }).filter(function (v) { return v.trim(); }),
        rates: $('mkt-f-rates').value, availability: $('mkt-f-avail').value, samples: samples.slice(), submit: !!submit
      };
    }
    body.querySelector('.mkt-actions') && body.querySelector('.mkt-actions').addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act !== 'save' && act !== 'submit') return;
      var msg = $('mkt-save-msg');
      flash(msg, 'Saving\u2026');
      api('PUT', '/api/marketplace/mine', collect(act === 'submit')).then(function (x) {
        if (!x.ok) { flash(msg, x.j.error || 'Could not save it right now.', true); return; }
        m = x.j.mine;
        $('mkt-state').textContent = statusSentence(m);
        flash(msg, act === 'submit' ? (m.status === 'approved' ? 'Nothing changed, so it stays as it is.' : 'Sent for review. We will email you when it is decided.') : 'Saved.');
        loadStatus();
      });
    });
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
    var txt = !m ? 'Artists, writers and editors can list themselves so Story Masters can find them and get in touch.'
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
    var w = $('mkt-admin-waiting'); if (w) w.textContent = STATUS.waiting ? (STATUS.waiting + ' waiting for review') : 'Nothing waiting for review';
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
    var ov = modal('mkt-modal-wide', '<div class="mkt-title">Marketplace listings</div>' +
      '<div class="mkt-row"><select id="mkt-rv-filter"><option value="pending">Waiting for review</option><option value="approved">Live</option><option value="declined">Sent back</option><option value="draft">Drafts</option><option value="removed">Removed</option><option value="">All</option></select>' +
      '<span class="mkt-msg" id="mkt-rv-msg"></span></div><div class="mkt-body" id="mkt-rv-list"><span class="mkt-spin"></span></div>');
    var all = [];
    function paint() {
      var f = $('mkt-rv-filter').value;
      var list = all.filter(function (m) { return !f || m.status === f; });
      $('mkt-rv-list').innerHTML = list.length ? list.map(reviewCard).join('') : '<p class="mkt-sub">Nothing here.</p>';
    }
    function load() {
      api('GET', '/api/marketplace/admin/listings').then(function (x) {
        if (!x.ok) { $('mkt-rv-list').innerHTML = '<p>' + esc(x.j.error || 'Could not load the listings.') + '</p>'; return; }
        all = x.j.listings || []; paint();
      });
    }
    $('mkt-rv-filter').addEventListener('change', paint);
    $('mkt-rv-list').addEventListener('click', function (e) {
      var act = e.target.getAttribute && e.target.getAttribute('data-rv');
      if (!act) return;
      var card = e.target.closest('.mkt-rv'); var id = card.getAttribute('data-id');
      var note = card.querySelector('textarea').value;
      e.target.disabled = true;
      api('POST', '/api/marketplace/admin/listings/' + id + '/review', { action: act, note: note }).then(function (x) {
        e.target.disabled = false;
        if (!x.ok) { flash($('mkt-rv-msg'), x.j.error || 'Could not do that.', true); return; }
        flash($('mkt-rv-msg'), 'Done: ' + act + (x.j.emailed ? ' (emailed them)' : ''));
        load(); loadStatus();
      });
    });
    load();
  }
  function reviewCard(m) {
    var d = m.draft, live = m.live;
    var diff = [];
    if (live && m.changed) ['display_name', 'headline', 'roles', 'bio', 'links', 'rates', 'availability', 'samples'].forEach(function (k) {
      if (JSON.stringify(d[k]) !== JSON.stringify(live[k])) diff.push(k.replace('_', ' '));
    });
    var pics = (d.samples || []).map(function (u) {
      var r = m.sample_rights[u];
      var badge = r ? '<span class="mkt-badge mkt-badge-' + esc(r.verdict) + '" title="' + esc((r.reasons || []).join(' ')) + '">' + esc({ warn: 'signed?', reject: 'watermark', ok: 'checked' }[r.verdict] || r.verdict) + '</span>' : '';
      return '<a class="mkt-rv-pic" href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="">' + badge + '</a>';
    }).join('');
    return '<div class="mkt-rv" data-id="' + esc(m.id) + '">' +
      '<div class="mkt-rv-top"><b>' + esc(d.display_name || '(no name)') + '</b> <span class="mkt-sub">' + esc(m.status) + (m.paused ? ', paused' : '') + (m.has_live ? ', has a live copy' : '') +
        ' &middot; ' + esc(m.contacts) + ' contact' + (m.contacts === 1 ? '' : 's') + '</span>' +
        '<div class="mkt-sub">Account: ' + esc(m.owner.name) + (m.owner.pen_name ? ' (' + esc(m.owner.pen_name) + ')' : '') + ' &lt;' + esc(m.owner.email) + '&gt;</div></div>' +
      (diff.length ? '<div class="mkt-diff">Changed since it was approved: ' + esc(diff.join(', ')) + '</div>' : '') +
      '<div class="mkt-head">' + esc(d.headline) + '</div><div class="mkt-pills">' + rolePills(d.roles) + '</div>' +
      '<div class="mkt-bio">' + esc(d.bio) + '</div>' +
      (d.links.length ? '<div class="mkt-links">' + d.links.map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="nofollow noopener noreferrer">' + esc(u) + '</a>'; }).join('') + '</div>' : '') +
      (d.rates ? '<div class="mkt-sub">Rates: ' + esc(d.rates) + '</div>' : '') +
      '<div class="mkt-sub">Availability: ' + esc(AVAIL_NAMES[d.availability] || d.availability) + '</div>' +
      '<div class="mkt-rv-pics">' + pics + '</div>' +
      (m.admin_note ? '<div class="mkt-sub">Last note: \u201c' + esc(m.admin_note) + '\u201d</div>' : '') +
      '<textarea rows="2" maxlength="1000" placeholder="Note (sent to them with Decline and Remove; optional with Approve)"></textarea>' +
      '<div class="mkt-row">' +
        (m.status !== 'removed' ? '<button type="button" class="mkt-btn mkt-btn-gold" data-rv="approve">Approve</button><button type="button" class="mkt-btn" data-rv="decline">Send back</button><button type="button" class="mkt-btn mkt-danger" data-rv="remove">Remove</button>'
          : '<button type="button" class="mkt-btn" data-rv="restore">Restore</button>') +
      '</div></div>';
  }

  // ---------------------------------------------------------------- the Library tab
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

  window.Mkt = { openEditor: openEditor, openReview: openReview, openListing: openListing, setSwitch: setSwitch, refresh: loadStatus, showDirectory: showDirectory };

  function start() {
    libraryWire();
    loadStatus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
