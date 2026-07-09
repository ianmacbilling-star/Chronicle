// Promo capture: if an ad link lands with ?promo=CODE, stash it in a 30-day cookie
// so it survives browsing until signup. getStashedPromo() returns the current code
// (URL takes priority over cookie). Attribution only -- no grant happens here.
(function () {
  try {
    var m = new URLSearchParams(window.location.search).get('promo');
    if (m) {
      m = m.trim().toUpperCase().slice(0, 40);
      if (/^[A-Z0-9_-]+$/.test(m)) {
        var exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
        document.cookie = 'promo_code=' + encodeURIComponent(m) + '; expires=' + exp + '; path=/; SameSite=Lax';
      }
    }
  } catch (e) {}
})();
window.getStashedPromo = function () {
  try {
    var url = new URLSearchParams(window.location.search).get('promo');
    if (url) return url.trim().toUpperCase().slice(0, 40);
    var m = document.cookie.match(/(?:^|;\s*)promo_code=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
};
