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
// PHASE A - in-app history so the device/browser Back button walks backward
// through views (and shows a soft 'leave app' guard at the campaigns root)
// instead of dropping out of app.html to the login page. (TF-12)
// ============================================================
var _navSilent = false;

function _navRecord(view) {
  if (_navSilent) return;
  if (view === 'session-detail' && !(state.currentSession && state.currentSession.id)) return;
  var token = {
    view: view,
    campaignId: (state.currentCampaign && state.currentCampaign.id) || null,
    sessionId: (view === 'session-detail' && state.currentSession) ? state.currentSession.id : null
  };
  var cur = history.state && history.state.nav;
  if (cur && cur.view === token.view && cur.campaignId === token.campaignId && cur.sessionId === token.sessionId) {
    try { history.replaceState({ nav: token }, ''); } catch (e) {}
    return;
  }
  try { history.pushState({ nav: token }, ''); } catch (e) {}
}

function _navRestore(st) {
  var v = st.view;
  if (v === 'campaigns') { showView('campaigns'); return; }
  if (v === 'account' || v === 'orders' || v === 'settings') { showView(v); return; }
  if (st.campaignId && (!state.currentCampaign || state.currentCampaign.id !== st.campaignId)) {
    var c = (state.campaigns || []).find(function (x) { return x.id === st.campaignId; });
    if (c) { state.currentCampaign = c; if (typeof setCampaignElements === 'function') setCampaignElements(); }
  }
  if (!state.currentCampaign) { showView('campaigns'); return; }
  if (v === 'session-detail') {
    if (st.sessionId && (!state.currentSession || state.currentSession.id !== st.sessionId)) {
      selectSession(st.sessionId);
      return;
    }
    if (state.currentSession && state.currentSession.id) {
      var ids = ['campaigns','sessions','characters','assets','novel','members','archives','orders','account','settings'];
      ids.forEach(function (x) { var el = document.getElementById('view-' + x); if (el) el.style.display = 'none'; });
      var d = document.getElementById('view-session-detail'); if (d) d.style.display = 'block';
      state.currentView = 'session-detail';
      return;
    }
    showCampaignSection('sessions');
    return;
  }
  if (['sessions','characters','assets','novel','members','archives'].indexOf(v) !== -1) {
    showCampaignSection(v);
    return;
  }
  showView('campaigns');
}

// PHASE C - the manifest start_url is the public landing ('/'), so that page
// is the app's home in both a browser tab and the installed PWA. The leave
// action steps down to it (history.back) rather than pushing a new entry.
function _navIsStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
}

function _navLeave() {
  if (window.history.length > 1) { window.history.back(); }
  else { window.location.href = '/'; }
}

function _navLeaveGuard() {
  var msg = _navIsStandalone() ? 'Return to the Campaignia home screen?' : 'Leave Campaignia?';
  if (window.confirm(msg)) { _navLeave(); return; }
  // Declined: stay in the app and re-seat the root.
  try { history.pushState({ nav: { view: 'campaigns', root: true } }, ''); } catch (e) {}
  _navSilent = true;
  try { showView('campaigns'); } catch (e) {}
  _navSilent = false;
}

// ------------------------------------------------------------
// PHASE B - Back closes an open modal/overlay before changing views.
// All modals are .modal-overlay toggled via the 'hidden' class; the image
// lightbox is a dynamically-added #lightbox element with its own closer.
// ------------------------------------------------------------
function _navZ(el) {
  var z = parseInt(window.getComputedStyle(el).zIndex, 10);
  return isNaN(z) ? 0 : z;
}

function _navAnyModalOpen() {
  if (document.getElementById('lightbox')) return true;
  var ovs = document.querySelectorAll('.modal-overlay');
  for (var i = 0; i < ovs.length; i++) {
    if (ovs[i].classList.contains('hidden')) continue;
    var cs = window.getComputedStyle(ovs[i]);
    if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
  }
  return false;
}

function _navCloseTopModal() {
  // The lightbox is appended to <body> last, so it sits on top when present.
  var lb = document.getElementById('lightbox');
  if (lb) { if (typeof closeLightbox === 'function') closeLightbox(); else lb.remove(); return true; }
  var opens = [];
  var ovs = document.querySelectorAll('.modal-overlay');
  for (var i = 0; i < ovs.length; i++) {
    var el = ovs[i];
    if (el.classList.contains('hidden')) continue;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    opens.push(el);
  }
  if (!opens.length) return false;
  var top = opens[0], topZ = _navZ(opens[0]);
  for (var j = 1; j < opens.length; j++) {
    var z = _navZ(opens[j]);
    if (z >= topZ) { top = opens[j]; topZ = z; }
  }
  top.classList.add('hidden');
  return true;
}

function _navCurrentToken() {
  var v = state.currentView || (typeof _visibleViewId === 'function' ? _visibleViewId() : null) || 'campaigns';
  return {
    view: v,
    campaignId: (state.currentCampaign && state.currentCampaign.id) || null,
    sessionId: (v === 'session-detail' && state.currentSession) ? state.currentSession.id : null
  };
}

window.addEventListener('popstate', function (e) {
  // Phase B: a Back press with a modal open closes the modal and stays put.
  if (_navAnyModalOpen()) {
    _navCloseTopModal();
    try { history.pushState({ nav: _navCurrentToken() }, ''); } catch (e2) {}
    return;
  }
  var st = e.state && e.state.nav;
  if (!st || st.view === '__leave__') { _navLeaveGuard(); return; }
  _navSilent = true;
  try { _navRestore(st); } catch (err) {}
  _navSilent = false;
});

// Seat the baseline once: a '__leave__' sentinel sits below the campaigns root
// so the first Back from the root triggers the soft leave guard rather than
// silently leaving app.html for the login page.
(function () {
  try {
    if (!(history.state && history.state.nav)) {
      history.replaceState({ nav: { view: '__leave__' } }, '');
      history.pushState({ nav: { view: 'campaigns', root: true } }, '');
    }
  } catch (e) {}
})();

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
        if (data.reserveLow) {
          el.title = data.reserve + ' tokens are reserved so you can still create a session.';
          if (!window.__reserveWarned && typeof billingToast === 'function') {
            window.__reserveWarned = true;
            billingToast('Heads up - you are getting low. ' + data.reserve + ' tokens are reserved so you can still create a session. Save them to finish your story.', 'info');
          }
        } else if (el.title) { el.title = ''; }
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
  { id:'huge',   name:'Huge',   price:250, tokens:1700, tagline:'Best value' }
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
      // TF-03: may this user buy token packs? (subscribers, or Copper under a
      // paid SM). Absent field => older server => default permissive; the
      // backend /checkout gate is authoritative regardless.
      state.canPurchaseTokens = (data && data.can_purchase_tokens !== undefined) ? !!data.can_purchase_tokens : true;
      renderTokenPacks();
    })
    .catch(function() { renderTokenPacks(); });
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

// Close the Buy Tokens modal and jump to the Plans section of the Account
// page -- the single source of truth for choosing/subscribing to a plan.
// Shared upsell CTA from the token gate; TF-14 "See Plans" will reuse this.
function goToPlans() {
  closeTokensModal();
  if (typeof showView === 'function') showView('account');
  // The account view fills several panels in asynchronously, so a single fixed
  // delay can scroll before the layout settles and land a little short. Re-scroll
  // a few times over ~1s so the final position lands on the 'Upgrade Your Plan'
  // panel once everything above it has loaded. First pass is smooth; the later
  // passes snap silently only if the layout shifted.
  var tries = 0;
  function settleScrollToPlans() {
    var sec = document.getElementById('account-upgrade-section');
    if (sec && sec.scrollIntoView) {
      sec.scrollIntoView({ behavior: (tries === 0 ? 'smooth' : 'auto'), block: 'start' });
    }
    if (++tries < 5) setTimeout(settleScrollToPlans, 220);
  }
  setTimeout(settleScrollToPlans, 120);
}

// TF-05 (C): welcome-back modal, shown once when a login reactivated a suspended
// account (login redirected here with ?reactivated=1). Tier-aware: the re-subscribe
// nudge appears only for users who previously paid (now copper + had billing).
function maybeStartCheckout() {
  try {
    var q = new URLSearchParams(window.location.search);
    var plan = (q.get('start_checkout') || '').toLowerCase();
    if (plan !== 'silver' && plan !== 'gold' && plan !== 'platinum') return;
    try { history.replaceState(history.state, '', window.location.pathname); } catch (e) {}
    subscribeTier(plan);
  } catch (e) {}
}
function maybeShowReactivatedWelcome(data) {
  try {
    var q = new URLSearchParams(window.location.search);
    if (!q.has('reactivated')) return;
    try { history.replaceState(history.state, '', window.location.pathname); } catch (e) {}
    var m = document.getElementById('reactivated-modal');
    if (!m) return;
    var wasPaid = !!(data && data.tier === 'copper' && data.hasBilling);
    var up = document.getElementById('reactivated-upsell');
    var pb = document.getElementById('reactivated-plans-btn');
    if (up) up.style.display = wasPaid ? 'block' : 'none';
    if (pb) pb.style.display = wasPaid ? 'inline-block' : 'none';
    m.classList.remove('hidden');
  } catch (e) {}
}
function closeReactivatedModal() {
  var m = document.getElementById('reactivated-modal');
  if (m) m.classList.add('hidden');
}

function renderTokenPacks() {
  var wrap = document.getElementById('token-packs');
  if (!wrap) return;
  var canBuy = (state.canPurchaseTokens !== false);   // TF-03: only false hard-blocks; undefined stays permissive
  var _baseRate = (TOKEN_PACKS[0] && TOKEN_PACKS[0].price) ? (TOKEN_PACKS[0].tokens / TOKEN_PACKS[0].price) : 0;
  var html = TOKEN_PACKS.map(function(p) {
    var _rate = p.price ? (p.tokens / p.price) : 0;
    var _bonusPct = _baseRate ? Math.round((_rate / _baseRate - 1) * 100) : 0;
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
        '<div style="font-size:16px;color:var(--gold-light);"><strong>' + p.tokens.toLocaleString() + '</strong> tokens</div>' +
        (_bonusPct > 0 ? '<div style="font-size:11px;font-weight:700;color:#7ec98f;margin-bottom:6px;">+' + _bonusPct + '% more tokens per $</div>' : '') +
        (p.highlight ? '' : '<div style="font-size:11px;color:rgba(201,168,76,0.6);font-style:italic;">' + p.tagline + '</div>') +
        (canBuy
          ? '<button class="btn btn-primary btn-sm" onclick="buyTokenPack(\'' + p.id + '\')" style="margin-top:auto;">Buy ' + p.name + '</button>'
          : '<button class="btn btn-sm" disabled style="margin-top:auto;opacity:0.5;cursor:not-allowed;">Buy ' + p.name + '</button>') +
      '</div>';
  }).join('');
  wrap.innerHTML = html;
  if (!canBuy) {
    var _pmsg = document.getElementById('token-purchase-msg');
    if (_pmsg) {
      _pmsg.innerHTML = 'Buying token packs requires a paid plan &mdash; either your own, or being part of a campaign run by someone on a paid plan. Upgrade to Silver, Gold, or Platinum to purchase tokens.<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="goToPlans()">See plans</button></div>';
      _pmsg.style.display = 'block';
    }
  }
}

function buyTokenPack(packId) {
  // Start a Stripe Checkout. Until billing is configured (pre-LLC) the server
  // returns 503 and we show the friendly "coming soon" message instead.
  var msg = document.getElementById('token-purchase-msg');
  var pack = TOKEN_PACKS.filter(function(p){return p.id===packId;})[0];
  var label = pack ? pack.name + ' pack ($' + pack.price + ')' : 'this pack';
  function showUpgrade() {
    if (!msg) return;
    msg.innerHTML = 'Buying token packs requires a paid plan &mdash; either your own, or being part of a campaign run by someone on a paid plan. Upgrade to Silver, Gold, or Platinum to purchase tokens.<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="goToPlans()">See plans</button></div>';
    msg.style.display = 'block';
    msg.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  // TF-03: blocked tiers never reach checkout.
  if (state.canPurchaseTokens === false) { showUpgrade(); return; }
  function showComingSoon() {
    if (!msg) return;
    msg.innerHTML = '&#9881; Purchasing is being set up. ' + label + ' will be available very soon. ' +
      'In the meantime, contact your admin to add tokens to your account.';
    msg.style.display = 'block';
    msg.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  function showError(text) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
  fetch('/api/tokens/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId: packId })
  }).then(function(r) {
    if (r.status === 503) { showComingSoon(); return null; }
    if (r.status === 403) { showUpgrade(); return null; }
    return r.json();
  }).then(function(data) {
    if (!data) return;
    if (data.url) { window.location = data.url; return; }
    showError((data && data.error) ? data.error : "We couldn't start your token purchase -- this looks like a billing setup issue on our end, not a problem with your card. Please try again shortly, and if it keeps happening, contact support.");
  }).catch(function() {
    showError('Could not reach the billing service. Please try again.');
  });
}

// ============================================================
// SUBSCRIPTIONS + BILLING (Stripe-hosted: Checkout + Billing Portal)
// ============================================================
// All plan management is Stripe-hosted. subscribeTier starts a recurring
// Checkout; openBillingPortal opens the white-labeled portal where the user
// upgrades / downgrades / cancels / updates their card. The server is the
// source of truth (tier follows the customer.subscription.* webhooks); the
// client just kicks off the hosted flows and reflects the result on return.

function hasLiveSubscription(me) {
  if (!me || !me.hasSubscription) return false;
  var st = me.subscriptionStatus || '';
  return st === 'active' || st === 'trialing' || st === 'past_due' || st === 'unpaid' || st === 'paused';
}

function subscribeTier(tier) {
  var msg = document.getElementById('account-billing-msg');
  function show(t) { if (msg) { msg.textContent = t; msg.style.display = 'block'; } }
  fetch('/api/tokens/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: tier })
  }).then(function(r) {
    if (r.status === 503) {
      return r.json().then(function(j) {
        show((j && j.error === 'tier_price_unconfigured')
          ? 'Subscriptions are being set up and will be available shortly.'
          : 'Billing is being set up and will be available shortly.');
        return null;
      });
    }
    return r.json();
  }).then(function(data) {
    if (!data) return;
    if (data.url) { window.location = data.url; return; }
    show((data && data.error) ? data.error : "We couldn't start your subscription -- this looks like a billing setup issue on our end, not a problem with your card. Please try again shortly, and if it keeps happening, contact support.");
  }).catch(function() {
    show('Could not reach the billing service. Please try again.');
  });
}

// TF-15: switch an EXISTING subscription to another paid tier in place. The server
// updates the Stripe subscription (proration on next invoice); the webhook reconciles
// the tier, so we refresh the account shortly after.
function changePlan(tier) {
  var msg = document.getElementById('account-billing-msg');
  function show(t) { if (msg) { msg.textContent = t; msg.style.display = 'block'; } }
  show('Updating your plan...');
  fetch('/api/tokens/change-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: tier })
  }).then(function(r) {
    if (r.status === 503) {
      return r.json().then(function(j) {
        show((j && j.error === 'tier_price_unconfigured')
          ? 'Subscriptions are being set up and will be available shortly.'
          : 'Billing is being set up and will be available shortly.');
        return null;
      });
    }
    return r.json();
  }).then(function(data) {
    if (!data) return;
    if (data.url) { window.location = data.url; return; }   // stale/canceled sub -> fresh checkout
    if (data.success) {
      show('Your plan is updating -- this can take a few seconds to reflect.');
      setTimeout(function() { if (typeof loadAccount === 'function') loadAccount(); else if (typeof checkAuth === 'function') checkAuth(); }, 2500);
      return;
    }
    show((data.error === 'no_subscription')
      ? 'You do not have an active subscription to change. Use Subscribe instead.'
      : ('Could not change your plan. ' + (data.detail ? ('[' + data.detail + ']') : 'Please try again.')));
  }).catch(function() {
    show('Could not reach the billing service. Please try again.');
  });
}

function openBillingPortal() {
  var msg = document.getElementById('account-billing-msg');
  function show(t) { if (msg) { msg.textContent = t; msg.style.display = 'block'; } }
  fetch('/api/tokens/portal', { method: 'POST' }).then(function(r) {
    if (r.status === 503) { show('Billing is being set up and will be available shortly.'); return null; }
    if (r.status === 400) { show('No billing account yet - subscribe to a plan first.'); return null; }
    return r.json();
  }).then(function(data) {
    if (!data) return;
    if (data.url) { window.location = data.url; return; }
    show('Could not open the billing portal. Please try again.');
  }).catch(function() {
    show('Could not reach the billing service. Please try again.');
  });
}

// The browser native alert() prints the site URL in its header ("<site> says").
// Route it through our own in-app toast instead -- same fire-and-forget usage,
// no URL. confirm() dialogs use the custom uiConfirm() modal below.
if (typeof window !== "undefined" && !window.__alertPatched) {
  window.__alertPatched = true;
  window.alert = function (m) {
    var msg = String(m == null ? "" : m);
    try { if (typeof billingToast === "function") billingToast(msg, "info"); else if (typeof showAlert === "function") showAlert(msg); } catch (e) {}
  };
}

// In-app confirm dialog (matches our popups; no browser URL header). Returns a
// Promise<boolean>. Enter = OK, Escape / click-outside = Cancel.
function uiConfirm(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(8,5,2,0.66);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#16100a;border:1px solid rgba(201,168,76,0.35);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,0.5);max-width:440px;width:100%;padding:22px 22px 18px;';
    var msg = document.createElement('div');
    msg.textContent = (message == null) ? '' : String(message);
    msg.style.cssText = 'color:#f0e8d0;font-size:15px;line-height:1.5;margin-bottom:18px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
    var cancel = document.createElement('button'); cancel.className = 'btn btn-sm'; cancel.textContent = opts.cancelText || 'Cancel';
    var ok = document.createElement('button'); ok.className = 'btn btn-primary btn-sm'; ok.textContent = opts.okText || 'OK';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(msg); box.appendChild(row); overlay.appendChild(box);
    document.body.appendChild(overlay);
    function done(val) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); }
    cancel.onclick = function () { done(false); };
    ok.onclick = function () { done(true); };
    overlay.onclick = function (e) { if (e.target === overlay) done(false); };
    document.addEventListener('keydown', onKey);
    setTimeout(function () { try { ok.focus(); } catch (e) {} }, 0);
  });
}

function uiPublishPrompt(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(8,5,2,0.66);display:flex;align-items:center;justify-content:center;padding:20px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#16100a;border:1px solid rgba(201,168,76,0.35);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,0.5);max-width:460px;width:100%;padding:22px 22px 18px;';
    var msg = document.createElement('div');
    msg.textContent = (message == null) ? '' : String(message);
    msg.style.cssText = 'color:#f0e8d0;font-size:15px;line-height:1.5;margin-bottom:14px;';
    var tlabel = document.createElement('div');
    tlabel.textContent = 'Title for this story';
    tlabel.style.cssText = 'color:rgba(201,168,76,0.9);font-size:12px;margin-bottom:6px;';
    var ti = document.createElement('input');
    ti.type = 'text'; ti.maxLength = 200; ti.value = opts.defaultTitle || '';
    ti.placeholder = 'e.g. The Shattered Crown';
    ti.style.cssText = 'width:100%;background:rgba(20,12,4,0.85);color:var(--gold);border:1px solid rgba(201,168,76,0.3);border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;box-sizing:border-box;margin-bottom:14px;';
    var label = document.createElement('div');
    label.textContent = 'Add a short blurb for your Library page (optional)';
    label.style.cssText = 'color:rgba(201,168,76,0.9);font-size:12px;margin-bottom:6px;';
    var ta = document.createElement('textarea');
    ta.maxLength = 600;
    ta.placeholder = 'Leave blank to use your opening narrative as the teaser.';
    ta.style.cssText = 'width:100%;min-height:64px;background:rgba(20,12,4,0.85);color:var(--gold);border:1px solid rgba(201,168,76,0.3);border-radius:8px;padding:8px 10px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box;margin-bottom:8px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
    var cancel = document.createElement('button'); cancel.className = 'btn btn-sm'; cancel.textContent = opts.cancelText || 'Cancel';
    var ok = document.createElement('button'); ok.className = 'btn btn-primary btn-sm'; ok.textContent = opts.okText || 'Publish';
    row.appendChild(cancel); row.appendChild(ok);
    var hint = document.createElement('div');
    hint.textContent = 'You can manage your published content on your Account page.';
    hint.style.cssText = 'color:rgba(240,232,208,0.5);font-size:11px;margin:0 0 16px;';
    var attestWrap = document.createElement('label');
    attestWrap.style.cssText = 'display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#cbb994;line-height:1.4;margin:0 0 14px;cursor:pointer;';
    var attestBox = document.createElement('input');
    attestBox.type = 'checkbox';
    attestBox.style.cssText = 'margin-top:2px;flex-shrink:0;';
    var attestText = document.createElement('span');
    attestText.textContent = 'I own or have the rights to this content, and it is suitable for a general audience (stylized fantasy violence is fine; no sexual, hateful, or graphically gratuitous content).';
    attestWrap.appendChild(attestBox); attestWrap.appendChild(attestText);
    ok.disabled = true;
    attestBox.addEventListener('change', function () { ok.disabled = !attestBox.checked; });
    box.appendChild(msg); box.appendChild(tlabel); box.appendChild(ti); box.appendChild(label); box.appendChild(ta); box.appendChild(hint); box.appendChild(attestWrap); box.appendChild(row); overlay.appendChild(box);
    document.body.appendChild(overlay);
    function done(val) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    }
    function onKey(e) { if (e.key === 'Escape') done(null); }
    cancel.onclick = function () { done(null); };
    ok.onclick = function () { if (!attestBox.checked) return; done({ title: String(ti.value || '').trim(), blurb: String(ta.value || '').trim(), attested: true }); };
    overlay.onclick = function (e) { if (e.target === overlay) done(null); };
    document.addEventListener('keydown', onKey);
    setTimeout(function () { try { ti.focus(); } catch (e) {} }, 0);
  });
}

function billingToast(text, kind) {
  var bg = (kind === 'error') ? 'rgba(120,40,30,0.96)'
    : (kind === 'info') ? 'rgba(45,45,55,0.96)' : 'rgba(40,90,52,0.96)';
  var el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;' +
    'background:' + bg + ';color:#fff;padding:12px 20px;border-radius:8px;font-size:14px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.35);max-width:90vw;text-align:center;';
  document.body.appendChild(el);
  setTimeout(function() { el.style.transition = 'opacity 0.4s'; el.style.opacity = '0'; }, 4200);
  setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 4800);
}

function handleBillingReturn() {
  var params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
  var purchase = params.get('purchase');
  var subscribe = params.get('subscribe');
  var portal = params.get('portal');
  var order = params.get('order');
  if (!purchase && !subscribe && !portal && !order) return;
  function refreshAccount() {
    if (typeof checkAuth === 'function') checkAuth();
    if (document.getElementById('account-plans')) loadAccount();
  }
  if (purchase === 'success') {
    billingToast('Payment complete - your tokens have been added.', 'success');
    setTimeout(function() { if (typeof refreshTokenBalance === 'function') refreshTokenBalance(); }, 1200);
  } else if (purchase === 'cancel') {
    billingToast('Checkout canceled - no charge was made.', 'info');
  } else if (subscribe === 'success') {
    billingToast('Subscription active - welcome aboard!', 'success');
    setTimeout(refreshAccount, 1500);
    setTimeout(refreshAccount, 4500);
  } else if (subscribe === 'cancel') {
    billingToast('Subscription checkout canceled - no charge was made.', 'info');
  } else if (portal === 'return') {
    billingToast('Billing updated.', 'success');
    // loadAccount() reconciles from Stripe when it opens, so refreshing is enough;
    // the second pass is a backstop in case the portal write lands a moment late.
    setTimeout(refreshAccount, 600);
    setTimeout(refreshAccount, 2500);
  } else if (order === 'success') {
    billingToast('Payment received - your book is being sent to the printer.', 'success');
    setTimeout(function () { if (typeof loadOrders === 'function') loadOrders(); }, 1000);
  } else if (order === 'cancel') {
    billingToast('Order canceled - no charge was made.', 'info');
  }
  try { window.history.replaceState(window.history.state || {}, '', window.location.pathname); } catch (e) {}
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
        if (typeof refreshUsageTokens === 'function') refreshUsageTokens();
      } else {
        show((data && data.error) || 'Could not add tokens.', false);
      }
    })
    .catch(function() { show('Network error.', false); });
}

// ----- TESTING: set EXACT cot/utlt balances (+ optional current-tier reserve).
// Wipes the ledger first. Remove with the other testing controls at launch. -----
function devSetBalance() {
  var msg = document.getElementById('dev-add-tokens-msg');
  function show(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.background = ok ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.12)';
    msg.style.color = ok ? '#3c9142' : '#c0392b';
  }
  var cotEl = document.getElementById('dev-set-cot');
  var utltEl = document.getElementById('dev-set-utlt');
  var resEl = document.getElementById('dev-set-reserve');
  var cot = cotEl ? parseInt(cotEl.value, 10) : NaN;
  var utlt = utltEl ? parseInt(utltEl.value, 10) : NaN;
  if (!Number.isFinite(cot) || cot < 0 || !Number.isFinite(utlt) || utlt < 0) { show('Enter non-negative CO and UTOLT amounts.', false); return; }
  var bodyObj = { cot: cot, utlt: utlt };
  if (resEl && resEl.value !== '') bodyObj.reserve = parseInt(resEl.value, 10);
  fetch('/api/tokens/dev-set-balance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok) {
        var extra = data.reserve ? (' Reserve set to ' + data.reserve.session_reserve + ' on ' + data.reserve.tier + '.') : '';
        show('Set CO ' + cot + ' + UTOLT ' + utlt + '. Balance: ' + (data.balance && data.balance.total) + '.' + extra, true);
        if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        if (typeof refreshUsageTokens === 'function') refreshUsageTokens();
      } else {
        show((data && data.error) || 'Could not set balance.', false);
      }
    })
    .catch(function() { show('Network error.', false); });
}

// ----- TESTING: manually grant this user's current-tier monthly allotment.
// The monthly grant no longer fires automatically on page load; this is the
// manual trigger. Remove with the other testing controls at launch. -----
function devGrantMonthly() {
  var msg = document.getElementById('dev-add-tokens-msg');
  function show(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.background = ok ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.12)';
    msg.style.color = ok ? '#3c9142' : '#c0392b';
  }
  fetch('/api/tokens/dev-grant-monthly', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.ok) {
        show('Reset to ' + data.granted.utlt + ' UTOLT + ' + data.granted.cot + ' CO (' + data.tier + ' tier, fresh account). Balance: ' + (data.balance && data.balance.total) + '.', true);
        if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
        if (typeof refreshUsageTokens === 'function') refreshUsageTokens();
      } else {
        show((data && data.error) || 'Could not grant monthly tokens.', false);
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
        if (state.user) state.user.tier = data.tier;
        var tb = document.getElementById('trial-badge');
        if (tb) tb.style.display = (data.tier === 'trial') ? 'inline-flex' : 'none';
        var tbd = document.getElementById('trial-badge-days');
        if (tbd && data.tier === 'trial' && data.trial_started_at) {
          var msLeft = (new Date(data.trial_started_at).getTime() + 30 * 24 * 60 * 60 * 1000) - Date.now();
          tbd.textContent = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000))) + 'd left';
        }
        show(data.inTrial ? ('Account is now ON the Free Trial tier (' + data.tier + ') -- badge + caps active, and it persists across logins.') : ('Out of free trial. Tier is now ' + data.tier + '.'), true);
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
  handleBillingReturn();
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
      maybeShowReactivatedWelcome(data);   // TF-05 (C): greet a just-reactivated account
      maybeStartCheckout();   // post-verification: auto-start a chosen paid plan's checkout
      // Free Trial badge in the top bar -- driven by the ACTUAL tier (tier === 'trial'),
      // i.e. the state where the trial caps apply. If this badge is hidden, the trial
      // caps are NOT in effect for this account regardless of any watermark/trial window.
      var trialBadge = document.getElementById('trial-badge');
      if (trialBadge) {
        if (data.tier === 'trial') {
          var tbDays = document.getElementById('trial-badge-days');
          if (tbDays) tbDays.textContent = (typeof data.trialDaysLeft === 'number') ? (data.trialDaysLeft + 'd left') : '';
          trialBadge.style.display = 'inline-flex';
        } else {
          trialBadge.style.display = 'none';
        }
      }
      // Lone-copper pill: copper account with no paid Story Master coverage.
      var loneBadge = document.getElementById('lone-badge');
      if (loneBadge) loneBadge.style.display = data.loneCopper ? 'inline-flex' : 'none';
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';
      var libModBox = document.getElementById('admin-library-section');
      if (libModBox) libModBox.style.display = data.is_admin ? 'block' : 'none';
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
  _helpSendTranscriptOnLogout(function() {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function() { window.location.href = '/'; });
  });
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

function loadMyStories() {
  var list = document.getElementById('my-stories-list');
  var empty = document.getElementById('my-stories-empty');
  if (!list) return;
  list.innerHTML = '';
  if (empty) empty.style.display = 'none';
  fetch('/api/pdf/my-stories')
    .then(function(r){ return r.json(); })
    .then(function(d){
      var items = (d && d.items) || [];
      if (!items.length) { if (empty) empty.style.display = 'block'; return; }
      items.forEach(function(it){ list.appendChild(myStoryCard(it)); });
    })
    .catch(function(){ if (empty) { empty.style.display = 'block'; empty.textContent = 'Could not load your published stories right now.'; } });
}

function myStoryCard(it) {
  var card = document.createElement('div');
  card.style.cssText = 'border:1px solid rgba(201,168,76,0.2);border-radius:8px;overflow:hidden;background:rgba(12,8,4,0.4);display:flex;flex-direction:column;';
  var a = document.createElement('a');
  a.href = '/library/story/' + it.id + '/' + (it.slug || 'story'); a.target = '_blank'; a.rel = 'noopener'; a.title = 'Open your published story page';
  a.style.cssText = 'display:block;text-decoration:none;';
  if (it.cover_url) {
    var img = document.createElement('img');
    img.setAttribute('loading', 'lazy'); img.src = it.cover_url; img.alt = it.title || 'story';
    img.style.cssText = 'width:100%;aspect-ratio:17/22;object-fit:cover;display:block;background:#160e06;';
    a.appendChild(img);
  } else {
    var ph = document.createElement('div'); ph.textContent = it.title || 'Untitled';
    ph.style.cssText = 'width:100%;aspect-ratio:17/22;display:flex;align-items:center;justify-content:center;background:#160e06;color:rgba(201,168,76,0.45);font-size:12px;text-align:center;padding:8px;';
    a.appendChild(ph);
  }
  card.appendChild(a);
  var meta = document.createElement('div');
  meta.style.cssText = 'font-size:12px;color:rgba(240,232,208,0.85);padding:6px 8px;line-height:1.35;';
  meta.textContent = it.title || 'Untitled';
  card.appendChild(meta);
  var dateLine = document.createElement('div');
  var _dt = it.created_at ? new Date(it.created_at) : null;
  dateLine.textContent = _dt ? ('Published ' + _dt.toLocaleDateString()) : '';
  dateLine.style.cssText = 'font-size:10px;color:rgba(201,168,76,0.5);padding:0 8px 4px;';
  card.appendChild(dateLine);
  var blWrap = document.createElement('div');
  blWrap.style.cssText = 'padding:0 8px 8px;';
  var blView = document.createElement('div');
  blView.style.cssText = 'font-size:11px;color:rgba(240,232,208,0.6);line-height:1.4;margin-bottom:6px;white-space:pre-wrap;';
  var renderBlurbView = function(){ blView.textContent = (it.blurb && String(it.blurb).trim()) ? it.blurb : 'No blurb yet.'; };
  var editBtn = document.createElement('button'); editBtn.className = 'btn btn-sm'; editBtn.textContent = 'Edit';
  editBtn.style.cssText = 'font-size:11px;padding:3px 8px;';
  var showView = function(){ blWrap.innerHTML = ''; renderBlurbView(); blWrap.appendChild(blView); blWrap.appendChild(editBtn); };
  editBtn.onclick = function(){
    var ti = document.createElement('input'); ti.type = 'text'; ti.value = it.title || ''; ti.maxLength = 200; ti.placeholder = 'Title';
    ti.style.cssText = 'width:100%;background:rgba(20,12,4,0.85);color:var(--gold);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;box-sizing:border-box;margin-bottom:6px;';
    var ta = document.createElement('textarea'); ta.value = it.blurb || ''; ta.maxLength = 600; ta.placeholder = 'Blurb (optional)';
    ta.style.cssText = 'width:100%;min-height:54px;background:rgba(20,12,4,0.85);color:var(--gold);border:1px solid rgba(201,168,76,0.3);border-radius:6px;padding:6px 8px;font-size:11px;font-family:inherit;resize:vertical;box-sizing:border-box;margin-bottom:6px;';
    var save = document.createElement('button'); save.className = 'btn btn-primary btn-sm'; save.textContent = 'Save'; save.style.cssText = 'font-size:11px;padding:3px 10px;margin-right:6px;';
    var cancel = document.createElement('button'); cancel.className = 'btn btn-sm'; cancel.textContent = 'Cancel'; cancel.style.cssText = 'font-size:11px;padding:3px 10px;';
    blWrap.innerHTML = ''; blWrap.appendChild(ti); blWrap.appendChild(ta);
    var brow = document.createElement('div'); brow.appendChild(save); brow.appendChild(cancel); blWrap.appendChild(brow);
    try { ti.focus(); } catch(e){}
    cancel.onclick = function(){ showView(); };
    save.onclick = function(){
      save.disabled = true; save.textContent = 'Saving...';
      fetch('/api/pdf/story/' + it.id + '/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: ti.value, blurb: ta.value }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && d.success) { it.title = d.title || it.title; it.blurb = d.blurb || ''; meta.textContent = it.title || 'Untitled'; showView(); } else { save.disabled = false; save.textContent = 'Save'; billingToast((d && d.error) || 'Could not save.', 'error'); } })
        .catch(function(){ save.disabled = false; save.textContent = 'Save'; billingToast('Could not save.', 'error'); });
    };
  };
  showView();
  card.appendChild(blWrap);
  var btn = document.createElement('button'); btn.className = 'btn btn-sm lib-remove-btn';
  btn.textContent = 'Remove from Library'; btn.style.cssText = 'margin:0 8px 8px;';
  var armed = false; var tmr = null;
  btn.onclick = function(){
    if (!armed) { armed = true; btn.textContent = 'Click again to remove'; tmr = setTimeout(function(){ armed = false; btn.textContent = 'Remove from Library'; }, 3000); return; }
    if (tmr) clearTimeout(tmr);
    removeMyStory(it.id, card, btn);
  };
  card.appendChild(btn);
  return card;
}

function removeMyStory(storyId, card, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  fetch('/api/pdf/story/' + storyId + '/unpublish', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) {
        if (card && card.parentNode) card.parentNode.removeChild(card);
        var list = document.getElementById('my-stories-list'); var empty = document.getElementById('my-stories-empty');
        if (list && !list.children.length && empty) empty.style.display = 'block';
      } else {
        if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; }
        billingToast((d && d.error) || 'Could not remove.', 'error');
      }
    })
    .catch(function(){ if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; } billingToast('Could not remove.', 'error'); });
}
function loadAccount() {
  if (typeof loadMyStories === 'function') loadMyStories();
  // Profile fields moved here from Settings — populate name/email from state.
  var _pn = document.getElementById('settings-name');
  if (_pn) _pn.value = (state.user && state.user.name) || '';
  var _pe = document.getElementById('settings-email');
  if (_pe) _pe.value = (state.user && state.user.email) || '';
  var _pp = document.getElementById('settings-penname');
  if (_pp) _pp.value = (state.user && state.user.penName) || '';
  // Reconcile live billing state from Stripe first (self-healing: reflects a cancel,
  // plan change, or payment problem made in the portal OR the Stripe dashboard), then
  // render. The endpoint no-ops server-side for users with no subscription on file.
  fetch('/api/tokens/sync-subscription', { method: 'POST' })
    .then(function() {}, function() {})
    .then(function() { return fetch('/api/auth/me'); })
    .then(function(r) { return r.json(); })
    .then(function(me) {
      if (!me || !me.authenticated) return;
      renderAccountTier(me);
      renderAccountPlans(me);
      var _ppn = document.getElementById('settings-penname'); if (_ppn) _ppn.value = me.penName || '';
      var _tt = document.getElementById('dev-trial-toggle'); if (_tt) _tt.checked = (me.tier === 'trial');
      var _td = document.getElementById('dev-trial-date'); if (_td && me.trialStartedAt) _td.value = String(me.trialStartedAt).slice(0,10);
      var _np=document.getElementById('pref-promo'); if(_np)_np.checked = me.notifyPromo !== false;
      var _nf=document.getElementById('pref-features'); if(_nf)_nf.checked = me.notifyFeatures !== false;
      var _na=document.getElementById('pref-activity'); if(_na)_na.checked = me.notifyActivity !== false;
      return fetch('/api/auth/usage').then(function(r) { return r.json(); });
    })
    .then(function(usage) {
      if (usage) renderAccountUsage(usage);
    })
    .catch(function(){});
}

function savePreferences() {
  var msg = document.getElementById('prefs-msg');
  var body = {
    notify_promo: !!(document.getElementById('pref-promo') || {}).checked,
    notify_features: !!(document.getElementById('pref-features') || {}).checked,
    notify_activity: !!(document.getElementById('pref-activity') || {}).checked
  };
  fetch('/api/auth/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!msg) return;
      msg.style.display = 'block';
      if (d && d.success) { msg.style.color = '#0a4a38'; msg.textContent = 'Preferences saved.'; }
      else { msg.style.color = 'var(--error)'; msg.textContent = (d && d.error) || 'Could not save preferences.'; }
      setTimeout(function(){ if (msg) msg.style.display = 'none'; }, 4000);
    })
    .catch(function(){ if (msg) { msg.style.display='block'; msg.style.color='var(--error)'; msg.textContent='Could not save preferences.'; } });
}

function resetFeedbackForm() {
  var c = document.getElementById('feedback-category'); if (c) c.value = 'Suggestion';
  var sub = document.getElementById('feedback-subject'); if (sub) sub.value = '';
  var m = document.getElementById('feedback-message'); if (m) m.value = '';
  var er = document.getElementById('feedback-error'); if (er) er.classList.add('hidden');
  var ok = document.getElementById('feedback-success'); if (ok) ok.classList.add('hidden');
  var btn = document.getElementById('feedback-submit-btn'); if (btn) { btn.disabled = false; btn.textContent = 'Send feedback'; }
}

function submitFeedback() {
  var er = document.getElementById('feedback-error');
  var ok = document.getElementById('feedback-success');
  var btn = document.getElementById('feedback-submit-btn');
  var msgEl = document.getElementById('feedback-message');
  if (er) er.classList.add('hidden');
  if (ok) ok.classList.add('hidden');
  var message = msgEl ? msgEl.value.trim() : '';
  if (!message) { if (er) { er.textContent = 'Please enter a message before sending.'; er.classList.remove('hidden'); } return; }
  var body = {
    category: (document.getElementById('feedback-category') || {}).value || 'Other',
    subject: (document.getElementById('feedback-subject') || {}).value || '',
    message: message
  };
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) {
        if (msgEl) msgEl.value = '';
        var sub = document.getElementById('feedback-subject'); if (sub) sub.value = '';
        if (ok) { ok.textContent = 'Thanks for the feedback. We have received your message.'; ok.classList.remove('hidden'); }
      } else { if (er) { er.textContent = (d && d.error) || 'Could not send your feedback.'; er.classList.remove('hidden'); } }
      if (btn) { btn.disabled = false; btn.textContent = 'Send feedback'; }
    })
    .catch(function(){ if (er) { er.textContent = 'Could not send your feedback. Please try again.'; er.classList.remove('hidden'); } if (btn) { btn.disabled = false; btn.textContent = 'Send feedback'; } });
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

  // Lone-copper nudge: copper with no paid SM coverage. Conversion prompt only;
  // the deletion clock is inactivity-driven, not shown here.
  var loneBanner = document.getElementById('account-lone-banner');
  if (loneBanner) {
    if (me.loneCopper) {
      loneBanner.textContent = 'You are on Copper with no active Story Master coverage. You can keep creating and buying tokens, but consider Silver to unlock more.';
      loneBanner.style.display = 'block';
    } else {
      loneBanner.style.display = 'none';
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
      row('Order printed book', feat.can_print) +
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
    card(usage.imagesAllTime || 0, 'IMAGES ALL TIME') +
    card('<span id="usage-utlt">&mdash;</span>', 'UTOLT TOKENS') +
    card('<span id="usage-cot">&mdash;</span>', 'CARRY-OVER TOKENS');
  refreshUsageTokens();
}

// Read-only token balances for the Usage panel. Pure read -- does NOT grant.
function refreshUsageTokens() {
  var u = document.getElementById('usage-utlt');
  var c = document.getElementById('usage-cot');
  if (!u && !c) return;
  fetch('/api/tokens/balance')
    .then(function(r) { return r.json(); })
    .then(function(b) {
      if (u) u.textContent = (b && typeof b.utlt === 'number') ? b.utlt.toLocaleString() : '0';
      if (c) c.textContent = (b && typeof b.cot === 'number') ? b.cot.toLocaleString() : '0';
    })
    .catch(function() {});
}

function renderAccountPlans(me) {
  var el = document.getElementById('account-plans');
  if (!el) return;
  var all = me.allTiers || {};
  var current = me.tier || 'copper';
  var order = ['copper','silver','gold','platinum'];
  var live = hasLiveSubscription(me);

  el.innerHTML = order.map(function(key) {
    var t = all[key];
    if (!t) return '';
    var isCurrent = (key === current);
    var col = TIER_COLORS[key] || TIER_COLORS.copper;
    var priceText = t.price ? ('$' + t.price + '<span style="font-size:11px;color:var(--text-light);">/mo</span>') : 'Free';
    var action = '';
    if (key !== 'copper' && !isCurrent && !live) {
      action = '<button class="btn btn-primary btn-sm" style="margin-top:10px;width:100%;" onclick="subscribeTier(&#39;' + key + '&#39;)">Subscribe</button>';
    } else if (key !== 'copper' && !isCurrent && live) {
      // TF-15: in-place plan change for an existing subscriber (proration on next invoice).
      var curIdx = order.indexOf(current), thisIdx = order.indexOf(key);
      var swLabel = (thisIdx > curIdx) ? ('Upgrade to ' + (t.name || key)) : ('Switch to ' + (t.name || key));
      action = '<button class="btn btn-primary btn-sm" style="margin-top:10px;width:100%;" onclick="changePlan(&#39;' + key + '&#39;)">' + swLabel + '</button>';
    } else if (key !== 'copper' && isCurrent && live) {
      action = '<button class="btn btn-sm" style="margin-top:10px;width:100%;" onclick="openBillingPortal()">Manage</button>';
    }
    return '<div style="border:1px solid ' + (isCurrent ? 'var(--gold)' : 'rgba(201,168,76,0.2)') + ';' +
      'border-radius:var(--radius-lg);padding:16px;background:' +
      (isCurrent ? 'rgba(201,168,76,0.08)' : 'transparent') + ';display:flex;flex-direction:column;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="font-family:var(--font-display);font-size:14px;letter-spacing:1px;color:' + col.bg + ';">' +
          (t.name || key).toUpperCase() + '</span>' +
        (isCurrent ? '<span style="font-size:10px;color:var(--gold);font-weight:600;">CURRENT</span>' : '') +
      '</div>' +
      '<div style="font-family:var(--font-display);font-size:22px;color:var(--text);margin:8px 0;">' + priceText + '</div>' +
      '<div style="font-size:11px;color:var(--text-light);line-height:1.5;">' + (t.description || '') + '</div>' +
      action +
    '</div>';
  }).join('');

  // Billing status line: a pending cancel (cancel-at-period-end keeps status
  // 'active', so cancelAtPeriodEnd is the only signal) takes precedence over the
  // normal next-billing date. Only shown for a live subscriber with a known date.
  var bs = document.getElementById('account-billing-status');
  if (bs) {
    var feat = (me.allTiers && me.allTiers[current]) ? me.allTiers[current] : null;
    var tierLabel = (feat && feat.name) ? feat.name : current;
    var dateStr = '';
    if (me.currentPeriodEnd) {
      try {
        dateStr = new Date(me.currentPeriodEnd).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      } catch (e) { dateStr = ''; }
    }
    var billStatus = me.subscriptionStatus || '';
    if (live && (billStatus === 'past_due' || billStatus === 'unpaid')) {
      bs.textContent = 'There is a problem with your most recent payment (often an expired or declined card). Open "Manage subscription & billing" to update your card and keep your ' + tierLabel + ' plan.';
      bs.style.display = 'block';
    } else if (live && me.cancelAtPeriodEnd && dateStr) {
      bs.textContent = 'Your ' + tierLabel + ' plan is set to cancel on ' + dateStr + ". You'll keep " + tierLabel + ' access until then, after which your account moves to Copper.';
      bs.style.display = 'block';
    } else if (live && !me.cancelAtPeriodEnd && dateStr) {
      bs.textContent = 'Next billing date: ' + dateStr + '.';
      bs.style.display = 'block';
    } else {
      bs.textContent = '';
      bs.style.display = 'none';
    }
  }

  var mb = document.getElementById('account-manage-billing-btn');
  if (mb) mb.style.display = (me && me.hasBilling) ? 'inline-block' : 'none';
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
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings','members','archives','orders','custom-styles','feedback'];
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
  } else if (view === 'feedback') {
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Feedback'}
    ]);
    if (typeof resetFeedbackForm === 'function') resetFeedbackForm();
  } else if (view === 'orders') {
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Print Orders'}
    ]);
    loadOrders();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
  try { if (typeof maybeStartTour === 'function') maybeStartTour(view); } catch (e) {}
  try { _navRecord(view); } catch (e) {}
}

function showCampaignSection(section) {
  if (section === 'assets' || section === 'archives') { var _cur = _visibleViewId(); if (_cur && _cur !== 'assets' && _cur !== 'archives') _sectionBackFrom = _cur; }
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
  if (section === 'novel') { if (typeof resetPublishForCampaignSwitch === 'function') resetPublishForCampaignSwitch(); loadNovelPeople(); loadNovelSummary(); }
  if (section === 'assets') loadAssets();
  if (section === 'archives') loadArchives();
  if (section === 'members') loadMembersTab();

  // Phase 3 — apply role-based visibility (hide DM-only UI for players).
  applyRoleVisibility();
  // Fire the per-section guided tour (characters fires from its create modal instead).
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  try { maybeStartTour(section === 'characters' ? 'char-grid' : section); } catch (e) {}
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
      ((c.campaign_image_url || c.cover_image_url)
        ? '<img class="campaign-card-img" src="' + encodeURI(c.campaign_image_url || c.cover_image_url) + '" alt="" loading="lazy" />'
        : '<div class="campaign-card-img campaign-card-img-empty"><img src="/images/Campaignia_Logo.png" alt="" /></div>') +
      '<div class="campaign-card-body">' +
        '<div class="campaign-card-name">' + c.name + '</div>' +
        campCardDescHtml(c.description) +
        '<div class="campaign-card-footer">' +
          '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
          (c.my_role === 'dm' ? '<button class="campaign-details-btn" onclick="openCampaignSettings(' + c.id + ', event)" title="Campaign details">Details</button>' : '') +
        '</div>' +
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
  if (state.currentCampaign && typeof loadCampaignLayoutOpts === 'function') loadCampaignLayoutOpts();   // layout options follow the campaign, pulled fresh from the DB
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  if (typeof resetPublishForCampaignSwitch === 'function') resetPublishForCampaignSwitch();
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  if (!editId && blockCopperCreate('campaign')) return;
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-lore').value = editId && state.currentCampaign ? (state.currentCampaign.lore || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var lore = (document.getElementById('campaign-lore') || {}).value || '';
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc, lore:lore})
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
    var _isDM = state.currentCampaign && state.currentCampaign.my_role === 'dm';
    if (!_isDM) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><img src="/images/Campaignia_Logo.png" alt="Campaignia" style="width:96px;height:96px;object-fit:contain;vertical-align:middle;" /></div>' +
        '<h3>No sessions ready yet</h3>' +
        '<p>Waiting on the Story Master to ready a session for viewing.</p></div>';
      return;
    }
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><img src="/images/Campaignia_Logo.png" alt="Campaignia" style="width:96px;height:96px;object-fit:contain;vertical-align:middle;" /></div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<p id="no-char-session-hint" style="display:none;margin-top:-2px;color:#c9a84c;font-size:13px;">It works best if you create your characters before making your session.</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    maybeShowNoCharacterHint();
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

  list.innerHTML = '<div class="session-card-grid">' + ordered.map(function(s) {
    var thumbSrc = s.title_image_url || s.establishing_image || s.first_image_url;
    var thumb = thumbSrc
      ? '<img class="session-card-img" src="' + thumbSrc + '" alt="" loading="lazy" />'
      : '<div class="session-card-img session-card-img-empty">&#128203;</div>';
    var readyChip = (s.player_access_status === 'ready')
      ? '<span class="session-badge">Ready</span>'
      : '<span class="session-badge session-badge-draft">Draft</span>';
    var transcriptChip = '';
    var menuId = 'session-menu-' + s.id;
    var deleteMenu =
      '<div class="row-menu dm-only">' +
        '<button class="row-menu-btn" onclick="event.stopPropagation();toggleRowMenu(\'' + menuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + menuId + '">' +
          '<button class="row-menu-item row-menu-item-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete session</button>' +
        '</div>' +
      '</div>';
    return '<div class="session-card" onclick="selectSession(' + s.id + ')">' +
      thumb +
      '<div class="session-card-body">' +
        '<div class="session-card-title">' + s.name + '</div>' +
        '<div class="session-card-date">' + formatSessionDate(s.session_date) + '</div>' +
        '<div class="session-card-meta">' +
          readyChip +
          transcriptChip +
          deleteMenu +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function openSessionModal() {
  if (blockCopperCreate('session')) return;
  document.getElementById('session-name').value = '';
  var _nsd = document.getElementById('session-desc'); if (_nsd) _nsd.value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  var desc = document.getElementById('session-desc') ? document.getElementById('session-desc').value : '';
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date, description:desc})
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

async function deleteSession(id) {
  if (!await uiConfirm('Delete this session and all its moments? This cannot be undone.')) return;
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

function renderSessionEstablishing(data) {
  // Approach B: the title image is the first moment (kind='establishing'); show
  // ITS image as the read-only thumbnail beside the session name (editing happens
  // on the storyboard, not here).
  var thumb = document.getElementById('session-establishing-thumb');
  if (!thumb) return;
  var moms = (data && data.moments) || state.moments || [];
  var est = null;
  for (var i = 0; i < moms.length; i++) { if (moms[i] && moms[i].kind === 'establishing') { est = moms[i]; break; } }
  var img = est && est.image;
  if (!img) { thumb.style.display = 'none'; thumb.removeAttribute('src'); return; }
  thumb.src = img;
  thumb.style.display = 'block';
}

// Inline edit of the session title + description (mirrors the campaign editor:
// pencil swaps the title to an input and the description to a textarea, saves on
// blur once focus leaves both fields, never blanks the name).
function fmtSessionDateShort(dateVal) {
  if (!dateVal) return '';
  var dateStr = (typeof dateVal === 'string') ? dateVal : (dateVal && dateVal.toISOString ? dateVal.toISOString() : String(dateVal));
  var datePart = dateStr.split('T')[0];
  try { return new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return datePart; }
}
function sessionDateISO(dateVal) {
  if (!dateVal) return '';
  var dateStr = (typeof dateVal === 'string') ? dateVal : (dateVal && dateVal.toISOString ? dateVal.toISOString() : String(dateVal));
  return dateStr.split('T')[0];
}
function renderSessionHeaderDisplay() {
  var s = state.currentSession;
  var nameEl = document.getElementById('session-detail-name');
  var dateEl = document.getElementById('session-detail-date-display');
  var descEl = document.getElementById('session-detail-desc');
  if (nameEl) nameEl.textContent = (s && s.name) ? s.name : 'Session';
  if (dateEl) dateEl.textContent = (s && s.session_date) ? fmtSessionDateShort(s.session_date) : '';
  if (descEl) descEl.textContent = (s && s.description) ? s.description : '';
}
function startSessionEdit() {
  var s = state.currentSession;
  if (!s) return;
  if (document.getElementById('session-edit-name-input')) return;
  var nameEl = document.getElementById('session-detail-name');
  var dateEl = document.getElementById('session-detail-date-display');
  var descEl = document.getElementById('session-detail-desc');
  if (nameEl) nameEl.innerHTML = '<input id="session-edit-name-input" class="camp-edit-input" onblur="sessionEditBlur()" onkeydown="sessionEditKey(event)" />';
  if (dateEl) dateEl.innerHTML = '<input type="date" id="session-edit-date-input" class="camp-edit-input sdh-date-edit" onblur="sessionEditBlur()" />';
  if (descEl) descEl.innerHTML = '<textarea id="session-edit-desc-input" class="camp-edit-textarea" placeholder="Add a description..." onblur="sessionEditBlur()"></textarea>';
  var ni = document.getElementById('session-edit-name-input');
  if (ni) { ni.value = s.name || ''; ni.focus(); ni.select(); }
  var ddi = document.getElementById('session-edit-date-input');
  if (ddi) ddi.value = sessionDateISO(s.session_date);
  var di = document.getElementById('session-edit-desc-input');
  if (di) di.value = s.description || '';
}
function sessionEditKey(e) {
  if (e && e.key === 'Enter' && e.target && e.target.id === 'session-edit-name-input') { e.preventDefault(); e.target.blur(); }
}
function sessionEditBlur() {
  setTimeout(function() {
    var ni = document.getElementById('session-edit-name-input');
    var ddi = document.getElementById('session-edit-date-input');
    var di = document.getElementById('session-edit-desc-input');
    var ae = document.activeElement;
    if (ae === ni || ae === ddi || ae === di) return;
    var s = state.currentSession;
    if (!s) { renderSessionHeaderDisplay(); return; }
    var newName = ni ? ni.value.trim() : (s.name || '');
    var newDesc = di ? di.value : (s.description || '');
    var newDate = (ddi && ddi.value) ? ddi.value : sessionDateISO(s.session_date);
    if (!newName) newName = s.name;
    if (newName === s.name && newDesc === (s.description || '') && newDate === sessionDateISO(s.session_date)) { renderSessionHeaderDisplay(); return; }
    fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + s.id, {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: newName, description: newDesc, session_date: newDate })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.id) { state.currentSession = Object.assign({}, s, data); }
      else { s.name = newName; s.description = newDesc; s.session_date = newDate; }
      renderSessionHeaderDisplay();
    })
    .catch(function(){ s.name = newName; s.description = newDesc; s.session_date = newDate; renderSessionHeaderDisplay(); });
  }, 0);
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
      renderSessionHeaderDisplay();
      renderSessionEstablishing(data);
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
      try { _navRecord('session-detail'); } catch (e) {}

      // Now that view is visible, open the most relevant tab for the session's state:
      // moments + images -> Storyboard; story generated but no images -> Review; else Story (notes).
      var _hasImg = (state.moments || []).some(function (m) { return m && (m.image || m.image_url); });
      var _hasStory = (state.moments && state.moments.length > 0) || (state.narrativeData && state.narrativeData.sections && state.narrativeData.sections.length > 0) || !!(data && data.narrative_intro);
      switchSessionTab((state.moments.length && _hasImg) ? 'storyboard' : (_hasStory ? 'review' : 'notes'));
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
      editBtn = '<button class="btn btn-sm sc-edit-btn" onclick="openChangeReview(' + r.character_id + ')">' + editLabel + '</button>';
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
        '<button class="btn btn-sm btn-primary sc-approve-btn" id="sc-approve-' + charId + '" ' +
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
  if (!ensureGenFree()) return;
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

// Render an outline string as a readable list: break onto a new bullet line at
// the 'bigger' dashes (em/en) and at inline ' - ' bullet separators. Leaves
// hyphenated words, already-multiline bullets, and plain sentences intact.
function formatOutlineText(t) {
  if (!t) return '';
  var s = String(t).trim();
  s = s.replace(/\s*[\u2014\u2013]\s*/g, '\n- ');
  s = s.replace(/ +- +/g, '\n- ');
  if (s.charAt(0) !== '-') s = '- ' + s;
  return s;
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
  state.reviewDataKey = _reviewCtxKey();
  state.narrativeDirections = (data && data.directions) || {};
  state.reviewOutlines = {};
  var _rawOut = (data && data.outlines) || {};
  Object.keys(_rawOut).forEach(function(k){ var v = _rawOut[k]; state.reviewOutlines[k] = (v && typeof v === 'object') ? (v.text || '') : (v || ''); });

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
  function narrRow(gapKey, label, cls) {
    var hasDir = !!(state.narrativeDirections && state.narrativeDirections[gapKey]);
    var oText = (state.reviewOutlines && state.reviewOutlines[gapKey]) || '';
    var safeLabel = escapeHtmlReview(label);
    var outBtn = canEditNarr
      ? '<button class="review-dir-btn" onclick="openGapOutline(\'' + gapKey + '\', \'' + safeLabel + '\')" title="The facts you want covered">\u270E Edit Narrative Outline</button>'
      : '';
    var dirBtn = canEditNarr
      ? '<button class="review-dir-btn' + (hasDir ? ' is-on' : '') + '" ' +
        'onclick="openNarrDirection(\'' + gapKey + '\', \'' + safeLabel + '\')" ' +
        'title="How do you want it written">' +
        '\u270E Edit Narrative Direction' + (hasDir ? ' \u2713' : '') + '</button>'
      : '';
    var narrMenuId = 'review-menu-' + gapKey.replace(/[^a-z0-9]/gi, '-');
    var narrMenu = canEditNarr
      ? '<div class="row-menu review-row-menu">' +
        '<button class="row-menu-btn" onclick="toggleRowMenu(\'' + narrMenuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + narrMenuId + '">' +
        '<button class="row-menu-item" onclick="openGapOutline(\'' + gapKey + '\', \'' + safeLabel + '\')">Edit Narrative Outline</button>' +
        '<button class="row-menu-item" onclick="openNarrDirection(\'' + gapKey + '\', \'' + safeLabel + '\')">Edit Narrative Direction</button>' +
        '</div></div>'
      : '';
    var body = oText
      ? '<div class="review-nar-text" style="white-space:pre-wrap;">' + escapeHtmlReview(formatOutlineText(oText)) + '</div>'
      : (canEditNarr ? '' : '<div class="review-nar-text review-nar-empty">No outline yet.</div>');
    return '<div class="review-nar ' + cls + '">' +
      '<div class="review-nar-head"><div class="review-nar-label">' + safeLabel + '</div><div class="review-actions-inline">' + outBtn + dirBtn + '</div>' + narrMenu + '</div>' +
      body +
    '</div>';
  }

  var html = '';
  var _hasEstR = panels.some(function(p){ return p.kind === 'establishing'; });
  if (!_hasEstR) html += narrRow('opening', 'Opening', 'review-nar-open');

  var _pNumR = 0;
  panels.forEach(function(p, i) {
    var _isEstR = (p.kind === 'establishing');
    var num = _isEstR ? 0 : (++_pNumR);
    var mid = p.moment_id;

    // Character chips — each carries an id; × removes when editable.
    var charChips = (p.characters || []).map(function(c) {
      var rm = canEditNarr
        ? '<button class="review-chip-x" title="Remove" onclick="castRemoveCharacter(' + mid + ', ' + c.id + ')">\u00d7</button>'
        : '';
      return '<span class="review-chip">' + escapeHtmlReview(charDisplayName(c.name)) + rm + '</span>';
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
        .map(function(c){ return '<option value="' + c.id + '">' + escapeHtmlReview(charDisplayName(c.name)) + '</option>'; }).join('');
      addChar = '<button class="review-add-btn" onclick="openCastPicker(\'character\', ' + mid + ')">+ Add character</button>';
      var haveA = {}; (p.assets || []).forEach(function(a){ haveA[String(a.id)] = true; });
      var optsA = (state.reviewData.all_assets || []).filter(function(a){ return !haveA[String(a.id)]; })
        .map(function(a){ return '<option value="' + a.id + '">' + escapeHtmlReview(a.name) + ' \u00b7 ' + (ASSET_CAT[a.category] || a.category) + '</option>'; }).join('');
      addAsset = '<button class="review-add-btn" onclick="openCastPicker(\'asset\', ' + mid + ')">+ Add asset</button>';
    }

    // Auto vs Custom indicator + reset-to-auto (only when explicit + editable).
    var castBadge = p.cast_explicit
      ? '<span class="review-cast-badge is-custom">Custom cast</span>'
      : '<span class="review-cast-badge">Auto-Matched</span>';
    var resetBtn = (canEditNarr && p.cast_explicit)
      ? '<button class="review-reset-btn" onclick="castReset(' + mid + ')" title="Drop back to automatic name-matching">Reset to auto</button>'
      : '';

    // Change marker (folded-in): which characters' look changes at THIS panel.
    var changeNote = (p.change_marks && p.change_marks.length)
      ? '<div class="review-change-mark" title="A character appearance change takes effect here">\u2726 ' +
          escapeHtmlReview(p.change_marks.join(', ')) +
          (p.change_marks.length === 1 ? '\u2019 look changes here' : ' \u2014 looks change here') + '</div>'
      : '';

    var pDirKey = _isEstR ? 'opening' : ('moment:' + i);
    var pHasDir = !!(state.narrativeDirections && state.narrativeDirections[pDirKey]);
    var pDirBtn = canEditNarr
      ? '<button class="review-dir-btn' + (pHasDir ? ' is-on' : '') + '" onclick="openNarrDirection(\'' + pDirKey + '\', \'' + (_isEstR ? 'Opening' : ('Panel ' + num)) + ' direction\')" title="How do you want it written">\u270E Edit Narrative Direction' + (pHasDir ? ' \u2713' : '') + '</button>'
      : '';
    var pOutText = (state.reviewOutlines && state.reviewOutlines[pDirKey]) || '';
    var pOutBtn = canEditNarr ? '<button class="review-dir-btn" onclick="openGapOutline(\'' + pDirKey + '\', \'' + (_isEstR ? 'Opening' : ('Panel ' + num + ' narration')) + '\')" title="The facts you want covered">\u270E Edit Narrative Outline</button>' : '';
    var pPromptBtn = (canEditNarr && !_isEstR) ? '<button class="review-dir-btn" onclick="openImagePrompt(' + mid + ')" title="Edit the image prompt for this panel">\u270E Edit Image Prompt</button>' : '';
    var pMenuId = 'review-menu-p' + mid;
    var pMenu = canEditNarr
      ? '<div class="row-menu review-row-menu">' +
        '<button class="row-menu-btn" onclick="toggleRowMenu(\'' + pMenuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + pMenuId + '">' +
        ((!_isEstR) ? '<button class="row-menu-item" onclick="openImagePrompt(' + mid + ')">Edit Image Prompt</button>' : '') +
        '<button class="row-menu-item" onclick="openGapOutline(\'' + pDirKey + '\', \'' + (_isEstR ? 'Opening' : ('Panel ' + num + ' narration')) + '\')">Edit Narrative Outline</button>' +
        '<button class="row-menu-item" onclick="openNarrDirection(\'' + pDirKey + '\', \'' + (_isEstR ? 'Opening' : ('Panel ' + num)) + ' direction\')">Edit Narrative Direction</button>' +
        '</div></div>'
      : '';
    html += '<div class="review-panel">' +
      '<div class="review-panel-head">' +
        '<span class="review-panel-num">' + (_isEstR ? 'Opening' : num) + '</span>' +
        '<span class="review-panel-title">' + escapeHtmlReview(p.title || 'Untitled panel') + '</span>' +
        castBadge + resetBtn + '<div class="review-actions-inline">' + pPromptBtn + pOutBtn + pDirBtn + '</div>' + pMenu +
      '</div>' +
      (pOutText ? '<div class="review-nar-text" style="white-space:pre-wrap;margin-bottom:4px;">' + escapeHtmlReview(formatOutlineText(pOutText)) + '</div>' : '') +
      changeNote +
      '<div class="review-row"><span class="review-label">Characters:</span> ' + charChips + ' ' + addChar + '</div>' +
      '<div class="review-row"><span class="review-label">Assets:</span> ' + assetChips + ' ' + addAsset + '</div>' +
    '</div>';

    // Bridge gap AFTER this panel (the last gap is covered by the closing).
    if (!_isEstR && i < panels.length - 1) {
      html += narrRow('between:' + i, 'Panel ' + num + ' \u2192 ' + (num + 1), 'review-nar-bridge');
    }
  });

  html += narrRow('closing', 'Closing', 'review-nar-close');

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
    if (typeof _refreshOpenMomentOptions === 'function') _refreshOpenMomentOptions(p.moment_id);
  })
  .catch(function(e){ showAlert('Could not save casting: ' + e.message); loadReview(); });
}
function castAddCharacter(momentId, sel) {
  var id = parseInt(sel.value, 10); if (!id) return;
  var p = _reviewPanel(momentId); if (!p) return;
  var name = '';
  (state.reviewData.all_characters || []).some(function(c){ if (String(c.id) === String(id)) { name = charDisplayName(c.name); return true; } return false; });
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
    state.reviewData = null; state.reviewDataKey = null;   // force a fresh fetch so the auto cast returns
    ensureReviewData(function(){
      if (state.reviewData && document.getElementById('review-list')) renderReview(state.reviewData);
      _refreshOpenMomentOptions(momentId);
    });
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
// --- Ask Claudia: contextual help (read-only, multi-turn chat). -------------
// Coarse current-view hint; the server enriches the rest (tier, tokens, role).
var _helpThread = [];      // [{ role: 'user'|'assistant', content }]
var _helpAiDoneSent = false; // set once the server emails an AI-done transcript this session
var _helpLogoutSent = false; // guard so logout emails the transcript at most once

function _helpSendTranscriptOnLogout(done) {
  var proceed = function() { if (done) { var f = done; done = null; f(); } };
  var hasQ = _helpThread && _helpThread.some(function(m) { return m.role === 'user'; });
  if (_helpLogoutSent || !hasQ) { proceed(); return; }
  _helpLogoutSent = true;
  var body = { messages: _helpThread.slice(-60), view_id: _helpCurrentViewId() };
  if (state && state.currentCampaign && state.currentCampaign.id) body.campaign_id = state.currentCampaign.id;
  var t = setTimeout(proceed, 1200);
  try {
    fetch('/api/help/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function() { clearTimeout(t); proceed(); })
      .catch(function() { clearTimeout(t); proceed(); });
  } catch (e) { clearTimeout(t); proceed(); }
}
var _helpPending = false;  // a request is in flight
var _helpError = '';       // transient error shown below the thread
function _helpCurrentViewId() {
  if (state && state.currentSession && state.currentSession.id) return 'session_detail_view';
  return '';
}
function _helpGreeting() {
  return 'Hi! I can help with anything in Campaignia. What do you need a hand with?';
}
function renderHelpThread() {
  var box = document.getElementById('help-thread'); if (!box) return;
  var html = '';
  if (!_helpThread.length) {
    html += '<div class="help-msg help-msg-bot">' + escapeHtml(_helpGreeting()) + '</div>';
  } else {
    _helpThread.forEach(function(m){
      var cls = (m.role === 'user') ? 'help-msg-user' : 'help-msg-bot';
      html += '<div class="help-msg ' + cls + '">' + escapeHtml(m.content) + '</div>';
    });
  }
  if (_helpPending) html += '<div class="help-msg help-msg-bot help-msg-pending">Thinking\u2026</div>';
  if (_helpError) html += '<div class="help-msg help-msg-error">' + escapeHtml(_helpError) + '</div>';
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
function openHelp() {
  var m = document.getElementById('help-panel'); if (!m) return;
  m.classList.remove('hidden');
  var fab = document.getElementById('help-fab'); if (fab) fab.style.display = 'none';
  renderHelpThread();
  var q = document.getElementById('help-question');
  if (q) setTimeout(function(){ q.focus(); }, 0);
}
function closeHelp() {
  var m = document.getElementById('help-panel'); if (m) m.classList.add('hidden');
  var fab = document.getElementById('help-fab'); if (fab) fab.style.display = '';
}
function submitHelp() {
  if (_helpPending) return;
  var qEl = document.getElementById('help-question');
  var btn = document.getElementById('help-ask-btn');
  var q = qEl ? qEl.value.trim() : '';
  if (!q) { if (qEl) qEl.focus(); return; }
  _helpError = '';
  _helpThread.push({ role: 'user', content: q });
  if (qEl) qEl.value = '';
  _helpPending = true;
  if (btn) btn.disabled = true;
  renderHelpThread();
  var body = { messages: _helpThread.slice(-12), current_view_id: _helpCurrentViewId(), ai_done_sent: _helpAiDoneSent };
  if (state && state.currentCampaign && state.currentCampaign.id) body.current_campaign_id = state.currentCampaign.id;
  fetch('/api/help/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(data){
      _helpPending = false;
      if (btn) btn.disabled = false;
      if (data && data.ok && data.answer) {
        _helpThread.push({ role: 'assistant', content: data.answer });
        if (data.ai_done_emailed) _helpAiDoneSent = true;
      } else {
        _helpThread.pop();
        if (qEl) qEl.value = q;
        _helpError = (data && data.error) ? data.error : 'Could not answer that right now - try again?';
      }
      renderHelpThread();
    })
    .catch(function(){
      _helpPending = false;
      if (btn) btn.disabled = false;
      _helpThread.pop();
      if (qEl) qEl.value = q;
      _helpError = 'Could not answer that right now - try again?';
      renderHelpThread();
    });
}

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

// Outline editors (Review). The gap outline (Opening/bridge/Closing) saves to
// narrative_outlines via the /outline PUT; a moment/panel outline saves to the
// moment's description. Both re-render Review on success.
function openGapOutline(gapKey, label) {
  state.outlineTarget = { type: 'gap', gap: gapKey };
  var titleEl = document.getElementById('outline-title');
  if (titleEl) titleEl.textContent = 'Outline \u2014 ' + (label || 'gap');
  var ta = document.getElementById('outline-text');
  if (ta) ta.value = (state.reviewOutlines && state.reviewOutlines[gapKey]) || '';
  var modal = document.getElementById('outline-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

function openMomentOutline(momentId) {
  state.outlineTarget = { type: 'moment', momentId: momentId };
  var titleEl = document.getElementById('outline-title');
  if (titleEl) titleEl.textContent = 'Panel outline';
  var cur = '';
  if (state.reviewData && Array.isArray(state.reviewData.panels)) {
    var _rp = state.reviewData.panels.find(function(p){ return p.moment_id === momentId; });
    if (_rp) cur = _rp.description || '';
  }
  var ta = document.getElementById('outline-text');
  if (ta) ta.value = cur;
  var modal = document.getElementById('outline-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

function closeOutlineModal() {
  var modal = document.getElementById('outline-modal');
  if (modal) modal.classList.add('hidden');
}

function saveOutline() {
  var tgt = state.outlineTarget;
  if (!tgt) { closeOutlineModal(); return; }
  var ta = document.getElementById('outline-text');
  var text = ta ? ta.value.trim() : '';
  if (!state.currentCampaign || !state.currentSession) { closeOutlineModal(); return; }
  var url, body;
  if (tgt.type === 'gap') {
    url = '/api/narrative/outline/' + state.currentCampaign.id + '/' + state.currentSession.id;
    body = { gap: tgt.gap, text: text };
  } else {
    url = '/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/moments/' + tgt.momentId;
    body = { description: text };
  }
  fetch(url, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.error) { showAlert('Could not save outline: ' + (data.message || data.error)); return; }
      closeOutlineModal();
      if (typeof loadReview === 'function') loadReview();
    })
    .catch(function(e){ showAlert('Could not save outline: ' + e.message); });
}

// ============================================================
// STYLE PICKER (Narrative Styles) — shared dialog of style cards.
// Step 2 wires the NARRATIVE side; the art side is added in Step 3.
// NARR_STYLE_META is the client display list (name/desc/example); its ids
// MUST match the server-side NARRATIVE_STYLES keys in routes/narrative.js.
// ============================================================
var NARR_STYLE_META = [
  { id:'classic', name:'Classic', desc:'Vivid, dramatic graphic-novel narration in present tense \u2014 the default Campaignia voice.', example:'Torchlight trembles against the cavern wall as the party edges forward, every breath held, every shadow a possible threat.' },
  { id:'dialogue', name:'Comic Dialogue', desc:'Dialogue-driven comic-book script \u2014 each spoken line led by the speaker, like a graphic novel.', example:'GARRICK: "Hold the line." VENA: "You said that last time."' },
  { id:'anime', name:'High-Drama Anime', desc:'Intense, emotional, and heroic. Heightened emotion and dynamic, expressive action.', example:'Ruk\u2019s heartbeat thundered like a war drum as the darkness closed in \u2014 but his spirit refused to fall.' },
  { id:'epic', name:'Epic Saga', desc:'Mythic, poetic, and sweeping \u2014 a legendary saga recorded by ancient historians.', example:'Thus the companions pressed onward, their footsteps echoing through the hollow places of the world, unaware that fate watched them with patient eyes.' },
  { id:'journal', name:"Adventurer's Journal", desc:'Personal and grounded, with dry humor, like an adventurer\u2019s diary. May use first person.', example:'We thought the forest would be quiet after the fight. Turns out the turnips were louder than the monsters.' },
  { id:'cinematic', name:'Cinematic Script', desc:'Visual, fast, and minimal. Short punchy sentences describing what the camera sees.', example:'The torchlight flickers. Shadows stretch across the stone. Ruk stumbles, pale and shaking, as the shriek fades into the dark.' },
  { id:'lorekeeper', name:'Lorekeeper / Historian', desc:'Scholarly and mysterious \u2014 formal, slightly archaic, recorded by an in-world historian.', example:'In the annals of the Third Era, the incident of the SoupMaster is noted with both caution and curiosity.' },
  { id:'noir', name:'Noir', desc:'Gritty, moody, cynical fantasy-noir. Hard-boiled phrasing, shadows, and suspicion.', example:'The cave breathed cold air like a liar exhaling excuses, and the torchlight wasn\u2019t bright enough to chase off the truth.' },
  { id:'grim', name:'Dark Fantasy / Grim', desc:'Bleak, heavy, and visceral. Dread, decay, and the cost of every choice.', example:'Blood soaked into the stone, vanishing as if the earth itself were thirsty. Even hope felt like a dying ember.' },
  { id:'storybook', name:"Children's Storybook", desc:'Whimsical, gentle, and playful \u2014 warm language and a sense of wonder.', example:'And so the brave friends tip-toed into the twinkly cave, where shadows danced like shy little creatures.' }
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
  if (moment) {
    // One-deep Revert: mirror the server's armed slot locally (the prior image is
    // the panel's current image, before we overwrite) so the Revert pill shows now.
    if (moment.image && moment.image !== imageUrl) {
      moment.revert_image = moment.image;
      moment.revert_img_w = moment.img_w || null;
      moment.revert_img_h = moment.img_h || null;
    }
    moment.image = imageUrl; moment.archived = false;
  }
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
    clearGenLock();
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
  clearCharGenBusy(charId);   // TF-09: generation finished
  var ch = (state.characters || []).find(function(c) { return c.id === charId; });
  if (ch) {
    if (ch.canonical_reference_url && ch.canonical_reference_url !== url) ch.revert_reference_url = ch.canonical_reference_url;
    ch.canonical_reference_url = url; ch.archived = false; renderCharModalPrompt(ch);
  }
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

// ===== Custom Art Styles (Platinum) =====
var cstyleSamples = []; // sample_urls from the latest analyze, carried into save
var cstylePreviewUrl = ''; // last-rendered preview image, persisted with the style
function customStylesLoaded() { return !!(state && state._customStylesLoaded); }
function getCustomStyles() { return (state && state.customStyles) ? state.customStyles : []; }
function customStyleById(id) {
  var rid = String(id).indexOf('custom:') === 0 ? String(id).slice(7) : String(id);
  var lists = [ getCustomStyles(), getAvailableStyles() ];  // own (full, has style_prompt) first; available (lean) only for members' SM styles
  for (var L = 0; L < lists.length; L++) { var list = lists[L]; for (var i = 0; i < list.length; i++) { if (String(list[i].id) === rid) return list[i]; } }
  return null;
}
function loadCustomStyles(cb) {
  fetch('/api/art-styles/custom', { headers: { 'Accept': 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(data){ if (state) { state.customStyles = Array.isArray(data) ? data : []; state._customStylesLoaded = true; state._availableStylesLoaded = false; } })
    .catch(function(){ if (state) { state.customStyles = state.customStyles || []; state._customStylesLoaded = true; state._availableStylesLoaded = false; } })
    .then(function(){ if (typeof cb === 'function') cb(); });
}
// Styles the caller may USE in the current campaign: own (if Platinum) + the
// campaign SM's (if the SM is Platinum and the caller is a member). Used by the
// art picker and by custom-name resolution for SM-shared styles. Falls back to
// own styles when no campaign is in context.
function availableStylesLoaded() { return !!(state && state._availableStylesLoaded); }
function getAvailableStyles() { return (state && state.availableStyles) ? state.availableStyles : []; }
function loadAvailableStyles(campaignId, cb) {
  var url = campaignId ? ('/api/art-styles/custom/available/' + campaignId) : '/api/art-styles/custom';
  fetch(url, { headers: { 'Accept': 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(data){ if (state) { state.availableStyles = Array.isArray(data) ? data : []; state._availableStylesLoaded = true; } })
    .catch(function(){ if (state) { state.availableStyles = state.availableStyles || []; state._availableStylesLoaded = true; } })
    .then(function(){ if (typeof cb === 'function') cb(); });
}
function cstyleErr(msg) { var e = document.getElementById('cstyle-error'); if (!e) return; if (msg) { e.textContent = msg; e.classList.remove('hidden'); } else { e.textContent = ''; e.classList.add('hidden'); } }
function cstyleSaveErr(msg) { var e = document.getElementById('cstyle-save-error'); if (!e) return; if (msg) { e.textContent = msg; e.classList.remove('hidden'); } else { e.textContent = ''; e.classList.add('hidden'); } }
function resetCustomStyleForm() {
  cstyleSamples = [];
  cstylePreviewUrl = '';
  var vals = { 'cstyle-edit-id':'', 'cstyle-name':'', 'cstyle-prompt':'' };
  Object.keys(vals).forEach(function(k){ var el = document.getElementById(k); if (el) el.value = vals[k]; });
  var fade = document.getElementById('cstyle-fade'); if (fade) fade.checked = false;
  var pw = document.getElementById('cstyle-preview-wrap'); if (pw) pw.style.display = 'none';
  var pi = document.getElementById('cstyle-preview-img'); if (pi) pi.src = '';
  var ft = document.getElementById('cstyle-form-title'); if (ft) ft.textContent = 'Create a new style';
  ['cstyle_1','cstyle_2','cstyle_3','cstyle_4'].forEach(function(k){ clearSlot(k); slotFiles[k + '_clear'] = false; });
  cstyleErr(''); cstyleSaveErr('');
}
function openCustomStylesView() {
  if (!(state && state.user && state.user.tier === 'platinum')) {
    showAlert('Custom Art Styles are a Platinum feature. Upgrade to Platinum to build and use your own art styles.');
    return;
  }
  showView('custom-styles');
  var _csn = document.getElementById('campaign-subnav'); if (_csn) _csn.style.display = 'none';
  setBreadcrumb([{ label: 'My Campaigns', action: "showView('campaigns')" }, { label: 'Custom Art Styles' }]);
  loadCustomStyles(renderCustomStyleCards);
}
function openCustomStyles() {
  if (!(state && state.user && state.user.tier === 'platinum')) {
    showAlert('Custom Art Styles are a Platinum feature. Upgrade to Platinum to build and use your own art styles.');
    return;
  }
  resetCustomStyleForm();
  var m = document.getElementById('cstyle-modal');
  if (m) m.classList.remove('hidden');
}
function closeCustomStyles() {
  var m = document.getElementById('cstyle-modal');
  if (m) m.classList.add('hidden');
  ['cstyle_1','cstyle_2','cstyle_3','cstyle_4'].forEach(function(k){ slotFiles[k] = null; slotFiles[k + '_clear'] = false; });
}
function renderCustomStyleCards() {
  var grid = document.getElementById('cstyle-grid');
  if (!grid) return;
  var list = getCustomStyles();
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var html = list.map(function(s, i) {
    var bg = colors[i % colors.length];
    var thumb = (Array.isArray(s.sample_urls) && s.sample_urls[0])
      ? '<img src="' + s.sample_urls[0] + '" style="width:100%;height:100%;object-fit:cover;" alt="' + escapeHtml(s.name || '') + '" />'
      : '<span style="font-size:22px;">&#127912;</span>';
    return '<div class="char-card" style="cursor:pointer;" onclick="editCustomStyle(\'' + s.id + '\')">' +
      '<div class="char-card-header">' +
        '<div class="char-avatar" style="background:' + bg + ';">' + thumb + '</div>' +
        '<div class="char-actions">' +
          '<button class="char-btn char-btn-delete" onclick="event.stopPropagation();deleteCustomStyle(\'' + s.id + '\')">Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="char-name">' + escapeHtml(s.name || 'Untitled') + '</div>' +
      '<div class="char-desc">' + (s.is_fade ? 'Soft, faded edges.' : 'Your custom art style.') + '</div>' +
      (s.is_fade ? '<span class="char-badge">Soft edges</span>' : '') +
    '</div>';
  }).join('');
  html += '<div class="add-char-card" onclick="openCustomStyles()"><div class="plus">+</div><span>New style</span></div>';
  grid.innerHTML = html;
}
function collectCstyleFiles() {
  var out = [];
  ['cstyle_1','cstyle_2','cstyle_3','cstyle_4'].forEach(function(k){ if (slotFiles[k]) out.push(slotFiles[k]); });
  return out;
}
function collectCstyleRefs() {
  var files = []; var urls = [];
  ['cstyle_1','cstyle_2','cstyle_3','cstyle_4'].forEach(function(k){
    if (slotFiles[k]) { files.push(slotFiles[k]); return; }
    var pv = document.getElementById('preview-' + k);
    if (pv && pv.src && /^https?:/i.test(pv.src) && !pv.classList.contains('hidden')) urls.push(pv.src);
  });
  return { files: files, urls: urls };
}
function analyzeCustomStyle() {
  cstyleErr('');
  var refs = collectCstyleRefs();
  if ((refs.files.length + refs.urls.length) < 2) { cstyleErr('Add at least 2 reference images first.'); return; }
  var btn = document.getElementById('cstyle-analyze-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  var fd = new FormData();
  refs.files.forEach(function(f){ fd.append('images', f); });
  fd.append('sample_urls', JSON.stringify(refs.urls));
  fetch('/api/art-styles/custom/analyze', { method: 'POST', body: fd })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.error) { cstyleErr(data.message || data.error); return; }
      var pr = document.getElementById('cstyle-prompt'); if (pr) pr.value = data.style_prompt || '';
      var fade = document.getElementById('cstyle-fade'); if (fade) fade.checked = !!data.is_fade;
      cstyleSamples = Array.isArray(data.sample_urls) ? data.sample_urls : [];
      if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
      var _nm = document.getElementById('cstyle-name'); if (_nm && !_nm.value.trim()) _nm.value = 'Untitled Style';
      saveCustomStyle({ keepOpen: true });
    })
    .catch(function(e){ cstyleErr('Could not analyze the style: ' + e.message); })
    .then(function(){ if (btn) { btn.disabled = false; btn.textContent = 'Analyze style (1 token)'; } });
}
function previewCustomStyle() {
  cstyleErr('');
  var pr = document.getElementById('cstyle-prompt');
  var txt = pr ? pr.value.trim() : '';
  if (!txt) { cstyleErr('Add a style description first (analyze or type one).'); return; }
  var fade = document.getElementById('cstyle-fade');
  var btn = document.getElementById('cstyle-preview-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Rendering...'; }
  fetch('/api/images/custom-style-preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style_prompt: txt, is_fade: !!(fade && fade.checked), style_id: (document.getElementById('cstyle-edit-id') || {}).value || null })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.error) { cstyleErr(data.message || data.error); return; }
      var wrap = document.getElementById('cstyle-preview-wrap');
      var img = document.getElementById('cstyle-preview-img');
      if (img) img.src = data.image || '';
      if (wrap) wrap.style.display = data.image ? 'block' : 'none';
      cstylePreviewUrl = data.image || '';
      if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
    })
    .catch(function(e){ cstyleErr('Could not render the preview: ' + e.message); })
    .then(function(){ if (btn) { btn.disabled = false; btn.textContent = 'Preview render (1 token)'; } });
}
function saveCustomStyle(opts) {
  opts = opts || {};
  var keepOpen = !!opts.keepOpen;
  cstyleSaveErr('');
  var name = (document.getElementById('cstyle-name') || {}).value;
  var prompt = (document.getElementById('cstyle-prompt') || {}).value;
  name = (name || '').trim(); prompt = (prompt || '').trim();
  if (!name) { cstyleSaveErr('Please name your style.'); return; }
  if (!prompt) { cstyleSaveErr('The style description is empty. Analyze your samples or write one first.'); return; }
  var editEl = document.getElementById('cstyle-edit-id');
  var editId = (editEl || {}).value;
  var fade = document.getElementById('cstyle-fade');
  var isFade = !!(fade && fade.checked);
  var btn = document.getElementById('cstyle-save-btn');
  if (btn && !keepOpen) { btn.disabled = true; btn.textContent = 'Saving...'; }
  var url = editId ? ('/api/art-styles/custom/' + editId) : '/api/art-styles/custom';
  var method = editId ? 'PUT' : 'POST';
  var body = editId ? { name: name, style_prompt: prompt, is_fade: isFade, preview_url: cstylePreviewUrl || null } : { name: name, style_prompt: prompt, is_fade: isFade, sample_urls: cstyleSamples, preview_url: cstylePreviewUrl || null };
  fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data.error) { cstyleSaveErr(data.message || data.error); return; }
      if (!editId && data && data.id && editEl) { editEl.value = data.id; var ft = document.getElementById('cstyle-form-title'); if (ft) ft.textContent = 'Edit style'; }
      if (!keepOpen) closeCustomStyles();
      loadCustomStyles(function(){ renderCustomStyleCards(); if (typeof refreshArtStyleButtons === 'function') refreshArtStyleButtons(); });
    })
    .catch(function(e){ cstyleSaveErr('Could not save: ' + e.message); })
    .then(function(){ if (btn && !keepOpen) { btn.disabled = false; btn.textContent = 'Save style'; } });
}
function paintSlotUrl(slot, url) {
  var preview = document.getElementById('preview-' + slot);
  var placeholder = document.getElementById('placeholder-' + slot);
  var clearBtn = document.getElementById('clear-' + slot);
  if (!preview) return;
  preview.src = url;
  preview.classList.remove('hidden');
  if (placeholder) placeholder.style.display = 'none';
  if (clearBtn) clearBtn.style.display = 'inline-flex';
}
function editCustomStyle(id) {
  var sObj = customStyleById(id);
  if (!sObj) return;
  resetCustomStyleForm();
  var eid = document.getElementById('cstyle-edit-id'); if (eid) eid.value = sObj.id;
  var nm = document.getElementById('cstyle-name'); if (nm) nm.value = sObj.name || '';
  var pr = document.getElementById('cstyle-prompt'); if (pr) pr.value = sObj.style_prompt || '';
  var fade = document.getElementById('cstyle-fade'); if (fade) fade.checked = !!sObj.is_fade;
  var ft = document.getElementById('cstyle-form-title'); if (ft) ft.textContent = 'Edit style';
  cstyleSamples = Array.isArray(sObj.sample_urls) ? sObj.sample_urls : [];
  ['cstyle_1','cstyle_2','cstyle_3','cstyle_4'].forEach(function(k, i){ if (cstyleSamples[i]) paintSlotUrl(k, cstyleSamples[i]); });
  cstylePreviewUrl = sObj.preview_url || '';
  var _pi = document.getElementById('cstyle-preview-img'); if (_pi) _pi.src = cstylePreviewUrl;
  var _pw = document.getElementById('cstyle-preview-wrap'); if (_pw) _pw.style.display = cstylePreviewUrl ? 'block' : 'none';
  var m = document.getElementById('cstyle-modal'); if (m) m.classList.remove('hidden');
}
function deleteCustomStyle(id) {
  var sObj = customStyleById(id);
  if (!confirm('Delete the custom style "' + ((sObj && sObj.name) || 'this style') + '"? This cannot be undone.')) return;
  fetch('/api/art-styles/custom/' + id, { method: 'DELETE' })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.error) { cstyleErr(data.error); return; }
      loadCustomStyles(function(){ renderCustomStyleCards(); if (typeof refreshArtStyleButtons === 'function') refreshArtStyleButtons(); });
    })
    .catch(function(e){ cstyleErr('Could not delete: ' + e.message); });
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
    if (!availableStylesLoaded()) { loadAvailableStyles(state.currentCampaign && state.currentCampaign.id, function(){ openStylePicker('art'); }); return; }
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
  if (STYLE_PICKER_KIND === 'art') {
    var _av = getAvailableStyles();
    var _mine = _av.filter(function(s){ return !s.shared_by_sm; });
    var _sm = _av.filter(function(s){ return s.shared_by_sm; });
    var _renderCustGroup = function(title, arr) {
      if (!arr.length) return '';
      var h = '<div class="style-custom-head" style="grid-column:1 / -1;margin:8px 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--gold-dim);">' + escapeHtml(title) + '</div>';
      h += arr.map(function(s) {
        var cid = 'custom:' + s.id;
        var on2 = (cid === cur) ? ' is-selected' : '';
        var badge2 = (cid === cur) ? ' <span class="style-card-current">\u2713 current</span>' : '';
        var _d = s.is_fade ? 'Soft, faded edges.' : (s.shared_by_sm ? "Shared by your campaign's SM." : 'Your custom art style.');
        var _samp = (Array.isArray(s.sample_urls) && s.sample_urls[0]) ? s.sample_urls[0] : '';
        var _thumb = _samp
          ? '<div class="style-card-thumb" style="width:100%;height:84px;border-radius:8px;overflow:hidden;margin-bottom:6px;background:#000;"><img src="' + _samp + '" alt="' + escapeHtml(s.name || '') + '" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>'
          : '';
        return '<div class="style-card' + on2 + '" onclick="selectStyleCard(\'art\',\'' + cid + '\')">' +
          _thumb +
          '<div class="style-card-name">' + escapeHtml(s.name || 'Untitled') + badge2 + '</div>' +
          '<div class="style-card-desc">' + _d + '</div>' +
          '</div>';
      }).join('');
      return h;
    };
    grid.innerHTML += _renderCustGroup('My Custom Styles', _mine);
    grid.innerHTML += _renderCustGroup('Campaign Styles (SM)', _sm);
  }
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
      mpSave('session', { narrative_style: state.narrativeStyle });
      refreshNarrStyleButtons();
      closeStylePicker();
    })
    .catch(function(e) { showAlert('Could not set narrative style: ' + e.message); });
  } else if (kind === 'art') {
    state.artStyle = id;
    mpSave('session', { art_style: id });
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
  { id:'High fantasy illustration', name:'High fantasy', desc:'Rich, painterly high-fantasy illustration \u2014 the Campaignia default.' },
  { id:'Anime manga style', name:'Anime / manga', desc:'Clean anime / manga linework with expressive shading.' },
  { id:'Dark gritty comic book', name:'Dark and gritty', desc:'Heavy ink and deep shadow, a gritty comic-book tone.' },
  { id:'Classic pen and ink', name:'Pen and ink', desc:'Classic black-and-white pen-and-ink line art.' },
  { id:'Fantasy oil painting', name:'Fantasy oil', desc:'Rich, saturated oil-paint cover art \u2014 heroic and dramatic, with painterly brushwork and soft, borderless edges.' },
  { id:'Fantasy pastel', name:'Fantasy pastel', desc:'Soft, dreamy pastel and watercolor blend with glowing highlights and gentle, feathered edges.' },
  { id:'Watercolor painterly', name:'Watercolor', desc:'Soft, painterly watercolor washes and loose edges.' },
  { id:'Charcoal drawing', name:'Charcoal', desc:'Traditional charcoal on rough paper \u2014 deep blacks, smudged mid-tones, and bold, expressive shadows.' },
  { id:'Comic book cel-shaded', name:'Cel-shaded', desc:'Thick ink outlines and hard cel-shaded shadow blocks; bold, hand-painted graphic-novel look.' }
];

function artStyleName(v) {
  if (typeof v === 'string' && v.indexOf('custom:') === 0) { var _cs = customStyleById(v); return _cs ? (_cs.name || 'Custom style') : 'Custom style'; }
  for (var i = 0; i < ART_STYLE_META.length; i++) { if (ART_STYLE_META[i].id === v) return ART_STYLE_META[i].name; }
  return v || 'High fantasy';
}

// Display label for an art style. Presets show their plain name; custom styles
// show "Custom: <name>" so members know it's custom (and to nudge upgrades).
// stampedName: a server-resolved name (archives carry art_style_name) so the
// label is identical for every viewer and survives renames/deletes/lapses.
function artStyleLabel(v, stampedName) {
  if (typeof v === 'string' && v.indexOf('custom:') === 0) {
    var nm = stampedName;
    if (!nm) { var r = artStyleName(v); if (r && r !== 'Custom style') nm = r; }
    return nm ? ('Custom: ' + nm) : 'Custom style';
  }
  return artStyleName(v);
}

function refreshArtStyleButtons() {
  var v = state.artStyle ? state.artStyle : 'High fantasy illustration';
  var label = 'Art: ' + artStyleLabel(v);
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
  // If this version's art style is a custom one, load the campaign-available
  // styles so the button label resolves to 'Custom: <name>' (covers members
  // using the SM's style before they've opened the picker).
  if (typeof state.artStyle === 'string' && state.artStyle.indexOf('custom:') === 0 && !availableStylesLoaded()) {
    loadAvailableStyles(state.currentCampaign && state.currentCampaign.id, function(){ refreshArtStyleButtons(); });
  }
}

// ============================================================
// "Generate Narrative & Images" (Pass 1) — the commit point on the Review tab.
// Generates the narrative prose ONCE (honoring per-gap directions + Session
// Notes), then runs image generation. The narrative is produced for the first
// time here, so it reflects the casting and directions set on the Review tab.
// ============================================================
// === Session-wide generation lock ========================================
// Only ONE session-wide generation (Generate Story / Images / Narrative) may
// run at a time; while one runs, single-image regen/retouch are blocked too.
// Auto-expires after 15 min so a missed clear can never lock a user out for
// good (the image batch itself caps at 12 min).
function sessionGenBusy() {
  var L = state.sessionGenLock;
  if (!L) return null;
  if (Date.now() - L.at > 15 * 60 * 1000) { state.sessionGenLock = null; return null; }
  return L.label;
}
function setGenLock(label) { state.sessionGenLock = { label: label, at: Date.now() }; }
function clearGenLock() { state.sessionGenLock = null; }
function ensureGenFree() {
  var b = sessionGenBusy();
  if (b) {
    // Client-side lock; auto-expires in 15 min. If a run got stuck (a hung or
    // aborted request that skipped its clear), offer a manual override so the user
    // is never blocked waiting it out. Two-step on purpose: override clears the
    // lock, then they start again.
    uiConfirm('A session-wide generation (' + b + '\u2026) appears to be running, so this action is blocked. If it looks stuck, you can override and clear the lock, then try again.', { okText: 'Override & unlock', cancelText: 'Keep waiting' })
      .then(function (ok) { if (ok) { clearGenLock(); showAlert('Generation lock cleared. You can start again now.'); } });
    return false;
  }
  return true;
}

function generateNarrativeAndImages() {
  if (!ensureGenFree()) return;
  setGenLock('Generate Narrative');
  var btn = document.getElementById('review-generate-btn');
  var origLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Generating\u2026'; }

  // PARALLEL: images don't depend on the narrative prose (the board renders
  // from the moments/prompts), so start BOTH at once and poll each. Render the
  // board now with empty prose + image spinners — the narrative fills in when
  // its async job finishes. Narrative is a submit->poll job so a long write
  // can't hit the gateway timeout.
  state.narrativeData = { intro: '', sections: [], outro: '' };
  state.narrativeStyleUsed = state.narrativeStyle || 'classic';
  switchSessionTab('storyboard');
  if (typeof renderStoryboard === 'function') renderStoryboard();

  // Kick off image generation (its own progress bar + per-panel spinners + poll).
  setTimeout(function() { if (typeof generateAllImages === 'function') generateAllImages(true); }, 60);

  // Kick off the narrative as an async job and poll it independently.
  state.narrJobActive = true;
  var _nctl = new AbortController();
  state.abortNarr = _nctl;
  var _ncb = document.getElementById('narr-cancel-btn'); if (_ncb) _ncb.style.display = 'inline-block';
  // Narrative progress bar, paired with the Images bar on the storyboard.
  // Ease toward ~90% (write time is unknown), snap to 100% + fade out on done.
  var _nbc = document.getElementById('narr-bar-cell'); if (_nbc) _nbc.style.display = 'block';
  var _nfill = document.getElementById('narr-progress-fill'); if (_nfill) _nfill.style.width = '0%';
  var _npct = 0;
  var _nticker = setInterval(function() {
    _npct = Math.min(90, _npct + Math.max(1, (90 - _npct) * 0.10));
    if (_nfill) _nfill.style.width = _npct.toFixed(0) + '%';
  }, 500);

  function _narrEnd(ok) {
    if (ok && typeof refreshTokenBalance === 'function') refreshTokenBalance();
    clearInterval(_nticker);
    state.narrJobActive = false;
    clearGenLock();
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    var _c = document.getElementById('narr-cancel-btn'); if (_c) _c.style.display = 'none';
    if (ok && _nfill) _nfill.style.width = '100%';
    setTimeout(function() { var b = document.getElementById('narr-bar-cell'); if (b) b.style.display = 'none'; }, ok ? 400 : 0);
  }

  fetch('/api/narrative/generate/' + state.currentCampaign.id + '/' + state.currentSession.id + forkQ(), {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ key: getApiKey() || 'platform' }),
    signal: _nctl.signal
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (!data || !data.job_id) { _narrEnd(false); showAlert('Could not start narrative: ' + ((data && data.error) || 'no job id returned')); return; }
    var jobId = data.job_id;
    var tries = 0;
    var poll = function() {
      if (!state.narrJobActive) return;
      if (tries++ > 100) { _narrEnd(false); showAlert('The narrative is taking longer than expected. Reload the session in a moment to see it.'); return; }
      fetch('/api/narrative/job/' + jobId, { signal: _nctl.signal })
        .then(function(r){ return r.json(); })
        .then(function(j){
          if (!state.narrJobActive) return;
          if (j.status === 'pending') { setTimeout(poll, 3000); return; }
          if (j.status === 'error') { _narrEnd(false); showAlert('Could not generate narrative: ' + (j.error || 'unknown error')); return; }
          state.narrativeData = { intro: j.intro || '', sections: j.sections || [], outro: j.outro || '' };
          if (typeof fillStoryboardProse === 'function') fillStoryboardProse(state.narrativeData);
          _narrEnd(true);
        })
        .catch(function(e){ if (e && e.name === 'AbortError') return; if (!state.narrJobActive) return; setTimeout(poll, 3000); });
    };
    poll();
  })
  .catch(function(e){ _narrEnd(false); if (e && e.name === 'AbortError') return; showAlert('Could not start narrative: ' + e.message); });
}

function cancelExtract() {
  clearGenLock();
  if (state.abortExtract) { try { state.abortExtract.abort(); } catch (e) {} }
  var w = document.getElementById('progress-wrap'); if (w) w.style.display = 'none';
  var c = document.getElementById('extract-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('extract-btn'); if (b) b.disabled = false;
}

function cancelGenAll() {
  clearGenLock();
  if (state.abortGenAll) { try { state.abortGenAll.abort(); } catch (e) {} }
  if (typeof hideAllPanelBusy === 'function') hideAllPanelBusy();
  var w = document.getElementById('generate-progress'); if (w) w.style.display = 'none';
  var c = document.getElementById('genall-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('generate-all-btn'); if (b) b.disabled = false;
}

function cancelNarr() {
  state.narrJobActive = false;
  clearGenLock();
  if (state.abortNarr) { try { state.abortNarr.abort(); } catch (e) {} }
  var w = document.getElementById('review-progress-wrap'); if (w) w.style.display = 'none';
  var c = document.getElementById('narr-cancel-btn'); if (c) c.style.display = 'none';
  var b = document.getElementById('review-generate-btn'); if (b) b.disabled = false;
}

// Generate the narrative ONLY (no images). Same narrative pass as the combined
// button, but it stops after painting the prose into the panels. Lets you
// rewrite the story without regenerating art / spending image tokens.
function generateNarrativeOnly() {
  if (!ensureGenFree()) return;
  setGenLock('Generate Narrative');
  var btn = document.getElementById('sb-generate-narr-btn');
  var origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Writing narrative\u2026'; }
  // Narrative-only drives its OWN dedicated 'Narrative:' bar (narr-bar-cell),
  // not the shared 'Images:' bar -- so a solo narrative run is labeled correctly
  // and, as the only visible bar, spans the full width.
  var wrap = document.getElementById('narr-bar-cell');
  var fill = document.getElementById('narr-progress-fill');
  var pct = 0;
  if (wrap) wrap.style.display = 'block';
  if (fill) fill.style.width = '0%';
  var _nctl = new AbortController();
  state.abortNarrOnly = _nctl;
  var _cb = document.getElementById('sb-narr-cancel-btn'); if (_cb) _cb.style.display = 'inline-block';
  var ticker = setInterval(function () {
    pct = Math.min(90, pct + Math.max(1, (90 - pct) * 0.12));
    if (fill) fill.style.width = pct.toFixed(0) + '%';
  }, 400);
  function endBar(done) {
    clearInterval(ticker);
    clearGenLock();
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
    // The endpoint is ASYNC: it returns a job_id, not the narrative. Poll the
    // job until it is done, THEN render -- previously this read data.intro/
    // sections/outro straight off the job_id response (all undefined), rendering
    // an empty narrative while the background job quietly saved the real one.
    if (data.error) { if (btn) { btn.disabled = false; btn.textContent = origLabel; } endBar(false); showAlert('Could not generate narrative: ' + data.error); return; }
    if (!data.job_id) { if (btn) { btn.disabled = false; btn.textContent = origLabel; } endBar(false); showAlert('Could not start narrative: no job id returned'); return; }
    var jobId = data.job_id;
    var tries = 0;
    var poll = function () {
      if (tries++ > 100) { if (btn) { btn.disabled = false; btn.textContent = origLabel; } endBar(false); showAlert('The narrative is taking longer than expected. Reload the session in a moment to see it.'); return; }
      fetch('/api/narrative/job/' + jobId, { signal: _nctl.signal })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.status === 'pending') { setTimeout(poll, 3000); return; }
          if (btn) { btn.disabled = false; btn.textContent = origLabel; }
          if (j.status === 'error') { endBar(false); showAlert('Could not generate narrative: ' + (j.error || 'unknown error')); return; }
          endBar(true);
          if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
          state.narrativeData = { intro: j.intro || '', sections: j.sections || [], outro: j.outro || '' };
          state.narrativeStyleUsed = state.narrativeStyle || 'classic';
          if (typeof renderStoryboard === 'function') renderStoryboard();
        })
        .catch(function (e) { if (e && e.name === 'AbortError') return; setTimeout(poll, 3000); });
    };
    poll();
  })
  .catch(function (e) {
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    endBar(false);
    if (e && e.name === 'AbortError') return;
    showAlert('Could not generate narrative: ' + e.message);
  });
}

function cancelNarrOnly() {
  clearGenLock();
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
  if (descEl) {
    var _cd = campDescTrunc((c && c.description) ? c.description : '');
    descEl.textContent = _cd.visible;
    if (_cd.truncated) descEl.title = _cd.title; else descEl.removeAttribute('title');
  }
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
  if (descEl) descEl.innerHTML = '<textarea id="camp-edit-desc-input" class="camp-edit-textarea" placeholder="Add a description..." onblur="campaignEditBlur()"></textarea>' +
    '<div class="camp-lore-edit-wrap"><label class="camp-lore-edit-label">Lore / Background</label>' +
    '<textarea id="camp-edit-lore-input" class="camp-edit-textarea" maxlength="6000" placeholder="Describe the world your campaign takes place in..." onblur="campaignEditBlur()"></textarea>' +
    '<div class="camp-lore-count" id="camp-edit-lore-count"></div></div>';
  var ni = document.getElementById('camp-edit-name-input');
  if (ni) { ni.value = c.name || ''; ni.focus(); ni.select(); }
  var di = document.getElementById('camp-edit-desc-input');
  if (di) di.value = c.description || '';
  var li = document.getElementById('camp-edit-lore-input');
  if (li) { li.value = c.lore || ''; loreCount(li, 'camp-edit-lore-count'); li.addEventListener('input', function(){ loreCount(li, 'camp-edit-lore-count'); }); }
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
    var li = document.getElementById('camp-edit-lore-input');
    var ae = document.activeElement;
    if (ae === ni || ae === di || ae === li) return; // still editing one of the fields
    var c = state.currentCampaign;
    if (!c) { renderCampaignHeaderDisplay(); return; }
    var newName = ni ? ni.value.trim() : (c.name || '');
    var newDesc = di ? di.value : (c.description || '');
    var newLore = li ? li.value.slice(0, 6000) : (c.lore || '');
    if (!newName) newName = c.name; // never blank the name
    if (newName === c.name && newDesc === (c.description || '') && newLore === (c.lore || '')) {
      renderCampaignHeaderDisplay();
      return;
    }
    fetch('/api/campaigns/' + c.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, description: newDesc, lore: newLore })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.id) {
        c.name = data.name; c.description = data.description; c.lore = (data.lore != null ? data.lore : newLore);
        var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
        if (i >= 0) { state.campaigns[i].name = data.name; state.campaigns[i].description = data.description; state.campaigns[i].lore = (data.lore != null ? data.lore : newLore); }
      }
    })
    .catch(function(){})
    .then(function(){ renderCampaignHeaderDisplay(); });
  }, 0);
}

// Set (or clear, by re-clicking the current one) the campaign cover from an
// archived image. DM-only; the button is only rendered for the DM.
function setCampaignCover(archiveId, cb) {
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
      if (typeof cb === 'function') cb();
    } else {
      showAlert((data && data.error) || 'Could not update the cover.');
    }
  })
  .catch(function(){ showAlert('Could not update the campaign cover.'); });
}

function setCampaignBackCover(archiveId, cb) {
  var c = state.currentCampaign;
  if (!c) return;
  var a = (state.archives || []).find(function(x){ return x.id === archiveId; });
  if (!a) return;
  var newBack = (c.back_cover_image_url === a.image_url) ? '' : a.image_url;
  fetch('/api/campaigns/' + c.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ back_cover_image_url: newBack })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data && data.id) {
      c.back_cover_image_url = data.back_cover_image_url || '';
      var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
      if (i >= 0) state.campaigns[i].back_cover_image_url = data.back_cover_image_url || '';
      renderArchives();
      showAlert(newBack ? 'Back cover set.' : 'Back cover cleared.');
      if (typeof cb === 'function') cb();
    } else {
      showAlert((data && data.error) || 'Could not update the back cover.');
    }
  })
  .catch(function(){ showAlert('Could not update the back cover.'); });
}

// Set/clear the interior TITLE-PAGE image from an archived image. DM-only.
function setCampaignTitleImage(archiveId, cb) {
  var c = state.currentCampaign;
  if (!c) return;
  var a = (state.archives || []).find(function(x){ return x.id === archiveId; });
  if (!a) return;
  var newTitle = (c.title_image_url === a.image_url) ? '' : a.image_url;
  fetch('/api/campaigns/' + c.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title_image_url: newTitle })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data && data.id) {
      c.title_image_url = data.title_image_url || '';
      var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
      if (i >= 0) state.campaigns[i].title_image_url = data.title_image_url || '';
      renderArchives();
      showAlert(newTitle ? 'Title-page image set.' : 'Title-page image cleared.');
      if (typeof cb === 'function') cb();
    } else {
      showAlert((data && data.error) || 'Could not update the title image.');
    }
  })
  .catch(function(){ showAlert('Could not update the title-page image.'); });
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
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  try { maybeStartTour('sess-' + tab); } catch (e) {}
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

function updateAssetCount() {
  var el = document.getElementById('asset-count');
  if (!el) return;
  var n = (state.assets || []).length;
  el.textContent = n ? (' \u00b7 ' + n + (n === 1 ? ' asset' : ' assets')) : '';
}
function renderAssets() {
  updateAssetCount();
  var grid = document.getElementById('asset-grid');
  if (!grid) return;
  var cards = (state.assets || []).map(function(a) {
    var img = a.image_url
      ? '<img src="' + a.image_url + '" class="asset-card-photo" alt="' + a.name + '" onclick="openLightbox(this.src,this.alt)" />'
      : '<div class="asset-card-photo asset-photo-empty">&#127912;</div>';
    var cat = ASSET_CAT_LABEL[a.category] || 'Location';
    return '<div class="asset-card">' +
      '<div class="asset-card-img">' +
        img +
        '<div class="panel-img-actions">' +
          '<button class="panel-pill" onclick="openAssetModal(' + a.id + ')" title="Edit this asset">&#9998; Edit</button>' +
          '<button class="panel-pill" onclick="deleteAsset(' + a.id + ')" title="Delete this asset">&#10005; Delete</button>' +
        '</div>' +
      '</div>' +
      '<div class="asset-card-meta">' +
        '<div class="asset-card-name">' + a.name + '</div>' +
        '<div class="asset-card-cls">' + cat + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  var _cur = state.currentCampaign;
  var _role = _cur ? _cur.my_role : null;
  var _allowAssets = _cur && (_cur.allow_member_assets === true || _cur.allow_member_assets === 1 || _cur.allow_member_assets === 't' || _cur.allow_member_assets === 'true');
  var _canAddAsset = (_role === 'dm') || _allowAssets;
  var _addCard = _canAddAsset
    ? '<div class="add-char-card" onclick="openAssetModal()"><div class="plus">+</div><span>Add asset</span></div>'
    : '';
  grid.innerHTML = _addCard + cards;
}

function openAssetModal(assetId) {
  var modal = document.getElementById('asset-modal');
  var title = document.getElementById('asset-modal-title');
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var descEl = document.getElementById('asset-description');
  var fileEl = document.getElementById('asset-image');
  var errEl = document.getElementById('asset-modal-error');
  if (errEl) errEl.classList.add('hidden');
  if (fileEl) fileEl.value = '';
  if (state.assetMetaTimer) { clearTimeout(state.assetMetaTimer); state.assetMetaTimer = null; }

  if (assetId) {
    var a = (state.assets || []).find(function(x) { return x.id === assetId; });
    if (!a) return;
    state.modalAsset = a;
    if (title) title.textContent = 'Edit Asset';
    if (nameEl) nameEl.value = a.name || '';
    if (catEl) catEl.value = a.category || 'location';
    if (descEl) descEl.value = a.description || '';
  } else {
    state.modalAsset = { id: null, name: '', category: 'location', description: '', image_url: null, revert_image_url: null };
    if (title) title.textContent = 'Add Asset';
    if (nameEl) nameEl.value = '';
    if (catEl) catEl.value = 'location';
    if (descEl) descEl.value = '';
  }
  renderAssetModalImage(state.modalAsset);
  if (modal) modal.classList.remove('hidden');
  if (!assetId) { try { maybeStartTour('asset-modal'); } catch (e) {} }
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
// Client-side image-type gate -- mirror of the server whitelist so users are
// stopped at pick/drop time with the SAME message, right by the control used.
function isSupportedUploadImage(file) {
  return !!file && ['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) !== -1;
}
var UPLOAD_TYPE_MSG = 'Please upload a JPG, PNG, or WebP image.';

// Show a small inline error directly beneath an upload slot (drop-<slot>) rather
// than a corner toast. Reused by character portraits AND custom art-style slots.
function showSlotError(slot, msg) {
  var zone = document.getElementById('drop-' + slot);
  if (!zone || !zone.parentNode) { showAlert(msg); return; }
  var el = document.getElementById('slot-err-' + slot);
  if (!el) {
    el = document.createElement('div');
    el.id = 'slot-err-' + slot;
    el.className = 'panel-dark';
    var inner = document.createElement('div');
    inner.className = 'alert alert-error';
    inner.style.cssText = 'margin:6px 0 0;padding:8px 10px;font-size:12px;font-weight:600;text-align:center;';
    el.appendChild(inner);
    zone.parentNode.insertBefore(el, zone.nextSibling);
  }
  el.firstChild.textContent = msg;
  el.style.display = 'block';
  if (el._t) { clearTimeout(el._t); }
  el._t = setTimeout(function() { if (el) { el.style.display = 'none'; } }, 6000);
}
function clearSlotError(slot) {
  var el = document.getElementById('slot-err-' + slot);
  if (el) { el.style.display = 'none'; }
}

function acceptAssetFile(file) {
  if (!file) return;
  if (!isSupportedUploadImage(file)) {
    var errEl = document.getElementById('asset-modal-error');
    if (errEl) { errEl.textContent = UPLOAD_TYPE_MSG; errEl.classList.remove('hidden'); }
    return;
  }
  state.assetPickedFile = file;
  setAssetPreview(URL.createObjectURL(file));
}

function handleAssetFileSelect(e) {
  if (e.target.files && e.target.files[0]) assetUploadFile(e.target.files[0]);
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
  if (state.assetMetaTimer) { clearTimeout(state.assetMetaTimer); state.assetMetaTimer = null; }
  state.modalAsset = null;
}

function assetPickFile() { var f = document.getElementById('asset-image'); if (f) f.click(); }

// Render the asset modal's image area: the image with Retouch/Regenerate/Revert
// pills once one exists, or Generate/Upload actions when it does not. Mirrors the
// character reference section -- the modal stays open and updates in place.
function renderAssetModalImage(asset) {
  var body = document.getElementById('asset-modal-image-body');
  if (!body) return;
  asset = asset || state.modalAsset || {};
  var aid = asset.id;
  var hasImg = !!asset.image_url;
  var hasDesc = !!(asset.description && asset.description.trim());
  if (hasImg) {
    var pills = '';
    if (hasDesc) pills += '<button class="panel-pill" onclick="regenerateAsset(' + aid + ')" title="Re-roll the image from its description">Regenerate</button>';
    pills += '<button class="panel-pill" onclick="openRetouchAsset(' + aid + ')" title="Keep this image and change just one thing">Retouch</button>';
    if (asset.revert_image_url) pills += '<button class="panel-pill" onclick="revertAsset(' + aid + ')" title="Undo the last retouch or regenerate">Revert</button>';
    pills += '<button class="panel-pill" onclick="openReplacePicker(\'asset\', ' + aid + ')" title="Replace with an image from the Archive">Replace</button>';
    body.innerHTML =
      '<div class="char-ref-image" id="asset-modal-imgwrap">' +
        '<div class="char-ref-imgwrap">' +
          '<img src="' + asset.image_url + '" alt="' + (asset.name || 'asset') + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />' +
          '<div class="panel-img-actions">' + pills + '</div>' +
        '</div>' +
      '</div>';
  } else {
    var genBtn = hasDesc
      ? '<button class="btn btn-sm btn-primary" onclick="assetGenerateFromModal()">Generate from description</button>'
      : '<button class="btn btn-sm" onclick="assetGenerateFromModal()" title="Add a description above first">Generate from description</button>';
    body.innerHTML =
      '<div id="asset-modal-imgwrap" style="display:flex;gap:8px;flex-wrap:wrap;">' +
        genBtn +
        '<button class="btn btn-sm" onclick="assetPickFile()">Upload image</button>' +
      '</div>';
  }
}

// Debounced auto-save of name/category/description. Saves only once the asset
// exists; a brand-new asset is created on the first image action.
function scheduleAssetMetaSave() {
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var descEl = document.getElementById('asset-description');
  if (state.modalAsset) {
    state.modalAsset.name = nameEl ? nameEl.value : state.modalAsset.name;
    state.modalAsset.category = catEl ? catEl.value : state.modalAsset.category;
    state.modalAsset.description = descEl ? descEl.value : state.modalAsset.description;
  }
  if (!state.modalAsset || !state.modalAsset.id) return;
  if (state.assetMetaTimer) clearTimeout(state.assetMetaTimer);
  state.assetMetaTimer = setTimeout(saveAssetMeta, 700);
}

function saveAssetMeta() {
  if (!state.modalAsset || !state.modalAsset.id) return;
  var id = state.modalAsset.id;
  var fd = new FormData();
  fd.append('name', state.modalAsset.name || '');
  fd.append('category', state.modalAsset.category || 'location');
  fd.append('description', state.modalAsset.description || '');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + id, { method: 'PUT', body: fd })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && !data.error) {
        state.assets = (state.assets || []).map(function(x){ return String(x.id) === String(id) ? data : x; });
        renderAssets();
        _syncReviewAsset('upsert', data);
        if (state.modalAsset && String(state.modalAsset.id) === String(id)) { state.modalAsset = data; renderAssetModalImage(data); }
      }
    })
    .catch(function(){});
}

// Generate an image from the description. Auto-creates the asset if new (POST
// /generate), else re-rolls (POST /:id/regenerate). Modal stays open.
function assetGenerateFromModal() {
  var errEl = document.getElementById('asset-modal-error');
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var descEl = document.getElementById('asset-description');
  var name = nameEl ? nameEl.value.trim() : '';
  var category = catEl ? catEl.value : 'location';
  var description = descEl ? descEl.value.trim() : '';
  if (errEl) errEl.classList.add('hidden');
  if (!name) { if (errEl) { errEl.textContent = 'Give the asset a name first.'; errEl.classList.remove('hidden'); } return; }
  if (!description) { if (errEl) { errEl.textContent = 'Add a description to generate an image.'; errEl.classList.remove('hidden'); } return; }
  showBusyOverlay('asset-modal-image-body', 'Generating', 'Creating your image...');
  var existingId = state.modalAsset && state.modalAsset.id;
  var url, opts;
  if (existingId) {
    url = '/api/campaigns/' + state.currentCampaign.id + '/assets/' + existingId + '/regenerate';
    opts = { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fal_key: getFalKey() || 'platform' }) };
  } else {
    url = '/api/campaigns/' + state.currentCampaign.id + '/assets/generate';
    opts = { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: name, category: category, description: description }) };
  }
  fetch(url, opts)
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.error) {
        hideBusyOverlay('asset-modal-image-body');
        if (errEl) { errEl.textContent = data.message || data.error; errEl.classList.remove('hidden'); }
        return;
      }
      if (data.asset) state.modalAsset = data.asset;
      var jobId = data.image_job_id || data.job_id;
      var targetId = state.modalAsset ? state.modalAsset.id : (data.asset && data.asset.id);
      if (jobId) {
        pollRefJob(jobId, function(u){ reloadAndRenderModalAsset(targetId); if (typeof refreshTokenBalance === 'function') refreshTokenBalance(); }, function(err){ hideBusyOverlay('asset-modal-image-body'); if (errEl) { errEl.textContent = 'Could not generate: ' + err; errEl.classList.remove('hidden'); } });
      } else {
        hideBusyOverlay('asset-modal-image-body');
        reloadAndRenderModalAsset(targetId);
      }
    })
    .catch(function(){ hideBusyOverlay('asset-modal-image-body'); if (errEl) { errEl.textContent = 'Could not start generation.'; errEl.classList.remove('hidden'); } });
}

// Upload an image as the asset image. Auto-creates the asset if new, else
// replaces the image on the existing asset. Modal stays open.
function assetUploadFile(file) {
  var errEl = document.getElementById('asset-modal-error');
  if (!isSupportedUploadImage(file)) { if (errEl) { errEl.textContent = UPLOAD_TYPE_MSG; errEl.classList.remove('hidden'); } return; }
  var nameEl = document.getElementById('asset-name');
  var catEl = document.getElementById('asset-category');
  var descEl = document.getElementById('asset-description');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) { if (errEl) { errEl.textContent = 'Give the asset a name first.'; errEl.classList.remove('hidden'); } return; }
  if (errEl) errEl.classList.add('hidden');
  if (state.assetMetaTimer) { clearTimeout(state.assetMetaTimer); state.assetMetaTimer = null; }
  showBusyOverlay('asset-modal-image-body', 'Uploading', 'Saving your image...');
  var fd = new FormData();
  fd.append('name', name);
  fd.append('category', catEl ? catEl.value : 'location');
  fd.append('description', descEl ? descEl.value : '');
  fd.append('image', file);
  var existingId = state.modalAsset && state.modalAsset.id;
  var url = '/api/campaigns/' + state.currentCampaign.id + '/assets' + (existingId ? '/' + existingId : '');
  var method = existingId ? 'PUT' : 'POST';
  fetch(url, { method: method, body: fd })
    .then(function(r){ return r.json(); })
    .then(function(data){
      hideBusyOverlay('asset-modal-image-body');
      if (data && data.error) { if (errEl) { errEl.textContent = data.error; errEl.classList.remove('hidden'); } return; }
      state.modalAsset = data;
      var found = false;
      state.assets = (state.assets || []).map(function(x){ if (String(x.id) === String(data.id)) { found = true; return data; } return x; });
      if (!found) state.assets.push(data);
      renderAssets();
      renderAssetModalImage(data);
      _syncReviewAsset('upsert', data);
    })
    .catch(function(){ hideBusyOverlay('asset-modal-image-body'); if (errEl) { errEl.textContent = 'Could not upload the image.'; errEl.classList.remove('hidden'); } });
}

// Reload assets and, if the modal is open on this asset, re-render its image
// area in place so retouch/regenerate/revert update the modal without closing.
function reloadAndRenderModalAsset(assetId) {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets')
    .then(function(r){ return r.json(); })
    .then(function(data){
      state.assets = Array.isArray(data) ? data : [];
      renderAssets();
      var a = state.assets.find(function(x){ return String(x.id) === String(assetId); });
      if (a) _syncReviewAsset('upsert', a);
      if (a && state.modalAsset && String(state.modalAsset.id) === String(assetId)) { state.modalAsset = a; renderAssetModalImage(a); }
    })
    .catch(function(){});
}

// TF-08: keep the cached review/storyboard asset picker list
// (state.reviewData.all_assets) in sync with asset create/edit/delete, so a newly
// added asset shows up in the "+ Add asset" picker without reloading the review payload.
function _syncReviewAsset(action, asset) {
  if (!state.reviewData || !Array.isArray(state.reviewData.all_assets)) return;
  if (!asset || asset.id == null) return;
  var list = state.reviewData.all_assets;
  var i = -1;
  for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(asset.id)) { i = k; break; } }
  if (action === 'remove') { if (i >= 0) list.splice(i, 1); return; }
  var entry = { id: asset.id, name: asset.name, category: asset.category, image_url: asset.image_url };
  if (i >= 0) list[i] = entry; else list.push(entry);
}

async function deleteAsset(assetId) {
  if (!await uiConfirm('Delete this asset? This cannot be undone.')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + assetId, { method: 'DELETE' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) { alert(data.error); return; }
      loadAssets();
      _syncReviewAsset('remove', { id: assetId });   // TF-08
    })
    .catch(function() { alert('Could not delete the asset.'); });
}


// Empty-session hint: nudge the user to create characters first, but only when
// THIS campaign has none. Fetched fresh (state.characters can be stale from a
// previously-opened campaign). Safe no-op if the hint element isn't present.
function maybeShowNoCharacterHint() {
  if (!state.currentCampaign || !state.currentCampaign.id) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var arr = Array.isArray(data) ? data : [];
      if (arr.length === 0) {
        var h = document.getElementById('no-char-session-hint');
        if (h) h.style.display = 'block';
      }
    })
    .catch(function() {});
}

// One-time "no characters yet" nudge before Generate Story. Fires at most
// once per browser session for a given (user, session): stories read and
// illustrate better when characters exist first. Non-blocking -- returns true
// to proceed, false only if the user chooses to stop and add characters.
// Fails open on any error so a hiccup never blocks generation.
async function warnIfNoCharacters() {
  try {
    if (!state.currentCampaign || !state.currentCampaign.id) return true;
    var _uid = (state.user && state.user.id) || 'anon';
    var _sid = (state.currentSession && state.currentSession.id) || 'nosess';
    var _flagKey = 'chr_nochar_warn_' + _uid + '_' + _sid;
    if (sessionStorage.getItem(_flagKey)) return true;
    var resp = await fetch('/api/campaigns/' + state.currentCampaign.id + '/characters');
    var data = await resp.json();
    var arr = Array.isArray(data) ? data : [];
    if (arr.length > 0) return true;
    sessionStorage.setItem(_flagKey, '1');
    return await uiConfirm(
      'This campaign does not have any characters yet. Stories turn out better ' +
      'when your characters are built first -- they appear more consistently in ' +
      'the narrative and images. You can add characters first, or generate the ' +
      'story now and add them later.\n\nGenerate the story now?');
  } catch (e) {
    return true;
  }
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
            (char.revert_reference_url ? '<button class="panel-pill" onclick="revertCharRef(' + char.id + ')" title="Undo the last retouch or regenerate - restore the previous reference">Revert</button>' : '') +
            '<button class="panel-pill" onclick="openReplacePicker(\'canonical\', ' + char.id + ')" title="Replace with an image from the Archive">Replace</button>' +
            '<button class="panel-pill' + (_carched ? ' is-on' : '') + '" id="char-archive-' + char.id + '" onclick="toggleArchiveCharCanonical(' + char.id + ')" title="' + (_carched ? 'In your Archive — click to remove' : 'Save this reference image to your Archive') + '">' + (_carched ? 'Archived' : 'Archive') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    : '<div class="char-ref-image" id="char-ref-image-' + char.id + '"></div>';

  body.innerHTML = inner + '<div class="char-prompt-actions">' + buttons + '</div>' + refImg;
}

function rebuildCharPrompt(charId) {
  if (isCharGenBusy(charId)) return;   // TF-09: don't re-enter while generating
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
  setCharGenBusy(charId);   // TF-09
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
          pollRefJob(data.image_job_id, function(url){ applyCanonicalRef(charId, url); }, function(){ hideBusyOverlay(refTargetId); clearCharGenBusy(charId); });
        } else { clearCharGenBusy(charId); }   // TF-09: no async image job, unlock now
      } else {
        // Refusal / failure — remove the overlay so the existing image
        // (if any) is fully visible again, and show the error.
        hideBusyOverlay(refTargetId);
        clearCharGenBusy(charId);   // TF-09
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
      clearCharGenBusy(charId);   // TF-09
      if (textEl) textEl.textContent = 'Could not build the prompt.';
      if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rebuild prompt'; }
    });
}

// Re-roll the canonical reference IMAGE from the existing prompt (option A:
// no prompt rewrite). The moment "Regenerate" pill, applied to a character.
function regenCharRef(charId) {
  if (!ensureGenFree()) return;
  if (isCharGenBusy(charId)) return;
  setCharGenBusy(charId);   // TF-09
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
        clearCharGenBusy(charId);   // TF-09
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
          clearCharGenBusy(charId);   // TF-09
          alert(err === 'INSUFFICIENT_TOKENS' ? 'You are out of tokens.' : 'Could not regenerate the reference image.');
        });
        return;
      }
      hideBusyOverlay(refTargetId);
      clearCharGenBusy(charId);   // TF-09
      alert('Could not regenerate the reference image.');
    })
    .catch(function(e){ hideBusyOverlay(refTargetId); clearCharGenBusy(charId); alert('Could not regenerate the reference image: ' + e.message); });
}

// Open the shared Retouch modal targeting a CHARACTER reference (vs a moment).
function openRetouchChar(charId) {
  state.retouchCharId = charId;
  state.retouchMomentId = null;
  state.retouchSessionCharId = null;
  state.retouchAssetId = null;
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
  state.retouchAssetId = null;
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
  if (!ensureGenFree()) return;
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

// Character Name may hold slash-separated aliases ("Superman / Clark Kent /
// Clark"). First token is the canonical display name; the rest are a.k.a. names
// the AI matches in prose. Mirrors the asset alias convention.
function charDisplayName(name) {
  var parts = String(name == null ? '' : name).split('/').map(function(t){ return t.trim(); }).filter(function(t){ return t.length; });
  return parts.length ? parts[0] : String(name == null ? '' : name).trim();
}
function charAkaNames(name) {
  return String(name == null ? '' : name).split('/').map(function(t){ return t.trim(); }).filter(function(t){ return t.length; }).slice(1);
}

function renderCharacters() {
  var colors = ['#EEEDFE','#E1F5EE','#FAECE7','#E6F1FB','#FAEEDA'];
  var fgs = ['#534AB7','#0F6E56','#993C1D','#185FA5','#854F0B'];
  var html = state.characters.map(function(c, i) {
    var initials = charDisplayName(c.name).split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + charDisplayName(c.name) + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
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
      '<div class="char-name">' + escapeHtml(charDisplayName(c.name)) + '</div>' +
      (charAkaNames(c.name).length ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">a.k.a. ' + escapeHtml(charAkaNames(c.name).join(', ')) + '</div>' : '') +
      ownerBadge +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      charDescHtml(c.description) +
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
  (function(){ var _sb = document.getElementById('char-save-btn'); if (_sb) _sb.textContent = editId ? 'Done' : 'Create character'; })();
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
  (function(){ var _cse = document.getElementById('char-save-error'); if (_cse) _cse.classList.add('hidden'); })();
  document.getElementById('char-modal').classList.remove('hidden');
  // Always open scrolled to the top -- a freshly opened modal should never start at
  // the bottom (reset now and next frame, after any late content layout).
  (function(){
    var _reset = function(){ var _m = document.getElementById('char-modal'); if (!_m) return; _m.scrollTop = 0; var _mi = _m.querySelector('.modal'); if (_mi) _mi.scrollTop = 0; };
    _reset();
    if (window.requestAnimationFrame) requestAnimationFrame(_reset);
  })();
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  if (window.requestAnimationFrame) { requestAnimationFrame(function(){ try { maybeStartTour('characters'); } catch (e) {} }); }
  else { try { maybeStartTour('characters'); } catch (e) {} }
}

function closeCharModal() {
  try {
    var editId = (document.getElementById('char-edit-id') || {}).value || '';
    var nameEl = document.getElementById('char-name');
    var name = nameEl ? nameEl.value.trim() : '';
    if (editId && name && !(typeof isCharGenBusy === 'function' && isCharGenBusy(editId))) {
      var fd = new FormData();
      fd.append('name', name);
      fd.append('player_name', document.getElementById('char-player').value.trim());
      fd.append('cls', document.getElementById('char-cls').value.trim() || 'Adventurer');
      fd.append('description', document.getElementById('char-desc').value.trim());
      var npcEl = document.getElementById('char-is-npc');
      fd.append('is_npc', (npcEl && npcEl.checked) ? 'true' : 'false');
      fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + editId, { method: 'PUT', body: fd })
        .then(function(){ loadCharacters(); }).catch(function(){});
    }
  } catch (e) {}
  document.getElementById('char-modal').classList.add('hidden');
}

function previewCharImage() {
  var input = document.getElementById('char-image-input');
  var preview = document.getElementById('char-image-preview');
  if (input.files && input.files[0]) {
    var reader = new FileReader();
    reader.onload = function(e) { preview.src = e.target.result; preview.style.display = 'block'; };
    reader.readAsDataURL(input.files[0]);
  }
}

// TF-09: per-character generation lock. While a character's reference image is
// generating (Build prompt / Regenerate / Retouch in flight), block Save and
// re-entry into generation for that character so edits can't race the result.
function isCharGenBusy(charId){ return !!(state.charGenBusy && state.charGenBusy[String(charId)]); }
function setCharGenBusy(charId){ state.charGenBusy = state.charGenBusy || {}; state.charGenBusy[String(charId)] = true; _reflectCharSaveLock(charId, true); }
function clearCharGenBusy(charId){ if (state.charGenBusy) delete state.charGenBusy[String(charId)]; _reflectCharSaveLock(charId, false); }
// Visually disable the open character modal's Save button while that character
// is generating; the click-time guard in saveChar is the correctness backstop.
function _reflectCharSaveLock(charId, busy){
  var idEl = document.getElementById('char-edit-id');
  if (!idEl || String(idEl.value) !== String(charId)) return;
  var btn = document.getElementById('char-save-btn');
  if (!btn) return;
  if (busy) { btn.disabled = true; btn.title = 'Generating the reference image\u2026 please wait'; }
  else { btn.disabled = false; btn.title = ''; }
}
// TF-16: render the character-modal save error next to the Save button. When the
// error is the per-campaign character cap, include a See plans upgrade button.
function showCharSaveError(msg, withPlans) {
  var el = document.getElementById('char-save-error');
  if (!el) return;
  el.textContent = '';
  var span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
  if (withPlans) {
    var wrap = document.createElement('div'); wrap.style.marginTop = '10px';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-primary btn-sm';
    b.textContent = 'See plans';
    b.addEventListener('click', function(){ closeCharModal(); goToPlans(); });
    wrap.appendChild(b); el.appendChild(wrap);
  }
  el.classList.remove('hidden');
}
function charModalPrimary() {
  // saveChar() handles BOTH new and edit: it builds the PUT with editId and
  // appends every selected slot file (and clear_ flags), then closes + reloads.
  // The old edit path (closeCharModal) sent only metadata, silently dropping
  // any picked portrait/action/etc. image on edit.
  saveChar();
}

function saveChar() {
  (function(){ var _e = document.getElementById('char-save-error'); if (_e) _e.classList.add('hidden'); })();
  var name = document.getElementById('char-name').value.trim();
  var player = document.getElementById('char-player').value.trim();
  var cls = document.getElementById('char-cls').value.trim();
  var desc = document.getElementById('char-desc').value.trim();
  var editId = document.getElementById('char-edit-id').value;
  if (!name) { showCharSaveError('Character name is required.'); return; }
  if (editId && isCharGenBusy(editId)) {
    showCharSaveError('This character\u2019s reference image is still generating. Please wait for it to finish before saving.');
    return;
  }

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
      if (data.error) { showCharSaveError(data.error, data.code === 'CHARACTER_LIMIT'); return; }

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
        (function(){ var _sb = document.getElementById('char-save-btn'); if (_sb) _sb.textContent = 'Done'; })();
        showCharPromptNudge();
        return;
      }

      document.getElementById('char-modal').classList.add('hidden');
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
    'background:rgba(15,110,86,0.15);border:1px solid rgba(15,110,86,0.4);color:#0a4a38;font-weight:500;';
  nudge.innerHTML = '&#10003; Character saved. Now build its character prompt below \u2014 ' +
    'this is what keeps the character looking consistent across your panels. ' +
    'You can close this window when you\u2019re done.';
  body.parentNode.insertBefore(nudge, body);
}

async function deleteChar(id) {
  var char = state.characters.find(function(c){return c.id===id;});
  if (!await uiConfirm('Delete ' + (char ? char.name : 'this character') + '?')) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + id, {method:'DELETE'})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.error) {
        if (typeof showAlert === 'function') { showAlert(data.error); } else { alert(data.error); }
        return;
      }
      loadCharacters();
    })
    .catch(function(e) {
      var m = 'Delete failed: ' + (e && e.message ? e.message : 'network error');
      if (typeof showAlert === 'function') { showAlert(m); } else { alert(m); }
    });
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
  _fitPreviewMobile('session-preview-iframe', typeof sessionPreviewMode !== 'undefined' && sessionPreviewMode !== 'wysiwyg');
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

// Async Generate Story: poll the extraction job until done/error. Resolves to the job
// result ({moments, pendingChanges, ...}) or an {error,message} object, so the existing
// success handler consumes it exactly like the old synchronous response did.
function _pollExtractJob(jobId, signal) {
  return new Promise(function (resolve) {
    var tries = 0;
    (function loop() {
      if (signal && signal.aborted) { resolve({ error: 'aborted', message: 'Generation cancelled.' }); return; }
      fetch('/api/extract/job/' + jobId, { signal: signal })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.status === 'done') { resolve(j); return; }
          if (j && (j.status === 'error' || j.error)) { resolve({ error: j.error || 'generation_failed', message: j.error || 'Story generation failed.' }); return; }
          tries++;
          if (tries > 300) { resolve({ error: 'timeout', message: 'Generation is taking longer than expected -- please check back in a moment.' }); return; }
          setTimeout(loop, 2000);
        })
        .catch(function () {
          if (signal && signal.aborted) { resolve({ error: 'aborted', message: 'Generation cancelled.' }); return; }
          tries++;
          if (tries > 300) { resolve({ error: 'poll_failed', message: 'Lost connection while generating.' }); return; }
          setTimeout(loop, 2000);
        });
    })();
  });
}

async function extractMoments() {
  if (!ensureGenFree()) return;
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

  // No-character nudge: one-time reminder that stories read and illustrate
  // better when characters exist first. Non-blocking; proceeds if the user OKs.
  if (!await warnIfNoCharacters()) return;

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!await uiConfirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // All pre-flight prompts passed -- claim the session-wide lock now (not
  // before the confirms above, so cancelling any prompt can never strand it).
  setGenLock('Generate Story');

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
  .then(function(start) {
    if (start && start.error) return start;
    if (!start || !start.job_id) return { error: 'no_job', message: 'Could not start story generation. Please try again.' };
    return _pollExtractJob(start.job_id, _xctl.signal);
  })
  .then(function(data) {
    clearInterval(ticker);
    clearGenLock();
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
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
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
    clearGenLock();
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
      if (typeof renderSessionEstablishing === 'function') renderSessionEstablishing(data);
      state.moments = data.moments || [];
      renderStoryboard();
      if (typeof renderNovelWithImages === 'function') renderNovelWithImages();
    })
    .catch(function(){});
}

async function generateAllImages(fromChain) {
  if (!fromChain) { if (!ensureGenFree()) return; }
  setGenLock('Generate Images');
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!await uiConfirm('This will replace all existing panel images that are not locked. Are you sure?')) {
      clearGenLock();
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
      clearGenLock();
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
    clearGenLock();
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
  if (!ensureGenFree()) return;
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
        showPanelError(momentId, 'Could not regenerate: ' + (data.message || data.error));
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
  if (typeof layoutAiCheckStatus === 'function') layoutAiCheckStatus();
  if (tab === 'finalize' && typeof loadFinalize === 'function') { loadFinalize(); }
  if (tab === 'order' && typeof loadPrintTab === 'function') loadPrintTab();
  ['sessions', 'preview', 'finalize', 'order'].forEach(function(t) {
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
    if (typeof refreshStoryStatus === 'function') refreshStoryStatus();
    if (typeof prepPanelSync === 'function') prepPanelSync();
  }
}

function selNovelLayout(el, layout) {
  if (blockLayoutChangeIfOrdering()) return;
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

// "Own view" = the version you may curate/publish: the SM on the canonical book,
// or a member on their own fork. Drives the publish guard and whether the
// Include-in-Print checkboxes are editable.
function novelOwnView() {
  var isSM = !!(state.currentCampaign && state.currentCampaign.my_role === 'dm');
  var myId = (state.user && state.user.id) || null;
  return isSM ? (state.novelAsUser == null)
              : (myId != null && String(state.novelAsUser) === String(myId));
}

// Shared fork-edit permission (session-detail / storyboard / establishing context):
// true when the caller may edit the CURRENTLY-VIEWED fork's images/content -- the SM
// on the canonical version, or a member on their OWN fork. (novelOwnView is the
// parallel rule for the publish/version-picker context.) Canonical helper for the
// reusable image-panel primitive; new code should call this instead of re-deriving.
function canEditFork() {
  var role = state.currentCampaign && state.currentCampaign.my_role;
  if (role === 'dm' && !state.currentForkId) return true;
  return (role === 'player') && !!(state.currentForkId && state.myForkId
    && String(state.currentForkId) === String(state.myForkId));
}
// Player-publish: the version picker is open to everyone for VIEWING. A member
// defaults to their OWN version; the SM defaults to the canonical book. Publishing
// is always your own (enforced server-side); updateNovelPublishGuard keeps the
// Publish button disabled unless you are viewing your own version.
function updateNovelPublishGuard() {
  var btn = document.getElementById('novel-publish-btn');
  if (!btn) return;
  var ownView = novelOwnView();
  var st = document.getElementById('novel-publish-status');
  if (ownView) {
    btn.disabled = false;
    if (st && st.dataset && st.dataset.guard) { st.style.display = 'none'; st.textContent = ''; delete st.dataset.guard; }
  } else {
    btn.disabled = true;
    if (st) { st.style.display = 'block'; st.textContent = 'You can only publish your own version. Switch the version selector back to your own version to publish to the Library.'; if (st.dataset) st.dataset.guard = '1'; }
  }
}
function loadNovelPeople() {
  var sel = document.getElementById('novel-version-select');
  var isSM = !!(state.currentCampaign && state.currentCampaign.my_role === 'dm');
  var myId = (state.user && state.user.id) || null;
  // Set the data driver synchronously so loadNovelSummary (called right after)
  // uses the correct version before the picker options finish loading.
  state.novelAsUser = isSM ? null : (myId != null ? String(myId) : null);
  updateNovelPublishGuard();
  if (!sel) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/novel/people')
    .then(function(r) { return r.ok ? r.json() : []; })
    .then(function(rows) {
      rows = Array.isArray(rows) ? rows : [];
      var opts = '<option value="">Story Master \u2014 Canonical</option>';
      var myAdded = false;
      rows.forEach(function(p) {
        var hasV = (p.has_version === true || p.has_version === 1 || p.has_version === '1' || p.has_version === 't');
        if (p.role === 'player' && hasV) {
          var mine = (myId != null && String(p.user_id) === String(myId));
          var label = mine ? 'Your version' : ((p.name || p.email || 'Player') + '\u2019s version');
          opts += '<option value="' + p.user_id + '">' + label + '</option>';
          if (mine) myAdded = true;
        }
      });
      if (!isSM && myId != null && !myAdded) {
        opts += '<option value="' + myId + '">Your version</option>';
      }
      sel.innerHTML = opts;
      if (isSM) { state.novelAsUser = null; sel.value = ''; }
      else { state.novelAsUser = (myId != null) ? String(myId) : null; sel.value = (myId != null) ? String(myId) : ''; }
      updateNovelPublishGuard();
    })
    .catch(function(){ updateNovelPublishGuard(); });
}

function onNovelVersionChange(val) {
  state.novelAsUser = val || null;
  updateNovelPublishGuard();
  if (typeof prepLoadBookMeta === 'function') prepLoadBookMeta(function(){ if (typeof prepSyncTitle === 'function') prepSyncTitle(); if (typeof renderPrepThumbs === 'function') renderPrepThumbs(); });
  if (typeof syncPrintVersionDisplay === 'function') syncPrintVersionDisplay();
  // Switch to this member's saved look before rendering their book.
  mpLoadAndApply('novel', function(){
    if (typeof novelPreviewPage !== 'undefined') novelPreviewPage = 1;
    loadNovelSummary(function(){
      var prev = document.getElementById('novel-tab-preview');
      if (prev && prev.style.display !== 'none') {
        loadNovelPreview(novelLayoutStyle);
      }
    });
  });
}

// Preview mode toggle: 'quick' = fast on-screen HTML preview for layout checks
// (default); 'wysiwyg' = the exact paged PDF that prints (slower). One mode each
// for the novel and the session preview.
var novelPreviewMode = 'quick';
// ---- Quick View zoom (same-origin HTML preview; True View uses the browser's native PDF zoom) ----
var novelZoom = 1;
try { var _nz0 = localStorage.getItem('novelZoom'); if (_nz0) novelZoom = Math.max(0.4, Math.min(3, parseFloat(_nz0) || 1)); } catch (_e) {}
function applyNovelZoom() {
  var lbl = document.getElementById('novel-zoom-label');
  if (lbl) lbl.textContent = Math.round(novelZoom * 100) + '%';
  if (typeof novelPreviewMode !== 'undefined' && novelPreviewMode !== 'quick') return;
  try { var iframe = document.getElementById('novel-preview-iframe'); var doc = iframe && iframe.contentDocument; if (doc && doc.body) doc.body.style.zoom = novelZoom; } catch (_e) {}
}
function setNovelZoom(z) {
  novelZoom = Math.max(0.4, Math.min(3, z));
  try { localStorage.setItem('novelZoom', String(novelZoom)); } catch (_e) {}
  applyNovelZoom();
}
function novelZoomStep(delta) { setNovelZoom(Math.round((novelZoom + delta) * 100) / 100); }
function novelZoomFit() {
  try {
    var iframe = document.getElementById('novel-preview-iframe');
    var doc = iframe && iframe.contentDocument;
    if (doc && doc.body) {
      doc.body.style.zoom = 1;
      var natural = Math.max(doc.body.scrollWidth || 0, doc.documentElement.scrollWidth || 0);
      var avail = (iframe.clientWidth || 0) - 4;
      if (natural > 0 && avail > 0) { setNovelZoom(avail / natural); return; }
    }
  } catch (_e) {}
  applyNovelZoom();
}
function novelZoomWheel(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (typeof novelPreviewMode !== 'undefined' && novelPreviewMode !== 'quick') return;
  e.preventDefault();
  novelZoomStep(e.deltaY < 0 ? 0.1 : -0.1);
}
function novelZoomSyncCtrl() {
  var zc = document.getElementById('novel-zoom-ctrl');
  if (zc) zc.style.display = (typeof novelPreviewMode !== 'undefined' && novelPreviewMode === 'quick') ? 'inline-flex' : 'none';
}
function toggleNovelPreviewMode() {
  novelPreviewMode = (novelPreviewMode === 'quick') ? 'wysiwyg' : 'quick';
  var btn = document.getElementById('novel-preview-mode-btn');
  if (btn) btn.textContent = (novelPreviewMode === 'wysiwyg') ? 'True View' : 'Quick View';
  novelZoomSyncCtrl();
  if (typeof loadNovelPreview === 'function') loadNovelPreview(novelLayoutStyle);
}
var sessionPreviewMode = 'quick';
function toggleSessionPreviewMode() {
  sessionPreviewMode = (sessionPreviewMode === 'quick') ? 'wysiwyg' : 'quick';
  var btn = document.getElementById('session-preview-mode-btn');
  if (btn) btn.textContent = (sessionPreviewMode === 'wysiwyg') ? 'True View' : 'Quick View';
  if (typeof loadPreview === 'function') loadPreview(state.layoutStyle || 'Classic');
}

function clearFinalizePanes() {
  ['finalize-before-scroll', 'finalize-after-scroll'].forEach(function (id) { var el = document.getElementById(id); if (el) el.innerHTML = ''; });
  var _o = document.getElementById('layoutai-results'); if (_o) _o.innerHTML = '';
  var _f = document.getElementById('layoutai-free'); if (_f) _f.innerHTML = '';
  try { if (typeof loadFinalize !== 'undefined') loadFinalize._lastUrl = null; } catch (e) {}
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
  var _ptEl = document.getElementById('prep-title');
  if (_ptEl && _ptEl.value && _ptEl.value.trim()) url += '&bookTitle=' + encodeURIComponent(_ptEl.value.trim());
  var _tcEl = document.getElementById('print-title-color');
  if (_tcEl && _tcEl.value) url += '&titleColor=' + encodeURIComponent(_tcEl.value);
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
    applyNovelZoom();
    try { var _zd = iframe.contentDocument; if (_zd) _zd.addEventListener('wheel', novelZoomWheel, { passive: false }); } catch (_e) {}
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
  _fitPreviewMobile('novel-preview-iframe', typeof novelPreviewMode !== 'undefined' && novelPreviewMode !== 'wysiwyg');
  var _ph = '75vh';
  if (window.innerWidth > 900) {
    var _prep = document.querySelector('.novel-prep-panel');
    if (_prep && _prep.offsetHeight > 0) {
      var _h = _prep.offsetHeight;
      if (_h < 520) _h = 520;
      _ph = _h + 'px';
    }
  }
  if (iframe) iframe.style.height = _ph;
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

// --- Publish to Public Library (Stories) -------------------------------------
// Owner-only on the server; here we just drive the button. We send the SAME
// layout + custom options the preview is showing so the published book matches.
// Pre-Publish Prep panel: seed the title + reflect the chosen cover/back/title images.
var PREP_IMG_KINDS = {
  cover: { label: 'Choose a Cover image', field: 'cover_image_url' },
  back:  { label: 'Choose a Back Cover image', field: 'back_cover_image_url' },
  title: { label: 'Choose a Title image', field: 'title_image_url' }
};
// First-publish convenience: if this campaign has a Campaign image but no
// explicit publish Cover yet, seed the Cover with the Campaign image so it is
// already in place when the user opens publish prep. The fields stay
// independent afterward -- the user can change or clear the Cover freely, and
// changing the Campaign image later does not alter an already-chosen Cover.
function prepSeedCoverFromCampaignImage() {
  var c = state.currentCampaign;
  if (!c || c.cover_image_url || !c.campaign_image_url) return;
  var url = c.campaign_image_url;
  var prev = c.cover_image_url || '';
  c.cover_image_url = url;
  var i = state.campaigns.findIndex(function(x){ return x.id === c.id; });
  if (i >= 0) state.campaigns[i].cover_image_url = url;
  fetch('/api/campaigns/' + c.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_image_url: url })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data && data.id) {
      c.cover_image_url = data.cover_image_url || '';
      if (i >= 0) state.campaigns[i].cover_image_url = data.cover_image_url || '';
    } else {
      c.cover_image_url = prev;
      if (i >= 0) state.campaigns[i].cover_image_url = prev;
    }
    renderPrepThumbs();
  })
  .catch(function(){
    c.cover_image_url = prev;
    if (i >= 0) state.campaigns[i].cover_image_url = prev;
    renderPrepThumbs();
  });
}

// Title field tracks the viewed fork; editable only on your own version. The
// owner's typed title is stashed while peeking at another fork and restored.
function prepSyncTitle() {
  var tEl = document.getElementById('prep-title'); if (!tEl) return;
  var own = (typeof novelOwnView === 'function') ? novelOwnView() : true;
  if (own) {
    tEl.readOnly = false;
    if (state._prepOwnTitle != null) { tEl.value = state._prepOwnTitle; state._prepOwnTitle = null; }
    if (!tEl.value) {
      tEl.value = (state.bookMeta && state.bookMeta.book_title)
        ? state.bookMeta.book_title
        : ((state.currentCampaign && state.currentCampaign.name) ? state.currentCampaign.name : '');
    }
  } else {
    if (state._prepOwnTitle == null) state._prepOwnTitle = tEl.value || '';
    tEl.value = (state.bookMeta && state.bookMeta.book_title)
      ? state.bookMeta.book_title
      : ((state.currentCampaign && state.currentCampaign.name) ? state.currentCampaign.name : '');
    tEl.readOnly = true;
  }
  var _cEl = document.getElementById('print-title-color');
  if (_cEl) _cEl.value = (state.bookMeta && state.bookMeta.title_color) ? state.bookMeta.title_color : '#f0d98a';
}
// Persist the title color per user (campaign + user) via /my-book-meta, mirroring the title text.
function prepSaveTitleColor() {
  var el = document.getElementById('print-title-color');
  if (!el || !state.currentCampaign) return;
  if (typeof prepUseMember === 'function' && prepUseMember()) {
    // Per-fork (SM canonical or member), written to the logged-in user's own row.
    var _tcB = { title_color: el.value }; if (state.novelAsUser) _tcB.fork_user = state.novelAsUser;
    fetch('/api/campaigns/' + state.currentCampaign.id + '/my-book-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_tcB) }).catch(function(){});
  }
}
function prepPanelSync() {
  prepLoadBookMeta(function(){
    var isSM = !!(state.currentCampaign && state.currentCampaign.my_role === 'dm');
    if (isSM && !state.novelAsUser) prepSeedCoverFromCampaignImage();
    prepSyncTitle();
    renderPrepThumbs();
  });
  _prepEnsureArchives();
}
// Per-member book images (Phase 2b): a member on their own fork edits their own
// cover/back/title via /my-book-meta; the SM edits the campaign images as before.
function prepUseMember() {
  // True whenever the viewer may edit the currently-shown book: their own fork (SM
  // canonical or member own), OR the SM curating a member's fork into the SM overlay.
  if (typeof novelOwnView === 'function' && novelOwnView()) return true;
  var isSM = !!(state.currentCampaign && state.currentCampaign.my_role === 'dm');
  return isSM && !!state.novelAsUser;
}
function _prepCampaignMeta() {
  var c = state.currentCampaign || {};
  return { cover_image_url: c.campaign_image_url || '', back_cover_image_url: '', title_image_url: '', book_title: '', title_color: '' };
}
// Load book-meta for the CURRENTLY VIEWED fork. Canonical (null) reads the live
// campaign in renderPrepThumbs; a fork view fetches that fork's effective meta so
// the SM and other members see the member's own cover/back/title selections.
function prepLoadBookMeta(cb) {
  var c = state.currentCampaign;
  var forkUser = state.novelAsUser || (state.user && state.user.id);
  if (!c || !forkUser) { state.bookMeta = _prepCampaignMeta(); if (cb) cb(); return; }
  fetch('/api/campaigns/' + c.id + '/my-book-meta?as_user=' + encodeURIComponent(forkUser))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(m){ state.bookMeta = m || _prepCampaignMeta(); applyCampaignLayoutOpts(m); finalizeClearStats(); if (cb) cb(); })
    .catch(function(){ state.bookMeta = _prepCampaignMeta(); finalizeClearStats(); if (cb) cb(); });
}
function _prepMemberSetImage(kind, url) {
  var c = state.currentCampaign; if (!c) return;
  var field = PREP_IMG_KINDS[kind].field;
  var body = {}; body[field] = url; if (state.novelAsUser) body.fork_user = state.novelAsUser;
  fetch('/api/campaigns/' + c.id + '/my-book-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(m){ state.bookMeta = m || state.bookMeta || {}; renderPrepThumbs(); showAlert(url ? 'Your book image set.' : 'Reverted to the campaign image.'); })
    .catch(function(){ showAlert('Could not update your book image.'); });
}
function renderPrepThumbs() {
  var c = state.currentCampaign; if (!c) return;
  ['cover','back','title'].forEach(function(kind){
    var el = document.getElementById('prep-thumb-' + kind); if (!el) return;
    var _f = PREP_IMG_KINDS[kind].field;
    var url = ((state.bookMeta || {})[_f]) || '';
    if (url) { el.style.backgroundImage = 'url("' + encodeURI(url) + '")'; el.classList.add('has-img'); el.innerHTML = ''; }
    else { el.style.backgroundImage = ''; el.classList.remove('has-img'); el.innerHTML = '<span class="prep-thumb-plus">+</span>'; }
  });
}
function _prepEnsureArchives(cb) {
  var _cid = state.currentCampaign && state.currentCampaign.id;
  if (state.archives && state.archives.length && state.archivesCid === _cid) { if (cb) cb(); return; }
  if (!state.currentCampaign) { if (cb) cb(); return; }
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(rows){ state.archives = Array.isArray(rows) ? rows : []; state.archivesCid = state.currentCampaign && state.currentCampaign.id; if (cb) cb(); })
    .catch(function(){ state.archives = state.archives || []; if (cb) cb(); });
}
function openPrepImagePicker(kind) {
  var cfg = PREP_IMG_KINDS[kind]; if (!cfg || !state.currentCampaign) return;
  if (!(typeof prepUseMember === 'function' && prepUseMember())) { showAlert('Switch to your own version to change the cover, back, or title image.'); return; }
  _prepEnsureArchives(function(){
    closePrepImagePicker();
    var c = state.currentCampaign;
    var curUrl = ((state.bookMeta || {})[cfg.field]) || '';
    var rows = (state.archives || []).filter(function(a){ return a && a.image_url; });
    var overlay = document.createElement('div');
    overlay.id = 'prep-img-modal'; overlay.className = 'prep-img-modal';
    overlay.addEventListener('click', function(e){ if (e.target === overlay) closePrepImagePicker(); });
    var box = document.createElement('div'); box.className = 'prep-img-modal-box';
    var head = document.createElement('div'); head.className = 'prep-img-modal-head';
    var h = document.createElement('div'); h.className = 'prep-img-modal-title'; h.textContent = cfg.label;
    var x = document.createElement('button'); x.type = 'button'; x.className = 'prep-img-modal-x'; x.innerHTML = '&times;';
    x.addEventListener('click', closePrepImagePicker);
    head.appendChild(h); head.appendChild(x);
    var grid = document.createElement('div'); grid.className = 'prep-img-grid';
    if (!rows.length) {
      var empty = document.createElement('div'); empty.className = 'prep-img-empty';
      empty.textContent = 'No archived images yet. Lock or archive images from the Storyboard, then choose one here.';
      grid.appendChild(empty);
    } else {
      rows.forEach(function(a){
        var btn = document.createElement('button'); btn.type = 'button';
        btn.className = 'prep-img-pick' + (a.image_url === curUrl ? ' selected' : '');
        btn.style.backgroundImage = 'url("' + encodeURI(a.image_url) + '")';
        if (a.title) btn.title = a.title;
        btn.addEventListener('click', function(){ selectPrepImage(kind, a.id); });
        grid.appendChild(btn);
      });
    }
    box.appendChild(head); box.appendChild(grid);
    if (curUrl) {
      var foot = document.createElement('div'); foot.className = 'prep-img-modal-foot';
      foot.textContent = 'Tip: click the highlighted image to remove it.';
      box.appendChild(foot);
    }
    overlay.appendChild(box); document.body.appendChild(overlay);
  });
}
function selectPrepImage(kind, archiveId) {
  closePrepImagePicker();
  if (prepUseMember()) {
    var a = (state.archives || []).find(function(x){ return x.id === archiveId; });
    if (!a) return;
    var field = PREP_IMG_KINDS[kind].field;
    var cur = (state.bookMeta && state.bookMeta[field]) || '';
    _prepMemberSetImage(kind, (cur === a.image_url) ? '' : a.image_url);
    return;
  }
  var cb = function(){ renderPrepThumbs(); };
  if (kind === 'cover') setCampaignCover(archiveId, cb);
  else if (kind === 'back') setCampaignBackCover(archiveId, cb);
  else if (kind === 'title') setCampaignTitleImage(archiveId, cb);
}
function closePrepImagePicker() {
  var m = document.getElementById('prep-img-modal');
  if (m && m.parentNode) m.parentNode.removeChild(m);
}
// Refresh button: sync the title to the Order tab, then re-render the preview
// with the current title + image picks (one trigger for both).
function refreshNovelPreview() {
  var tEl = document.getElementById('prep-title');
  var title = tEl ? tEl.value.trim() : '';
  var pt = document.getElementById('print-book-title');
  if (pt && title) pt.value = title;
  if (typeof loadNovelPreview === 'function') loadNovelPreview(novelLayoutStyle);
}

async function publishStory() {
  if (!state.currentCampaign || !state.currentCampaign.id) return;
  if (state.user && state.user.tier === 'trial') {
    var _go = await uiConfirm('You need to sign up to publish to the library. Publishing is available once you are on a paid plan.', { okText: 'See plans', cancelText: 'Not now' });
    if (_go) goToPlans();
    return;
  }
  var tEl = document.getElementById('prep-title');
  var bEl = document.getElementById('prep-blurb');
  var aEl = document.getElementById('prep-attest');
  var _title = tEl ? tEl.value.trim() : '';
  if (prepUseMember() && _title) { var _btB = { book_title: _title }; if (state.novelAsUser) _btB.fork_user = state.novelAsUser; fetch('/api/campaigns/' + state.currentCampaign.id + '/my-book-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_btB) }).catch(function(){}); }
  var _blurb = bEl ? bEl.value.trim() : '';
  var _attested = aEl ? !!aEl.checked : false;
  var btn = document.getElementById('novel-publish-btn');
  var st = document.getElementById('novel-publish-status');
  if (!_attested) { if (st) { st.style.display = 'block'; st.textContent = 'Please confirm you own the rights and the content is suitable before publishing.'; } return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing...'; }
  if (st) { st.style.display = 'block'; st.textContent = 'Rendering and publishing your book... this can take a moment.'; }
  var url = '/api/pdf/publish-story/' + state.currentCampaign.id + '?layout=' + encodeURIComponent(novelLayoutStyle) + customOptsQ('novel','&');
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: _title, blurb: _blurb, attested: _attested }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (btn) btn.disabled = false;
      if (d && d.success) {
        if (st) st.textContent = d.author ? ('Published a new entry to the Library, listed as ' + d.author + '.') : 'Published a new entry to the Library. You have no pen name set, so it is listed without a name.';
        setStoryPublishedUI(true, d.url);
        var _pt = document.getElementById('print-book-title'); if (_pt && _title) _pt.value = _title;
      } else if (d && d.code === 'publish_requires_subscription') {
        if (btn) btn.textContent = 'Publish to Library';
        if (st) st.style.display = 'none';
        uiConfirm('Publishing to the Library requires a paid plan, or playing in a campaign run by a subscriber.', { okText: 'See plans', cancelText: 'Not now' }).then(function(go){ if (go) goToPlans(); });
      } else {
        if (st) st.textContent = (d && (d.message || d.error)) ? (d.message || d.error) : 'Could not publish. Please try again.';
        if (btn) btn.textContent = 'Publish to Library';
      }
    })
    .catch(function(){
      if (btn) { btn.disabled = false; btn.textContent = 'Publish to Library'; }
      if (st) st.textContent = 'Could not publish. Please try again.';
    });
}

async function unpublishStory() {
  if (!state.currentCampaign || !state.currentCampaign.id) return;
  if (!await uiConfirm('Remove your story from the public Library?')) return;
  var btn = document.getElementById('novel-publish-btn');
  var st = document.getElementById('novel-publish-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  fetch('/api/pdf/unpublish-story/' + state.currentCampaign.id, { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (btn) btn.disabled = false;
      if (d && d.success) {
        setStoryPublishedUI(false);
        if (st) { st.style.display = 'block'; st.textContent = 'Removed from the Library.'; }
      } else {
        if (btn) btn.textContent = 'Unpublish from Library';
        if (st) st.textContent = (d && d.error) || 'Could not remove.';
      }
    })
    .catch(function(){ if (btn) { btn.disabled = false; btn.textContent = 'Unpublish from Library'; } if (st) st.textContent = 'Could not remove.'; });
}

function setStoryPublishedUI(published, url) {
  var btn = document.getElementById('novel-publish-btn');
  if (!btn) return;
  // Publishing/unpublishing is managed on the Account page, not here. This button
  // always (re)publishes the current content; it never flips to an unpublish toggle.
  btn.textContent = 'Publish to Library';
  btn.onclick = publishStory;
}

function refreshStoryStatus() {
  var btn = document.getElementById('novel-publish-btn');
  var st = document.getElementById('novel-publish-status');
  if (st) { st.style.display = 'none'; st.textContent = ''; }
  if (!btn || !state.currentCampaign || !state.currentCampaign.id) return;
  setStoryPublishedUI(false);
  fetch('/api/pdf/story-status/' + state.currentCampaign.id)
    .then(function(r){ return r.json(); })
    .then(function(d){ if (d && d.published && st) { st.style.display = 'block'; st.textContent = 'You have already published from this campaign. Each Publish creates a new Library entry. Manage or remove your entries on your Account page.'; } })
    .catch(function(){});
}

function loadNovelSummary(cb) {
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
      if (typeof cb === 'function') cb();
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
  var html = '<div class="session-card-grid">' + sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var thumbSrc = s.title_image || s.establishing_image || s.first_image_url;
    var thumb = thumbSrc
      ? '<img class="session-card-img" src="' + thumbSrc + '" loading="lazy" alt="" />'
      : '<div class="session-card-img session-card-img-empty">&#128213;</div>';
    var forkLabel = s.is_canonical
      ? "Story Master's Version"
      : (s.fork_owner_name ? (s.fork_owner_name + "'s Version") : "Your Version");
    var includeChk = '<label class="session-card-include"><input type="checkbox" ' + (novelIncluded(s) ? 'checked' : '') + (novelOwnView() ? '' : ' disabled title="You can only change which sessions are included on your own version"') + ' onchange="toggleNovelInclude(' + s.id + ', this.checked)"> Include in Print</label>';
    return '<div class="session-card session-card-publish">' +
      thumb +
      '<div class="session-card-body">' +
        '<div class="session-card-title">Session ' + (i+1) + ' — ' + s.name + '</div>' +
        '<div class="session-card-date">' + formatSessionDate(s.session_date) + '</div>' +
        '<div class="session-card-fork">' + forkLabel + '</div>' +
        '<div class="session-card-pills">' +
          '<span class="session-badge' + (moments.length ? '' : ' empty') + '">' + moments.length + ' panels</span>' +
          '<span class="session-badge' + (s.fork_status === 'ready' ? '' : ' session-badge-draft') + '">' + (s.fork_status === 'ready' ? 'Ready' : 'Draft') + '</span>' +
        '</div>' +
        '<div class="session-card-actions">' +
          includeChk +
          '<a onclick="goToSessionPage(' + s.id + ')" class="session-card-open">Open</a>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

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
  // Admin general-tab settings must load when the settings view is shown
  // (and on refresh), not only on a tab-button click via switchSettingsTab.
  loadPrintMarkup(); loadSignupBonus(); loadMaxPagesPerPrint(); loadLifecycleConfig(); loadHelpEmailSettings(); loadGenerationSettings();
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
  var pen_name = document.getElementById('settings-penname').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email, pen_name:pen_name})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    state.user.penName = pen_name;
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
  var confirmEl = document.getElementById('settings-confirm-password');
  var confirmpw = confirmEl ? confirmEl.value : newpw;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }
  if (newpw !== confirmpw) { showSettingsError('password-error', 'New password and confirmation do not match.'); return; }

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
    if (confirmEl) confirmEl.value = '';
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
  if (!isSupportedUploadImage(files[0])) { showSlotError(slot, UPLOAD_TYPE_MSG); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    if (!isSupportedUploadImage(e.target.files[0])) { showSlotError(slot, UPLOAD_TYPE_MSG); e.target.value = ''; return; }
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  clearSlotError(slot);
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
    if (!isSupportedUploadImage(file)) {
      showAlert(UPLOAD_TYPE_MSG);
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
  if (!ensureGenFree()) return;
  setGenLock('Generate Narrative');
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
    clearGenLock();
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
    clearGenLock();
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
function updateArchivesCount() {
  var el = document.getElementById('archives-count');
  if (!el) return;
  var n = (state.archives || []).length;
  el.textContent = n ? (' \u00b7 ' + n + (n === 1 ? ' archived image' : ' archived images')) : '';
}
function loadArchives() {
  var grid = document.getElementById('archives-grid');
  if (grid) grid.innerHTML = '<div class="muted" style="padding:20px;">Loading…</div>';
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(data){ state.archives = Array.isArray(data) ? data : []; state.archivesCid = state.currentCampaign && state.currentCampaign.id; updateArchivesCount(); renderArchives(); })
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
  if (key === 'moment') { renderArchiveGrid(); } else { renderArchives(); }
}

function getFilteredArchives(f) {
  f = f || state.archiveFilters || {};
  var rows = (state.archives || []).slice();
  if (f.session) rows = rows.filter(function(a){ return String(a.session_id) === String(f.session); });
  if (f.moment) { var _mq = String(f.moment).toLowerCase(); rows = rows.filter(function(a){ return (archiveMomentLabel(a) || '').toLowerCase().indexOf(_mq) !== -1; }); }
  if (f.creator) rows = rows.filter(function(a){ return String(a.archived_by) === String(f.creator); });
  if (f.type) rows = rows.filter(function(a){ return a.image_type === f.type; });
  if (f.style) rows = rows.filter(function(a){ return String(a.art_style) === String(f.style); });
  if (f.version) rows = rows.filter(function(a){ return archiveVersionLabel(a) === f.version; });
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
    if (a.art_style) styles[a.art_style] = artStyleLabel(a.art_style, a.art_style_name);
    var _vl = archiveVersionLabel(a); if (_vl) versions[_vl] = _vl;
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
    '<input type="text" class="archive-filter archive-filter-search" placeholder="Search moments" value="' + escapeHtml(f.moment || '') + '" oninput="setArchiveFilter(\'moment\', this.value)" />' +
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
    state.archivesCid = cid;
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
    if (a.art_style) styles[a.art_style] = artStyleLabel(a.art_style, a.art_style_name);
    var _vl = archiveVersionLabel(a); if (_vl) versions[_vl] = _vl;
    if (a.character_id && a.character_name) characters[a.character_id] = a.character_name;
  });
  function opts(map, sel) {
    return Object.keys(map).map(function(k){
      return '<option value="' + escapeHtml(k) + '"' + (String(sel) === String(k) ? ' selected' : '') + '>' + escapeHtml(map[k]) + '</option>';
    }).join('');
  }
  return '<select class="archive-filter" onchange="' + onchange + '(\'session\', this.value)"><option value="">All sessions</option>' + opts(sessions, f.session) + '</select>' +
    '<select class="archive-filter" onchange="' + onchange + '(\'version\', this.value)"><option value="">All versions</option>' + opts(versions, f.version) + '</select>' +
    '<input type="text" class="archive-filter archive-filter-search" placeholder="Moment Name" value="' + escapeHtml(f.moment || '') + '" oninput="' + onchange + '(\'moment\', this.value)" />' +
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
  state.retouchAssetId = null;
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

// Open the shared Retouch modal targeting an ASSET image.
function openRetouchAsset(assetId) {
  state.retouchAssetId = assetId;
  state.retouchCharId = null;
  state.retouchMomentId = null;
  state.retouchSessionCharId = null;
  var ta = document.getElementById('retouch-instruction');
  if (ta) ta.value = '';
  var modal = document.getElementById('retouch-modal');
  if (modal) modal.classList.remove('hidden');
  if (ta) setTimeout(function(){ ta.focus(); }, 30);
}

// Regenerate an asset image from its stored description (re-roll). Arms revert.
function regenerateAsset(assetId) {
  if (!state.currentCampaign) return;
  showBusyOverlay('asset-modal-image-body', 'Generating', 'Re-rolling your image...');
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + assetId + '/regenerate', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ fal_key: getFalKey() || 'platform' })
  })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (data && data.job_id) {
        pollRefJob(data.job_id, function(url){ reloadAndRenderModalAsset(assetId); if (typeof refreshTokenBalance === 'function') refreshTokenBalance(); }, function(err){ hideBusyOverlay('asset-modal-image-body'); alert('Could not regenerate: ' + err); });
        return;
      }
      hideBusyOverlay('asset-modal-image-body');
      if (data && data.error === 'INSUFFICIENT_TOKENS') { alert(data.message || 'You are out of tokens.'); }
      else { alert((data && (data.message || data.error)) || 'Could not regenerate the asset.'); }
    })
    .catch(function(e){ hideBusyOverlay('asset-modal-image-body'); alert('Could not regenerate: ' + e.message); });
}

// One-step undo of the last asset retouch/regenerate. Free (no token spend).
function revertAsset(assetId) {
  if (!state.currentCampaign) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + assetId + '/revert', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || d.error) { alert((d && (d.message || d.error)) || 'Could not revert.'); return; }
      reloadAndRenderModalAsset(assetId);
    })
    .catch(function(){ alert('Could not revert the asset.'); });
}

function submitRetouch() {
  if (!ensureGenFree()) return;
  var ta = document.getElementById('retouch-instruction');
  var instruction = ta ? ta.value.trim() : '';
  if (!instruction) { if (ta) ta.focus(); return; }

  // Asset image target (uploaded, from-archive, or generated). Checked first.
  if (state.retouchAssetId) {
    var _aId = state.retouchAssetId;
    closeRetouch();
    showBusyOverlay('asset-modal-image-body', 'Retouching', 'Applying your change...');
    fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/' + _aId + '/retouch', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ instruction: instruction, fal_key: getFalKey() || 'platform' })
    })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data && data.job_id) {
          pollRefJob(data.job_id, function(url){ reloadAndRenderModalAsset(_aId); if (typeof refreshTokenBalance === 'function') refreshTokenBalance(); }, function(err){ hideBusyOverlay('asset-modal-image-body'); alert('Could not retouch: ' + err); });
          return;
        }
        hideBusyOverlay('asset-modal-image-body');
        if (data && data.error === 'INSUFFICIENT_TOKENS') { alert(data.message || 'You are out of tokens.'); }
        else { alert((data && (data.message || data.error)) || 'Could not retouch the asset.'); }
      })
      .catch(function(e){ hideBusyOverlay('asset-modal-image-body'); alert('Could not retouch: ' + e.message); });
    return;
  }

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
    if (isCharGenBusy(charId)) { showAlert('This character\u2019s reference image is still generating. Please wait, then try again.'); return; }
    setCharGenBusy(charId);   // TF-09
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
            clearCharGenBusy(charId);   // TF-09
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
          clearCharGenBusy(charId);   // TF-09
        } else {
          hideBusyOverlay(refTargetId);
          clearCharGenBusy(charId);   // TF-09
          var textEl = document.getElementById('char-prompt-text-' + charId);
          if (data && data.error === 'INSUFFICIENT_TOKENS') {
            if (textEl) textEl.innerHTML = insufficientTokensHtml(data.message);
            else alert(data.message || 'You are out of tokens.');
          } else {
            alert((data && (data.message || data.error)) || 'Could not retouch the reference image.');
          }
        }
      })
      .catch(function(e){ hideBusyOverlay(refTargetId); clearCharGenBusy(charId); alert('Could not retouch the reference image: ' + e.message); });
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
    if (state.currentForkId) f.version = String(state.currentForkId);
    if (tEl) tEl.textContent = 'Replace panel image from Archive';
  } else if (mode === 'canonical') {
    state.pickerCtx.characterId = id;
    state.pickerCtx.sessionId = null;
    state.pickerCtx.forkId = null;
    f.type = 'character';
    f.character = String(id);
    if (tEl) tEl.textContent = 'Replace character image from Archive';
  } else if (mode === 'establishing') {
    state.pickerCtx.sessionId = id;
    if (tEl) tEl.textContent = 'Replace title image from Archive';
  } else if (mode === 'asset') {
    state.pickerCtx.assetId = id;
    state.pickerCtx.sessionId = null;
    state.pickerCtx.forkId = null;
    if (tEl) tEl.textContent = 'Replace asset image from Archive';
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
  if (key === 'moment') { renderPickerGrid(); } else { renderPicker(); }
}

function clearPickerFilters() {
  state.pickerFilters = { session:'', moment:'', creator:'', type:'', style:'', version:'', character:'', sort:'newest' };
  renderPicker();
}

function renderPicker() {
  var fhost = document.getElementById('replace-picker-filters');
  if (fhost) fhost.innerHTML = archiveFilterBarHTML(state.pickerFilters, 'setPickerFilter') +
    '<button class="archive-filter archive-clear" onclick="clearPickerFilters()">Clear filters</button>';
  renderPickerGrid();
}

function renderPickerGrid() {
  var grid = document.getElementById('replace-picker-grid');
  if (!grid) return;
  var rows = getFilteredArchives(state.pickerFilters);
  if (!rows.length) { grid.innerHTML = '<div class="archive-pick-empty">No archived images match these filters. Widen them to pull from another version, session, or character.</div>'; return; }
  grid.innerHTML = rows.map(function(a){
    var cap = '<b>' + escapeHtml(a.image_type === 'character' ? (a.character_name || 'Character') : (archiveMomentLabel(a) || 'Panel')) + '</b>';
    if (a.session_title) cap += '<br>' + escapeHtml(a.session_title);
    var ver = (!a.fork_id || a.fork_role === 'dm') ? 'Canonical' : ((a.fork_owner_name || 'Player') + "'s version");
    cap += '<br>' + escapeHtml(ver);
    if (a.art_style) cap += '<br>' + escapeHtml(artStyleLabel(a.art_style, a.art_style_name));
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
  } else if (ctx.mode === 'establishing') {
    body = { target_type: 'session_establishing', session_id: ctx.sessionId };
  } else if (ctx.mode === 'asset') {
    body = { target_type: 'asset', target_asset_id: ctx.assetId };
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
    else if (ctx.mode === 'asset') { reloadAndRenderModalAsset(ctx.assetId); }
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
  renderArchiveGrid();
}

function renderArchiveGrid() {
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
    if (a.art_style) meta += '<div class="archive-row"><span>Style</span><b>' + escapeHtml(artStyleLabel(a.art_style, a.art_style_name)) + '</b></div>';
    if (a.character_name) meta += '<div class="archive-row"><span>Character</span><b>' + escapeHtml(a.character_name) + '</b></div>';
    meta += '<div class="archive-row"><span>Archived by</span><b>' + escapeHtml(a.archived_by_name || 'someone') + (when ? ' &middot; ' + when : '') + '</b></div>';
    var promptBtn = a.image_prompt ? '<button class="archive-prompt-btn" onclick="viewArchivePrompt(' + a.id + ')" title="View the prompt for this image">&#128196; View Prompt</button>' : '';
    return '<div class="archive-card">' +
      '<div class="archive-thumb">' +
        '<img loading="lazy" src="' + a.image_url + '" alt="' + escapeHtml(a.title || 'archived image') + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />' +
        promptBtn +
        (isDM ? '<button class="archive-asset-thumb" onclick="openCopyToAssetModal(' + a.id + ')" title="Copy this image to Assets">&#43; Assets</button>' : '') +
        (canDelete ? '<button class="archive-del-thumb" onclick="deleteArchive(' + a.id + ')" title="Remove from Archive">&#10005; Remove</button>' : '') +
      '</div>' +
      '<div class="archive-meta">' +
        '<div class="archive-title">' + escapeHtml(a.title || '(untitled)') + '</div>' +
        meta +
        '<div class="archive-actions">' +
          (canDelete ? '<label class="archive-cover-toggle" title="Show this image in the public Library, credited to your pen name"><input type="checkbox" ' + (a.public ? 'checked' : '') + ' onchange="setArchivePublic(' + a.id + ', this.checked)" /> Public</label>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function setArchivePublic(id, makePublic) {
  fetch('/api/campaigns/' + state.currentCampaign.id + '/archives/' + id + '/public', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public: !!makePublic })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.error) { showAlert(d.error); renderArchives(); return; }
    var a = (state.archives || []).find(function (x) { return x.id === id; });
    if (a) a.public = !!makePublic;
  }).catch(function () { showAlert('Could not update the Public setting.'); renderArchives(); });
}

// ---- Admin: Public Library moderation modal ----
var adminLib = { cursor: 0, loading: false, done: false, any: false };
var adminStories = { cursor: 0, loading: false, done: false, any: false };
function openAdminLibrary() {
  var m = document.getElementById('admin-library-modal');
  if (m) m.classList.remove('hidden');
  var grid = document.getElementById('admin-library-grid');
  if (grid) grid.innerHTML = '';
  adminLib = { cursor: 0, loading: false, done: false, any: false };
  if (grid && !grid._scrollBound) {
    grid._scrollBound = true;
    grid.addEventListener('scroll', function () {
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) loadAdminLibrary();
    });
  }
  loadAdminLibrary();
}
function closeAdminLibrary() {
  var m = document.getElementById('admin-library-modal');
  if (m) m.classList.add('hidden');
}
function loadAdminLibrary() {
  if (adminLib.loading || adminLib.done) return;
  adminLib.loading = true;
  var st = document.getElementById('admin-library-status');
  if (st) st.textContent = 'Loading...';
  var url = '/api/admin/library?limit=48' + (adminLib.cursor ? '&beforeId=' + adminLib.cursor : '');
  fetch(url).then(function (r) { return r.json(); }).then(function (d) {
    adminLib.loading = false;
    var grid = document.getElementById('admin-library-grid');
    var items = (d && d.items) || [];
    items.forEach(function (it) { adminLib.any = true; if (grid) grid.appendChild(adminLibCard(it)); });
    if (d && d.nextCursor) adminLib.cursor = d.nextCursor;
    if (!d || !d.hasMore || !d.nextCursor) {
      adminLib.done = true;
      if (st) st.textContent = adminLib.any ? 'End of list.' : 'Nothing has been shared to the public Library yet.';
    } else if (st) { st.textContent = ''; }
  }).catch(function () {
    adminLib.loading = false;
    if (st) st.textContent = 'Could not load. Please try again.';
  });
}
function adminLibCard(it) {
  var card = document.createElement('div');
  card.style.cssText = 'border:1px solid rgba(201,168,76,0.2);border-radius:8px;overflow:hidden;background:rgba(12,8,4,0.5);display:flex;flex-direction:column;';
  var img = document.createElement('img');
  img.setAttribute('loading', 'lazy');
  img.src = it.image_url;
  img.alt = it.caption || 'shared image';
  img.style.cssText = 'width:100%;height:auto;display:block;background:#160e06;cursor:zoom-in;';
  img.onclick = function () { openLightbox(it.image_url, it.caption); };
  card.appendChild(img);
  if (it.caption) {
    var cap = document.createElement('div');
    cap.textContent = it.caption;
    cap.style.cssText = 'font-size:12px;font-style:italic;color:rgba(240,232,208,0.75);padding:6px 8px;';
    card.appendChild(cap);
  }
  var btn = document.createElement('button');
  btn.className = 'btn btn-sm archive-del';
  btn.textContent = 'Remove from Library';
  btn.style.cssText = 'margin:6px 8px 8px;';
  btn.onclick = function () { adminUnpublish(it.id, card, btn); };
  card.appendChild(btn);
  return card;
}
function adminUnpublish(id, card, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  fetch('/api/admin/library/' + id + '/unpublish', { method: 'POST' })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) { if (card && card.parentNode) card.parentNode.removeChild(card); }
      else { if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; } showAlert((d && d.error) || 'Could not remove.'); }
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; } showAlert('Could not remove.'); });
}

function openAdminStories() {
  var m = document.getElementById('admin-stories-modal');
  if (m) m.classList.remove('hidden');
  var grid = document.getElementById('admin-stories-grid');
  if (grid) grid.innerHTML = '';
  adminStories = { cursor: 0, loading: false, done: false, any: false };
  if (grid && !grid._scrollBound) {
    grid._scrollBound = true;
    grid.addEventListener('scroll', function () {
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) loadAdminStories();
    });
  }
  loadAdminStories();
}
function closeAdminStories() {
  var m = document.getElementById('admin-stories-modal');
  if (m) m.classList.add('hidden');
}
function loadAdminStories() {
  if (adminStories.loading || adminStories.done) return;
  adminStories.loading = true;
  var st = document.getElementById('admin-stories-status');
  if (st) st.textContent = 'Loading...';
  var url = '/api/admin/stories?limit=48' + (adminStories.cursor ? '&beforeId=' + adminStories.cursor : '');
  fetch(url).then(function (r) { return r.json(); }).then(function (d) {
    adminStories.loading = false;
    var grid = document.getElementById('admin-stories-grid');
    var items = (d && d.items) || [];
    items.forEach(function (it) { adminStories.any = true; if (grid) grid.appendChild(adminStoryCard(it)); });
    if (d && d.nextCursor) adminStories.cursor = d.nextCursor;
    if (!d || !d.hasMore || !d.nextCursor) {
      adminStories.done = true;
      if (st) st.textContent = adminStories.any ? 'End of list.' : 'No stories have been published yet.';
    } else if (st) { st.textContent = ''; }
  }).catch(function () {
    adminStories.loading = false;
    if (st) st.textContent = 'Could not load. Please try again.';
  });
}
function adminStoryCard(it) {
  var card = document.createElement('div');
  card.style.cssText = 'border:1px solid rgba(201,168,76,0.2);border-radius:8px;overflow:hidden;background:rgba(12,8,4,0.5);display:flex;flex-direction:column;';
  var a = document.createElement('a');
  a.href = it.pdf_url; a.target = '_blank'; a.rel = 'noopener'; a.style.cssText = 'display:block;text-decoration:none;';
  if (it.cover_url) {
    var img = document.createElement('img');
    img.setAttribute('loading', 'lazy'); img.src = it.cover_url; img.alt = it.title || 'story';
    img.style.cssText = 'width:100%;aspect-ratio:17/22;object-fit:cover;display:block;background:#160e06;';
    a.appendChild(img);
  } else {
    var ph = document.createElement('div'); ph.textContent = it.title || 'Untitled';
    ph.style.cssText = 'width:100%;aspect-ratio:17/22;display:flex;align-items:center;justify-content:center;background:#160e06;color:rgba(201,168,76,0.45);font-size:12px;text-align:center;padding:8px;';
    a.appendChild(ph);
  }
  card.appendChild(a);
  var meta = document.createElement('div');
  meta.style.cssText = 'font-size:12px;color:rgba(240,232,208,0.8);padding:6px 8px;';
  meta.textContent = (it.title || 'Untitled') + (it.author ? (' by ' + it.author) : '');
  card.appendChild(meta);
  var btn = document.createElement('button');
  btn.className = 'btn btn-sm archive-del'; btn.textContent = 'Remove from Library'; btn.style.cssText = 'margin:6px 8px 8px;';
  btn.onclick = function () { adminUnpublishStory(it.id, card, btn); };
  card.appendChild(btn);
  return card;
}
function adminUnpublishStory(id, card, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Removing...'; }
  fetch('/api/admin/stories/' + id + '/unpublish', { method: 'POST' })
    .then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) { if (card && card.parentNode) card.parentNode.removeChild(card); }
      else { if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; } showAlert((d && d.error) || 'Could not remove.'); }
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Remove from Library'; } showAlert('Could not remove.'); });
}
// --- Copy an archived image into the campaign's Assets (DM-only). ------------
// Opens a small modal for Name + Type, then posts to the from-archive route
// which gives the new asset its OWN copy of the image (independent of the
// archived original, so deleting one never affects the other).
var _caArchiveId = null;
function openCopyToAssetModal(archiveId) {
  _caArchiveId = archiveId;
  var a = (state.archives || []).find(function(x){ return x.id === archiveId; });
  var nameEl = document.getElementById('ca-name');
  var catEl = document.getElementById('ca-category');
  var errEl = document.getElementById('ca-error');
  if (errEl) errEl.classList.add('hidden');
  if (nameEl) nameEl.value = (a && a.title) ? a.title : '';
  if (catEl) catEl.value = 'location';
  var m = document.getElementById('copy-asset-modal');
  if (m) m.classList.remove('hidden');
  if (nameEl) setTimeout(function(){ nameEl.focus(); nameEl.select(); }, 0);
}
function closeCopyToAssetModal() {
  var m = document.getElementById('copy-asset-modal');
  if (m) m.classList.add('hidden');
  _caArchiveId = null;
}
function submitCopyToAsset() {
  var nameEl = document.getElementById('ca-name');
  var catEl = document.getElementById('ca-category');
  var errEl = document.getElementById('ca-error');
  var saveBtn = document.getElementById('ca-save-btn');
  var name = nameEl ? nameEl.value.trim() : '';
  if (!name) {
    if (errEl) { errEl.textContent = 'Asset name is required.'; errEl.classList.remove('hidden'); }
    return;
  }
  if (!_caArchiveId || !state.currentCampaign) { closeCopyToAssetModal(); return; }
  if (saveBtn) saveBtn.disabled = true;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/assets/from-archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archive_id: _caArchiveId, name: name, category: catEl ? catEl.value : 'location' })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (saveBtn) saveBtn.disabled = false;
    if (data && data.error) {
      if (errEl) { errEl.textContent = data.error; errEl.classList.remove('hidden'); }
      return;
    }
    closeCopyToAssetModal();
    showAlert('Copied to Assets.');
    if (typeof loadAssets === 'function' && document.getElementById('asset-grid')) loadAssets();
    _syncReviewAsset('upsert', data);   // TF-08
  })
  .catch(function(){
    if (saveBtn) saveBtn.disabled = false;
    if (errEl) { errEl.textContent = 'Could not copy this image to Assets.'; errEl.classList.remove('hidden'); }
  });
}

async function deleteArchive(id) {
  if (!await uiConfirm('Remove this image from the campaign Archive? This permanently deletes the saved copy.')) return;
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
  var promptVal = moment ? (moment.prompt || '') : '';
  if (!moment && state.reviewData && Array.isArray(state.reviewData.panels)) {
    var _rp = state.reviewData.panels.find(function(p) { return p.moment_id === momentId; });
    if (_rp) promptVal = _rp.prompt || '';
  }
  var ta = document.getElementById('image-prompt-text');
  if (ta) ta.value = promptVal;
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
        var _rvp = document.getElementById('session-tab-review');
        if (_rvp && _rvp.style.display !== 'none' && typeof loadReview === 'function') loadReview();
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

  function buildPanel(m, i, pNum) {
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
      lockBtn = '<button class="panel-pill pp-lock' + (m.locked ? ' is-on' : '') + '" onclick="toggleMomentLock(' + m.id + ')" title="' + (m.locked ? 'Locked - click to unlock (Regenerate All skips it)' : 'Lock this image (Regenerate All skips it)') + '">' + (m.locked ? 'Unlock' : 'Lock') + '</button>';
    } else if (m.locked) {
      lockBtn = '<span class="panel-pill pp-lock is-on is-static" title="Locked by the version owner">Locked</span>';
    }
    var regenBtn = m.locked
      ? '<button class="panel-pill pp-regen dm-only" disabled title="Unlock to regenerate">Regenerate</button>'
      : '<button class="panel-pill pp-regen dm-only" onclick="regenImage(' + m.id + ', ' + i + ')" title="Regenerate this image from scratch">Regenerate</button>';
    var editPromptBtn = m.locked
      ? '<button class="panel-pill pp-edit dm-only" disabled title="Unlock to edit the prompt">Edit prompt</button>'
      : '<button class="panel-pill pp-edit dm-only" onclick="openImagePrompt(' + m.id + ')" title="Edit the image prompt, then Regenerate to apply">Edit prompt</button>';
    var retouchBtn = m.locked
      ? '<button class="panel-pill pp-retouch dm-only" disabled title="Unlock to retouch">Retouch</button>'
      : '<button class="panel-pill pp-retouch dm-only" onclick="openRetouch(' + m.id + ')" title="Keep this image and change just one thing">Retouch</button>';
    var revertBtn = (m.revert_image && !m.locked)
      ? '<button class="panel-pill dm-only" onclick="revertMoment(' + m.id + ')" title="Undo the last retouch or regenerate - restore the previous image">Revert</button>'
      : '';
    var replaceBtn = m.locked
      ? '<button class="panel-pill pp-replace dm-only" disabled title="Unlock to replace">Replace</button>'
      : '<button class="panel-pill pp-replace dm-only" onclick="openReplacePicker(\'moment\', ' + m.id + ')" title="Replace with an image from the Archive">Replace</button>';
    var archiveBtn = '';
    if (m.image) {
      var _arched = isMomentArchived(m);
      archiveBtn = '<button class="panel-pill pp-archive' + (_arched ? ' is-on' : '') +
        '" onclick="toggleArchiveMoment(' + m.id + ')" title="' +
        (_arched ? 'In your Archive - click to remove' : 'Save this image to your Archive') +
        '">' + (_arched ? 'Archived' : 'Archive') + '</button>';
    }
    var optsBtn = '<button class="moment-opts-btn" onclick="toggleMomentOptions(' + m.id + ')" title="Cast &amp; prominence for this panel">&#8230;</button>';
    var msection = (narrative.sections || []).find(function(s){ return s.panel_index === i; }) || {};
    return '<div class="storyboard-panel' + (m.kind === 'establishing' ? ' is-opening' : '') + '" id="moment-card-' + m.id + '">' +
      '<div class="storyboard-panel-img">' +
        imgHtml + '<div class="panel-img-actions">' + editPromptBtn + regenBtn + retouchBtn + revertBtn + replaceBtn + lockBtn + archiveBtn + '</div>' +
      '</div>' +
      '<div class="storyboard-panel-meta">' +
        '<span class="moment-num">' + (m.kind === 'establishing' ? 'Opening' : ('Panel ' + pNum)) + '</span>' +
        '<span class="moment-title">' + m.title + '</span>' +
        '<span class="moment-meta-list">' + escapeHtml(m.style ? artStyleLabel(m.style) : 'Unknown') + ', ' + (m.type ? ((typeLabel[m.type]||m.type) + ', ') : '') + (_shapeVal.charAt(0).toUpperCase() + _shapeVal.slice(1)) + '</span>' +
        optsBtn +
      '</div>' +
      '<div class="moment-options" id="moment-options-' + m.id + '" style="display:none;"></div>' +
      (m.kind === 'establishing' ? buildNarrative('narrative-opening', 'Opening', 'narrative-intro-box', 'Opening paragraph...', narrative.intro, "regenNarrativeSection('opening')", true) : buildNarrative('narrative-moment-' + i, 'Panel ' + pNum + ' moment', 'narrative-moment-box-' + i, 'Narrate what this panel shows...', msection.before || '', "regenNarrativeSection('moment'," + i + ")", true)) +
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
  var _hasEst = state.moments.some(function(m){ return m.kind === 'establishing'; });
  if (!_hasEst) cells.push(buildNarrative('narrative-opening', 'Opening', 'narrative-intro-box',
    'Opening paragraph...', narrative.intro, 'regenNarrativeSection(\'opening\')', true));

  // Alternate panels and between-narratives
  var _pNum = 0;
  state.moments.forEach(function(m, i) {
    if (m.kind === 'establishing') { cells.push(buildPanel(m, i, 0)); return; }
    _pNum++;
    cells.push(buildPanel(m, i, _pNum));
    if (i < state.moments.length - 1) {
      var section = (narrative.sections||[]).find(function(s){return s.panel_index===i;}) || {};
      cells.push(buildNarrative(
        'narrative-between-' + i,
        'Panel ' + _pNum + ' → ' + (_pNum + 1),
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

// Fill the storyboard's narrative textareas in place from a finished narrative,
// WITHOUT re-rendering the board (so in-flight image spinners are untouched).
// Mirrors renderStoryboard's per-panel section lookup (panel_index === i).
function fillStoryboardProse(narr) {
  narr = narr || state.narrativeData || {};
  var secs = narr.sections || [];
  var setBox = function(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
  setBox('narrative-intro-box', narr.intro);
  setBox('narrative-outro-box', narr.outro);
  (state.moments || []).forEach(function(m, i) {
    if (m.kind === 'establishing') return;
    var sec = secs.find(function(x){ return x.panel_index === i; }) || {};
    setBox('narrative-moment-box-' + i, sec.before);
    setBox('narrative-between-box-' + i, sec.after);
  });
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
      maybeShowReactivatedWelcome(data);   // TF-05 (C): greet a just-reactivated account
      maybeStartCheckout();   // post-verification: auto-start a chosen paid plan's checkout
      // Free Trial badge in the top bar -- driven by the ACTUAL tier (tier === 'trial'),
      // i.e. the state where the trial caps apply. If this badge is hidden, the trial
      // caps are NOT in effect for this account regardless of any watermark/trial window.
      var trialBadge = document.getElementById('trial-badge');
      if (trialBadge) {
        if (data.tier === 'trial') {
          var tbDays = document.getElementById('trial-badge-days');
          if (tbDays) tbDays.textContent = (typeof data.trialDaysLeft === 'number') ? (data.trialDaysLeft + 'd left') : '';
          trialBadge.style.display = 'inline-flex';
        } else {
          trialBadge.style.display = 'none';
        }
      }
      // Lone-copper pill: copper account with no paid Story Master coverage.
      var loneBadge = document.getElementById('lone-badge');
      if (loneBadge) loneBadge.style.display = data.loneCopper ? 'inline-flex' : 'none';
      document.getElementById('user-name').textContent = data.name;
      document.getElementById('user-menu-email').textContent = data.email;
      var initials = data.name.split(' ').map(function(w) { return w[0]; }).join('').slice(0,2).toUpperCase();
      document.getElementById('user-avatar').textContent = initials;
      refreshTokenBalance();
      var adminBox = document.getElementById('account-admin-testing');
      if (adminBox) adminBox.style.display = data.is_admin ? 'block' : 'none';
      var libModBox = document.getElementById('admin-library-section');
      if (libModBox) libModBox.style.display = data.is_admin ? 'block' : 'none';
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
  _helpSendTranscriptOnLogout(function() {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function() { window.location.href = '/'; });
  });
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
  var views = ['campaigns','sessions','characters','assets','novel','session-detail','account','settings','members','archives','orders','custom-styles','feedback'];
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
  } else if (view === 'feedback') {
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Feedback'}
    ]);
    if (typeof resetFeedbackForm === 'function') resetFeedbackForm();
  } else if (view === 'orders') {
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'My Print Orders'}
    ]);
    loadOrders();
  } else if (view === 'settings') {
    var _ss=document.getElementById('snav-settings'); if(_ss)_ss.classList.add('active');
    var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='none';
    setBreadcrumb([
      {label:'My Campaigns', action:"showView('campaigns')"},
      {label:'Settings'}
    ]);
    loadSettingsForm();
  }
  try { if (typeof maybeStartTour === 'function') maybeStartTour(view); } catch (e) {}
  try { _navRecord(view); } catch (e) {}
}

function showCampaignSection(section) {
  if (section === 'assets' || section === 'archives') { var _cur = _visibleViewId(); if (_cur && _cur !== 'assets' && _cur !== 'archives') _sectionBackFrom = _cur; }
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
  if (section === 'novel') { if (typeof resetPublishForCampaignSwitch === 'function') resetPublishForCampaignSwitch(); loadNovelPeople(); loadNovelSummary(); }
  if (section === 'assets') loadAssets();
  if (section === 'archives') loadArchives();
  if (section === 'members') loadMembersTab();

  // Phase 3 — apply role-based visibility (hide DM-only UI for players).
  applyRoleVisibility();
  // Fire the per-section guided tour (characters fires from its create modal instead).
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  try { maybeStartTour(section === 'characters' ? 'char-grid' : section); } catch (e) {}
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
      ((c.campaign_image_url || c.cover_image_url)
        ? '<img class="campaign-card-img" src="' + encodeURI(c.campaign_image_url || c.cover_image_url) + '" alt="" loading="lazy" />'
        : '<div class="campaign-card-img campaign-card-img-empty"><img src="/images/Campaignia_Logo.png" alt="" /></div>') +
      '<div class="campaign-card-body">' +
        '<div class="campaign-card-name">' + c.name + '</div>' +
        campCardDescHtml(c.description) +
        '<div class="campaign-card-footer">' +
          '<div class="campaign-card-meta">Created ' + new Date(c.created_at).toLocaleDateString() + '</div>' +
          (c.my_role === 'dm' ? '<button class="campaign-details-btn" onclick="openCampaignSettings(' + c.id + ', event)" title="Campaign details">Details</button>' : '') +
        '</div>' +
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
  if (state.currentCampaign && typeof loadCampaignLayoutOpts === 'function') loadCampaignLayoutOpts();   // layout options follow the campaign, pulled fresh from the DB
}

function selectCampaign(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  setCampaignElements();
  showCampaignSection('sessions');
}

function selectCampaignNovel(id) {
  state.currentCampaign = state.campaigns.find(function(c) { return c.id === id; });
  if (typeof resetPublishForCampaignSwitch === 'function') resetPublishForCampaignSwitch();
  setCampaignElements();
  var _cs=document.getElementById('campaign-subnav'); if(_cs)_cs.style.display='block';
  var _scn=document.getElementById('sidebar-campaign-name'); if(_scn)_scn.textContent=state.currentCampaign.name;
  showView('campaign-detail');
  showCampaignTab('novel');
}

function openCampaignModal(editId) {
  if (!editId && blockCopperCreate('campaign')) return;
  document.getElementById('campaign-edit-id').value = editId || '';
  document.getElementById('campaign-modal-title').textContent = editId ? 'Edit Campaign' : 'New Campaign';
  document.getElementById('campaign-save-btn').textContent = editId ? 'Save changes' : 'Create campaign';
  document.getElementById('campaign-name').value = editId && state.currentCampaign ? state.currentCampaign.name : '';
  document.getElementById('campaign-desc').value = editId && state.currentCampaign ? (state.currentCampaign.description || '') : '';
  document.getElementById('campaign-lore').value = editId && state.currentCampaign ? (state.currentCampaign.lore || '') : '';
  document.getElementById('campaign-modal-error').classList.add('hidden');
  document.getElementById('campaign-modal').classList.remove('hidden');
}

function closeCampaignModal() { document.getElementById('campaign-modal').classList.add('hidden'); }

function saveCampaign() {
  var name = document.getElementById('campaign-name').value.trim();
  var desc = document.getElementById('campaign-desc').value.trim();
  var lore = (document.getElementById('campaign-lore') || {}).value || '';
  var editId = document.getElementById('campaign-edit-id').value;
  if (!name) { showModalError('campaign-modal-error', 'Campaign name is required.'); return; }

  var url = editId ? '/api/campaigns/' + editId : '/api/campaigns';
  fetch(url, {
    method: editId ? 'PUT' : 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, description:desc, lore:lore})
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
    var _isDM = state.currentCampaign && state.currentCampaign.my_role === 'dm';
    if (!_isDM) {
      list.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><img src="/images/Campaignia_Logo.png" alt="Campaignia" style="width:96px;height:96px;object-fit:contain;vertical-align:middle;" /></div>' +
        '<h3>No sessions ready yet</h3>' +
        '<p>Waiting on the Story Master to ready a session for viewing.</p></div>';
      return;
    }
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon"><img src="/images/Campaignia_Logo.png" alt="Campaignia" style="width:96px;height:96px;object-fit:contain;vertical-align:middle;" /></div>' +
      '<h3>No sessions yet</h3><p>Create your first session to start uploading transcripts and generating storyboards</p>' +
      '<p id="no-char-session-hint" style="display:none;margin-top:-2px;color:#c9a84c;font-size:13px;">It works best if you create your characters before making your session.</p>' +
      '<button class="btn btn-primary" onclick="openSessionModal()">+ New session</button></div>';
    maybeShowNoCharacterHint();
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

  list.innerHTML = '<div class="session-card-grid">' + ordered.map(function(s) {
    var thumbSrc = s.title_image_url || s.establishing_image || s.first_image_url;
    var thumb = thumbSrc
      ? '<img class="session-card-img" src="' + thumbSrc + '" alt="" loading="lazy" />'
      : '<div class="session-card-img session-card-img-empty">&#128203;</div>';
    var readyChip = (s.player_access_status === 'ready')
      ? '<span class="session-badge">Ready</span>'
      : '<span class="session-badge session-badge-draft">Draft</span>';
    var transcriptChip = '';
    var menuId = 'session-menu-' + s.id;
    var deleteMenu =
      '<div class="row-menu dm-only">' +
        '<button class="row-menu-btn" onclick="event.stopPropagation();toggleRowMenu(\'' + menuId + '\', event)">&#8943;</button>' +
        '<div class="row-menu-dropdown" id="' + menuId + '">' +
          '<button class="row-menu-item row-menu-item-danger" onclick="event.stopPropagation();deleteSession(' + s.id + ')">Delete session</button>' +
        '</div>' +
      '</div>';
    return '<div class="session-card" onclick="selectSession(' + s.id + ')">' +
      thumb +
      '<div class="session-card-body">' +
        '<div class="session-card-title">' + s.name + '</div>' +
        '<div class="session-card-date">' + formatSessionDate(s.session_date) + '</div>' +
        '<div class="session-card-meta">' +
          readyChip +
          transcriptChip +
          deleteMenu +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function openSessionModal() {
  if (blockCopperCreate('session')) return;
  document.getElementById('session-name').value = '';
  var _nsd = document.getElementById('session-desc'); if (_nsd) _nsd.value = '';
  document.getElementById('session-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('session-modal-error').classList.add('hidden');
  document.getElementById('session-modal').classList.remove('hidden');
}

function closeSessionModal() { document.getElementById('session-modal').classList.add('hidden'); }

function saveSession() {
  var name = document.getElementById('session-name').value.trim();
  var date = document.getElementById('session-date').value;
  var desc = document.getElementById('session-desc') ? document.getElementById('session-desc').value : '';
  if (!name) { showModalError('session-modal-error', 'Session name is required.'); return; }

  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, session_date:date, description:desc})
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

async function deleteSession(id) {
  if (!await uiConfirm('Delete this session and all its moments? This cannot be undone.')) return;
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
      renderSessionHeaderDisplay();
      renderSessionEstablishing(data);
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
      try { _navRecord('session-detail'); } catch (e) {}

      // Now that view is visible, open the most relevant tab for the session's state:
      // moments + images -> Storyboard; story generated but no images -> Review; else Story (notes).
      var _hasImg = (state.moments || []).some(function (m) { return m && (m.image || m.image_url); });
      var _hasStory = (state.moments && state.moments.length > 0) || (state.narrativeData && state.narrativeData.sections && state.narrativeData.sections.length > 0) || !!(data && data.narrative_intro);
      switchSessionTab((state.moments.length && _hasImg) ? 'storyboard' : (_hasStory ? 'review' : 'notes'));
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
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  try { maybeStartTour('sess-' + tab); } catch (e) {}
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
    var initials = charDisplayName(c.name).split(' ').map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var bg = colors[i % colors.length];
    var fg = fgs[i % fgs.length];
    // Canonical reference image is the preferred thumbnail (Stage 3 Piece 2).
    var refImg = c.canonical_reference_url;
    var primaryImg = refImg || c.image_portrait || c.image_fullbody || c.image_action || c.image_other || c.image;
    var imgPos = refImg ? 'center top' : 'center center';
    var portrait = primaryImg
      ? '<img src="' + primaryImg + '" style="width:100%;height:100%;object-fit:cover;object-position:' + imgPos + ';cursor:zoom-in;" alt="' + charDisplayName(c.name) + '" onclick="openLightbox(this.src,this.alt)" title="Click to enlarge" />'
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
      '<div class="char-name">' + escapeHtml(charDisplayName(c.name)) + '</div>' +
      (charAkaNames(c.name).length ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">a.k.a. ' + escapeHtml(charAkaNames(c.name).join(', ')) + '</div>' : '') +
      ownerBadge +
      (c.player_name ? '<div class="char-player">Played by ' + c.player_name + '</div>' : '') +
      charDescHtml(c.description) +
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
  _fitPreviewMobile('session-preview-iframe', typeof sessionPreviewMode !== 'undefined' && sessionPreviewMode !== 'wysiwyg');
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

async function extractMoments() {
  if (!ensureGenFree()) return;
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

  // No-character nudge: one-time reminder that stories read and illustrate
  // better when characters exist first. Non-blocking; proceeds if the user OKs.
  if (!await warnIfNoCharacters()) return;

  // Warn before overwriting an existing storyboard
  if (state.moments && state.moments.length) {
    if (!await uiConfirm('This session already has a storyboard with ' + state.moments.length +
        ' panel' + (state.moments.length === 1 ? '' : 's') +
        '. Generating again will replace it — existing panels, narrative, and images will be lost. ' +
        'The character snapshots for this session will also be rebuilt. Continue?')) {
      return;
    }
  }

  // All pre-flight prompts passed -- claim the session-wide lock now (not
  // before the confirms above, so cancelling any prompt can never strand it).
  setGenLock('Generate Story');

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
  .then(function(start) {
    if (start && start.error) return start;
    if (!start || !start.job_id) return { error: 'no_job', message: 'Could not start story generation. Please try again.' };
    return _pollExtractJob(start.job_id, _xctl.signal);
  })
  .then(function(data) {
    clearInterval(ticker);
    clearGenLock();
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
    if (typeof refreshTokenBalance === 'function') refreshTokenBalance();
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
    clearGenLock();
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

async function generateAllImages(fromChain) {
  if (!fromChain) { if (!ensureGenFree()) return; }
  setGenLock('Generate Images');
  var falKey = getFalKey() || 'platform';
  document.getElementById('generate-error').classList.add('hidden');

  // Warn if images already exist
  var hasImages = state.moments && state.moments.some(function(m) { return m.image; });
  if (hasImages) {
    if (!await uiConfirm('This will replace all existing panel images that are not locked. Are you sure?')) {
      clearGenLock();
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
      clearGenLock();
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
    clearGenLock();
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
  if (!ensureGenFree()) return;
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
        showPanelError(momentId, 'Could not regenerate: ' + (data.message || data.error));
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
  if (typeof layoutAiCheckStatus === 'function') layoutAiCheckStatus();
  if (tab === 'finalize' && typeof loadFinalize === 'function') { loadFinalize(); }
  if (tab === 'order' && typeof loadPrintTab === 'function') loadPrintTab();
  ['sessions', 'preview', 'finalize', 'order'].forEach(function(t) {
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
    if (typeof refreshStoryStatus === 'function') refreshStoryStatus();
    if (typeof prepPanelSync === 'function') prepPanelSync();
  }
}

function selNovelLayout(el, layout) {
  if (blockLayoutChangeIfOrdering()) return;
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
  var _ptEl = document.getElementById('prep-title');
  if (_ptEl && _ptEl.value && _ptEl.value.trim()) url += '&bookTitle=' + encodeURIComponent(_ptEl.value.trim());
  var _tcEl = document.getElementById('print-title-color');
  if (_tcEl && _tcEl.value) url += '&titleColor=' + encodeURIComponent(_tcEl.value);
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
    applyNovelZoom();
    try { var _zd = iframe.contentDocument; if (_zd) _zd.addEventListener('wheel', novelZoomWheel, { passive: false }); } catch (_e) {}
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
  _fitPreviewMobile('novel-preview-iframe', typeof novelPreviewMode !== 'undefined' && novelPreviewMode !== 'wysiwyg');
  var _ph = '75vh';
  if (window.innerWidth > 900) {
    var _prep = document.querySelector('.novel-prep-panel');
    if (_prep && _prep.offsetHeight > 0) {
      var _h = _prep.offsetHeight;
      if (_h < 520) _h = 520;
      _ph = _h + 'px';
    }
  }
  if (iframe) iframe.style.height = _ph;
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

function loadNovelSummary(cb) {
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
      if (typeof cb === 'function') cb();
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
  var html = '<div class="session-card-grid">' + sessions.map(function(s, i) {
    var moments = s.moments || [];
    totalMoments += moments.length;
    var thumbSrc = s.title_image || s.establishing_image || s.first_image_url;
    var thumb = thumbSrc
      ? '<img class="session-card-img" src="' + thumbSrc + '" loading="lazy" alt="" />'
      : '<div class="session-card-img session-card-img-empty">&#128213;</div>';
    var forkLabel = s.is_canonical
      ? "Story Master's Version"
      : (s.fork_owner_name ? (s.fork_owner_name + "'s Version") : "Your Version");
    var includeChk = '<label class="session-card-include"><input type="checkbox" ' + (novelIncluded(s) ? 'checked' : '') + (novelOwnView() ? '' : ' disabled title="You can only change which sessions are included on your own version"') + ' onchange="toggleNovelInclude(' + s.id + ', this.checked)"> Include in Print</label>';
    return '<div class="session-card session-card-publish">' +
      thumb +
      '<div class="session-card-body">' +
        '<div class="session-card-title">Session ' + (i+1) + ' — ' + s.name + '</div>' +
        '<div class="session-card-date">' + formatSessionDate(s.session_date) + '</div>' +
        '<div class="session-card-fork">' + forkLabel + '</div>' +
        '<div class="session-card-pills">' +
          '<span class="session-badge' + (moments.length ? '' : ' empty') + '">' + moments.length + ' panels</span>' +
          '<span class="session-badge' + (s.fork_status === 'ready' ? '' : ' session-badge-draft') + '">' + (s.fork_status === 'ready' ? 'Ready' : 'Draft') + '</span>' +
        '</div>' +
        '<div class="session-card-actions">' +
          includeChk +
          '<a onclick="goToSessionPage(' + s.id + ')" class="session-card-open">Open</a>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

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
  // Admin general-tab settings must load when the settings view is shown
  // (and on refresh), not only on a tab-button click via switchSettingsTab.
  loadPrintMarkup(); loadSignupBonus(); loadMaxPagesPerPrint(); loadLifecycleConfig(); loadHelpEmailSettings(); loadGenerationSettings();
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
  var pen_name = document.getElementById('settings-penname').value.trim();
  document.getElementById('profile-error').classList.add('hidden');
  document.getElementById('profile-success').classList.add('hidden');
  if (!name || !email) { showSettingsError('profile-error', 'Name and email are required.'); return; }

  fetch('/api/auth/profile', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:name, email:email, pen_name:pen_name})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) { showSettingsError('profile-error', data.error); return; }
    state.user.name = name;
    state.user.email = email;
    state.user.penName = pen_name;
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
  var confirmEl = document.getElementById('settings-confirm-password');
  var confirmpw = confirmEl ? confirmEl.value : newpw;
  document.getElementById('password-error').classList.add('hidden');
  document.getElementById('password-success').classList.add('hidden');
  if (!current || !newpw) { showSettingsError('password-error', 'Both fields are required.'); return; }
  if (newpw.length < 8) { showSettingsError('password-error', 'New password must be at least 8 characters.'); return; }
  if (newpw !== confirmpw) { showSettingsError('password-error', 'New password and confirmation do not match.'); return; }

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
    if (confirmEl) confirmEl.value = '';
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
  if (!isSupportedUploadImage(files[0])) { showSlotError(slot, UPLOAD_TYPE_MSG); return; }
  setSlotFile(slot, files[0]);
}

function handleSlotFileSelect(e, slot) {
  if (e.target.files && e.target.files[0]) {
    if (!isSupportedUploadImage(e.target.files[0])) { showSlotError(slot, UPLOAD_TYPE_MSG); e.target.value = ''; return; }
    setSlotFile(slot, e.target.files[0]);
  }
}

function setSlotFile(slot, file) {
  slotFiles[slot] = file;
  clearSlotError(slot);
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
    if (!isSupportedUploadImage(file)) {
      showAlert(UPLOAD_TYPE_MSG);
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
  if (!ensureGenFree()) return;
  setGenLock('Generate Narrative');
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
    clearGenLock();
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
    clearGenLock();
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
  // The invite button stays visible on the Free Trial (it shows what's
  // possible), but inviting is a paid feature -- stop them on click.
  if (state.user && state.user.tier === 'trial') {
    showAlert('Inviting players is a paid feature. Free Trial campaigns are single-player. Upgrade to a paid plan to invite your table.');
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
  document.getElementById('invite-newchar-fields').style.display = 'none';
  document.getElementById('invite-assign-character').checked = false;
  document.getElementById('invite-character-group').style.display = 'none';

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

// Optional character: the picker stays collapsed until the DM checks "assign a
// character" -- default is campaign access only (no PC claimed).
function toggleInviteAssignCharacter() {
  var assign = document.getElementById('invite-assign-character').checked;
  document.getElementById('invite-character-group').style.display = assign ? '' : 'none';
  if (assign) {
    var sel = document.getElementById('invite-character-select');
    document.getElementById('invite-newchar-fields').style.display = (sel.value === '__new__') ? '' : 'none';
  } else {
    document.getElementById('invite-newchar-fields').style.display = 'none';
  }
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
    errEl.textContent = 'Please enter the member\'s email.';
    errEl.classList.remove('hidden');
    return;
  }

  var body = { email: email };
  var assignEl = document.getElementById('invite-assign-character');
  var assignCharacter = !!(assignEl && assignEl.checked);
  if (assignCharacter) {
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
    var _headshot = m.character_image || m.character_portrait || '';
    var iconHtml = _headshot
      ? '<div class="member-row-icon"><img class="member-row-headshot" src="' + escapeHtml(_headshot) + '" alt="' + escapeHtml(m.character_name || '') + '" /></div>'
      : '';
    var roleBadge = isDM
      ? '<span class="role-badge role-badge-dm">Story Master</span>'
      : '<span class="role-badge role-badge-player">Member</span>';
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
      iconHtml +
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
// Character-card descriptions are capped so a long bio can't stretch the card
// without bound. Visible text is trimmed to ~184 chars at a word boundary with an
// ellipsis; the full description is available on hover via the title attribute.
function campDescTrunc(desc) {
  var full = (desc == null) ? '' : String(desc);
  var LIMIT = 144;
  if (full.length <= LIMIT) return { visible: full, title: '', truncated: false };
  var cut = full.slice(0, LIMIT);
  var lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > LIMIT - 30) cut = cut.slice(0, lastSpace);
  while (cut.length && ' .,;:!?-'.indexOf(cut.charAt(cut.length - 1)) !== -1) {
    cut = cut.slice(0, cut.length - 1);
  }
  return { visible: cut + '\u2026', title: full, truncated: true };
}

function campCardDescHtml(desc) {
  var full = (desc == null) ? '' : String(desc);
  if (!full) return '<div class="campaign-card-desc">No description</div>';
  var t = campDescTrunc(full);
  var titleAttr = t.truncated ? ' title="' + escapeHtml(t.title) + '"' : '';
  return '<div class="campaign-card-desc"' + titleAttr + '>' + escapeHtml(t.visible) + '</div>';
}

function charDescHtml(desc) {
  var full = (desc == null) ? '' : String(desc);
  if (!full) return '<div class="char-desc"></div>';
  var LIMIT = 184;
  if (full.length <= LIMIT) return '<div class="char-desc">' + escapeHtml(full) + '</div>';
  var cut = full.slice(0, LIMIT);
  var lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > LIMIT - 30) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,;:!?-]+$/, '');
  return '<div class="char-desc" title="' + escapeHtml(full) + '">' + escapeHtml(cut) + '\u2026</div>';
}

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
  // Apply this member's saved layout first; the per-fork reload then overrides
  // art/narrative with any session-specific value.
  mpLoadAndApply('session', function(){ reloadSessionForFork(); });
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
  updateWordCounts();
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

function revertMoment(id) {
  if (!state.currentCampaign || !state.currentSession) return;
  fetch('/api/images/revert-moment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moment_id: id })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || d.error) { alert((d && (d.message || d.error)) || 'Could not revert.'); return; }
      if (typeof reloadSessionForFork === 'function') reloadSessionForFork();
    })
    .catch(function(e){ alert('Could not revert: ' + e.message); });
}

function revertCharRef(charId) {
  if (!state.currentCampaign) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/characters/' + charId + '/revert-reference', {
    method: 'POST'
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (!d || d.error) { alert((d && (d.message || d.error)) || 'Could not revert.'); return; }
      // Update the OPEN modal in place so the restored image shows immediately;
      // loadCharacters() only refreshes the card list, not the open dialog (which
      // is why revert previously needed a close/reopen to show). The endpoint
      // returns the restored URL; fall back to the client's armed slot if absent.
      var ch = (state.characters || []).find(function(c) { return c.id === charId; });
      if (ch) {
        var restored = (d && d.canonical_reference_url) ? d.canonical_reference_url : ch.revert_reference_url;
        if (restored) {
          ch.canonical_reference_url = restored;
          ch.revert_reference_url = null;
          ch.archived = false;
          if (typeof renderCharModalPrompt === 'function') renderCharModalPrompt(ch);
        }
      }
      if (typeof loadCharacters === 'function') loadCharacters();
    })
    .catch(function(e){ alert('Could not revert: ' + e.message); });
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
      // Art style is per-fork too: re-apply from the viewed fork's data so a member
      // sees their own art style, not the SM's set by the initial no-fork load.
      if (typeof loadLastArtStyle === 'function') loadLastArtStyle(data.art_style_override || data.art_style, data.layout_style);
      if (typeof renderStoryboard === 'function') renderStoryboard();
      // Title-image thumbnail must follow the viewed fork (member's own vs canonical),
      // otherwise it keeps the SM image painted by the initial no-fork load.
      if (typeof renderSessionEstablishing === 'function') renderSessionEstablishing(data);
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

async function deleteMyVersion() {
  if (!state.currentCampaign || !state.currentSession || !state.myForkId) return;
  if (!await uiConfirm('Delete your version of this session? This cannot be undone.')) return;
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
  monthly_utlt: 'Monthly UTOLT tokens',
  monthly_cot: 'Monthly CO tokens',
  signup_bonus: 'Sign-up bonus (one-time CO tokens, per tier)',
  max_campaigns: 'Max campaigns (blank/-1 = unlimited)',
  max_sessions: 'Max sessions / campaign (blank/-1 = unlimited)',
  max_characters: 'Max characters / campaign (blank/-1 = unlimited)',
  session_reserve: 'Session token reserve (0 = none)',
  max_archives_per_campaign: 'Archived images / campaign',
  max_assets: 'Max campaign assets (blank = unlimited)',
  max_moments_short: 'Max moments \u2014 short (<2k words)',
  max_moments_medium: 'Max moments \u2014 medium (2k\u20135k)',
  max_moments_long: 'Max moments \u2014 long (5k\u201310k)',
  max_moments_epic: 'Max moments \u2014 epic (10k+)'
};

function switchSettingsTab(tab) {
  ['general', 'tiers', 'stats', 'trends', 'financial', 'usertesting', 'promos'].forEach(function (t) {
    var pane = document.getElementById('settings-pane-' + t);
    var btn = document.getElementById('settings-tab-' + t);
    if (pane) pane.style.display = (t === tab) ? 'block' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
  if (tab === 'general') { loadPrintMarkup(); loadSignupBonus(); loadMaxPagesPerPrint(); loadLifecycleConfig(); loadHelpEmailSettings(); loadGenerationSettings(); }
  if (tab === 'tiers') loadTiersConfig();
  if (tab === 'stats') loadStats();
  if (tab === 'trends') loadTrends();
  if (tab === 'usertesting') initUserTestingTab();
  if (tab === 'promos') loadPromoCodes();
}

// Populate the User Testing tab with the signed-in account's current state
// (trial toggle/date + tier-override dropdown) so it is accurate even when the
// Dashboard is opened without first visiting My Account. Self only -- reads
// /api/auth/me for the current user; never touches anyone else's account.
function initUserTestingTab() {
  fetch('/api/auth/me').then(function(r){ return r.json(); }).then(function(me){
    if (!me || !me.authenticated) return;
    var tt = document.getElementById('dev-trial-toggle'); if (tt) tt.checked = (me.tier === 'trial');
    var td = document.getElementById('dev-trial-date'); if (td && me.trialStartedAt) td.value = String(me.trialStartedAt).slice(0,10);
    var ov = document.getElementById('account-tier-override'); if (ov && me.tier) ov.value = me.tier;
  }).catch(function(){});
}

var _promoEditId = null;
var _promoLoaded = [];
function loadPromoCodes() {
  var box = document.getElementById('promo-codes-list');
  if (box) box.textContent = 'Loading...';
  fetch('/api/admin/promo-codes')
    .then(function (r) { return r.json(); })
    .then(function (d) { _promoLoaded = (d && d.codes) || []; renderPromoCodes(_promoLoaded); })
    .catch(function () { if (box) box.textContent = 'Could not load promo codes.'; });
}

function renderPromoCodes(codes) {
  var box = document.getElementById('promo-codes-list');
  if (!box) return;
  if (!codes.length) { box.textContent = 'No promo codes yet.'; return; }
  var typeLabel = { token_grant: 'Tokens', percent_off: '% off', amount_off: '$ off' };
  var rows = codes.map(function (c) {
    var val = (c.action_type === 'percent_off') ? (c.action_value + '%')
            : (c.action_type === 'amount_off') ? ('$' + c.action_value)
            : (c.action_value + ' CO');
    var exp = c.expires_at ? String(c.expires_at).slice(0, 10) : 'none';
    var badge = c.active ? 'Active' : 'Inactive';
    return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border);">' +
      '<strong style="color:var(--gold);min-width:110px;">' + escapeHtml(c.code) + '</strong>' +
      '<span style="min-width:140px;">' + escapeHtml(c.label || '') + '</span>' +
      '<span style="min-width:100px;">' + (typeLabel[c.action_type] || c.action_type) + ': ' + escapeHtml(String(val)) + '</span>' +
      '<span style="min-width:90px;">' + escapeHtml(String(c.per_user_limit || 1)) + '/user</span>' +
      '<span style="min-width:105px;">exp: ' + escapeHtml(exp) + '</span>' +
      '<span style="min-width:70px;">used: ' + (c.redeemed_count || 0) + '</span>' +
      '<span style="min-width:64px;color:' + (c.active ? 'var(--gold)' : 'var(--text-muted)') + ';">' + badge + '</span>' +
      '<button class="btn btn-sm" onclick="editPromoCode(' + c.id + ')">Edit</button>' +
      '<button class="btn btn-sm" onclick="togglePromoCode(' + c.id + ')">' + (c.active ? 'Deactivate' : 'Activate') + '</button>' +
      '</div>';
  }).join('');
  box.innerHTML = rows;
}

function editPromoCode(id) {
  var c = null;
  for (var i = 0; i < _promoLoaded.length; i++) { if (_promoLoaded[i].id === id) { c = _promoLoaded[i]; break; } }
  if (!c) return;
  var g = function (x) { return document.getElementById(x); };
  if (g('promo-code-input')) { g('promo-code-input').value = c.code; g('promo-code-input').readOnly = true; }
  if (g('promo-label-input')) g('promo-label-input').value = c.label || '';
  if (g('promo-type-input')) g('promo-type-input').value = c.action_type || 'token_grant';
  if (g('promo-value-input')) g('promo-value-input').value = (c.action_value != null ? c.action_value : 0);
  if (g('promo-peruser-input')) g('promo-peruser-input').value = (c.per_user_limit || 1);
  if (g('promo-expires-input')) g('promo-expires-input').value = c.expires_at ? String(c.expires_at).slice(0, 10) : '';
  _promoEditId = id;
  if (g('promo-submit-btn')) g('promo-submit-btn').textContent = 'Save changes';
  if (g('promo-cancel-edit')) g('promo-cancel-edit').style.display = '';
  var msg = g('promo-create-msg'); if (msg) msg.textContent = 'Editing ' + c.code + ' (code cannot be changed).';
  if (g('promo-code-input')) g('promo-code-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelPromoEdit() {
  var g = function (x) { return document.getElementById(x); };
  _promoEditId = null;
  ['promo-code-input','promo-label-input','promo-value-input','promo-expires-input'].forEach(function (id) { if (g(id)) g(id).value = ''; });
  if (g('promo-peruser-input')) g('promo-peruser-input').value = '1';
  if (g('promo-type-input')) g('promo-type-input').value = 'token_grant';
  if (g('promo-code-input')) g('promo-code-input').readOnly = false;
  if (g('promo-submit-btn')) g('promo-submit-btn').textContent = 'Create code';
  if (g('promo-cancel-edit')) g('promo-cancel-edit').style.display = 'none';
  var msg = g('promo-create-msg'); if (msg) msg.textContent = '';
}

function createPromoCode() {
  var g = function (id) { return document.getElementById(id); };
  var msg = g('promo-create-msg');
  var payload = {
    code: (g('promo-code-input') || {}).value || '',
    label: (g('promo-label-input') || {}).value || '',
    action_type: (g('promo-type-input') || {}).value || 'token_grant',
    action_value: (g('promo-value-input') || {}).value || '0',
    per_user_limit: (g('promo-peruser-input') || {}).value || '1',
    expires_at: (g('promo-expires-input') || {}).value || ''
  };
  var editing = _promoEditId;
  var url = editing ? ('/api/admin/promo-codes/' + editing + '/update') : '/api/admin/promo-codes';
  if (msg) msg.textContent = 'Saving...';
  fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j && res.j.ok) {
        cancelPromoEdit();
        if (msg) msg.textContent = editing ? 'Saved.' : 'Created.';
        loadPromoCodes();
      } else {
        if (msg) msg.textContent = (res.j && res.j.error) ? res.j.error : 'Could not save.';
      }
    })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

function togglePromoCode(id) {
  fetch('/api/admin/promo-codes/' + id + '/toggle', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function () { loadPromoCodes(); })
    .catch(function () {});
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
    html += '<div class="settings-section tier-config-panel panel-dark" id="tier-panel-' + tierKey + '">';
    html += '<div class="settings-section-title">' + (t.name || tierKey) + '</div>';
    html += '<div style="columns:2;column-gap:30px;">';
    fields.forEach(function (f) {
      var val = (t[f] === null || t[f] === undefined) ? '' : t[f];
      var label = TIER_FIELD_LABELS[f] || f;
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid rgba(201,168,76,0.12);break-inside:avoid;">' +
        '<label class="form-label" for="tcf-' + tierKey + '-' + f + '" style="margin:0;flex:1;font-size:12.5px;line-height:1.25;">' + label + '</label>' +
        '<input id="tcf-' + tierKey + '-' + f + '" class="form-input tier-config-input" type="number" min="0" step="1" ' +
        'data-tier="' + tierKey + '" data-field="' + f + '" value="' + val + '" ' +
        'style="width:74px;flex:0 0 auto;text-align:right;padding:5px 8px;" />' +
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
  cover:1, cast:1, toc:1, header:1, markers:1, markerbreak:0, watermark:1,
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
  if (r.paper === 'parchment' || r.paper === 'linen') { r.paper = 'cream'; }
  if (r.paper === 'grey' || r.paper === 'lightgrey') { r.paper = 'white'; }
  return r;
}
function saveCustomLayoutPrefs(){
  // localStorage stays as a fallback for signed-out/first-paint, but the CAMPAIGN copy is authoritative:
  // layout choices belong to the book, keyed by (logged-in user, fork, campaign) exactly like cover art.
  try { window.localStorage.setItem(CL_LS_KEY, JSON.stringify({ opts: customOpts, active: customActive })); } catch (e) {}
  saveCampaignLayoutOpts();
  finalizeClearStats();   // any layout change invalidates the Before/After comparison
}
// Persist this campaign's layout options into the same per-(user, fork, campaign) prefs blob the
// cover art uses, so switching campaigns switches layouts and nothing leaks between books.
function saveCampaignLayoutOpts(){
  try {
    var c = state.currentCampaign; if (!c || !state.user) return;
    var body = { layout_opts: JSON.stringify({ opts: customOpts, active: customActive }) };
    if (state.novelAsUser) body.fork_user = state.novelAsUser;
    fetch('/api/campaigns/' + c.id + '/my-book-meta', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function(){});
  } catch (e) {}
}
// Apply the layout options saved on THIS campaign (called after book meta loads). Falls back to the
// current in-memory values when a campaign has none saved yet, so existing books are unchanged.
function applyCampaignLayoutOpts(meta){
  var saved = null;
  try { if (meta && meta.layout_opts) saved = JSON.parse(meta.layout_opts); } catch (e) { saved = null; }
  // ALWAYS set state. A campaign with nothing saved must fall back to DEFAULTS, never keep whatever
  // the previously-open campaign was using -- inheriting was the bug (open A with drop shadow, open
  // B, B showed drop shadow).
  if (saved && saved.opts) {
    customOpts.session = clMerge(saved.opts.session);
    customOpts.novel = clMerge(saved.opts.novel);
  } else {
    customOpts.session = clClone(CUSTOM_LAYOUT_DEFAULTS);
    customOpts.novel = clClone(CUSTOM_LAYOUT_DEFAULTS);
  }
  if (saved && saved.active) {
    customActive.session = !!saved.active.session;
    customActive.novel = !!saved.active.novel;
  } else {
    customActive.session = false;
    customActive.novel = false;
  }
  // Repaint anything that displays the options: the Finalize header summary ("Borders: ...") and the
  // Custom Layout panel if it happens to be open. Without this the values change but the UI lies.
  try { if (typeof finalizeUpdateHeader === 'function') finalizeUpdateHeader(); } catch (e) {}
  try {
    var _pn = document.getElementById('custom-layout-modal');
    if (_pn && _pn.style && _pn.style.display && _pn.style.display !== 'none' && typeof openCustomLayout === 'function' && typeof _clCtx !== 'undefined') openCustomLayout(_clCtx);
  } catch (e) {}
  return !!saved;
}
// Pull this campaign's layout options straight from the DB on every switch. Deliberately no cache
// and no localStorage read: the stored options ARE the truth, so a stale browser copy can never
// leak one campaign's look into another. Called from setCampaignElements, which every campaign-
// switch path funnels through.
var _clLoadSeq = 0;
function loadCampaignLayoutOpts(){
  try {
    var c = state.currentCampaign;
    if (!c) return;
    var forkUser = state.novelAsUser || (state.user && state.user.id);
    if (!forkUser) return;
    var seq = ++_clLoadSeq;
    finalizeClearStats();   // the Before/After numbers belong to the campaign we just left
    fetch('/api/campaigns/' + c.id + '/my-book-meta?as_user=' + encodeURIComponent(forkUser), { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(m){ if (seq !== _clLoadSeq) return; applyCampaignLayoutOpts(m); })   // ignore a slow reply for a campaign we already left
      .catch(function(){});
  } catch (e) {}
}
// Clear the Optimize Before/After readout. It describes one specific book + layout, so it must not
// survive a campaign switch or a layout change -- a stale "35 -> 35 / 72% -> 70%" is worse than none.
function finalizeClearStats(){
  try {
    var d = document.getElementById('layoutai-delta'); if (d) d.innerHTML = '';
    var r = document.getElementById('layoutai-results'); if (r) { r.innerHTML = ''; r.removeAttribute('data-mode'); }
    if (typeof _finalizeFills !== 'undefined') _finalizeFills = {};
    if (typeof _finalizeAfterFills !== 'undefined') _finalizeAfterFills = {};
  } catch (e) {}
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
var CL_TOGGLES = ['dropcap','header','markers','markerbreak','cover','cast','toc','hidelogo'];
var CL_ARRANGE_LABEL = { paired:'Picture Book', comicpage:'Comic', magazine:'Magazine', gazette:'Gazette' };

// Enable the page-break sub-toggle only when Session dividers (markers) is on.
function clSyncMarkerBreak(){
  var mk=document.getElementById('cl-markers');
  var mb=document.getElementById('cl-markerbreak');
  var mbl=document.getElementById('cl-markerbreak-label');
  if(!mb) return;
  var on = mk ? !!mk.checked : true;
  mb.disabled = !on;
  if(!on) mb.checked = false;
  if(mbl){ mbl.style.opacity = on ? '1' : '0.55'; }
}
// Draggable slider between the prep pane and the preview pane (Preview & Export tab).
var _novelDrag = null, _novelSplitPct = null;
function novelSplitStart(e){
  e.preventDefault();
  var layout=document.querySelector('.novel-preview-layout');
  var prep=document.getElementById('novel-prep-panel');
  if(!layout||!prep) return;
  _novelDrag={ x:e.clientX, w:prep.getBoundingClientRect().width, total:layout.getBoundingClientRect().width };
  document.addEventListener('mousemove', novelSplitMove);
  document.addEventListener('mouseup', novelSplitEnd);
  document.body.style.userSelect='none';
}
function novelSplitMove(e){
  if(!_novelDrag || !_novelDrag.total) return;
  var prep=document.getElementById('novel-prep-panel');
  var pct=((_novelDrag.w + (e.clientX - _novelDrag.x)) / _novelDrag.total) * 100;
  if(pct<20) pct=20; if(pct>70) pct=70;
  if(prep){ prep.style.flexBasis=pct.toFixed(2)+'%'; prep.style.flexGrow='0'; prep.style.flexShrink='0'; }
  _novelSplitPct=pct;
}
function novelSplitEnd(){
  _novelDrag=null;
  document.removeEventListener('mousemove', novelSplitMove);
  document.removeEventListener('mouseup', novelSplitEnd);
  document.body.style.userSelect='';
  try{ if(_novelSplitPct!=null) localStorage.setItem('novelSplitPct', String(Math.round(_novelSplitPct*100)/100)); }catch(_e){}
}
function novelSplitInit(){
  try{ var v=localStorage.getItem('novelSplitPct'); if(v){ var prep=document.getElementById('novel-prep-panel'); if(prep){ prep.style.flexBasis=v+'%'; prep.style.flexGrow='0'; prep.style.flexShrink='0'; } } }catch(_e){}
}
if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', novelSplitInit); } else { novelSplitInit(); }
// Prep-pane accordion (Preview & Export tab): independent open/close per panel.
function togglePrepAcc(key){
  var acc=document.getElementById('prep-acc-'+key); if(!acc) return;
  var body=acc.querySelector('.prep-acc-body');
  var head=acc.querySelector('.prep-acc-head');
  if(!body) return;
  var isOpen=body.style.display!=='none';
  body.style.display=isOpen?'none':'';
  if(head) head.setAttribute('aria-expanded', isOpen?'false':'true');
  acc.classList.toggle('open', !isOpen);
  if(key==='layout' && !isOpen && typeof prepLayoutLoad==='function') prepLayoutLoad();   // populate from saved novel layout on open
}
// Inline layout panel (Preview & Export tab, Panel 2): mirrors the Layout modal for the 'novel'
// context using pcl-* controls, wired to the same customOpts.novel store. Storyboard modal untouched.
function prepSyncMarkerBreak(){
  var mk=document.getElementById('pcl-markers');
  var mb=document.getElementById('pcl-markerbreak');
  var mbl=document.getElementById('pcl-markerbreak-label');
  if(!mb) return;
  var on = mk ? !!mk.checked : true;
  mb.disabled = !on;
  if(!on) mb.checked = false;
  if(mbl){ mbl.style.opacity = on ? '1' : '0.55'; }
}
function prepLayoutLoad(){
  var o = (typeof customOpts !== 'undefined' && customOpts.novel) ? customOpts.novel : CUSTOM_LAYOUT_DEFAULTS;
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('pcl-'+k); if(el) el.value=o[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('pcl-'+k); if(el) el.checked=!!o[k]; });
  prepSyncMarkerBreak();
  var _plat = !!(state.tierInfo && state.tierInfo.effective_rank >= 4);
  var _hl=document.getElementById('pcl-hidelogo'); if(_hl){ _hl.disabled=!_plat; if(!_plat) _hl.checked=false; }
  var _hll=document.getElementById('pcl-hidelogo-label'); if(_hll){ _hll.style.opacity=_plat?'1':'0.55'; _hll.title=_plat?'Hide the Campaignia logo on the cover':'Hiding the logo is a Platinum feature'; }
  // Commit panel selections to customOpts.novel the moment any control changes, so a plain
  // Refresh (not just Apply) reflects the chosen arrangement. Programmatic .value sets above
  // don't fire 'change', so this never clobbers on load.
  var _lp = document.getElementById('prep-acc-layout');
  if (_lp && !_lp._commitWired) { _lp._commitWired = true; _lp.addEventListener('change', function(){ if (typeof prepLayoutCommit === 'function') prepLayoutCommit(); }); }
}
// Read the layout panel (pcl-*) into customOpts.novel + mark it active, WITHOUT rendering.
function prepLayoutCommit(){
  if(typeof blockLayoutChangeIfOrdering==='function' && blockLayoutChangeIfOrdering()) return false;
  var o={};
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('pcl-'+k); o[k]= el ? el.value : CUSTOM_LAYOUT_DEFAULTS[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('pcl-'+k); o[k]= (el && el.checked) ? 1 : 0; });
  customOpts.novel=o;
  customActive.novel=true;
  if(typeof mpSave==='function') mpSave('novel', { layout_opts: o });
  saveCustomLayoutPrefs();
  if(typeof refreshLayoutStyleButtons==='function') refreshLayoutStyleButtons();
  return true;
}
function prepLayoutApply(){
  if(prepLayoutCommit() && typeof loadNovelPreview==='function') loadNovelPreview(novelLayoutStyle);
}
function prepLayoutReset(){
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('pcl-'+k); if(el) el.value=CUSTOM_LAYOUT_DEFAULTS[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('pcl-'+k); if(el) el.checked=!!CUSTOM_LAYOUT_DEFAULTS[k]; });
  prepSyncMarkerBreak();
}
function openCustomLayout(ctx){
  _clCtx = ctx || 'novel';
  var modal=document.getElementById('custom-layout-modal');
  if(modal){ modal.style.display=''; modal.classList.remove('hidden'); }
  var o = customOpts[_clCtx] || CUSTOM_LAYOUT_DEFAULTS;
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('cl-'+k); if(el) el.value=o[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('cl-'+k); if(el) el.checked=!!o[k]; });
  clSyncMarkerBreak();
  (function(){ var _plat = !!(state.tierInfo && state.tierInfo.effective_rank >= 4); var _hl=document.getElementById('cl-hidelogo'); if(_hl){ _hl.disabled=!_plat; if(!_plat) _hl.checked=false; } var _hll=document.getElementById('cl-hidelogo-label'); if(_hll){ _hll.style.opacity=_plat?'1':'0.55'; _hll.title=_plat?'Hide the Campaignia logo on the cover':'Hiding the logo is a Platinum feature'; } })();
  var lbl=document.getElementById('cl-ctx-label'); if(lbl) lbl.textContent = (_clCtx==='novel' ? '(graphic novel)' : '(this session)');
  var novelOnly=document.querySelectorAll('.cl-novel-only');
  for (var i=0;i<novelOnly.length;i++){ novelOnly[i].style.display = (_clCtx==='novel' ? 'flex' : 'none'); }
}
function closeCustomLayout(){ var m=document.getElementById('custom-layout-modal'); if(m) m.classList.add('hidden'); }
function resetCustomLayout(){ customOpts[_clCtx]=clClone(CUSTOM_LAYOUT_DEFAULTS); saveCustomLayoutPrefs(); openCustomLayout(_clCtx); }
function applyCustomLayout(){
  if(_clCtx==='novel' && blockLayoutChangeIfOrdering()) return;
  var o={};
  CL_SELECTS.forEach(function(k){ var el=document.getElementById('cl-'+k); o[k]= el ? el.value : CUSTOM_LAYOUT_DEFAULTS[k]; });
  CL_TOGGLES.forEach(function(k){ var el=document.getElementById('cl-'+k); o[k]= (el && el.checked) ? 1 : 0; });
  customOpts[_clCtx]=o;
  customActive[_clCtx]=true;
  mpSave(_clCtx, { layout_opts: o });   // persist to the active member (own fork only)
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

// ---- Per-member layout/style prefs (server-persisted on campaign_members) ----
// The 'active member' depends on context: the novel/book view uses novelAsUser
// (null = my own canonical); the session view uses the OWNER of the viewed fork
// (null fork = my canonical). We may READ anyone's prefs (so the SM auto-loads a
// member's look when generating their book) but auto-SAVE ONLY our own (isMe) --
// re-enforced server-side. Layout is the primary per-member signal; art/narrative
// are captured too (their per-session-fork values still govern within a session).
function mpMemberFor(ctx){
  var meId = (state.user && state.user.id) || null;
  if (ctx === 'novel'){
    var asU = state.novelAsUser;
    return { userId: asU ? asU : meId, isMe: (!asU || String(asU) === String(meId)) };
  }
  var fid = state.currentForkId;
  if (!fid) return { userId: meId, isMe: true };
  var fork = (state.sessionForks || []).filter(function(f){ return String(f.fork_id) === String(fid); })[0];
  return { userId: (fork && fork.user_id) ? fork.user_id : meId, isMe: !!(fork && fork.is_mine) };
}
function mpApplyPrefs(ctx, p){
  if (!p) return;
  if (p.layout_opts && typeof p.layout_opts === 'object'){
    var keys = 0; for (var k in p.layout_opts){ if (p.layout_opts.hasOwnProperty(k)) keys++; }
    if (keys){
      customOpts[ctx] = clMerge(p.layout_opts);   // clMerge fills any newly-added params with defaults
      customActive[ctx] = true;
      if (p.layout_opts.arrange){
        if (ctx === 'novel') novelLayoutStyle = p.layout_opts.arrange;
        else state.layoutStyle = p.layout_opts.arrange;
      }
      saveCustomLayoutPrefs();
      if (typeof refreshLayoutStyleButtons === 'function') refreshLayoutStyleButtons();
    }
  }
  // Seed art/narrative. In the session view the per-fork loader (reloadSessionForFork)
  // runs AFTER this and overrides with the session-specific value when present, so the
  // member value only fills a gap; in the book view there is no competing loader.
  if (typeof p.art_style === 'string' && p.art_style){ state.artStyle = p.art_style; if (typeof refreshArtStyleButtons === 'function') refreshArtStyleButtons(); }
  if (typeof p.narrative_style === 'string' && p.narrative_style){ state.narrativeStyle = p.narrative_style; if (typeof refreshNarrStyleButtons === 'function') refreshNarrStyleButtons(); }
}
function mpLoadAndApply(ctx, done){
  var m = mpMemberFor(ctx);
  if (!state.currentCampaign || !m.userId){ if (done) done(); return; }
  fetch('/api/campaigns/' + state.currentCampaign.id + '/members/' + m.userId + '/prefs')
    .then(function(r){ return r.json(); })
    .then(function(p){ if (p && !p.error) mpApplyPrefs(ctx, p); })
    .catch(function(){})
    .then(function(){ if (done) done(); });
}
function mpSave(ctx, patch){
  var m = mpMemberFor(ctx);
  // Own fork, OR the SM curating a member's fork (server routes it to the SM overlay).
  var _ok = m.isMe || (typeof prepUseMember === 'function' && prepUseMember());
  if (!state.currentCampaign || !m.userId || !_ok) return;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/members/' + m.userId + '/prefs', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  }).catch(function(){});
}

// ----- Campaign settings modal (SM/DM only) -----
// Opened from the ellipsis on a campaign card. Holds per-campaign options;
// starts with "allow players access to graphic novel" and has room to grow.
var _csCampaignId = null;

// --- Campaign tile image (DM-only, set from the campaign settings modal). ----
// Stored on the campaign as campaign_image_url. Drives the home tile, and acts
// as the default publish cover when no explicit cover has been chosen.
function renderCampaignSettingsThumb() {
  var el = document.getElementById('cs-image-thumb');
  if (!el) return;
  var c = (state.campaigns || []).filter(function(x){ return x.id === _csCampaignId; })[0];
  var url = (c && c.campaign_image_url) ? c.campaign_image_url : '';
  if (url) {
    el.style.backgroundImage = 'url("' + encodeURI(url) + '")';
    el.classList.add('has-img');
    el.innerHTML = '';
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
    el.innerHTML = '<span class="prep-thumb-plus">+</span>';
  }
}

// PUT the new campaign image (or '' to clear). Operates on the settings modal's
// target campaign (_csCampaignId), which may differ from the current campaign.
function setCampaignImage(campaignId, newUrl, cb) {
  fetch('/api/campaigns/' + campaignId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaign_image_url: newUrl })
  })
  .then(function(r){ return r.json(); })
  .then(function(data){
    if (data && data.id) {
      var i = state.campaigns.findIndex(function(x){ return x.id === data.id; });
      if (i >= 0) state.campaigns[i].campaign_image_url = data.campaign_image_url || '';
      if (state.currentCampaign && state.currentCampaign.id === data.id) {
        state.currentCampaign.campaign_image_url = data.campaign_image_url || '';
      }
      renderCampaigns();
      renderCampaignSettingsThumb();
      showAlert(newUrl ? 'Campaign image set.' : 'Campaign image cleared.');
      if (typeof cb === 'function') cb();
    } else {
      showAlert((data && data.error) || 'Could not update the campaign image.');
    }
  })
  .catch(function(){ showAlert('Could not update the campaign image.'); });
}

// Archive picker for the campaign image. Same look as the Pre-Publish Prep
// picker (shared CSS classes), but self-contained: it loads the target
// campaign's own archives so it works from the home grid for any campaign.
function openCampaignImagePicker(campaignId) {
  if (!campaignId) return;
  fetch('/api/campaigns/' + campaignId + '/archives', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(rows){
      var archives = Array.isArray(rows) ? rows.filter(function(a){ return a && a.image_url; }) : [];
      var c = (state.campaigns || []).filter(function(x){ return x.id === campaignId; })[0];
      var curUrl = (c && c.campaign_image_url) ? c.campaign_image_url : '';
      closeCampaignImagePicker();
      var overlay = document.createElement('div');
      overlay.id = 'cs-img-modal'; overlay.className = 'prep-img-modal';
      overlay.addEventListener('click', function(e){ if (e.target === overlay) closeCampaignImagePicker(); });
      var box = document.createElement('div'); box.className = 'prep-img-modal-box';
      var head = document.createElement('div'); head.className = 'prep-img-modal-head';
      var h = document.createElement('div'); h.className = 'prep-img-modal-title'; h.textContent = 'Choose a Campaign image';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'prep-img-modal-x'; x.innerHTML = '&times;';
      x.addEventListener('click', closeCampaignImagePicker);
      head.appendChild(h); head.appendChild(x);
      var grid = document.createElement('div'); grid.className = 'prep-img-grid';
      if (!archives.length) {
        var empty = document.createElement('div'); empty.className = 'prep-img-empty';
        empty.textContent = 'No archived images yet. Lock or archive images from the Storyboard, then choose one here.';
        grid.appendChild(empty);
      } else {
        archives.forEach(function(a){
          var btn = document.createElement('button'); btn.type = 'button';
          btn.className = 'prep-img-pick' + (a.image_url === curUrl ? ' selected' : '');
          btn.style.backgroundImage = 'url("' + encodeURI(a.image_url) + '")';
          if (a.title) btn.title = a.title;
          btn.addEventListener('click', function(){
            var nu = (a.image_url === curUrl) ? '' : a.image_url;
            setCampaignImage(campaignId, nu, null);
            closeCampaignImagePicker();
          });
          grid.appendChild(btn);
        });
      }
      box.appendChild(head); box.appendChild(grid);
      if (curUrl) {
        var foot = document.createElement('div'); foot.className = 'prep-img-modal-foot';
        foot.textContent = 'Tip: click the highlighted image to remove it.';
        box.appendChild(foot);
      }
      overlay.appendChild(box); document.body.appendChild(overlay);
    })
    .catch(function(){ showAlert('Could not load archived images.'); });
}
function closeCampaignImagePicker() {
  var m = document.getElementById('cs-img-modal');
  if (m && m.parentNode) m.parentNode.removeChild(m);
}

function updateWordCounts() {
  var pairs = [['transcript-input', 'transcript-wordcount'], ['session-notes-input', 'session-notes-wordcount']];
  pairs.forEach(function (pr) {
    var el = document.getElementById(pr[0]);
    var out = document.getElementById(pr[1]);
    if (!el || !out) return;
    var v = (el.value || '').trim();
    var n = v ? v.split(/\s+/).length : 0;
    out.textContent = n + (n === 1 ? ' word' : ' words');
  });
}

function loreCount(el, countId) {
  var val = (el && el.value) ? el.value : '';
  var chars = val.length;
  var t = val.trim();
  var words = t ? t.split(/\s+/).length : 0;
  var c = document.getElementById(countId);
  if (c) c.textContent = words + (words === 1 ? ' word' : ' words') + ' \u00B7 ' + chars + ' / 6000';
}

function openCampaignSettings(id, ev) {
  if (ev && ev.stopPropagation) ev.stopPropagation();
  _csCampaignId = id;
  var c = (state.campaigns || []).filter(function (x) { return x.id === id; })[0];
  var cb = document.getElementById('cs-allow-novel');
  if (cb) {
    var v = c && c.allow_player_novel_access;
    cb.checked = (v === true || v === 1 || v === 't' || v === 'true');
  }
  var cba = document.getElementById('cs-allow-assets');
  if (cba) {
    var va = c && c.allow_member_assets;
    cba.checked = (va === true || va === 1 || va === 't' || va === 'true');
  }
  var loreEl = document.getElementById('cs-lore-input');
  if (loreEl) { loreEl.value = (c && c.lore) ? c.lore : ''; loreCount(loreEl, 'cs-lore-count'); }
  var err = document.getElementById('campaign-settings-error');
  if (err) err.classList.add('hidden');
  var modal = document.getElementById('campaign-settings-modal');
  if (modal) modal.classList.remove('hidden');
  renderCampaignSettingsThumb();
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
  var cba = document.getElementById('cs-allow-assets');
  var allowAssets = !!(cba && cba.checked);
  var _loreEl = document.getElementById('cs-lore-input');
  var _loreVal = _loreEl ? _loreEl.value.slice(0, 6000) : undefined;
  var btn = document.getElementById('cs-save-btn');
  var err = document.getElementById('campaign-settings-error');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  fetch('/api/campaigns/' + _csCampaignId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow_player_novel_access: allow, allow_member_assets: allowAssets, lore: _loreVal })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      if (!data || data.error) {
        if (err) { err.textContent = (data && data.error) || 'Could not save settings.'; err.classList.remove('hidden'); }
        return;
      }
      var saveId = _csCampaignId;
      (state.campaigns || []).forEach(function (x) { if (x.id === saveId) { x.allow_player_novel_access = allow; x.allow_member_assets = allowAssets; if (_loreVal !== undefined) x.lore = _loreVal; } });
      if (state.currentCampaign && state.currentCampaign.id === saveId) { state.currentCampaign.allow_player_novel_access = allow; state.currentCampaign.allow_member_assets = allowAssets; if (_loreVal !== undefined) state.currentCampaign.lore = _loreVal; }
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

// --- Exact page count from the rendered interior PDF -------------------------
// The on-screen estimate counts moments (~panels), but the comic layout packs
// several panels per page, so it runs high. The only accurate source is the
// rendered interior PDF itself; print-interior returns its real page count.
// We render once (on tab open), cache it by the interior URL, and reuse that
// same file at Place Order so we never render twice for the same book.
var printActualPages = 0;
var printInteriorCache = { key: '', url: '', pages: 0 };

function currentPageCount() {
  if (printActualPages > 0) return printActualPages;
  return (printNovelInfo && printNovelInfo.pageEstimate) || 0;
}

function updatePrintPageDisplay(n, exact) {
  var pe = document.getElementById('print-page-est');
  if (!pe) return;
  if (exact && n > 0) {
    pe.textContent = 'Final length: ' + n + ' pages (used for pricing and the cover spine).';
  } else if (n === 0) {
    pe.textContent = 'Calculating exact page count from the print file...';
  } else {
    var est = (printNovelInfo && printNovelInfo.pageEstimate) || 0;
    pe.textContent = 'Estimated length: about ' + est + ' pages (final count is set when the print file is generated).';
  }
}

// Resolve the interior PDF, reusing a cached render when params are unchanged.
// Resolves to { url, pages }.
function ensureInterior() {
  var key = printInteriorUrl();
  if (printInteriorCache.key === key && printInteriorCache.url) {
    return Promise.resolve({ url: printInteriorCache.url, pages: printInteriorCache.pages });
  }
  return fetch(key)
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j || !res.j.url) {
        throw new Error(res.j && (res.j.message || res.j.error) ? (res.j.message || res.j.error) : 'Could not build the interior file.');
      }
      printInteriorCache = { key: key, url: res.j.url, pages: (res.j.pages || 0) };
      return { url: res.j.url, pages: (res.j.pages || 0) };
    });
}

// Fired when the Order tab opens: render the interior once to learn the true
// page count, then update the displayed length and format options. Optional --
// if it fails the form still works off the estimate.
function prepareInteriorCount() {
  if (!state.currentCampaign) return;
  var key = printInteriorUrl();
  if (printInteriorCache.key === key && printInteriorCache.pages > 0) {
    printActualPages = printInteriorCache.pages;
    updatePrintPageDisplay(printActualPages, true);
    refreshPrintOptions(printActualPages);
    return;
  }
  updatePrintPageDisplay(0, false);
  fetch(key)
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok || !res.j || !res.j.url) { updatePrintPageDisplay(-1, false); return; }
      printInteriorCache = { key: key, url: res.j.url, pages: (res.j.pages || 0) };
      if (res.j.pages && res.j.pages > 0) {
        printActualPages = res.j.pages;
        updatePrintPageDisplay(printActualPages, true);
        refreshPrintOptions(printActualPages);
      } else {
        updatePrintPageDisplay(-1, false);
      }
    })
    .catch(function () { updatePrintPageDisplay(-1, false); });
}

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

// Order feedback shown DOWN BY THE BUTTON (prepare/order failures + the
// 'details changed' notice), as opposed to showPrintMsg which is the
// top-of-form load-error slot.
function showPrintBtnMsg(text, kind) {
  var el = document.getElementById('print-place-msg');
  if (!el) return;
  if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
  var ok = kind === 'ok';
  el.style.display = 'block';
  el.style.background = ok ? 'rgba(120,180,90,0.12)' : 'rgba(201,120,76,0.12)';
  el.style.border = '1px solid ' + (ok ? 'rgba(120,180,90,0.4)' : 'rgba(201,120,76,0.4)');
  el.style.color = ok ? 'rgba(200,235,180,0.95)' : 'rgba(245,200,180,0.95)';
  el.textContent = text;
}
function printProgress(pct) {
  var wrap = document.getElementById('print-progress');
  var bar = document.getElementById('print-progress-bar');
  if (wrap) wrap.style.display = 'block';
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function printProgressDone() {
  var wrap = document.getElementById('print-progress');
  var bar = document.getElementById('print-progress-bar');
  if (bar) bar.style.width = '0%';
  if (wrap) wrap.style.display = 'none';
}

function loadPrintTab() {
  // The book title is set on the Preview & Export tab and is read-only here;
  // mirror the current prep title (or campaign name) into this field.
  var _pbt = document.getElementById('print-book-title');
  if (_pbt) {
    var _prep = document.getElementById('prep-title');
    var _v = (_prep && _prep.value.trim()) || (state.currentCampaign && state.currentCampaign.name) || '';
    if (_v) _pbt.value = _v;
  }
  if (!state.currentCampaign) return;
  wirePrintOrderLock();
  showPrintMsg('', null);
  showPrintBtnMsg('', null);
  printProgressDone();
  (function(){
    var _trial = !!(state.user && state.user.tier === 'trial');
    var _pb = document.getElementById('print-place-btn');
    var _tn = document.getElementById('print-trial-notice');
    if (_pb) _pb.disabled = _trial;
    if (_tn) {
      _tn.style.display = _trial ? 'block' : 'none';
      if (_trial) _tn.innerHTML = "Free Trial books are watermarked, so they can't be ordered as physical prints. Upgrade to a paid plan to remove the watermark and order your book." + '<div style="margin-top:10px;"><button class="btn btn-primary btn-sm" onclick="goToPlans()">See plans</button></div>';
    }
  })();
  var q = document.getElementById('print-quote');
  if (q) q.textContent = '';
  fetch('/api/print/novel-info/' + state.currentCampaign.id)
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { showPrintMsg(res.j && res.j.error ? res.j.error : 'Could not load order options.', null); return; }
      printNovelInfo = res.j;
      syncPrintVersionDisplay();
      printActualPages = 0;
      printInteriorCache = { key: '', url: '', pages: 0 };
      updatePrintPageDisplay(-1, false);
      refreshPrintOptions(res.j.pageEstimate);
      prepareInteriorCount();
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
      var pp = document.getElementById('print-paper');
      function fill(el, arr) {
        if (!el) return;
        el.innerHTML = (arr || []).map(function (x) {
          return '<option value="' + x.id + '">' + escapeHtmlPrint(x.label) + '</option>';
        }).join('');
      }
      fill(b, o.bindings);
      fill(c, o.colorTiers);
      fill(f, o.coverFinishes);
      fill(pp, o.papers);
      if (o.default) {
        if (b && o.default.binding) b.value = o.default.binding;
        if (c && o.default.colorTier) c.value = o.default.colorTier;
        if (f && o.default.coverFinish) f.value = o.default.coverFinish;
        if (pp && o.default.paper) pp.value = o.default.paper;
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
    bookTitle: val('print-book-title'),
    sourceUserId: state.novelAsUser || null,
    pageCount: currentPageCount(),
    quantity: parseInt(val('print-qty'), 10) || 1,
    selection: {
      binding: val('print-binding'),
      colorTier: val('print-color'),
      coverFinish: val('print-finish'),
      paper: val('print-paper')
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
        if (res.j && res.j.details && res.j.details.join) msg += ' (' + res.j.details.join('; ') + ')';
        else if (res.j && res.j.detail) msg += ' (' + res.j.detail + ')';
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
// "Prepare Your Order" now builds the actual print-ready interior, shows a summary
// plus a link to PREVIEW that exact PDF, and requires an explicit confirm
// before the order is submitted. preparedInteriorUrl holds the generated file.
var preparedInteriorUrl = '';
var preparedCoverUrl = '';
var preparedSignature = '';
var printLockWired = false;

// A fingerprint of every order attribute that affects the printed files or the
// price. If this changes after the user has prepared an order, the prepared
// PDFs + quote are stale and must be rebuilt before the order can go through.
function printOrderSignature() {
  var b = printSelectionBody();
  if (!b) return '';
  return JSON.stringify(b) + '|' + printCoverUrl() + '|' + printInteriorUrl();
}

// Drop any prepared files/price and collapse the review + final-confirm panels,
// sending the user back to the Prepare Your Order step so the files and price rebuild
// from the current form. No-op if nothing was prepared yet.
function invalidatePreparedOrder() {
  var panel = document.getElementById('print-review');
  var reviewOpen = !!(panel && panel.style.display === 'block');
  if (!preparedInteriorUrl && !preparedCoverUrl && !reviewOpen) { preparedSignature = ''; return; }
  preparedInteriorUrl = '';
  preparedCoverUrl = '';
  preparedSignature = '';
  if (panel) panel.style.display = 'none';
  hideFinalConfirm();
  var place = document.getElementById('print-place-btn');
  if (place) { place.style.display = ''; place.disabled = false; place.textContent = 'Prepare Your Order'; }
  showPrintBtnMsg('Your order details changed. Click Prepare Your Order to rebuild your print files and update the price.', null);
}

// Attach change/input listeners to every order-affecting control once, so any
// edit invalidates a prepared order. Safe to call repeatedly (guarded).
function wirePrintOrderLock() {
  if (printLockWired) return;
  printLockWired = true;
  var ids = ['print-binding','print-color','print-finish','print-qty','print-book-title',
    'print-title-color','print-order-name','print-ship-name','print-ship-street1',
    'print-ship-street2','print-ship-city','print-ship-state','print-ship-postcode',
    'print-ship-country','print-ship-phone','print-ship-level'];
  ids.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', invalidatePreparedOrder);
    el.addEventListener('input', invalidatePreparedOrder);
  });
}

// True while a print order is in review/confirm (placed but not yet charged).
// Used to police layout changes that would make the ordered book diverge from
// what the user is looking at.
function orderInProgress() {
  if (preparedSignature) return true;
  var panel = document.getElementById('print-review');
  if (panel && panel.style.display === 'block') return true;
  return false;
}

// Refuse a novel-layout change while an order is in review. Returns true if it
// blocked the change (caller should return without applying it).
function blockLayoutChangeIfOrdering() {
  if (!orderInProgress()) return false;
  if (typeof showAlert === 'function') {
    showAlert('You have a print order in review. Open the Order tab and click Back to cancel it before changing the layout, or the book you order will not match what you see here.');
  }
  return true;
}

function printInteriorUrl() {
  // Same params the on-screen novel preview uses, so the printed interior
  // matches what the reader sees (the cover page is omitted server-side).
  return '/api/pdf/print-interior/' + state.currentCampaign.id +
    '?layout=' + encodeURIComponent(novelLayoutStyle) +
    '&bookTitle=' + encodeURIComponent((document.getElementById('print-book-title') || {}).value || '') +
    novelAsUserQ('&') + customOptsQ('novel', '&');
}

function printCoverUrl() {
  // The wrap cover is sized to the chosen format (binding + page count drive
  // the spine), so it carries the format selection + page count, plus co for
  // the Platinum hide-logo flag, plus as_user so a member's own cover art is used.
  var sel = printSelectionBody();
  var s = (sel && sel.selection) || {};
  var pc = currentPageCount();
  return '/api/pdf/print-cover/' + state.currentCampaign.id +
    '?binding=' + encodeURIComponent(s.binding || '') +
    '&color=' + encodeURIComponent(s.colorTier || '') +
    '&finish=' + encodeURIComponent(s.coverFinish || '') +
    '&paper=' + encodeURIComponent(s.paper || '') +
    '&pageCount=' + encodeURIComponent(pc) +
    '&bookTitle=' + encodeURIComponent((sel && sel.bookTitle) || '') +
    '&titleColor=' + encodeURIComponent((document.getElementById('print-title-color') || {}).value || '') +
    novelAsUserQ('&') + customOptsQ('novel', '&');
}

function reviewPrintOrder() {
  var body = printSelectionBody();
  if (!body || !body.selection.binding) { showPrintBtnMsg('Pick your format first.', null); return; }
  if (!body.shipTo.name || !body.shipTo.street1 || !body.shipTo.city || !body.shipTo.postcode) {
    showPrintBtnMsg('Please complete the shipping address.', null);
    return;
  }
  var btn = document.getElementById('print-place-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing your book...'; }
  showPrintBtnMsg('', null);
  printProgress(12);
  preparedCoverUrl = '';

  ensureInterior()
    .then(function (intr) {
      printProgress(45);
      preparedInteriorUrl = intr.url;
      if (intr.pages && intr.pages > 0) {
        printActualPages = intr.pages;
        body.pageCount = intr.pages;
        updatePrintPageDisplay(intr.pages, true);
      }
      return fetch(printCoverUrl())
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
    })
    .then(function (res) {
      if (!res.ok || !res.j || !res.j.url) {
        throw new Error(res.j && res.j.error ? res.j.error : 'Could not build the cover file.');
      }
      printProgress(72);
      preparedCoverUrl = res.j.url;
      return fetch('/api/print/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
    })
    .then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Prepare Your Order'; }
      if (!res.ok || !res.j) {
        printProgressDone();
        var msg = res.j && res.j.error ? res.j.error : 'Could not price this order.';
        if (res.j && res.j.details && res.j.details.join) msg += ' (' + res.j.details.join('; ') + ')';
        else if (res.j && res.j.detail) msg += ' (' + res.j.detail + ')';
        showPrintBtnMsg(msg, null);
        return;
      }
      printProgress(100);
      showPrintBtnMsg('', null);
      renderPrintReview(body, res.j);
      setTimeout(printProgressDone, 450);
    })
    .catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Prepare Your Order'; }
      printProgressDone();
      showPrintBtnMsg((e && e.message) ? e.message : 'Could not prepare your order.', null);
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
  if (prev) {
    prev.href = preparedInteriorUrl;
    prev.textContent = 'Preview your interior (opens the PDF in a new tab)';
    var oldCov = document.getElementById('print-review-cover-preview');
    if (oldCov && oldCov.parentNode) oldCov.parentNode.removeChild(oldCov);
    if (preparedCoverUrl) {
      var ca = document.createElement('a');
      ca.id = 'print-review-cover-preview';
      ca.href = preparedCoverUrl; ca.target = '_blank'; ca.rel = 'noopener';
      ca.textContent = 'Preview your cover (opens the PDF in a new tab)';
      ca.style.cssText = 'display:inline-block;margin-bottom:10px;margin-left:14px;font-size:13px;color:#7fb0e0;text-decoration:underline;';
      prev.insertAdjacentElement('afterend', ca);
    }
  }
  var place = document.getElementById('print-place-btn');
  if (place) place.style.display = 'none';
  hideFinalConfirm();
  preparedSignature = printOrderSignature();
  var _att = document.getElementById('print-attest');
  if (_att) _att.checked = false;
  updatePrintConfirmGate();
  panel.style.display = 'block';
  if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelPrintReview() {
  var panel = document.getElementById('print-review');
  if (panel) panel.style.display = 'none';
  var place = document.getElementById('print-place-btn');
  if (place) place.style.display = '';
  preparedSignature = '';
  showPrintBtnMsg('', null);
  printProgressDone();
}

function updatePrintConfirmGate() {
  var cb = document.getElementById('print-attest');
  var btn = document.getElementById('print-confirm-btn');
  if (btn) btn.disabled = !(cb && cb.checked);
}

function submitPrintOrder() {
  var body = printSelectionBody();
  if (!body || !body.selection.binding) { showPrintBtnMsg('Pick your format first.', null); return; }
  var _att = document.getElementById('print-attest');
  if (!_att || !_att.checked) { showPrintBtnMsg('Please confirm you have reviewed the interior and cover PDFs before continuing.', null); return; }
  if (preparedSignature && printOrderSignature() !== preparedSignature) {
    invalidatePreparedOrder();
    showPrintBtnMsg('Your order details changed. Click Prepare Your Order to rebuild your print files and update the price before ordering.', null);
    return;
  }
  body.interiorPdfUrl = preparedInteriorUrl || ((document.getElementById('print-interior-url') || {}).value || '');
  body.coverPdfUrl = preparedCoverUrl || ((document.getElementById('print-cover-url') || {}).value || '');
  if (!body.interiorPdfUrl) { showPrintBtnMsg('Your print file was not prepared. Please go Back and try again.', null); return; }
  if (!body.coverPdfUrl) { showPrintBtnMsg('Your cover file was not prepared. Please go Back and try again.', null); return; }
  var btn = document.getElementById('print-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting to payment...'; }
  fetch('/api/print/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j && res.j.url) { window.location = res.j.url; return; }
      if (btn) { btn.disabled = false; btn.textContent = 'Continue to secure payment'; }
      if (res.status === 503) { showPrintBtnMsg('Payments are being set up and will be available shortly.', null); return; }
      showPrintBtnMsg((res.j && (res.j.message || res.j.error)) ? (res.j.message || res.j.error) : 'Could not start payment.', null);
    })
    .catch(function () { if (btn) { btn.disabled = false; btn.textContent = 'Continue to secure payment'; } showPrintBtnMsg('Could not reach the payment service. Please try again.', null); });
}

// Final point-of-no-return gate. The first confirm button reveals this; only
// the button inside it actually submits and charges.
function showFinalConfirm() {
  var probe = {};
  var payErr = applyPaymentToBody(probe);
  if (payErr) { showPrintMsg(payErr, null); return; }
  var fc = document.getElementById('print-final-confirm');
  var cb = document.getElementById('print-confirm-btn');
  if (cb) cb.style.display = 'none';
  if (fc) {
    fc.style.display = 'block';
    if (fc.scrollIntoView) fc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function hideFinalConfirm() {
  var fc = document.getElementById('print-final-confirm');
  var cb = document.getElementById('print-confirm-btn');
  if (fc) fc.style.display = 'none';
  if (cb) cb.style.display = '';
}

// Return the Order tab to a clean state after a successful order so a new one
// can be started from scratch.
function resetPrintForm() {
  var ids = ['print-book-title','print-order-name','print-ship-name','print-ship-street1',
    'print-ship-street2','print-ship-city','print-ship-state','print-ship-postcode',
    'print-ship-country','print-ship-phone'];
  ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
  var qty = document.getElementById('print-qty'); if (qty) qty.value = '1';
  var tcol = document.getElementById('print-title-color'); if (tcol) tcol.value = '#f0d98a';
  var review = document.getElementById('print-review'); if (review) review.style.display = 'none';
  hideFinalConfirm();
  var place = document.getElementById('print-place-btn'); if (place) place.style.display = '';
  preparedInteriorUrl = '';
  preparedCoverUrl = '';
  preparedSignature = '';
  printActualPages = 0;
  printInteriorCache = { key: '', url: '', pages: 0 };
  if (printNovelInfo) {
    updatePrintPageDisplay(-1, false);
    refreshPrintOptions(printNovelInfo.pageEstimate);
  }
}

// ---- Stubbed payment helpers (Stripe replaces these later) -----------------
// We never transmit the full card number; only brand + last4 (+ exp) leave the
// browser. When Stripe lands, these fields become a Stripe Element and we send
// a PaymentMethod id instead.
function digitsOnly(s) {
  s = String(s == null ? '' : s);
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c >= '0' && c <= '9') out += c;
  }
  return out;
}

function guessCardBrand(num) {
  var f = String(num || '').charAt(0);
  if (f === '4') return 'Visa';
  if (f === '5') return 'Mastercard';
  if (f === '3') return 'Amex';
  if (f === '6') return 'Discover';
  return 'Card';
}

function maskedCard(brand, last4) {
  return (brand || 'Card') + ' ' + String.fromCharCode(8226, 8226, 8226, 8226) + (last4 || '');
}

function updatePaymentMode() {
  var fields = document.getElementById('print-pay-fields');
  var onfileWrap = document.getElementById('print-pay-onfile');
  var onfileRadio = document.getElementById('print-pay-onfile-radio');
  var onfileShown = onfileWrap && onfileWrap.style.display !== 'none';
  var useOnFile = onfileShown && onfileRadio && onfileRadio.checked;
  if (fields) fields.style.display = useOnFile ? 'none' : 'block';
}

function setupReviewPayment() {
  var onfileWrap = document.getElementById('print-pay-onfile');
  var label = document.getElementById('print-pay-onfile-label');
  var onfileRadio = document.getElementById('print-pay-onfile-radio');
  var newRadio = document.getElementById('print-pay-new-radio');
  if (onfileWrap) onfileWrap.style.display = 'none';
  if (newRadio) newRadio.checked = true;
  updatePaymentMode();
  fetch('/api/print/card')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.card && j.card.last4) {
        if (label) label.textContent = 'Use card on file (' + maskedCard(j.card.brand, j.card.last4) + ')';
        if (onfileWrap) onfileWrap.style.display = 'block';
        if (onfileRadio) onfileRadio.checked = true;
      }
      updatePaymentMode();
    })
    .catch(function () {});
}

// Reads the payment selection into the order body. Returns an error string, or
// null on success.
function applyPaymentToBody(body) {
  var onfileWrap = document.getElementById('print-pay-onfile');
  var onfileShown = onfileWrap && onfileWrap.style.display !== 'none';
  var onfileRadio = document.getElementById('print-pay-onfile-radio');
  if (onfileShown && onfileRadio && onfileRadio.checked) {
    body.useCardOnFile = true;
    return null;
  }
  var num = digitsOnly((document.getElementById('print-card-number') || {}).value);
  if (num.length < 12) return 'Enter a valid card number.';
  var exp = (((document.getElementById('print-card-exp') || {}).value) || '').trim();
  if (!exp) return 'Enter the card expiry (MM/YY).';
  body.card = { brand: guessCardBrand(num), last4: num.slice(-4), exp: exp };
  body.saveCard = !!((document.getElementById('print-card-save') || {}).checked);
  return null;
}

// ---- My Print Orders page --------------------------------------------------
function loadOrders() {
  var list = document.getElementById('orders-list');
  if (list) list.innerHTML = '<div class="settings-section-desc">Loading...</div>';
  fetch('/api/print/orders')
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!res.ok) { if (list) list.innerHTML = '<div class="settings-section-desc">Could not load your orders.</div>'; return; }
      renderOrders((res.j && res.j.orders) || []);
    })
    .catch(function () { if (list) list.innerHTML = '<div class="settings-section-desc">Could not load your orders.</div>'; });
}

function formatOrderDate(v) {
  try {
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) { return String(v); }
}

function orderStatusLabel(o) {
  var p = o.payment_status || 'pending';
  if (p === 'stubbed') p = 'test payment';
  return (o.status || 'pending') + ' / ' + p;
}

function renderOrders(orders) {
  var list = document.getElementById('orders-list');
  if (!list) return;
  if (!orders.length) {
    list.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;text-align:center;color:var(--text-muted);">You have not placed any print orders yet.</div>';
    return;
  }
  list.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;align-items:start;">' + orders.map(function (o) { return orderCardHtml(o); }).join('') + '</div>';
}

function orderCardHtml(o) {
  function esc(s) { return escapeHtmlPrint(s); }
  function row(label, value) {
    return '<div style="display:flex;flex-wrap:wrap;gap:4px 6px;padding:2px 0;font-size:12px;line-height:1.35;">' +
      '<span style="color:var(--text-muted);">' + esc(label) + ':</span>' +
      '<span style="color:var(--text);">' + esc(value) + '</span></div>';
  }
  var title = o.order_name || o.book_title || o.campaign_name || ('Order #' + o.id);
  var orderNo = o.external_id || ('po-' + o.id);
  var fmt = [o.binding, o.color_tier, o.cover_finish].filter(Boolean).join(', ');
  var charge = (o.customer_charge != null) ? ('$' + Number(o.customer_charge).toFixed(2) + ' ' + (o.currency || 'USD')) : '';
  var card = (o.card_brand && o.card_last4) ? maskedCard(o.card_brand, o.card_last4) : '';
  var when = o.created_at ? formatOrderDate(o.created_at) : '';
  var linkBase = 'color:var(--crimson);text-decoration:underline;font-size:12px;';
  var links = '';
  if (o.interior_pdf_url) links += '<a href="' + esc(o.interior_pdf_url) + '" target="_blank" rel="noopener" style="' + linkBase + 'margin-right:14px;">Interior PDF</a>';
  if (o.cover_pdf_url) links += '<a href="' + esc(o.cover_pdf_url) + '" target="_blank" rel="noopener" style="' + linkBase + 'margin-right:14px;">Cover PDF</a>';
  if (o.tracking_url) links += '<a href="' + esc(o.tracking_url) + '" target="_blank" rel="noopener" style="' + linkBase + '">Track shipment</a>';
  var html = '';
  html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:12px 14px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:1px;">';
  html += '<div style="font-weight:600;color:var(--text);font-size:15px;font-family:var(--font-display);">' + esc(title) + '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);">' + esc(when) + '</div>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--text-muted);letter-spacing:0.04em;margin-bottom:10px;">Order ' + esc(orderNo) + (o.provider_order_id ? (' &middot; Lulu ' + esc(o.provider_order_id)) : '') + '</div>';
  if (o.book_title && o.order_name) html += row('Book title', o.book_title);
  if (o.campaign_name && (o.order_name || o.book_title)) html += row('Campaign', o.campaign_name);
  if (o.source_kind === 'member' && o.source_user_name) html += row('Version', o.source_user_name + ' (player)');
  html += row('Format', fmt);
  if (o.page_count) html += row('Pages', String(o.page_count));
  html += row('Quantity', String(o.quantity || 1));
  if (charge) html += row('Total', charge);
  if (card) html += row('Paid with', card);
  if (o.ship_name) html += row('Ship to', o.ship_name);
  if (o.tracking_number) {
    html += row('Tracking', o.tracking_number + (o.carrier ? (' (' + o.carrier + ')') : ''));
  } else if (['paid','created','accepted','in_production'].indexOf(o.status) !== -1) {
    html += row('Tracking', 'Sent to Printer, Awaiting Tracking');
  }
  html += row('Status', orderStatusLabel(o));
  if (links) html += '<div style="margin-top:10px;">' + links + '</div>';
  html += '</div>';
  return html;
}

// ---- Novel session include + navigation (Sessions tab) ----
function novelIncluded(s) {
  return !(s && (s.novel_include === false || s.novel_include === 0 || s.novel_include === 'f' || s.novel_include === 'false'));
}

function toggleNovelInclude(sessionId, checked) {
  var isSM = !!(state.currentCampaign && state.currentCampaign.my_role === 'dm');
  var ep = isSM ? '/novel-include' : '/my-novel-include';
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + sessionId + ep, {
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

// ---- Admin: Signup bonus CO tokens to the Story Master (dashboard Settings tab) ----
function loadSignupBonus() {
  var inp = document.getElementById('signup-bonus-input');
  if (!inp) return;
  fetch('/api/admin/signup-bonus')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.signupBonusCot != null) inp.value = j.signupBonusCot; })
    .catch(function () {});
}

function saveSignupBonus() {
  var inp = document.getElementById('signup-bonus-input');
  var msg = document.getElementById('signup-bonus-msg');
  if (!inp) return;
  var n = parseInt(inp.value, 10);
  if (!isFinite(n) || n < 0) { if (msg) msg.textContent = 'Enter a whole number of 0 or more.'; return; }
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/signup-bonus', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signupBonusCot: n })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (msg) msg.textContent = res.ok ? 'Saved.' : (res.j && res.j.error ? res.j.error : 'Could not save.');
      if (res.ok && res.j && res.j.signupBonusCot != null) inp.value = res.j.signupBonusCot;
    })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

function sendEmailPreview() {
  var sel = document.getElementById("email-preview-select");
  var msg = document.getElementById("email-preview-msg");
  if (!sel) return;
  var type = sel.value;
  if (msg) msg.textContent = "Sending...";
  fetch("/api/email/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: type })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (!msg) return;
      if (res.ok && res.j && res.j.success) { msg.textContent = "Sent to " + (res.j.sentTo || "your email") + "."; }
      else { msg.textContent = (res.j && res.j.error) ? res.j.error : "Could not send."; }
    })
    .catch(function () { if (msg) msg.textContent = "Could not send."; });
}

function loadGenerationSettings() {
  var el = document.getElementById('gen-story-wpt');
  if (!el) return;
  fetch('/api/admin/generation-settings')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var g = function(id){ return document.getElementById(id); };
      if (g('gen-story-wpt')) g('gen-story-wpt').value = j.storyWordsPerToken;
      if (g('gen-story-floor')) g('gen-story-floor').value = j.storyFloor;
      if (g('gen-narr-ppt')) g('gen-narr-ppt').value = j.narrativePanelsPerToken;
      if (g('gen-narr-floor')) g('gen-narr-floor').value = j.narrativeFloor;
      if (g('transcript-cache-ttl')) g('transcript-cache-ttl').value = (j.transcriptCacheTtl === '1h') ? '1h' : '5m';
    })
    .catch(function () {});
}

function saveGenerationSettings() {
  var g = function(id){ return document.getElementById(id); };
  var iv = function(id){ var n = parseInt((g(id)||{}).value, 10); return (isFinite(n) && n >= 0) ? n : 0; };
  var msg = g('gen-settings-msg');
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/generation-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storyWordsPerToken: iv('gen-story-wpt'),
      storyFloor: iv('gen-story-floor'),
      narrativePanelsPerToken: iv('gen-narr-ppt'),
      narrativeFloor: iv('gen-narr-floor'),
      transcriptCacheTtl: (g('transcript-cache-ttl') && g('transcript-cache-ttl').value === '1h') ? '1h' : '5m'
    })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { if (msg) msg.textContent = res.ok ? 'Saved.' : ((res.j && res.j.error) ? res.j.error : 'Could not save.'); if (res.ok) loadGenerationSettings(); })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

function loadHelpEmailSettings() {
  var a = document.getElementById('help-aidone-toggle');
  var l = document.getElementById('help-logout-toggle');
  if (!a && !l) return;
  fetch('/api/admin/help-email-settings')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (!j) return; if (a) a.checked = !!j.aiDone; if (l) l.checked = !!j.logout; })
    .catch(function () {});
}

function saveHelpEmailSettings() {
  var a = document.getElementById('help-aidone-toggle');
  var l = document.getElementById('help-logout-toggle');
  var msg = document.getElementById('help-email-msg');
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/help-email-settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiDone: !!(a && a.checked), logout: !!(l && l.checked) })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (msg) msg.textContent = res.ok ? 'Saved.' : ((res.j && res.j.error) ? res.j.error : 'Could not save.');
      if (res.ok && res.j) { if (a) a.checked = !!res.j.aiDone; if (l) l.checked = !!res.j.logout; }
    })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

// ---- Admin: Account lifecycle (config + test tools) ----
function loadLifecycleConfig() {
  var idle = document.getElementById('lifecycle-idle-input');
  var purge = document.getElementById('lifecycle-purge-input');
  if (!idle || !purge) return;
  fetch('/api/admin/lifecycle-config')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j) { if (j.idle_days != null) idle.value = j.idle_days; if (j.purge_days != null) purge.value = j.purge_days; var g = document.getElementById('lifecycle-grace-input'); if (g && j.grace_days != null) g.value = j.grace_days; var pw = document.getElementById('lifecycle-purgewarn-input'); if (pw && j.purge_warn_days != null) pw.value = j.purge_warn_days; } })
    .catch(function () {});
}

function saveLifecycleConfig() {
  var idle = document.getElementById('lifecycle-idle-input');
  var purge = document.getElementById('lifecycle-purge-input');
  var msg = document.getElementById('lifecycle-config-msg');
  if (!idle || !purge) return;
  var graceEl = document.getElementById('lifecycle-grace-input');
  var i = parseInt(idle.value, 10), pp = parseInt(purge.value, 10), gg = parseInt(graceEl && graceEl.value, 10);
  if (!isFinite(i) || i < 1 || !isFinite(pp) || pp < 1 || !isFinite(gg) || gg < 1) { if (msg) msg.textContent = 'Enter whole numbers of 1 or more.'; return; }
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/lifecycle-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idle_days: i, purge_days: pp, grace_days: gg, purge_warn_days: (document.getElementById('lifecycle-purgewarn-input') || {}).value || '' })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (res.ok && res.j) { idle.value = res.j.idle_days; purge.value = res.j.purge_days; if (graceEl && res.j.grace_days != null) graceEl.value = res.j.grace_days; var pwEl = document.getElementById('lifecycle-purgewarn-input'); if (pwEl && res.j.purge_warn_days != null) pwEl.value = res.j.purge_warn_days; if (msg) msg.textContent = 'Saved.'; }
      else if (msg) msg.textContent = (res.j && res.j.error) || 'Could not save.';
    })
    .catch(function () { if (msg) msg.textContent = 'Could not save.'; });
}

function _lifecycleTestOut(obj) {
  var out = document.getElementById('lifecycle-test-output');
  if (!out) return;
  out.style.display = 'block';
  out.textContent = (typeof obj === 'string') ? obj : JSON.stringify(obj, null, 2);
}

function stageIdleUser() {
  var emailEl = document.getElementById('lifecycle-test-email');
  var email = emailEl ? emailEl.value : '';
  if (!email) { _lifecycleTestOut('Enter a user email first.'); return; }
  var daysEl = document.getElementById('lifecycle-test-days');
  var days = parseInt(daysEl && daysEl.value, 10); if (!isFinite(days) || days < 0) days = 0;
  var iso = new Date(Date.now() - days * 86400000).toISOString();
  _lifecycleTestOut('Staging ' + email + ' as lone copper idle ' + days + ' days...');
  fetch('/api/admin/lifecycle/set-user-dates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, tier: 'copper', status: 'active', last_active_at: iso, lone_since: iso, last_purchase_at: iso, idle_warned_at: '', suspended_at: '' })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { _lifecycleTestOut(res.j); })
    .catch(function () { _lifecycleTestOut('Could not stage user.'); });
}

function stageWarnedUser() {
  var emailEl = document.getElementById('lifecycle-test-email');
  var email = emailEl ? emailEl.value : '';
  if (!email) { _lifecycleTestOut('Enter a user email first.'); return; }
  var wEl = document.getElementById('lifecycle-test-warned');
  var warnedDays = parseInt(wEl && wEl.value, 10); if (!isFinite(warnedDays) || warnedDays < 0) warnedDays = 0;
  var idleIso = new Date(Date.now() - 730 * 86400000).toISOString();
  var warnedIso = new Date(Date.now() - warnedDays * 86400000).toISOString();
  _lifecycleTestOut('Staging ' + email + ' as warned lone copper (warned ' + warnedDays + ' days ago)...');
  fetch('/api/admin/lifecycle/set-user-dates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, tier: 'copper', status: 'active', last_active_at: idleIso, lone_since: idleIso, last_purchase_at: idleIso, idle_warned_at: warnedIso, suspended_at: '' })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { _lifecycleTestOut(res.j); })
    .catch(function () { _lifecycleTestOut('Could not stage user.'); });
}

function stageSuspendedUser() {
  var emailEl = document.getElementById('lifecycle-test-email');
  var email = emailEl ? emailEl.value : '';
  if (!email) { _lifecycleTestOut('Enter a user email first.'); return; }
  var sEl = document.getElementById('lifecycle-test-suspended');
  var suspDays = parseInt(sEl && sEl.value, 10); if (!isFinite(suspDays) || suspDays < 0) suspDays = 0;
  var oldIso = new Date(Date.now() - 730 * 86400000).toISOString();
  var suspIso = new Date(Date.now() - suspDays * 86400000).toISOString();
  _lifecycleTestOut('Staging ' + email + ' as suspended (' + suspDays + ' days ago)...');
  fetch('/api/admin/lifecycle/set-user-dates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, tier: 'copper', status: 'suspended', last_active_at: oldIso, lone_since: oldIso, last_purchase_at: oldIso, idle_warned_at: oldIso, suspended_at: suspIso })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { _lifecycleTestOut(res.j); })
    .catch(function () { _lifecycleTestOut('Could not stage user.'); });
}

function runSweepNow() {
  var dry = document.getElementById('lifecycle-dryrun');
  _lifecycleTestOut('Running sweep...');
  fetch('/api/admin/lifecycle/run-sweep', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: !!(dry && dry.checked) })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) { _lifecycleTestOut(res.j); })
    .catch(function () { _lifecycleTestOut('Sweep request failed.'); });
}

// ---- Admin: Max Pages Per Print (dashboard Settings tab) ----
function loadMaxPagesPerPrint() {
  var inp = document.getElementById('max-pages-input');
  if (!inp) return;
  fetch('/api/admin/print-page-limit')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.maxPagesPerPrint != null) inp.value = j.maxPagesPerPrint; })
    .catch(function () {});
}

function saveMaxPagesPerPrint() {
  var inp = document.getElementById('max-pages-input');
  var msg = document.getElementById('max-pages-msg');
  if (!inp) return;
  var n = parseInt(inp.value, 10);
  if (!isFinite(n) || n < 1) { if (msg) msg.textContent = 'Enter a whole number of 1 or more.'; return; }
  if (msg) msg.textContent = 'Saving...';
  fetch('/api/admin/print-page-limit', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxPagesPerPrint: n })
  }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (res) {
      if (msg) msg.textContent = res.ok ? 'Saved.' : (res.j && res.j.error ? res.j.error : 'Could not save.');
      if (res.ok && res.j && res.j.maxPagesPerPrint != null) inp.value = res.j.maxPagesPerPrint;
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

// ============================================================
// SECTION BACK NAVIGATION
// Remembers the view you were on before opening Asset Library or
// Archives, so a Back button returns you exactly where you were
// (re-opening the same session if that is where you came from).
// ============================================================
var _sectionBackFrom = null;
function _visibleViewId() {
  var ids = ['session-detail','sessions','characters','assets','novel','members','archives','campaigns','account','settings','orders'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById('view-' + ids[i]);
    if (el && el.style.display === 'block') return ids[i];
  }
  return null;
}
function sectionBack() {
  var t = _sectionBackFrom || 'sessions';
  if (t === 'session-detail') {
    // selectSession() only hides a partial set of views, which left the
    // Asset/Archive view stacked above the session. The detail DOM is still
    // populated (it was only hidden), so just hide every view and reveal it.
    if (!(state.currentSession && state.currentSession.id)) { showCampaignSection('sessions'); return; }
    var ids = ['campaigns','sessions','characters','assets','novel','members','archives','orders','account','settings'];
    ids.forEach(function(v){ var el = document.getElementById('view-' + v); if (el) el.style.display = 'none'; });
    var d = document.getElementById('view-session-detail'); if (d) d.style.display = 'block';
    state.currentView = 'session-detail';
    document.querySelectorAll('.sidebar-item').forEach(function(el){ el.classList.remove('active'); });
    var _sx = document.getElementById('snav-sessions'); if (_sx) _sx.classList.add('active');
    var _cs = document.getElementById('campaign-subnav'); if (_cs) _cs.style.display = 'block';
    if (state.currentCampaign) { var _scn = document.getElementById('sidebar-campaign-name'); if (_scn) _scn.textContent = state.currentCampaign.name; }
    if (state.currentCampaign && state.currentSession) {
      setBreadcrumb([
        {label:'My Campaigns', action:"showView('campaigns')"},
        {label:state.currentCampaign.name, action:"showCampaignSection('sessions')"},
        {label:'Sessions', action:"showCampaignSection('sessions')"},
        {label:(state.currentSession.name || 'Session')}
      ]);
    }
    if (typeof applyRoleVisibility === 'function') applyRoleVisibility();
    return;
  }
  showCampaignSection(t);
}

// Copper (free) plan cannot create campaigns or sessions -- prompt to upgrade.
function blockCopperCreate(kind) {
  if (state.user && state.user.tier === 'copper') {
    var what = (kind === 'session') ? 'sessions' : 'campaigns';
    uiConfirm('Creating ' + what + ' is not available on the Copper plan. Upgrade to a paid plan to continue.', { okText: 'See plans', cancelText: 'Not now' }).then(function(go){ if (go) goToPlans(); });
    return true;
  }
  return false;
}

// Read a moment layout prominence (1-5) from its layout_meta JSON; default 3.
// Mirrors lmProminence in routes/pdf.js so the storyboard and PDF agree.
function momProminence(m) {
  try {
    var meta = m && m.layout_meta;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    var n = meta ? Number(meta.prominence) : NaN;
    return (n >= 1 && n <= 5) ? Math.round(n) : 3;
  } catch (e) { return 3; }
}
function setMomentProminence(momentId, value) {
  var moment = (state.moments || []).find(function(m){ return m.id === momentId; });
  if (!moment || !state.currentCampaign || !state.currentSession) return;
  var v = parseInt(value, 10); if (!(v >= 1 && v <= 5)) v = 3;
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/moments/' + momentId + '/prominence', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prominence: v })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) { moment.layout_meta = d.layout_meta; }
      else { billingToast((d && (d.error || d.message)) || 'Could not update prominence.', 'error'); }
    })
    .catch(function(){ billingToast('Could not update prominence.', 'error'); });
}

// ============================================================
// STORYBOARD per-moment OPTIONS panel (cast + prominence).
// The ... button on each panel expands an inline strip that mirrors the
// Review casting block, so users do not have to bounce to the Review tab.
// ============================================================
function canEditCurrentVersion() {
  var role = state.currentCampaign && state.currentCampaign.my_role;
  return (role === 'dm' && !state.currentForkId) ||
    (role === 'player' && !!(state.currentForkId && state.myForkId && String(state.currentForkId) === String(state.myForkId)));
}
// Lazy-load the review payload (cast per panel + character/asset master lists)
// once; one fetch covers every panel in the session.
function _reviewCtxKey() {
  return (state.currentSession && state.currentSession.id) + ':' + (state.currentForkId == null ? 'dm' : state.currentForkId);
}
function ensureReviewData(cb, wantMomentId) {
  // Cache is valid only for the session/fork it was built for; a context switch
  // (or a regen that mints new moment ids) is treated as a miss so we refetch.
  var _key = _reviewCtxKey();
  var _fresh = !!(state.reviewData && state.reviewData.panels && state.reviewDataKey === _key);
  var _hasMoment = _fresh && (wantMomentId == null ||
    state.reviewData.panels.some(function(p){ return String(p.moment_id) === String(wantMomentId); }));
  if (_fresh && _hasMoment) { cb(); return; }
  if (!state.currentCampaign || !state.currentSession) { cb(); return; }
  fetch('/api/campaigns/' + state.currentCampaign.id + '/sessions/' + state.currentSession.id + '/review' + forkQ())
    .then(function(r){ return r.json(); })
    .then(function(data){ state.reviewData = data || {}; state.reviewDataKey = _key; cb(); })
    .catch(function(){ cb(); });
}
function toggleMomentOptions(momentId) {
  var box = document.getElementById('moment-options-' + momentId);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="moment-opts-loading">Loading...</div>';
  ensureReviewData(function(){ renderMomentOptions(momentId); }, momentId);
}
function _refreshOpenMomentOptions(momentId) {
  var box = document.getElementById('moment-options-' + momentId);
  if (box && box.style.display === 'block') renderMomentOptions(momentId);
}
function renderMomentOptions(momentId) {
  var box = document.getElementById('moment-options-' + momentId);
  if (!box) return;
  var canEdit = canEditCurrentVersion();
  var ACAT = { location: 'Location', npc: 'NPC', item: 'Item' };
  var p = _reviewPanel(momentId);
  var castHtml;
  if (!p) {
    castHtml = '<div class="moment-opts-note">Cast will appear once this version has a saved storyboard.</div>';
  } else {
    var charChips = (p.characters || []).map(function(c){
      var rm = canEdit ? '<button class="review-chip-x" title="Remove" onclick="castRemoveCharacter(' + momentId + ', ' + c.id + ')">&#215;</button>' : '';
      return '<span class="review-chip">' + escapeHtmlReview(charDisplayName(c.name)) + rm + '</span>';
    }).join();
    if (!(p.characters || []).length) charChips = '<span class="review-none">none</span>';
    var assetChips = (p.assets || []).map(function(a){
      var rm = canEdit ? '<button class="review-chip-x" title="Remove" onclick="castRemoveAsset(' + momentId + ', ' + a.id + ')">&#215;</button>' : '';
      return '<span class="review-chip review-chip-asset">' + escapeHtmlReview(a.name) + ' &#183; ' + (ACAT[a.category] || a.category) + rm + '</span>';
    }).join();
    if (!(p.assets || []).length) assetChips = '<span class="review-none">none</span>';
    var addChar = '', addAsset = '';
    if (canEdit) {
      var haveC = {}; (p.characters || []).forEach(function(c){ haveC[String(c.id)] = true; });
      var optsC = ((state.reviewData && state.reviewData.all_characters) || []).filter(function(c){ return !haveC[String(c.id)]; }).map(function(c){ return '<option value="' + c.id + '">' + escapeHtmlReview(charDisplayName(c.name)) + '</option>'; }).join('');
      addChar = '<button class="review-add-btn" onclick="openCastPicker(\'character\', ' + momentId + ')">+ Add character</button>';
      var haveA = {}; (p.assets || []).forEach(function(a){ haveA[String(a.id)] = true; });
      var optsA = ((state.reviewData && state.reviewData.all_assets) || []).filter(function(a){ return !haveA[String(a.id)]; }).map(function(a){ return '<option value="' + a.id + '">' + escapeHtmlReview(a.name) + ' &#183; ' + (ACAT[a.category] || a.category) + '</option>'; }).join('');
      addAsset = '<button class="review-add-btn" onclick="openCastPicker(\'asset\', ' + momentId + ')">+ Add asset</button>';
    }
    var badge = p.cast_explicit ? '<span class="review-cast-badge is-custom">Custom cast</span>' : '<span class="review-cast-badge">Auto-Matched</span>';
    var resetBtn = (canEdit && p.cast_explicit) ? '<button class="review-reset-btn" onclick="castReset(' + momentId + ')" title="Drop back to automatic name-matching">Reset to auto</button>' : '';
    castHtml = '<div class="moment-opts-casthead">' + badge + resetBtn + '</div>' +
      '<div class="review-row"><span class="review-label">Characters:</span> ' + charChips + ' ' + addChar + '</div>' +
      '<div class="review-row"><span class="review-label">Assets:</span> ' + assetChips + ' ' + addAsset + '</div>';
  }
  var m = (state.moments || []).find(function(x){ return x.id === momentId; });
  var prom = m ? momProminence(m) : 3;
  // Map the stored 1-5 value into the 3-way control: Minimize / Default / Maximize.
  var ptier = (prom >= 4) ? 5 : (prom <= 2 ? 1 : 3);
  var POPTS = [[1, 'Minimize'], [3, 'Default'], [5, 'Maximize']];
  var plabel = (ptier === 5) ? 'Maximize' : (ptier === 1 ? 'Minimize' : 'Default');
  var promHtml;
  if (canEdit) {
    var po = '';
    for (var pi = 0; pi < POPTS.length; pi++) { po += '<option value="' + POPTS[pi][0] + '"' + (POPTS[pi][0] === ptier ? ' selected' : '') + '>' + POPTS[pi][1] + '</option>'; }
    promHtml = '<div class="review-row"><span class="review-label">Prominence:</span> <select class="moment-prom-select" onchange="setMomentProminence(' + momentId + ', this.value)">' + po + '</select> <span class="moment-opts-hint">how big this panel gets in the comic, magazine &amp; picture book layouts</span></div>';
  } else {
    promHtml = '<div class="review-row"><span class="review-label">Prominence:</span> ' + plabel + '</div>';
  }
  box.innerHTML = '<div class="moment-opts-inner">' + castHtml + promHtml + '</div>';
}

// Mobile: in Quick View the preview iframe renders the print-width (8.5in) HTML,
// which overflows a phone. Same-origin, so on a narrow screen we zoom the iframe
// body to fit its width. True View (PDF) and desktop are left untouched.
function _fitPreviewMobile(iframeId, isQuickView) {
  try {
    if (!isQuickView) return;
    if ((window.innerWidth || 9999) > 640) return;
    var ifr = document.getElementById(iframeId);
    if (!ifr) return;
    var doc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
    if (!doc || !doc.body) return;
    var avail = ifr.clientWidth || ifr.offsetWidth || window.innerWidth;
    var bookW = 816;
    doc.body.style.zoom = (avail && avail < bookW) ? String(avail / bookW) : "";
  } catch (e) {}
}

// ============================================================
// GUIDED TOURS ENGINE (data-driven; steps in public/tours.json)
// Self-contained: module-level state, hoisted fns. maybeStartTour(view)
// is called from showView. Never throws into navigation.
// ============================================================
var _toursData = null;
var _tourProgress = null;
var _tourActive = false;
var _tourSteps = [];
var _tourIdx = 0;
var _tourViewId = '';
var _tourCurEl = null;
var _tourCurStep = null;
var _tourPanelEl = null;
var _tourShownAny = false;

function _tourEnsureData(cb) {
  if (_toursData) { cb(); return; }
  fetch('/api/auth/tours')
    .then(function(r){ return r.json(); })
    .then(function(d){ _toursData = (d && d.tours) ? d.tours : {}; cb(); })
    .catch(function(){ _toursData = {}; cb(); });
}

function _tourEnsureProgress(cb) {
  if (_tourProgress) { cb(); return; }
  fetch('/api/auth/tour-progress')
    .then(function(r){ return r.json(); })
    .then(function(d){ _tourProgress = (d && d.progress) ? d.progress : {}; cb(); })
    .catch(function(){ _tourProgress = {}; cb(); });
}

function _tourStepsFor(viewId) {
  var t = _toursData && _toursData[viewId];
  return (t && Array.isArray(t.steps)) ? t.steps : [];
}

var VOCAB_MAP = {
  ttrpg: { campaign: 'campaign', campaigns: 'campaigns', session: 'session', sessions: 'sessions' },
  story: { campaign: 'story', campaigns: 'stories', session: 'chapter', sessions: 'chapters' }
};
function applyVocab(s) {
  if (!s) return s;
  var v = (typeof state !== 'undefined' && state.user && state.user.vocab) || 'ttrpg';
  var m = VOCAB_MAP[v] || VOCAB_MAP.ttrpg;
  return String(s).replace(/\{(Campaigns?|Sessions?|campaigns?|sessions?)\}/g, function(full, tok) {
    var lower = tok.toLowerCase();
    var word = m[lower] || lower;
    if (tok.charAt(0) !== tok.charAt(0).toLowerCase()) word = word.charAt(0).toUpperCase() + word.slice(1);
    return word;
  });
}

function maybeStartTour(viewId) {
  if (_tourActive || !viewId) return;
  _tourEnsureData(function(){
    var _t = _toursData && _toursData[viewId];
    if (!_t || !Array.isArray(_t.steps) || _t.steps.length === 0) return;
    var _go = function() {
      _tourEnsureProgress(function(){
        if (_tourProgress[viewId]) return;
        startTour(viewId, false);
      });
    };
    if (_t.requires) {
      // Data gate: wait (retry) for the required element; if it never appears, defer silently (do NOT mark seen).
      _tourFindTarget(_t.requires, 8, function(rq){ if (_tourVisible(rq)) _go(); });
    } else {
      _go();
    }
  });
}

function showTour(viewId) {
  if (_tourActive) { try { _tourTeardown(); } catch (e) {} }
  _tourEnsureData(function(){
    if (_tourStepsFor(viewId).length === 0) return;
    startTour(viewId, true);
  });
}

function _activeSessionTab() {
  var ids = ['notes', 'characters', 'review', 'storyboard', 'export'];
  for (var i = 0; i < ids.length; i++) {
    var e = document.getElementById('stab-' + ids[i]);
    if (e && e.classList.contains('active')) return ids[i];
  }
  return 'notes';
}

function tourKeyForView() {
  var v = (window.state && state.currentView) || 'campaigns';
  if (v === 'session-detail') return 'sess-' + _activeSessionTab();
  return v;
}

function startTour(viewId, manual) {
  _tourViewId = viewId;
  _tourSteps = _tourStepsFor(viewId);
  if (_tourSteps.length === 0) return;
  _tourIdx = 0;
  _tourShownAny = false;
  _tourActive = true;
  var ov = document.getElementById('tour-overlay');
  if (ov) { ov.classList.remove('hidden'); ov.setAttribute('aria-hidden','false'); }
  document.addEventListener('keydown', _tourKey);
  window.addEventListener('resize', _tourReposition);
  window.addEventListener('scroll', _tourReposition, true);
  _tourRenderStep();
}

function _tourKey(e) {
  if (!_tourActive) return;
  if (e.key === 'Escape') { tourSkip(); }
  else if (e.key === 'Enter') { tourNext(); }
}

function _tourRenderStep() {
  var step = _tourSteps[_tourIdx];
  if (!step) { if (_tourShownAny) { _tourFinish(); } else { _tourTeardown(); } return; }
  if (step.dmOnly && !(state.currentCampaign && state.currentCampaign.my_role === 'dm')) { _tourIdx++; _tourRenderStep(); return; }
  var titleEl = document.getElementById('tour-tip-title');
  var textEl = document.getElementById('tour-tip-text');
  var countEl = document.getElementById('tour-tip-count');
  var nextEl = document.getElementById('tour-btn-next');
  if (titleEl) titleEl.textContent = applyVocab(step.title || '');
  if (textEl) textEl.textContent = applyVocab(step.text || '');
  if (countEl) countEl.textContent = 'Step ' + (_tourIdx + 1) + ' of ' + _tourSteps.length;
  if (nextEl) nextEl.textContent = (_tourIdx === _tourSteps.length - 1) ? 'Done' : 'Next';
  var _find = function() {
    _tourFindTarget(step.selector, 8, function(el){
      if (step.selector && !_tourVisible(el)) { _tourIdx++; _tourRenderStep(); return; }
      _tourPlace(el, step);
      _tourScheduleSettle();
    });
  };
  if (step.click) {
    try { var _ce = document.querySelector(step.click); if (_ce) _ce.click(); } catch (e) {}
    setTimeout(_find, 160);
  } else {
    _find();
  }
}

function _tourVisible(el) {
  if (!el) return false;
  if (el.getClientRects().length === 0) return false;
  var cs = window.getComputedStyle(el);
  if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
  return true;
}

function _tourFindTarget(selector, tries, cb) {
  var el = null;
  try { el = selector ? document.querySelector(selector) : null; } catch(e) { el = null; }
  if (el || tries <= 0) { cb(el); return; }
  setTimeout(function(){ _tourFindTarget(selector, tries - 1, cb); }, 80);
}

function _tourPlace(el, step) {
  _tourCurEl = el; _tourCurStep = step;
  _tourShownAny = true;
  if (_tourPanelEl) { try { _tourPanelEl.classList.remove('tour-show-pills'); } catch (e) {} _tourPanelEl = null; }
  if (el && el.closest) { try { var _sp = el.closest('.storyboard-panel'); if (_sp) { _sp.classList.add('tour-show-pills'); _tourPanelEl = _sp; } } catch (e) {} }
  var ov = document.getElementById('tour-overlay');
  var hl = document.getElementById('tour-highlight');
  var tip = document.getElementById('tour-tip');
  if (!ov || !hl || !tip) return;
  if (!el) {
    ov.classList.add('no-target');
    var w = tip.offsetWidth || 320, h = tip.offsetHeight || 160;
    tip.style.left = Math.max(12, (window.innerWidth - w) / 2) + 'px';
    tip.style.top = Math.max(12, (window.innerHeight - h) / 2) + 'px';
    return;
  }
  ov.classList.remove('no-target');
  var r = el.getBoundingClientRect();
  var pad = 6;
  hl.style.top = Math.max(0, r.top - pad) + 'px';
  hl.style.left = Math.max(0, r.left - pad) + 'px';
  hl.style.width = (r.width + pad * 2) + 'px';
  hl.style.height = (r.height + pad * 2) + 'px';
  var tw = tip.offsetWidth || 320, th = tip.offsetHeight || 160;
  var place = step.placement || 'auto';
  var ttop, tleft;
  if (place === 'left') {
    tleft = Math.max(12, r.left - tw - 14);
    ttop = Math.min(window.innerHeight - th - 12, Math.max(12, r.top));
  } else {
    tleft = Math.min(window.innerWidth - tw - 12, Math.max(12, r.left));
    if (r.bottom + 14 + th < window.innerHeight) { ttop = r.bottom + 14; }
    else if (r.top - 14 - th > 0) { ttop = r.top - 14 - th; }
    else { ttop = Math.max(12, window.innerHeight - th - 12); }
  }
  tip.style.left = tleft + 'px';
  tip.style.top = ttop + 'px';
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch(e) {}
}

function _tourReposition() {
  if (!_tourActive) return;
  _tourPlace(_tourCurEl, _tourCurStep || {});
}

function _tourScheduleSettle() {
  // Re-position after layout settles (title/images/fonts can reflow and move the target).
  if (window.requestAnimationFrame) { requestAnimationFrame(function(){ _tourReposition(); }); }
  setTimeout(function(){ _tourReposition(); }, 180);
  setTimeout(function(){ _tourReposition(); }, 450);
}

function tourNext() {
  if (!_tourActive) return;
  if (_tourIdx >= _tourSteps.length - 1) { _tourFinish(); return; }
  _tourIdx++;
  _tourRenderStep();
}

function tourSkip() {
  if (!_tourActive) return;
  _tourFinish();
}

function _tourFinish() {
  var viewId = _tourViewId;
  _tourTeardown();
  _tourMarkComplete(viewId);
}

function _tourTeardown() {
  _tourActive = false;
  var ov = document.getElementById('tour-overlay');
  if (ov) { ov.classList.add('hidden'); ov.classList.remove('no-target'); ov.setAttribute('aria-hidden','true'); }
  document.removeEventListener('keydown', _tourKey);
  window.removeEventListener('resize', _tourReposition);
  window.removeEventListener('scroll', _tourReposition, true);
  if (_tourPanelEl) { try { _tourPanelEl.classList.remove('tour-show-pills'); } catch (e) {} _tourPanelEl = null; }
  _tourCurEl = null; _tourCurStep = null;
}

function _tourMarkComplete(viewId) {
  if (!viewId) return;
  if (_tourProgress) _tourProgress[viewId] = true;
  fetch('/api/auth/tour-complete', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewId: viewId })
  }).catch(function(){});
}

// Testing helper: clear this account's tour history (self only) and reset the
// client cache so tours fire again immediately. Backed by /api/auth/tour-reset.
function devClearTours() {
  var msg = document.getElementById('dev-tours-msg');
  fetch('/api/auth/tour-reset', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) {
        _tourProgress = {};
        if (msg) msg.textContent = 'Tour history cleared. Visit any screen to see its tour again.';
      } else {
        if (msg) msg.textContent = (d && d.error) ? d.error : 'Could not clear.';
      }
    })
    .catch(function(){ if (msg) msg.textContent = 'Could not clear.'; });
}

// Account-facing: re-enable guided tours by clearing this account's seen-history
// (same endpoint as the dev reset). Each screen's tour then auto-plays once on the
// next visit and re-marks itself complete, so they settle down on their own.
function replayTours() {
  var msg = document.getElementById('tours-replay-msg');
  if (msg) { msg.style.display = 'block'; msg.style.color = ''; msg.textContent = 'Turning tours back on...'; }
  fetch('/api/auth/tour-reset', { method: 'POST' })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) {
        _tourProgress = {};
        if (msg) { msg.style.color = 'var(--gold-light)'; msg.textContent = 'Guided tours are back on. Visit any screen to see its tour again.'; }
      } else {
        if (msg) { msg.style.color = '#c0392b'; msg.textContent = (d && d.error) ? d.error : 'Could not turn tours back on. Please try again.'; }
      }
    })
    .catch(function(){ if (msg) { msg.style.color = '#c0392b'; msg.textContent = 'Could not turn tours back on. Please try again.'; } });
}

// ===== Cast picker modal: image grid (replaces the +Add character/asset dropdowns) =====
var _castCharImg = {};
var _castAssetImg = {};

function _loadCastImages(cb) {
  var cid = state.currentCampaign && state.currentCampaign.id;
  _castCharImg = {}; _castAssetImg = {};
  if (!cid) { cb(); return; }
  var done = 0;
  function step(){ if (++done >= 2) cb(); }
  fetch('/api/campaigns/' + cid + '/characters').then(function(r){ return r.json(); }).then(function(rows){ (Array.isArray(rows)?rows:[]).forEach(function(c){ if (c && c.id != null) _castCharImg[String(c.id)] = c.canonical_reference_url || ''; }); step(); }).catch(step);
  fetch('/api/campaigns/' + cid + '/assets').then(function(r){ return r.json(); }).then(function(rows){ (Array.isArray(rows)?rows:[]).forEach(function(a){ if (a && a.id != null) _castAssetImg[String(a.id)] = a.image_url || ''; }); step(); }).catch(step);
}

function openCastPicker(kind, momentId) {
  if (!state.currentCampaign) return;
  if (!_reviewPanel(momentId)) return;
  _loadCastImages(function(){ _buildCastPicker(kind, momentId); });
}

function _buildCastPicker(kind, momentId) {
  closeCastPicker();
  var p = _reviewPanel(momentId); if (!p) return;
  var isChar = (kind === 'character');
  var ACAT = { location: 'Location', npc: 'NPC', item: 'Item' };
  var have = {};
  (isChar ? (p.characters || []) : (p.assets || [])).forEach(function(x){ have[String(x.id)] = true; });
  var src = isChar ? ((state.reviewData && state.reviewData.all_characters) || []) : ((state.reviewData && state.reviewData.all_assets) || []);
  var items = src.filter(function(x){ return !have[String(x.id)]; });
  var overlay = document.createElement('div');
  overlay.id = 'cast-pick-modal'; overlay.className = 'prep-img-modal';
  overlay.addEventListener('click', function(e){ if (e.target === overlay) closeCastPicker(); });
  var box = document.createElement('div'); box.className = 'prep-img-modal-box';
  var head = document.createElement('div'); head.className = 'prep-img-modal-head';
  var h = document.createElement('div'); h.className = 'prep-img-modal-title'; h.textContent = isChar ? 'Add a character' : 'Add an asset';
  var x = document.createElement('button'); x.type = 'button'; x.className = 'prep-img-modal-x'; x.innerHTML = '&times;';
  x.addEventListener('click', closeCastPicker);
  head.appendChild(h); head.appendChild(x);
  var grid = document.createElement('div'); grid.className = 'prep-img-grid';
  if (!items.length) {
    var empty = document.createElement('div'); empty.className = 'prep-img-empty';
    empty.textContent = isChar ? 'No more characters to add. Create characters on the Characters tab.' : 'No more assets to add. Create assets on the Asset Library tab.';
    grid.appendChild(empty);
  } else {
    items.forEach(function(it){
      var img = isChar ? (_castCharImg[String(it.id)] || '') : (_castAssetImg[String(it.id)] || '');
      var label = isChar ? it.name : (it.name + ' \u00b7 ' + (ACAT[it.category] || it.category || ''));
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'prep-img-pick-named';
      var imgEl = document.createElement('span'); imgEl.className = 'prep-img-pick-img';
      if (img) { imgEl.style.backgroundImage = 'url("' + encodeURI(img) + '")'; }
      else { imgEl.innerHTML = isChar ? '&#128100;' : '&#127991;'; }
      var cap = document.createElement('span'); cap.className = 'prep-img-cap'; cap.textContent = label;
      btn.appendChild(imgEl); btn.appendChild(cap);
      btn.addEventListener('click', function(){ if (isChar) castPickCharacter(momentId, it.id); else castPickAsset(momentId, it.id); closeCastPicker(); });
      grid.appendChild(btn);
    });
  }
  box.appendChild(head); box.appendChild(grid);
  overlay.appendChild(box); document.body.appendChild(overlay);
}

function closeCastPicker() {
  var m = document.getElementById('cast-pick-modal');
  if (m && m.parentNode) m.parentNode.removeChild(m);
}

function castPickCharacter(momentId, id) {
  id = parseInt(id, 10); if (!id) return;
  var p = _reviewPanel(momentId); if (!p) return;
  var name = '';
  ((state.reviewData && state.reviewData.all_characters) || []).some(function(c){ if (String(c.id) === String(id)) { name = charDisplayName(c.name); return true; } return false; });
  p.characters = p.characters || [];
  if (!p.characters.some(function(c){ return String(c.id) === String(id); })) p.characters.push({ id: id, name: name });
  p.cast_explicit = true;
  _saveCast(p);
}

function castPickAsset(momentId, id) {
  id = parseInt(id, 10); if (!id) return;
  var p = _reviewPanel(momentId); if (!p) return;
  var meta = null;
  ((state.reviewData && state.reviewData.all_assets) || []).some(function(a){ if (String(a.id) === String(id)) { meta = a; return true; } return false; });
  p.assets = p.assets || [];
  if (!p.assets.some(function(a){ return String(a.id) === String(id); })) p.assets.push({ id: id, name: meta ? meta.name : '', category: meta ? meta.category : '' });
  p.cast_explicit = true;
  _saveCast(p);
}

// ===== Mobile corner menu: collapses Tour / Ask into a kebab on small screens =====
function toggleCornerMenu(e) {
  if (e) e.stopPropagation();
  var m = document.getElementById('corner-menu'); if (!m) return;
  var open = m.classList.toggle('open');
  if (open) { setTimeout(function(){ document.addEventListener('click', _closeCornerMenuOutside); }, 0); }
  else { document.removeEventListener('click', _closeCornerMenuOutside); }
}
function closeCornerMenu() {
  var m = document.getElementById('corner-menu'); if (m) m.classList.remove('open');
  document.removeEventListener('click', _closeCornerMenuOutside);
}
function _closeCornerMenuOutside(e) {
  var f = document.getElementById('corner-fabs');
  if (f && !f.contains(e.target)) closeCornerMenu();
}

// ===== Delete campaign (from Campaign settings). Safe: server refuses unless empty. =====
async function deleteCampaign() {
  var id = (typeof _csCampaignId !== 'undefined') ? _csCampaignId : null;
  if (!id) return;
  var msg = document.getElementById('cs-delete-msg');
  if (msg) { msg.textContent = ''; msg.style.color = ''; }
  if (!await uiConfirm('Delete this campaign? This cannot be undone.', { okText: 'Delete', cancelText: 'Cancel' })) return;
  _doDeleteCampaign(id);
}

function _doDeleteCampaign(id) {
  var msg = document.getElementById('cs-delete-msg');
  var btn = document.getElementById('cs-delete-btn');
  if (btn) btn.disabled = true;
  fetch('/api/campaigns/' + id, { method: 'DELETE' })
    .then(function(r){ return r.json().then(function(d){ return { status: r.status, d: d }; }); })
    .then(function(res){
      if (btn) btn.disabled = false;
      if (res.status === 200 && res.d && res.d.success) {
        closeCampaignSettings();
        loadCampaigns();
        return;
      }
      if (res.status === 409 && res.d && res.d.error === 'NOT_EMPTY') {
        var c = res.d.counts || {};
        var parts = [];
        if (c.sessions) parts.push(c.sessions + ' session' + (c.sessions > 1 ? 's' : ''));
        if (c.characters) parts.push(c.characters + ' character' + (c.characters > 1 ? 's' : ''));
        if (c.assets) parts.push(c.assets + ' asset' + (c.assets > 1 ? 's' : ''));
        if (c.archives) parts.push(c.archives + ' archived image' + (c.archives > 1 ? 's' : ''));
        if (c.otherMembers) parts.push(c.otherMembers + ' other member' + (c.otherMembers > 1 ? 's' : ''));
        if (msg) { msg.style.color = '#e57373'; msg.textContent = 'Cannot delete yet \u2014 this campaign still has ' + parts.join(', ') + '. Remove those first.'; }
        return;
      }
      if (msg) { msg.style.color = '#e57373'; msg.textContent = (res.d && res.d.error) ? res.d.error : 'Could not delete this campaign.'; }
    })
    .catch(function(){ if (btn) btn.disabled = false; if (msg) { msg.style.color = '#e57373'; msg.textContent = 'Could not delete this campaign.'; } });
}

// ============================================================
// DEVELOPER / DEBUG MODE (per-user, opt-in) -- easter-egg reveal
// Tapping the version label on the Account page 7x reveals the panel.
// ============================================================
var _cmpVerTaps = 0;
var _cmpVerTapTimer = null;
var _cmpDebugCache = [];
var _cmpDotTaps = 0;
var _cmpDotTapTimer = null;
var _cmpLogUnlocked = false;

function cmpVersionTap() {
  _cmpVerTaps++;
  if (_cmpVerTapTimer) clearTimeout(_cmpVerTapTimer);
  _cmpVerTapTimer = setTimeout(function(){ _cmpVerTaps = 0; }, 2000);
  if (_cmpVerTaps >= 7) {
    _cmpVerTaps = 0;
    var p = document.getElementById('dev-debug-panel');
    if (p) { p.style.display = 'block'; cmpInitDebugPanel(); p.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
}

function cmpInitDebugPanel() {
  var isAdmin = !!(typeof state !== "undefined" && state.user && state.user.is_admin);
  cmpShowLogSection(isAdmin || _cmpLogUnlocked);
  fetch('/api/debug/status', { headers: { 'Accept': 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var on = !!(d && d.debug_mode);
      var t = document.getElementById('debug-mode-toggle'); if (t) t.checked = on;
      cmpSetRecDot(on);
      if (isAdmin || _cmpLogUnlocked) cmpRefreshDebugLog();
    })
    .catch(function(){});
}

function cmpSetRecDot(on) {
  var dot = document.getElementById('debug-rec-dot');
  if (dot) dot.style.display = on ? 'inline-block' : 'none';
}

function cmpShowLogSection(show) {
  var sec = document.getElementById('debug-log-section');
  if (sec) sec.style.display = show ? 'block' : 'none';
}

function cmpRecDotTap() {
  if (_cmpLogUnlocked) return;
  _cmpDotTaps++;
  if (_cmpDotTapTimer) clearTimeout(_cmpDotTapTimer);
  _cmpDotTapTimer = setTimeout(function(){ _cmpDotTaps = 0; }, 2000);
  if (_cmpDotTaps >= 7) {
    _cmpDotTaps = 0;
    _cmpLogUnlocked = true;
    cmpShowLogSection(true);
    cmpRefreshDebugLog();
    cmpDebugMsg('Debug log unlocked.', true);
  }
}

function cmpDebugMsg(text, ok) {
  var m = document.getElementById('debug-log-msg');
  if (!m) return;
  m.style.display = 'block';
  m.style.color = ok ? '#7bbf6a' : '#e57373';
  m.textContent = text;
}

function cmpToggleDebug(on) {
  fetch('/api/debug/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: !!on })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){
      var state = !!(d && d.debug_mode);
      cmpSetRecDot(state);
      cmpDebugMsg(state ? 'Debug Mode is ON. Reproduce the problem, then send the log.' : 'Debug Mode is OFF.', true);
      cmpRefreshDebugLog();
    })
    .catch(function(){ cmpDebugMsg('Could not update Debug Mode.', false); });
}

function cmpFormatDebugLog(entries) {
  if (!entries || !entries.length) return 'No debug entries yet. Turn Debug Mode ON and reproduce the problem.';
  var out = [];
  out.push('Campaignia debug log -- ' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies'));
  out.push('========================================');
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    out.push('');
    out.push('[' + (e.created_at || '') + '] ' + String(e.level || 'info').toUpperCase() + ' / ' + (e.source || ''));
    out.push('  page: ' + (e.page || '-'));
    out.push('  fn:   ' + (e.fn || '-'));
    out.push('  msg:  ' + (e.message || '-'));
    if (e.detail) { out.push('  detail:'); out.push(String(e.detail).replace(/^/gm, '    ')); }
  }
  return out.join('\n');
}

function cmpRefreshDebugLog() {
  fetch('/api/debug/logs', { headers: { 'Accept': 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(d){
      _cmpDebugCache = (d && d.entries) || [];
      var view = document.getElementById('debug-log-view');
      if (view) view.textContent = cmpFormatDebugLog(_cmpDebugCache);
    })
    .catch(function(){ var view = document.getElementById('debug-log-view'); if (view) view.textContent = 'Could not load the debug log.'; });
}

function cmpCopyDebugLog() {
  var text = cmpFormatDebugLog(_cmpDebugCache);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(function(){ cmpDebugMsg('Log copied to your clipboard.', true); })
      .catch(function(){ cmpDebugMsg('Could not copy automatically -- select the text and copy.', false); });
  } else {
    cmpDebugMsg('Clipboard not available -- select the text and copy.', false);
  }
}

function cmpSendDebugLog() {
  cmpDebugMsg('Sending log to support...', true);
  fetch('/api/debug/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if (d && d.success) cmpDebugMsg('Sent to support. Thank you -- we will take a look.', true);
      else cmpDebugMsg((d && d.error) || 'Could not send the log.', false);
    })
    .catch(function(){ cmpDebugMsg('Could not send the log.', false); });
}

function cmpClearDebugLog() {
  fetch('/api/debug/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    .then(function(r){ return r.json(); })
    .then(function(){ cmpRefreshDebugLog(); cmpDebugMsg('Log cleared.', true); })
    .catch(function(){ cmpDebugMsg('Could not clear the log.', false); });
}

// ==== Finalize tab: AI layout dry-run (admin-gated, read-only) ====
var _layoutAiChecked = false;
function layoutAiCheckStatus() {
  if (_layoutAiChecked) return; _layoutAiChecked = true;
  fetch('/api/layout-ai/status', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.enabled) { var t = document.getElementById('ntab-finalize'); if (t) t.style.display = ''; } })
    .catch(function () {});
}
function finalizeBookQuery() {
  return '?layout=' + encodeURIComponent(novelLayoutStyle) + novelAsUserQ('&') + customOptsQ('novel', '&');   // covers now render in the panes (viewer upgraded to pdf.js 6.x, which handles the cover/caption gradients)
}
var _finalizeBeforeBase = '';
var _finalizeAfterBase = '';
var _finalizeBeforeBlob = '';
var _finalizeDebugUrl = '';   // admin easter egg: pack-plan text dump URL (double-click the After page count)
var _finalizeFills = {};
var _finalizeAfterFills = {};   // per-page ink-fill % for the After pane (parallels _finalizeFills)
var _finalizeAfterBlob = '';
function loadFinalize() {
  if (!state.currentCampaign || !document.getElementById('finalize-before-scroll')) return;
  finalizeUpdateHeader();   // show the layout + attributes immediately, before the scan finishes
  var url = '/api/pdf/novel/' + state.currentCampaign.id + finalizeBookQuery() + '&format=pdf';
  var _pt = document.getElementById('prep-title'); if (_pt && _pt.value && _pt.value.trim()) url += '&bookTitle=' + encodeURIComponent(_pt.value.trim());
  var _tc = document.getElementById('print-title-color'); if (_tc && _tc.value) url += '&titleColor=' + encodeURIComponent(_tc.value);
  if (loadFinalize._lastUrl === url) return;
  loadFinalize._lastUrl = url;
  finalizeClearScanState();   // fresh initial scan -> drop stale counts / under-fill list / optimized pane
  var _rb = document.getElementById('layoutai-run-btn'); if (_rb) _rb.style.display = 'none';
  var _sl = document.getElementById('layoutai-scan-label'); if (_sl) _sl.style.display = '';
  renderPdfInto(url, 'finalize-before-scroll', true);
}
// Clear everything a prior optimize/scan left behind so a fresh initial scan starts clean.
function finalizeClearScanState() {
  ['layoutai-free', 'layoutai-delta'].forEach(function (id) { var e = document.getElementById(id); if (e) e.innerHTML = ''; });
  ['finalize-before-count', 'finalize-after-count'].forEach(function (id) { var e = document.getElementById(id); if (e) e.textContent = ''; });
  var af = document.getElementById('finalize-after-scroll'); if (af) { af.innerHTML = ''; af.style.display = 'none'; }
  var ab = document.getElementById('finalize-after-body'); if (ab) ab.style.display = '';
  ['finalize-before-open', 'finalize-after-open'].forEach(function (id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; });
}
// Fetch the PDF ONCE, hold it as an in-memory blob, and point the iframe at the blob URL.
// Page jumps then reload the blob locally (instant) instead of re-hitting the server (30s).
function finalizeLoadPdf(url, iframeId, isBefore) {
  fetch(url, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('fetch ' + r.status);
    return r.blob();
  }).then(function (blob) {
    var blobUrl = URL.createObjectURL(blob);
    if (isBefore) { if (_finalizeBeforeBlob) URL.revokeObjectURL(_finalizeBeforeBlob); _finalizeBeforeBlob = blobUrl; _finalizeBeforeBase = blobUrl; }
    else { if (_finalizeAfterBlob) URL.revokeObjectURL(_finalizeAfterBlob); _finalizeAfterBlob = blobUrl; _finalizeAfterBase = blobUrl; }
    var ifr = document.getElementById(iframeId);
    if (ifr) { ifr.src = blobUrl + '#toolbar=0&navpanes=0&page=1'; ifr.style.display = ''; }
    if (isBefore) finalizeMeasureBlob(blob);
  }).catch(function () {});
}
// Hidden pdf.js measurement from the SAME blob (no extra fetch): page count + under-fill scan.
function finalizeMeasureBlob(blob) {
  if (!document.getElementById('finalize-measure-hidden')) return;
  _finalizeFills = {};
  ensurePdfJs().then(function (pdfjsLib) {
    return blob.arrayBuffer().then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
      .then(function (pdf) {
        finalizeBuildNav(pdf.numPages);
        var flagged = [];
        var chain = Promise.resolve();
        var _one = function (pageNum) {
          chain = chain.then(function () {
            return pdf.getPage(pageNum).then(function (page) {
              var vp = page.getViewport({ scale: 0.5 });
              var canvas = document.createElement('canvas');
              canvas.width = vp.width; canvas.height = vp.height;
              return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
                var fill = measureCanvasFill(canvas); if (fill != null) { _finalizeFills[pageNum] = Math.round(fill * 100); if ((pageNum === 2 || pageNum > 5) && fill < 0.62) flagged.push({ page: pageNum, fill: Math.round(fill * 100) }); }
              });
            });
          });
        };
        for (var n = 1; n <= pdf.numPages; n++) _one(n);
        return chain.then(function () { finalizeShowFreeAnalysis(flagged, pdf.numPages); });
      });
  }).catch(function () {});
}
function finalizeBuildNav(first, last) {
  var nav = document.getElementById('finalize-page-nav');
  if (!nav) return;
  var h = '';
  for (var n = first; n <= last; n++) {
    h += '<div data-page="' + n + '" onclick="finalizeGoToPage(' + n + ')" style="cursor:pointer;font-size:10px;line-height:1.6;color:rgba(245,232,200,0.6);padding:0 5px;border-radius:2px;">' + n + '</div>';
  }
  nav.innerHTML = h;
}
function finalizeGoToPage(n) {
  var before = document.getElementById('finalize-before-scroll');
  var top = null;
  if (before) { var canvas = before.querySelector('canvas[data-page="' + n + '"]'); if (canvas) top = canvas.offsetTop - (before.firstChild ? before.firstChild.offsetTop : 0) - 2; }
  if (top != null) {
    ['finalize-before-scroll', 'finalize-after-scroll'].forEach(function (id) {
      var c = document.getElementById(id);
      if (c && c.style.display !== 'none') c.scrollTop = top;   // same absolute offset -> page tops align
    });
  }
  var nav = document.getElementById('finalize-page-nav');
  if (nav) { for (var i = 0; i < nav.children.length; i++) { var el = nav.children[i]; var on = (el.getAttribute('data-page') == n); el.style.color = on ? 'var(--gold)' : 'rgba(245,232,200,0.6)'; el.style.background = on ? 'rgba(201,168,76,0.15)' : 'transparent'; } }
}
var LAYOUT_DISPLAY = {
  'classic': 'Picture Book', 'paired': 'Picture Book', 'picture book': 'Picture Book',
  'comic': 'Comic', 'comicpage': 'Comic',
  'magazine': 'Magazine', 'gazette': 'Gazette'
};
var LAYOUT_DESCRIPTIONS = {
  'Picture Book': 'Keeps images as large as possible.',
  'Classic': 'Keeps images as large as possible.',
  'Comic': 'Panel grid with captions and dialogue.',
  'Magazine': 'Text flows around floating images.',
  'Gazette': 'Enclosed, newspaper-style columns.'
};
var OPT_EST_COST_PER_PAGE = 0.015;   // rough $/page incl. the 2-pass cascade; calibrate from server logs
function finalizeUpdateHeader() {
  var el = document.getElementById('layoutai-header');
  if (!el) return;
  // Effective layout the Optimizer will actually run: the custom arrange when custom layout is
  // active, otherwise the main layout selection. (Previously read the modal's cl-arrange, which
  // defaulted to Picture Book and ignored the real selection.)
  var o = (typeof customActive !== 'undefined' && customActive.novel && typeof customOpts !== 'undefined' && customOpts.novel)
    ? customOpts.novel
    : (typeof CUSTOM_LAYOUT_DEFAULTS !== 'undefined' ? CUSTOM_LAYOUT_DEFAULTS : {});
  var arrange = o.arrange || 'paired';
  var layout = (typeof CL_ARRANGE_LABEL !== 'undefined' && CL_ARRANGE_LABEL[arrange]) ? CL_ARRANGE_LABEL[arrange] : 'Picture Book';
  var desc = LAYOUT_DESCRIPTIONS[layout] || '';
  function optLabel(selId, val) {
    var sel = document.getElementById(selId);
    if (sel) { var opt = sel.querySelector('option[value="' + val + '"]'); if (opt && opt.textContent) return opt.textContent.trim(); }
    return String(val == null ? '' : val);
  }
  // Only attributes the Optimizer accounts for. (Drop cap is omitted until the composer supports it.)
  var parts = [];
  parts.push('Running header: ' + (o.header ? 'On' : 'Off'));
  parts.push('Session dividers: ' + (o.markers ? ('On' + (o.markerbreak ? ' (new page per session)' : '')) : 'Off'));
  parts.push('Captions: ' + optLabel('cl-caption', o.caption));
  parts.push('Borders: ' + optLabel('cl-border', o.border));
  parts.push('Paper: ' + optLabel('cl-paper', o.paper));
  parts.push('Body font: ' + optLabel('cl-font', o.font));
  parts.push('Drop cap: ' + (o.dropcap ? 'On' : 'Off'));
  parts.push('Narrative: ' + optLabel('cl-narr', o.narr));
  var h = '<div style="margin-bottom:6px;"><span style="font-family:var(--font-display);color:var(--gold);font-size:15px;letter-spacing:0.04em;">' + escapeHtml(layout) + '</span>' +
    (desc ? ' <span style="color:rgba(245,232,200,0.6);font-size:11px;font-style:italic;">&ldquo;' + escapeHtml(desc) + '&rdquo;</span>' : '') + '</div>';
  h += '<div style="color:rgba(245,232,200,0.75);font-size:11px;line-height:1.7;">' + parts.map(function (t) { return escapeHtml(t); }).join(' <span style="color:rgba(201,168,76,0.6);">&middot;</span> ') + '</div>';
  el.innerHTML = h;
}

function finalizeShowFreeAnalysis(flagged, numPages) {
  var out = document.getElementById('layoutai-free');
  if (!out) return;
  var _rb = document.getElementById('layoutai-run-btn'); if (_rb) { _rb.disabled = false; _rb.textContent = 'Optimize layout'; _rb.classList.add('has-token'); _rb.style.display = ''; }
  var _sl = document.getElementById('layoutai-scan-label'); if (_sl) _sl.style.display = 'none';
  finalizeUpdateHeader();
  out.style.maxHeight = '540px';   // scan fills the panel until Optimize runs
  var h = '';
  if (!flagged.length) {
    h += '<div style="color:rgba(245,232,200,0.85);font-size:12px;">No obviously under-filled pages. Run Optimize for a full art-director pass.</div>';
  } else {
    h += '<div style="color:var(--cream);font-size:12px;margin-bottom:8px;">' + flagged.length + ' page(s) look under-filled:</div>';
    flagged.forEach(function (f) {
      h += '<div onclick="finalizeGoToPage(' + f.page + ')" title="Go to page ' + f.page + '" style="cursor:pointer;border:1px solid rgba(201,168,76,0.3);border-radius:4px;padding:7px 10px;margin-bottom:6px;font-size:12px;color:var(--cream);"><span style="font-family:var(--font-display);color:var(--gold);">Page ' + f.page + '</span> &middot; content fills ~' + f.fill + '% of the page</div>';
    });
    h += '<div style="color:rgba(245,232,200,0.7);font-size:11px;margin-top:6px;">Run Optimize for the AI to decide how to fill them.</div>';
  }
  out.innerHTML = h;
}
function runLayoutAiDryRun() {
  if (!state.currentCampaign) return;
  // Optimize costs 1 token -- gate on the balance first (the server also enforces).
  var _gb = document.getElementById('layoutai-run-btn'); if (_gb) _gb.disabled = true;
  fetch('/api/tokens/balance', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var bal = (j && typeof j.total === 'number') ? j.total : 1;   // unreadable -> let the server decide
      if (bal < 1) {
        if (_gb) _gb.disabled = false;
        if (typeof billingToast === 'function') billingToast('You need at least 1 token to optimize the layout.', 'error');
        return;
      }
      _runLayoutAiOptimize();
    })
    .catch(function () { _runLayoutAiOptimize(); });
}
function _runLayoutAiOptimize() {
  if (!state.currentCampaign) return;
  var cid = state.currentCampaign.id;
  var btn = document.getElementById('layoutai-run-btn');
  var status = document.getElementById('layoutai-status');
  var out = document.getElementById('layoutai-results');
  var wrap = document.getElementById('layoutai-progress-wrap');
  var fill = document.getElementById('layoutai-progress-fill');
  var pmsg = document.getElementById('layoutai-progress-msg');
  var _lf = document.getElementById('layoutai-free'); if (_lf) _lf.style.maxHeight = '540px';   // composer is free -- keep the full findings shown, don't collapse
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; btn.classList.remove('has-token'); }
  if (status) status.textContent = '';
  if (out) out.innerHTML = '';
  var _d0 = document.getElementById('layoutai-delta'); if (_d0) _d0.innerHTML = '';
  // Composer is deterministic and fast -- a lightweight status line, no progress bar.
  if (status) status.textContent = 'Composing the book page by page...';
  function finish() {
    if (status) status.textContent = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Optimize layout'; btn.classList.add('has-token'); }
  }
  // Load the deterministic page-packer / composer into the After pane. Synchronous render,
  // no async job, no tokens -- the packer composes the book page by page and returns the PDF,
  // rendered through the same styled shell as the Before pane so it's a true comparison.
  var composeUrl = '/api/pdf/pack-render/' + cid + '?compose=1' + finalizeBookQuery().replace('?', '&');
  // Admin easter egg: double-click the After page count to open the pack-plan text dump in a new tab.
  _finalizeDebugUrl = '/api/pdf/pack-debug/' + cid + finalizeBookQuery();
  var _dbgCnt = document.getElementById('finalize-after-count');
  if (_dbgCnt && state.user && state.user.is_admin) {
    _dbgCnt.style.cursor = 'pointer';
    _dbgCnt.title = 'Double-click: pack plan (admin)';
    _dbgCnt.ondblclick = function () { if (_finalizeDebugUrl) window.open(_finalizeDebugUrl, '_blank'); };
  }
  var afterBody = document.getElementById('finalize-after-body');
  if (afterBody) afterBody.style.display = 'none';
  var afterScroll = document.getElementById('finalize-after-scroll');
  if (afterScroll) afterScroll.style.display = '';
  if (pmsg) pmsg.textContent = 'Composing the book page by page (this can take up to a minute)...';
  renderPdfInto(composeUrl, 'finalize-after-scroll', false);
  var _afterCount = 0, _stable = 0;
  var _composeWatch = setInterval(function () {
    var sc = document.getElementById('finalize-after-scroll');
    var cnt = sc ? sc.querySelectorAll('canvas').length : 0;
    if (cnt > 0) {
      if (cnt === _afterCount) { _stable++; } else { _stable = 0; _afterCount = cnt; }
      if (_stable >= 3) {   // page count stable for ~1.5s -> render finished
        clearInterval(_composeWatch);
        finish();
        var bp = document.querySelectorAll('#finalize-before-scroll canvas').length;
        var _dEl = document.getElementById('layoutai-delta');
        if (_dEl) {
          var delta = bp - cnt;
          var _fB = finalizeFillPct(_finalizeFills, bp), _fA = finalizeFillPct(_finalizeAfterFills, cnt);
          var _html = 'Pages: <strong>' + bp + '</strong> &nbsp;&rarr;&nbsp; <strong>' + cnt + '</strong>' +
            (delta > 0 ? ' &nbsp;(<strong style="color:#8fd18f;">-' + delta + '</strong>)' : (delta < 0 ? ' &nbsp;(<strong style="color:#e0a0a0;">+' + (-delta) + '</strong>)' : ''));
          if (_fB != null && _fA != null) {
            _html += '<br>Density: <strong style="color:' + finalizeFillColor(_fB) + ';">' + _fB + '%</strong> &nbsp;&rarr;&nbsp; <strong style="color:' + finalizeFillColor(_fA) + ';">' + _fA + '% full</strong>';
            // Total empty space = pages x white. Captures BOTH fewer pages AND denser pages in one number.
            var _eB = bp * (100 - _fB), _eA = cnt * (100 - _fA);
            if (_eB > 0) { var _cut = Math.round((_eB - _eA) / _eB * 100);
              if (_cut > 0) _html += '<br><strong style="color:#8fd18f;">' + _cut + '% less empty space overall</strong>'; }
          }
          _dEl.innerHTML = _html;
        }
        if (typeof refreshTokenBalance === 'function') refreshTokenBalance();   // reflect the spent token
      }
    }
  }, 500);
  setTimeout(function () { clearInterval(_composeWatch); finish(); }, 180000);
}
// DIAGNOSTIC (temporary): draw a line on the preview canvas at the scan's detected content
// bottom, labeled with fill %, so we can see whether pages are truly full or a stray element
// is fooling the scan. Remove once the under-fill detection is confirmed.
function finalizeDebugMarkCanvas(canvas, fill) {
  try {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var y = Math.round(fill * canvas.height);
    var d = canvas.__scanDbg || {};
    ctx.save();
    ctx.strokeStyle = 'rgba(230,0,140,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(canvas.width, y + 0.5); ctx.stroke();
    ctx.fillStyle = 'rgba(230,0,140,0.95)';
    ctx.font = 'bold ' + Math.max(11, Math.round(canvas.width * 0.026)) + 'px sans-serif';
    var lbl = Math.round(fill * 100) + '%';
    if (d.bg) lbl += '  bg(' + d.bg.join(',') + ')';
    if (d.px) lbl += '  ink@x' + d.px[0] + '(' + d.px[1] + ',' + d.px[2] + ',' + d.px[3] + ')';
    ctx.fillText(lbl, 6, Math.max(16, y - 5));
    ctx.restore();
  } catch (e) {}
}
function measureCanvasFill(canvas) {
  try {
    var W = canvas.width, H = canvas.height;
    if (!W || !H) return null;
    var data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    // Sample the ACTUAL paper background from the top-left corner (always blank margin) and count a
    // pixel as ink only if it differs from that background by more than TOL. The old code used an
    // absolute 'channel < 238' cutoff, so any near-white artifact (faint watermark, anti-alias ghost)
    // registered as content and pinned every page's fill high. Comparing to the real background fixes it.
    var bgR = 255, bgG = 255, bgB = 255, sr = 0, sg = 0, sb = 0, sn = 0;
    var cx0 = Math.floor(W * 0.02), cx1 = Math.max(cx0 + 1, Math.floor(W * 0.07));
    var cy0 = Math.floor(H * 0.01), cy1 = Math.max(cy0 + 1, Math.floor(H * 0.03));
    for (var yy = cy0; yy < cy1; yy++) { for (var xx = cx0; xx < cx1; xx++) { var k = (yy * W + xx) * 4; if (data[k + 3] < 10) continue; sr += data[k]; sg += data[k + 1]; sb += data[k + 2]; sn++; } }
    if (sn > 0) { bgR = Math.round(sr / sn); bgG = Math.round(sg / sn); bgB = Math.round(sb / sn); }
    var TOL = 34;
    // GRID OCCUPANCY (v3.0.116): the old metric returned how far DOWN the page ink reached, so it was
    // blind to SIDE-white -- a narrow image with an empty column beside it still scored ~full. That is
    // exactly the white the optimizer's image-grow removes, so improvements never showed up. Now the
    // printable area (margins + footer excluded) is divided into a coarse grid and a cell counts as
    // used if ANY ink falls in it. Cells are ~one text-line pitch tall, so normal line spacing still
    // reads as full, while genuine white -- beside a narrow image or below short content -- reads empty.
    // Denominator = the TRUE printable box, so permanent margin white never counts against a page.
    // Interior geometry: @page 8.5x11in with margin 0.65in top/bottom and .content-page padding 0.85in
    // left/right (top/bottom padding is zeroed in print). Margins are symmetric -- no mirrored gutter --
    // so one box is valid for both odd and even pages. The running-header band (HEADER_BAND_IN 0.24in)
    // is skipped too, so the score reflects BODY content only.
    var gx0 = Math.floor(W * 0.100), gx1 = Math.floor(W * 0.900);   // 0.85in / 8.5in
    var gy0 = Math.floor(H * 0.081), gy1 = Math.floor(H * 0.941);   // (0.65 + 0.24)in / 11in .. (11 - 0.65)in / 11in
    var COLS = 20, ROWS = 30;
    var cw = (gx1 - gx0) / COLS, chh = (gy1 - gy0) / ROWS;
    if (!(cw > 0) || !(chh > 0)) return null;
    var cells = new Uint8Array(COLS * ROWS), pxDbg = null;
    for (var y = gy0; y < gy1; y += 2) {
      var ry = Math.floor((y - gy0) / chh); if (ry < 0 || ry >= ROWS) continue;
      for (var x = gx0; x < gx1; x += 4) {
        var i = (y * W + x) * 4;
        if (data[i + 3] < 10) continue;
        if (Math.abs(data[i] - bgR) > TOL || Math.abs(data[i + 1] - bgG) > TOL || Math.abs(data[i + 2] - bgB) > TOL) {
          var rx = Math.floor((x - gx0) / cw); if (rx < 0 || rx >= COLS) continue;
          cells[ry * COLS + rx] = 1;
          if (!pxDbg) pxDbg = [x, data[i], data[i + 1], data[i + 2]];
        }
      }
    }
    var usedCells = 0;
    for (var ci = 0; ci < cells.length; ci++) { if (cells[ci]) usedCells++; }
    canvas.__scanDbg = { bg: [bgR, bgG, bgB], px: pxDbg, cells: usedCells + '/' + cells.length };
    return usedCells / cells.length;
  } catch (e) { return null; }
}
function finalizeFreeAnalysis() {
  var container = document.getElementById('finalize-before-scroll');
  var out = document.getElementById('layoutai-results');
  if (!container || !out) return;
  if (out.getAttribute('data-mode') === 'ai') return;   // don't clobber an AI pass result
  var canvases = container.querySelectorAll('canvas');
  if (!canvases.length) return;
  var flagged = [];
  for (var n = 0; n < canvases.length; n++) {
    if (n < 5) continue;   // skip front matter (cover/title/credits/roster/contents)
    var fill = measureCanvasFill(canvases[n]);
    if (fill != null && fill < 0.62) flagged.push({ page: n + 1, fill: Math.round(fill * 100) });
  }
  var h = '<div style="font-size:11px;color:rgba(245,232,200,0.5);margin-bottom:8px;">Free layout scan (no tokens) &middot; ' + canvases.length + ' pages</div>';
  if (!flagged.length) {
    h += '<div style="color:rgba(245,232,200,0.6);font-size:12px;">No obviously under-filled pages. Run Optimize for a full art-director pass.</div>';
  } else {
    h += '<div style="color:var(--cream);font-size:12px;margin-bottom:8px;">' + flagged.length + ' page(s) look under-filled &mdash; content stops high with space below:</div>';
    flagged.forEach(function (f) {
      h += '<div style="border:1px solid rgba(201,168,76,0.2);border-radius:4px;padding:7px 10px;margin-bottom:6px;font-size:12px;"><span style="font-family:var(--font-display);color:var(--gold);">Page ' + f.page + '</span> &middot; content fills ~' + f.fill + '% of the page</div>';
    });
    h += '<div style="color:rgba(245,232,200,0.5);font-size:11px;margin-top:6px;">Run Optimize for the AI to decide how to fill them (grow image / flow text).</div>';
  }
  out.innerHTML = h;
  out.setAttribute('data-mode', 'free');
}

function renderLayoutAiResult(j) {
  var out = document.getElementById('layoutai-results');
  if (!out) return;
  if (!j || j.error) { out.innerHTML = '<div style="color:#e0a0a0;font-size:13px;">Error: ' + escapeHtml((j && j.error) || 'no response') + '</div>'; return; }
  var h = '';
  h += '<div style="font-size:11px;color:rgba(245,232,200,0.5);margin-bottom:8px;">' + escapeHtml(j.layout || '') + ' &middot; ' + escapeHtml(j.model || '') + ' &middot; ' + (j.total_pages || 0) + ' pages &middot; ' + (j.pages_flagged || 0) + ' flagged &middot; ' + (j.applied != null ? j.applied + ' applied &middot; ' : '') + (Math.round((j.ms || 0) / 100) / 10) + 's</div>';
  if (j.settings) {
    var _co = j.settings.co || {};
    var _coStr = Object.keys(_co).map(function (k) { return k + '=' + _co[k]; }).join(', ');
    h += '<div style="font-size:10px;color:rgba(245,232,200,0.4);margin-bottom:8px;font-family:monospace;word-break:break-all;">rendered: layout=' + escapeHtml(String(j.settings.layout || '')) + ' &middot; panels=' + (j.settings.panels || 0) + (_coStr ? ' &middot; ' + escapeHtml(_coStr) : '') + '</div>';
  }
  if (j.book_assessment) h += '<div style="background:rgba(201,168,76,0.08);border-left:3px solid var(--gold);border-radius:4px;padding:10px 12px;font-size:13px;line-height:1.5;color:var(--cream);margin-bottom:10px;">' + escapeHtml(j.book_assessment) + '</div>';
  if (j.notes && j.notes.length) h += '<div style="color:#d0a86a;font-size:11px;margin-bottom:8px;">' + escapeHtml(j.notes.join(' | ')) + '</div>';
  var pages = j.pages || [];
  if (!pages.length) h += '<div style="color:rgba(245,232,200,0.5);font-size:12px;">No page-level changes suggested.</div>';
  pages.forEach(function (pg) {
    var vc = pg.verdict === 'near_blank' ? '#c0392b' : (pg.verdict === 'under_filled' ? '#b06a2a' : '#3f7d4f');
    h += '<div' + (pg.page != null && !isNaN(Number(pg.page)) ? ' onclick="finalizeGoToPage(' + Number(pg.page) + ')"' : '') + ' title="Go to page" style="cursor:pointer;border:1px solid rgba(201,168,76,0.2);border-radius:4px;padding:9px 11px;margin-bottom:7px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-family:var(--font-display);color:var(--gold);font-size:13px;">Page ' + escapeHtml(String(pg.page != null ? pg.page : '?')) + '</span>';
    h += '<span style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:' + vc + ';">' + escapeHtml(String(pg.verdict || '')) + '</span></div>';
    if (pg.problem && !/^none$/i.test(String(pg.problem))) h += '<div style="font-size:12px;color:rgba(245,232,200,0.85);margin-top:3px;font-style:italic;">' + escapeHtml(pg.problem) + '</div>';
    if (pg.fix) h += '<div style="font-size:12px;color:rgba(245,232,200,0.7);margin-top:3px;">Fix: ' + escapeHtml(pg.fix) + '</div>';
    var panels = pg.panels || [];
    if (panels.length) {
      h += '<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px;">';
      panels.forEach(function (pn) {
        var tag = (pn.label ? escapeHtml(String(pn.label)) : 'panel') + ': e' + escapeHtml(String(pn.emphasis)) + '/' + escapeHtml(String(pn.size_hint || 'keep')) + (pn.flow === true ? ' +flow' : '');
        h += '<span style="font-size:10px;font-family:monospace;background:#0c0805;border:1px solid rgba(138,106,42,0.5);border-radius:3px;padding:1px 6px;color:#d8c9a0;">' + tag + '</span>';
      });
      h += '</div>';
    }
    h += '</div>';
  });
  out.innerHTML = h;
  out.setAttribute('data-mode', 'ai');
}

// ---- Finalize: draggable splitter + before/after PDF tabs ----
var _finalizeDrag = null;
function finalizeSplitStart(e) {
  e.preventDefault();
  var split = document.getElementById('finalize-split');
  var left = document.getElementById('finalize-left');
  if (!split || !left) return;
  _finalizeDrag = { x: e.clientX, w: left.getBoundingClientRect().width, total: split.getBoundingClientRect().width };
  document.addEventListener('mousemove', finalizeSplitMove);
  document.addEventListener('mouseup', finalizeSplitEnd);
  document.body.style.userSelect = 'none';
}
function finalizeSplitMove(e) {
  if (!_finalizeDrag || !_finalizeDrag.total) return;
  var left = document.getElementById('finalize-left');
  var pct = ((_finalizeDrag.w + (e.clientX - _finalizeDrag.x)) / _finalizeDrag.total) * 100;
  if (pct < 20) pct = 20; if (pct > 75) pct = 75;
  if (left) left.style.flexBasis = pct + '%';
}
function finalizeSplitEnd() {
  _finalizeDrag = null;
  document.removeEventListener('mousemove', finalizeSplitMove);
  document.removeEventListener('mouseup', finalizeSplitEnd);
  document.body.style.userSelect = '';
}
function finalizeSetPdfTab(which) {
  // Tabs removed -- the panes are always side by side now. Kept as a safe hook so existing
  // callers (e.g. the optimize handler) still work; it just ensures both panes are visible.
  var before = document.getElementById('finalize-before-wrap');
  var after = document.getElementById('finalize-after-wrap');
  if (before) { before.style.display = ''; before.style.flex = '1 1 50%'; }
  if (after) { after.style.display = ''; after.style.flex = '1 1 50%'; }
}

// ---- Finalize: pdf.js render into scroll containers + synced scrolling ----
var _pdfjsPromise = null;
var PDFJS_VER = '6.1.200';   // upgraded viewer (SPIKE): renders fade-to-transparent gradients, so no more pink in the panes. ESM build via dynamic import; paneSafeHtml stays dormant in pdf.js as the rollback fallback.
function ensurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  var base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/';
  _pdfjsPromise = import(base + 'pdf.min.mjs')
    .then(function (mod) {
      var lib = (mod && mod.getDocument) ? mod : ((mod && mod.default && mod.default.getDocument) ? mod.default : mod);
      if (lib && lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
      window.pdfjsLib = lib;
      return lib;
    })
    .catch(function (e) { _pdfjsPromise = null; throw new Error('pdf.js ' + PDFJS_VER + ' could not load: ' + (e && e.message)); });
  return _pdfjsPromise;
}
// Locked render width: capture the right pane's width once (when valid) and reuse it for
// BOTH before and after, so a page renders pixel-identical in each pane -- only content differs.
var _finalizeLockedWidth = 0;
function finalizeRenderWidth(container) {
  if (_finalizeLockedWidth > 0) return _finalizeLockedWidth;   // truly locked: measure once, reuse for both panes
  var rp = document.getElementById('finalize-right');
  var w = rp ? rp.clientWidth : 0;
  if (w > 8) { _finalizeLockedWidth = w - 8; return _finalizeLockedWidth; }
  return Math.max(400, (container ? container.clientWidth : 400) - 8);
}
var _pdfRenderTokens = {};
// Whole-book white-space score from per-page ink-fill %. Average the interior pages (skip the
// front/back cover, which are non-content) and return 100 - avgFill so higher = more white.
function finalizeWhitePct(fills, total) {
  var vals = [];
  Object.keys(fills || {}).forEach(function (k) {
    var pn = parseInt(k, 10);
    if (pn === 1 || pn === total) return;   // exclude covers
    if (typeof fills[k] === 'number') vals.push(fills[k]);
  });
  if (!vals.length) return null;
  var sum = 0; vals.forEach(function (v) { sum += v; });
  return Math.max(0, Math.round(100 - sum / vals.length));
}
var FINALIZE_FILL_GREEN = 78;   // density % at/above which the score reads "as good as it gets" (green). Rescaled for the v3.0.116 grid-occupancy metric, which counts side-white the old depth metric ignored, so equivalent books read a little lower.
function finalizeFillPct(fills, total) { var w = finalizeWhitePct(fills, total); return (w == null) ? null : (100 - w); }
function finalizeFillColor(f) { return (f != null && f >= FINALIZE_FILL_GREEN) ? '#8fd18f' : '#e0a0a0'; }
function finalizeCountLabel(total, fillPct) {
  var t = total + (total === 1 ? ' page' : ' pages');
  if (fillPct != null) t += ' \u00b7 <span style="color:' + finalizeFillColor(fillPct) + ';font-weight:600;">' + fillPct + '% full</span>';
  return t;
}
// Open the already-fetched Before/After PDF in a new browser tab via its in-memory blob (native
// PDF viewer -> viewable, savable). Reuses the blob so nothing is re-fetched and no token is spent.
function finalizeOpenPdf(isBefore) {
  var u = isBefore ? _finalizeBeforeBlob : _finalizeAfterBlob;
  if (u) window.open(u, '_blank');
}
function finalizeShowOpenBtn(isBefore) {
  var b = document.getElementById(isBefore ? 'finalize-before-open' : 'finalize-after-open');
  if (b) b.style.display = '';
}
function renderPdfInto(url, containerId, isBefore) {
  var container = document.getElementById(containerId);
  if (!container) return;
  var myToken = Date.now() + ':' + Math.random();
  _pdfRenderTokens[containerId] = myToken;
  container.innerHTML =
    '<div class="progress-wrap" id="' + containerId + '-pw" style="display:block;padding:12px 12px 6px;">' +
      '<div class="progress-bar"><div class="progress-fill" id="' + containerId + '-pf" style="width:0%;"></div></div>' +
      '<div class="progress-msg" id="' + containerId + '-pm">Rendering preview...</div>' +
    '</div>' +
    '<div id="' + containerId + '-cv"></div>';
  var cv = document.getElementById(containerId + '-cv');
  var pf = document.getElementById(containerId + '-pf');
  var pm = document.getElementById(containerId + '-pm');
  if (isBefore) _finalizeFills = {}; else _finalizeAfterFills = {};
  var flagged = [];
  // The server generates the whole PDF (~20s). Nothing to show real progress on during
  // that fetch, so creep the bar to ~45% so it's obviously working, not stuck.
  var creepPct = 0;
  var creepTimer = setInterval(function () { creepPct += Math.max(0.5, (45 - creepPct) * 0.05); if (creepPct > 45) creepPct = 45; if (pf) pf.style.width = creepPct.toFixed(1) + '%'; }, 300);
  ensurePdfJs().then(function (pdfjsLib) {
    if (pm) pm.textContent = 'Generating the book (~20s)...';
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('PDF fetch failed (' + r.status + ')');
      return r.arrayBuffer();
    }).then(function (buf) {
      // Keep the raw PDF as an in-memory blob so "Open in new tab" reuses it -- no re-fetch, so the
      // After pane (pack-render) never re-charges its token just to view the file.
      try {
        var _pdfBlobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
        if (isBefore) { if (_finalizeBeforeBlob) URL.revokeObjectURL(_finalizeBeforeBlob); _finalizeBeforeBlob = _pdfBlobUrl; }
        else { if (_finalizeAfterBlob) URL.revokeObjectURL(_finalizeAfterBlob); _finalizeAfterBlob = _pdfBlobUrl; }
        finalizeShowOpenBtn(isBefore);
      } catch (e) {}
      if (pm) pm.textContent = 'Preparing pages...';
      return pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      clearInterval(creepTimer);
      if (_pdfRenderTokens[containerId] !== myToken) return;
      var total = pdf.numPages;
      var _cntEl = document.getElementById(isBefore ? 'finalize-before-count' : 'finalize-after-count');
      if (_cntEl) _cntEl.innerHTML = finalizeCountLabel(total, null);
      // Preview now includes covers (viewer upgraded): page 1 is the front cover, last is the back
      // cover, interior between -- show every page.
      var first = 1, last = total;
      var width = finalizeRenderWidth(container);   // locked, shared -> before/after identical size
      var span = (last - first + 1);
      var chain = Promise.resolve();
      var _loop = function (pageNum) {
        chain = chain.then(function () {
          if (_pdfRenderTokens[containerId] !== myToken) return;
          return pdf.getPage(pageNum).then(function (page) {
            var dpr = Math.min(window.devicePixelRatio || 1, 2);
            var vp1 = page.getViewport({ scale: 1 });
            var vp = page.getViewport({ scale: (width / vp1.width) * dpr });
            var canvas = document.createElement('canvas');
            canvas.width = vp.width; canvas.height = vp.height;
            canvas.style.width = '100%'; canvas.style.height = 'auto'; canvas.style.display = 'block'; canvas.style.marginBottom = '6px'; canvas.style.borderRadius = '3px';
            canvas.setAttribute('data-page', pageNum);
            if (cv) cv.appendChild(canvas);
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
              if (pf) pf.style.width = (45 + Math.round(((pageNum - first + 1) / span) * 55)) + '%';
              if (pm) pm.textContent = 'Rendering page ' + pageNum;
              { var fill = measureCanvasFill(canvas); if (fill != null) { var _fpct = Math.round(fill * 100); if (isBefore) { _finalizeFills[pageNum] = _fpct; /* DIAGNOSTIC (disabled): finalizeDebugMarkCanvas(canvas, fill); */ if ((pageNum === 2 || pageNum > 5) && fill < 0.62) flagged.push({ page: pageNum, fill: _fpct }); } else { _finalizeAfterFills[pageNum] = _fpct; } } }
            });
          });
        });
      };
      for (var n = first; n <= last; n++) _loop(n);
      return chain.then(function () {
        if (_pdfRenderTokens[containerId] !== myToken) return;
        var pw = document.getElementById(containerId + '-pw');
        if (pw && pw.parentNode) pw.parentNode.removeChild(pw);
        if (isBefore) { finalizeBuildNav(first, last); finalizeShowFreeAnalysis(flagged, total); }
        var _fpct = finalizeFillPct(isBefore ? _finalizeFills : _finalizeAfterFills, total);
        var _wcnt = document.getElementById(isBefore ? 'finalize-before-count' : 'finalize-after-count');
        if (_wcnt) _wcnt.innerHTML = finalizeCountLabel(total, _fpct);
        finalizeAttachSync();
      });
    });
  }).catch(function (e) {
    clearInterval(creepTimer);
    if (container) container.innerHTML = '<div style="color:#e0a0a0;font-size:12px;padding:16px;">Preview render failed: ' + escapeHtml((e && e.message) || 'error') + '</div>';
  });
}
var _finalizeSyncing = false;
function finalizeSyncScroll(srcId) {
  if (_finalizeSyncing) return;
  _finalizeSyncing = true;
  var src = document.getElementById(srcId);
  if (src) {
    var top = src.scrollTop;
    ['finalize-before-scroll', 'finalize-after-scroll'].forEach(function (id) {
      if (id === srcId) return;
      var el = document.getElementById(id);
      if (el && el.offsetParent !== null) el.scrollTop = top;   // absolute: equal-height pages -> page tops align
    });
  }
  window.requestAnimationFrame(function () { _finalizeSyncing = false; });
}
function finalizeAttachSync() {
  ['finalize-before-scroll', 'finalize-after-scroll'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && !el._syncAttached) { el._syncAttached = true; el.addEventListener('scroll', function () { finalizeSyncScroll(id); }); }
  });
}

// ---- Reset the publish/Finalize page when switching campaigns ----
// prepSyncTitle only fills the title when empty, and the Layout AI panels cache the
// prior campaign, so switching campaigns must clear these before the novel tab reloads.
function resetPublishForCampaignSwitch() {
  var _cid = state.currentCampaign ? state.currentCampaign.id : null;
  if (resetPublishForCampaignSwitch._last === _cid) return;   // already reset for this campaign
  resetPublishForCampaignSwitch._last = _cid;
  var t = document.getElementById('prep-title'); if (t) t.value = '';
  var pv = document.getElementById('novel-preview-iframe'); if (pv) pv.src = '';   // clear cached Preview & Export
  state._prepOwnTitle = null;
  state.bookMeta = null;
  if (typeof loadFinalize === 'function') loadFinalize._lastUrl = null;
  _finalizeLockedWidth = 0;   // re-lock the render width for the new campaign
  var bi = document.getElementById('finalize-before-scroll'); if (bi) bi.innerHTML = '';
  var ai = document.getElementById('finalize-after-scroll'); if (ai) { ai.innerHTML = ''; ai.style.display = 'none'; }
  var ab = document.getElementById('finalize-after-body'); if (ab) ab.style.display = '';
  ['finalize-before-open', 'finalize-after-open'].forEach(function (id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; });
  var _nv = document.getElementById('finalize-page-nav'); if (_nv) _nv.innerHTML = '';
  var lr = document.getElementById('layoutai-results'); if (lr) { lr.innerHTML = ''; lr.removeAttribute('data-mode'); }
  var _lf = document.getElementById('layoutai-free'); if (_lf) _lf.innerHTML = '';
  var pw = document.getElementById('layoutai-progress-wrap'); if (pw) pw.style.display = 'none';
  if (typeof finalizeSetPdfTab === 'function') finalizeSetPdfTab('before');
  // Re-pull book meta + title/thumbs for the new campaign.
  if (typeof prepPanelSync === 'function') prepPanelSync();
}
