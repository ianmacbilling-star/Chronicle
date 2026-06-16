/*
 * Campaignia PWA bootstrap: registers the service worker and offers a small,
 * dismissible "Install" chip. Everything here fails open -- if service workers
 * are unsupported or registration throws, the site works exactly as before.
 */
(function () {
  'use strict';

  // 1) Register the service worker (best-effort).
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* fail open */ });
    });
  }

  // 2) Custom install prompt: capture beforeinstallprompt, show a gentle chip.
  var deferred = null;
  var DISMISS_KEY = 'cmpInstallDismissed';

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
  }

  function removeChip() {
    var el = document.getElementById('cmp-install-chip');
    if (el && el.parentNode) { el.parentNode.removeChild(el); }
  }

  function showChip() {
    if (dismissed() || document.getElementById('cmp-install-chip')) { return; }
    var bar = document.createElement('div');
    bar.id = 'cmp-install-chip';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Install Campaignia');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:2147483000', 'display:flex', 'align-items:center', 'gap:12px',
      'max-width:92vw', 'padding:10px 12px 10px 14px', 'border-radius:12px',
      'background:rgba(10,8,6,0.97)', 'border:1px solid rgba(201,168,76,0.35)',
      'box-shadow:0 8px 28px rgba(0,0,0,0.5)', 'font-family:Georgia,serif', 'color:#f0e8d0'
    ].join(';');

    var icon = document.createElement('img');
    icon.src = '/images/cmp-icon-192.png';
    icon.alt = '';
    icon.style.cssText = 'width:34px;height:34px;border-radius:7px;flex:0 0 auto;';

    var label = document.createElement('span');
    label.textContent = 'Install Campaignia';
    label.style.cssText = 'font-size:14px;color:#e8d5a3;white-space:nowrap;';

    var install = document.createElement('button');
    install.type = 'button';
    install.textContent = 'Install';
    install.style.cssText = 'font-family:Georgia,serif;font-size:13px;font-weight:700;color:#160e06;background:#c9a84c;border:none;padding:7px 14px;border-radius:8px;cursor:pointer;flex:0 0 auto;';
    install.addEventListener('click', function () {
      removeChip();
      if (!deferred) { return; }
      var p = deferred; deferred = null;
      p.prompt();
      if (p.userChoice && p.userChoice.then) {
        p.userChoice.then(function () { remember(); });
      } else {
        remember();
      }
    });

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '&#215;';
    close.style.cssText = 'font-family:Georgia,serif;font-size:18px;line-height:1;color:rgba(201,168,76,0.7);background:none;border:none;padding:4px 6px;cursor:pointer;flex:0 0 auto;';
    close.addEventListener('click', function () { remember(); removeChip(); });

    bar.appendChild(icon);
    bar.appendChild(label);
    bar.appendChild(install);
    bar.appendChild(close);
    document.body.appendChild(bar);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (dismissed()) { return; }
    // Show after a short beat so it doesn't fight the first paint.
    setTimeout(showChip, 1500);
  });

  window.addEventListener('appinstalled', function () { remember(); removeChip(); });
})();
