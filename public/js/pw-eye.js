/* TF-18: persistent show/hide eye on every password input, across all pages.
   Self-contained: wraps each password field with an always-visible toggle.
   A MutationObserver picks up password inputs added after load (e.g. the invite
   page builds its registration form at runtime). Styling lives in style.css
   (.pw-eye-wrap / .pw-eye-btn), which every page already loads. */
(function () {
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function wrap(input) {
    if (!input || input.getAttribute('type') !== 'password') return;
    if (input.dataset && input.dataset.pwEye) return;
    if (input.dataset) input.dataset.pwEye = '1';
    var parent = input.parentNode;
    if (!parent) return;

    var w = document.createElement('span');
    w.className = 'pw-eye-wrap';
    parent.insertBefore(w, input);
    w.appendChild(input);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye-btn';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('tabindex', '-1');
    btn.innerHTML = EYE;
    btn.addEventListener('click', function () {
      var reveal = (input.getAttribute('type') === 'password');
      input.setAttribute('type', reveal ? 'text' : 'password');
      btn.innerHTML = reveal ? EYE_OFF : EYE;
      btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    });
    w.appendChild(btn);
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll('input[type="password"]');
    for (var i = 0; i < nodes.length; i++) wrap(nodes[i]);
  }

  function init() {
    scan(document);
    if (window.MutationObserver && document.body) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.matches && n.matches('input[type="password"]')) wrap(n);
            if (n.querySelectorAll) scan(n);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
