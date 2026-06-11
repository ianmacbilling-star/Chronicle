// ============================================================
// STATE
// ============================================================
var state = {
  user: null,
  userTier: null,
  campaigns: [],
  currentCampaign: null,
  layoutStyle: 'Classic',
  currentSession: null,
  currentForkId: null,
  sessionForks: [],
  characters: [],
  sessions: [],
  moments: [],
  artStyle: 'High fantasy illustration',
  currentView: 'campaigns'
};

// ============================================================
// TOKEN BALANCE — header label, refreshed on load and after any
// token-spending action. Defined once (guarded), called globally.
// ============================================================
function refreshTokenBalance() {
  fetch('/api/tokens/balance')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var el = document.getElementById('token-balance-value');
      if (el && data && typeof data.total === 'number') {
        el.textContent = data.total.toLocaleString();
      }
    })
    .catch(function() { /* non-fatal: keep last shown value */ });
}

// ----- Non-destructive busy overlay (shared across all generation flows) -----
// Drops a semi-transparent overlay with a spinning gold ring + uppercase
// label on top of any container — without removing what's underneath. The
// existing image stays in the DOM; if generation refuses or fails, the
// overlay is removed and the original is intact.
// Optional `sublabel` shows a smaller line of descriptive text below the
// main label (used for cycling status messages in the character flows).
// `target` may be an Element or an element id string.
function showBusyOverlay(target, label, sublabel) {
  var el = (typeof target === 'string') ? document.getElementById(target) : target;
  if (!el) return null;
  // The target must be a positioned ancestor for absolute children to anchor.
  // Force position:relative if it isn't already.
  var computed = window.getComputedStyle(el).position;
  if (computed === 'static') el.style.position = 'relative';
  // Don't stack overlays.
  var existing = el.querySelector(':scope > .moment-img-busy-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.className = 'moment-img-busy-overlay';
  var subHtml = sublabel
    ? '<div class="moment-img-busy-sublabel">' + sublabel + '</div>'
    : '';
  overlay.innerHTML =
    '<div class="moment-img-busy-spinner"></div>' +
    '<div class="moment-img-busy-label">' + (label || 'Generating') + '\u2026</div>' +
    subHtml;
  el.appendChild(overlay);
  return overlay;
}
// Update just the sublabel text inside an existing overlay (used by the
// cycling status ticker so we don't tear down and rebuild every 4 seconds).
function updateBusyOverlaySublabel(target, sublabel) {
  var el = (typeof target === 'string') ? document.getElementById(target) : target;
  if (!el) return;
  var sub = el.querySelector(':scope > .moment-img-busy-overlay .moment-img-busy-sublabel');
  if (sub) sub.textContent = sublabel || '';
}
function hideBusyOverlay(target) {
  var el = (typeof target === 'string') ? document.getElementById(target) : target;
  if (!el) return;
  var overlay = el.querySelector(':scope > .moment-img-busy-overlay');
  if (overlay) overlay.remove();
}

// Storyboard-panel-specific wrappers (kept for the existing call sites).
function showPanelBusy(momentId, label) {
  // Clear any stale error overlay first — a fresh regenerate should not
  // show the spinner sitting on top of yesterday's error message.
  hidePanelError(momentId);
  return showBusyOverlay('moment-card-' + momentId, label);
}
function hidePanelBusy(momentId) {
  hideBusyOverlay('moment-card-' + momentId);
}
function hideAllPanelBusy() {
  var overlays = document.querySelectorAll('.moment-img-busy-overlay');
  for (var i = 0; i < overlays.length; i++) overlays[i].remove();
}

// Show an error AT the panel (not at the top of the page). Solves the
// "user scrolled deep, errors appear off-screen and they think nothing
// happened" problem. The overlay sits on top of the existing image so
// the original is preserved and visible underneath. Auto-removes the
// busy overlay first (we never want both at once).
// htmlContent: either a plain string (treated as text) or HTML when
// the caller passes the insufficientTokensHtml(...) output.
function showPanelError(momentId, htmlContent, isHtml) {
  var card = document.getElementById('moment-card-' + momentId);
  if (!card) return;
  // Remove any existing busy / error overlay first.
  hidePanelBusy(momentId);
  var prev = card.querySelector('.moment-img-error-overlay');
  if (prev) prev.remove();

  var overlay = document.createElement('div');
  overlay.className = 'moment-img-error-overlay';

  var dismissBtn = '<button class="moment-img-error-dismiss" onclick="hidePanelError(' + momentId + ')" title="Dismiss">&times;</button>';
  var icon = '<div class="moment-img-error-icon">&#9888;</div>';
  var body = isHtml
    ? '<div class="moment-img-error-message">' + htmlContent + '</div>'
    : '<div class="moment-img-error-message">' + (htmlContent || 'Something went wrong.') + '</div>';

  overlay.innerHTML = dismissBtn + icon + body;
  card.appendChild(overlay);

  // Scroll the panel into view if it's off-screen (a courtesy, not the
  // primary fix — the in-panel overlay IS the primary fix, but if the
  // user clicked a panel that's already partially visible we may as well
  // ensure the error is fully in frame).
  try {
    var rect = card.getBoundingClientRect();
    var fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!fullyVisible) {
      card.scrollIntoView({ behavior:'smooth', block:'center' });
    }
  } catch(e) { /* non-fatal */ }
}

function hidePanelError(momentId) {
  var card = document.getElementById('moment-card-' + momentId);
  if (!card) return;
  var overlay = card.querySelector('.moment-img-error-overlay');
  if (overlay) overlay.remove();
}

// ----- TOKENS VIEW (purchase screen) -----
// The four token packs from the locked pricing model. Edit here when
// pricing changes. The "best value" flag highlights one card so the
// eye lands on the recommended option (classic e-commerce nudge).
var TOKEN_PACKS = [
  { id:'small',  name:'Small',  price:15,  tokens:85,   tagline:'Try it out' },
  { id:'medium', name:'Medium', price:40,  tokens:250,  tagline:'Most popular', highlight:true },
  { id:'large',  name:'Large',  price:100, tokens:650,  tagline:'For active campaigns' },
  { id:'huge',   name:'Huge',   price:250, tokens:1700, tagline:'Best per-token value' }
];

function openTokensModal() {
  // Refresh balance into both the modal and the header chip.
  fetch('/api/tokens/balance')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var el = document.getElementById('tokens-modal-balance');
      if (el && data && typeof data.total === 'number') {
        el.textContent = data.total.toLocaleString();
      }
      var hdr = document.getElementById('token-balance-value');
      if (hdr && data && typeof data.total === 'number') {
        hdr.textContent = data.total.toLocaleString();
      }
    })
    .catch(function() { /* leave dashes */ });
  renderTokenPacks();
  // Hide any prior purchase message from a previous open.
  var pm = document.getElementById('token-purchase-msg');
  if (pm) pm.style.display = 'none';
  // Show the modal.
  var m = document.getElementById('tokens-modal');
  if (m) m.classList.remove('hidden');
}

function closeTokensModal() {
  var m = document.getElementById('tokens-modal');
  if (m) m.classList.add('hidden');
  // Refresh balance one more time on close so the header chip reflects
  // anything that may have changed while the modal was open (future:
  // a real Stripe purchase will redirect back and we'll see the credit).
  if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
}

function renderTokenPacks() {
  var wrap = document.getElementById('token-packs');
  if (!wrap) return;
  var html = TOKEN_PACKS.map(function(p) {
    var perTok = (p.price / p.tokens).toFixed(3);
    var highlightStyle = p.highlight
      ? 'border:2px solid #c9a84c;box-shadow:0 0 0 1px rgba(201,168,76,0.3),0 6px 18px rgba(201,168,76,0.1);'
      : 'border:1px solid rgba(201,168,76,0.2);';
    var badge = p.highlight
      ? '<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#c9a84c;color:#1a120a;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:99px;">' + p.tagline.toUpperCase() + '</div>'
      : '';
    return '' +
      '<div style="position:relative;background:rgba(25,18,10,0.85);' + highlightStyle + 'border-radius:10px;padding:22px 18px 18px;text-align:center;display:flex;flex-direction:column;gap:8px;">' +
        badge +
        '<div style="font-family:var(--font-display);font-size:13px;letter-spacing:2px;text-transform:uppercase;color:rgba(201,168,76,0.7);">' + p.name + '</div>' +
        '<div style="font-size:32px;font-weight:700;color:#c9a84c;line-height:1;margin:4px 0 2px;">$' + p.price + '</div>' +
        '<div style="font-size:16px;color:var(--text);"><strong>' + p.tokens.toLocaleString() + '</strong> tokens</div>' +
        '<div style="font-size:11px;color:rgba(201,168,76,0.5);margin-bottom:6px;">$' + perTok + ' per token</div>' +
        (p.highlight ? '' : '<div style="font-size:11px;color:rgba(201,168,76,0.6);font-style:italic;">' + p.tagline + '</div>') +
        '<button class="btn btn-primary btn-sm" onclick="buyTokenPack(\'' + p.id + '\')" style="margin-top:auto;">Buy ' + p.name + '</button>' +
      '</div>';
  }).join('');
  wrap.innerHTML = html;
}

function buyTokenPack(packId) {
  // Stripe wiring is pending. For now show a friendly "coming soon"
  // message anchored at the pack grid, so the surface is usable even
  // before purchasing actually works.
  var msg = document.getElementById('token-purchase-msg');
  if (!msg) return;
  var pack = TOKEN_PACKS.filter(function(p){return p.id===packId;})[0];
  var label = pack ? pack.name + ' pack ($' + pack.price + ')' : 'this pack';
  msg.innerHTML = '&#9881; Purchasing is being set up. ' + label + ' will be available very soon. ' +
    'In the meantime, contact your admin to add tokens to your account.';
  msg.style.display = 'block';
  msg.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

// Renders the INSUFFICIENT_TOKENS error as a message + "Buy more tokens"
// button, returned as an HTML string. Callers drop it into the appropriate
// container via .innerHTML. If the error isn't a token error, returns
// the plain error text (HTML-safe by basic browser handling).
function insufficientTokensHtml(message) {
  var msg = message || 'You\u2019re out of tokens.';
  return '<div style="display:flex;flex-direction:column;align-items:flex-start;gap:8px;">' +
    '<div>' + msg + '</div>' +
    '<button class="btn btn-primary btn-sm" onclick="openTokensModal()">&#9672; Buy more tokens</button>' +
    '</div>';
}

// ----- TESTING: self-service add tokens (any user). Remove at Stripe. -----
function devAddTokens() {
  var input = document.getElementById('dev-add-tokens-input');
  var msg = document.getElementById('dev-add-tokens-msg');
  function show(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.background = ok ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.12)';
    msg.style.color = ok ? '#3c9142' : '#c0392b';
  }
  if (!input) return;
  var amt = parseInt(input.value, 10);
  if (!Number.isFinite(amt) || amt <= 0) { show('Enter a positive whole number.', false); return; }
  fetch('/api/tokens/dev-credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok) {
        show('Added ' + amt + ' tokens. Balance: ' + (data.balance && data.balance.total) + '.', true);
        refreshTokenBalance();
      } else {
        show((data && data.error) || 'Could not add tokens.', false);
      }
    })
    .catch(function() { show('Network error.', false); });
}

// ----- TESTING: put this account in/out of the free trial. Remove later. -----
function devApplyTrial() {
  var toggle = document.getElementById('dev-trial-toggle');
  var dateEl = document.getElementById('dev-trial-date');
  var msg = document.getElementById('dev-trial-msg');
  function show(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.background = ok ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.12)';
    msg.style.color = ok ? '#3c9142' : '#c0392b';
  }
  if (!toggle) return;
  var body = { inTrial: toggle.checked };
  if (toggle.checked && dateEl && dateEl.value) body.started_at = dateEl.value;
  fetch('/api/auth/trial-testing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        state.inFreeTrial = !!data.inTrial;
        show(data.inTrial ? 'Account is now IN the free trial. Open a session to see the watermark.' : 'Account is now OUT of the free trial (watermark off).', true);
      } else {
        show((data && data.error) || 'Could not update trial state.', false);
      }
    })
    .catch(function() { show('Network error.', false); });
}

// ----- ADMIN TESTING: set my own balance (temporary, deprecate later) -----
function adminSetMyBalance() {
  var input = document.getElementById('admin-set-balance-input');
  var msg = document.getElementById('admin-set-balance-msg');
  if (!input || !state.user || !state.user.id) return;
  var amt = parseInt(input.value, 10);
  if (!Number.isFinite(amt) || amt < 0) {
    showAdminBalanceMsg('Enter a non-negative whole number.', 'err');
    return;
  }
  fetch('/api/tokens/admin/set-balance', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ user_id: state.user.id, amount: amt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok) {
        showAdminBalanceMsg('Balance set to ' + (data.balance && data.balance.total) + '.', 'ok');
        refreshTokenBalance();
      } else {
        showAdminBalanceMsg((data && data.error) || 'Could not set balance.', 'err');
      }
    })
    .catch(function() { showAdminBalanceMsg('Network error.', 'err'); });
}
function showAdminBalanceMsg(text, kind) {
  var el = document.getElementById('admin-set-balance-msg');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  if (kind === 'ok') {
    el.style.background = 'rgba(15,110,86,0.25)';
    el.style.border = '1px solid rgba(134,212,186,0.4)';
    el.style.color = '#86d4ba';
  } else {
    el.style.background = 'rgba(139,26,26,0.35)';
    el.style.border = '1px solid rgba(240,149,149,0.4)';
    el.style.color = '#f09595';
  }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  checkAuth();
  var charImageInput = document.getElementById('char-image-input');
  if (charImageInput) charImageInput.addEventListener('change', previewCharImage);
  var sessionDate = document.getElementById('session-date');
  if (sessionDate) sessionDate.value = new Date().toISOString().split('T')[0];

  // Close user menu when clicking outside
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('user-menu');
    var btn = document.querySelector('.user-menu-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // CRITICAL: Prevent browser from opening dragged files as new pages
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop', function(e) { e.preventDefault(); });
});

// ============================================================
// AUTH
// ============================================================
function checkAuth() {
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.authenticated) { window.location.href = '/'; return; }
      state.user = data;
      // Tier info drives feature gates (prompt editing, watermark, export)
      state.userTier = data.tierFeatures || null;
      state.inFreeTrial = !!data.inFreeTrial;
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';
      var navSettingsItem = document.getElementById('nav-settings-item');
      if (navSettingsItem) navSettingsItem.style.display = data.is_admin ? 'block' : 'none';

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            var akEl = document.getElementById('settings-apikey');
            if (akEl) akEl.value = k.api_key;
          }
        });

      loadCampaigns();
    });
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' })
    .then(function() { window.location.href = '/'; });
}

function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('open');
}

function closeUserMenu() {
  document.getElementById('user-menu').classList.remove('open');
}

// ============================================================
// MY ACCOUNT (read-only)
// ============================================================
// ============================================================
// SUSPEND ACCOUNT (self-service). Suspend holds the account + all data
// for the retention window; the user reactivates simply by logging back
// in. Permanent delete is a separate, later flow.
// ============================================================
function openSuspendConfirm() {
  var e = document.getElementById('suspend-modal-error');
  if (e) e.classList.add('hidden');
  var m = document.getElementById('suspend-modal');
  if (m) m.classList.remove('hidden');
}
function closeSuspendConfirm() {
  var m = document.getElementById('suspend-modal');
  if (m) m.classList.add('hidden');
}
function suspendAccount() {
  var btn = document.getElementById('suspend-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Suspending…'; }
  fetch('/api/auth/suspend', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.success) {
        window.location.href = '/';
      } else {
        var e = document.getElementById('suspend-modal-error');
        if (e) { e.textContent = (d && d.error) || 'Could not suspend account.'; e.classList.remove('hidden'); }
        if (btn) { btn.disabled = false; btn.textContent = 'Suspend my account'; }
      }
    })
    .catch(function() {
      var e = document.getElementById('suspend-modal-error');
      if (e) { e.textContent = 'Could not suspend account. Please try again.'; e.classList.remove('hidden'); }
      if (btn) { btn.disabled = false; btn.textContent = 'Suspend my account'; }
    });
}

function loadAccount() {
  // Profile fields moved here from Settings — populate name/email from state.
  var _pn = document.getElementById('settings-name');
  if (_pn) _pn.value = (state.user && state.user.name) || '';
  var _pe = document.getElementById('settings-email');
  if (_pe) _pe.value = (state.user && state.user.email) || '';
  // Pull current tier + plan info, then usage counts.
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(me) {
      if (!me || !me.authenticated) return;
      renderAccountTier(me);
      renderAccountPlans(me);
      var _tk = document.getElementById('setting-thinking'); if (_tk) _tk.checked = !!me.renderThinking;
      var _tt = document.getElementById('dev-trial-toggle'); if (_tt) _tt.checked = !!me.inFreeTrial;
      var _td = document.getElementById('dev-trial-date'); if (_td && me.trialStartedAt) _td.value = String(me.trialStartedAt).slice(0,10);
      return fetch('/api/auth/usage').then(function(r) { return r.json(); });
    })
    .then(function(usage) {
      if (usage) renderAccountUsage(usage);
    })
    .catch(function(){});
}

function saveRenderThinking() {
  var el = document.getElementById('setting-thinking');
  if (!el) return;
  fetch('/api/auth/render-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinking: el.checked })
  }).catch(function(){});
}

// TESTING ONLY: switch the signed-in account's tier so we can exercise
// tier-gated features. NOT a real upgrade path -- remove before production.
function setTierOverride() {
  var sel = document.getElementById('account-tier-override');
  var msg = document.getElementById('account-tier-override-msg');
  if (!sel) return;
  if (msg) msg.textContent = 'Applying...';
  fetch('/api/auth/set-tier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: sel.value })
  })
  .then(function (r) { return r.json(); })
  .then(function (d) {
    if (d && d.success) { window.location.reload(); }
    else if (msg) { msg.textContent = 'Could not change tier: ' + ((d && d.error) || 'unknown'); }
  })
  .catch(function (e) { if (msg) msg.textContent = 'Could not change tier: ' + e.message; });
}

var TIER_COLORS = {
  copper:   { bg:'#6b4a2f', fg:'#f0d8b8' },
  silver:   { bg:'#8a8d93', fg:'#1a1a1a' },
  gold:     { bg:'#c9a84c', fg:'#1a1a1a' },
  platinum: { bg:'#3a3d6b', fg:'#e8e8f0' }
};

function renderAccountTier(me) {
  var tierKey = (me.tier || 'copper');
  // TESTING tier override: reflect the current tier in the dropdown.
  var _ov = document.getElementById('account-tier-override');
  if (_ov) _ov.value = tierKey;
  var feat = me.tierFeatures || {};
  var nameEl = document.getElementById('account-tier-name');
  if (nameEl) nameEl.textContent = (feat.name || tierKey) + ' Plan';

  var badge = document.getElementById('account-tier-badge');
  if (badge) {
    var col = TIER_COLORS[tierKey] || TIER_COLORS.copper;
    badge.textContent = (feat.name || tierKey).toUpperCase();
    badge.style.background = col.bg;
    badge.style.color = col.fg;
  }

  var desc = document.getElementById('account-tier-desc');
  if (desc) {
    var priceText = (feat.price ? ('$' + feat.price + '/month') : 'Free');
    desc.textContent = (feat.description || '') + ' \u2014 ' + priceText;
  }

  // Trial banner — only for copper with a trial running
  var banner = document.getElementById('account-trial-banner');
  if (banner) {
    if (tierKey === 'copper' && me.trialDaysLeft !== null && me.trialDaysLeft !== undefined) {
      if (me.trialExpired) {
        banner.textContent = 'Your free trial has expired. Upgrade to keep creating.';
      } else {
        banner.textContent = 'Free trial: ' + me.trialDaysLeft + ' day' +
          (me.trialDaysLeft === 1 ? '' : 's') + ' remaining.';
      }
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  // Feature grid
  var grid = document.getElementById('account-features');
  if (grid) {
    function row(label, ok) {
      var mark = ok
        ? '<span style="color:#7fae5f;">\u2713</span> '
        : '<span style="color:#9a6a5a;">\u2717</span> ';
      return '<div>' + mark + label + '</div>';
    }
    function val(label, v) {
      return '<div><span style="color:var(--gold);">' + v + '</span> ' + label + '</div>';
    }
    var campLimit = (feat.max_campaigns === null || feat.max_campaigns === undefined)
      ? 'Unlimited' : feat.max_campaigns;
    var sessLimit = (feat.max_sessions === null || feat.max_sessions === undefined)
      ? 'Unlimited' : feat.max_sessions;
    grid.innerHTML =
      val('campaigns', campLimit) +
      val('sessions per campaign', sessLimit) +
      row('Export to PDF', feat.can_export) +
      row('Print on demand', feat.can_print) +
      row('Prompt editing', feat.can_edit_prompts) +
      row('Watermark-free', !feat.watermark);
  }
}

function renderAccountUsage(usage) {
  var el = document.getElementById('account-usage');
  if (!el) return;
  function card(num, label) {
    return '<div style="background:rgba(201,168,76,0.06);border:1px solid rgba(201,168,76,0.18);' +
      'border-radius:var(--radius);padding:16px;text-align:center;">' +
      '<div style="font-family:var(--font-display);font-size:28px;color:var(--gold);">' + num + '</div>' +
      '<div style="font-size:11px;color:var(--text-light);letter-spacing:0.5px;margin-top:4px;">' +
      label + '</div></div>';
  }
  el.innerHTML =
    card(usage.campaigns || 0, 'ACTIVE CAMPAIGNS') +
    card(usage.sessions || 0, 'TOTAL SESSIONS') +
    card(usage.storyboards || 0, 'STORYBOARDS') +
    card(usage.imagesThisMonth || 0, 'IMAGES THIS MONTH') +
    card(usage.imagesAllTime || 0, 'IMAGES ALL TIME');
}

function renderAccountPlans(me) {
  var el = document.getElementById('account-plans');
  if (!el) return;
  var all = me.allTiers || {};
  var current = me.tier || 'copper';
  var order = ['copper','silver','gold','platinum'];

  el.innerHTML = order.map(function(key) {
    var t = all[key];
    if (!t) return '';
    var isCurrent = (key === current);
    var col = TIER_COLORS[key] || TIER_COLORS.copper;
    var priceText = t.price ? ('$' + t.price + '<span style="font-size:11px;color:var(--text-light);">/mo</span>') : 'Free';
    return '<div style="border:1px solid ' + (isCurrent ? 'var(--gold)' : 'rgba(201,168,76,0.2)') + ';' +
      'border-radius:var(--radius-lg);padding:16px;background:' +
      (isCurrent ? 'rgba(201,168,76,0.08)' : 'transparent') + ';">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-family:var(--font-display);font-size:14px;letter-spacing:1px;color:' + col.bg + ';">' +
          (t.name || key).toUpperCase() + '</span>' +
        (isCurrent ? '<span style="font-size:10px;color:var(--gold);font-weight:600;">CURRENT</span>' : '') +
      '</div>' +
      '<div style="font-family:var(--font-display);font-size:22px;color:var(--text);margin:8px 0;">' + priceText + '</div>' +
      '<div style="font-size:11px;color:var(--text-light);line-height:1.5;">' + (t.description || '') + '</div>' +
    '</div>';
  }).join('');
}

// Get API key — prefer settings field, fall back to nothing
function getApiKey() {
  var el = document.getElementById('settings-apikey');
  return el ? el.value.trim() : '';
}

// ============================================================
// BREADCRUMB
// ============================================================
function setBreadcrumb(items) {
  var bc = document.getElementById('breadcrumb');
  var html = '';
  items.forEach(function(item, i) {
    if (i > 0) html += '<span class="breadcrumb-sep">&#8250;</span>';
    if (item.action && i < items.length - 1) {
      html += '<span class="breadcrumb-link" onclick="' + item.action + '">' + item.label + '</span>';
    } else {
      html += '<span class="breadcrumb-current">' + item.label + '</span>';
    }
  });
  bc.innerHTML = html;
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(view) {
  if (view === 'settings' && !(state.user && state.user.is_admin)) { view = 'account'; }
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings','members','archives'];
  views.forEach(function(v) {
    var el = document.getElementById('view-' + v);
    if (el) el.style.display = 'none';
  });

  var el = document.getElementById('view-' + view);
  if (el) el.style.display = 'block';
  state.currentView = view;

  // Update sidebar active states
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });

  if (view === 'campaigns') {
    var _sc=document.getElementById('snav-campaigns'); if(_sc)_sc.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
    loadAccount();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
}

function showCampaignSection(section) {
  // A player can only enter the Graphic Novel if the SM enabled it for this campaign.
  if (section === 'novel' && state.currentCampaign) {
    var _c = state.currentCampaign;
    var _allow = (_c.allow_player_novel_access === true || _c.allow_player_novel_access === 1 || _c.allow_player_novel_access === 't' || _c.allow_player_novel_access === 'true');
    if (_c.my_role !== 'dm' && !_allow) { section = 'sessions'; }
  }
  showView(section);

  // Show campaign subnav
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', assets:'Asset Library', novel:'Publish', members:'Members', archives:'Archives'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') { loadCharacters(); renderCampaignLockBanner(); }
  if (section === 'novel') { loadNovelPeople(); loadNovelSummary(); }
  if (section === 'assets') loadAssets();
  if (section === 'archives') loadArchives();
  if (section === 'members') loadMembersTab();

  // Phase 3 — apply role-based visibility (hide DM-only UI for players).
  applyRoleVisibility();
}

// ============================================================
// CAMPAIGNS
// ============================================================
function loadCampaigns() {
  fetch('/api/campaigns')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.campaigns = Array.isArray(data) ? data : [];
      renderCampaigns();
    });
}

function renderCampaigns() {
  var grid = document.getElementById('campaigns-grid');
  var html = state.campaigns.map(function(c) {
    return '<div class="campaign-card" onclick="selectCampaign(' + c.id + ')">' +
      (c.cover_image_url
        ? '<div class="campaign-card-cover" style="background-image:url(\'' + encodeURI(c.cover_image_url) + '\');"></div>'
        : '<div class="campaign-card-icon"><img src="/images/Campaignia_Icon.png" alt="" /></div>') +
      '<div class="campaign-card-name">' + c.name + '</div>' +
      '<div class="campaign-card-desc">' + (c.description || 'No description') + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
        '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
        (c.my_role === 'dm' ? '<button class="campaign-card-menu-btn" onclick="openCampaignSettings(' + c.id + ', event)" title="Campaign settings">&#8943;</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  html += '<div class="add-campaign-card" onclick="openCampaignModal()"><div class="plus">+</div><span>New campaign</span></div>';
  grid.innerHTML = html;
}

function setCampaignElements() {
  // sessions-title is owned by renderSessions() so it can include the session count
  var ct = document.getElementById('novel-cover-title');
  var cs = document.getElementById('novel-cover-sub');
  if (ct) ct.textContent = state.currentCampaign.name;
  if (cs) cs.textContent = state.currentCampaign.description || '';
  if (state.currentCampaign) loadTierInfo(state.currentCampaign.id);
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('campaign-modal-error', data.error); return; }
    closeCampaignModal();
    loadCampaigns();
  });
}

// ============================================================
// SESSIONS
// ============================================================

function formatSessionDate(dateVal) {
  if (!dateVal) return '';
  // PostgreSQL returns Date objects, SQLite returns strings
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  // Handle both 'YYYY-MM-DD' and full ISO strings
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
function loadSessions() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.sessions = Array.isArray(data) ? data : [];
      renderSessions();
    });
}

function renderSessions() {
  var list = document.getElementById('sessions-list');

  // Campaign name + count + description in the header (DM can edit inline).
  renderCampaignHeaderDisplay();

  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128203;</div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    return;
  }

  // Newest first — sort by session date descending
  var ordered = state.sessions.slice().sort(function(a, b) {
    var da = (a.session_date || '').toString().split('T')[0];
    var db = (b.session_date || '').toString().split('T')[0];
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  list.innerHTML = ordered.map(function(s) {
    var thumb = s.first_image_url
      ? '<img class="session-thumb" src="' + s.first_image_url + '" alt="" loading="lazy" />'
      : '';
    var readyChip = (s.player_access_status === 'ready')
      ? '<span class="session-badge">Ready</span>'
      : '<span class="session-badge session-badge-draft">Draft</span>';
    var transcriptChip = s.transcript
      ? '<span class="session-badge">Has transcript</span>'
      : '<span class="session-badge empty">No transcript</span>';
    var menuId = 'session-menu-' + s.id;
    var deleteMenu =
      '<div class="row-menu dm-only">' +
        '<button class="row-menu-btn" onclick="event.stopPropagation();toggleRowMenu(\'' + menuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + menuId + '">' +
          '<button class="row-menu-item row-menu-item-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete session</button>' +
        '</div>' +
      '</div>';
    return '<div class="session-item" onclick="selectSession(' + s.id + ')">' +
      '<div class="session-item-left">' +
        thumb +
        '<div>' +
          '<div class="session-name">' + s.name + '</div>' +
          '<div class="session-date">' + formatSessionDate(s.session_date) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-1 items-center">' +
        readyChip +
        transcriptChip +
        deleteMenu +
      '</div>' +
    '</div>';
  }).join('');
}

function openSessionModal() {
  document.getElementById('session-name').value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('session-modal-error', data.error); return; }
    closeSessionModal();
    // Drop the user straight into the newly created session (the backend
    // returns the full session row, so data.id is the new id). Fall back to
    // just refreshing the list if no id came back.
    if (data && data.id) { selectSession(data.id); }
    else { loadSessions(); }
  });
}

function updateSessionDate(value) {
  if (!value || !state.currentCampaign || !state.currentSession) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ session_date: value })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.id) {
        state.currentSession = data;
        if (typeof loadSessions === 'function') loadSessions();
      }
    })
    .catch(function(){});
}

function deleteSession(id) {
  if (!confirm('Delete this session and all its moments? This cannot be undone.')) return;
  // Backend requires a confirmation flag in the body; without it the
  // route returns {error:'Confirmation required'} (HTTP 200) and the
  // delete silently no-ops. Send it, and surface any real error.
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) {
        if (typeof showAlert === 'function') { showAlert(data.error); } else { alert(data.error); }
        return;
      }
      loadSessions();
    })
    .catch(function(e) {
      if (typeof showAlert === 'function') { showAlert('Delete failed: ' + e.message); } else { alert('Delete failed: ' + e.message); }
    });
}

function selectSession(id) {
  // Clear previous session state
  state.moments = [];
  state.currentForkId = null;
  state.narrativeData = { intro: '', sections: [], outro: '' };
  var sbEmpty = document.getElementById('sb-empty');
  var sbContent = document.getElementById('sb-content');
  if (sbEmpty) sbEmpty.style.display = 'block';
  if (sbContent) sbContent.style.display = 'none';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      document.getElementById('session-detail-name').textContent = data.name;
      // Set editable date input
      var dateInput = document.getElementById('session-detail-date-input');
      if (dateInput && data.session_date) {
        var dateStr = typeof data.session_date === 'string'
          ? data.session_date.split('T')[0]
          : data.session_date.toISOString().split('T')[0];
        dateInput.value = dateStr;
      }
      // date now handled by session-detail-date-input

      // Load narrative data
      state.narrativeData = {
        intro: data.narrative_intro || '',
        sections: data.narrative_sections ? JSON.parse(data.narrative_sections) : [],
        outro: data.narrative_outro || ''
      };
      // Per-gap narrative directions for this version (Pass 1) — drives the
      // Direction pills on Review and the "prompt" blocks under the Storyboard
      // narrative panels.
      try { state.narrativeDirections = data.narrative_directions ? JSON.parse(data.narrative_directions) : {}; }
      catch (e) { state.narrativeDirections = {}; }
      // Narrative Styles: this version's narrative voice preset (defaults to 'classic').
      state.narrativeStyle = (data && data.narrative_style) ? data.narrative_style : 'classic';
      state.narrativeStyleUsed = (data && data.narrative_style_used) ? data.narrative_style_used : state.narrativeStyle;
      if (typeof refreshNarrStyleButtons === 'function') refreshNarrStyleButtons();

      if (state.moments.length) renderStoryboard();

      // Load last used art style for this campaign
      if (typeof loadLastArtStyle === 'function') loadLastArtStyle(data.art_style_override || data.art_style, data.layout_style);

      // Show session detail view FIRST
      var views = ['campaigns','sessions','characters','novel','session-detail','settings'];
      views.forEach(function(v) {
        var el = document.getElementById('view-' + v);
        if (el) el.style.display = 'none';
      });
      document.getElementById('view-session-detail').style.display = 'block';

      // Now that view is visible, populate fields
      switchSessionTab('notes');
      // Phase 3: apply role-based UI (hides DM-only buttons, sets readonly on Notes textareas for players)
      applyRoleVisibility();
      // Phase 3 Deploy 3 — initialize access-status (Ready/Draft) UI
      if (typeof initAccessStatusUI === 'function') initAccessStatusUI(data.fork_status || data.player_access_status || 'draft');
      if (typeof loadSessionForks === 'function') loadSessionForks(id);
      setTimeout(function() {
        updateNotesBox(data);
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      var _sx=document.getElementById('snav-sessions'); if(_sx)_sx.classList.add('active');
      var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
      var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

      // Breadcrumb
      setBreadcrumb([
        {label:'My Campaigns', action:"showView('campaigns')"},
        {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
        {label:'Sessions', action:"showCampaignSection('sessions')"},
        {label:data.name}
      ]);
    });
}

// Quietly save one session field (transcript or session_notes) — used by
// the auto-save-on-blur handlers. Shows a brief confirmation, fails silent.
function saveSessionField(field, value) {
  if (!state.currentCampaign || !state.currentSession) return;
  var body = {};
  body[field] = value;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data && data.id) state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    if (saved) {
      saved.textContent = (field === 'transcript' ? 'Transcript saved' : 'Notes saved');
      saved.classList.remove('hidden');
      setTimeout(function() { saved.classList.add('hidden'); }, 1800);
    }
  })
  .catch(function(){});
}

function saveTranscript() {
  var transcript = document.getElementById('transcript-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({transcript:transcript})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    showAlert('Transcript saved!');
  });
}

function saveNotes() {
  var notes = document.getElementById('session-notes-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({session_notes:notes})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    saved.classList.remove('hidden');
    setTimeout(function() { saved.classList.add('hidden'); }, 2500);
  });
}

// ---- Session character snapshots (Stage 2) ----
function loadSessionCharacters() {
  if (!state.currentCampaign || !state.currentSession) return;
  var empty = document.getElementById('sc-empty');
  var content = document.getElementById('sc-content');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters' + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      rows = Array.isArray(rows) ? rows : [];
      if (!rows.length) {
        if (empty) empty.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (content) content.style.display = 'block';
      renderSessionCharacters(rows);
    })
    .catch(function(){});
}

function renderSessionCharacters(rows) {
  // Phase 4 Step 3c — amendment controls show for the DM on canonical OR a
  // player on their OWN version. Prompt editing is allowed wherever the caller
  // can edit images (own fork, or DM on canonical) — no tier gate.
  var role = state.currentCampaign && state.currentCampaign.my_role;
  var ownFork = (role === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
  var canAct = (role === 'dm' && !state.currentForkId) || ownFork;
  var canEditPrompt = canAct;
  var list = document.getElementById('sc-list');
  if (!list) return;
  list.innerHTML = rows.map(function(r) {
    var isNpc = (r.is_npc === true || r.is_npc === 1 || r.is_npc === '1');
    // Reference image is the preferred thumbnail.
    var img = r.reference_url || r.canonical_reference_url || r.image_portrait || r.image || r.image_fullbody;
    var thumb = img
      ? '<img src="' + img + '" class="sc-thumb" alt="' + r.name + '" ' +
        'style="cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<div class="sc-thumb sc-thumb-empty">&#128100;</div>';

    // Stage 3: a pending change shows a review badge.
    var pendingChange = (r.change_flag === true || r.change_flag === 1 || r.change_flag === '1')
      && r.change_status === 'pending';
    // An accepted change is now shown on the Edit button label itself,
    // so there is no separate "Change applied" badge row.
    var acceptedChange = (r.change_status === 'accepted');
    var changeBadge = '';
    if (pendingChange && canAct) {
      changeBadge = '<div class="sc-change-badge" onclick="openChangeReview(' + r.character_id + ')">' +
        '&#9888; Change detected &mdash; review</div>';
    }

    var editBtn = '';
    if (canEditPrompt) {
      // Single "Edit" — always available (even after a change is approved,
      // so appearance amendments can be redone). Opens ONE panel with both the
      // description editor and the appearance-change section. When a change has
      // already been applied, the button label shows it (no separate badge row).
      var editLabel = acceptedChange ? '&#10003; Change applied — Edit' : '&#9998; Edit';
      editBtn = '<button class="btn btn-sm" onclick="openChangeReview(' + r.character_id + ')">' + editLabel + '</button>';
    }

    return '<div class="sc-card" id="sc-card-' + r.character_id + '">' +
      '<div class="sc-card-head">' +
        thumb +
        '<div class="sc-card-id">' +
          '<div class="sc-card-name">' + r.name +
            (isNpc ? ' <span class="char-badge char-badge-npc">NPC</span>' : '') + '</div>' +
          '<div class="sc-card-cls">' + (r.cls || '') + '</div>' +
        '</div>' +
        editBtn +
      '</div>' +
      changeBadge +
      '<div class="sc-card-prompt" id="sc-prompt-' + r.character_id + '">' +
        (r.prompt || '') + '</div>' +
    '</div>';
  }).join('');
  // Keep the rows available for the review screen.
  state.sessionCharacterRows = rows;
}

function startEditSnapshot(charId) {
  var card = document.getElementById('sc-card-' + charId);
  var promptEl = document.getElementById('sc-prompt-' + charId);
  if (!card || !promptEl) return;
  var current = promptEl.textContent;
  promptEl.outerHTML =
    '<textarea class="char-prompt-editor" id="sc-editor-' + charId + '">' + current + '</textarea>' +
    '<div class="char-prompt-actions" id="sc-actions-' + charId + '">' +
      '<button class="btn btn-sm btn-primary" onclick="saveSnapshot(' + charId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="loadSessionCharacters()">Cancel</button>' +
    '</div>';
}

function saveSnapshot(charId) {
  var ta = document.getElementById('sc-editor-' + charId);
  if (!ta) return;
  var newPrompt = ta.value;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        loadSessionCharacters();
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save.');
      }
    })
    .catch(function() { ta.disabled = false; alert('Could not save.'); });
}

// ---- Stage 3: character change review screen ----
// Opens an in-card review: the AI's detected change + an editable text
// field. Regenerate / Approve buttons are wired in Piece 5.
function openChangeReview(charId) {
  var rows = state.sessionCharacterRows || [];
  var r = rows.find(function(x) { return x.character_id === charId; });
  if (!r) return;
  var card = document.getElementById('sc-card-' + charId);
  if (!card) return;

  var currentImg = r.reference_url || r.canonical_reference_url || '';
  var imgHtml = currentImg
    ? '<img src="' + currentImg + '" class="sc-review-img" id="sc-review-img-' + charId + '" alt="reference" />'
    : '<div class="sc-review-img sc-review-img-empty" id="sc-review-img-' + charId + '">No reference image yet</div>';

  // Moment selector — which panel the change first becomes visible at.
  // The character looks normal before it, changed from it onward.
  var moments = state.moments || [];
  var savedIdx = (typeof r.change_moment_index === 'number' && r.change_moment_index >= 0) ? r.change_moment_index : -1;
  var emptyOpt = '<option value="-1"' + (savedIdx < 0 ? ' selected' : '') + '>&mdash; Empty (applies throughout, not tied to a Moment Panel) &mdash;</option>';
  var momentOptions = moments.map(function(m, i) {
    var label = 'Moment Panel ' + (i + 1) + (m.title ? ': ' + m.title : '');
    var sel = (i === savedIdx) ? ' selected' : '';
    return '<option value="' + i + '"' + sel + '>' + label + '</option>';
  }).join('');
  var momentSelector = moments.length
    ? '<label class="sc-review-label">Change first appears at this Moment Panel ' +
        '(character looks normal before it; choose Empty to apply it throughout):</label>' +
      '<select class="form-input sc-review-moment" id="sc-review-moment-' + charId + '">' +
        emptyOpt + momentOptions +
      '</select>'
    : '';

  var isAccepted = (r.change_status === 'accepted');
  // A "manual amend" = the DM opened this with no AI-detected change.
  var isManual = !isAccepted && !r.change_detail;
  var titleText;
  if (isAccepted) {
    titleText = '&#10003; Change applied — adjust or un-approve';
  } else if (isManual) {
    titleText = '&#10010; Amend ' + r.name + '\u2019s appearance';
  } else {
    titleText = '&#9888; Permanent change detected';
  }
  // For an accepted change, the textarea holds the clean change_note
  // (the approved detail), not change_detail.
  var detailText = isAccepted
    ? (r.change_note || r.change_detail || '')
    : (r.change_detail || '');
  // Only show the "AI detected" line when the AI actually detected something.
  var detectedLine = (r.change_detail && !isManual)
    ? '<div class="sc-review-detected">The AI detected: <em>' + r.change_detail + '</em></div>'
    : (isManual
        ? '<div class="sc-review-detected">Describe a permanent change to this ' +
          'character — it will be applied from the chosen moment onward.</div>'
        : '');

  // Reference-image controls - on-image pills: Replace + Archive only.
  // (Regenerate/Retouch now live as a button below the Amended-appearance box.)
  var imgActions = currentImg
    ? '<div class="panel-img-actions">' +
        '<button class="panel-pill" onclick="openReplacePicker(\'character\', ' + charId + ')" title="Replace with an image from the Archive">Replace</button>' +
        '<button class="panel-pill' + (isMomentArchived(r) ? ' is-on' : '') + '" id="sc-archive-' + charId + '" onclick="toggleArchiveCharSnapshot(' + charId + ')" title="' + (isMomentArchived(r) ? 'In your Archive \u2014 click to remove' : 'Save this reference image to your Archive') + '">' + (isMomentArchived(r) ? 'Archived' : 'Archive') + '</button>' +
      '</div>'
    : '<div class="char-prompt-actions" style="margin-top:8px;">' +
        '<button class="btn btn-sm" onclick="openReplacePicker(\'character\', ' + charId + ')">&#8646; Replace from Archive</button>' +
      '</div>';

  card.innerHTML =
    '<div class="sc-review">' +
      '<div class="sc-review-title">' + titleText + '</div>' +
      '<div class="sc-review-name">' + r.name + '</div>' +
      detectedLine +
      '<label class="sc-review-label">Description (this session):</label>' +
      '<textarea class="char-prompt-editor" id="sc-editor-' + charId + '">' + (r.prompt || '') + '</textarea>' +
      '<div class="char-prompt-actions" style="margin-bottom:10px;">' +
        '<button class="btn btn-sm" onclick="saveSnapshot(' + charId + ')">Save description</button>' +
      '</div>' +
      '<label class="sc-review-label">Amended appearance (edit if needed before approving):</label>' +
      '<textarea class="char-prompt-editor" id="sc-review-text-' + charId + '" ' +
        'placeholder="e.g. left horn broken off to a jagged stump">' +
        detailText + '</textarea>' +
      '<div class="sc-review-retouch">' +
        '<button class="btn btn-sm" id="sc-retouch-' + charId + '" ' +
          'onclick="retouchSessionInline(' + charId + ')" ' +
          'title="Apply the amended appearance above to the current reference image \u2014 retouches in place, no pop-up">&#9998; Retouch image</button>' +
      '</div>' +
      '<div class="sc-review-row">' +
        '<div class="sc-review-imgwrap" id="sc-review-imgwrap-' + charId + '">' + imgHtml + imgActions +
        '</div>' +
        '<div class="sc-review-side">' + momentSelector + '</div>' +
      '</div>' +
      '<div class="sc-review-msg" id="sc-review-msg-' + charId + '"></div>' +
      '<div class="char-prompt-actions">' +
        '<button class="btn btn-sm btn-primary" id="sc-approve-' + charId + '" ' +
          'onclick="approveChange(' + charId + ')" ' +
          'title="Lock in this amended appearance from the chosen Moment Panel onward, and carry it into later sessions">&#10003; ' +
          (isAccepted ? 'Save changes' : 'Approve change') + '</button>' +
        '<button class="btn btn-sm" id="sc-reject-' + charId + '" ' +
          'onclick="rejectChange(' + charId + ')" ' +
          'title="Discard this amendment and leave the character unchanged for this session">&#10005; ' +
          (isAccepted ? 'Un-approve' : 'Discard / Ignore') + '</button>' +
        '<button class="btn btn-sm" onclick="loadSessionCharacters()">Cancel</button>' +
      '</div>' +
    '</div>';
}

// Piece 5: regenerate the reference image as a draft. The DM can do
// this repeatedly; the latest draft URL is held until Approve.
function regenerateReference(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-regen-' + charId);
  var textEl = document.getElementById('sc-review-text-' + charId);
  var detail = textEl ? textEl.value : '';
  if (btn) { btn.disabled = true; }
  // Clear any previous status text from the msg area — the spinner over
  // the image carries the activity signal now.
  if (msg) msg.textContent = '';

  // Unified spinner overlay on the existing reference image area. Image
  // stays visible underneath; on refusal/failure the overlay goes away
  // and the original is intact. Cycling status text rides in the sublabel.
  var wrapId = 'sc-review-imgwrap-' + charId;
  showBusyOverlay(wrapId, 'Regenerating', 'Applying the amendment\u2026');

  var steps = [
    'Applying the amendment\u2026',
    'Editing the reference image\u2026',
    'Preserving the character\u2019s identity\u2026',
    'Rendering the new look\u2026',
    'Almost there\u2026'
  ];
  var stepIdx = 0;
  var ticker = setInterval(function() {
    stepIdx++;
    if (stepIdx < steps.length) updateBusyOverlaySublabel(wrapId, steps[stepIdx]);
  }, 4000);

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/regenerate-reference', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ detail: detail })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.job_id) {
        // Async draft: poll the session_ref job. The webhook persists the image
        // to R2 but leaves it a DRAFT (session_characters is written on Approve).
        pollRefJob(data.job_id, function(url) {
          clearInterval(ticker);
          if (btn) { btn.disabled = false; }
          var wrap = document.getElementById(wrapId);
          if (wrap) {
            wrap.innerHTML = '<img src="' + url + '" class="sc-review-img" ' +
              'id="sc-review-img-' + charId + '" alt="reference" />';
          }
          state.draftReference = state.draftReference || {};
          state.draftReference[charId] = url;
          if (msg) msg.textContent = 'New image ready. Regenerate again, or Approve to keep it.';
          if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        }, function(err) {
          clearInterval(ticker);
          if (btn) { btn.disabled = false; }
          hideBusyOverlay(wrapId);
          if (msg) msg.textContent = 'Could not regenerate: ' + err;
        });
        return;
      }
      // No job id => a synchronous error (e.g. insufficient tokens / refusal).
      clearInterval(ticker);
      if (btn) { btn.disabled = false; }
      hideBusyOverlay(wrapId);
      if (data && data.error === 'INSUFFICIENT_TOKENS') {
        if (msg) msg.innerHTML = insufficientTokensHtml(data.message);
      } else if (msg) {
        msg.textContent = (data && data.error) || 'Could not regenerate.';
      }
    })
    .catch(function() {
      clearInterval(ticker);
      hideBusyOverlay(wrapId);
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not regenerate.';
    });
}

// Piece 5: approve the change — locks the draft image + text into this
// session and writes it forward to later sessions.
function approveChange(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-approve-' + charId);
  var textEl = document.getElementById('sc-review-text-' + charId);
  var detail = textEl ? textEl.value : '';
  // The DM's chosen moment index (override of the AI's guess).
  var momentEl = document.getElementById('sc-review-moment-' + charId);
  var momentIndex = momentEl ? parseInt(momentEl.value, 10) : -1;
  if (isNaN(momentIndex) || momentIndex < -1) momentIndex = -1;

  // The image to lock in: a fresh draft if regenerated, otherwise the
  // existing reference (so editing an already-accepted change — e.g.
  // just moving the moment — doesn't force a regenerate).
  var row = (state.sessionCharacterRows || []).find(function(x) { return x.character_id === charId; });
  var existingUrl = row ? (row.reference_url || row.canonical_reference_url) : null;
  var draftUrl = (state.draftReference && state.draftReference[charId]) || existingUrl || null;

  if (!draftUrl) {
    if (msg) msg.textContent = 'Regenerate the image at least once before approving.';
    return;
  }
  if (btn) { btn.disabled = true; }
  if (msg) msg.textContent = 'Saving...';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/approve-change', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ detail: detail, image_url: draftUrl, moment_index: momentIndex })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        if (state.draftReference) delete state.draftReference[charId];
        loadSessionCharacters();
      } else {
        if (btn) { btn.disabled = false; }
        if (msg) msg.textContent = (data && data.error) || 'Could not approve.';
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not approve.';
    });
}

// Reject a detected change — it's not real, or the DM doesn't want it.
// Marks it rejected; re-extraction won't re-flag the SAME change.
function rejectChange(charId) {
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-reject-' + charId);
  if (btn) { btn.disabled = true; }
  if (msg) msg.textContent = 'Rejecting...';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/reject-change', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        loadSessionCharacters();
      } else {
        if (btn) { btn.disabled = false; }
        if (msg) msg.textContent = (data && data.error) || 'Could not reject.';
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; }
      if (msg) msg.textContent = 'Could not reject.';
    });
}

// Scroll a textarea so a character offset is visible. Uses a hidden
// "mirror" div that copies the textarea's exact styling, so we can
// measure where the offset actually lands — reliable with wrapped lines.
function scrollTextareaToOffset(box, offset) {
  try {
    var cs = window.getComputedStyle(box);
    var mirror = document.createElement('div');
    var props = ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
      'textTransform','wordSpacing','paddingTop','paddingRight','paddingBottom',
      'paddingLeft','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'];
    props.forEach(function(p) { mirror.style[p] = cs[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.width = box.clientWidth + 'px';
    mirror.style.boxSizing = 'border-box';
    // Text up to the match, then a marker span at the match position.
    mirror.textContent = box.value.substring(0, offset);
    var marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    var markerTop = marker.offsetTop;
    document.body.removeChild(mirror);
    // Centre the match in the visible area.
    box.scrollTop = Math.max(0, markerTop - box.clientHeight / 2);
  } catch (e) {
    // If anything goes wrong, fail quietly — selection is still set.
  }
}

// Find NEXT — steps through matches one at a time, selecting each.
// Searches the transcript first, then the notes; wraps around.
var _frLastBox = null;
function findNextSession() {
  var findEl = document.getElementById('fr-find');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  if (resultEl) resultEl.textContent = '';
  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var transcript = document.getElementById('transcript-input');
  var notes = document.getElementById('session-notes-input');
  var boxes = [transcript, notes].filter(function(b) { return b; });
  if (!boxes.length) return;

  var startBox = _frLastBox && boxes.indexOf(_frLastBox) !== -1 ? _frLastBox : boxes[0];
  var order = [startBox];
  boxes.forEach(function(b) { if (b !== startBox) order.push(b); });

  var lower = find.toLowerCase();
  for (var i = 0; i < order.length; i++) {
    var box = order[i];
    var from = (box === startBox) ? (box.selectionEnd || 0) : 0;
    var idx = box.value.toLowerCase().indexOf(lower, from);
    if (idx === -1 && box === startBox) {
      idx = box.value.toLowerCase().indexOf(lower, 0);
    }
    if (idx !== -1) {
      box.focus();
      box.setSelectionRange(idx, idx + find.length);
      scrollTextareaToOffset(box, idx);
      _frLastBox = box;
      if (resultEl) resultEl.textContent = 'Found in ' +
        (box === transcript ? 'transcript' : 'notes') + '.';
      return;
    }
  }
  _frLastBox = null;
  if (resultEl) resultEl.textContent = 'No matches found.';
}

// Replace just the currently-highlighted match, then advance to the next.
function replaceOneSession() {
  var findEl = document.getElementById('fr-find');
  var replEl = document.getElementById('fr-replace');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  var repl = replEl ? replEl.value : '';
  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var box = _frLastBox;
  // If the current selection matches the find text, replace it; then find next.
  if (box) {
    var selStart = box.selectionStart;
    var selEnd = box.selectionEnd;
    var selected = box.value.substring(selStart, selEnd);
    if (selected.toLowerCase() === find.toLowerCase()) {
      box.value = box.value.substring(0, selStart) + repl + box.value.substring(selEnd);
      // Put the cursor right after the replacement so Find next moves on.
      box.setSelectionRange(selStart + repl.length, selStart + repl.length);
      if (resultEl) resultEl.textContent = 'Replaced one.';
      findNextSession();
      return;
    }
  }
  // Nothing suitable selected — just jump to the next match first.
  findNextSession();
}

// Find & replace across BOTH the transcript and the session notes at once.
// Use case: a character's name is wrong throughout — fix it in one shot.
function findReplaceSession() {
  var findEl = document.getElementById('fr-find');
  var replEl = document.getElementById('fr-replace');
  var resultEl = document.getElementById('fr-result');
  var find = findEl ? findEl.value : '';
  var repl = replEl ? replEl.value : '';
  if (resultEl) resultEl.textContent = '';

  if (!find) {
    if (resultEl) resultEl.textContent = 'Enter text to find.';
    return;
  }

  var transcript = document.getElementById('transcript-input');
  var notes = document.getElementById('session-notes-input');

  // Escape regex special chars so the find text is treated literally.
  var safe = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var rx = new RegExp(safe, 'g');

  var count = 0;
  [transcript, notes].forEach(function(box) {
    if (!box || !box.value) return;
    var matches = box.value.match(rx);
    if (matches) {
      count += matches.length;
      box.value = box.value.replace(rx, repl);
    }
  });

  if (resultEl) {
    resultEl.textContent = count === 0
      ? 'No matches found.'
      : 'Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's') + '. Click Generate Story to save.';
  }
}


// ============================================================
// REVIEW TAB — storyboard outline + per-panel matched characters/assets
// ============================================================
function loadReview() {
  var empty = document.getElementById('review-empty');
  var content = document.getElementById('review-content');
  var list = document.getElementById('review-list');
  if (list) list.innerHTML = '<div class="form-hint">Loading review...</div>';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/review' + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var panels = (data && data.panels) || [];
      if (!panels.length) {
        if (empty) empty.style.display = 'block';
        if (content) content.style.display = 'none';
        return;
      }
      if (empty) empty.style.display = 'none';
      if (content) content.style.display = 'block';
      renderReview(data);
    })
    .catch(function() {
      if (list) list.innerHTML = '<div class="alert alert-error">Could not load the review.</div>';
    });
}

function escapeHtmlReview(s) {
  return String(s || '').replace(/[&<>]/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

// Render the Review tab as the actual READING ORDER of the finished comic:
// opening narrative → panel → bridge narrative → panel → bridge → ... → closing.
// All narrative text shown is a TERSE SUMMARY (~10–25 words) of the actual
// prose — the storyboard and graphic novel show the real text. Old
// sessions (generated before summaries existed) fall back to truncated
// prose, so the tab never goes blank.
function renderReview(data) {
  var list = document.getElementById('review-list');
  if (!list) return;
  var ASSET_CAT = { location: 'Location', npc: 'NPC', item: 'Item' };
  var panels = (data && data.panels) || [];
  state.reviewData = data || {};
  state.narrativeDirections = (data && data.directions) || {};

  // Who may steer/edit this version's narrative (same rule as the Storyboard
  // Regen): the DM on canonical, or a player on their OWN version.
  var _nRole = state.currentCampaign && state.currentCampaign.my_role;
  var canEditNarr = (_nRole === 'dm' && !state.currentForkId) ||
    ((_nRole === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId)));

  // Outline fallback for legacy versions that stored prose, not an outline.
  function fallback(text, words) {
    if (!text) return '';
    var w = String(text).trim().split(/\s+/);
    if (w.length <= words) return w.join(' ');
    return w.slice(0, words).join(' ') + '\u2026';
  }
  var intro = (data && data.intro_summary) || fallback(data && data.intro, 25);
  var outro = (data && data.outro_summary) || fallback(data && data.outro, 25);

  // A steerable narrative row: shows the outline (what the prose WILL say)
  // plus a Direction pill that lights gold when a direction has been set.
  function narrRow(gapKey, label, text, cls) {
    var hasDir = !!(state.narrativeDirections && state.narrativeDirections[gapKey]);
    var safeLabel = escapeHtmlReview(label);
    var btn = canEditNarr
      ? '<button class="review-dir-btn' + (hasDir ? ' is-on' : '') + '" ' +
        'onclick="openNarrDirection(\'' + gapKey + '\', \'' + safeLabel + '\')" ' +
        'title="' + (hasDir ? 'Narrative direction set - click to edit' : 'Steer the prose for this gap') + '">' +
        '\u270E Direction' + (hasDir ? ' \u2713' : '') + '</button>'
      : '';
    var body = text
      ? '<div class="review-nar-text">' + escapeHtmlReview(text) + '</div>'
      : '<div class="review-nar-text review-nar-empty">No outline yet - prose will be generated for this gap.</div>';
    return '<div class="review-nar ' + cls + '">' +
      '<div class="review-nar-head"><div class="review-nar-label">' + safeLabel + '</div>' + btn + '</div>' +
      body +
    '</div>';
  }

  var html = '';
  html += narrRow('opening', 'Opening', intro, 'review-nar-open');

  panels.forEach(function(p, i) {
    var num = (typeof p.panel_order === 'number' ? p.panel_order : i) + 1;
    var mid = p.moment_id;

    // Character chips — each carries an id; × removes when editable.
    var charChips = (p.characters || []).map(function(c) {
      var rm = canEditNarr
        ? '<button class="review-chip-x" title="Remove" onclick="castRemoveCharacter(' + mid + ', ' + c.id + ')">\u00d7</button>'
        : '';
      return '<span class="review-chip">' + escapeHtmlReview(c.name) + rm + '</span>';
    }).join('');
    if (!(p.characters || []).length) charChips = '<span class="review-none">none</span>';

    var assetChips = (p.assets || []).map(function(a) {
      var rm = canEditNarr
        ? '<button class="review-chip-x" title="Remove" onclick="castRemoveAsset(' + mid + ', ' + a.id + ')">\u00d7</button>'
        : '';
      return '<span class="review-chip review-chip-asset">' +
        escapeHtmlReview(a.name) + ' \u00b7 ' + (ASSET_CAT[a.category] || a.category) + rm + '</span>';
    }).join('');
    if (!(p.assets || []).length) assetChips = '<span class="review-none">none</span>';

    // "+ Add" dropdowns — campaign characters/assets not already on the panel.
    var addChar = '', addAsset = '';
    if (canEditNarr) {
      var haveC = {}; (p.characters || []).forEach(function(c){ haveC[String(c.id)] = true; });
      var optsC = (state.reviewData.all_characters || []).filter(function(c){ return !haveC[String(c.id)]; })
        .map(function(c){ return '<option value="' + c.id + '">' + escapeHtmlReview(c.name) + '</option>'; }).join('');
      addChar = '<select class="review-add-select" onchange="castAddCharacter(' + mid + ', this)">' +
        '<option value="">+ Add character</option>' + optsC + '</select>';
      var haveA = {}; (p.assets || []).forEach(function(a){ haveA[String(a.id)] = true; });
      var optsA = (state.reviewData.all_assets || []).filter(function(a){ return !haveA[String(a.id)]; })
        .map(function(a){ return '<option value="' + a.id + '">' + escapeHtmlReview(a.name) + ' \u00b7 ' + (ASSET_CAT[a.category] || a.category) + '</option>'; }).join('');
      addAsset = '<select class="review-add-select" onchange="castAddAsset(' + mid + ', this)">' +
        '<option value="">+ Add asset</option>' + optsA + '</select>';
    }

    // Auto vs Custom indicator + reset-to-auto (only when explicit + editable).
    var castBadge = p.cast_explicit
      ? '<span class="review-cast-badge is-custom">Custom cast</span>'
      : '<span class="review-cast-badge">Auto-matched</span>';
    var resetBtn = (canEditNarr && p.cast_explicit)
      ? '<button class="review-reset-btn" onclick="castReset(' + mid + ')" title="Drop back to automatic name-matching">Reset to auto</button>'
      : '';

    // Change marker (folded-in): which characters' look changes at THIS panel.
    var changeNote = (p.change_marks && p.change_marks.length)
      ? '<div class="review-change-mark" title="A character appearance change takes effect here">\u2726 ' +
          escapeHtmlReview(p.change_marks.join(', ')) +
          (p.change_marks.length === 1 ? '\u2019 look changes here' : ' \u2014 looks change here') + '</div>'
      : '';

    html += '<div class="review-panel">' +
      '<div class="review-panel-head">' +
        '<span class="review-panel-num">' + num + '</span>' +
        '<span class="review-panel-title">' + escapeHtmlReview(p.title || 'Untitled panel') + '</span>' +
        castBadge + resetBtn +
      '</div>' +
      (p.moment ? '<div class="review-nar-text" style="margin-bottom:4px;">' + escapeHtmlReview(p.moment) + '</div>' : '') +
      (p.snippet ? '<div class="review-snippet">' + escapeHtmlReview(p.snippet) + '</div>' : '') +
      changeNote +
      '<div class="review-row"><span class="review-label">Characters:</span> ' + charChips + ' ' + addChar + '</div>' +
      '<div class="review-row"><span class="review-label">Assets:</span> ' + assetChips + ' ' + addAsset + '</div>' +
    '</div>';

    // Bridge gap AFTER this panel (the last gap is covered by the closing).
    if (i < panels.length - 1) {
      html += narrRow('between:' + i, 'Panel ' + num + ' \u2192 ' + (num + 1), p.bridge || '', 'review-nar-bridge');
    }
  });

  html += narrRow('closing', 'Closing', outro, 'review-nar-close');

  list.innerHTML = html;
}

// ============================================================
// Pass 2 — per-panel casting edits (Review tab). Each edit mutates the
// in-memory review payload, flips the panel to "Custom", and PUTs the full
// cast set (materialize-on-first-edit). Owner-gated server-side too.
// ============================================================
function _reviewPanel(momentId) {
  var panels = (state.reviewData && state.reviewData.panels) || [];
  return panels.find(function(p){ return String(p.moment_id) === String(momentId); });
}
function _saveCast(p) {
  var characterIds = (p.characters || []).map(function(c){ return c.id; }).filter(function(x){ return x != null; });
  var assetIds = (p.assets || []).map(function(a){ return a.id; }).filter(function(x){ return x != null; });
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/moments/' + p.moment_id + '/cast', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ characterIds: characterIds, assetIds: assetIds })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data.error) { showAlert('Could not save casting: ' + data.error); loadReview(); return; }
    renderReview(state.reviewData);   // reflect Custom badge + updated chips
  })
  .catch(function(e){ showAlert('Could not save casting: ' + e.message); loadReview(); });
}
function castAddCharacter(momentId, sel) {
  var id = parseInt(sel.value, 10); if (!id) return;
  var p = _reviewPanel(momentId); if (!p) return;
  var name = '';
  (state.reviewData.all_characters || []).some(function(c){ if (String(c.id) === String(id)) { name = c.name; return true; } return false; });
  p.characters = p.characters || [];
  if (!p.characters.some(function(c){ return String(c.id) === String(id); })) p.characters.push({ id: id, name: name });
  p.cast_explicit = true;
  _saveCast(p);
}
function castRemoveCharacter(momentId, charId) {
  var p = _reviewPanel(momentId); if (!p) return;
  p.characters = (p.characters || []).filter(function(c){ return String(c.id) !== String(charId); });
  p.cast_explicit = true;
  _saveCast(p);
}
function castAddAsset(momentId, sel) {
  var id = parseInt(sel.value, 10); if (!id) return;
  var p = _reviewPanel(momentId); if (!p) return;
  var meta = null;
  (state.reviewData.all_assets || []).some(function(a){ if (String(a.id) === String(id)) { meta = a; return true; } return false; });
  p.assets = p.assets || [];
  if (!p.assets.some(function(a){ return String(a.id) === String(id); })) p.assets.push({ id: id, name: meta ? meta.name : '', category: meta ? meta.category : '' });
  p.cast_explicit = true;
  _saveCast(p);
}
function castRemoveAsset(momentId, assetId) {
  var p = _reviewPanel(momentId); if (!p) return;
  p.assets = (p.assets || []).filter(function(a){ return String(a.id) !== String(assetId); });
  p.cast_explicit = true;
  _saveCast(p);
}
function castReset(momentId) {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/moments/' + momentId + '/cast', {
    method: 'DELETE'
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data.error) { showAlert('Could not reset casting: ' + data.error); return; }
    loadReview();   // re-fetch so the auto (name-match) cast comes back
  })
  .catch(function(e){ showAlert('Could not reset casting: ' + e.message); });
}


// "Generate Storyboard Images" from the Review tab. The generation flow
// (progress bar, panel shimmer) lives on the Storyboard tab and targets
// its DOM — so switch there first, then run the same generate-all.
function generateFromReview() {
  switchSessionTab('storyboard');
  // Let the storyboard pane render before the generation code touches it.
  setTimeout(function() {
    if (typeof generateAllImages === 'function') generateAllImages();
  }, 60);
}

// ============================================================
// Per-gap narrative DIRECTION modal (Pass 1)
// Mirrors the Retouch modal: open (prefill), close, save.
// state.narrDirGap holds the gap key currently being edited
// ('opening' | 'between:<i>' | 'closing').
// ============================================================
function openNarrDirection(gapKey, label) {
  state.narrDirGap = gapKey;
  var titleEl = document.getElementById('narr-direction-title');
  if (titleEl) titleEl.textContent = 'Narrative direction \u2014 ' + (label || 'gap');
  var ta = document.getElementById('narr-direction-text');
  var cur = (state.narrativeDirections && state.narrativeDirections[gapKey]) || '';
  if (ta) ta.value = cur;
  var modal = document.getElementById('narr-direction-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

function closeNarrDirection() {
  var modal = document.getElementById('narr-direction-modal');
  if (modal) modal.classList.add('hidden');
}

function saveNarrDirection() {
  var gapKey = state.narrDirGap;
  if (!gapKey) { closeNarrDirection(); return; }
  var ta = document.getElementById('narr-direction-text');
  var text = ta ? ta.value.trim() : '';
  fetch('/api/narrative/direction/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ gap: gapKey, text: text })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data.error) { showAlert('Could not save direction: ' + data.error); return; }
    state.narrativeDirections = data.directions || {};
    closeNarrDirection();
    refreshNarrativeDirectionUI(gapKey);
  })
  .catch(function(e){ showAlert('Could not save direction: ' + e.message); });
}

// Refresh the surfaces that show a gap's Direction after it's saved, WITHOUT
// clobbering in-progress prose edits. The Review tab re-renders its pills (no
// editable prose there); the Storyboard updates just that one gap's "prompt"
// block in place rather than re-rendering the whole board.
function refreshNarrativeDirectionUI(gapKey) {
  var reviewPane = document.getElementById('session-tab-review');
  if (reviewPane && reviewPane.style.display !== 'none' && typeof loadReview === 'function') {
    loadReview();
  }
  var sbPane = document.getElementById('session-tab-storyboard');
  if (sbPane && sbPane.style.display !== 'none') {
    var domKey = gapKey.replace(/[^a-z0-9]/gi, '-');
    var txt = (state.narrativeDirections && state.narrativeDirections[gapKey]) || '';
    var el = document.getElementById('narr-dir-text-' + domKey);
    if (el) {
      el.textContent = txt || 'No direction set \u2014 using the default narrative style.';
      if (txt) el.classList.remove('narr-dir-empty');
      else el.classList.add('narr-dir-empty');
    }
  }
}

// ============================================================
// STYLE PICKER (Narrative Styles) — shared dialog of style cards.
// Step 2 wires the NARRATIVE side; the art side is added in Step 3.
// NARR_STYLE_META is the client display list (name/desc/example); its ids
// MUST match the server-side NARRATIVE_STYLES keys in routes/narrative.js.
// ============================================================
var NARR_STYLE_META = [
  { id:'classic', name:'Classic', desc:'Vivid, dramatic graphic-novel narration in present tense \u2014 the default Chronicle voice.', example:'Torchlight trembles against the cavern wall as the party edges forward, every breath held, every shadow a possible threat.' },
  { id:'epic', name:'Epic Chronicle', desc:'Mythic, poetic, and sweeping \u2014 a legendary saga recorded by ancient historians.', example:'Thus the companions pressed onward, their footsteps echoing through the hollow places of the world, unaware that fate watched them with patient eyes.' },
  { id:'journal', name:"Adventurer's Journal", desc:'Personal and grounded, with dry humor, like an adventurer\u2019s diary. May use first person.', example:'We thought the forest would be quiet after the fight. Turns out the turnips were louder than the monsters.' },
  { id:'cinematic', name:'Cinematic Script', desc:'Visual, fast, and minimal. Short punchy sentences describing what the camera sees.', example:'The torchlight flickers. Shadows stretch across the stone. Ruk stumbles, pale and shaking, as the shriek fades into the dark.' },
  { id:'lorekeeper', name:'Lorekeeper / Historian', desc:'Scholarly and mysterious \u2014 formal, slightly archaic, recorded by an in-world historian.', example:'In the annals of the Third Era, the incident of the SoupMaster is noted with both caution and curiosity.' },
  { id:'noir', name:'Noir', desc:'Gritty, moody, cynical fantasy-noir. Hard-boiled phrasing, shadows, and suspicion.', example:'The cave breathed cold air like a liar exhaling excuses, and the torchlight wasn\u2019t bright enough to chase off the truth.' },
  { id:'grim', name:'Dark Fantasy / Grim', desc:'Bleak, heavy, and visceral. Dread, decay, and the cost of every choice.', example:'Blood soaked into the stone, vanishing as if the earth itself were thirsty. Even hope felt like a dying ember.' },
  { id:'storybook', name:"Children's Storybook", desc:'Whimsical, gentle, and playful \u2014 warm language and a sense of wonder.', example:'And so the brave friends tip-toed into the twinkly cave, where shadows danced like shy little creatures.' },
  { id:'anime', name:'High-Drama Anime', desc:'Intense, emotional, and heroic. Heightened emotion and dynamic, expressive action.', example:'Ruk\u2019s heartbeat thundered like a war drum as the darkness closed in \u2014 but his spirit refused to fall.' }
];
var STYLE_PICKER_KIND = null;

function narrStyleName(id) {
  for (var i = 0; i < NARR_STYLE_META.length; i++) { if (NARR_STYLE_META[i].id === id) return NARR_STYLE_META[i].name; }
  return 'Classic';
}

function refreshNarrStyleButtons() {
  var id = state.narrativeStyle ? state.narrativeStyle : 'classic';
  var label = 'Narrative: ' + narrStyleName(id);
  ['review-narr-style-btn', 'sb-narr-style-btn'].forEach(function(bid) {
    var b = document.getElementById(bid);
    if (b) b.textContent = label;
  });
}

// Fetch the caller's EFFECTIVE tier + style locks for the current campaign so
// the style pickers can show locked styles as visible-but-unselectable. Fails
// open in the UI (the server still enforces on every set/generate).
function loadTierInfo(campaignId) {
  if (!campaignId) return;
  fetch('/api/campaigns/' + campaignId + '/tier-info')
    .then(function (r) { return r.json(); })
    .then(function (d) { state.tierInfo = d || null; })
    .catch(function () { state.tierInfo = null; });
}

// Apply a finished regenerated image to its panel and refresh the views.
function applyRegenResult(momentId, imageUrl) {
  var moment = state.moments.find(function(m) { return m.id === momentId; });
  if (moment) { moment.image = imageUrl; moment.archived = false; }
  if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
  renderStoryboard();
  renderNovelWithImages();
}

// Poll an async image job until done/failed. The panel keeps its busy overlay
// meanwhile, so the user can look away and the image just lands when ready.
function pollImageJob(jobId, momentId) {
  var started = Date.now();
  var MAX_MS = 6 * 60 * 1000;
  var INTERVAL = 4000;
  function tick() {
    fetch('/api/images/jobs/' + jobId)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j || j.error) {
          if (Date.now() - started > MAX_MS) { showPanelError(momentId, 'Could not regenerate: ' + ((j && j.error) || 'timed out')); return; }
          setTimeout(tick, INTERVAL); return;
        }
        if (j.status === 'done' && j.image_url) { applyRegenResult(momentId, j.image_url); return; }
        if (j.status === 'failed') {
          if (j.error === 'INSUFFICIENT_TOKENS') showPanelError(momentId, insufficientTokensHtml(j.message || 'You are out of tokens.'), true);
          else showPanelError(momentId, 'Could not regenerate: ' + (j.error || 'generation failed'));
          return;
        }
        if (Date.now() - started > MAX_MS) { showPanelError(momentId, 'Still working \u2014 the image will appear here when it is ready.'); return; }
        setTimeout(tick, INTERVAL);
      })
      .catch(function(e) {
        if (Date.now() - started > MAX_MS) { showPanelError(momentId, 'Could not regenerate: ' + e.message); return; }
        setTimeout(tick, INTERVAL);
      });
  }
  setTimeout(tick, INTERVAL);
}

// Poll a batch of async image jobs (generate-all) to completion, driving the
// progress bar. Panels keep their busy overlays; finished images appear via a
// single refresh at the end (avoids clobbering still-pending panels mid-batch).
function pollImageBatch(jobs, meta) {
  meta = meta || {};
  var btn = document.getElementById('generate-all-btn');
  var progressWrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var msg = document.getElementById('gen-progress-msg');
  var total = jobs.length;
  var done = 0, failed = 0;
  var pending = jobs.map(function(j) { return j.job_id; });
  var started = Date.now();
  var MAX_MS = 12 * 60 * 1000;
  var INTERVAL = 4000;
  function reset() {
    setTimeout(function() {
      if (btn) btn.disabled = false;
      if (progressWrap) progressWrap.style.display = 'none';
      if (fill) fill.style.width = '0%';
    }, 2000);
  }
  function finalize() {
    if (fill) fill.style.width = '100%';
    var t = done + ' image' + (done === 1 ? '' : 's') + ' generated';
    if (meta.skipped_locked) t += ' (' + meta.skipped_locked + ' locked skipped)';
    if (failed) t += ', ' + failed + ' failed';
    if (msg) msg.textContent = t + '!';
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    refreshStoryboardImages();
    reset();
  }
  function tick() {
    if (!pending.length) { finalize(); return; }
    if (Date.now() - started > MAX_MS) {
      if (msg) msg.textContent = 'Still working \u2014 remaining panels will appear when ready.';
      refreshStoryboardImages();
      reset();
      return;
    }
    fetch('/api/images/jobs-status?ids=' + pending.join(','))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var rows = (data && data.jobs) || [];
        rows.forEach(function(j) {
          if (j.status === 'done') { if (pending.indexOf(j.id) !== -1) { done++; pending = pending.filter(function(x) { return x !== j.id; }); } }
          else if (j.status === 'failed') { if (pending.indexOf(j.id) !== -1) { failed++; pending = pending.filter(function(x) { return x !== j.id; }); } }
        });
        var fin = done + failed;
        if (fill) fill.style.width = Math.max(5, total ? Math.round((fin / total) * 100) : 100) + '%';
        if (msg) msg.textContent = fin + ' of ' + total + ' done' + (failed ? ' (' + failed + ' failed)' : '') + '\u2026';
        if (!pending.length) finalize(); else setTimeout(tick, INTERVAL);
      })
      .catch(function() { setTimeout(tick, INTERVAL); });
  }
  tick();
}

// ---- Phase 3: async character reference polling ----
function pollRefJob(jobId, onDone, onFail) {
  var started = Date.now();
  var MAX_MS = 6 * 60 * 1000;
  var INTERVAL = 4000;
  function tick() {
    fetch('/api/images/jobs/' + jobId)
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!j || j.error) {
          if (Date.now() - started > MAX_MS) { onFail((j && j.error) || 'timed out'); return; }
          setTimeout(tick, INTERVAL); return;
        }
        if (j.status === 'done' && j.image_url) { onDone(j.image_url); return; }
        if (j.status === 'failed') { onFail(j.error || 'generation failed'); return; }
        if (Date.now() - started > MAX_MS) { onFail('timed out'); return; }
        setTimeout(tick, INTERVAL);
      })
      .catch(function(e) {
        if (Date.now() - started > MAX_MS) { onFail(e.message); return; }
        setTimeout(tick, INTERVAL);
      });
  }
  setTimeout(tick, INTERVAL);
}

function applyCanonicalRef(charId, url) {
  var ch = (state.characters || []).find(function(c) { return c.id === charId; });
  if (ch) { ch.canonical_reference_url = url; ch.archived = false; renderCharModalPrompt(ch); }
  if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
}

function applySessionRefDraft(charId, url, wrapId, msg) {
  var wrap = document.getElementById(wrapId);
  if (wrap) { wrap.innerHTML = '<img src="' + url + '" class="sc-review-img" id="sc-review-img-' + charId + '" alt="reference" />'; }
  state.draftReference = state.draftReference || {};
  state.draftReference[charId] = url;
  if (msg) msg.textContent = 'New image ready. Regenerate again, or Approve to keep it.';
  if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
}

function openStylePicker(kind) {
  STYLE_PICKER_KIND = kind || 'narrative';
  var titleEl = document.getElementById('style-picker-title');
  var grid = document.getElementById('style-picker-grid');
  if (!grid) return;
  var cur, meta;
  if (STYLE_PICKER_KIND === 'narrative') {
    if (titleEl) titleEl.textContent = 'Choose a narrative style';
    cur = state.narrativeStyle ? state.narrativeStyle : 'classic';
    meta = NARR_STYLE_META;
  } else if (STYLE_PICKER_KIND === 'art') {
    if (titleEl) titleEl.textContent = 'Choose an art style';
    cur = state.artStyle ? state.artStyle : 'High fantasy illustration';
    meta = ART_STYLE_META;
  } else if (STYLE_PICKER_KIND === 'layout') {
    if (titleEl) titleEl.textContent = 'Choose a layout';
    cur = normalizeLayoutId(state.layoutStyle || 'Classic');
    meta = LAYOUT_STYLE_META;
  } else if (STYLE_PICKER_KIND === 'novel-layout') {
    if (titleEl) titleEl.textContent = 'Choose a layout';
    cur = normalizeLayoutId((typeof novelLayoutStyle !== 'undefined' && novelLayoutStyle) ? novelLayoutStyle : 'Classic');
    meta = LAYOUT_STYLE_META;
  } else { return; }
  var _subEl = document.getElementById('style-picker-sub');
  if (_subEl) {
    _subEl.textContent =
      (STYLE_PICKER_KIND === 'art') ? 'Pick the art style for this version. It applies to new image generations; change it any time.' :
      (STYLE_PICKER_KIND === 'narrative') ? 'Pick the narrative voice for this version. It applies whenever the narrative is generated or regenerated; change it any time.' :
      'Pick the page layout. The preview updates when you choose; change it any time.';
  }
  grid.innerHTML = meta.map(function(s) {
    var TLABEL = {2:'Silver',3:'Gold',4:'Platinum'};
    var _locks = (STYLE_PICKER_KIND === 'art') ? (state.tierInfo && state.tierInfo.art_locks) : (STYLE_PICKER_KIND === 'narrative') ? (state.tierInfo && state.tierInfo.narrative_locks) : null;
    var _eff = (state.tierInfo && state.tierInfo.effective_rank) || 99;
    var _min = (_locks && _locks[s.id]) || 1;
    var _locked = _min > _eff;
    var on = _locked ? ' is-locked' : ((s.id === cur) ? ' is-selected' : '');
    var badge = (!_locked && s.id === cur) ? ' <span class="style-card-current">\u2713 current</span>' : '';
    if (_locked) badge = ' <span class="style-card-current" style="background:#6b7280;">' + (TLABEL[_min] || 'Upgrade') + ' only</span>';
    var eg = s.example ? ('<div class="style-card-eg">' + escapeHtml(s.example) + '</div>') : '';
    return '<div class="style-card' + on + '" onclick="selectStyleCard(\'' + STYLE_PICKER_KIND + '\',\'' + s.id + '\')">' +
      '<div class="style-card-name">' + escapeHtml(s.name) + badge + '</div>' +
      '<div class="style-card-desc">' + escapeHtml(s.desc) + '</div>' +
      eg +
      '</div>';
  }).join('');
  var modal = document.getElementById('style-picker-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeStylePicker() {
  var modal = document.getElementById('style-picker-modal');
  if (modal) modal.classList.add('hidden');
}

function selectStyleCard(kind, id) {
  if (kind === 'narrative') {
    if (!state.currentCampaign || !state.currentSession) { closeStylePicker(); return; }
    fetch('/api/narrative/style/' + state.currentCampaign.id + '/' + state.currentSession.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: id })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showAlert('Could not set narrative style: ' + data.error); return; }
      state.narrativeStyle = data.style || id;
      refreshNarrStyleButtons();
      closeStylePicker();
    })
    .catch(function(e) { showAlert('Could not set narrative style: ' + e.message); });
  } else if (kind === 'art') {
    state.artStyle = id;
    if (state.currentSession && state.currentCampaign) {
      // Smart endpoint: DM -> session canonical art_style; player -> their own
      // fork's art_style_override (per-version, never touches canon).
      fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/art-style', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ art_style: id })
      }).catch(function () {});
    }
    refreshArtStyleButtons();
    closeStylePicker();
  } else if (kind === 'layout') {
    state.layoutStyle = id;
    customActive.session = false;
    saveCustomLayoutPrefs();
    if (state.currentSession && state.currentCampaign) {
      fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout_style: id })
      }).catch(function () {});
    }
    if (typeof loadPreview === 'function') loadPreview(id);
    refreshLayoutStyleButtons();
    closeStylePicker();
  } else if (kind === 'novel-layout') {
    novelLayoutStyle = id;
    customActive.novel = false;
    saveCustomLayoutPrefs();
    if (typeof loadNovelPreview === 'function') loadNovelPreview(id);
    refreshLayoutStyleButtons();
    closeStylePicker();
  }
}

// ---- Art Styles (shared picker; mirrors selStyle's session persistence) ----
var ART_STYLE_META = [
  { id:'High fantasy illustration', name:'High fantasy', desc:'Rich, painterly high-fantasy illustration \u2014 the Chronicle default.' },
  { id:'Dark gritty comic book', name:'Dark and gritty', desc:'Heavy ink and deep shadow, a gritty comic-book tone.' },
  { id:'Watercolor painterly', name:'Watercolor', desc:'Soft, painterly watercolor washes and loose edges.' },
  { id:'Anime manga style', name:'Anime / manga', desc:'Clean anime / manga linework with expressive shading.' },
  { id:'Classic pen and ink', name:'Pen and ink', desc:'Classic black-and-white pen-and-ink line art.' },
  { id:'Fantasy oil painting', name:'Fantasy oil', desc:'Rich, saturated oil-paint cover art \u2014 heroic and dramatic, with painterly brushwork and soft, borderless edges.' },
  { id:'Comic book cel-shaded', name:'Cel-shaded', desc:'Thick ink outlines and hard cel-shaded shadow blocks; bold, hand-painted graphic-novel look.' },
  { id:'Fantasy pastel', name:'Fantasy pastel', desc:'Soft, dreamy pastel and watercolor blend with glowing highlights and gentle, feathered edges.' },
  { id:'Charcoal drawing', name:'Charcoal', desc:'Traditional charcoal on rough paper \u2014 deep blacks, smudged mid-tones, and bold, expressive shadows.' }
];

function artStyleName(v) {
  for (var i = 0; i < ART_STYLE_META.length; i++) { if (ART_STYLE_META[i].id === v) return ART_STYLE_META[i].name; }
  return v || 'High fantasy';
}

function refreshArtStyleButtons() {
  var v = state.artStyle ? state.artStyle : 'High fantasy illustration';
  var label = 'Art: ' + artStyleName(v);
  ['review-art-style-btn', 'sb-art-style-btn'].forEach(function (bid) {
    var b = document.getElementById(bid);
    if (b) b.textContent = label;
  });
}

// Was referenced on session load but never defined (a no-op). Now it sets the
// art style from the session's saved value and refreshes the Art buttons so the
// label is truthful for the session being opened.
function loadLastArtStyle(artStyle, layoutStyle) {
  if (artStyle) state.artStyle = artStyle;
  else if (!state.artStyle) state.artStyle = 'High fantasy illustration';
  if (layoutStyle && !state.layoutStyle) state.layoutStyle = layoutStyle;
  refreshArtStyleButtons();
  refreshLayoutStyleButtons();
}

// ============================================================
// "Generate Narrative & Images" (Pass 1) — the commit point on the Review tab.
// Generates the narrative prose ONCE (honoring per-gap directions + Session
// Notes), then runs image generation. The narrative is produced for the first
// time here, so it reflects the casting and directions set on the Review tab.
// ============================================================
function generateNarrativeAndImages() {
  var btn = document.getElementById('review-generate-btn');
  var origLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Writing narrative\u2026'; }

  // Progress bar on the Review tab for the narrative-writing phase. The call
  // duration is unknown (one LLM pass), so ease the bar toward ~90% and snap
  // to 100% on success, then hand off to the Storyboard image bar.
  var wrap = document.getElementById('review-progress-wrap');
  var fill = document.getElementById('review-progress-fill');
  var pmsg = document.getElementById('review-progress-msg');
  var pct = 0;
  if (wrap) wrap.style.display = 'block';
  if (fill) fill.style.width = '0%';
  if (pmsg) pmsg.textContent = 'Writing your narrative\u2026';
  var _nctl = new AbortController();
  state.abortNarr = _nctl;
  var _ncb = document.getElementById('narr-cancel-btn'); if (_ncb) _ncb.style.display = 'inline-block';
  var ticker = setInterval(function() {
    pct = Math.min(90, pct + Math.max(1, (90 - pct) * 0.12));
    if (fill) fill.style.width = pct.toFixed(0) + '%';
  }, 400);
  function endBar(done) {
    clearInterval(ticker);
    var _ncb = document.getElementById('narr-cancel-btn'); if (_ncb) _ncb.style.display = 'none';
    if (done && fill) fill.style.width = '100%';
    setTimeout(function() {
      if (wrap) wrap.style.display = 'none';
      if (fill) fill.style.width = '0%';
    }, done ? 350 : 0);
  }

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id + forkQ(), {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ key: getApiKey() || 'platform' }),
    signal: _nctl.signal
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    if (data.error) { endBar(false); showAlert('Could not generate narrative: ' + data.error); return; }
    if (pmsg) pmsg.textContent = 'Narrative ready \u2014 starting images\u2026';
    endBar(true);
    state.narrativeData = {
      intro: data.intro || '',
      sections: data.sections || [],
      outro: data.outro || ''
    };
    state.narrativeStyleUsed = state.narrativeStyle || 'classic';
    // Paint the narrative into the storyboard right away so the user can start
    // reading each panel's prose while the images are still being generated.
    switchSessionTab('storyboard');
    if (typeof renderStoryboard === 'function') renderStoryboard();
    // Hand off to image generation — it overlays per-panel busy spinners on the
    // image areas; the narrative text stays readable underneath while they run.
    setTimeout(function() {
      if (typeof generateAllImages === 'function') generateAllImages();
    }, 60);
  })
  .catch(function(e){
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    endBar(false);
    if (e && e.name === 'AbortError') return;
    showAlert('Could not generate narrative: ' + e.message);
  });
}

function cancelExtract() {
  if (state.abortExtract) { try { state.abortExtract.abort(); } catch (e) {} }
  var w = document.getElementById('progress-wrap'); if (w) w.style.display = 'none';
  var c = document.getElementById('extract-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('extract-btn'); if (b) b.disabled = false;
}

function cancelGenAll() {
  if (state.abortGenAll) { try { state.abortGenAll.abort(); } catch (e) {} }
  if (typeof hideAllPanelBusy === 'function') hideAllPanelBusy();
  var w = document.getElementById('generate-progress'); if (w) w.style.display = 'none';
  var c = document.getElementById('genall-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('generate-all-btn'); if (b) b.disabled = false;
}

function cancelNarr() {
  if (state.abortNarr) { try { state.abortNarr.abort(); } catch (e) {} }
  var w = document.getElementById('review-progress-wrap'); if (w) w.style.display = 'none';
  var c = document.getElementById('narr-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('review-generate-btn'); if (b) b.disabled = false;
}

// Generate the narrative ONLY (no images). Same narrative pass as the combined
// button, but it stops after painting the prose into the panels. Lets you
// rewrite the story without regenerating art / spending image tokens.
function generateNarrativeOnly() {
  var btn = document.getElementById('sb-generate-narr-btn');
  var origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Writing narrative\u2026'; }
  var wrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var pmsg = document.getElementById('gen-progress-msg');
  var pct = 0;
  if (wrap) wrap.style.display = 'block';
  if (fill) fill.style.width = '0%';
  if (pmsg) pmsg.textContent = 'Writing your narrative\u2026';
  var _nctl = new AbortController();
  state.abortNarrOnly = _nctl;
  var _cb = document.getElementById('sb-narr-cancel-btn'); if (_cb) _cb.style.display = 'inline-block';
  var ticker = setInterval(function () {
    pct = Math.min(90, pct + Math.max(1, (90 - pct) * 0.12));
    if (fill) fill.style.width = pct.toFixed(0) + '%';
  }, 400);
  function endBar(done) {
    clearInterval(ticker);
    var _cb = document.getElementById('sb-narr-cancel-btn'); if (_cb) _cb.style.display = 'none';
    if (done && fill) fill.style.width = '100%';
    setTimeout(function () { if (wrap) wrap.style.display = 'none'; if (fill) fill.style.width = '0%'; }, done ? 350 : 0);
  }
  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id + forkQ(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: getApiKey() || 'platform' }),
    signal: _nctl.signal
  })
  .then(function (r) { return r.json(); })
  .then(function (data) {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    if (data.error) { endBar(false); showAlert('Could not generate narrative: ' + data.error); return; }
    endBar(true);
    state.narrativeData = { intro: data.intro || '', sections: data.sections || [], outro: data.outro || '' };
    state.narrativeStyleUsed = state.narrativeStyle || 'classic';
    if (typeof renderStoryboard === 'function') renderStoryboard();
  })
  .catch(function (e) {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    endBar(false);
    if (e && e.name === 'AbortError') return;
    showAlert('Could not generate narrative: ' + e.message);
  });
}

function cancelNarrOnly() {
  if (state.abortNarrOnly) { try { state.abortNarrOnly.abort(); } catch (e) {} }
  var w = document.getElementById('generate-progress'); if (w) w.style.display = 'none';
  var c = document.getElementById('sb-narr-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('sb-generate-narr-btn'); if (b) b.disabled = false;
}

// ============================================================
// CAMPAIGN HEADER — editable name + description on the Sessions screen,
// plus the campaign cover art (set from the Archive; shown on the chip).
// ============================================================
function renderCampaignHeaderDisplay() {
  var c = state.currentCampaign;
  var nameEl = document.getElementById('sessions-camp-name');
  var cntEl = document.getElementById('sessions-count');
  var descEl = document.getElementById('sessions-camp-desc');
  if (nameEl) nameEl.textContent = (c && c.name) ? c.name : 'Sessions';
  if (cntEl) {
    var n = state.sessions ? state.sessions.length : 0;
    cntEl.textContent = ' (' + n + ' session' + (n === 1 ? '' : 's') + ')';
  }
  if (descEl) descEl.textContent = (c && c.description) ? c.description : '';
}

function startCampaignEdit() {
  var c = state.currentCampaign;
  if (!c) return;
  if (document.getElementById('camp-edit-name-input')) return; // already editing
  var nameEl = document.getElementById('sessions-camp-name');
  var descEl = document.getElementById('sessions-camp-desc');
  var cntEl = document.getElementById('sessions-count');
  if (cntEl) cntEl.textContent = '';
  if (nameEl) nameEl.innerHTML = '<input id="camp-edit-name-input" class="camp-edit-input" onblur="campaignEditBlur()" onkeydown="campaignEditKey(event)" />';
  if (descEl) descEl.innerHTML = '<textarea id="camp-edit-desc-input" class="camp-edit-textarea" placeholder="Add a description..." onblur="campaignEditBlur()"></textarea>';
  var ni = document.getElementById('camp-edit-name-input');
  if (ni) { ni.value = c.name || ''; ni.focus(); ni.select(); }
  var di = document.getElementById('camp-edit-desc-input');
  if (di) di.value = c.description || '';
}

function campaignEditKey(e) {
  if (e && e.key === 'Enter' && e.target && e.target.id === 'camp-edit-name-input') {
    e.preventDefault();
    e.target.blur();
  }
}

// Commit only once focus has fully left BOTH edit fields, so tabbing from the
// name to the description doesn't prematurely close the editor. Saves on blur.
function campaignEditBlur() {
  setTimeout(function() {
    var ni = document.getElementById('camp-edit-name-input');
    var di = document.getElementById('camp-edit-desc-input');
    var ae = document.activeElement;
    if (ae === ni || ae === di) return; // still editing one of the fields
    var c = state.currentCampaign;
    if (!c) { renderCampaignHeaderDisplay(); return; }
    var newName = ni ? ni.value.trim() : (c.name || '');
    var newDesc = di ? di.value : (c.description || '');
    if (!newName) newName = c.name; // never blank the name
    if (newName === c.name && newDesc === (c.description || '')) {
      renderCampaignHeaderDisplay();
      return;
    }
    fetch('/api/campaigns/' + c.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, description: newDesc })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.id) {
        c.name = data.name; c.description = data.description;
        var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
        if (i >= 0) { state.campaigns[i].name = data.name; state.campaigns[i].description = data.description; }
      }
    })
    .catch(function(){})
    .then(function(){ renderCampaignHeaderDisplay(); });
  }, 0);
}

// Set (or clear, by re-clicking the current one) the campaign cover from an
// archived image. DM-only; the button is only rendered for the DM.
function setCampaignCover(archiveId) {
  var c = state.currentCampaign;
  if (!c) return;
  var a = (state.archives || []).find(function(x){ return x.id === archiveId; });
  if (!a) return;
  var newCover = (c.cover_image_url === a.image_url) ? '' : a.image_url;
  fetch('/api/campaigns/' + c.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_image_url: newCover })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data && data.id) {
      c.cover_image_url = data.cover_image_url || '';
      var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
      if (i >= 0) state.campaigns[i].cover_image_url = data.cover_image_url || '';
      renderArchives();
      showAlert(newCover ? 'Campaign cover set.' : 'Campaign cover cleared.');
    } else {
      showAlert((data && data.error) || 'Could not update the cover.');
    }
  })
  .catch(function(){ showAlert('Could not update the campaign cover.'); });
}

function showErrorDialog(msg, title) {
  var ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--panel,#1c1b22);border:1px solid var(--gold,#c9a84c);border-radius:10px;max-width:440px;width:100%;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,0.55);';
  var h = document.createElement('div');
  h.textContent = title || 'Heads up';
  h.style.cssText = 'font-size:16px;font-weight:700;color:var(--gold,#c9a84c);margin-bottom:10px;';
  var p = document.createElement('div');
  p.textContent = msg;
  p.style.cssText = 'font-size:14px;line-height:1.5;color:var(--gold,#c9a84c);margin-bottom:18px;white-space:pre-wrap;';
  var bar = document.createElement('div');
  bar.style.cssText = 'text-align:right;';
  var ok = document.createElement('button');
  ok.className = 'btn btn-primary';
  ok.textContent = 'OK';
  ok.onclick = function(){ ov.remove(); };
  bar.appendChild(ok);
  box.appendChild(h); box.appendChild(p); box.appendChild(bar);
  ov.appendChild(box);
  ov.onclick = function(e){ if (e.target === ov) ov.remove(); };
  document.body.appendChild(ov);
  ok.focus();
}

function switchSessionTab(tab) {
  var tabs = ['notes', 'characters', 'review', 'storyboard', 'export'];
  tabs.forEach(function(t) {
    var pane = document.getElementById('session-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('stab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Auto-load preview when switching to the Publish tab. Default to Quick View
  // and always render it; True View is only shown when the user toggles to it.
  if (tab === 'export' && state.currentSession) {
    sessionPreviewMode = 'quick';
    var _spb = document.getElementById('session-preview-mode-btn');
    if (_spb) _spb.textContent = 'Quick View';
    loadPreview(state.layoutStyle || 'Classic');
  }
  // Load character snapshots when switching to the characters tab
  if (tab === 'characters') {
    loadSessionCharacters();
  }
  if (tab === 'review') {
    loadReview();
  }
}

// ============================================================
// CHARACTERS
// ============================================================
// ============================================================
// CAMPAIGN ASSET LIBRARY
// ============================================================
function loadAssets() {
  var grid = document.getElementById('asset-grid');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.assets = Array.isArray(data) ? data : [];
      renderAssets();
    })
    .catch(function() {
      state.assets = [];
      renderAssets();
    });
}

var ASSET_CAT_LABEL = { location: 'Location', npc: 'NPC', item: 'Item' };

function renderAssets() {
  var grid = document.getElementById('asset-grid');
  if (!grid) return;
  var cards = (state.assets || []).map(function(a) {
    var img = a.image_url
      ? '<img src="' + a.image_url + '" class="sc-thumb" alt="' + a.name + '" ' +
        'style="cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" />'
      : '<div class="sc-thumb sc-thumb-empty">&#127912;</div>';
    var cat = ASSET_CAT_LABEL[a.category] || 'Location';
    return '<div class="sc-card">' +
      '<div class="sc-card-head">' +
        img +
        '<div class="sc-card-id">' +
          '<div class="sc-card-name">' + a.name + '</div>' +
          '<div class="sc-card-cls">' + cat + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="char-prompt-actions">' +
        '<button class="btn btn-sm" onclick="openAssetModal(' + a.id + ')">&#9998; Edit</button>' +
        '<button class="btn btn-sm" onclick="deleteAsset(' + a.id + ')">&#10005; Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
  grid.innerHTML =
    '<div class="add-char-card" onclick="openAssetModal()">' +
      '<div class="plus">+</div><span>Add asset</span>' +
    '</div>' + cards;
}

function openAssetModal(assetId) {
  var modal = document.getElementById('asset-modal');
  var title = document.getElementById('asset-modal-title');
  var saveBtn = document.getElementById('asset-save-btn');
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var fileEl = document.getElementById('asset-image');
  var errEl = document.getElementById('asset-modal-error');
  if (errEl) errEl.classList.add('hidden');
  if (fileEl) fileEl.value = '';

  // Reset the picked-file holder each time the modal opens.
  state.assetPickedFile = null;

  if (assetId) {
    var a = (state.assets || []).find(function(x) { return x.id === assetId; });
    if (!a) return;
    state.editingAssetId = assetId;
    if (title) title.textContent = 'Edit Asset';
    if (saveBtn) saveBtn.textContent = 'Save asset';
    if (nameEl) nameEl.value = a.name || '';
    if (catEl) catEl.value = a.category || 'location';
    setAssetPreview(a.image_url || null);
  } else {
    state.editingAssetId = null;
    if (title) title.textContent = 'Add Asset';
    if (saveBtn) saveBtn.textContent = 'Add asset';
    if (nameEl) nameEl.value = '';
    if (catEl) catEl.value = 'location';
    setAssetPreview(null);
  }
  if (modal) modal.classList.remove('hidden');
}

// Show an image in the drop zone (existing URL or a freshly picked file),
// or the empty prompt when there is none. A shown image is click-to-enlarge.
function setAssetPreview(src) {
  var empty = document.getElementById('asset-drop-empty');
  var preview = document.getElementById('asset-drop-preview');
  if (!empty || !preview) return;
  if (src) {
    preview.src = src;
    preview.style.display = 'block';
    empty.style.display = 'none';
    preview.onclick = function(e) {
      e.stopPropagation();
      openLightbox(preview.src, 'Asset image');
    };
  } else {
    preview.removeAttribute('src');
    preview.style.display = 'none';
    empty.style.display = 'flex';
    preview.onclick = null;
  }
}

// A file was picked or dropped — hold it and show a local preview.
function acceptAssetFile(file) {
  if (!file) return;
  if (!file.type || !file.type.match('image.*')) {
    var errEl = document.getElementById('asset-modal-error');
    if (errEl) { errEl.textContent = 'Please choose an image file.'; errEl.classList.remove('hidden'); }
    return;
  }
  state.assetPickedFile = file;
  setAssetPreview(URL.createObjectURL(file));
}

function handleAssetFileSelect(e) {
  if (e.target.files && e.target.files[0]) acceptAssetFile(e.target.files[0]);
}
function handleAssetDragOver(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.add('drag-over');
}
function handleAssetDragLeave(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.remove('drag-over');
}
function handleAssetDrop(e) {
  e.preventDefault(); e.stopPropagation();
  var z = document.getElementById('asset-drop');
  if (z) z.classList.remove('drag-over');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files[0]) acceptAssetFile(files[0]);
}

function closeAssetModal() {
  var modal = document.getElementById('asset-modal');
  if (modal) modal.classList.add('hidden');
  state.editingAssetId = null;
}

function saveAsset() {
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var fileEl = document.getElementById('asset-image');
  var errEl = document.getElementById('asset-modal-error');
  var saveBtn = document.getElementById('asset-save-btn');
  var name = nameEl ? nameEl.value.trim() : '';

  if (!name) {
    if (errEl) { errEl.textContent = 'Asset name is required.'; errEl.classList.remove('hidden'); }
    return;
  }

  var fd = new FormData();
  fd.append('name', name);
  fd.append('category', catEl ? catEl.value : 'location');
  if (state.assetPickedFile) fd.append('image', state.assetPickedFile);

  var editing = state.editingAssetId;
  var url = '/api/campaigns/' + state.currentCampaign.id + '/assets' + (editing ? '/' + editing : '');
  var method = editing ? 'PUT' : 'POST';
  if (saveBtn) saveBtn.disabled = true;

  fetch(url, { method: method, body: fd })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (saveBtn) saveBtn.disabled = false;
      if (data && data.error) {
        if (errEl) { errEl.textContent = data.error; errEl.classList.remove('hidden'); }
        return;
      }
      closeAssetModal();
      loadAssets();
    })
    .catch(function() {
      if (saveBtn) saveBtn.disabled = false;
      if (errEl) { errEl.textContent = 'Could not save the asset.'; errEl.classList.remove('hidden'); }
    });
}

function deleteAsset(assetId) {
  if (!confirm('Delete this asset? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + assetId, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) { alert(data.error); return; }
      loadAssets();
    })
    .catch(function() { alert('Could not delete the asset.'); });
}


function loadCharacters() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.characters = Array.isArray(data) ? data : [];
      renderCharacters();
    });
}

// ---- Canonical character prompt (shown in the Edit Character modal) ----
// Renders into the modal's prompt section. charId may be null for a new
// (unsaved) character — in which case the prompt can't be built yet.
function renderCharModalPrompt(char) {
  var body = document.getElementById('char-modal-prompt-body');
  if (!body) return;

  if (!char || !char.id) {
    body.innerHTML = '<div class="char-prompt-empty">Save the character first, then you can build its prompt from the images.</div>';
    return;
  }

  var _meId = (state.user && state.user.id) || null;
  var _crole = state.currentCampaign && state.currentCampaign.my_role;
  var canEdit = (_crole === 'dm') || (!!_meId && char.owner_user_id === _meId);
  var hasPrompt = char.canonical_prompt && char.canonical_prompt.trim();
  var inner = hasPrompt
    ? '<div class="char-prompt-text" id="char-prompt-text-' + char.id + '">' + char.canonical_prompt + '</div>'
    : '<div class="char-prompt-empty" id="char-prompt-text-' + char.id + '">No character prompt yet \u2014 build one from the card info and images.</div>';

  var buttons = '<button class="btn btn-sm" id="char-prompt-rebuild-' + char.id + '" ' +
    'onclick="rebuildCharPrompt(' + char.id + ')">&#10227; ' +
    (hasPrompt ? 'Rebuild prompt' : 'Build character prompt') + '</button>';
  if (canEdit && hasPrompt) {
    buttons += '<button class="btn btn-sm" onclick="startEditCharPrompt(' + char.id + ')">&#9998; Edit</button>';
  }

  // Reference image — the generated picture, shown full under the button.
  var _carched = isMomentArchived(char);
  var refImg = char.canonical_reference_url
    ? '<div class="char-ref-image" id="char-ref-image-' + char.id + '">' +
        '<div class="char-ref-label">Reference image</div>' +
        '<div class="char-ref-imgwrap">' +
          '<img src="' + char.canonical_reference_url + '" alt="' + char.name + ' reference" ' +
          'onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />' +
          '<div class="panel-img-actions">' +
            '<button class="panel-pill" onclick="regenCharRef(' + char.id + ')" title="Re-roll the reference image from the current prompt">Regenerate</button>' +
            '<button class="panel-pill" onclick="openRetouchChar(' + char.id + ')" title="Keep this image and change just one thing">Retouch</button>' +
            '<button class="panel-pill" onclick="openReplacePicker(\'canonical\', ' + char.id + ')" title="Replace with an image from the Archive">Replace</button>' +
            '<button class="panel-pill' + (_carched ? ' is-on' : '') + '" id="char-archive-' + char.id + '" onclick="toggleArchiveCharCanonical(' + char.id + ')" title="' + (_carched ? 'In your Archive — click to remove' : 'Save this reference image to your Archive') + '">' + (_carched ? 'Archived' : 'Archive') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    : '<div class="char-ref-image" id="char-ref-image-' + char.id + '"></div>';

  body.innerHTML = inner + '<div class="char-prompt-actions">' + buttons + '</div>' + refImg;
}

function rebuildCharPrompt(charId) {
  // Save-first guard. The character form in the modal may have pending
  // changes (uploaded reference images, edited description, etc.) that
  // haven't been persisted yet. Without this, the AI build runs against
  // stale database data and ignores whatever the user just changed —
  // wasting a token and producing a wrong result.
  //
  // The save runs silently (no modal close, no nudge, no success toast).
  // If save fails, we abort the build and surface the error.
  saveCharFormSilently(charId, function(err) {
    if (err) {
      showModalError('char-modal-error', err);
      return;
    }
    // Save succeeded — refresh the cached character from the saved data
    // (loadCharacters fires inside the save), then run the actual build.
    rebuildCharPromptCore(charId);
  });
}

// Internal: silently save the open character form, then call cb(err).
// Mirrors saveChar()'s FormData submit but doesn't touch the modal UI
// (no close, no "guided nudge", no transition into edit mode). Used as
// a pre-flight from rebuildCharPrompt.
function saveCharFormSilently(charId, cb) {
  var nameEl = document.getElementById('char-name');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) { cb('Character name is required.'); return; }

  var player = document.getElementById('char-player').value.trim();
  var cls = document.getElementById('char-cls').value.trim();
  var desc = document.getElementById('char-desc').value.trim();

  var formData = new FormData();
  formData.append('name', name);
  formData.append('player_name', player);
  formData.append('cls', cls || 'Adventurer');
  formData.append('description', desc);
  var npcEl = document.getElementById('char-is-npc');
  // Only DM sees the NPC checkbox; for players it's hidden but we still
  // submit the field. Backend ignores it for non-DM role anyway.
  formData.append('is_npc', (npcEl && npcEl.checked) ? 'true' : 'false');

  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    if (slotFiles[slot]) {
      formData.append(slot, slotFiles[slot]);
    }
    if (slotFiles[slot + '_clear']) {
      formData.append('clear_' + slot, 'true');
    }
  });

  var url = '/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId;
  fetch(url, { method: 'PUT', body: formData })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) { cb(data.error); return; }
      // Update the cached character in state so the build step uses
      // the just-saved version, not the stale one.
      if (data && data.id && Array.isArray(state.characters)) {
        var idx = state.characters.findIndex(function(c) { return c.id === data.id; });
        if (idx >= 0) state.characters[idx] = data;
      }
      // Don't close, don't nudge, don't transition — just return.
      cb(null);
    })
    .catch(function(e) {
      cb('Save failed: ' + (e && e.message ? e.message : 'network error'));
    });
}

// The original build logic, factored out of rebuildCharPrompt so the
// save-first wrapper can call it after a successful save.
function rebuildCharPromptCore(charId) {
  var btn = document.getElementById('char-prompt-rebuild-' + charId);
  var textEl = document.getElementById('char-prompt-text-' + charId);
  if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }

  // Show the unified spinner overlay on top of the reference-image area.
  // If a reference image already exists (rebuild case), it stays visible
  // underneath, dimmed. If it doesn't yet (first build), the overlay just
  // covers the empty container. Cycling status text goes in the sublabel.
  var refTargetId = 'char-ref-image-' + charId;
  var refEl = document.getElementById(refTargetId);
  // Give the empty container a min-height so the overlay has somewhere
  // to render even before any image exists.
  if (refEl && !refEl.querySelector('img')) {
    refEl.style.minHeight = '180px';
  }
  showBusyOverlay(refTargetId, 'Building', 'Analyzing character and images\u2026');

  // Cycle through status messages so it feels alive during the wait.
  var steps = [
    'Analyzing character and images\u2026',
    'Studying facial features and outfit\u2026',
    'Writing the canonical description\u2026',
    'Generating the reference image\u2026',
    'Almost there\u2026'
  ];
  var stepIdx = 0;
  var ticker = setInterval(function() {
    stepIdx++;
    if (stepIdx < steps.length) updateBusyOverlaySublabel(refTargetId, steps[stepIdx]);
  }, 4000);

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/rebuild-prompt', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      clearInterval(ticker);
      if (data && data.success) {
        var ch = (state.characters || []).find(function(c) { return c.id === charId; });
        if (ch) {
          ch.canonical_prompt = data.canonical_prompt;
          ch.canonical_prompt_at = data.canonical_prompt_at;
          renderCharModalPrompt(ch);
        } else {
          hideBusyOverlay(refTargetId);
        }
        if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        // The reference image is generated async — poll for it and slot it in.
        if (data.image_job_id) {
          showBusyOverlay(refTargetId, 'Generating', 'Rendering the reference image\u2026');
          pollRefJob(data.image_job_id, function(url){ applyCanonicalRef(charId, url); }, function(){ hideBusyOverlay(refTargetId); });
        }
      } else {
        // Refusal / failure — remove the overlay so the existing image
        // (if any) is fully visible again, and show the error.
        hideBusyOverlay(refTargetId);
        if (data && data.error === 'INSUFFICIENT_TOKENS') {
          if (textEl) textEl.innerHTML = insufficientTokensHtml(data.message);
        } else if (textEl) {
          textEl.textContent = (data && data.error) || 'Could not build the prompt.';
        }
        if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rebuild prompt'; }
      }
    })
    .catch(function() {
      clearInterval(ticker);
      hideBusyOverlay(refTargetId);
      if (textEl) textEl.textContent = 'Could not build the prompt.';
      if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rebuild prompt'; }
    });
}

// Re-roll the canonical reference IMAGE from the existing prompt (option A:
// no prompt rewrite). The moment "Regenerate" pill, applied to a character.
function regenCharRef(charId) {
  var refTargetId = 'char-ref-image-' + charId;
  var refEl = document.getElementById(refTargetId);
  if (refEl && !refEl.querySelector('img')) refEl.style.minHeight = '180px';
  showBusyOverlay(refTargetId, 'Regenerating', 'Re-rolling the reference image…');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/regenerate-reference', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ fal_key: getFalKey() || 'platform' })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.error) {
        hideBusyOverlay(refTargetId);
        var textEl0 = document.getElementById('char-prompt-text-' + charId);
        if (data.error === 'INSUFFICIENT_TOKENS') {
          if (textEl0) textEl0.innerHTML = insufficientTokensHtml(data.message);
          else alert(data.message || 'You are out of tokens.');
        } else {
          alert((data && (data.message || data.error)) || 'Could not regenerate the reference image.');
        }
        return;
      }
      if (data && data.canonical_reference_url) { applyCanonicalRef(charId, data.canonical_reference_url); return; }
      if (data && data.job_id) {
        pollRefJob(data.job_id, function(url){ applyCanonicalRef(charId, url); }, function(err){
          hideBusyOverlay(refTargetId);
          alert(err === 'INSUFFICIENT_TOKENS' ? 'You are out of tokens.' : 'Could not regenerate the reference image.');
        });
        return;
      }
      hideBusyOverlay(refTargetId);
      alert('Could not regenerate the reference image.');
    })
    .catch(function(e){ hideBusyOverlay(refTargetId); alert('Could not regenerate the reference image: ' + e.message); });
}

// Open the shared Retouch modal targeting a CHARACTER reference (vs a moment).
function openRetouchChar(charId) {
  state.retouchCharId = charId;
  state.retouchMomentId = null;
  state.retouchSessionCharId = null;
  var ta = document.getElementById('retouch-instruction');
  if (ta) ta.value = '';
  var modal = document.getElementById('retouch-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

// Open the shared Retouch modal targeting a SESSION character's reference (a
// draft amendment image). Distinct from openRetouchChar (canonical) and
// openRetouch (moment) via state.retouchSessionCharId.
function openRetouchSessionChar(charId) {
  state.retouchSessionCharId = charId;
  state.retouchCharId = null;
  state.retouchMomentId = null;
  var ta = document.getElementById('retouch-instruction');
  if (ta) ta.value = '';
  var modal = document.getElementById('retouch-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

// Inline session-character retouch: reads the Amended-appearance textarea and
// retouches the current reference in place (draft -> Approve), no modal. The
// session_ref webhook persists/spends/logs but only writes the snapshot on
// Approve. Replaces the old Regenerate/Retouch pills on this screen.
function retouchSessionInline(charId) {
  var textEl = document.getElementById('sc-review-text-' + charId);
  var instruction = textEl ? textEl.value.trim() : '';
  var msg = document.getElementById('sc-review-msg-' + charId);
  var btn = document.getElementById('sc-retouch-' + charId);
  if (!instruction) {
    if (msg) msg.textContent = 'Describe the amended appearance in the box above first.';
    return;
  }
  var wrapId = 'sc-review-imgwrap-' + charId;
  if (msg) msg.textContent = '';
  if (btn) btn.disabled = true;
  showBusyOverlay(wrapId, 'Retouching', 'Applying your change\u2026');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/characters/' + charId + '/retouch-reference', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ instruction: instruction, fal_key: getFalKey() || 'platform' })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.job_id) {
        pollRefJob(data.job_id, function(url){
          var wrap = document.getElementById(wrapId);
          if (wrap) {
            wrap.innerHTML = '<img src="' + url + '" class="sc-review-img" id="sc-review-img-' + charId + '" alt="reference" />';
          }
          state.draftReference = state.draftReference || {};
          state.draftReference[charId] = url;
          if (btn) btn.disabled = false;
          if (msg) msg.textContent = 'Retouched image ready. Retouch again, or Approve to keep it.';
          if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        }, function(err){
          hideBusyOverlay(wrapId);
          if (btn) btn.disabled = false;
          if (msg) msg.textContent = 'Could not retouch: ' + err;
        });
        return;
      }
      hideBusyOverlay(wrapId);
      if (btn) btn.disabled = false;
      if (data && data.error === 'INSUFFICIENT_TOKENS') {
        if (msg) msg.innerHTML = insufficientTokensHtml(data.message);
      } else if (msg) {
        msg.textContent = (data && (data.message || data.error)) || 'Could not retouch.';
      } else {
        alert((data && (data.message || data.error)) || 'Could not retouch.');
      }
    })
    .catch(function(e){ hideBusyOverlay(wrapId); if (btn) btn.disabled = false; if (msg) msg.textContent = 'Could not retouch: ' + e.message; });
}

function startEditCharPrompt(charId) {
  var body = document.getElementById('char-modal-prompt-body');
  var ch = (state.characters || []).find(function(c) { return c.id === charId; });
  if (!body || !ch) return;
  body.innerHTML =
    '<textarea class="char-prompt-editor" id="char-prompt-editor-' + charId + '">' +
      (ch.canonical_prompt || '') + '</textarea>' +
    '<div class="char-prompt-actions">' +
      '<button class="btn btn-sm btn-primary" onclick="saveCharPrompt(' + charId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="renderCharModalPrompt(charById(' + charId + '))">Cancel</button>' +
    '</div>';
}

function charById(id) {
  return (state.characters || []).find(function(c) { return c.id === id; }) || null;
}

function saveCharPrompt(charId) {
  var ta = document.getElementById('char-prompt-editor-' + charId);
  if (!ta) return;
  var newPrompt = ta.value;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/canonical-prompt', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ canonical_prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        var ch = (state.characters || []).find(function(c) { return c.id === charId; });
        if (ch) ch.canonical_prompt = newPrompt;
        renderCharModalPrompt(ch);
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save.');
      }
    })
    .catch(function() { ta.disabled = false; alert('Could not save.'); });
}

function renderCharacters() {
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var html = state.characters.map(function(c, i) {
    var initials = c.name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<span style="font-size:15px;font-weight:600;color:' + fg + ';">' + initials + '</span>';
    // Just show portrait on card - clean and simple
    var imgGridHtml = '';

    // Phase 3 ownership badges. Three mutually exclusive states for a PC:
    // - owner_name present → claimed by a Chronicle user (Played by X)
    // - is_claimed === false → stub awaiting invitee (Awaiting player)
    // - otherwise → unowned PC, no badge
    // NPCs get neither (they have the NPC badge already below).
    var ownerBadge = '';
    var isNpc = (c.is_npc === true || c.is_npc === 1 || c.is_npc === '1');
    if (!isNpc) {
      if (c.owner_name) {
        ownerBadge = '<div class="char-owner-badge">&#127922; Played by ' + (typeof escapeHtml === 'function' ? escapeHtml(c.owner_name) : c.owner_name) + '</div>';
      } else if (c.is_claimed === false) {
        ownerBadge = '<div class="char-pending-badge">&#8987; Awaiting player</div>';
      }
    }

    return '<div class="char-card char-card-drop" id="char-card-' + c.id + '">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          (function() {
            // Phase 3 Deploy 3 — per-card edit visibility.
            var meId = (state.user && state.user.id) || null;
            var cur = state.currentCampaign;
            var isDM = (cur && cur.my_role === 'dm');
            var isOwner = (meId && c.owner_user_id === meId);
            var locked = !!(cur && cur.locked);
            var canEdit = isDM || (isOwner && !locked);
            var btns = '';
            if (canEdit) {
              btns += '<button class="char-btn" onclick="openCharModal(' + c.id + ')">Edit</button>';
            }
            // Delete stays DM-only — players cannot delete any character.
            btns += '<button class="char-btn char-btn-delete dm-only" onclick="deleteChar(' + c.id + ')">Delete</button>';
            return btns;
          })() +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      ownerBadge +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="char-desc">' + (c.description || '') + '</div>' +
      '<span class="char-badge">' + (c.cls || '') + '</span>' +
      (isNpc ? '<span class="char-badge char-badge-npc">NPC</span>' : '') +
      imgGridHtml +
    '</div>';
  }).join('');
  html += '<div class="add-char-card dm-only" onclick="openCharModal()"><div class="plus">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
  setupCardDragDrop();
}

function openCharModal(editId) {
  var char = editId ? state.characters.find(function(c){return c.id===editId;}) : null;
  document.getElementById('char-edit-id').value = editId || '';
  document.getElementById('char-modal-title').textContent = editId ? 'Edit Character' : 'Add Character';
  document.getElementById('char-name').value = char ? char.name : '';
  document.getElementById('char-player').value = char ? (char.player_name || '') : '';
  document.getElementById('char-cls').value = char ? (char.cls || '') : '';
  document.getElementById('char-desc').value = char ? (char.description || '') : '';
  var npcEl = document.getElementById('char-is-npc');
  if (npcEl) npcEl.checked = !!(char && (char.is_npc === true || char.is_npc === 1 || char.is_npc === '1'));
  loadSlotPreviews(char);
  renderCharModalPrompt(char);
  var oldNudge = document.getElementById('char-prompt-nudge');
  if (oldNudge) oldNudge.remove();
  document.getElementById('char-modal-error').classList.add('hidden');
  document.getElementById('char-modal').classList.remove('hidden');
}

function closeCharModal() { document.getElementById('char-modal').classList.add('hidden'); }

function previewCharImage() {
  var input = document.getElementById('char-image-input');
  var preview = document.getElementById('char-image-preview');
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function(e) { preview.src = e.target.result; preview.style.display = 'block'; };
    reader.readAsDataURL(input.files[0]);
  }
}

function saveChar() {
  var name = document.getElementById('char-name').value.trim();
  var player = document.getElementById('char-player').value.trim();
  var cls = document.getElementById('char-cls').value.trim();
  var desc = document.getElementById('char-desc').value.trim();
  var editId = document.getElementById('char-edit-id').value;
  if (!name) { showModalError('char-modal-error', 'Character name is required.'); return; }

  var formData = new FormData();
  formData.append('name', name);
  formData.append('player_name', player);
  formData.append('cls', cls || 'Adventurer');
  formData.append('description', desc);
  var npcEl = document.getElementById('char-is-npc');
  formData.append('is_npc', (npcEl && npcEl.checked) ? 'true' : 'false');

  // Append all slot files
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    if (slotFiles[slot]) {
      formData.append(slot, slotFiles[slot]);
    }
    if (slotFiles[slot + '_clear']) {
      formData.append('clear_' + slot, 'true');
    }
  });

  var url = editId
    ? '/api/campaigns/' + state.currentCampaign.id + '/characters/' + editId
    : '/api/campaigns/' + state.currentCampaign.id + '/characters';

  fetch(url, {method: editId ? 'PUT' : 'POST', body: formData})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { showModalError('char-modal-error', data.error); return; }

      // If this was a NEW character that has no prompt yet, DON'T close —
      // the "Build character prompt" step is only available once the
      // character exists, so closing here would force a save-and-reopen.
      // Instead, transition the open dialog into edit mode for the just-
      // created character, reveal the Build button, and guide the user.
      var wasNew = !editId;
      var newChar = data && data.id ? data : null;
      var needsPrompt = newChar && !(newChar.canonical_prompt && String(newChar.canonical_prompt).trim());

      if (wasNew && newChar && needsPrompt) {
        // Make the new character available to the rest of the UI.
        loadCharacters();
        // Switch the dialog from "Add" to "Edit" mode in place.
        document.getElementById('char-edit-id').value = newChar.id;
        document.getElementById('char-modal-title').textContent = 'Edit Character';
        document.getElementById('char-modal-error').classList.add('hidden');
        // Re-render the prompt section so the Build button appears.
        renderCharModalPrompt(newChar);
        // Guided nudge: point the user at the now-available build step.
        showCharPromptNudge();
        return;
      }

      closeCharModal();
      loadCharacters();
    });
}

// Inline guided nudge shown after a new character is first saved, telling
// the user the next step (building the character prompt) is now available.
function showCharPromptNudge() {
  var body = document.getElementById('char-modal-prompt-body');
  if (!body) return;
  var existing = document.getElementById('char-prompt-nudge');
  if (existing) existing.remove();
  var nudge = document.createElement('div');
  nudge.id = 'char-prompt-nudge';
  nudge.style.cssText = 'margin:8px 0;padding:8px 12px;border-radius:6px;font-size:13px;' +
    'background:rgba(15,110,86,0.25);border:1px solid rgba(134,212,186,0.4);color:#86d4ba;';
  nudge.innerHTML = '&#10003; Character saved. Now build its character prompt below \u2014 ' +
    'this is what keeps the character looking consistent across your panels. ' +
    'You can close this window when you\u2019re done.';
  body.parentNode.insertBefore(nudge, body);
}

function deleteChar(id) {
  var char = state.characters.find(function(c){return c.id===id;});
  if (!confirm('Delete ' + (char ? char.name : 'this character') + '?')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + id, {method:'DELETE'})
    .then(function() { loadCharacters(); });
}

// ============================================================
// EXTRACT MOMENTS
// ============================================================
function selStyle(el, style) {
  document.querySelectorAll('.style-row .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.artStyle = style;

  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({art_style: style})
    }).catch(function() {});
  }
}

function selLayout(el, layout) {
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.layoutStyle = layout;

  // Save to session
  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({layout_style: layout})
    }).catch(function() {});
  }

  // Always show preview when layout is selected
  loadPreview(layout);
}

// --- Preview render progress bar (shared by the session + novel preview iframes).
// The real server render percentage is unknowable, so the bar creeps toward ~90%
// while Chromium renders the PDF, then snaps to 100% when the iframe finishes.
var _previewProgress = {};
function startPreviewProgress(prefix, mode) {
  var wrap = document.getElementById(prefix + '-progress-wrap');
  var fill = document.getElementById(prefix + '-progress-fill');
  var msg = document.getElementById(prefix + '-progress-msg');
  if (!wrap || !fill) return;
  if (_previewProgress[prefix]) clearInterval(_previewProgress[prefix]);
  wrap.style.display = 'block';
  var pct = 8;
  fill.style.width = pct + '%';
  if (msg) msg.textContent = (mode === 'wysiwyg')
    ? 'Rendering the paged PDF (this can take several seconds)...'
    : 'Loading preview...';
  var ease = (mode === 'wysiwyg') ? 0.04 : 0.18;
  _previewProgress[prefix] = setInterval(function() {
    pct += Math.max(0.4, (90 - pct) * ease);
    if (pct > 90) pct = 90;
    fill.style.width = pct.toFixed(1) + '%';
  }, 300);
}
function stopPreviewProgress(prefix) {
  var wrap = document.getElementById(prefix + '-progress-wrap');
  var fill = document.getElementById(prefix + '-progress-fill');
  if (_previewProgress[prefix]) { clearInterval(_previewProgress[prefix]); _previewProgress[prefix] = null; }
  if (fill) fill.style.width = '100%';
  setTimeout(function() {
    if (wrap) wrap.style.display = 'none';
    if (fill) fill.style.width = '0%';
  }, 400);
}

function loadPreview(layout) {
  var loading = document.getElementById('session-preview-loading');
  var iframe = document.getElementById('session-preview-iframe');
  if (!iframe) return;

  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(layout || state.layoutStyle || 'Classic') +
    (state.currentForkId ? '&fork_id=' + state.currentForkId : '') + customOptsQ('session','&') +
    (sessionPreviewMode === 'wysiwyg' ? '&format=pdf' : '');

  // Show loading state
  if (loading) loading.style.display = 'flex';
  startPreviewProgress('session-preview', sessionPreviewMode);
  iframe.style.display = 'none';
  iframe.src = '';

  // Load new preview
  iframe.onload = function() {
    stopPreviewProgress('session-preview');
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizePreviewIframe();
  };
  iframe.src = url;
}

// Grow the preview iframe to the full height of its content so there is
// no inner scrollbar — the user scrolls only the outer page.
function resizePreviewIframe() {
  // Preview now renders the true paged PDF; the native PDF viewer scrolls
  // internally, so keep a fixed-height pane instead of growing to content.
  var iframe = document.getElementById('session-preview-iframe');
  var frame = document.getElementById('session-preview-frame');
  if (iframe) iframe.style.height = '75vh';
  if (frame) frame.style.height = '';
}

// Re-measure on window resize — content reflow can change the height
window.addEventListener('resize', function() {
  var iframe = document.getElementById('session-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizePreviewIframe();
  }
});

// Map a layout value (including legacy names) to its chip id suffix
function layoutChipKey(layout) {
  var legacy = { cinematic: 'comicbook', dramatic: 'action' };
  var k = (layout || 'Classic').toLowerCase();
  return legacy[k] || k;
}

function applyLayoutStyle(layout) {
  state.layoutStyle = layout || 'Classic';
  refreshLayoutStyleButtons();
}

function extractMoments() {
  var key = getApiKey();
  var transcript = document.getElementById('transcript-input').value.trim();
  var errorEl = document.getElementById('extract-error');
  errorEl.classList.add('hidden');

  // Image locking — re-extract would destroy locked panels; block it.
  if ((state.moments || []).some(function(m){ return m.locked; })) {
    var _lockMsg = 'Locked moments exist, so you can’t regenerate the story. Unlock them first to rebuild this version.';
    errorEl.textContent = _lockMsg;
    errorEl.classList.remove('hidden');
    alert(_lockMsg);
    return;
  }

  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!confirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // Auto-save before extracting: the DM persists transcript + canonical
  // notes; a player persists only their OWN version's notes (the transcript
  // is DM-owned and read-only to players).
  var notesVal = document.getElementById('session-notes-input');
  var _role = state.currentCampaign && state.currentCampaign.my_role;
  var _ownFork = (_role === 'player') && state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId);
  if (_ownFork) {
    if (typeof saveForkNotes === 'function') saveForkNotes(notesVal ? notesVal.value.trim() : '');
  } else if (_role === 'dm' && !state.currentForkId) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        transcript: transcript,
        session_notes: notesVal ? notesVal.value.trim() : ''
      })
    });
  }

  var btn = document.getElementById('extract-btn');
  var wrap = document.getElementById('progress-wrap');
  var fill = document.getElementById('progress-fill');
  var msg = document.getElementById('progress-msg');

  btn.disabled = true;
  wrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Reading your session transcript...';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 6, 88);
    fill.style.width = pct + '%';
  }, 400);

  var _xctl = new AbortController();
  state.abortExtract = _xctl;
  var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'inline-block';
  fetch('/api/extract/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key:key, artStyle:state.artStyle}),
    signal: _xctl.signal
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'none';
    if (data.error) {
      var _emsg = data.message || ('Error: ' + data.error);
      errorEl.textContent = _emsg;
      errorEl.classList.remove('hidden');
      if (typeof showErrorDialog === 'function') showErrorDialog(_emsg, 'Generate Story');
      wrap.style.display = 'none';
      btn.disabled = false;
      return;
    }
    // Pass 1 — Generate Story now EXTRACTS ONLY (moments + the free narrative
    // outline produced in the same call). Narrative prose and images are
    // generated later from the Review tab via "Generate Narrative & Images",
    // so no narrative call fires here.
    state.moments = data.moments || [];
    state.pendingChanges = data.pendingChanges || 0;
    state.narrativeData = { intro: '', sections: [], outro: '' };
    fill.style.width = '100%';
    msg.textContent = 'Your storyboard plan is ready!';
    var _mc = document.getElementById('moment-count'); if (_mc) _mc.textContent = state.moments.length;
    renderStoryboard();
    setTimeout(function() {
      wrap.style.display = 'none';
      fill.style.width = '0%';
      btn.disabled = false;
      // Permanent character changes detected -> review them on the Characters
      // tab first; otherwise land on Review to check the plan, steer the
      // narrative, and set casting before generating.
      if (state.pendingChanges && state.pendingChanges > 0) {
        switchSessionTab('characters');
      } else {
        switchSessionTab('review');
      }
    }, 800);
  })
  .catch(function(e) {
    clearInterval(ticker);
    var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'none';
    if (e && e.name === 'AbortError') { wrap.style.display = 'none'; btn.disabled = false; return; }
    wrap.style.display = 'none';
    btn.disabled = false;
    errorEl.textContent = 'Connection error: ' + e.message;
    errorEl.classList.remove('hidden');
  });
}


// Auto-save narrative with debounce — saves 1.5 seconds after user stops typing
var narrativeSaveTimer = null;
function scheduleNarrativeSave() {
  if (narrativeSaveTimer) clearTimeout(narrativeSaveTimer);
  narrativeSaveTimer = setTimeout(function() {
    saveInlineNarrative(true); // true = silent save
  }, 1500);
}

function collectNarrativeState() {
  var intro = document.getElementById('narrative-intro-box');
  var outro = document.getElementById('narrative-outro-box');
  var prevSecs = (state.narrativeData && state.narrativeData.sections) || [];
  var sections = (state.moments || []).map(function(m, i) {
    var mbox = document.getElementById('narrative-moment-box-' + i);
    var abox = document.getElementById('narrative-between-box-' + i);
    var prev = prevSecs.find(function(s){ return s.panel_index === i; }) || {};
    return {
      panel_index: i,
      before: mbox ? mbox.value.trim() : (prev.before || ''),
      before_summary: prev.before_summary || '',
      after: abox ? abox.value.trim() : (prev.after || ''),
      after_summary: prev.after_summary || ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrativeSection(type, panelIndex) {
  var data = collectNarrativeState();

  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    // Show brief saved indicator on the button
    var btnId = type === 'intro' ? 'narrative-opening'
      : type === 'outro' ? 'narrative-closing'
      : 'narrative-between-' + panelIndex;
    var block = document.getElementById(btnId);
    if (block) {
      var btn = block.querySelector('.narrative-save-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.color = '#5dcaa5';
        setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
      }
    }
  });
}

function saveInlineNarrative(silent) {
  var data = collectNarrativeState();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { if (!silent) showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    if (!silent) showAlert('Narrative saved!');
  });
}

function regenNarrativeSection(type, panelIndex) {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  // Save current state first
  saveInlineNarrative();

  // The textarea we write the result into, plus the panel container the
  // spinner overlay anchors to (same gold spinner the storyboard image
  // panels use, via showBusyOverlay).
  var boxId = type === 'opening' ? 'narrative-intro-box'
    : type === 'closing' ? 'narrative-outro-box'
    : type === 'moment' ? 'narrative-moment-box-' + panelIndex
    : 'narrative-between-box-' + panelIndex;
  var panelId = type === 'opening' ? 'narrative-opening'
    : type === 'closing' ? 'narrative-closing'
    : type === 'moment' ? 'narrative-moment-' + panelIndex
    : 'narrative-between-' + panelIndex;

  var box = document.getElementById(boxId);
  // Non-destructive: leave the existing prose visible-but-dimmed under the
  // overlay and lock editing while the regenerate is in flight. The original
  // text stays put on failure (we never blank it).
  if (box) box.disabled = true;
  showBusyOverlay(panelId, 'Regenerating');

  // Regenerate full narrative and extract the relevant section
  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    hideBusyOverlay(panelId);
    if (box) box.disabled = false;
    if (data.error) {
      showAlert('Error: ' + data.error);
      return;
    }

    state.narrativeData = {
      intro: data.intro || '',
      sections: data.sections || [],
      outro: data.outro || ''
    };

    // Update just the relevant box
    if (type === 'opening' && box) box.value = data.intro || '';
    else if (type === 'closing' && box) box.value = data.outro || '';
    else if (type === 'moment' && box) {
      var msec = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = msec ? (msec.before || '') : '';
    }
    else if (type === 'between' && box) {
      var section = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = section ? (section.after || '') : '';
    }
  })
  .catch(function(e) {
    hideBusyOverlay(panelId);
    if (box) box.disabled = false;
    showAlert('Error: ' + e.message);
  });
}

// Re-fetch the current session from the server and re-render the storyboard
// in place. Used after image generation so new images appear without a reload.
function refreshStoryboardImages() {
  if (!state.currentCampaign || !state.currentSession) return;
  // Reload the CURRENT version's moments (forkQ keeps us on the player's own
  // version after generation — without it we fall back to the DM canonical).
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || data.error) return;
      state.currentSession = data;
      state.moments = data.moments || [];
      renderStoryboard();
      if (typeof renderNovelWithImages === 'function') renderNovelWithImages();
    })
    .catch(function(){});
}

function generateAllImages() {
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!confirm('This will replace all existing panel images that are not locked. Are you sure?')) {
      return;
    }
  }

  var btn = document.getElementById('generate-all-btn');
  var progressWrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var msg = document.getElementById('gen-progress-msg');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  fill.style.width = '5%';
  var _toGen = (state.moments || []).filter(function(m){ return !m.locked; }).length;
  msg.textContent = 'Generating ' + _toGen + ' image' + (_toGen === 1 ? '' : 's') + '...';

  // Non-destructive busy overlay on each panel — existing images stay
  // in the DOM underneath, dimmed. On refusal/failure we remove overlays
  // and the user's previous images are still right there.
  state.moments.forEach(function(m) {
    if (!m.locked) showPanelBusy(m.id, 'Generating');
  });

  var _gctl = new AbortController();
  state.abortGenAll = _gctl;
  var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'inline-block';
  fetch('/api/images/generate-all', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      style: state.artStyle,
      fal_key: falKey
    }),
    signal: _gctl.signal
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'none';
    if (data.error) {
      // Generation refused — clear ALL busy overlays so the user's
      // existing images are fully visible again (not dimmed).
      hideAllPanelBusy();
      var errEl = document.getElementById('generate-error');
      if (data.error === 'INSUFFICIENT_TOKENS') {
        errEl.innerHTML = insufficientTokensHtml(data.message);
      } else {
        errEl.textContent = 'Error: ' + data.error;
      }
      errEl.classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    // Async batch: the server queued one job per panel and returned their ids.
    // Poll them to completion, driving the progress bar as each lands. (Falls
    // back to the old synchronous shape if the server returns counts directly.)
    if (data.jobs) {
      pollImageBatch(data.jobs, { total: data.total, skipped_locked: data.skipped_locked });
      return;
    }
    fill.style.width = '100%';
    var _doneMsg = (data.count || 0) + ' image' + ((data.count || 0) === 1 ? '' : 's') + ' generated';
    if (data.skipped_locked) { _doneMsg += ' (' + data.skipped_locked + ' locked panel' + (data.skipped_locked === 1 ? '' : 's') + ' skipped)'; }
    msg.textContent = _doneMsg + '!';
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    refreshStoryboardImages();
    setTimeout(function() {
      btn.disabled = false;
      progressWrap.style.display = 'none';
      fill.style.width = '0%';
    }, 2000);
  })
  .catch(function(e) {
    hideAllPanelBusy();
    var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'none';
    if (e && e.name === 'AbortError') { btn.disabled = false; progressWrap.style.display = 'none'; return; }
    document.getElementById('generate-error').textContent = 'Error: ' + e.message;
    document.getElementById('generate-error').classList.remove('hidden');
    btn.disabled = false;
    progressWrap.style.display = 'none';
  });
}

function regenImage(momentId, index) {
  var falKey = getFalKey() || 'platform';

  var moment = state.moments.find(function(m) { return m.id === momentId; });
  if (!moment) return;

  // Non-destructive busy overlay — existing image stays in the DOM
  // underneath, dimmed. On refusal/failure we remove the overlay and
  // the user's previous image is still there.
  showPanelBusy(momentId, 'Regenerating');

  fetch('/api/images/generate-moment', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      moment_id: momentId,
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      prompt: moment.prompt,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      // Render the error AT the panel (not at the top of the page) so
      // users scrolled deep in a long storyboard actually see it. The
      // existing image stays visible underneath the error overlay.
      if (data.error === 'INSUFFICIENT_TOKENS') {
        showPanelError(momentId, insufficientTokensHtml(data.message), true);
      } else {
        showPanelError(momentId, 'Could not regenerate: ' + data.error);
      }
      return;
    }
    // Async flow: the server queued the job and returned a job_id; the image is
    // generated by fal and delivered to our webhook, so we poll for it. (If the
    // server ever returns an image_url directly, just use it.)
    if (data.image_url) { applyRegenResult(momentId, data.image_url); return; }
    if (data.job_id) { pollImageJob(data.job_id, momentId); return; }
    showPanelError(momentId, 'Could not start generation.');
  })
  .catch(function(e) { showPanelError(momentId, 'Could not regenerate: ' + e.message); });
}

// ============================================================
// GRAPHIC NOVEL
// ============================================================
var novelLayoutStyle = 'Classic';

function switchNovelTab(tab) {
  if (tab === 'order' && typeof loadPrintTab === 'function') loadPrintTab();
  ['sessions', 'preview', 'order'].forEach(function(t) {
    var pane = document.getElementById('novel-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('ntab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Default to Quick View and always render it on entry; True View is only
  // shown when the user toggles to it.
  if (tab === 'preview') {
    novelPreviewMode = 'quick';
    var _npb = document.getElementById('novel-preview-mode-btn');
    if (_npb) _npb.textContent = 'Quick View';
    if (typeof novelPreviewPage !== 'undefined') novelPreviewPage = 1;
    if (typeof loadNovelPreview === 'function') loadNovelPreview(novelLayoutStyle);
  }
}

function selNovelLayout(el, layout) {
  document.querySelectorAll('#novel-tab-preview .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  novelLayoutStyle = layout;
  loadNovelPreview(layout);
}

// Phase 4 - the Story Master can produce a player's graphic novel (the player
// cannot export their own across-sessions book). state.novelAsUser is the
// chosen person's user id, or null for the Story Master's own canonical book.
function novelAsUserQ(prefix) {
  return state.novelAsUser ? (prefix + 'as_user=' + encodeURIComponent(state.novelAsUser)) : '';
}

function loadNovelPeople() {
  var sel = document.getElementById('novel-version-select');
  if (!sel) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/people')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      rows = Array.isArray(rows) ? rows : [];
      // Default to the Story Master's canonical book on entry.
      state.novelAsUser = null;
      var opts = '<option value="">Story Master \u2014 Canonical</option>';
      rows.forEach(function(p) {
        var hasV = (p.has_version === true || p.has_version === 1 || p.has_version === '1' || p.has_version === 't');
        if (p.role === 'player' && hasV) {
          var label = (p.name || p.email || 'Player') + '\u2019s version';
          opts += '<option value="' + p.user_id + '">' + label + '</option>';
        }
      });
      sel.innerHTML = opts;
      sel.value = '';
    })
    .catch(function(){});
}

function onNovelVersionChange(val) {
  state.novelAsUser = val || null;
  if (typeof syncPrintVersionDisplay === 'function') syncPrintVersionDisplay();
  loadNovelSummary();
  var prev = document.getElementById('novel-tab-preview');
  if (prev && prev.style.display !== 'none') {
    if (typeof novelPreviewPage !== 'undefined') novelPreviewPage = 1;
    loadNovelPreview(novelLayoutStyle);
  }
}

// Preview mode toggle: 'quick' = fast on-screen HTML preview for layout checks
// (default); 'wysiwyg' = the exact paged PDF that prints (slower). One mode each
// for the novel and the session preview.
var novelPreviewMode = 'quick';
function toggleNovelPreviewMode() {
  novelPreviewMode = (novelPreviewMode === 'quick') ? 'wysiwyg' : 'quick';
  var btn = document.getElementById('novel-preview-mode-btn');
  if (btn) btn.textContent = (novelPreviewMode === 'wysiwyg') ? 'True View' : 'Quick View';
  if (typeof loadNovelPreview === 'function') loadNovelPreview(novelLayoutStyle);
}
var sessionPreviewMode = 'quick';
function toggleSessionPreviewMode() {
  sessionPreviewMode = (sessionPreviewMode === 'quick') ? 'wysiwyg' : 'quick';
  var btn = document.getElementById('session-preview-mode-btn');
  if (btn) btn.textContent = (sessionPreviewMode === 'wysiwyg') ? 'True View' : 'Quick View';
  if (typeof loadPreview === 'function') loadPreview(state.layoutStyle || 'Classic');
}

function loadNovelPreview(layout) {
  var loading = document.getElementById('novel-preview-loading');
  var iframe = document.getElementById('novel-preview-iframe');
  if (!iframe) return;

  if (layout) novelLayoutStyle = layout;

  // Build/refresh the session pager
  setupNovelPager();

  var total = (state.novelSessions || []).length;
  var url = '/api/pdf/novel/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel','&') +
    (novelPreviewMode === 'wysiwyg' ? '&format=pdf' : '');
  // Paginate by session only in Quick View; True View renders the whole
  // continuous document so the PDF viewer's own page navigation moves through it.
  if (total > 1 && novelPreviewMode === 'quick') {
    url += '&page=' + novelPreviewPage;
  }

  if (loading) loading.style.display = 'flex';
  startPreviewProgress('novel-preview', novelPreviewMode);
  iframe.style.display = 'none';
  iframe.src = '';

  iframe.onload = function() {
    stopPreviewProgress('novel-preview');
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizeNovelPreviewIframe();
  };
  iframe.src = url;
}

// ---- Novel preview pager ----
var novelPreviewPage = 1;

function setupNovelPager() {
  var warning = document.getElementById('novel-preview-warning');
  var sessions = state.novelSessions || [];
  var total = sessions.length;

  // Both pager bars: top and bottom. Suffix '' = top, '-bottom' = bottom.
  var suffixes = ['', '-bottom'];

  // True View renders the real continuous document (sessions flow into each
  // other mid-page), so a session-based pager has no clean page to jump to.
  // Hide both bars there and let the PDF viewer's own nav do the moving;
  // the pager shows only in Quick View, where each session renders alone.
  if (typeof novelPreviewMode !== 'undefined' && novelPreviewMode === 'wysiwyg') {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    return;
  }

  // Only show the pagers when there is more than one session
  if (total <= 1) {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    novelPreviewPage = 1;
    return;
  }

  // Clamp current page into range
  if (novelPreviewPage < 1) novelPreviewPage = 1;
  if (novelPreviewPage > total) novelPreviewPage = total;

  // Build dropdown options once, reuse for both bars
  var opts = '';
  for (var i = 0; i < total; i++) {
    var nm = sessions[i] && sessions[i].name ? sessions[i].name : ('Session ' + (i+1));
    var label = 'Session ' + (i+1) + ' of ' + total + '  —  ' + nm;
    opts += '<option value="' + (i+1) + '"' + ((i+1) === novelPreviewPage ? ' selected' : '') + '>' +
      label + '</option>';
  }

  suffixes.forEach(function(sx) {
    var pager = document.getElementById('novel-pager' + sx);
    if (!pager) return;
    var select = document.getElementById('novel-pager-select' + sx);
    if (select) select.innerHTML = opts;
    var prev = document.getElementById('novel-pager-prev' + sx);
    var next = document.getElementById('novel-pager-next' + sx);
    if (prev) prev.disabled = (novelPreviewPage <= 1);
    if (next) next.disabled = (novelPreviewPage >= total);
    pager.style.display = 'flex';
  });

  if (warning) warning.style.display = total > 15 ? 'block' : 'none';
}

// Scroll the preview area back to the top after navigating
// Find the nearest ancestor of `el` that actually has a vertical scrollbar.
function findScrollParent(el) {
  var node = el ? el.parentElement : null;
  while (node) {
    var style = window.getComputedStyle(node);
    var oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) { console.log('[pager-scroll] no anchor element found'); return; }

  function doScroll(label) {
    var scroller = findScrollParent(anchor);
    if (scroller) {
      var aRect = anchor.getBoundingClientRect();
      var sRect = scroller.getBoundingClientRect();
      var target = Math.max(0, scroller.scrollTop + (aRect.top - sRect.top) - 12);
      // Instant jump — a smooth scroll gets interrupted by the iframe resize.
      scroller.scrollTop = target;
      console.log('[pager-scroll ' + label + '] scrolled', scroller.className || scroller.tagName,
        'to', target);
    } else {
      // No scrollable ancestor found — fall back to window + documentElement.
      var rect = anchor.getBoundingClientRect();
      var top = Math.max(0, rect.top + (window.pageYOffset || 0) - 12);
      window.scrollTo(0, top);
      document.documentElement.scrollTop = top;
      document.body.scrollTop = top;
      console.log('[pager-scroll ' + label + '] no scroll parent — used window, top', top);
    }
  }

  // Scroll now, then re-assert after the iframe reloads/resizes the page.
  doScroll('immediate');
  setTimeout(function() { doScroll('settle-1'); }, 120);
  setTimeout(function() { doScroll('settle-2'); }, 500);
}

function novelPageJump(value) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return;
  novelPreviewPage = n;
  loadNovelPreview(novelLayoutStyle);
  scrollNovelPreviewToTop();
}

function novelPagePrev() {
  if (novelPreviewPage > 1) {
    novelPreviewPage--;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

function novelPageNext() {
  var total = (state.novelSessions || []).length;
  if (novelPreviewPage < total) {
    novelPreviewPage++;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

// Grow the novel preview iframe to the full height of its content so there
// is no inner scrollbar — the user scrolls only the outer page.
function resizeNovelPreviewIframe() {
  // Preview now renders the true paged PDF; the native PDF viewer scrolls
  // internally, so keep a fixed-height pane instead of growing to content.
  var iframe = document.getElementById('novel-preview-iframe');
  var frame = document.getElementById('novel-preview-frame');
  if (iframe) iframe.style.height = '75vh';
  if (frame) frame.style.height = '';
}

// Re-measure novel preview on window resize
window.addEventListener('resize', function() {
  var iframe = document.getElementById('novel-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizeNovelPreviewIframe();
  }
});

function previewNovelPDF() {
  novelPreviewPage = 1;
  switchNovelTab('preview');
  loadNovelPreview(novelLayoutStyle);
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel','&') + '&format=pdf';
  window.open(url, '_blank');
}

function loadNovelSummary() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all' + novelAsUserQ('?'))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Sort ascending by date (oldest first) using a normalized YYYY-MM-DD key
      var sessions = Array.isArray(data) ? data : [];
      function sessionDateKey(s) {
        if (!s.session_date) return '';
        if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
        try { return s.session_date.toISOString().split('T')[0]; }
        catch (e) { return String(s.session_date); }
      }
      sessions.sort(function(a, b) {
        return sessionDateKey(a).localeCompare(sessionDateKey(b));
      });
      renderNovelSummary(sessions);
    });
}

function renderNovelSummary(sessions) {

  // Keep the ordered session list available for the preview pager
  state.novelSessions = (sessions || []).filter(novelIncluded);

  var container = document.getElementById('novel-summary-list');
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128213;</div>' +
      '<h3>No sessions yet</h3><p>Create sessions and extract moments to build your graphic novel</p></div>';
    return;
  }

  var totalMoments = 0;
  var html = sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var momentsHtml = moments.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:10px 14px;">' +
        moments.map(function(m, j) {
          return '<div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(15,10,5,0.6);border:1px solid rgba(201,168,76,0.1);">' +
            (m.image
              ? '<img src="' + m.image + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" alt="' + m.title + '" />'
              : '<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0.2;">&#128444;</div>') +
            '<div style="padding:5px 7px;">' +
              '<div style="font-size:9px;color:rgba(201,168,76,0.4);">Panel ' + (j+1) + '</div>' +
              '<div style="font-size:10px;color:var(--gold-light);font-weight:600;line-height:1.3;">' + m.title + '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="novel-empty">No moments extracted yet — open this session to generate storyboard panels</div>';

    return '<div class="novel-session-block">' +
      '<div class="novel-session-header">' +
        '<div><div class="novel-session-title">Session ' + (i+1) + ' &mdash; ' + s.name + '</div>' +
        '<div class="novel-session-date">' + formatSessionDate(s.session_date) + '</div></div>' +
        '<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' + '<label style="font-size:11px;color:var(--text-muted);display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" ' + (novelIncluded(s) ? 'checked' : '') + ' onchange="toggleNovelInclude(' + s.id + ', this.checked)"> Include in Print</label>' + '<a onclick="goToSessionPage(' + s.id + ')" style="font-size:11px;color:#2f5a86;cursor:pointer;text-decoration:underline;">Open</a>' +
          '<span class="session-badge' + (moments.length?'':' empty') + '">' + moments.length + ' panels</span>' +
          '<span class="session-badge' + (s.fork_status === 'ready' ? '' : ' session-badge-draft') + '">' + (s.fork_status === 'ready' ? 'Ready' : 'Draft') + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="novel-session-moments">' + momentsHtml + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div style="font-size:12px;color:rgba(201,168,76,0.5);margin-bottom:14px;">' +
    sessions.length + ' sessions in chronological order &middot; ' + totalMoments + ' total panels</div>' + html;
}

function showNovelPreview() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all' + novelAsUserQ('?'))
    .then(function(r) { return r.json(); })
    .then(function(data) { renderNovelPreview(Array.isArray(data) ? data : []); });
}

function renderNovelWithImages() {
  // Re-render novel panels for current session with updated images
  if (!state.moments.length) return;
  var panels = document.getElementById('novel-panels');
  if (panels) {
    panels.innerHTML = state.moments.map(function(m, i) {
      var wide = (i === 0 || i === Math.floor(state.moments.length / 2));
      var imgContent = m.image
        ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
        : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
      return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
        imgContent +
        '<div class="novel-caption">' + m.description + '</div>' +
      '</div>';
    }).join('');
  }
}

function renderNovelPreview(sessions) {
  document.getElementById('novel-summary-list').innerHTML = '';
  document.getElementById('preview-novel-btn').style.display = 'none';
  document.getElementById('novel-preview-section').style.display = 'block';

  var html = sessions.map(function(s, si) {
    var moments = s.moments || [];
    if (!moments.length) return '';
    return '<div>' +
      '<div class="novel-chapter-header">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '<div class="novel-grid" style="grid-template-columns:1fr 1fr;gap:2px;background:#222;padding:2px;">' +
      moments.map(function(m, i) {
        var wide = (i===0 || i===Math.floor(moments.length/2));
        var imgContent = m.image
          ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
          : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
        return '<div class="novel-panel' + (wide?' wide':'') + '">' +
          imgContent +
          '<div class="novel-caption">' + m.description + '</div>' +
        '</div>';
      }).join('') + '</div></div>';
  }).join('');

  document.getElementById('novel-all-panels').innerHTML = html ||
    '<div class="empty-state" style="padding:2rem;"><p>No moments extracted yet.</p></div>';
}

function hideNovelPreview() { loadNovelSummary(); }

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsForm() {
  // Settings now hosts admin/testing controls only (the global image model).
  // Profile (name / email / password) moved to the Account screen.
  fetch('/api/auth/image-model')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('settings-image-model');
      if (el && d.model) el.value = d.model;
    });
}

function saveImageModel() {
  var el = document.getElementById('settings-image-model');
  if (!el) return;
  fetch('/api/auth/image-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: el.value })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showSettingsError('model-error', d.error);
      } else {
        var ok = document.getElementById('model-success');
        if (ok) {
          ok.textContent = 'Image model saved.';
          ok.classList.remove('hidden');
          setTimeout(function() { ok.classList.add('hidden'); }, 2500);
        }
      }
    })
    .catch(function() {
      showSettingsError('model-error', 'Could not save. Please try again.');
    });
}

function saveProfile() {
  var name = document.getElementById('settings-name').value.trim();
  var email = document.getElementById('settings-email').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    document.getElementById('user-name').textContent = name;
    document.getElementById('user-menu-email').textContent = email;
    var initials = name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('profile-success').textContent = 'Profile updated!';
    document.getElementById('profile-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('profile-success').classList.add('hidden'); }, 2500);
  });
}

function saveApiKey() {
  var apiEl = document.getElementById('settings-apikey');
  if (!apiEl) return;
  var key = apiEl.value.trim();
  document.getElementById('apikey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({api_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('apikey-success').textContent = 'API key saved!';
    document.getElementById('apikey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('apikey-success').classList.add('hidden'); }, 2500);
  });
}

function saveFalKey() {
  var falEl = document.getElementById('settings-falkey');
  if (!falEl) return;
  var key = falEl.value.trim();
  document.getElementById('falkey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({fal_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('falkey-success').textContent = 'fal.ai key saved!';
    document.getElementById('falkey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('falkey-success').classList.add('hidden'); }, 2500);
  });
}

function getFalKey() {
  var el = document.getElementById('settings-falkey');
  return el ? el.value.trim() : '';
}

function changePassword() {
  var current = document.getElementById('settings-current-password').value;
  var newpw = document.getElementById('settings-new-password').value;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }

  fetch('/api/auth/password', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({current_password:current, new_password:newpw})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('password-error', data.error); return; }
    document.getElementById('settings-current-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('password-success').textContent = 'Password changed successfully!';
    document.getElementById('password-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('password-success').classList.add('hidden'); }, 2500);
  });
}

function showSettingsError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// DRAG AND DROP — Character portraits
// ============================================================

// Image slot handlers — modal upload areas
var slotFiles = {}; // Tracks new files selected for each slot

function handleSlotDragOver(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.add('drag-over');
}

function handleSlotDragLeave(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
}

function handleSlotDrop(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
  var files = e.dataTransfer.files;
  if (!files || !files[0]) return;
  if (!files[0].type.match('image.*')) { showAlert('Please drop an image file'); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    preview.src = ev.target.result;
    preview.classList.remove('hidden');
    // stopPropagation: the surrounding .image-upload-area div has its own
    // onclick that opens the file-picker. Without this stop, clicking the
    // preview image opens the lightbox AND ALSO bubbles up to fire the
    // file picker — looks to the user like a download/save dialog.
    preview.onclick = function(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      openLightbox(ev.target.result, slot.replace('image_', '').replace('_', ' '));
    };
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);
}

function clearSlot(slot) {
  slotFiles[slot] = null;
  var preview = document.getElementById('preview-' + slot);
  var placeholder = document.getElementById('placeholder-' + slot);
  var clearBtn = document.getElementById('clear-' + slot);
  var input = document.getElementById('input-' + slot);
  preview.src = '';
  preview.classList.add('hidden');
  if (placeholder) placeholder.style.display = 'flex';
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) input.value = '';
  // Mark for clearing on save
  slotFiles[slot + '_clear'] = true;
}

function loadSlotPreviews(char) {
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    var url = char ? char[slot] : null;
    slotFiles[slot] = null;
    slotFiles[slot + '_clear'] = false;

    if (url) {
      preview.src = url;
      preview.classList.remove('hidden');
      // stopPropagation: same reason as setSlotFile — keep the click from
      // bubbling to the wrapping .image-upload-area which would fire the
      // file picker.
      preview.onclick = function(e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        openLightbox(url, slot.replace('image_', '').replace('_', ' '));
      };
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    } else {
      preview.src = '';
      preview.classList.add('hidden');
      if (placeholder) placeholder.style.display = 'flex';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  });
}

// Drag and drop directly onto character cards
function setupCardDragDrop() {
  var grid = document.getElementById('char-grid');
  if (!grid) return;

  grid.addEventListener('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    // Remove drag-over from all cards first
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    // Only remove if leaving the grid entirely
    if (!grid.contains(e.relatedTarget)) {
      grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    }
  });

  grid.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });

    var card = e.target.closest('.char-card-drop');
    if (!card) return;

    var files = e.dataTransfer.files;
    if (!files || !files[0]) return;

    var file = files[0];
    if (!file.type.match('image.*')) {
      showAlert('Please drop an image file (JPG, PNG, WebP)');
      return;
    }

    var charId = parseInt(card.id.replace('char-card-', ''));
    if (!charId) return;

    uploadPortraitToChar(charId, file);
  });
}

function uploadPortraitToChar(charId, file) {
  var formData = new FormData();
  formData.append('image', file);

  // Get existing char data to preserve it
  var char = state.characters.find(function(c) { return c.id === charId; });
  if (!char) return;

  formData.append('name', char.name);
  formData.append('cls', char.cls || '');
  formData.append('description', char.description || '');
  formData.append('player_name', char.player_name || '');

  // Show uploading indicator on the card
  var card = document.getElementById('char-card-' + charId);
  if (card) {
    var avatar = card.querySelector('.char-avatar');
    if (avatar) avatar.style.opacity = '0.5';
  }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId, {
    method: 'PUT',
    body: formData
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showAlert('Error uploading portrait: ' + data.error); return; }
    showAlert('Portrait updated for ' + char.name + '!');
    loadCharacters();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); });
}

// ============================================================
// NARRATIVE
// ============================================================

var narrativeData = { intro: '', sections: [], outro: '' };

function loadNarrative() {
  fetch('/api/narrative/' + state.currentCampaign.id + '/' + state.currentSession.id + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      narrativeData = data;
      if (data.intro || (data.sections && data.sections.length) || data.outro) {
        renderNarrativeEditor(data);
        document.getElementById('narrative-empty').style.display = 'none';
        document.getElementById('narrative-content').style.display = 'block';
      } else {
        document.getElementById('narrative-empty').style.display = 'block';
        document.getElementById('narrative-content').style.display = 'none';
      }
    });
}

function generateNarrative() {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  var btn = document.getElementById('regen-narrative-btn');
  var progress = document.getElementById('narrative-progress');
  var fill = document.getElementById('narrative-progress-fill');
  var msg = document.getElementById('narrative-progress-msg');
  var errorEl = document.getElementById('narrative-error');

  if (btn) btn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');
  document.getElementById('narrative-empty').style.display = 'none';
  document.getElementById('narrative-content').style.display = 'block';
  if (progress) progress.style.display = 'block';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 5, 88);
    if (fill) fill.style.width = pct + '%';
  }, 500);

  if (msg) msg.textContent = 'Writing your story narrative...';

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;

    if (data.error) {
      if (errorEl) { errorEl.textContent = 'Error: ' + data.error; errorEl.classList.remove('hidden'); }
      return;
    }

    narrativeData = data;
    renderNarrativeEditor(data);
    if (fill) fill.style.width = '0%';
  })
  .catch(function(e) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;
    if (errorEl) { errorEl.textContent = 'Error: ' + e.message; errorEl.classList.remove('hidden'); }
  });
}

function renderNarrativeEditor(data) {
  var editor = document.getElementById('narrative-editor');
  var html = '';

  // Intro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Opening — before first panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-intro" placeholder="Opening paragraph that sets the scene...">' +
    (data.intro || '') + '</textarea>' +
  '</div>';

  // Per-moment sections
  state.moments.forEach(function(m, i) {
    var section = (data.sections || []).find(function(s) { return s.panel_index === i; }) || {};

    html += '<div class="narrative-section">' +
      '<div class="narrative-section-header">' +
        (m.image ? '<img class="narrative-section-img" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" />' : '') +
        'Panel ' + (i+1) + ' — ' + m.title +
      '</div>' +
      '<textarea class="narrative-textarea" id="narrative-before-' + i + '" placeholder="Prose leading into this panel...">' +
      (section.before || '') + '</textarea>' +
      (i < state.moments.length - 1
        ? '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— panel image appears here —</div>' +
          '<textarea class="narrative-textarea" id="narrative-after-' + i + '" placeholder="Prose bridging from this panel to the next...">' +
          (section.after || '') + '</textarea>'
        : '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— final panel image appears here —</div>') +
    '</div>';
  });

  // Outro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Closing — after final panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-outro" placeholder="Closing paragraph — what this session meant, what comes next...">' +
    (data.outro || '') + '</textarea>' +
  '</div>';

  editor.innerHTML = html;
}

function collectNarrativeFromEditor() {
  var intro = document.getElementById('narrative-intro');
  var outro = document.getElementById('narrative-outro');
  var sections = state.moments.map(function(m, i) {
    var before = document.getElementById('narrative-before-' + i);
    var after = document.getElementById('narrative-after-' + i);
    return {
      panel_index: i,
      before: before ? before.value.trim() : '',
      after: after ? after.value.trim() : ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrative() {
  var data = collectNarrativeFromEditor();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error saving: ' + result.error); return; }
    narrativeData = data;
    showAlert('Narrative saved!');
  });
}

// ============================================================
// PDF EXPORT
// ============================================================

// Preview inline below the buttons (toggles)
function previewSessionInline() {
  loadPreview(state.layoutStyle || 'Classic');
}

// Also keep old name working
function toggleSessionPreview() { previewSessionInline(); }

// Export - opens PDF page, waits for full render, then prints
function exportSessionPDF() {
  if (state.tierInfo && state.tierInfo.can_export === false) {
    showAlert('Export is not available on your current plan. Upgrade to Silver or higher to export PDFs.');
    return;
  }
  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(state.layoutStyle || 'Classic') +
    (state.currentForkId ? '&fork_id=' + state.currentForkId : '') + customOptsQ('session','&') + '&format=pdf';
  window.open(url, '_blank');
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel','&') + '&format=pdf';
  window.open(url, '_blank');
}

function previewNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id;
  window.open(url, '_blank');
}

// ============================================================
// LIGHTBOX
// ============================================================

function openLightbox(src, caption) {
  if (!src) return;

  // Remove any existing lightbox
  closeLightbox();

  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.id = 'lightbox';
  overlay.onclick = function(e) {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
      closeLightbox();
    }
  };

  var close = document.createElement('div');
  close.className = 'lightbox-close';
  close.innerHTML = '&times;';
  close.onclick = closeLightbox;

  var img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = caption || '';

  overlay.appendChild(close);
  overlay.appendChild(img);

  if (caption) {
    var cap = document.createElement('div');
    cap.className = 'lightbox-caption';
    cap.textContent = caption;
    overlay.appendChild(cap);
  }

  document.body.appendChild(overlay);

  // Close on escape key
  document.addEventListener('keydown', handleLightboxKey);
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
}

function closeLightbox() {
  var existing = document.getElementById('lightbox');
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleLightboxKey);
}

// ============================================================
// UTILITIES
// ============================================================
function showModalError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showAlert(msg) {
  var el = document.createElement('div');
  el.className = 'alert alert-success';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.15);';
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
}

// Prompt block for a storyboard panel. The Edit button shows wherever the
// caller can edit the panel image: the DM on canonical, or a player on their
// own fork. No tier gate.
function buildPromptBlock(m) {
  var _prole = state.currentCampaign && state.currentCampaign.my_role;
  var _pOwnFork = (_prole === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
  var canEdit = (_prole === 'dm' && !state.currentForkId) || _pOwnFork;
  var safe = (m.prompt || '');
  if (m.locked) {
    return '<div class="moment-prompt-text" id="prompt-text-' + m.id + '">' + safe + '</div>';
  }
  if (!canEdit) {
    return '<div class="moment-prompt-text" id="prompt-text-' + m.id + '">' + safe + '</div>';
  }
  return '<div class="moment-prompt-wrap" id="prompt-wrap-' + m.id + '">' +
    '<div class="moment-prompt-text" id="prompt-text-' + m.id + '">' + safe + '</div>' +
    '<button class="moment-prompt-edit-btn dm-only" onclick="startEditPrompt(' + m.id + ')">' +
      '&#9998; Edit prompt</button>' +
  '</div>';
}

function toggleMomentLock(momentId) {
  if (!state.currentCampaign || !state.currentSession) return;
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  if (!moment) return;
  var newLocked = moment.locked ? false : true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/moments/' + momentId + '/lock', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ locked: newLocked })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        moment.locked = data.locked;
        renderStoryboard();
      } else {
        alert((data && data.error) || 'Could not change the lock.');
      }
    })
    .catch(function() { alert('Could not change the lock.'); });
}

// Treasure-chest icons. Closed lid = archived (in YOUR archive); open lid = not.
// ============================================================
// ARCHIVES (campaign-wide gallery of saved image copies)
// ============================================================
function loadArchives() {
  var grid = document.getElementById('archives-grid');
  if (grid) grid.innerHTML = '<div class="muted" style="padding:20px;">Loading…</div>';
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(data){ state.archives = Array.isArray(data) ? data : []; renderArchives(); })
    .catch(function(){ if (grid) grid.innerHTML = '<div class="muted" style="padding:20px;">Could not load the archive.</div>'; });
}

// --- Archives screen: filters + enriched cards + prompt viewer ---
function archiveVersionLabel(a) {
  if (!a.fork_id) return null;
  if (a.fork_role === 'dm') return 'Canonical';
  return a.fork_owner_name ? (a.fork_owner_name + "'s version") : 'A version';
}

function archiveMomentLabel(a) {
  if (a.moment_title) return a.moment_title;
  if (a.moment_panel_order !== null && a.moment_panel_order !== undefined) return 'Panel ' + (a.moment_panel_order + 1);
  return null;
}

function setArchiveFilter(key, val) {
  if (!state.archiveFilters) state.archiveFilters = {};
  state.archiveFilters[key] = val;
  renderArchives();
}

function getFilteredArchives(f) {
  f = f || state.archiveFilters || {};
  var rows = (state.archives || []).slice();
  if (f.session) rows = rows.filter(function(a){ return String(a.session_id) === String(f.session); });
  if (f.moment) rows = rows.filter(function(a){ return String(a.moment_id) === String(f.moment); });
  if (f.creator) rows = rows.filter(function(a){ return String(a.archived_by) === String(f.creator); });
  if (f.type) rows = rows.filter(function(a){ return a.image_type === f.type; });
  if (f.style) rows = rows.filter(function(a){ return String(a.art_style) === String(f.style); });
  if (f.version) rows = rows.filter(function(a){ return String(a.fork_id) === String(f.version); });
  if (f.character) rows = rows.filter(function(a){ return String(a.character_id) === String(f.character); });
  rows.sort(function(a,b){
    var ta = new Date(a.created_at || 0).getTime();
    var tb = new Date(b.created_at || 0).getTime();
    return f.sort === 'oldest' ? (ta - tb) : (tb - ta);
  });
  return rows;
}

function renderArchiveFilters() {
  var host = document.getElementById('archives-filters');
  if (!host) return;
  var rows = state.archives || [];
  if (!state.archiveFilters) state.archiveFilters = { session:'', moment:'', creator:'', type:'', style:'', version:'', character:'', sort:'newest' };
  var f = state.archiveFilters;
  var sessions = {}, moments = {}, creators = {}, styles = {}, versions = {}, characters = {};
  rows.forEach(function(a){
    if (a.session_id && a.session_title) sessions[a.session_id] = a.session_title;
    if (a.moment_id) moments[a.moment_id] = archiveMomentLabel(a) || ('Moment #' + a.moment_id);
    if (a.archived_by) creators[a.archived_by] = a.archived_by_name || ('User #' + a.archived_by);
    if (a.art_style) styles[a.art_style] = a.art_style;
    if (a.fork_id) versions[a.fork_id] = (a.fork_role === 'dm') ? 'Canonical' : ((a.fork_owner_name || 'Player') + "'s version");
    if (a.character_id && a.character_name) characters[a.character_id] = a.character_name;
  });
  function opts(map, sel) {
    return Object.keys(map).map(function(k){
      return '<option value="' + escapeHtml(k) + '"' + (String(sel) === String(k) ? ' selected' : '') + '>' + escapeHtml(map[k]) + '</option>';
    }).join('');
  }
  host.innerHTML =
    '<select class="archive-filter" onchange="setArchiveFilter(\'session\', this.value)"><option value="">All sessions</option>' + opts(sessions, f.session) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'version\', this.value)"><option value="">All versions</option>' + opts(versions, f.version) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'moment\', this.value)"><option value="">All moments</option>' + opts(moments, f.moment) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'character\', this.value)"><option value="">All characters</option>' + opts(characters, f.character) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'creator\', this.value)"><option value="">Anyone</option>' + opts(creators, f.creator) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'type\', this.value)"><option value="">All types</option>' +
      '<option value="moment"' + (f.type === 'moment' ? ' selected' : '') + '>Panels</option>' +
      '<option value="character"' + (f.type === 'character' ? ' selected' : '') + '>Characters</option></select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'style\', this.value)"><option value="">All styles</option>' + opts(styles, f.style) + '</select>' +
    '<select class="archive-filter" onchange="setArchiveFilter(\'sort\', this.value)">' +
      '<option value="newest"' + (f.sort !== 'oldest' ? ' selected' : '') + '>Newest first</option>' +
      '<option value="oldest"' + (f.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option></select>' +
    '<button class="archive-filter archive-clear" onclick="clearArchiveFilters()">Clear filters</button>';
}

function clearArchiveFilters() {
  state.archiveFilters = { session:'', moment:'', creator:'', type:'', style:'', version:'', character:'', sort:'newest' };
  renderArchives();
}

function ensureArchivesLoaded(cb) {
  var cid = state.currentCampaign && state.currentCampaign.id;
  if (!cid) { cb(); return; }
  fetch('/api/campaigns/' + cid + '/archives', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(rows){
    state.archives = Array.isArray(rows) ? rows : [];
    cb();
  }).catch(function(){ state.archives = state.archives || []; cb(); });
}

function archiveFilterBarHTML(f, onchange) {
  var rows = state.archives || [];
  var sessions = {}, moments = {}, creators = {}, styles = {}, versions = {}, characters = {};
  rows.forEach(function(a){
    if (a.session_id && a.session_title) sessions[a.session_id] = a.session_title;
    if (a.moment_id) moments[a.moment_id] = archiveMomentLabel(a) || ('Moment #' + a.moment_id);
    if (a.archived_by) creators[a.archived_by] = a.archived_by_name || ('User #' + a.archived_by);
    if (a.art_style) styles[a.art_style] = a.art_style;
    if (a.fork_id) versions[a.fork_id] = (a.fork_role === 'dm') ? 'Canonical' : ((a.fork_owner_name || 'Player') + "'s version");
    if (a.character_id && a.character_name) characters[a.character_id] = a.character_name;
  });
  function opts(map, sel) {
    return Object.keys(map).map(function(k){
      return '<option value="' + escapeHtml(k) + '"' + (String(sel) === String(k) ? ' selected' : '') + '>' + escapeHtml(map[k]) + '</option>';
    }).join('');
  }
  return '<select class="archive-filter" onchange="' + onchange + '(\'session\', this.value)"><option value="">All sessions</option>' + opts(sessions, f.session) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'version\', this.value)"><option value="">All versions</option>' + opts(versions, f.version) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'moment\', this.value)"><option value="">All moments</option>' + opts(moments, f.moment) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'character\', this.value)"><option value="">All characters</option>' + opts(characters, f.character) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'creator\', this.value)"><option value="">Anyone</option>' + opts(creators, f.creator) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'type\', this.value)"><option value="">All types</option>' +
      '<option value="moment"' + (f.type === 'moment' ? ' selected' : '') + '>Panels</option>' +
      '<option value="character"' + (f.type === 'character' ? ' selected' : '') + '>Characters</option></select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'style\', this.value)"><option value="">All styles</option>' + opts(styles, f.style) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'sort\', this.value)">' +
      '<option value="newest"' + (f.sort !== 'oldest' ? ' selected' : '') + '>Newest first</option>' +
      '<option value="oldest"' + (f.sort === 'oldest' ? ' selected' : '') + '>Oldest first</option></select>';
}

function openRetouch(momentId) {
  state.retouchMomentId = momentId;
  state.retouchCharId = null;
  state.retouchSessionCharId = null;
  var ta = document.getElementById('retouch-instruction');
  if (ta) ta.value = '';
  var modal = document.getElementById('retouch-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

function closeRetouch() {
  var modal = document.getElementById('retouch-modal');
  if (modal) modal.classList.add('hidden');
}

function submitRetouch() {
  var ta = document.getElementById('retouch-instruction');
  var instruction = ta ? ta.value.trim() : '';
  if (!instruction) { if (ta) ta.focus(); return; }

  // Session-character reference target (a draft amendment image). Checked
  // before the canonical character branch below.
  if (state.retouchSessionCharId) {
    var scId = state.retouchSessionCharId;
    closeRetouch();
    var scWrapId = 'sc-review-imgwrap-' + scId;
    var scMsg = document.getElementById('sc-review-msg-' + scId);
    if (scMsg) scMsg.textContent = '';
    showBusyOverlay(scWrapId, 'Retouching', 'Applying your change\u2026');
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
          state.currentSession.id + '/characters/' + scId + '/retouch-reference', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ instruction: instruction, fal_key: getFalKey() || 'platform' })
    })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data && data.job_id) {
          // Async draft: poll the session_ref job, then show it as a draft.
          // session_characters is written only on Approve.
          pollRefJob(data.job_id, function(url){
            var wrap = document.getElementById(scWrapId);
            if (wrap) {
              wrap.innerHTML = '<img src="' + url + '" class="sc-review-img" ' +
                'id="sc-review-img-' + scId + '" alt="reference" />';
            }
            state.draftReference = state.draftReference || {};
            state.draftReference[scId] = url;
            if (scMsg) scMsg.textContent = 'Retouched image ready. Retouch again, or Approve to keep it.';
            if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
          }, function(err){
            hideBusyOverlay(scWrapId);
            if (scMsg) scMsg.textContent = 'Could not retouch: ' + err;
          });
          return;
        }
        hideBusyOverlay(scWrapId);
        if (data && data.error === 'INSUFFICIENT_TOKENS') {
          if (scMsg) scMsg.innerHTML = insufficientTokensHtml(data.message);
        } else if (scMsg) {
          scMsg.textContent = (data && (data.message || data.error)) || 'Could not retouch.';
        } else {
          alert((data && (data.message || data.error)) || 'Could not retouch.');
        }
      })
      .catch(function(e){ hideBusyOverlay(scWrapId); if (scMsg) scMsg.textContent = 'Could not retouch: ' + e.message; });
    return;
  }

  // Character reference target (vs a storyboard moment).
  if (state.retouchCharId) {
    var charId = state.retouchCharId;
    var ch = (state.characters || []).find(function(c){ return c.id === charId; });
    if (!ch) return;
    closeRetouch();
    var refTargetId = 'char-ref-image-' + charId;
    showBusyOverlay(refTargetId, 'Retouching', 'Applying your change…');
    fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/retouch-reference', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ instruction: instruction, fal_key: getFalKey() || 'platform' })
    })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data && data.job_id) {
          // Async: poll the char_ref job. The webhook writes
          // characters.canonical_reference_url, so on done we just show it.
          pollRefJob(data.job_id, function(url){ applyCanonicalRef(charId, url); }, function(err){
            hideBusyOverlay(refTargetId);
            var et = document.getElementById('char-prompt-text-' + charId);
            if (et) et.textContent = 'Could not retouch: ' + err;
            else alert('Could not retouch the reference image: ' + err);
          });
          return;
        }
        if (data && data.success) {
          ch.canonical_reference_url = data.canonical_reference_url;
          ch.archived = false;
          renderCharModalPrompt(ch);
          if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        } else {
          hideBusyOverlay(refTargetId);
          var textEl = document.getElementById('char-prompt-text-' + charId);
          if (data && data.error === 'INSUFFICIENT_TOKENS') {
            if (textEl) textEl.innerHTML = insufficientTokensHtml(data.message);
            else alert(data.message || 'You are out of tokens.');
          } else {
            alert((data && (data.message || data.error)) || 'Could not retouch the reference image.');
          }
        }
      })
      .catch(function(e){ hideBusyOverlay(refTargetId); alert('Could not retouch the reference image: ' + e.message); });
    return;
  }

  // Moment target (original behavior).
  var momentId = state.retouchMomentId;
  var moment = state.moments.find(function(m){ return m.id === momentId; });
  if (!moment) return;
  closeRetouch();
  showPanelBusy(momentId, 'Retouching');
  fetch('/api/images/retouch-moment', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      moment_id: momentId,
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      instruction: instruction,
      style: state.artStyle,
      fal_key: getFalKey() || 'platform'
    })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data.error) {
      if (data.error === 'INSUFFICIENT_TOKENS') showPanelError(momentId, insufficientTokensHtml(data.message), true);
      else showPanelError(momentId, 'Could not retouch: ' + (data.message || data.error));
      return;
    }
    if (data.image_url) { applyRegenResult(momentId, data.image_url); return; }
    if (data.job_id) { pollImageJob(data.job_id, momentId); return; }
    showPanelError(momentId, 'Could not start retouch.');
  })
  .catch(function(e){ showPanelError(momentId, 'Could not retouch: ' + e.message); });
}

function openReplacePicker(mode, id) {
  state.pickerCtx = { mode: mode };
  var f = { session:'', moment:'', creator:'', type:'', style:'', version:'', character:'', sort:'newest' };
  var tEl = document.getElementById('replace-picker-title');
  if (mode === 'moment') {
    state.pickerCtx.momentId = id;
    state.pickerCtx.sessionId = state.currentSession ? state.currentSession.id : null;
    state.pickerCtx.forkId = state.currentForkId || null;
    if (state.pickerCtx.sessionId) f.session = String(state.pickerCtx.sessionId);
    f.moment = String(id);
    if (state.currentForkId) f.version = String(state.currentForkId);
    if (tEl) tEl.textContent = 'Replace panel image from Archive';
  } else if (mode === 'canonical') {
    state.pickerCtx.characterId = id;
    state.pickerCtx.sessionId = null;
    state.pickerCtx.forkId = null;
    f.type = 'character';
    f.character = String(id);
    if (tEl) tEl.textContent = 'Replace character image from Archive';
  } else {
    state.pickerCtx.characterId = id;
    state.pickerCtx.sessionId = state.currentSession ? state.currentSession.id : null;
    state.pickerCtx.forkId = state.currentForkId || null;
    f.type = 'character';
    f.character = String(id);
    if (tEl) tEl.textContent = 'Replace character image from Archive';
  }
  state.pickerFilters = f;
  var modal = document.getElementById('replace-picker-modal');
  if (modal) modal.classList.remove('hidden');
  ensureArchivesLoaded(renderPicker);
}

function closeReplacePicker() {
  var modal = document.getElementById('replace-picker-modal');
  if (modal) modal.classList.add('hidden');
}

function setPickerFilter(key, val) {
  if (!state.pickerFilters) state.pickerFilters = {};
  state.pickerFilters[key] = val;
  renderPicker();
}

function clearPickerFilters() {
  state.pickerFilters = { session:'', moment:'', creator:'', type:'', style:'', version:'', character:'', sort:'newest' };
  renderPicker();
}

function renderPicker() {
  var fhost = document.getElementById('replace-picker-filters');
  if (fhost) fhost.innerHTML = archiveFilterBarHTML(state.pickerFilters, 'setPickerFilter') +
    '<button class="archive-filter archive-clear" onclick="clearPickerFilters()">Clear filters</button>';
  var grid = document.getElementById('replace-picker-grid');
  if (!grid) return;
  var rows = getFilteredArchives(state.pickerFilters);
  if (!rows.length) { grid.innerHTML = '<div class="archive-pick-empty">No archived images match these filters. Widen them to pull from another version, session, or character.</div>'; return; }
  grid.innerHTML = rows.map(function(a){
    var cap = '<b>' + escapeHtml(a.image_type === 'character' ? (a.character_name || 'Character') : (archiveMomentLabel(a) || 'Panel')) + '</b>';
    if (a.session_title) cap += '<br>' + escapeHtml(a.session_title);
    var ver = (!a.fork_id || a.fork_role === 'dm') ? 'Canonical' : ((a.fork_owner_name || 'Player') + "'s version");
    cap += '<br>' + escapeHtml(ver);
    if (a.art_style) cap += '<br>' + escapeHtml(a.art_style);
    return '<div class="archive-pick-item">' +
      '<img src="' + escapeHtml(a.image_url) + '" loading="lazy" onclick="applyArchiveToTarget(' + a.id + ')">' +
      '<div class="archive-pick-cap">' + cap + '</div>' +
      '<button class="archive-pick-use" onclick="applyArchiveToTarget(' + a.id + ')">Use this image</button>' +
    '</div>';
  }).join('');
}

function applyArchiveToTarget(archiveId) {
  var ctx = state.pickerCtx || {};
  var cid = state.currentCampaign && state.currentCampaign.id;
  if (!cid) return;
  var body;
  if (ctx.mode === 'moment') {
    body = { target_type: 'moment', target_moment_id: ctx.momentId };
  } else if (ctx.mode === 'canonical') {
    body = { target_type: 'canonical_character', target_character_id: ctx.characterId };
  } else {
    body = { target_type: 'character', target_character_id: ctx.characterId, session_id: ctx.sessionId, fork_id: ctx.forkId };
  }
  fetch('/api/campaigns/' + cid + '/archives/' + archiveId + '/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(function(r){ return r.json(); }).then(function(data){
    if (data && data.error) { alert(data.message || data.error); return; }
    closeReplacePicker();
    if (ctx.mode === 'moment') { if (typeof refreshStoryboardImages === 'function') refreshStoryboardImages(); }
    else if (ctx.mode === 'canonical') {
      var _ch = charById(ctx.characterId);
      if (_ch && data.image_url) { _ch.canonical_reference_url = data.image_url; _ch.archived = false; renderCharModalPrompt(_ch); }
    }
    else { if (typeof loadSessionCharacters === 'function') loadSessionCharacters(); }
  }).catch(function(e){ alert('Replace failed: ' + e.message); });
}

function viewArchivePrompt(id) {
  var a = (state.archives || []).find(function(x){ return x.id === id; });
  if (!a) return;
  openPromptModal(a.image_prompt, a.title || 'Prompt');
}

function openPromptModal(text, title) {
  closeLightbox();
  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.id = 'lightbox';
  overlay.onclick = function(e){ if (e.target === overlay || e.target.classList.contains('lightbox-close')) closeLightbox(); };
  var close = document.createElement('div');
  close.className = 'lightbox-close';
  close.innerHTML = '&times;';
  close.onclick = closeLightbox;
  var box = document.createElement('div');
  box.className = 'prompt-modal-box';
  var h = document.createElement('div'); h.className = 'prompt-modal-title'; h.textContent = title || 'Prompt';
  var bodyEl = document.createElement('div'); bodyEl.className = 'prompt-modal-text';
  bodyEl.textContent = (text && String(text).trim()) ? text : '(No prompt was saved with this image.)';
  box.appendChild(h); box.appendChild(bodyEl);
  overlay.appendChild(close); overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderArchives() {
  renderArchiveFilters();
  var grid = document.getElementById('archives-grid');
  if (!grid) return;
  var meId = (state.user && state.user.id) || null;
  var isDM = (state.currentCampaign && state.currentCampaign.my_role === 'dm');
  if (!(state.archives || []).length) {
    grid.innerHTML = '<div class="muted" style="padding:20px;">Nothing archived yet. Use the treasure-chest button on any image to save a copy here.</div>';
    return;
  }
  var rows = getFilteredArchives();
  if (!rows.length) {
    grid.innerHTML = '<div class="muted" style="padding:20px;">No archives match these filters.</div>';
    return;
  }
  grid.innerHTML = rows.map(function(a){
    var canDelete = isDM || (meId && a.archived_by === meId);
    var when = a.created_at ? new Date(a.created_at).toLocaleDateString() : '';
    var typeLabel = a.image_type === 'character' ? 'Character' : 'Panel';
    var ver = archiveVersionLabel(a);
    var mom = archiveMomentLabel(a);
    var meta = '<div class="archive-row"><span>Type</span><b>' + typeLabel + '</b></div>';
    if (a.session_title) meta += '<div class="archive-row"><span>Session</span><b>' + escapeHtml(a.session_title) + '</b></div>';
    if (ver) meta += '<div class="archive-row"><span>Version</span><b>' + escapeHtml(ver) + '</b></div>';
    if (mom) meta += '<div class="archive-row"><span>Moment</span><b>' + escapeHtml(mom) + '</b></div>';
    if (a.art_style) meta += '<div class="archive-row"><span>Style</span><b>' + escapeHtml(a.art_style) + '</b></div>';
    if (a.character_name) meta += '<div class="archive-row"><span>Character</span><b>' + escapeHtml(a.character_name) + '</b></div>';
    meta += '<div class="archive-row"><span>Archived by</span><b>' + escapeHtml(a.archived_by_name || 'someone') + (when ? ' &middot; ' + when : '') + '</b></div>';
    var promptBtn = a.image_prompt ? '<button class="archive-prompt-btn" onclick="viewArchivePrompt(' + a.id + ')" title="View the prompt for this image">&#128196; View Prompt</button>' : '';
    return '<div class="archive-card">' +
      '<div class="archive-thumb">' +
        '<img loading="lazy" src="' + a.image_url + '" alt="' + escapeHtml(a.title || 'archived image') + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />' +
        promptBtn +
      '</div>' +
      '<div class="archive-meta">' +
        '<div class="archive-title">' + escapeHtml(a.title || '(untitled)') + '</div>' +
        meta +
        '<div class="archive-actions">' +
          (isDM ? '<label class="archive-cover-toggle" title="Use as campaign cover"><input type="checkbox" ' + ((state.currentCampaign && state.currentCampaign.cover_image_url === a.image_url) ? 'checked' : '') + ' onchange="setCampaignCover(' + a.id + ')" /> Cover</label>' : '') +
          (canDelete ? '<button class="btn btn-sm archive-del" onclick="deleteArchive(' + a.id + ')">&#10005; Remove</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function deleteArchive(id) {
  if (!confirm('Remove this image from the campaign Archive? This permanently deletes the saved copy.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives/' + id, { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.success) {
        showAlert('Removed from the Archive.');
        state.archives = (state.archives || []).filter(function(a){ return a.id !== id; });
        renderArchives();
      } else {
        alert((data && data.error) || 'Could not remove the archive.');
      }
    })
    .catch(function(){ alert('Could not remove the archive.'); });
}

function archiveChestIcon(isClosed) {
  if (isClosed) {
    return '<img src="/images/chest-closed.png" alt="archived" />';
  }
  return '<img src="/images/chest-open.png" alt="not archived" />';
}

function isMomentArchived(m) {
  return m && (m.archived === true || m.archived === 1 || m.archived === '1' || m.archived === 't');
}

// Toggle: archive my copy if not archived, else remove MY archive entry.
function toggleArchiveMoment(momentId) {
  if (!state.currentCampaign) return;
  var moment = (state.moments || []).find(function(m){ return m.id === momentId; });
  if (!moment || !moment.image) { alert('This panel has no image to archive yet.'); return; }
  var isArchived = isMomentArchived(moment);
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', {
    method: isArchived ? 'DELETE' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ image_type: 'moment', moment_id: momentId })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.success) {
        moment.archived = !isArchived;
        showAlert(isArchived ? 'Removed from your Archive.' : 'Image saved to your Archive.');
        renderStoryboard();
      } else {
        alert((data && data.error) || 'Could not update the Archive.');
      }
    })
    .catch(function(){ alert('Could not update the Archive.'); });
}

// Archive toggle for a character's per-version reference image (Stage-3 panel).
function toggleArchiveCharSnapshot(characterId) {
  var rows = state.sessionCharacterRows || [];
  var r = rows.find(function(x){ return x.character_id === characterId; });
  if (!r) return;
  if (!(r.reference_url || r.canonical_reference_url)) { alert('No reference image to archive yet.'); return; }
  var isArchived = isMomentArchived(r);
  var btn = document.getElementById('sc-archive-' + characterId);
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', {
    method: isArchived ? 'DELETE' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ image_type: 'character', character_id: characterId,
                           session_id: state.currentSession.id, fork_id: r.fork_id })
  })
    .then(function(res){ return res.json(); })
    .then(function(data){
      if (data && data.success) {
        r.archived = !isArchived;
        showAlert(isArchived ? 'Removed from your Archive.' : 'Reference image saved to your Archive.');
        if (btn) {
          btn.className = 'panel-pill' + (r.archived ? ' is-on' : '');
          btn.title = r.archived ? 'In your Archive \u2014 click to remove' : 'Save this reference image to your Archive';
          btn.textContent = r.archived ? 'Archived' : 'Archive';
        }
      } else {
        alert((data && data.error) || 'Could not update the Archive.');
      }
    })
    .catch(function(){ alert('Could not update the Archive.'); });
}

// Archive toggle for a character's CANONICAL reference image (character modal).
function toggleArchiveCharCanonical(charId) {
  var char = (state.characters || []).find(function(c){ return c.id === charId; });
  if (!char) return;
  if (!char.canonical_reference_url) { alert('No reference image to archive yet.'); return; }
  var isArchived = isMomentArchived(char);
  var btn = document.getElementById('char-archive-' + charId);
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', {
    method: isArchived ? 'DELETE' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ image_type: 'character', character_id: charId })
  })
    .then(function(res){ return res.json(); })
    .then(function(data){
      if (data && data.success) {
        char.archived = !isArchived;
        showAlert(isArchived ? 'Removed from your Archive.' : 'Reference image saved to your Archive.');
        if (btn) {
          btn.className = 'panel-pill' + (char.archived ? ' is-on' : '');
          btn.title = char.archived ? 'In your Archive — click to remove' : 'Save this reference image to your Archive';
          btn.textContent = char.archived ? 'Archived' : 'Archive';
        }
      } else {
        alert((data && data.error) || 'Could not update the Archive.');
      }
    })
    .catch(function(){ alert('Could not update the Archive.'); });
}

function startEditPrompt(momentId) {
  var wrap = document.getElementById('prompt-wrap-' + momentId);
  if (!wrap) return;
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  var current = moment ? (moment.prompt || '') : '';
  wrap.innerHTML =
    '<textarea class="moment-prompt-editor" id="prompt-editor-' + momentId + '">' +
      current + '</textarea>' +
    '<div class="moment-prompt-actions">' +
      '<button class="btn btn-sm btn-primary" onclick="savePrompt(' + momentId + ')">Save</button>' +
      '<button class="btn btn-sm" onclick="cancelEditPrompt(' + momentId + ')">Cancel</button>' +
    '</div>';
  var ta = document.getElementById('prompt-editor-' + momentId);
  if (ta) ta.focus();
}

function cancelEditPrompt(momentId) {
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  var wrap = document.getElementById('prompt-wrap-' + momentId);
  if (wrap && moment) {
    wrap.innerHTML =
      '<div class="moment-prompt-text" id="prompt-text-' + momentId + '">' + (moment.prompt || '') + '</div>' +
      '<button class="moment-prompt-edit-btn dm-only" onclick="startEditPrompt(' + momentId + ')">' +
        '&#9998; Edit prompt</button>';
  }
}

function savePrompt(momentId) {
  var ta = document.getElementById('prompt-editor-' + momentId);
  if (!ta) return;
  var newPrompt = ta.value;
  if (!state.currentCampaign || !state.currentSession) return;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/moments/' + momentId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success) {
        var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
        if (moment) moment.prompt = newPrompt;
        cancelEditPrompt(momentId);
      } else {
        ta.disabled = false;
        alert((data && data.error) || 'Could not save the prompt.');
      }
    })
    .catch(function() {
      ta.disabled = false;
      alert('Could not save the prompt.');
    });
}

function openImagePrompt(momentId) {
  state.imagePromptMomentId = momentId;
  var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
  var ta = document.getElementById('image-prompt-text');
  if (ta) ta.value = moment ? (moment.prompt || '') : '';
  var modal = document.getElementById('image-prompt-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

function closeImagePrompt() {
  var modal = document.getElementById('image-prompt-modal');
  if (modal) modal.classList.add('hidden');
}

function saveImagePrompt() {
  var momentId = state.imagePromptMomentId;
  if (!momentId) { closeImagePrompt(); return; }
  var ta = document.getElementById('image-prompt-text');
  if (!ta) { closeImagePrompt(); return; }
  if (!state.currentCampaign || !state.currentSession) { closeImagePrompt(); return; }
  var newPrompt = ta.value;
  ta.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' +
        state.currentSession.id + '/moments/' + momentId, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: newPrompt })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      ta.disabled = false;
      if (data && data.success) {
        var moment = (state.moments || []).find(function(m) { return m.id === momentId; });
        if (moment) moment.prompt = newPrompt;
        closeImagePrompt();
      } else {
        showAlert((data && data.error) || 'Could not save the prompt.');
      }
    })
    .catch(function() {
      ta.disabled = false;
      showAlert('Could not save the prompt.');
    });
}

function renderStoryboard() {
  document.getElementById('sb-empty').style.display = 'none';
  document.getElementById('sb-content').style.display = 'block';

  var narrative = state.narrativeData || { intro: '', sections: [], outro: '' };
  // Narrative is editable on the version you OWN: the DM on canonical, or a
  // player on their own version. Read-only when viewing anyone else's.
  var _nRole = state.currentCampaign && state.currentCampaign.my_role;
  var canEditNarr = (_nRole === 'dm' && !state.currentForkId) ||
    ((_nRole === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId)));
  var typeLabel = {combat:'Combat',drama:'Drama',discovery:'Discovery',humor:'Humor'};

  // True alternating grid — narrative and image panels flow together
  // [Opening] [Panel 1] [Between 1-2] [Panel 2] [Between 2-3] [Panel 3] ...

  function buildPanel(m, i) {
    var needsWatermark = !!state.inFreeTrial;
    var imgHtml = m.image
      ? '<div class="' + (needsWatermark ? 'watermarked' : '') + '"><img class="moment-img-generated" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" /></div>'
      : '<div class="moment-img-placeholder">' +
          '<div style="font-size:32px;opacity:0.3;">&#128444;</div>' +
          '<div style="font-size:11px;color:rgba(201,168,76,0.3);margin-top:6px;">No image yet</div>' +
        '</div>';
    var _shapeVal = (['wide','tall','square','panoramic','tower','fullpage'].indexOf(m.shape) >= 0 ? m.shape : 'standard');
    var _canLock = canEditCurrentStatus();
    var lockBtn = '';
    if (m.image && _canLock) {
      lockBtn = '<button class="panel-pill' + (m.locked ? ' is-on' : '') + '" onclick="toggleMomentLock(' + m.id + ')" title="' + (m.locked ? 'Locked - click to unlock (Regenerate All skips it)' : 'Lock this image (Regenerate All skips it)') + '">' + (m.locked ? 'Unlock' : 'Lock') + '</button>';
    } else if (m.locked) {
      lockBtn = '<span class="panel-pill is-on is-static" title="Locked by the version owner">Locked</span>';
    }
    var regenBtn = m.locked
      ? '<button class="panel-pill dm-only" disabled title="Unlock to regenerate">Regenerate</button>'
      : '<button class="panel-pill dm-only" onclick="regenImage(' + m.id + ', ' + i + ')" title="Regenerate this image from scratch">Regenerate</button>';
    var editPromptBtn = m.locked
      ? '<button class="panel-pill dm-only" disabled title="Unlock to edit the prompt">Edit prompt</button>'
      : '<button class="panel-pill dm-only" onclick="openImagePrompt(' + m.id + ')" title="Edit the image prompt, then Regenerate to apply">Edit prompt</button>';
    var retouchBtn = m.locked
      ? '<button class="panel-pill dm-only" disabled title="Unlock to retouch">Retouch</button>'
      : '<button class="panel-pill dm-only" onclick="openRetouch(' + m.id + ')" title="Keep this image and change just one thing">Retouch</button>';
    var replaceBtn = m.locked
      ? '<button class="panel-pill dm-only" disabled title="Unlock to replace">Replace</button>'
      : '<button class="panel-pill dm-only" onclick="openReplacePicker(\'moment\', ' + m.id + ')" title="Replace with an image from the Archive">Replace</button>';
    var archiveBtn = '';
    if (m.image) {
      var _arched = isMomentArchived(m);
      archiveBtn = '<button class="panel-pill' + (_arched ? ' is-on' : '') +
        '" onclick="toggleArchiveMoment(' + m.id + ')" title="' +
        (_arched ? 'In your Archive - click to remove' : 'Save this image to your Archive') +
        '">' + (_arched ? 'Archived' : 'Archive') + '</button>';
    }
    var msection = (narrative.sections || []).find(function(s){ return s.panel_index === i; }) || {};
    return '<div class="storyboard-panel" id="moment-card-' + m.id + '">' +
      '<div class="storyboard-panel-img">' +
        imgHtml + '<div class="panel-img-actions">' + editPromptBtn + regenBtn + retouchBtn + replaceBtn + lockBtn + archiveBtn + '</div>' +
      '</div>' +
      '<div class="storyboard-panel-meta">' +
        '<span class="moment-num">Panel ' + (i+1) + '</span>' +
        '<span class="moment-title">' + m.title + '</span>' +
        '<span class="moment-meta-list">' + escapeHtml(m.style ? artStyleName(m.style) : 'Unknown') + ', ' + (typeLabel[m.type]||m.type) + ', ' + (_shapeVal.charAt(0).toUpperCase() + _shapeVal.slice(1)) + '</span>' +
      '</div>' +
      buildNarrative('narrative-moment-' + i, 'Panel ' + (i + 1) + ' moment', 'narrative-moment-box-' + i, 'Narrate what this panel shows...', msection.before || '', "regenNarrativeSection('moment'," + i + ")", true) +
    '</div>';
  }

  function buildNarrative(id, label, textareaId, placeholder, value, regenCall, autosave) {
    var regenBtn = canEditNarr
      ? '<button class="narrative-regen-btn" onclick="' + regenCall + '">&#8635; Regen</button>'
      : '';
    // Option A — the gap's "prompt" is its Direction. Mirror the image panels'
    // prompt block (same .moment-prompt-* classes): show the Direction text with
    // an "Edit prompt" button that opens the Direction modal. Always reflects the
    // current direction (incl. anything set on the Review tab); read-only echo
    // for viewers who can't edit this version.
    var gapKey = (id === 'narrative-opening') ? 'opening'
      : (id === 'narrative-closing') ? 'closing'
      : (id.indexOf('narrative-moment-') === 0) ? 'moment:' + id.replace('narrative-moment-', '')
      : 'between:' + id.replace('narrative-between-', '');
    var domKey = gapKey.replace(/[^a-z0-9]/gi, '-');
    var dirText = (state.narrativeDirections && state.narrativeDirections[gapKey]) || '';
    var dirBody = dirText
      ? escapeHtmlReview(dirText)
      : 'No direction set \u2014 using the default narrative style.';
    var dirEditBtn = canEditNarr
      ? '<button class="moment-prompt-edit-btn dm-only" id="narr-dir-btn-' + domKey + '" ' +
        'onclick="openNarrDirection(\'' + gapKey + '\', \'' + escapeHtmlReview(label) + '\')">&#9998; Edit prompt</button>'
      : '';
    var dirBlock = '<div class="moment-prompt-wrap narr-dir-wrap" id="narr-dir-' + domKey + '">' +
      '<div class="moment-prompt-text narr-dir-text' + (dirText ? '' : ' narr-dir-empty') + '" id="narr-dir-text-' + domKey + '">' + dirBody + '</div>' +
      dirEditBtn +
    '</div>';
    // When editable, every box auto-saves on input (so between-panel prose
    // persists too, not just opening/closing); otherwise it is read-only.
    var _nsName = narrStyleName(state.narrativeStyleUsed ? state.narrativeStyleUsed : (state.narrativeStyle || 'classic'));
    return '<div class="narrative-panel" id="' + id + '">' +
      '<div class="narrative-block-header">' +
        '<span>&#9998; ' + label + ' <span class="narr-block-style">Style: ' + escapeHtml(_nsName) + '</span></span>' +
        regenBtn +
      '</div>' +
      '<textarea class="narrative-inline-box" id="' + textareaId + '" placeholder="' + placeholder + '"' +
        (canEditNarr ? ' oninput="scheduleNarrativeSave()"' : ' readonly') + '>' +
      (value || '') + '</textarea>' +
      dirBlock +
    '</div>';
  }

  // Build alternating array: opening, panel0, between0-1, panel1, between1-2, panel2, ..., closing
  var cells = [];

  // Opening narrative
  cells.push(buildNarrative('narrative-opening', 'Opening', 'narrative-intro-box',
    'Opening paragraph...', narrative.intro, 'regenNarrativeSection(\'opening\')', true));

  // Alternate panels and between-narratives
  state.moments.forEach(function(m, i) {
    cells.push(buildPanel(m, i));
    if (i < state.moments.length - 1) {
      var section = (narrative.sections||[]).find(function(s){return s.panel_index===i;}) || {};
      cells.push(buildNarrative(
        'narrative-between-' + i,
        'Panel ' + (i+1) + ' → ' + (i+2),
        'narrative-between-box-' + i,
        'Bridge the story...', section.after || '',
        'regenNarrativeSection(\'between\',' + i + ')', false
      ));
    }
  });

  // Closing narrative
  cells.push(buildNarrative('narrative-closing', 'Closing', 'narrative-outro-box',
    'Closing paragraph...', narrative.outro, 'regenNarrativeSection(\'closing\')', true));

  document.getElementById('moments-grid').innerHTML = '<div class="panels-grid">' + cells.join('') + '</div>';
}

// STATE
// ============================================================
var state = {
  user: null,
  userTier: null,
  campaigns: [],
  currentCampaign: null,
  layoutStyle: 'Classic',
  currentSession: null,
  currentForkId: null,
  sessionForks: [],
  characters: [],
  sessions: [],
  moments: [],
  artStyle: 'High fantasy illustration',
  currentView: 'campaigns'
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  checkAuth();
  var charImageInput = document.getElementById('char-image-input');
  if (charImageInput) charImageInput.addEventListener('change', previewCharImage);
  var sessionDate = document.getElementById('session-date');
  if (sessionDate) sessionDate.value = new Date().toISOString().split('T')[0];

  // Close user menu when clicking outside
  document.addEventListener('click', function(e) {
    var menu = document.getElementById('user-menu');
    var btn = document.querySelector('.user-menu-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) {
      menu.classList.remove('open');
    }
  });

  // CRITICAL: Prevent browser from opening dragged files as new pages
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop', function(e) { e.preventDefault(); });
});

// ============================================================
// AUTH
// ============================================================
function checkAuth() {
  fetch('/api/auth/me')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.authenticated) { window.location.href = '/'; return; }
      state.user = data;
      // Tier info drives feature gates (prompt editing, watermark, export)
      state.userTier = data.tierFeatures || null;
      state.inFreeTrial = !!data.inFreeTrial;
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';
      var navSettingsItem = document.getElementById('nav-settings-item');
      if (navSettingsItem) navSettingsItem.style.display = data.is_admin ? 'block' : 'none';

      // Load saved API key into settings field
      fetch('/api/auth/apikey')
        .then(function(r) { return r.json(); })
        .then(function(k) {
          if (k.api_key) {
            var akEl = document.getElementById('settings-apikey');
            if (akEl) akEl.value = k.api_key;
          }
        });

      loadCampaigns();
    });
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' })
    .then(function() { window.location.href = '/'; });
}

function toggleUserMenu() {
  document.getElementById('user-menu').classList.toggle('open');
}

function closeUserMenu() {
  document.getElementById('user-menu').classList.remove('open');
}

// Get API key — prefer settings field, fall back to nothing
function getApiKey() {
  var el = document.getElementById('settings-apikey');
  return el ? el.value.trim() : '';
}

// ============================================================
// BREADCRUMB
// ============================================================
function setBreadcrumb(items) {
  var bc = document.getElementById('breadcrumb');
  var html = '';
  items.forEach(function(item, i) {
    if (i > 0) html += '<span class="breadcrumb-sep">&#8250;</span>';
    if (item.action && i < items.length - 1) {
      html += '<span class="breadcrumb-link" onclick="' + item.action + '">' + item.label + '</span>';
    } else {
      html += '<span class="breadcrumb-current">' + item.label + '</span>';
    }
  });
  bc.innerHTML = html;
}

// ============================================================
// VIEW MANAGEMENT
// ============================================================
function showView(view) {
  if (view === 'settings' && !(state.user && state.user.is_admin)) { view = 'account'; }
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings','members','archives'];
  views.forEach(function(v) {
    var el = document.getElementById('view-' + v);
    if (el) el.style.display = 'none';
  });

  var el = document.getElementById('view-' + view);
  if (el) el.style.display = 'block';
  state.currentView = view;

  // Update sidebar active states
  document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });

  if (view === 'campaigns') {
    var _sc=document.getElementById('snav-campaigns'); if(_sc)_sc.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    state.currentCampaign = null;
    state.currentSession = null;
    setBreadcrumb([{label:'My Campaigns'}]);
    loadCampaigns();
  } else if (view === 'account') {
    var sn = document.getElementById('snav-account');
    if (sn) sn.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Account'}
    ]);
    loadAccount();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
}

function showCampaignSection(section) {
  // A player can only enter the Graphic Novel if the SM enabled it for this campaign.
  if (section === 'novel' && state.currentCampaign) {
    var _c = state.currentCampaign;
    var _allow = (_c.allow_player_novel_access === true || _c.allow_player_novel_access === 1 || _c.allow_player_novel_access === 't' || _c.allow_player_novel_access === 'true');
    if (_c.my_role !== 'dm' && !_allow) { section = 'sessions'; }
  }
  showView(section);

  // Show campaign subnav
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

  // Sidebar active — novel has no sidebar item so skip it
  if (section !== 'novel') {
    var navId = 'snav-' + section;
    var el = document.getElementById(navId);
    if (el) el.classList.add('active');
  }

  // Breadcrumb
  var sectionLabel = {sessions:'Sessions', characters:'Characters', assets:'Asset Library', novel:'Publish', members:'Members', archives:'Archives'}[section] || section;
  setBreadcrumb([
    {label:'My Campaigns', action:"showView('campaigns')"},
    {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
    {label:sectionLabel}
  ]);

  if (section === 'sessions') loadSessions();
  if (section === 'characters') { loadCharacters(); renderCampaignLockBanner(); }
  if (section === 'novel') { loadNovelPeople(); loadNovelSummary(); }
  if (section === 'assets') loadAssets();
  if (section === 'archives') loadArchives();
  if (section === 'members') loadMembersTab();

  // Phase 3 — apply role-based visibility (hide DM-only UI for players).
  applyRoleVisibility();
}

// ============================================================
// CAMPAIGNS
// ============================================================
function loadCampaigns() {
  fetch('/api/campaigns')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.campaigns = Array.isArray(data) ? data : [];
      renderCampaigns();
    });
}

function renderCampaigns() {
  var grid = document.getElementById('campaigns-grid');
  var html = state.campaigns.map(function(c) {
    return '<div class="campaign-card" onclick="selectCampaign(' + c.id + ')">' +
      (c.cover_image_url
        ? '<div class="campaign-card-cover" style="background-image:url(\'' + encodeURI(c.cover_image_url) + '\');"></div>'
        : '<div class="campaign-card-icon"><img src="/images/Campaignia_Icon.png" alt="" /></div>') +
      '<div class="campaign-card-name">' + c.name + '</div>' +
      '<div class="campaign-card-desc">' + (c.description || 'No description') + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">' +
        '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
        (c.my_role === 'dm' ? '<button class="campaign-card-menu-btn" onclick="openCampaignSettings(' + c.id + ', event)" title="Campaign settings">&#8943;</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
  html += '<div class="add-campaign-card" onclick="openCampaignModal()"><div class="plus">+</div><span>New campaign</span></div>';
  grid.innerHTML = html;
}

function setCampaignElements() {
  // sessions-title is owned by renderSessions() so it can include the session count
  var ct = document.getElementById('novel-cover-title');
  var cs = document.getElementById('novel-cover-sub');
  if (ct) ct.textContent = state.currentCampaign.name;
  if (cs) cs.textContent = state.currentCampaign.description || '';
  if (state.currentCampaign) loadTierInfo(state.currentCampaign.id);
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('campaign-modal-error', data.error); return; }
    closeCampaignModal();
    loadCampaigns();
  });
}

// ============================================================
// SESSIONS
// ============================================================

function formatSessionDate(dateVal) {
  if (!dateVal) return '';
  // PostgreSQL returns Date objects, SQLite returns strings
  var dateStr = typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
  // Handle both 'YYYY-MM-DD' and full ISO strings
  var datePart = dateStr.split('T')[0];
  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
function loadSessions() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.sessions = Array.isArray(data) ? data : [];
      renderSessions();
    });
}

function renderSessions() {
  var list = document.getElementById('sessions-list');

  // Campaign name + count + description in the header (DM can edit inline).
  renderCampaignHeaderDisplay();

  if (!state.sessions.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128203;</div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    return;
  }

  // Newest first — sort by session date descending
  var ordered = state.sessions.slice().sort(function(a, b) {
    var da = (a.session_date || '').toString().split('T')[0];
    var db = (b.session_date || '').toString().split('T')[0];
    if (da < db) return 1;
    if (da > db) return -1;
    return 0;
  });

  list.innerHTML = ordered.map(function(s) {
    var thumb = s.first_image_url
      ? '<img class="session-thumb" src="' + s.first_image_url + '" alt="" loading="lazy" />'
      : '';
    var readyChip = (s.player_access_status === 'ready')
      ? '<span class="session-badge">Ready</span>'
      : '<span class="session-badge session-badge-draft">Draft</span>';
    var transcriptChip = s.transcript
      ? '<span class="session-badge">Has transcript</span>'
      : '<span class="session-badge empty">No transcript</span>';
    var menuId = 'session-menu-' + s.id;
    var deleteMenu =
      '<div class="row-menu dm-only">' +
        '<button class="row-menu-btn" onclick="event.stopPropagation();toggleRowMenu(\'' + menuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + menuId + '">' +
          '<button class="row-menu-item row-menu-item-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete session</button>' +
        '</div>' +
      '</div>';
    return '<div class="session-item" onclick="selectSession(' + s.id + ')">' +
      '<div class="session-item-left">' +
        thumb +
        '<div>' +
          '<div class="session-name">' + s.name + '</div>' +
          '<div class="session-date">' + formatSessionDate(s.session_date) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="flex gap-1 items-center">' +
        readyChip +
        transcriptChip +
        deleteMenu +
      '</div>' +
    '</div>';
  }).join('');
}

function openSessionModal() {
  document.getElementById('session-name').value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showModalError('session-modal-error', data.error); return; }
    closeSessionModal();
    // Drop the user straight into the newly created session (the backend
    // returns the full session row, so data.id is the new id). Fall back to
    // just refreshing the list if no id came back.
    if (data && data.id) { selectSession(data.id); }
    else { loadSessions(); }
  });
}

function updateSessionDate(value) {
  if (!value || !state.currentCampaign || !state.currentSession) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ session_date: value })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.id) {
        state.currentSession = data;
        if (typeof loadSessions === 'function') loadSessions();
      }
    })
    .catch(function(){});
}

function deleteSession(id) {
  if (!confirm('Delete this session and all its moments? This cannot be undone.')) return;
  // Backend requires a confirmation flag in the body; without it the
  // route returns {error:'Confirmation required'} (HTTP 200) and the
  // delete silently no-ops. Send it, and surface any real error.
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) {
        if (typeof showAlert === 'function') { showAlert(data.error); } else { alert(data.error); }
        return;
      }
      loadSessions();
    })
    .catch(function(e) {
      if (typeof showAlert === 'function') { showAlert('Delete failed: ' + e.message); } else { alert('Delete failed: ' + e.message); }
    });
}

function selectSession(id) {
  // Clear previous session state
  state.moments = [];
  state.currentForkId = null;
  state.narrativeData = { intro: '', sections: [], outro: '' };
  var sbEmpty = document.getElementById('sb-empty');
  var sbContent = document.getElementById('sb-content');
  if (sbEmpty) sbEmpty.style.display = 'block';
  if (sbContent) sbContent.style.display = 'none';

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + id + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      document.getElementById('session-detail-name').textContent = data.name;
      // Set editable date input
      var dateInput = document.getElementById('session-detail-date-input');
      if (dateInput && data.session_date) {
        var dateStr = typeof data.session_date === 'string'
          ? data.session_date.split('T')[0]
          : data.session_date.toISOString().split('T')[0];
        dateInput.value = dateStr;
      }
      // date now handled by session-detail-date-input

      // Load narrative data
      state.narrativeData = {
        intro: data.narrative_intro || '',
        sections: data.narrative_sections ? JSON.parse(data.narrative_sections) : [],
        outro: data.narrative_outro || ''
      };
      // Per-gap narrative directions for this version (Pass 1) — drives the
      // Direction pills on Review and the "prompt" blocks under the Storyboard
      // narrative panels.
      try { state.narrativeDirections = data.narrative_directions ? JSON.parse(data.narrative_directions) : {}; }
      catch (e) { state.narrativeDirections = {}; }
      // Narrative Styles: this version's narrative voice preset (defaults to 'classic').
      state.narrativeStyle = (data && data.narrative_style) ? data.narrative_style : 'classic';
      state.narrativeStyleUsed = (data && data.narrative_style_used) ? data.narrative_style_used : state.narrativeStyle;
      if (typeof refreshNarrStyleButtons === 'function') refreshNarrStyleButtons();

      if (state.moments.length) renderStoryboard();

      // Load last used art style for this campaign
      if (typeof loadLastArtStyle === 'function') loadLastArtStyle(data.art_style_override || data.art_style, data.layout_style);

      // Show session detail view FIRST
      var views = ['campaigns','sessions','characters','novel','session-detail','settings'];
      views.forEach(function(v) {
        var el = document.getElementById('view-' + v);
        if (el) el.style.display = 'none';
      });
      document.getElementById('view-session-detail').style.display = 'block';

      // Now that view is visible, populate fields
      switchSessionTab('notes');
      // Phase 3: apply role-based UI (hides DM-only buttons, sets readonly on Notes textareas for players)
      applyRoleVisibility();
      // Phase 3 Deploy 3 — initialize access-status (Ready/Draft) UI
      if (typeof initAccessStatusUI === 'function') initAccessStatusUI(data.fork_status || data.player_access_status || 'draft');
      if (typeof loadSessionForks === 'function') loadSessionForks(id);
      setTimeout(function() {
        updateNotesBox(data);
      }, 50);

      // Update sidebar
      document.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
      var _sx=document.getElementById('snav-sessions'); if(_sx)_sx.classList.add('active');
      var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
      var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;

      // Breadcrumb
      setBreadcrumb([
        {label:'My Campaigns', action:"showView('campaigns')"},
        {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
        {label:'Sessions', action:"showCampaignSection('sessions')"},
        {label:data.name}
      ]);
    });
}

function saveTranscript() {
  var transcript = document.getElementById('transcript-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({transcript:transcript})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    showAlert('Transcript saved!');
  });
}

function saveNotes() {
  var notes = document.getElementById('session-notes-input').value.trim();
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({session_notes:notes})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    state.currentSession = data;
    var saved = document.getElementById('notes-saved');
    saved.classList.remove('hidden');
    setTimeout(function() { saved.classList.add('hidden'); }, 2500);
  });
}

function switchSessionTab(tab) {
  var tabs = ['notes', 'characters', 'review', 'storyboard', 'export'];
  tabs.forEach(function(t) {
    var pane = document.getElementById('session-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('stab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Auto-load preview when switching to the Publish tab. Default to Quick View
  // and always render it; True View is only shown when the user toggles to it.
  if (tab === 'export' && state.currentSession) {
    sessionPreviewMode = 'quick';
    var _spb = document.getElementById('session-preview-mode-btn');
    if (_spb) _spb.textContent = 'Quick View';
    loadPreview(state.layoutStyle || 'Classic');
  }
  // Load character snapshots when switching to the characters tab
  if (tab === 'characters') {
    loadSessionCharacters();
  }
  if (tab === 'review') {
    loadReview();
  }
}

// ============================================================
// CHARACTERS
// ============================================================
function loadCharacters() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.characters = Array.isArray(data) ? data : [];
      renderCharacters();
    });
}

function renderCharacters() {
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var html = state.characters.map(function(c, i) {
    var initials = c.name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + c.name + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
      : '<span style="font-size:15px;font-weight:600;color:' + fg + ';">' + initials + '</span>';
    // Just show portrait on card - clean and simple
    var imgGridHtml = '';

    // Phase 3 ownership badges. Three mutually exclusive states for a PC:
    // - owner_name present → claimed by a Chronicle user (Played by X)
    // - is_claimed === false → stub awaiting invitee (Awaiting player)
    // - otherwise → unowned PC, no badge
    // NPCs get neither (they have the NPC badge already below).
    var ownerBadge = '';
    var isNpc = (c.is_npc === true || c.is_npc === 1 || c.is_npc === '1');
    if (!isNpc) {
      if (c.owner_name) {
        ownerBadge = '<div class="char-owner-badge">&#127922; Played by ' + (typeof escapeHtml === 'function' ? escapeHtml(c.owner_name) : c.owner_name) + '</div>';
      } else if (c.is_claimed === false) {
        ownerBadge = '<div class="char-pending-badge">&#8987; Awaiting player</div>';
      }
    }

    return '<div class="char-card char-card-drop" id="char-card-' + c.id + '">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + portrait + '</div>' +
        '<div class="char-actions">' +
          (function() {
            // Phase 3 Deploy 3 — per-card edit visibility.
            var meId = (state.user && state.user.id) || null;
            var cur = state.currentCampaign;
            var isDM = (cur && cur.my_role === 'dm');
            var isOwner = (meId && c.owner_user_id === meId);
            var locked = !!(cur && cur.locked);
            var canEdit = isDM || (isOwner && !locked);
            var btns = '';
            if (canEdit) {
              btns += '<button class="char-btn" onclick="openCharModal(' + c.id + ')">Edit</button>';
            }
            // Delete stays DM-only — players cannot delete any character.
            btns += '<button class="char-btn char-btn-delete dm-only" onclick="deleteChar(' + c.id + ')">Delete</button>';
            return btns;
          })() +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      ownerBadge +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      '<div class="char-desc">' + (c.description || '') + '</div>' +
      '<span class="char-badge">' + (c.cls || '') + '</span>' +
      (isNpc ? '<span class="char-badge char-badge-npc">NPC</span>' : '') +
      imgGridHtml +
    '</div>';
  }).join('');
  html += '<div class="add-char-card dm-only" onclick="openCharModal()"><div class="plus">+</div><span>Add character</span></div>';
  document.getElementById('char-grid').innerHTML = html;
  setupCardDragDrop();
}


// ============================================================
// EXTRACT MOMENTS
// ============================================================
function selStyle(el, style) {
  document.querySelectorAll('.style-row .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.artStyle = style;

  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({art_style: style})
    }).catch(function() {});
  }
}

function selLayout(el, layout) {
  document.querySelectorAll('#session-tab-export .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  state.layoutStyle = layout;

  // Save to session
  if (state.currentSession && state.currentCampaign) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({layout_style: layout})
    }).catch(function() {});
  }

  // Always show preview when layout is selected
  loadPreview(layout);
}

function loadPreview(layout) {
  var loading = document.getElementById('session-preview-loading');
  var iframe = document.getElementById('session-preview-iframe');
  if (!iframe) return;

  var url = '/api/pdf/session/' + state.currentCampaign.id + '/' + state.currentSession.id +
    '?layout=' + encodeURIComponent(layout || state.layoutStyle || 'Classic') +
    (state.currentForkId ? '&fork_id=' + state.currentForkId : '') + customOptsQ('session','&') +
    (sessionPreviewMode === 'wysiwyg' ? '&format=pdf' : '');

  // Show loading state
  if (loading) loading.style.display = 'flex';
  startPreviewProgress('session-preview', sessionPreviewMode);
  iframe.style.display = 'none';
  iframe.src = '';

  // Load new preview
  iframe.onload = function() {
    stopPreviewProgress('session-preview');
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizePreviewIframe();
  };
  iframe.src = url;
}

// Grow the preview iframe to the full height of its content so there is
// no inner scrollbar — the user scrolls only the outer page.
function resizePreviewIframe() {
  // Preview now renders the true paged PDF; the native PDF viewer scrolls
  // internally, so keep a fixed-height pane instead of growing to content.
  var iframe = document.getElementById('session-preview-iframe');
  var frame = document.getElementById('session-preview-frame');
  if (iframe) iframe.style.height = '75vh';
  if (frame) frame.style.height = '';
}

// Re-measure on window resize — content reflow can change the height
window.addEventListener('resize', function() {
  var iframe = document.getElementById('session-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizePreviewIframe();
  }
});

// Map a layout value (including legacy names) to its chip id suffix
function layoutChipKey(layout) {
  var legacy = { cinematic: 'comicbook', dramatic: 'action' };
  var k = (layout || 'Classic').toLowerCase();
  return legacy[k] || k;
}

function applyLayoutStyle(layout) {
  state.layoutStyle = layout || 'Classic';
  refreshLayoutStyleButtons();
}

function extractMoments() {
  var key = getApiKey();
  var transcript = document.getElementById('transcript-input').value.trim();
  var errorEl = document.getElementById('extract-error');
  errorEl.classList.add('hidden');

  // Image locking — re-extract would destroy locked panels; block it.
  if ((state.moments || []).some(function(m){ return m.locked; })) {
    var _lockMsg = 'Locked moments exist, so you can’t regenerate the story. Unlock them first to rebuild this version.';
    errorEl.textContent = _lockMsg;
    errorEl.classList.remove('hidden');
    alert(_lockMsg);
    return;
  }

  if (transcript.length < 50) {
    errorEl.textContent = 'Please paste a longer transcript first.';
    errorEl.classList.remove('hidden');
    return;
  }

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!confirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // Auto-save before extracting: the DM persists transcript + canonical
  // notes; a player persists only their OWN version's notes (the transcript
  // is DM-owned and read-only to players).
  var notesVal = document.getElementById('session-notes-input');
  var _role = state.currentCampaign && state.currentCampaign.my_role;
  var _ownFork = (_role === 'player') && state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId);
  if (_ownFork) {
    if (typeof saveForkNotes === 'function') saveForkNotes(notesVal ? notesVal.value.trim() : '');
  } else if (_role === 'dm' && !state.currentForkId) {
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        transcript: transcript,
        session_notes: notesVal ? notesVal.value.trim() : ''
      })
    });
  }

  var btn = document.getElementById('extract-btn');
  var wrap = document.getElementById('progress-wrap');
  var fill = document.getElementById('progress-fill');
  var msg = document.getElementById('progress-msg');

  btn.disabled = true;
  wrap.style.display = 'block';
  fill.style.width = '5%';
  msg.textContent = 'Reading your session transcript...';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 6, 88);
    fill.style.width = pct + '%';
  }, 400);

  var _xctl = new AbortController();
  state.abortExtract = _xctl;
  var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'inline-block';
  fetch('/api/extract/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key:key, artStyle:state.artStyle}),
    signal: _xctl.signal
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'none';
    if (data.error) {
      var _emsg = data.message || ('Error: ' + data.error);
      errorEl.textContent = _emsg;
      errorEl.classList.remove('hidden');
      if (typeof showErrorDialog === 'function') showErrorDialog(_emsg, 'Generate Story');
      wrap.style.display = 'none';
      btn.disabled = false;
      return;
    }
    // Pass 1 — Generate Story now EXTRACTS ONLY (moments + the free narrative
    // outline produced in the same call). Narrative prose and images are
    // generated later from the Review tab via "Generate Narrative & Images",
    // so no narrative call fires here.
    state.moments = data.moments || [];
    state.pendingChanges = data.pendingChanges || 0;
    state.narrativeData = { intro: '', sections: [], outro: '' };
    fill.style.width = '100%';
    msg.textContent = 'Your storyboard plan is ready!';
    var _mc = document.getElementById('moment-count'); if (_mc) _mc.textContent = state.moments.length;
    renderStoryboard();
    setTimeout(function() {
      wrap.style.display = 'none';
      fill.style.width = '0%';
      btn.disabled = false;
      // Permanent character changes detected -> review them on the Characters
      // tab first; otherwise land on Review to check the plan, steer the
      // narrative, and set casting before generating.
      if (state.pendingChanges && state.pendingChanges > 0) {
        switchSessionTab('characters');
      } else {
        switchSessionTab('review');
      }
    }, 800);
  })
  .catch(function(e) {
    clearInterval(ticker);
    var _xcb = document.getElementById('extract-cancel-btn'); if (_xcb) _xcb.style.display = 'none';
    if (e && e.name === 'AbortError') { wrap.style.display = 'none'; btn.disabled = false; return; }
    wrap.style.display = 'none';
    btn.disabled = false;
    errorEl.textContent = 'Connection error: ' + e.message;
    errorEl.classList.remove('hidden');
  });
}


// Auto-save narrative with debounce — saves 1.5 seconds after user stops typing
var narrativeSaveTimer = null;
function scheduleNarrativeSave() {
  if (narrativeSaveTimer) clearTimeout(narrativeSaveTimer);
  narrativeSaveTimer = setTimeout(function() {
    saveInlineNarrative(true); // true = silent save
  }, 1500);
}

function collectNarrativeState() {
  var intro = document.getElementById('narrative-intro-box');
  var outro = document.getElementById('narrative-outro-box');
  var prevSecs = (state.narrativeData && state.narrativeData.sections) || [];
  var sections = (state.moments || []).map(function(m, i) {
    var mbox = document.getElementById('narrative-moment-box-' + i);
    var abox = document.getElementById('narrative-between-box-' + i);
    var prev = prevSecs.find(function(s){ return s.panel_index === i; }) || {};
    return {
      panel_index: i,
      before: mbox ? mbox.value.trim() : (prev.before || ''),
      before_summary: prev.before_summary || '',
      after: abox ? abox.value.trim() : (prev.after || ''),
      after_summary: prev.after_summary || ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrativeSection(type, panelIndex) {
  var data = collectNarrativeState();

  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    // Show brief saved indicator on the button
    var btnId = type === 'intro' ? 'narrative-opening'
      : type === 'outro' ? 'narrative-closing'
      : 'narrative-between-' + panelIndex;
    var block = document.getElementById(btnId);
    if (block) {
      var btn = block.querySelector('.narrative-save-btn');
      if (btn) {
        var orig = btn.textContent;
        btn.textContent = '✓ Saved!';
        btn.style.color = '#5dcaa5';
        setTimeout(function() { btn.textContent = orig; btn.style.color = ''; }, 1500);
      }
    }
  });
}

function saveInlineNarrative(silent) {
  var data = collectNarrativeState();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { if (!silent) showAlert('Error: ' + result.error); return; }
    state.narrativeData = data;
    if (!silent) showAlert('Narrative saved!');
  });
}

function regenNarrativeSection(type, panelIndex) {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  // Save current state first
  saveInlineNarrative();

  // The textarea we write the result into, plus the panel container the
  // spinner overlay anchors to (same gold spinner the storyboard image
  // panels use, via showBusyOverlay).
  var boxId = type === 'opening' ? 'narrative-intro-box'
    : type === 'closing' ? 'narrative-outro-box'
    : type === 'moment' ? 'narrative-moment-box-' + panelIndex
    : 'narrative-between-box-' + panelIndex;
  var panelId = type === 'opening' ? 'narrative-opening'
    : type === 'closing' ? 'narrative-closing'
    : type === 'moment' ? 'narrative-moment-' + panelIndex
    : 'narrative-between-' + panelIndex;

  var box = document.getElementById(boxId);
  // Non-destructive: leave the existing prose visible-but-dimmed under the
  // overlay and lock editing while the regenerate is in flight. The original
  // text stays put on failure (we never blank it).
  if (box) box.disabled = true;
  showBusyOverlay(panelId, 'Regenerating');

  // Regenerate full narrative and extract the relevant section
  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    hideBusyOverlay(panelId);
    if (box) box.disabled = false;
    if (data.error) {
      showAlert('Error: ' + data.error);
      return;
    }

    state.narrativeData = {
      intro: data.intro || '',
      sections: data.sections || [],
      outro: data.outro || ''
    };

    // Update just the relevant box
    if (type === 'opening' && box) box.value = data.intro || '';
    else if (type === 'closing' && box) box.value = data.outro || '';
    else if (type === 'moment' && box) {
      var msec = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = msec ? (msec.before || '') : '';
    }
    else if (type === 'between' && box) {
      var section = (data.sections||[]).find(function(s){return s.panel_index===panelIndex;});
      box.value = section ? (section.after || '') : '';
    }
  })
  .catch(function(e) {
    hideBusyOverlay(panelId);
    if (box) box.disabled = false;
    showAlert('Error: ' + e.message);
  });
}

function generateAllImages() {
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!confirm('This will replace all existing panel images that are not locked. Are you sure?')) {
      return;
    }
  }

  var btn = document.getElementById('generate-all-btn');
  var progressWrap = document.getElementById('generate-progress');
  var fill = document.getElementById('gen-progress-fill');
  var msg = document.getElementById('gen-progress-msg');

  btn.disabled = true;
  progressWrap.style.display = 'block';
  fill.style.width = '5%';
  var _toGen = (state.moments || []).filter(function(m){ return !m.locked; }).length;
  msg.textContent = 'Generating ' + _toGen + ' image' + (_toGen === 1 ? '' : 's') + '...';

  // Non-destructive busy overlay on each panel — existing images stay
  // in the DOM underneath, dimmed. On refusal/failure we remove overlays
  // and the user's previous images are still right there.
  state.moments.forEach(function(m) {
    if (!m.locked) showPanelBusy(m.id, 'Generating');
  });

  var _gctl = new AbortController();
  state.abortGenAll = _gctl;
  var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'inline-block';
  fetch('/api/images/generate-all', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      style: state.artStyle,
      fal_key: falKey
    }),
    signal: _gctl.signal
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'none';
    if (data.error) {
      // Generation refused — clear ALL busy overlays so the user's
      // existing images are fully visible again (not dimmed).
      hideAllPanelBusy();
      var errEl = document.getElementById('generate-error');
      if (data.error === 'INSUFFICIENT_TOKENS') {
        errEl.innerHTML = insufficientTokensHtml(data.message);
      } else {
        errEl.textContent = 'Error: ' + data.error;
      }
      errEl.classList.remove('hidden');
      btn.disabled = false;
      progressWrap.style.display = 'none';
      return;
    }

    // Async batch: the server queued one job per panel and returned their ids.
    // Poll them to completion, driving the progress bar as each lands. (Falls
    // back to the old synchronous shape if the server returns counts directly.)
    if (data.jobs) {
      pollImageBatch(data.jobs, { total: data.total, skipped_locked: data.skipped_locked });
      return;
    }
    fill.style.width = '100%';
    var _doneMsg = (data.count || 0) + ' image' + ((data.count || 0) === 1 ? '' : 's') + ' generated';
    if (data.skipped_locked) { _doneMsg += ' (' + data.skipped_locked + ' locked panel' + (data.skipped_locked === 1 ? '' : 's') + ' skipped)'; }
    msg.textContent = _doneMsg + '!';
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    refreshStoryboardImages();
    setTimeout(function() {
      btn.disabled = false;
      progressWrap.style.display = 'none';
      fill.style.width = '0%';
    }, 2000);
  })
  .catch(function(e) {
    hideAllPanelBusy();
    var _gcb = document.getElementById('genall-cancel-btn'); if (_gcb) _gcb.style.display = 'none';
    if (e && e.name === 'AbortError') { btn.disabled = false; progressWrap.style.display = 'none'; return; }
    document.getElementById('generate-error').textContent = 'Error: ' + e.message;
    document.getElementById('generate-error').classList.remove('hidden');
    btn.disabled = false;
    progressWrap.style.display = 'none';
  });
}

function regenImage(momentId, index) {
  var falKey = getFalKey() || 'platform';

  var moment = state.moments.find(function(m) { return m.id === momentId; });
  if (!moment) return;

  // Non-destructive busy overlay — existing image stays in the DOM
  // underneath, dimmed. On refusal/failure we remove the overlay and
  // the user's previous image is still there.
  showPanelBusy(momentId, 'Regenerating');

  fetch('/api/images/generate-moment', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      moment_id: momentId,
      session_id: state.currentSession.id,
      campaign_id: state.currentCampaign.id,
      prompt: moment.prompt,
      style: state.artStyle,
      fal_key: falKey
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      // Render the error AT the panel (not at the top of the page) so
      // users scrolled deep in a long storyboard actually see it. The
      // existing image stays visible underneath the error overlay.
      if (data.error === 'INSUFFICIENT_TOKENS') {
        showPanelError(momentId, insufficientTokensHtml(data.message), true);
      } else {
        showPanelError(momentId, 'Could not regenerate: ' + data.error);
      }
      return;
    }
    // Async flow: the server queued the job and returned a job_id; the image is
    // generated by fal and delivered to our webhook, so we poll for it. (If the
    // server ever returns an image_url directly, just use it.)
    if (data.image_url) { applyRegenResult(momentId, data.image_url); return; }
    if (data.job_id) { pollImageJob(data.job_id, momentId); return; }
    showPanelError(momentId, 'Could not start generation.');
  })
  .catch(function(e) { showPanelError(momentId, 'Could not regenerate: ' + e.message); });
}

// ============================================================
// GRAPHIC NOVEL
// ============================================================
var novelLayoutStyle = 'Classic';

function switchNovelTab(tab) {
  if (tab === 'order' && typeof loadPrintTab === 'function') loadPrintTab();
  ['sessions', 'preview', 'order'].forEach(function(t) {
    var pane = document.getElementById('novel-tab-' + t);
    if (pane) pane.style.display = t === tab ? 'block' : 'none';
    var el = document.getElementById('ntab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // Default to Quick View and always render it on entry; True View is only
  // shown when the user toggles to it.
  if (tab === 'preview') {
    novelPreviewMode = 'quick';
    var _npb = document.getElementById('novel-preview-mode-btn');
    if (_npb) _npb.textContent = 'Quick View';
    if (typeof novelPreviewPage !== 'undefined') novelPreviewPage = 1;
    if (typeof loadNovelPreview === 'function') loadNovelPreview(novelLayoutStyle);
  }
}

function selNovelLayout(el, layout) {
  document.querySelectorAll('#novel-tab-preview .chip').forEach(function(c){c.classList.remove('sel');});
  el.classList.add('sel');
  novelLayoutStyle = layout;
  loadNovelPreview(layout);
}

function loadNovelPreview(layout) {
  var loading = document.getElementById('novel-preview-loading');
  var iframe = document.getElementById('novel-preview-iframe');
  if (!iframe) return;

  if (layout) novelLayoutStyle = layout;

  // Build/refresh the session pager
  setupNovelPager();

  var total = (state.novelSessions || []).length;
  var url = '/api/pdf/novel/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel','&') +
    (novelPreviewMode === 'wysiwyg' ? '&format=pdf' : '');
  // Paginate by session only in Quick View; True View renders the whole
  // continuous document so the PDF viewer's own page navigation moves through it.
  if (total > 1 && novelPreviewMode === 'quick') {
    url += '&page=' + novelPreviewPage;
  }

  if (loading) loading.style.display = 'flex';
  startPreviewProgress('novel-preview', novelPreviewMode);
  iframe.style.display = 'none';
  iframe.src = '';

  iframe.onload = function() {
    stopPreviewProgress('novel-preview');
    if (loading) loading.style.display = 'none';
    iframe.style.display = 'block';
    resizeNovelPreviewIframe();
  };
  iframe.src = url;
}

// ---- Novel preview pager ----
var novelPreviewPage = 1;

function setupNovelPager() {
  var warning = document.getElementById('novel-preview-warning');
  var sessions = state.novelSessions || [];
  var total = sessions.length;

  // Both pager bars: top and bottom. Suffix '' = top, '-bottom' = bottom.
  var suffixes = ['', '-bottom'];

  // True View renders the real continuous document (sessions flow into each
  // other mid-page), so a session-based pager has no clean page to jump to.
  // Hide both bars there and let the PDF viewer's own nav do the moving;
  // the pager shows only in Quick View, where each session renders alone.
  if (typeof novelPreviewMode !== 'undefined' && novelPreviewMode === 'wysiwyg') {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    return;
  }

  // Only show the pagers when there is more than one session
  if (total <= 1) {
    suffixes.forEach(function(sx) {
      var p = document.getElementById('novel-pager' + sx);
      if (p) p.style.display = 'none';
    });
    if (warning) warning.style.display = 'none';
    novelPreviewPage = 1;
    return;
  }

  // Clamp current page into range
  if (novelPreviewPage < 1) novelPreviewPage = 1;
  if (novelPreviewPage > total) novelPreviewPage = total;

  // Build dropdown options once, reuse for both bars
  var opts = '';
  for (var i = 0; i < total; i++) {
    var nm = sessions[i] && sessions[i].name ? sessions[i].name : ('Session ' + (i+1));
    var label = 'Session ' + (i+1) + ' of ' + total + '  —  ' + nm;
    opts += '<option value="' + (i+1) + '"' + ((i+1) === novelPreviewPage ? ' selected' : '') + '>' +
      label + '</option>';
  }

  suffixes.forEach(function(sx) {
    var pager = document.getElementById('novel-pager' + sx);
    if (!pager) return;
    var select = document.getElementById('novel-pager-select' + sx);
    if (select) select.innerHTML = opts;
    var prev = document.getElementById('novel-pager-prev' + sx);
    var next = document.getElementById('novel-pager-next' + sx);
    if (prev) prev.disabled = (novelPreviewPage <= 1);
    if (next) next.disabled = (novelPreviewPage >= total);
    pager.style.display = 'flex';
  });

  if (warning) warning.style.display = total > 15 ? 'block' : 'none';
}

// Scroll the preview area back to the top after navigating
// Find the nearest ancestor of `el` that actually has a vertical scrollbar.
function findScrollParent(el) {
  var node = el ? el.parentElement : null;
  while (node) {
    var style = window.getComputedStyle(node);
    var oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function scrollNovelPreviewToTop() {
  var anchor = document.getElementById('novel-pager') ||
               document.getElementById('novel-preview-frame');
  if (!anchor) { console.log('[pager-scroll] no anchor element found'); return; }

  function doScroll(label) {
    var scroller = findScrollParent(anchor);
    if (scroller) {
      var aRect = anchor.getBoundingClientRect();
      var sRect = scroller.getBoundingClientRect();
      var target = Math.max(0, scroller.scrollTop + (aRect.top - sRect.top) - 12);
      // Instant jump — a smooth scroll gets interrupted by the iframe resize.
      scroller.scrollTop = target;
      console.log('[pager-scroll ' + label + '] scrolled', scroller.className || scroller.tagName,
        'to', target);
    } else {
      // No scrollable ancestor found — fall back to window + documentElement.
      var rect = anchor.getBoundingClientRect();
      var top = Math.max(0, rect.top + (window.pageYOffset || 0) - 12);
      window.scrollTo(0, top);
      document.documentElement.scrollTop = top;
      document.body.scrollTop = top;
      console.log('[pager-scroll ' + label + '] no scroll parent — used window, top', top);
    }
  }

  // Scroll now, then re-assert after the iframe reloads/resizes the page.
  doScroll('immediate');
  setTimeout(function() { doScroll('settle-1'); }, 120);
  setTimeout(function() { doScroll('settle-2'); }, 500);
}

function novelPageJump(value) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return;
  novelPreviewPage = n;
  loadNovelPreview(novelLayoutStyle);
  scrollNovelPreviewToTop();
}

function novelPagePrev() {
  if (novelPreviewPage > 1) {
    novelPreviewPage--;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

function novelPageNext() {
  var total = (state.novelSessions || []).length;
  if (novelPreviewPage < total) {
    novelPreviewPage++;
    loadNovelPreview(novelLayoutStyle);
    scrollNovelPreviewToTop();
  }
}

// Grow the novel preview iframe to the full height of its content so there
// is no inner scrollbar — the user scrolls only the outer page.
function resizeNovelPreviewIframe() {
  // Preview now renders the true paged PDF; the native PDF viewer scrolls
  // internally, so keep a fixed-height pane instead of growing to content.
  var iframe = document.getElementById('novel-preview-iframe');
  var frame = document.getElementById('novel-preview-frame');
  if (iframe) iframe.style.height = '75vh';
  if (frame) frame.style.height = '';
}

// Re-measure novel preview on window resize
window.addEventListener('resize', function() {
  var iframe = document.getElementById('novel-preview-iframe');
  if (iframe && iframe.style.display !== 'none' && iframe.src) {
    resizeNovelPreviewIframe();
  }
});

function previewNovelPDF() {
  novelPreviewPage = 1;
  switchNovelTab('preview');
  loadNovelPreview(novelLayoutStyle);
}

function exportNovelPDF() {
  var url = '/api/pdf/novel/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel','&') + '&format=pdf';
  window.open(url, '_blank');
}

function loadNovelSummary() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all' + novelAsUserQ('?'))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Sort ascending by date (oldest first) using a normalized YYYY-MM-DD key
      var sessions = Array.isArray(data) ? data : [];
      function sessionDateKey(s) {
        if (!s.session_date) return '';
        if (typeof s.session_date === 'string') return s.session_date.split('T')[0];
        try { return s.session_date.toISOString().split('T')[0]; }
        catch (e) { return String(s.session_date); }
      }
      sessions.sort(function(a, b) {
        return sessionDateKey(a).localeCompare(sessionDateKey(b));
      });
      renderNovelSummary(sessions);
    });
}

function renderNovelSummary(sessions) {

  // Keep the ordered session list available for the preview pager
  state.novelSessions = (sessions || []).filter(novelIncluded);

  var container = document.getElementById('novel-summary-list');
  if (!sessions.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">&#128213;</div>' +
      '<h3>No sessions yet</h3><p>Create sessions and extract moments to build your graphic novel</p></div>';
    return;
  }

  var totalMoments = 0;
  var html = sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var momentsHtml = moments.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;padding:10px 14px;">' +
        moments.map(function(m, j) {
          return '<div style="position:relative;border-radius:6px;overflow:hidden;background:rgba(15,10,5,0.6);border:1px solid rgba(201,168,76,0.1);">' +
            (m.image
              ? '<img src="' + m.image + '" style="width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:zoom-in;" onclick="openLightbox(this.src,this.alt)" alt="' + m.title + '" />'
              : '<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0.2;">&#128444;</div>') +
            '<div style="padding:5px 7px;">' +
              '<div style="font-size:9px;color:rgba(201,168,76,0.4);">Panel ' + (j+1) + '</div>' +
              '<div style="font-size:10px;color:var(--gold-light);font-weight:600;line-height:1.3;">' + m.title + '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>'
      : '<div class="novel-empty">No moments extracted yet — open this session to generate storyboard panels</div>';

    return '<div class="novel-session-block">' +
      '<div class="novel-session-header">' +
        '<div><div class="novel-session-title">Session ' + (i+1) + ' &mdash; ' + s.name + '</div>' +
        '<div class="novel-session-date">' + formatSessionDate(s.session_date) + '</div></div>' +
        '<span style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">' + '<label style="font-size:11px;color:var(--text-muted);display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" ' + (novelIncluded(s) ? 'checked' : '') + ' onchange="toggleNovelInclude(' + s.id + ', this.checked)"> Include in Print</label>' + '<a onclick="goToSessionPage(' + s.id + ')" style="font-size:11px;color:#2f5a86;cursor:pointer;text-decoration:underline;">Open</a>' +
          '<span class="session-badge' + (moments.length?'':' empty') + '">' + moments.length + ' panels</span>' +
          '<span class="session-badge' + (s.fork_status === 'ready' ? '' : ' session-badge-draft') + '">' + (s.fork_status === 'ready' ? 'Ready' : 'Draft') + '</span>' +
        '</span>' +
      '</div>' +
      '<div class="novel-session-moments">' + momentsHtml + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = '<div style="font-size:12px;color:rgba(201,168,76,0.5);margin-bottom:14px;">' +
    sessions.length + ' sessions in chronological order &middot; ' + totalMoments + ' total panels</div>' + html;
}

function showNovelPreview() {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/all' + novelAsUserQ('?'))
    .then(function(r) { return r.json(); })
    .then(function(data) { renderNovelPreview(Array.isArray(data) ? data : []); });
}

function renderNovelWithImages() {
  // Re-render novel panels for current session with updated images
  if (!state.moments.length) return;
  var panels = document.getElementById('novel-panels');
  if (panels) {
    panels.innerHTML = state.moments.map(function(m, i) {
      var wide = (i === 0 || i === Math.floor(state.moments.length / 2));
      var imgContent = m.image
        ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
        : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
      return '<div class="novel-panel' + (wide ? ' wide' : '') + '">' +
        imgContent +
        '<div class="novel-caption">' + m.description + '</div>' +
      '</div>';
    }).join('');
  }
}

function renderNovelPreview(sessions) {
  document.getElementById('novel-summary-list').innerHTML = '';
  document.getElementById('preview-novel-btn').style.display = 'none';
  document.getElementById('novel-preview-section').style.display = 'block';

  var html = sessions.map(function(s, si) {
    var moments = s.moments || [];
    if (!moments.length) return '';
    return '<div>' +
      '<div class="novel-chapter-header">Session ' + (si+1) + ' &mdash; ' + s.name + '</div>' +
      '<div class="novel-grid" style="grid-template-columns:1fr 1fr;gap:2px;background:#222;padding:2px;">' +
      moments.map(function(m, i) {
        var wide = (i===0 || i===Math.floor(moments.length/2));
        var imgContent = m.image
          ? '<img src="' + m.image + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in;" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
          : '<div class="novel-panel-inner"><div style="font-size:20px;margin-bottom:4px;">&#128444;</div>' + m.title + '</div>';
        return '<div class="novel-panel' + (wide?' wide':'') + '">' +
          imgContent +
          '<div class="novel-caption">' + m.description + '</div>' +
        '</div>';
      }).join('') + '</div></div>';
  }).join('');

  document.getElementById('novel-all-panels').innerHTML = html ||
    '<div class="empty-state" style="padding:2rem;"><p>No moments extracted yet.</p></div>';
}

function hideNovelPreview() { loadNovelSummary(); }

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsForm() {
  // Settings now hosts admin/testing controls only (the global image model).
  // Profile (name / email / password) moved to the Account screen.
  fetch('/api/auth/image-model')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var el = document.getElementById('settings-image-model');
      if (el && d.model) el.value = d.model;
    });
}

function saveImageModel() {
  var el = document.getElementById('settings-image-model');
  if (!el) return;
  fetch('/api/auth/image-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: el.value })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        showSettingsError('model-error', d.error);
      } else {
        var ok = document.getElementById('model-success');
        if (ok) {
          ok.textContent = 'Image model saved.';
          ok.classList.remove('hidden');
          setTimeout(function() { ok.classList.add('hidden'); }, 2500);
        }
      }
    })
    .catch(function() {
      showSettingsError('model-error', 'Could not save. Please try again.');
    });
}

function saveProfile() {
  var name = document.getElementById('settings-name').value.trim();
  var email = document.getElementById('settings-email').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    document.getElementById('user-name').textContent = name;
    document.getElementById('user-menu-email').textContent = email;
    var initials = name.split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    document.getElementById('user-avatar').textContent = initials;
    document.getElementById('profile-success').textContent = 'Profile updated!';
    document.getElementById('profile-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('profile-success').classList.add('hidden'); }, 2500);
  });
}

function saveApiKey() {
  var apiEl = document.getElementById('settings-apikey');
  if (!apiEl) return;
  var key = apiEl.value.trim();
  document.getElementById('apikey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({api_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('apikey-success').textContent = 'API key saved!';
    document.getElementById('apikey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('apikey-success').classList.add('hidden'); }, 2500);
  });
}

function saveFalKey() {
  var falEl = document.getElementById('settings-falkey');
  if (!falEl) return;
  var key = falEl.value.trim();
  document.getElementById('falkey-success').classList.add('hidden');
  fetch('/api/auth/apikey', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({fal_key:key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { alert(data.error); return; }
    document.getElementById('falkey-success').textContent = 'fal.ai key saved!';
    document.getElementById('falkey-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('falkey-success').classList.add('hidden'); }, 2500);
  });
}

function getFalKey() {
  var el = document.getElementById('settings-falkey');
  return el ? el.value.trim() : '';
}

function changePassword() {
  var current = document.getElementById('settings-current-password').value;
  var newpw = document.getElementById('settings-new-password').value;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }

  fetch('/api/auth/password', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({current_password:current, new_password:newpw})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('password-error', data.error); return; }
    document.getElementById('settings-current-password').value = '';
    document.getElementById('settings-new-password').value = '';
    document.getElementById('password-success').textContent = 'Password changed successfully!';
    document.getElementById('password-success').classList.remove('hidden');
    setTimeout(function() { document.getElementById('password-success').classList.add('hidden'); }, 2500);
  });
}

function showSettingsError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ============================================================
// DRAG AND DROP — Character portraits
// ============================================================

// Image slot handlers — modal upload areas
var slotFiles = {}; // Tracks new files selected for each slot

function handleSlotDragOver(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.add('drag-over');
}

function handleSlotDragLeave(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
}

function handleSlotDrop(e, slot) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('drop-' + slot).classList.remove('drag-over');
  var files = e.dataTransfer.files;
  if (!files || !files[0]) return;
  if (!files[0].type.match('image.*')) { showAlert('Please drop an image file'); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  var reader = new FileReader();
  reader.onload = function(ev) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    preview.src = ev.target.result;
    preview.classList.remove('hidden');
    // stopPropagation: the surrounding .image-upload-area div has its own
    // onclick that opens the file-picker. Without this stop, clicking the
    // preview image opens the lightbox AND ALSO bubbles up to fire the
    // file picker — looks to the user like a download/save dialog.
    preview.onclick = function(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      openLightbox(ev.target.result, slot.replace('image_', '').replace('_', ' '));
    };
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'inline-flex';
  };
  reader.readAsDataURL(file);
}

function clearSlot(slot) {
  slotFiles[slot] = null;
  var preview = document.getElementById('preview-' + slot);
  var placeholder = document.getElementById('placeholder-' + slot);
  var clearBtn = document.getElementById('clear-' + slot);
  var input = document.getElementById('input-' + slot);
  preview.src = '';
  preview.classList.add('hidden');
  if (placeholder) placeholder.style.display = 'flex';
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) input.value = '';
  // Mark for clearing on save
  slotFiles[slot + '_clear'] = true;
}

function loadSlotPreviews(char) {
  var slots = ['image_portrait', 'image_fullbody', 'image_action', 'image_other'];
  slots.forEach(function(slot) {
    var preview = document.getElementById('preview-' + slot);
    var placeholder = document.getElementById('placeholder-' + slot);
    var clearBtn = document.getElementById('clear-' + slot);
    var url = char ? char[slot] : null;
    slotFiles[slot] = null;
    slotFiles[slot + '_clear'] = false;

    if (url) {
      preview.src = url;
      preview.classList.remove('hidden');
      // stopPropagation: same reason as setSlotFile — keep the click from
      // bubbling to the wrapping .image-upload-area which would fire the
      // file picker.
      preview.onclick = function(e) {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        openLightbox(url, slot.replace('image_', '').replace('_', ' '));
      };
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
    } else {
      preview.src = '';
      preview.classList.add('hidden');
      if (placeholder) placeholder.style.display = 'flex';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  });
}

// Drag and drop directly onto character cards
function setupCardDragDrop() {
  var grid = document.getElementById('char-grid');
  if (!grid) return;

  grid.addEventListener('dragenter', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var card = e.target.closest('.char-card-drop');
    // Remove drag-over from all cards first
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    if (card) card.classList.add('drag-over');
  });

  grid.addEventListener('dragleave', function(e) {
    e.preventDefault();
    e.stopPropagation();
    // Only remove if leaving the grid entirely
    if (!grid.contains(e.relatedTarget)) {
      grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });
    }
  });

  grid.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    grid.querySelectorAll('.char-card-drop').forEach(function(c) { c.classList.remove('drag-over'); });

    var card = e.target.closest('.char-card-drop');
    if (!card) return;

    var files = e.dataTransfer.files;
    if (!files || !files[0]) return;

    var file = files[0];
    if (!file.type.match('image.*')) {
      showAlert('Please drop an image file (JPG, PNG, WebP)');
      return;
    }

    var charId = parseInt(card.id.replace('char-card-', ''));
    if (!charId) return;

    uploadPortraitToChar(charId, file);
  });
}

function uploadPortraitToChar(charId, file) {
  var formData = new FormData();
  formData.append('image', file);

  // Get existing char data to preserve it
  var char = state.characters.find(function(c) { return c.id === charId; });
  if (!char) return;

  formData.append('name', char.name);
  formData.append('cls', char.cls || '');
  formData.append('description', char.description || '');
  formData.append('player_name', char.player_name || '');

  // Show uploading indicator on the card
  var card = document.getElementById('char-card-' + charId);
  if (card) {
    var avatar = card.querySelector('.char-avatar');
    if (avatar) avatar.style.opacity = '0.5';
  }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId, {
    method: 'PUT',
    body: formData
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showAlert('Error uploading portrait: ' + data.error); return; }
    showAlert('Portrait updated for ' + char.name + '!');
    loadCharacters();
  })
  .catch(function(e) { showAlert('Error: ' + e.message); });
}

// ============================================================
// NARRATIVE
// ============================================================

var narrativeData = { intro: '', sections: [], outro: '' };

function loadNarrative() {
  fetch('/api/narrative/' + state.currentCampaign.id + '/' + state.currentSession.id + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      narrativeData = data;
      if (data.intro || (data.sections && data.sections.length) || data.outro) {
        renderNarrativeEditor(data);
        document.getElementById('narrative-empty').style.display = 'none';
        document.getElementById('narrative-content').style.display = 'block';
      } else {
        document.getElementById('narrative-empty').style.display = 'block';
        document.getElementById('narrative-content').style.display = 'none';
      }
    });
}

function generateNarrative() {
  var key = getApiKey() || 'platform';  // Platform key used server-side

  var btn = document.getElementById('regen-narrative-btn');
  var progress = document.getElementById('narrative-progress');
  var fill = document.getElementById('narrative-progress-fill');
  var msg = document.getElementById('narrative-progress-msg');
  var errorEl = document.getElementById('narrative-error');

  if (btn) btn.disabled = true;
  if (errorEl) errorEl.classList.add('hidden');
  document.getElementById('narrative-empty').style.display = 'none';
  document.getElementById('narrative-content').style.display = 'block';
  if (progress) progress.style.display = 'block';

  var pct = 5;
  var ticker = setInterval(function() {
    pct = Math.min(pct + Math.random() * 5, 88);
    if (fill) fill.style.width = pct + '%';
  }, 500);

  if (msg) msg.textContent = 'Writing your story narrative...';

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({key: key})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;

    if (data.error) {
      if (errorEl) { errorEl.textContent = 'Error: ' + data.error; errorEl.classList.remove('hidden'); }
      return;
    }

    narrativeData = data;
    renderNarrativeEditor(data);
    if (fill) fill.style.width = '0%';
  })
  .catch(function(e) {
    clearInterval(ticker);
    if (progress) progress.style.display = 'none';
    if (btn) btn.disabled = false;
    if (errorEl) { errorEl.textContent = 'Error: ' + e.message; errorEl.classList.remove('hidden'); }
  });
}

function renderNarrativeEditor(data) {
  var editor = document.getElementById('narrative-editor');
  var html = '';

  // Intro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Opening — before first panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-intro" placeholder="Opening paragraph that sets the scene...">' +
    (data.intro || '') + '</textarea>' +
  '</div>';

  // Per-moment sections
  state.moments.forEach(function(m, i) {
    var section = (data.sections || []).find(function(s) { return s.panel_index === i; }) || {};

    html += '<div class="narrative-section">' +
      '<div class="narrative-section-header">' +
        (m.image ? '<img class="narrative-section-img" src="' + m.image + '" alt="' + m.title + '" onclick="openLightbox(this.src,this.alt)" />' : '') +
        'Panel ' + (i+1) + ' — ' + m.title +
      '</div>' +
      '<textarea class="narrative-textarea" id="narrative-before-' + i + '" placeholder="Prose leading into this panel...">' +
      (section.before || '') + '</textarea>' +
      (i < state.moments.length - 1
        ? '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— panel image appears here —</div>' +
          '<textarea class="narrative-textarea" id="narrative-after-' + i + '" placeholder="Prose bridging from this panel to the next...">' +
          (section.after || '') + '</textarea>'
        : '<div style="padding:4px 14px;font-size:10px;color:rgba(201,168,76,0.3);font-style:italic;">— final panel image appears here —</div>') +
    '</div>';
  });

  // Outro section
  html += '<div class="narrative-section">' +
    '<div class="narrative-section-header">Closing — after final panel</div>' +
    '<textarea class="narrative-textarea" id="narrative-outro" placeholder="Closing paragraph — what this session meant, what comes next...">' +
    (data.outro || '') + '</textarea>' +
  '</div>';

  editor.innerHTML = html;
}

function collectNarrativeFromEditor() {
  var intro = document.getElementById('narrative-intro');
  var outro = document.getElementById('narrative-outro');
  var sections = state.moments.map(function(m, i) {
    var before = document.getElementById('narrative-before-' + i);
    var after = document.getElementById('narrative-after-' + i);
    return {
      panel_index: i,
      before: before ? before.value.trim() : '',
      after: after ? after.value.trim() : ''
    };
  });
  return {
    intro: intro ? intro.value.trim() : '',
    sections: sections,
    outro: outro ? outro.value.trim() : ''
  };
}

function saveNarrative() {
  var data = collectNarrativeFromEditor();
  fetch('/api/narrative/save/' + state.currentCampaign.id + '/' + state.currentSession.id, {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(data)
  })
  .then(function(r) { return r.json(); })
  .then(function(result) {
    if (result.error) { showAlert('Error saving: ' + result.error); return; }
    narrativeData = data;
    showAlert('Narrative saved!');
  });
}

// ============================================================
// PDF EXPORT
// ============================================================


// ============================================================
// LIGHTBOX
// ============================================================

function openLightbox(src, caption) {
  if (!src) return;

  // Remove any existing lightbox
  closeLightbox();

  var overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  overlay.id = 'lightbox';
  overlay.onclick = function(e) {
    if (e.target === overlay || e.target.classList.contains('lightbox-close')) {
      closeLightbox();
    }
  };

  var close = document.createElement('div');
  close.className = 'lightbox-close';
  close.innerHTML = '&times;';
  close.onclick = closeLightbox;

  var img = document.createElement('img');
  img.className = 'lightbox-img';
  img.src = src;
  img.alt = caption || '';

  overlay.appendChild(close);
  overlay.appendChild(img);

  if (caption) {
    var cap = document.createElement('div');
    cap.className = 'lightbox-caption';
    cap.textContent = caption;
    overlay.appendChild(cap);
  }

  document.body.appendChild(overlay);

  // Close on escape key
  document.addEventListener('keydown', handleLightboxKey);
}

function handleLightboxKey(e) {
  if (e.key === 'Escape') closeLightbox();
}

function closeLightbox() {
  var existing = document.getElementById('lightbox');
  if (existing) existing.remove();
  document.removeEventListener('keydown', handleLightboxKey);
}

// ============================================================
// UTILITIES
// ============================================================
function showModalError(id, msg) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showAlert(msg) {
  var el = document.createElement('div');
  el.className = 'alert alert-success';
  el.textContent = msg;
  el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:999;min-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.15);';
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, 2500);
}

// ============================================================
// PHASE 3 — INVITE FLOW
// ============================================================
// Deploy 1 of Phase 3: minimal invite-creation UI. The proper Members
// tab lives in Deploy 2; this is the bare-minimum modal so the flow is
// testable end-to-end on staging.

// Show/hide DM-only UI elements based on the current user's role in
// the current campaign. Toggles a 'role-player' class on <body>; CSS
// rules then hide everything marked .dm-only. Centralized here so every
// view-switch / re-render goes through one helper.
//
// Also handles the invite button which uses an explicit ID toggle
// (it's DM-only but lives outside the .dm-only convention because we
// already had it before Phase 3 Deploy 1 wrap-up).
function applyRoleVisibility() {
  var cur = state.currentCampaign;
  var role = cur ? cur.my_role : null;
  var isPlayer = (role === 'player');

  // body.role-player drives CSS to hide every .dm-only element.
  if (isPlayer) {
    document.body.classList.add('role-player');
  } else {
    document.body.classList.remove('role-player');
  }

  // Graphic Novel: visible to the SM (dm) always; to a player only when the SM
  // has enabled player access for THIS campaign (no tier gate).
  var _allowNovel = cur && (cur.allow_player_novel_access === true || cur.allow_player_novel_access === 1 || cur.allow_player_novel_access === 't' || cur.allow_player_novel_access === 'true');
  var _showNovel = (role === 'dm') || (isPlayer && _allowNovel);
  Array.prototype.forEach.call(document.querySelectorAll('.novel-nav-btn'), function(b){ b.style.display = _showNovel ? '' : 'none'; });

  // Invite button: DM-only, has its own ID-targeted toggle.
  var inviteBtn = document.getElementById('campaign-invite-btn');
  if (inviteBtn) {
    inviteBtn.style.display = (role === 'dm') ? '' : 'none';
  }

  // Text inputs that players can SEE but shouldn't EDIT (transcript,
  // session notes). CSS can't set readonly — it's an HTML attribute —
  // so we toggle it here whenever a campaign view re-renders.
  var readOnlyTargets = ['transcript-input'];
  readOnlyTargets.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (isPlayer) {
      el.setAttribute('readonly', 'readonly');
    } else {
      el.removeAttribute('readonly');
    }
  });
}

// Backward-compatible alias — older code may still call this name.
function refreshInviteButtonVisibility() { applyRoleVisibility(); }

// Open the invite-creation modal. Fetches the campaign's characters so
// the dropdown can list unowned PCs. The first option is always
// "Create new character" — picking it reveals the name/class inputs.
function openInviteModal() {
  var cur = state.currentCampaign;
  if (!cur) {
    showAlert('No campaign selected');
    return;
  }
  // Reset modal state.
  document.getElementById('invite-modal-error').classList.add('hidden');
  document.getElementById('invite-modal-step1').style.display = '';
  document.getElementById('invite-modal-step2').style.display = 'none';
  document.getElementById('invite-email').value = '';
  document.getElementById('invite-newchar-name').value = '';
  document.getElementById('invite-newchar-class').value = '';
  document.getElementById('invite-character-select').value = '__new__';
  document.getElementById('invite-newchar-fields').style.display = '';

  // Populate the character dropdown with PCs not yet owned (is_npc=false
  // AND owner_user_id IS NULL). We pull from the existing characters
  // endpoint and filter client-side.
  fetch('/api/campaigns/' + cur.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(chars) {
      var unowned = (chars || []).filter(function(c) {
        return !c.is_npc && !c.owner_user_id;
      });
      var sel = document.getElementById('invite-character-select');
      // Reset options to just "create new", then add unowned PCs.
      sel.innerHTML = '<option value="__new__">+ Create a new character for them</option>';
      unowned.forEach(function(c) {
        var opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.name + (c.cls ? ' (' + c.cls + ')' : '');
        sel.appendChild(opt);
      });
      // Wire change to toggle the new-character fields.
      sel.onchange = function() {
        document.getElementById('invite-newchar-fields').style.display =
          (sel.value === '__new__') ? '' : 'none';
      };
    })
    .catch(function() { /* non-fatal — DM can still create a new character */ });

  document.getElementById('invite-modal').classList.remove('hidden');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.add('hidden');
}

function submitInvite() {
  var cur = state.currentCampaign;
  if (!cur) return;
  var emailEl = document.getElementById('invite-email');
  var sel = document.getElementById('invite-character-select');
  var nameEl = document.getElementById('invite-newchar-name');
  var classEl = document.getElementById('invite-newchar-class');
  var errEl = document.getElementById('invite-modal-error');
  errEl.classList.add('hidden');

  var email = (emailEl.value || '').trim();
  if (!email) {
    errEl.textContent = 'Please enter the player\'s email.';
    errEl.classList.remove('hidden');
    return;
  }

  var body = { email: email };
  if (sel.value === '__new__') {
    var name = (nameEl.value || '').trim();
    if (!name) {
      errEl.textContent = 'Please enter a name for the new character.';
      errEl.classList.remove('hidden');
      return;
    }
    body.character_name = name;
    body.character_class = (classEl.value || '').trim();
  } else {
    body.character_id = parseInt(sel.value, 10);
  }

  fetch('/api/campaigns/' + cur.id + '/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }
    // Stash the link for the copy button and switch the modal to step 2.
    window.__lastInviteUrl = data.url;
    document.getElementById('invite-link-display').textContent = data.url;
    // Phase 3 Deploy 3: backend now emails the invitee directly. Status
    // line reflects whether the email actually went out. The URL stays
    // visible as a backup in either case (DM may still want to share
    // via Discord/text).
    var statusEl = document.getElementById('invite-modal-step2-status');
    if (statusEl) {
      var who = (data.email_hint ? data.email_hint : 'the invitee');
      if (data.email_sent) {
        statusEl.innerHTML = '&#9989; Invite emailed to <strong>' + who + '</strong>. The link below is a backup if they need it.';
      } else {
        statusEl.textContent = 'Invite created. Copy this link and send it to your player however you like (Discord, text, email, etc.).';
      }
    }
    document.getElementById('invite-modal-step1').style.display = 'none';
    document.getElementById('invite-modal-step2').style.display = '';
    // Phase 3 Deploy 2: if the DM is on the Members tab, refresh the
    // pending invites list in the background so the new invite is
    // visible immediately after they close the modal. Also refresh
    // characters in case a new stub PC was created. Both calls are
    // no-ops if the user isn't viewing those tabs — they just stage
    // fresh data for the next visit.
    if (typeof loadPendingInvites === 'function') loadPendingInvites();
    if (typeof loadCharacters === 'function') loadCharacters();
  })
  .catch(function(e) {
    errEl.textContent = 'Network error: ' + e.message;
    errEl.classList.remove('hidden');
  });
}

function copyInviteLink() {
  var url = window.__lastInviteUrl;
  if (!url) return;
  // Modern clipboard API with a fallback for older contexts.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      var btn = document.getElementById('invite-copy-btn');
      if (btn) {
        var prev = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = prev; }, 1500);
      }
    });
  } else {
    // Fallback: select the text and let the user copy manually.
    var el = document.getElementById('invite-link-display');
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ============================================================
// PHASE 3 DEPLOY 2 — Members tab
// ============================================================

// Run-time state for the Members tab. We cache the current list so the
// ellipsis menu and confirm modal handlers can look up rows by id.
state.members = [];
state.pendingInvites = [];
state._pendingRemoveUserId = null;
state._pendingRemoveUserName = null;
state._pendingRevokeInviteId = null;

// Entry point — call when the Members section is shown.
function loadMembersTab() {
  var cur = state.currentCampaign;
  if (!cur) return;
  loadMembers();
  // All members can see the pending invites list (per design — players
  // get to see who else is joining). Action buttons are dm-only at the
  // CSS level. Backend enforces verifyCampaignMember on the GET.
  loadPendingInvites();
}

function loadMembers() {
  var cur = state.currentCampaign;
  if (!cur) return;
  var list = document.getElementById('members-list');
  if (!list) return;
  list.innerHTML = '<div style="color:rgba(245,232,200,0.75);font-size:13px;padding:8px;">Loading members…</div>';

  fetch('/api/campaigns/' + cur.id + '/members')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (rows && rows.error) {
        list.innerHTML = '<div style="color:#f5b0a8;padding:8px;">' + rows.error + '</div>';
        return;
      }
      state.members = rows || [];
      renderMembersList();
    })
    .catch(function(e) {
      list.innerHTML = '<div style="color:#f5b0a8;padding:8px;">Could not load members: ' + e.message + '</div>';
    });
}

function renderMembersList() {
  var list = document.getElementById('members-list');
  if (!list) return;
  if (!state.members.length) {
    list.innerHTML = '<div style="color:rgba(245,232,200,0.75);font-size:13px;padding:8px;">No members yet.</div>';
    return;
  }
  var meUserId = (state.user && state.user.id) || null;
  list.innerHTML = state.members.map(function(m) {
    var isDM = (m.role === 'dm');
    var isMe = (m.user_id === meUserId);
    var icon = isDM ? '&#128081;' : '&#127922;'; // crown vs game die
    var roleBadge = isDM
      ? '<span class="role-badge role-badge-dm">Story Master</span>'
      : '<span class="role-badge role-badge-player">Player</span>';
    var meTag = isMe ? '<span style="font-size:11px;color:rgba(245,232,200,0.75);">(you)</span>' : '';
    var charInfo = m.character_name
      ? 'Playing ' + escapeHtml(m.character_name) + (m.character_class ? ' (' + escapeHtml(m.character_class) + ')' : '')
      : (isDM ? 'No character owned' : 'No character');
    var joined = m.joined_at ? 'Joined ' + formatJoinedDate(m.joined_at) : '';
    // Action menu: visible only to DM, and never for the DM's own row.
    var actions = '';
    if (!isDM && !isMe) {
      actions =
        '<div class="member-row-actions dm-only">' +
          '<div class="row-menu">' +
            '<button class="row-menu-btn" onclick="toggleRowMenu(\'member-menu-' + m.user_id + '\', event)">&#8943;</button>' +
            '<div class="row-menu-dropdown" id="member-menu-' + m.user_id + '">' +
              '<button class="row-menu-item" onclick="openMakeDmConfirm(' + m.user_id + ')">Make Story Master</button>' +
              '<button class="row-menu-item row-menu-item-danger" onclick="openRemoveMemberConfirm(' + m.user_id + ')">Remove from campaign</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }
    return '<div class="member-row">' +
      '<div class="member-row-icon">' + icon + '</div>' +
      '<div class="member-row-body">' +
        '<div class="member-row-name">' + escapeHtml(m.user_name || '') + ' ' + meTag + ' ' + roleBadge + '</div>' +
        '<div class="member-row-email">' + escapeHtml(m.user_email || '') + '</div>' +
        '<div class="member-row-meta">' + charInfo + (joined ? ' · ' + joined : '') + '</div>' +
      '</div>' +
      actions +
    '</div>';
  }).join('');
}

function loadPendingInvites() {
  var cur = state.currentCampaign;
  if (!cur) return;
  var list = document.getElementById('pending-invites-list');
  if (!list) return;
  list.innerHTML = '<div style="color:rgba(245,232,200,0.75);font-size:13px;padding:8px;">Loading invites…</div>';

  fetch('/api/campaigns/' + cur.id + '/invites')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (rows && rows.error) {
        list.innerHTML = '<div style="color:#f5b0a8;padding:8px;">' + rows.error + '</div>';
        return;
      }
      state.pendingInvites = rows || [];
      renderPendingInvites();
    })
    .catch(function(e) {
      list.innerHTML = '<div style="color:#f5b0a8;padding:8px;">Could not load invites: ' + e.message + '</div>';
    });
}

function renderPendingInvites() {
  var list = document.getElementById('pending-invites-list');
  if (!list) return;
  if (!state.pendingInvites.length) {
    list.innerHTML = '<div style="color:rgba(245,232,200,0.75);font-size:13px;padding:8px;">No pending invites.</div>';
    return;
  }
  list.innerHTML = state.pendingInvites.map(function(inv) {
    var expiresLabel = inv.expired
      ? '<span class="invite-row-expired-tag">Expired</span>'
      : 'Expires ' + formatExpiresInDays(inv.expires_at);
    var charInfo = inv.character_name
      ? 'Invited as ' + escapeHtml(inv.character_name) + (inv.character_class ? ' (' + escapeHtml(inv.character_class) + ')' : '')
      : 'No character linked';
    return '<div class="invite-row">' +
      '<div class="invite-row-icon">&#8987;</div>' + // hourglass
      '<div class="invite-row-body">' +
        '<div class="member-row-name">' + escapeHtml(inv.email_hint || '(no email)') + ' ' + expiresLabel + '</div>' +
        '<div class="member-row-meta">' + charInfo + '</div>' +
      '</div>' +
      '<div class="invite-row-actions dm-only">' +
        '<button class="btn btn-sm" onclick="copyExistingInviteLink(' + inv.id + ',' + (inv.expired ? 'true' : 'false') + ')">' +
          (inv.expired ? 'Reactivate &amp; copy' : 'Copy link') +
        '</button>' +
        '<div class="row-menu">' +
          '<button class="row-menu-btn" onclick="toggleRowMenu(\'invite-menu-' + inv.id + '\', event)">&#8943;</button>' +
          '<div class="row-menu-dropdown" id="invite-menu-' + inv.id + '">' +
            '<button class="row-menu-item row-menu-item-danger" onclick="openRevokeInviteConfirm(' + inv.id + ')">Revoke invite</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// Toggle a row's ellipsis dropdown. Closes other open dropdowns first.
function toggleRowMenu(menuId, ev) {
  if (ev) { ev.stopPropagation(); }
  var all = document.querySelectorAll('.row-menu-dropdown');
  all.forEach(function(d) { if (d.id !== menuId) d.classList.remove('open'); });
  var el = document.getElementById(menuId);
  if (el) el.classList.toggle('open');
}

// Clicking anywhere else closes any open menu.
document.addEventListener('click', function(ev) {
  // Only close if the click wasn't on a row-menu-btn (which has its own handler)
  if (ev.target && ev.target.closest && ev.target.closest('.row-menu')) return;
  document.querySelectorAll('.row-menu-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
});

// --- Remove member flow ---
function openRemoveMemberConfirm(userId) {
  var m = (state.members || []).find(function(x) { return x.user_id === userId; });
  if (!m) return;
  state._pendingRemoveUserId = userId;
  state._pendingRemoveUserName = m.user_name;
  var body = document.getElementById('confirm-remove-member-body');
  if (body) {
    var who = escapeHtml(m.user_name || 'this player');
    var what = m.character_name ? ' Their character "' + escapeHtml(m.character_name) + '" will become available for re-invite.' : '';
    body.innerHTML = 'Remove <strong>' + who + '</strong> from the campaign?' + what;
  }
  // Close any open ellipsis menus
  document.querySelectorAll('.row-menu-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  document.getElementById('confirm-remove-member-modal').classList.remove('hidden');
}

function closeConfirmRemoveMember() {
  state._pendingRemoveUserId = null;
  state._pendingRemoveUserName = null;
  document.getElementById('confirm-remove-member-modal').classList.add('hidden');
}

function confirmRemoveMember() {
  var uid = state._pendingRemoveUserId;
  var cur = state.currentCampaign;
  if (!uid || !cur) { closeConfirmRemoveMember(); return; }
  var btn = document.getElementById('confirm-remove-member-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
  fetch('/api/campaigns/' + cur.id + '/members/' + uid, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        showAlert(data.error);
      }
      closeConfirmRemoveMember();
      loadMembersTab();
    })
    .catch(function(e) {
      showAlert('Could not remove member: ' + e.message);
      closeConfirmRemoveMember();
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Remove'; }
    });
}

// --- Hand off Story Master role ---
function openMakeDmConfirm(userId) {
  var m = (state.members || []).find(function(x) { return x.user_id === userId; });
  if (!m) return;
  state._pendingMakeDmUserId = userId;
  var body = document.getElementById('confirm-make-dm-body');
  if (body) {
    var who = escapeHtml(m.user_name || 'this player');
    body.innerHTML = 'Make <strong>' + who + '</strong> the Story Master of this campaign? You will become a regular player.';
  }
  document.querySelectorAll('.row-menu-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  var el = document.getElementById('confirm-make-dm-modal');
  if (el) el.classList.remove('hidden');
}

function closeMakeDmConfirm() {
  state._pendingMakeDmUserId = null;
  var el = document.getElementById('confirm-make-dm-modal');
  if (el) el.classList.add('hidden');
}

function confirmMakeDm() {
  var uid = state._pendingMakeDmUserId;
  var cur = state.currentCampaign;
  if (!uid || !cur) { closeMakeDmConfirm(); return; }
  var btn = document.getElementById('confirm-make-dm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Transferring…'; }
  fetch('/api/campaigns/' + cur.id + '/members/' + uid + '/make-dm', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) {
        showAlert(data.error);
        if (btn) { btn.disabled = false; btn.textContent = 'Make Story Master'; }
        return;
      }
      // The acting user just handed off the DM role and is now a player --
      // reload so every role-gated piece of UI recomputes from the server.
      window.location.reload();
    })
    .catch(function(e) {
      showAlert('Could not transfer the Story Master role: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Make Story Master'; }
    });
}

// --- Revoke invite flow ---
function openRevokeInviteConfirm(inviteId) {
  var inv = (state.pendingInvites || []).find(function(x) { return x.id === inviteId; });
  if (!inv) return;
  state._pendingRevokeInviteId = inviteId;
  var body = document.getElementById('confirm-revoke-invite-body');
  if (body) {
    var who = escapeHtml(inv.email_hint || 'this invitee');
    body.innerHTML = 'Revoke the invitation to <strong>' + who + '</strong>?';
  }
  document.querySelectorAll('.row-menu-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  document.getElementById('confirm-revoke-invite-modal').classList.remove('hidden');
}

function closeConfirmRevokeInvite() {
  state._pendingRevokeInviteId = null;
  document.getElementById('confirm-revoke-invite-modal').classList.add('hidden');
}

function confirmRevokeInvite() {
  var iid = state._pendingRevokeInviteId;
  var cur = state.currentCampaign;
  if (!iid || !cur) { closeConfirmRevokeInvite(); return; }
  var btn = document.getElementById('confirm-revoke-invite-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Revoking…'; }
  fetch('/api/campaigns/' + cur.id + '/invites/' + iid, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) showAlert(data.error);
      closeConfirmRevokeInvite();
      loadPendingInvites();
    })
    .catch(function(e) {
      showAlert('Could not revoke: ' + e.message);
      closeConfirmRevokeInvite();
    })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Revoke'; }
    });
}

// --- Copy existing invite link (with silent reactivation if expired) ---
function copyExistingInviteLink(inviteId, expired) {
  var inv = (state.pendingInvites || []).find(function(x) { return x.id === inviteId; });
  if (!inv) return;
  var cur = state.currentCampaign;
  if (!cur) return;

  if (expired) {
    // Reactivate first, then copy. The token doesn't change — just bumps expires_at.
    fetch('/api/campaigns/' + cur.id + '/invites/' + inviteId + '/reactivate', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { showAlert(data.error); return; }
        writeToClipboard(inv.url, 'Reactivated & copied');
        // Refresh so the row no longer shows "expired"
        loadPendingInvites();
      })
      .catch(function(e) { showAlert('Could not reactivate: ' + e.message); });
  } else {
    writeToClipboard(inv.url, 'Copied');
  }
}

function writeToClipboard(text, flashText) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      // Brief feedback by showing a temporary toast-ish alert. Reuse showAlert.
      if (flashText) showAlert(flashText);
    });
  } else {
    // Fallback: prompt the user to copy manually
    window.prompt('Copy this invite link:', text);
  }
}

// --- Small format helpers ---
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatJoinedDate(iso) {
  try {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return ''; }
}

function formatExpiresInDays(iso) {
  try {
    var d = new Date(iso);
    var now = new Date();
    var ms = d - now;
    var days = Math.max(0, Math.round(ms / 86400000));
    if (days === 0) return 'today';
    if (days === 1) return 'in 1 day';
    return 'in ' + days + ' days';
  } catch (e) { return ''; }
}

// ============================================================
// PHASE 3 DEPLOY 3 — Session access-status UI (Draft / Ready)
// ============================================================
// On session-view open we set the dropdown (DM) or chip (player) based
// on the session's current player_access_status. Changing the dropdown
// fires onAccessStatusChange — Draft→Ready shows a confirm modal,
// Ready→Draft toggles immediately.

state._pendingAccessStatus = null;

function canEditCurrentStatus() {
  var role = state.currentCampaign && state.currentCampaign.my_role;
  // DM edits the canonical (DM fork) status; a player edits the status of
  // their OWN version. Read-only for any other view.
  if (role === 'dm') return !state.currentForkId;
  return !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
}

function initAccessStatusUI(status) {
  var safeStatus = (status === 'ready') ? 'ready' : 'draft';
  var sel = document.getElementById('session-access-status-select');
  var chip = document.getElementById('session-access-status-chip');
  var editable = canEditCurrentStatus();

  if (sel) {
    sel.value = safeStatus;
    sel.style.display = editable ? '' : 'none';
  }
  if (chip) {
    if (editable) {
      chip.style.display = 'none';
    } else {
      chip.style.display = '';
      chip.className = 'session-access-chip session-access-chip-' + safeStatus;
      chip.textContent = safeStatus === 'ready' ? 'Ready' : 'Draft';
    }
  }
  // Cache so we can revert the select if user cancels the confirm modal.
  state._currentAccessStatus = safeStatus;
}

function onAccessStatusChange(newValue) {
  var current = state._currentAccessStatus || 'draft';
  if (newValue === current) return;

  var isDMCanonical = (state.currentCampaign && state.currentCampaign.my_role === 'dm') && !state.currentForkId;
  if (newValue === 'ready' && current === 'draft' && isDMCanonical) {
    // High-consequence DM transition (locks canonical editing) — confirm.
    state._pendingAccessStatus = newValue;
    document.getElementById('confirm-ready-modal').classList.remove('hidden');
  } else {
    // Player marking their own version, or any Ready → Draft — apply now.
    saveAccessStatus(newValue);
  }
}

function closeConfirmReady() {
  // User canceled — revert the dropdown back to the cached current value.
  var sel = document.getElementById('session-access-status-select');
  if (sel) sel.value = state._currentAccessStatus || 'draft';
  state._pendingAccessStatus = null;
  document.getElementById('confirm-ready-modal').classList.add('hidden');
}

function confirmMarkReady() {
  var pending = state._pendingAccessStatus;
  state._pendingAccessStatus = null;
  document.getElementById('confirm-ready-modal').classList.add('hidden');
  if (pending) saveAccessStatus(pending);
}

function saveAccessStatus(status) {
  var cur = state.currentCampaign;
  var sess = state.currentSession;
  if (!cur || !sess) return;
  var btn = document.getElementById('confirm-ready-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  fetch('/api/campaigns/' + cur.id + '/sessions/' + sess.id + '/access-status', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      showAlert(data.error);
      // Revert dropdown
      var sel = document.getElementById('session-access-status-select');
      if (sel) sel.value = state._currentAccessStatus || 'draft';
      return;
    }
    state._currentAccessStatus = status;
    if (state.currentSession) state.currentSession.player_access_status = status;
    // Update the local locked flag immediately so the UI feels responsive.
    // Then re-fetch /api/campaigns to get the authoritative value (handles
    // the edge case where another session is still Ready after this one
    // goes back to Draft).
    if (state.currentCampaign) {
      if (status === 'ready') {
        state.currentCampaign.locked = true;
      }
      // If we went ready → draft, leave .locked alone until the refetch
      // tells us the truth — other sessions might still be Ready.
    }
    // Re-fetch authoritative campaigns list. After loadCampaigns runs,
    // re-point state.currentCampaign to the refreshed object so anything
    // reading .locked sees the latest.
    fetch('/api/campaigns')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        state.campaigns = Array.isArray(rows) ? rows : [];
        if (state.currentCampaign) {
          var refreshed = state.campaigns.find(function(c) { return c.id === state.currentCampaign.id; });
          if (refreshed) state.currentCampaign = refreshed;
        }
      })
      .catch(function() { /* non-fatal */ });
  })
  .catch(function(e) {
    showAlert('Could not update status: ' + e.message);
    var sel = document.getElementById('session-access-status-select');
    if (sel) sel.value = state._currentAccessStatus || 'draft';
  })
  .finally(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Mark Ready'; }
  });
}

// ============================================================
// PHASE 4 STEP 2 — VERSION (FORK) SELECTOR
// ============================================================
// state.currentForkId === null means "viewing the DM canonical".
// A player may edit only when viewing their OWN version; toggling the
// body class flips the per-panel edit/regen controls on for them.
function updateForkEditability() {
  var role = state.currentCampaign && state.currentCampaign.my_role;
  var canEdit = (role === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
  document.body.classList.toggle('can-edit-fork', !!canEdit);
  // Can the viewer edit the CURRENTLY shown fork? DM may edit only canonical
  // (no currentForkId); a player only their own version. Any other view
  // (e.g. DM looking at a player's version) is read-only.
  var canEditCurrent = (role === 'dm') ? !state.currentForkId
    : !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
  document.body.classList.toggle('viewing-foreign-fork', !canEditCurrent);
}

function forkQ() {
  return state.currentForkId ? ('?fork_id=' + encodeURIComponent(state.currentForkId)) : '';
}

function loadSessionForks(sessionId) {
  if (!state.currentCampaign) return;
  var sel = document.getElementById('session-fork-select');
  var btn = document.getElementById('make-my-version-btn');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + sessionId + '/forks')
    .then(function(r) { return r.json(); })
    .then(function(forks) {
      forks = Array.isArray(forks) ? forks : [];
      state.sessionForks = forks;
      var dmFork = forks.filter(function(f) { return f.role === 'dm'; })[0];
      if (sel) {
        sel.innerHTML = '';
        forks.forEach(function(f) {
          var opt = document.createElement('option');
          opt.value = f.fork_id;
          opt.textContent = f.label;
          sel.appendChild(opt);
        });
        var selId = state.currentForkId || (dmFork ? dmFork.fork_id : (forks[0] && forks[0].fork_id));
        if (selId) sel.value = String(selId);
        // Only worth showing once there's more than the canonical to pick.
        sel.style.display = forks.length > 1 ? '' : 'none';
      }
      var mineFork = forks.filter(function(f) { return f.is_mine; })[0];
      state.myForkId = mineFork ? mineFork.fork_id : null;
      if (btn) {
        var isPlayer = state.currentCampaign.my_role === 'player';
        var sessReady = state.currentSession && state.currentSession.player_access_status === 'ready';
        btn.style.display = (isPlayer && sessReady && !mineFork) ? '' : 'none';
      }
      var verMenu = document.getElementById('session-version-menu');
      if (verMenu) verMenu.style.display = mineFork ? '' : 'none';
      // Phase 4 - default a player onto their OWN version of this session
      // when they have one. The Story Master (and players with no version)
      // stay on the canonical. Only applies on a fresh load (currentForkId
      // not yet chosen); an explicit dropdown pick goes through onForkChange.
      var _defaultedToOwn = false;
      if (!state.currentForkId && mineFork && mineFork.role !== 'dm') {
        state.currentForkId = mineFork.fork_id;
        if (sel) sel.value = String(mineFork.fork_id);
        _defaultedToOwn = true;
      }
      updateForkEditability();
      if (_defaultedToOwn && typeof reloadSessionForFork === 'function') reloadSessionForFork();
    })
    .catch(function() {});
}

function onForkChange(forkId) {
  var dmFork = (state.sessionForks || []).filter(function(f) { return f.role === 'dm'; })[0];
  // Selecting the DM canonical clears currentForkId (default path).
  state.currentForkId = (dmFork && String(forkId) === String(dmFork.fork_id)) ? null : forkId;
  updateForkEditability();
  reloadSessionForFork();
}

function updateNotesBox(data) {
  var role = state.currentCampaign && state.currentCampaign.my_role;
  var ownFork = (role === 'player') && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId));
  var notesEl = document.getElementById('session-notes-input');
  if (notesEl) {
    notesEl.value = state.currentForkId ? (data.fork_notes || '') : (data.session_notes || '');
    var notesEditable = ownFork || (role === 'dm' && !state.currentForkId);
    if (notesEditable) { notesEl.removeAttribute('readonly'); } else { notesEl.setAttribute('readonly', 'readonly'); }
    notesEl.onblur = function() {
      if (ownFork) { saveForkNotes(notesEl.value.trim()); }
      else if (role === 'dm' && !state.currentForkId) { saveSessionField('session_notes', notesEl.value.trim()); }
    };
  }
  var transcriptEl = document.getElementById('transcript-input');
  if (transcriptEl) {
    transcriptEl.value = data.transcript || '';
    if (role === 'dm') { transcriptEl.removeAttribute('readonly'); } else { transcriptEl.setAttribute('readonly', 'readonly'); }
    transcriptEl.onblur = function() {
      if (role === 'dm') { saveSessionField('transcript', transcriptEl.value.trim()); }
    };
  }
}

function saveForkNotes(value) {
  if (!state.currentCampaign || !state.currentSession || !state.currentForkId) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/fork-notes', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: value })
  })
  .then(function(r) { return r.json(); })
  .then(function() {
    var saved = document.getElementById('notes-saved');
    if (saved) { saved.textContent = 'Notes saved'; saved.classList.remove('hidden'); setTimeout(function() { saved.classList.add('hidden'); }, 1800); }
  })
  .catch(function() {});
}

function reloadSessionForFork() {
  if (!state.currentCampaign || !state.currentSession) return;
  var sid = state.currentSession.id;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + sid + forkQ())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      state.currentSession = data;
      state.moments = data.moments || [];
      state.narrativeData = {
        intro: data.narrative_intro || '',
        sections: data.narrative_sections ? JSON.parse(data.narrative_sections) : [],
        outro: data.narrative_outro || ''
      };
      // Per-gap narrative directions for this version (Pass 1) — drives the
      // Direction pills on Review and the "prompt" blocks under the Storyboard
      // narrative panels.
      try { state.narrativeDirections = data.narrative_directions ? JSON.parse(data.narrative_directions) : {}; }
      catch (e) { state.narrativeDirections = {}; }
      // Narrative Styles: this version's narrative voice preset (defaults to 'classic').
      state.narrativeStyle = (data && data.narrative_style) ? data.narrative_style : 'classic';
      state.narrativeStyleUsed = (data && data.narrative_style_used) ? data.narrative_style_used : state.narrativeStyle;
      if (typeof refreshNarrStyleButtons === 'function') refreshNarrStyleButtons();
      if (typeof renderStoryboard === 'function') renderStoryboard();
      if (typeof initAccessStatusUI === 'function') initAccessStatusUI(data.fork_status || data.player_access_status || 'draft');
      if (typeof updateNotesBox === 'function') updateNotesBox(data);
      // Refresh the session-character list so amendment controls reflect
      // the newly-selected version (editable on your own, read-only else).
      if (typeof loadSessionCharacters === 'function') loadSessionCharacters();
      // If the Publish/Preview tab is open, re-render the preview for the
      // newly-selected version (it reads fork_id from state.currentForkId).
      var _exp = document.getElementById('session-tab-export');
      if (_exp && _exp.style.display !== 'none' && typeof loadPreview === 'function') {
        loadPreview(state.layoutStyle || 'Classic');
      }
      // Other tabs lazy-reload on click via forkQ(); storyboard is the
      // live view, so refresh it immediately.
    });
}

function makeMyVersion() {
  if (!state.currentCampaign || !state.currentSession) return;
  var btn = document.getElementById('make-my-version-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating\u2026'; }
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/fork', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Make My Version'; }
      if (data && data.error) { if (typeof showAlert === 'function') { showAlert(data.error); } else { alert(data.error); } return; }
      state.currentForkId = data.fork_id;
      loadSessionForks(state.currentSession.id);
      reloadSessionForFork();
    })
    .catch(function(e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Make My Version'; }
      if (typeof showAlert === 'function') { showAlert('Could not create your version: ' + e.message); } else { alert(e.message); }
    });
}

function deleteMyVersion() {
  if (!state.currentCampaign || !state.currentSession || !state.myForkId) return;
  if (!confirm('Delete your version of this session? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/fork/' + state.myForkId, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) { if (typeof showAlert === 'function') { showAlert(data.error); } else { alert(data.error); } return; }
      state.currentForkId = null;
      state.myForkId = null;
      loadSessionForks(state.currentSession.id);
      reloadSessionForFork();
    })
    .catch(function(e) { if (typeof showAlert === 'function') { showAlert('Delete failed: ' + e.message); } else { alert(e.message); } });
}

// Render a lock banner on the Characters tab for players when the
// campaign is locked. Called from showCampaignSection('characters').
// Banner sits above the character grid; subtle but informative.
function renderCampaignLockBanner() {
  var grid = document.getElementById('char-grid');
  if (!grid) return;
  // Remove any prior banner first
  var existing = document.getElementById('campaign-lock-banner');
  if (existing) existing.remove();

  var cur = state.currentCampaign;
  if (!cur) return;
  // Banner only for players viewing a locked campaign.
  if (cur.my_role !== 'player') return;
  if (!cur.locked) return;

  var banner = document.createElement('div');
  banner.id = 'campaign-lock-banner';
  banner.className = 'campaign-lock-banner';
  banner.innerHTML =
    '<span class="campaign-lock-banner-icon">&#128274;</span>' +
    '<strong>Campaign locked.</strong> A session has been marked Ready by the Story Master, so your character\'s canonical details are now read-only. ' +
    'Open a Ready session and choose <strong>Make My Version</strong> to tinker in your own copy.';
  // Insert before the char-grid
  grid.parentNode.insertBefore(banner, grid);
}

// ============================================================
// ADMIN SETTINGS — tabs + Tiers config (Phase A)
// General tab = the existing settings panels. Tiers tab = per-tier limit
// editors backed by GET/PUT /api/admin/tier-config (admin-only). The field
// set is driven by the server response so it grows automatically in later
// phases. Numeric fields only for now (styles + tokens land in B/C).
// ============================================================
var TIER_FIELD_LABELS = {
  price: 'Price ($ / month, 0 = Invite only)',
  max_archives_per_campaign: 'Archived images / campaign',
  max_assets: 'Max campaign assets (blank = unlimited)',
  max_moments_short: 'Max moments \u2014 short (<2k words)',
  max_moments_medium: 'Max moments \u2014 medium (2k\u20135k)',
  max_moments_long: 'Max moments \u2014 long (5k\u201310k)',
  max_moments_epic: 'Max moments \u2014 epic (10k+)'
};

function switchSettingsTab(tab) {
  ['general', 'tiers', 'stats', 'trends', 'financial'].forEach(function (t) {
    var pane = document.getElementById('settings-pane-' + t);
    var btn = document.getElementById('settings-tab-' + t);
    if (pane) pane.style.display = (t === tab) ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'general') loadPrintMarkup();
  if (tab === 'tiers') loadTiersConfig();
  if (tab === 'stats') loadStats();
  if (tab === 'trends') loadTrends();
}

function loadTiersConfig() {
  var box = document.getElementById('tiers-config-container');
  var msg = document.getElementById('tiers-config-msg');
  if (msg) msg.textContent = '';
  if (box) box.textContent = 'Loading tiers...';
  fetch('/api/admin/tier-config')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || !data.tiers) {
        if (box) box.textContent = (data && (data.message || data.error)) || 'Could not load tiers.';
        return;
      }
      renderTiersConfig(data);
    })
    .catch(function (e) { if (box) box.textContent = 'Could not load tiers: ' + e.message; });
}

function renderTiersConfig(data) {
  var box = document.getElementById('tiers-config-container');
  if (!box) return;
  var fields = data.fields || [];
  var html = '';
  (data.order || []).forEach(function (tierKey) {
    var t = data.tiers[tierKey];
    if (!t) return;
    html += '<div class="settings-section tier-config-panel" id="tier-panel-' + tierKey + '">';
    html += '<div class="settings-section-title">' + (t.name || tierKey) + '</div>';
    html += '<div class="tier-config-grid">';
    fields.forEach(function (f) {
      var val = (t[f] === null || t[f] === undefined) ? '' : t[f];
      var label = TIER_FIELD_LABELS[f] || f;
      html += '<div class="form-group" style="margin-bottom:0;">' +
        '<label class="form-label">' + label + '</label>' +
        '<input class="form-input tier-config-input" type="number" min="0" step="1" ' +
        'data-tier="' + tierKey + '" data-field="' + f + '" value="' + val + '" />' +
        '</div>';
    });
    html += '</div>';
    html += '<div style="margin-top:12px;display:flex;align-items:center;gap:10px;">' +
      '<button class="btn btn-primary btn-sm" onclick="saveTierPanel(\'' + tierKey + '\')">Save ' + (t.name || tierKey) + '</button>' +
      '<span class="settings-section-desc" id="tier-save-msg-' + tierKey + '" style="margin:0;"></span>' +
      '</div>';
    html += '</div>';
  });
  box.innerHTML = html;
}

function saveTierPanel(tierKey) {
  var inputs = document.querySelectorAll('.tier-config-input[data-tier="' + tierKey + '"]');
  var values = {};
  inputs.forEach(function (inp) {
    var f = inp.getAttribute('data-field');
    var v = inp.value;
    values[f] = (v === '' ? null : parseInt(v, 10));
  });
  var msgEl = document.getElementById('tier-save-msg-' + tierKey);
  if (msgEl) { msgEl.textContent = 'Saving...'; msgEl.style.color = ''; }
  fetch('/api/admin/tier-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: tierKey, values: values })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.success) {
        if (msgEl) { msgEl.textContent = 'Saved.'; msgEl.style.color = 'var(--gold)'; }
      } else {
        if (msgEl) { msgEl.textContent = (data && (data.message || data.error)) || 'Save failed.'; msgEl.style.color = 'var(--error)'; }
      }
    })
    .catch(function (e) { if (msgEl) { msgEl.textContent = 'Save failed: ' + e.message; msgEl.style.color = 'var(--error)'; } });
}

// ----- Admin Settings: Stats tab (queried on open) -----
function loadStats() {
  var box = document.getElementById('stats-container');
  if (box) box.textContent = 'Loading stats...';
  fetch('/api/admin/stats')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || data.error) {
        if (box) box.textContent = (data && (data.message || data.error)) || 'Could not load stats.';
        return;
      }
      renderStats(data);
    })
    .catch(function (e) { if (box) box.textContent = 'Could not load stats: ' + e.message; });
}

function renderStats(d) {
  var box = document.getElementById('stats-container');
  if (!box) return;
  function row(name, val) {
    var v = (val === null || val === undefined) ? '\u2014' : val;
    return '<div class="stat-row"><span class="stat-name">' + name + '</span>' +
      '<span class="stat-num">' + v + '</span></div>';
  }
  var html = '<div class="stats-list">';
  html += row('Total active users', d.active_users);
  html += row('New users (last 30 days)', d.new_users_30);
  html += row('New users (last 90 days)', d.new_users_90);
  html += row('Moments generated (last 30 days)', d.moments_30);
  html += row('Moments generated (last 90 days)', d.moments_90);
  html += row('Total Fal calls', d.fal_calls);
  html += row('Tokens purchased (last 30 days)', d.tokens_purchased_30);
  html += row('Tokens purchased (last 90 days)', d.tokens_purchased_90);
  html += row('Total active campaigns', d.active_campaigns);
  html += '</div>';
  var tiers = d.tier_counts || {};
  html += '<div class="stats-subhead">Users by tier</div><div class="stats-list">';
  [['copper', 'Copper'], ['silver', 'Silver'], ['gold', 'Gold'], ['platinum', 'Platinum']].forEach(function (t) {
    html += row(t[1], (tiers[t[0]] === null || tiers[t[0]] === undefined) ? 0 : tiers[t[0]]);
  });
  html += '</div>';
  box.innerHTML = html;
}

// ----- Layout styles (shared style-picker; mirrors art/narrative) -----
// Two contexts share this metadata: the session Publish tab (kind 'layout',
// persisted to the session via layout_style) and the graphic-novel screen
// (kind 'novel-layout', ad-hoc novelLayoutStyle, not persisted). Layouts are
// not tier-gated, so the picker renders them all unlocked.
var LAYOUT_STYLE_META = [
  { id: 'Mosaic', name: 'Mosaic', desc: 'Mixed-size panels in a clean, modern grid — the dynamic graphic-novel look.' },
  { id: 'Ironframe', name: 'Ironframe', desc: 'Bold bordered panels with gutters, like a printed comic page.' },
  { id: 'Spectacle', name: 'Spectacle', desc: 'Splash-forward: dominant hero images with smaller beats around them.' },
  { id: 'Eclipse', name: 'Eclipse', desc: 'Full-bleed, frameless art that runs corner to corner — cinematic.' },
  { id: 'Reverie', name: 'Reverie', desc: 'Soft, feathered images that fade into the page — illustrated-novel feel.' },
  { id: 'Folio', name: 'Folio', desc: 'Large gallery images with generous white space — a premium art book.' },
  { id: 'Saga', name: 'Saga', desc: 'Large illustrations paired with flowing narrative text blocks.' }
];

var LAYOUT_LEGACY = { classic: 'Saga', storybook: 'Saga', comicbook: 'Ironframe', cinematic: 'Ironframe', action: 'Spectacle', dramatic: 'Spectacle' };
function normalizeLayoutId(v) {
  if (!v) return 'Mosaic';
  return LAYOUT_LEGACY[('' + v).toLowerCase()] || v;
}
function layoutStyleName(v) {
  var key = normalizeLayoutId(v);
  for (var i = 0; i < LAYOUT_STYLE_META.length; i++) {
    if (LAYOUT_STYLE_META[i].id === key) return LAYOUT_STYLE_META[i].name;
  }
  return key || 'Mosaic';
}

function refreshLayoutStyleButtons() {
  var sb = document.getElementById('layout-style-btn');
  if (sb) sb.textContent = 'Layout: ' + layoutStyleName(state.layoutStyle || 'Classic');
  var nb = document.getElementById('novel-layout-btn');
  var nv = (typeof novelLayoutStyle !== 'undefined' && novelLayoutStyle) ? novelLayoutStyle : 'Classic';
  if (nb) nb.textContent = 'Layout: ' + layoutStyleName(nv);
  var _clCO = (typeof customOpts !== 'undefined') ? customOpts : {};
  var _clAc = (typeof customActive !== 'undefined') ? customActive : {};
  var scb = document.getElementById('session-custom-btn');
  if (scb) scb.textContent = _clAc.session ? ('Layout: ' + ((_clCO.session && CL_ARRANGE_LABEL[_clCO.session.arrange]) || 'Custom')) : 'Layout';
  var ncb = document.getElementById('novel-custom-btn');
  if (ncb) ncb.textContent = _clAc.novel ? ('Layout: ' + ((_clCO.novel && CL_ARRANGE_LABEL[_clCO.novel.arrange]) || 'Custom')) : 'Layout';
}

// ===== Custom (a-la-carte) layout =====
var CUSTOM_LAYOUT_DEFAULTS = {
  arrange:'comicpage', border:'keyline', caption:'bar',
  narr:'plain', font:'classic', dropcap:0, paper:'white',
  pano:1, aside:1, companion:1, emphasis:0,
  cover:1, cast:1, toc:1, header:1, markers:1, watermark:1,
  hidelogo:0
};
function clClone(o){ var r={}; for (var k in o) { if (o.hasOwnProperty(k)) r[k]=o[k]; } return r; }
var customOpts = { session: clClone(CUSTOM_LAYOUT_DEFAULTS), novel: clClone(CUSTOM_LAYOUT_DEFAULTS) };
var customActive = { session:false, novel:false };
var _clCtx = 'novel';
var CL_LS_KEY = 'campaignia.customLayout';
var CL_CONDITION_VALUES = { smoke:1, dirt:1, wrinkle:1, blood:1 };
function clMerge(saved){
  var r=clClone(CUSTOM_LAYOUT_DEFAULTS);
  if(saved){ for (var k in CUSTOM_LAYOUT_DEFAULTS){ if(saved.hasOwnProperty(k)) r[k]=saved[k]; } }
  // Legacy migration: old single 'paper' control could hold a condition (smoke/dirt/...).
  if (CL_CONDITION_VALUES[r.paper]) { r.paper = 'white'; }
  if (r.paper === 'parchment') { r.paper = 'linen'; }
  return r;
}
function saveCustomLayoutPrefs(){
  try { window.localStorage.setItem(CL_LS_KEY, JSON.stringify({ opts: customOpts, active: customActive })); } catch (e) {}
}
(function loadCustomLayoutPrefs(){
  try {
    var raw = window.localStorage.getItem(CL_LS_KEY);
    if (!raw) return;
    var saved = JSON.parse(raw);
    if (saved && saved.opts) {
      customOpts.session = clMerge(saved.opts.session);
      customOpts.novel = clMerge(saved.opts.novel);
    }
    if (saved && saved.active) {
      customActive.session = !!saved.active.session;
      customActive.novel = !!saved.active.novel;
    }
  } catch (e) {}
})();
var CL_SELECTS = ['arrange','border','caption','paper','narr','font'];
var CL_TOGGLES = ['dropcap','header','markers','cover','cast','toc','hidelogo'];
var CL_ARRANGE_LABEL = { paired:'Picture Book', comicpage:'Comic', magazine:'Magazine' };

function openCustomLayout(ctx){
  _clCtx = ctx || 'novel';
  var modal=document.getElementById('custom-layout-modal');
  if(modal){ modal.style.display=''; modal.classList.remove('hidden'); }
  var o = customOpts[_clCtx] || CUSTOM_LAYOUT_DEFAULTS;
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('cl-'+k); if(el) el.value=o[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('cl-'+k); if(el) el.checked=!!o[k]; });
  (function(){ var _plat = !!(state.tierInfo && state.tierInfo.effective_rank >= 4); var _hl=document.getElementById('cl-hidelogo'); if(_hl){ _hl.disabled=!_plat; if(!_plat) _hl.checked=false; } var _hll=document.getElementById('cl-hidelogo-label'); if(_hll){ _hll.style.opacity=_plat?'1':'0.55'; _hll.title=_plat?'Hide the Campaignia logo on the cover':'Hiding the logo is a Platinum feature'; } })();
  var lbl=document.getElementById('cl-ctx-label'); if(lbl) lbl.textContent = (_clCtx==='novel' ? '(graphic novel)' : '(this session)');
  var novelOnly=document.querySelectorAll('.cl-novel-only');
  for (var i=0;i<novelOnly.length;i++){ novelOnly[i].style.display = (_clCtx==='novel' ? 'flex' : 'none'); }
}
function closeCustomLayout(){ var m=document.getElementById('custom-layout-modal'); if(m) m.classList.add('hidden'); }
function resetCustomLayout(){ customOpts[_clCtx]=clClone(CUSTOM_LAYOUT_DEFAULTS); saveCustomLayoutPrefs(); openCustomLayout(_clCtx); }
function applyCustomLayout(){
  var o={};
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('cl-'+k); o[k]= el ? el.value : CUSTOM_LAYOUT_DEFAULTS[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('cl-'+k); o[k]= (el && el.checked) ? 1 : 0; });
  customOpts[_clCtx]=o;
  customActive[_clCtx]=true;
  saveCustomLayoutPrefs();
  closeCustomLayout();
  refreshLayoutStyleButtons();
  if(_clCtx==='novel'){ if(typeof loadNovelPreview==='function') loadNovelPreview(novelLayoutStyle); }
  else { if(typeof loadPreview==='function') loadPreview(state.layoutStyle || 'Classic'); }
}
function serializeCustomOpts(o){
  var parts=[];
  for (var k in o){ if(o.hasOwnProperty(k)) parts.push(k+':'+o[k]); }
  return parts.join(',');
}
function customOptsQ(ctx, prefix){
  if(!customActive[ctx]) return '';
  return (prefix||'&')+'co='+encodeURIComponent(serializeCustomOpts(customOpts[ctx]));
}

// ----- Campaign settings modal (SM/DM only) -----
// Opened from the ellipsis on a campaign card. Holds per-campaign options;
// starts with "allow players access to graphic novel" and has room to grow.
var _csCampaignId = null;

function openCampaignSettings(id, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  _csCampaignId = id;
  var c = (state.campaigns || []).filter(function (x) { return x.id === id; })[0];
  var cb = document.getElementById('cs-allow-novel');
  if (cb) {
    var v = c && c.allow_player_novel_access;
    cb.checked = (v === true || v === 1 || v === 't' || v === 'true');
  }
  var err = document.getElementById('campaign-settings-error');
  if (err) err.classList.add('hidden');
  var modal = document.getElementById('campaign-settings-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeCampaignSettings() {
  var modal = document.getElementById('campaign-settings-modal');
  if (modal) modal.classList.add('hidden');
  _csCampaignId = null;
}

function saveCampaignSettings() {
  if (!_csCampaignId) { closeCampaignSettings(); return; }
  var cb = document.getElementById('cs-allow-novel');
  var allow = !!(cb && cb.checked);
  var btn = document.getElementById('cs-save-btn');
  var err = document.getElementById('campaign-settings-error');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  fetch('/api/campaigns/' + _csCampaignId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow_player_novel_access: allow })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (!data || data.error) {
        if (err) { err.textContent = (data && data.error) || 'Could not save settings.'; err.classList.remove('hidden'); }
        return;
      }
      var saveId = _csCampaignId;
      (state.campaigns || []).forEach(function (x) { if (x.id === saveId) x.allow_player_novel_access = allow; });
      if (state.currentCampaign && state.currentCampaign.id === saveId) state.currentCampaign.allow_player_novel_access = allow;
      closeCampaignSettings();
    })
    .catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (err) { err.textContent = 'Could not save settings: ' + e.message; err.classList.remove('hidden'); }
    });
}

// ----- Admin: run the weekly metrics snapshot on demand -----
function runSnapshotNow() {
  var btn = document.getElementById('snapshot-run-btn');
  var msg = document.getElementById('snapshot-run-msg');
  if (btn) btn.disabled = true;
  if (msg) { msg.textContent = 'Running...'; msg.style.color = ''; }
  fetch('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (btn) btn.disabled = false;
      if (data && data.success) {
        if (msg) { msg.textContent = 'Snapshot saved for week of ' + data.week_start + ' (' + data.written + ' values).'; msg.style.color = 'var(--gold)'; }
      } else {
        if (msg) { msg.textContent = (data && (data.message || data.error)) || 'Snapshot failed.'; msg.style.color = 'var(--error)'; }
      }
    })
    .catch(function (e) {
      if (btn) btn.disabled = false;
      if (msg) { msg.textContent = 'Snapshot failed: ' + e.message; msg.style.color = 'var(--error)'; }
    });
}

// ============================================================
// ADMIN DASHBOARD — Trends tab (inline SVG charts, dependency-free)
// Reads GET /api/admin/trends. active_users + per-tier come from weekly
// snapshots (true history); tokens purchased is live from the ledger.
// ============================================================
function loadTrends() {
  var box = document.getElementById('trends-container');
  if (box) box.textContent = 'Loading trends...';
  fetch('/api/admin/trends?weeks=12')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || data.error) {
        if (box) box.textContent = (data && (data.message || data.error)) || 'Could not load trends.';
        return;
      }
      renderTrends(data);
    })
    .catch(function (e) { if (box) box.textContent = 'Could not load trends: ' + e.message; });
}

function renderTrends(data) {
  var box = document.getElementById('trends-container');
  if (!box) return;
  var tc = data.tier_counts || {};
  var html = '';
  html += trendBlock('Active users (weekly)', svgFromSeries([
    { name: 'Active users', color: 'var(--gold)', points: data.active_users || [] }
  ]));
  html += trendBlock('Tokens purchased (weekly)', svgFromSeries([
    { name: 'Tokens purchased', color: 'var(--gold)', points: data.tokens_purchased || [] }
  ]));
  html += trendBlock('Users by tier (weekly)', svgFromSeries([
    { name: 'Copper', color: '#c87f4a', points: tc.copper || [] },
    { name: 'Silver', color: '#b9c2cc', points: tc.silver || [] },
    { name: 'Gold', color: '#d8b84c', points: tc.gold || [] },
    { name: 'Platinum', color: '#7fb0c8', points: tc.platinum || [] }
  ]));
  box.innerHTML = html;
}

function trendBlock(title, body) {
  return '<div class="trend-block"><div class="trend-title">' + title + '</div>' + body + '</div>';
}

function trendShortDate(w) {
  var p = String(w).slice(0, 10).split('-');
  if (p.length < 3) return String(w);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var mi = parseInt(p[1], 10) - 1;
  return (months[mi] || p[1]) + ' ' + parseInt(p[2], 10);
}

function svgFromSeries(seriesIn) {
  var weekSet = {};
  seriesIn.forEach(function (s) { (s.points || []).forEach(function (pt) { weekSet[String(pt.week_start).slice(0, 10)] = true; }); });
  var weeks = Object.keys(weekSet).sort();
  if (!weeks.length) {
    return '<div class="trend-empty">No data yet \u2014 the first weekly snapshot will show up here.</div>';
  }
  var series = seriesIn.map(function (s) {
    var map = {};
    (s.points || []).forEach(function (pt) { map[String(pt.week_start).slice(0, 10)] = Number(pt.value); });
    return {
      name: s.name, color: s.color,
      values: weeks.map(function (w) { return (w in map) ? map[w] : null; })
    };
  });
  return svgLineChart(series, weeks.map(trendShortDate), seriesIn.length > 1);
}

function trendNiceCeil(v) {
  if (v <= 5) return 5;
  var pow = Math.pow(10, Math.floor(Math.log10(v)));
  var nn = v / pow;
  var step = nn <= 2 ? 2 : (nn <= 5 ? 5 : 10);
  return step * pow;
}

function svgLineChart(series, xLabels, showLegend) {
  var W = 720, H = 240, padL = 46, padR = 16, padT = 14, padB = 34;
  var n = xLabels.length;
  var maxY = 1;
  series.forEach(function (s) { s.values.forEach(function (v) { if (v != null && v > maxY) maxY = v; }); });
  maxY = trendNiceCeil(maxY);
  var plotW = W - padL - padR, plotH = H - padT - padB;
  function xAt(i) { return n <= 1 ? padL + plotW / 2 : padL + (plotW * i / (n - 1)); }
  function yAt(v) { return padT + plotH - (plotH * v / maxY); }
  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="trend-svg" preserveAspectRatio="xMidYMid meet">';
  [0, 0.5, 1].forEach(function (f) {
    var yy = padT + plotH - plotH * f;
    svg += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="rgba(201,168,76,0.15)" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" class="trend-axis">' + Math.round(maxY * f) + '</text>';
  });
  var step = Math.ceil(n / 8) || 1;
  for (var i = 0; i < n; i++) {
    if (i % step !== 0 && i !== n - 1) continue;
    svg += '<text x="' + xAt(i).toFixed(1) + '" y="' + (H - padB + 16) + '" text-anchor="middle" class="trend-axis">' + xLabels[i] + '</text>';
  }
  series.forEach(function (s) {
    var d = '', started = false;
    for (var k = 0; k < n; k++) {
      var v = s.values[k];
      if (v == null) { started = false; continue; }
      d += (started ? ' L ' : 'M ') + xAt(k).toFixed(1) + ' ' + yAt(v).toFixed(1);
      started = true;
    }
    if (d) svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2"/>';
    for (var j = 0; j < n; j++) {
      var vv = s.values[j];
      if (vv == null) continue;
      svg += '<circle cx="' + xAt(j).toFixed(1) + '" cy="' + yAt(vv).toFixed(1) + '" r="3" fill="' + s.color + '"/>';
    }
  });
  svg += '</svg>';
  if (showLegend) {
    svg += '<div class="trend-legend">';
    series.forEach(function (s) {
      svg += '<span class="trend-leg"><span class="trend-swatch" style="background:' + s.color + '"></span>' + s.name + '</span>';
    });
    svg += '</div>';
  }
  return svg;
}

// ============================================================
// PRINT ORDER TAB (Graphic Novel -> Order Printed Copy)
// ============================================================
// Drives the order tab: loads campaign versions + a page estimate, renders
// the binding/color/finish options from the catalog, gives a live quote, and
// places the order. The Print Orders list (status/tracking) is a separate
// page built later; placing an order here just records it.
var printNovelInfo = null;

function escapeHtmlPrint(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showPrintMsg(text, kind) {
  var el = document.getElementById('print-msg');
  if (!el) return;
  if (!text) { el.style.display = 'none'; return; }
  var ok = kind === 'ok';
  el.style.display = 'block';
  el.style.background = ok ? 'rgba(120,180,90,0.12)' : 'rgba(201,120,76,0.12)';
  el.style.border = '1px solid ' + (ok ? 'rgba(120,180,90,0.4)' : 'rgba(201,120,76,0.4)');
  el.style.color = ok ? 'rgba(200,235,180,0.95)' : 'rgba(245,200,180,0.95)';
  el.textContent = text;
}

function loadPrintTab() {
  if (!state.currentCampaign) return;
  showPrintMsg('', null);
  var q = document.getElementById('print-quote');
  if (q) q.textContent = '';
  fetch('/api/print/novel-info/' + state.currentCampaign.id)
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { showPrintMsg(res.j && res.j.error ? res.j.error : 'Could not load order options.', null); return; }
      printNovelInfo = res.j;
      syncPrintVersionDisplay();
      var pe = document.getElementById('print-page-est');
      if (pe) pe.textContent = 'Estimated length: about ' + res.j.pageEstimate + ' pages (final count is set when the print file is generated).';
      refreshPrintOptions(res.j.pageEstimate);
    })
    .catch(function () { showPrintMsg('Could not load order options.', null); });
}

function refreshPrintOptions(pageCount) {
  fetch('/api/print/options?pageCount=' + encodeURIComponent(pageCount))
    .then(function (r) { return r.json(); })
    .then(function (o) {
      var b = document.getElementById('print-binding');
      var c = document.getElementById('print-color');
      var f = document.getElementById('print-finish');
      function fill(el, arr) {
        if (!el) return;
        el.innerHTML = (arr || []).map(function (x) {
          return '<option value="' + x.id + '">' + escapeHtmlPrint(x.label) + '</option>';
        }).join('');
      }
      fill(b, o.bindings);
      fill(c, o.colorTiers);
      fill(f, o.coverFinishes);
      if (o.default) {
        if (b && o.default.binding) b.value = o.default.binding;
        if (c && o.default.colorTier) c.value = o.default.colorTier;
        if (f && o.default.coverFinish) f.value = o.default.coverFinish;
      }
    })
    .catch(function () {});
}

function printSelectionBody() {
  if (!printNovelInfo || !state.currentCampaign) return null;
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  return {
    campaignId: state.currentCampaign.id,
    orderName: val('print-order-name'),
    sourceUserId: state.novelAsUser || null,
    pageCount: printNovelInfo.pageEstimate,
    quantity: parseInt(val('print-qty'), 10) || 1,
    selection: {
      binding: val('print-binding'),
      colorTier: val('print-color'),
      coverFinish: val('print-finish')
    },
    shippingLevel: val('print-ship-level') || 'cheapest',
    shipTo: {
      name: val('print-ship-name'),
      street1: val('print-ship-street1'),
      street2: val('print-ship-street2'),
      city: val('print-ship-city'),
      stateCode: val('print-ship-state'),
      postcode: val('print-ship-postcode'),
      countryCode: (val('print-ship-country') || 'US').toUpperCase(),
      phone: val('print-ship-phone')
    }
  };
}

function quotePrintOrder() {
  var body = printSelectionBody();
  var out = document.getElementById('print-quote');
  if (!body || !body.selection.binding) { if (out) out.textContent = ''; return; }
  if (!body.shipTo.postcode || !body.shipTo.countryCode) {
    if (out) out.textContent = 'Enter a postal code and country to price shipping.';
    return;
  }
  if (out) out.textContent = 'Pricing...';
  fetch('/api/print/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) {
        var msg = res.j && res.j.error ? res.j.error : 'Could not price this order.';
        if (res.j && res.j.details) msg += ' (' + res.j.details.join('; ') + ')';
        if (out) out.textContent = msg;
        return;
      }
      var j = res.j;
      if (out) {
        out.innerHTML = '<strong style="color:var(--gold);">$' + Number(j.customerCharge).toFixed(2) + ' ' + escapeHtmlPrint(j.currency) + '</strong> ' +
          '<span style="color:rgba(245,232,200,0.55);font-size:11px;">(print $' + Number(j.breakdown.print).toFixed(2) + ' + shipping $' + Number(j.breakdown.shipping).toFixed(2) + ')</span>';
      }
    })
    .catch(function () { if (out) out.textContent = 'Could not price this order.'; });
}

// --- Print order: final review + confirm gate ------------------------------
// "Place order" now builds the actual print-ready interior, shows a summary
// plus a link to PREVIEW that exact PDF, and requires an explicit confirm
// before the order is submitted. preparedInteriorUrl holds the generated file.
var preparedInteriorUrl = '';

function printInteriorUrl() {
  // Same params the on-screen novel preview uses, so the printed interior
  // matches what the reader sees (the cover page is omitted server-side).
  return '/api/pdf/print-interior/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel', '&');
}

function reviewPrintOrder() {
  var body = printSelectionBody();
  if (!body || !body.selection.binding) { showPrintMsg('Pick your format first.', null); return; }
  if (!body.shipTo.name || !body.shipTo.street1 || !body.shipTo.city || !body.shipTo.postcode) {
    showPrintMsg('Please complete the shipping address.', null);
    return;
  }
  var btn = document.getElementById('print-place-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing your book...'; }
  showPrintMsg('Building your print-ready book and pricing it. This can take a moment for longer books...', null);
  preparedInteriorUrl = '';

  fetch(printInteriorUrl())
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j || !res.j.url) {
        throw new Error(res.j && res.j.error ? res.j.error : 'Could not build the print file.');
      }
      preparedInteriorUrl = res.j.url;
      return fetch('/api/print/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
    })
    .then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Place order'; }
      if (!res.ok || !res.j) {
        var msg = res.j && res.j.error ? res.j.error : 'Could not price this order.';
        if (res.j && res.j.details) msg += ' (' + res.j.details.join('; ') + ')';
        showPrintMsg(msg, null);
        return;
      }
      showPrintMsg('', null);
      renderPrintReview(body, res.j);
    })
    .catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Place order'; }
      showPrintMsg((e && e.message) ? e.message : 'Could not prepare your order.', null);
    });
}

function renderPrintReview(body, quote) {
  var panel = document.getElementById('print-review');
  var sum = document.getElementById('print-review-summary');
  if (!panel || !sum) return;
  function row(label, value) {
    return '<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;">' +
      '<span style="color:rgba(245,232,200,0.55);">' + escapeHtmlPrint(label) + '</span>' +
      '<span style="color:var(--cream);text-align:right;">' + escapeHtmlPrint(value) + '</span></div>';
  }
  function lbl(id) { var el = document.getElementById(id); return (el && el.options && el.options[el.selectedIndex]) ? el.options[el.selectedIndex].text : ''; }
  var versionTxt = (document.getElementById('print-version-display') || {}).value || (state.novelAsUser ? 'Player version' : 'Canonical');
  var ship = body.shipTo;
  var addr = [ship.name, ship.street1, ship.street2, [ship.city, ship.stateCode, ship.postcode].filter(Boolean).join(' '), ship.countryCode].filter(Boolean).join(', ');
  var html = '';
  html += row('Order name', body.orderName || '(none)');
  html += row('Version', versionTxt);
  html += row('Format', [lbl('print-binding'), lbl('print-color'), lbl('print-finish')].filter(Boolean).join(', '));
  html += row('Quantity', String(body.quantity));
  html += row('Ship to', addr);
  html += row('Shipping', body.shippingLevel);
  html += '<div style="border-top:1px solid rgba(201,168,76,0.25);margin-top:8px;padding-top:8px;"></div>';
  html += row('Total', '$' + Number(quote.customerCharge).toFixed(2) + ' ' + (quote.currency || 'USD'));
  sum.innerHTML = html;
  var prev = document.getElementById('print-review-preview');
  if (prev) prev.href = preparedInteriorUrl;
  var place = document.getElementById('print-place-btn');
  if (place) place.style.display = 'none';
  panel.style.display = 'block';
  if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelPrintReview() {
  var panel = document.getElementById('print-review');
  if (panel) panel.style.display = 'none';
  var place = document.getElementById('print-place-btn');
  if (place) place.style.display = '';
  showPrintMsg('', null);
}

function submitPrintOrder() {
  var body = printSelectionBody();
  if (!body || !body.selection.binding) { showPrintMsg('Pick your format first.', null); return; }
  body.interiorPdfUrl = preparedInteriorUrl || ((document.getElementById('print-interior-url') || {}).value || '');
  body.coverPdfUrl = (document.getElementById('print-cover-url') || {}).value || '';
  if (!body.interiorPdfUrl) {
    showPrintMsg('Your print file was not prepared. Please go Back and try again.', null);
    return;
  }
  if (!body.coverPdfUrl) {
    showPrintMsg('A cover file is required. Covers are generated in the next phase; for sandbox testing, paste a cover PDF URL under "(testing) cover PDF URL".', null);
    return;
  }
  var btn = document.getElementById('print-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Placing...'; }
  fetch('/api/print/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Yes, place my order'; }
      if (!res.ok) { showPrintMsg(res.j && res.j.error ? res.j.error : 'Order failed.', null); return; }
      var panel = document.getElementById('print-review');
      if (panel) panel.style.display = 'none';
      showPrintMsg('Order placed. Reference #' + res.j.orderId + ' (' + (res.j.status || 'submitted') + '). It will appear on your Print Orders page.', 'ok');
    })
    .catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Yes, place my order'; } showPrintMsg('Order failed.', null); });
}

// ---- Novel session include + navigation (Sessions tab) ----
function novelIncluded(s) {
  return !(s && (s.novel_include === false || s.novel_include === 0 || s.novel_include === 'f' || s.novel_include === 'false'));
}

function toggleNovelInclude(sessionId, checked) {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + sessionId + '/novel-include', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ include: !!checked })
  }).then(function () { loadNovelSummary(); })
    .catch(function () { loadNovelSummary(); });
}

function goToSessionPage(id) {
  if (typeof showCampaignSection === 'function') showCampaignSection('sessions');
  if (typeof selectSession === 'function') selectSession(id);
}

// ---- Admin: Print markup percentage (dashboard Settings tab) ----
function loadPrintMarkup() {
  var inp = document.getElementById('print-markup-input');
  if (!inp) return;
  fetch('/api/admin/print-settings')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.printMarkupPct != null) inp.value = j.printMarkupPct; })
    .catch(function () {});
}

function savePrintMarkup() {
  var inp = document.getElementById('print-markup-input');
  var msg = document.getElementById('print-markup-msg');
  if (!inp) return;
  var pct = parseFloat(inp.value);
  if (!isFinite(pct) || pct < 0) { if (msg) msg.textContent = 'Enter a percentage of 0 or more.'; return; }
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/print-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ printMarkupPct: pct })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (msg) msg.textContent = res.ok ? 'Saved.' : (res.j && res.j.error ? res.j.error : 'Could not save.');
      if (res.ok && res.j && res.j.printMarkupPct != null) inp.value = res.j.printMarkupPct;
    })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

function syncPrintVersionDisplay() {
  var disp = document.getElementById('print-version-display');
  if (!disp) return;
  var top = document.getElementById('novel-version-select');
  var label = 'Canonical (Story Master)';
  if (top && top.options && top.selectedIndex >= 0 && top.options[top.selectedIndex]) {
    label = top.options[top.selectedIndex].text || label;
  }
  disp.value = label;
}
