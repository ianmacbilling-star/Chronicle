/*
 * Campaignia PWA bootstrap.
 *  - Registers the service worker (best-effort).
 *  - Drives the "Install app" item in the Profile menu on BOTH desktop and
 *    mobile (the menu item calls installApp()).
 *  - On MOBILE ONLY, also shows a gentle install chip when the app is
 *    installable and not already installed. Desktop never auto-prompts.
 *  - v3.1.88 (TD-957): the chip's x is remembered for 90 days, and an accepted
 *    install (or opening the installed app) silences the chip for good.
 * Everything fails open -- if the browser cannot install, nothing shows.
 */
(function () {
  'use strict';

  // ---- service worker -----------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* fail open */ });
    });
  }

  // ---- helpers ------------------------------------------------------------
  var deferred = null; // stashed beforeinstallprompt event (Android/desktop Chromium)

  function item() { return document.getElementById('nav-install-item'); }
  function showItem() { var el = item(); if (el) el.style.display = ''; }
  function hideItem() { var el = item(); if (el) el.style.display = 'none'; }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true; // iOS
  }

  function isMobile() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua)) { return true; }
    // Non-UA fallback: coarse pointer + touch + small screen (excludes desktop).
    return (navigator.maxTouchPoints || 0) > 0
        && window.matchMedia
        && window.matchMedia('(pointer: coarse)').matches
        && window.matchMedia('(max-width: 820px)').matches;
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  }

  // v3.1.88 -- TD-957. REMEMBERED IN localStorage, NOT sessionStorage.
  // sessionStorage forgot the x at the end of every visit, so the chip came back each time,
  // including for people who had installed the app from ANOTHER browser (Ian, Edge on Android:
  // Edge fires beforeinstallprompt because Edge did not install it, and cannot see the install).
  // Now: the x holds for DISMISS_DAYS; an accepted install, the appinstalled event, opening the
  // installed app (display-mode standalone) or getInstalledRelatedApps() finding it holds for good.
  // The Profile-menu "Install app" item is unaffected: it still appears whenever the browser
  // offers an install, so anyone who dismissed the chip can still install.
  var DISMISS_KEY = 'cmpInstallDismissAt';
  var INSTALLED_KEY = 'cmpInstalledAt';
  var DISMISS_DAYS = 90;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function chipSuppressed() {
    if (lsGet(INSTALLED_KEY)) { return true; }
    var at = Number(lsGet(DISMISS_KEY) || 0);
    return at > 0 && (Date.now() - at) < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  }
  function setDismissed() { lsSet(DISMISS_KEY, String(Date.now())); }
  function setInstalled() { lsSet(INSTALLED_KEY, String(Date.now())); }

  // Asks the browser whether this web app is already installed (manifest related_applications,
  // platform webapp). Chromium on Android only, and only sees installs made by THIS browser.
  // Resolves false on any doubt: an unanswered question must never hide the chip by itself.
  function relatedAppInstalled() {
    try {
      if (!navigator.getInstalledRelatedApps) { return Promise.resolve(false); }
      return navigator.getInstalledRelatedApps().then(function (apps) {
        var found = !!(apps && apps.length);
        if (found) { setInstalled(); }
        return found;
      }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  // ---- install chip (mobile only) ----------------------------------------
  function removeChip() {
    var c = document.getElementById('cmp-install-chip');
    if (c && c.parentNode) { c.parentNode.removeChild(c); }
  }

  // mode: 'native' (has install button) | 'ios' (instructional)
  function buildChip(mode) {
    removeChip();
    var wrap = document.createElement('div');
    wrap.id = 'cmp-install-chip';
    wrap.setAttribute('role', 'dialog');
    wrap.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:12px', 'transform:translateX(-50%)',
      'width:calc(100% - 24px)', 'max-width:520px', 'z-index:9998',
      'box-sizing:border-box',
      'display:flex', 'align-items:center', 'gap:10px',
      'padding:12px', 'padding-bottom:calc(12px + env(safe-area-inset-bottom))',
      'background:#211c16', 'color:#f5efe2',
      'border:1px solid rgba(255,255,255,.12)', 'border-radius:14px',
      'box-shadow:0 10px 34px rgba(0,0,0,.40)',
      'font-family:inherit', 'font-size:13px', 'line-height:1.35'
    ].join(';');

    var icon = document.createElement('img');
    icon.src = '/images/cmp-icon-192.png';
    icon.alt = '';
    icon.style.cssText = 'width:34px;height:34px;flex:none;border-radius:7px';
    wrap.appendChild(icon);

    var text = document.createElement('div');
    text.style.cssText = 'flex:1';
    if (mode === 'ios') {
      text.innerHTML = 'Install Campaignia: tap the Share icon, then '
        + '<strong>"Add to Home Screen."</strong>';
    } else {
      text.textContent = 'Install Campaignia for a faster, full-screen experience.';
    }
    wrap.appendChild(text);

    if (mode === 'native') {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Install';
      btn.style.cssText = [
        'flex:none', 'border:none', 'cursor:pointer', 'font:inherit',
        'font-weight:600', 'border-radius:9px', 'padding:8px 14px',
        'background:#c9a14a', 'color:#1a1712'
      ].join(';');
      btn.addEventListener('click', function () { window.installApp(); });
      wrap.appendChild(btn);
    }

    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = '&times;';
    x.style.cssText = [
      'flex:none', 'border:none', 'background:none', 'cursor:pointer',
      'color:inherit', 'opacity:.6', 'font-size:20px', 'line-height:1', 'padding:4px'
    ].join(';');
    x.addEventListener('click', function () { setDismissed(); removeChip(); });
    wrap.appendChild(x);

    document.body.appendChild(wrap);
  }

  function maybeShowNativeChip() {
    if (!isMobile() || isStandalone() || chipSuppressed()) { return; }
    if (!deferred) { return; }
    relatedAppInstalled().then(function (found) {
      if (found || !deferred || chipSuppressed()) { return; }
      buildChip('native');
    });
  }

  function maybeShowIosChip() {
    if (!isMobile() || isStandalone() || chipSuppressed()) { return; }
    buildChip('ios');
  }

  // ---- wiring -------------------------------------------------------------
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    showItem(); // Profile menu, desktop + mobile
    // Auto chip on mobile only; small delay so it doesn't slam in on load.
    if (isMobile()) { setTimeout(maybeShowNativeChip, 1000); }
  });

  // Called by the Profile-menu "Install app" item (and the chip's Install btn).
  window.installApp = function () {
    if (deferred) {
      var p = deferred;
      deferred = null;
      hideItem();
      removeChip();
      p.prompt();
      // v3.1.88 -- TD-957: an accepted install silences the chip in this browser for good.
      try {
        if (p.userChoice && p.userChoice.then) {
          p.userChoice.then(function (c) { if (c && c.outcome === 'accepted') { setInstalled(); } })
            .catch(function () { /* ignore */ });
        }
      } catch (e) { /* ignore */ }
      return;
    }
    // No native prompt available (e.g. iOS Safari): show instructions.
    if (isIOS() && !isStandalone()) { buildChip('ios'); }
  };

  window.addEventListener('appinstalled', function () {
    setInstalled();
    deferred = null;
    hideItem();
    removeChip();
  });

  // iOS never fires beforeinstallprompt, so surface the option on load: reveal
  // the Profile-menu item and show the instructional chip once per session.
  window.addEventListener('load', function () {
    // v3.1.88 -- TD-957: running as the installed app proves it is installed; the browser that
    // owns this storage stops offering the chip.
    if (isStandalone()) { setInstalled(); }
    if (isIOS() && !isStandalone()) {
      showItem();
      setTimeout(maybeShowIosChip, 1200);
    }
  });
})();
