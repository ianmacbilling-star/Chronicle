/*
 * Campaignia PWA bootstrap: registers the service worker and drives the
 * "Install app" item in the Profile menu (works on desktop + mobile). Everything
 * fails open -- if the browser cannot install, the menu item simply stays hidden.
 */
(function () {
  'use strict';

  // Register the service worker (best-effort).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* fail open */ });
    });
  }

  // beforeinstallprompt fires when the app is installable and not already
  // installed. Stash it and reveal the Profile-menu item; the item calls
  // installApp() to trigger the native prompt on demand (desktop and mobile).
  var deferred = null;
  function item() { return document.getElementById('nav-install-item'); }
  function showItem() { var el = item(); if (el) el.style.display = ''; }
  function hideItem() { var el = item(); if (el) el.style.display = 'none'; }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    showItem();
  });

  window.installApp = function () {
    if (!deferred) { return; }
    var p = deferred;
    deferred = null;
    hideItem();
    p.prompt();
  };

  window.addEventListener('appinstalled', function () {
    deferred = null;
    hideItem();
  });
})();
