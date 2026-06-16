/*
 * Campaignia service worker.
 *
 * Design goals (deliberately conservative):
 *  - NETWORK-FIRST for everything. When online, the SW is effectively
 *    transparent: it fetches from the network and returns the fresh response,
 *    so users can never get stuck on a stale build. The cache is only a
 *    fallback used when the network fails (offline).
 *  - It only ever touches same-origin GET requests. Non-GET, cross-origin
 *    (R2 images, Google Fonts, Stripe, fal), and /api/* requests pass straight
 *    through untouched -- they are never intercepted or cached.
 *  - Versioned cache, cleaned up on activate.
 *  - Fails open: if anything throws, the network response (or a normal failure)
 *    is what the user gets, exactly as if no SW were installed.
 *
 * To disable/reset in an emergency: bump VERSION (old caches get purged on
 * activate), or remove /sw.js (browsers unregister a 404'd worker over time).
 */
var VERSION = 'cmp-v1';
var RUNTIME = 'cmp-runtime-' + VERSION;
var OFFLINE_URL = '/offline.html';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(RUNTIME)
      .then(function (cache) { return cache.add(new Request(OFFLINE_URL, { cache: 'reload' })); })
      .catch(function () { /* offline page precache is best-effort */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf('cmp-') === 0 && k !== RUNTIME) { return caches.delete(k); }
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only same-origin GET. Everything else is left entirely alone.
  if (req.method !== 'GET') { return; }
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) { return; }          // skip R2/fonts/Stripe/fal
  if (url.pathname.indexOf('/api/') === 0) { return; }           // never touch the API
  if (url.pathname === '/sw.js') { return; }                     // don't intercept self

  // Page navigations (HTML): network-first, fall back to cache, then offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        // Respect server intent: don't cache responses marked no-store.
        var cc = res.headers.get('Cache-Control') || '';
        if (res && res.status === 200 && cc.indexOf('no-store') === -1) {
          var copy = res.clone();
          caches.open(RUNTIME).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match(OFFLINE_URL);
        });
      })
    );
    return;
  }

  // Same-origin static assets (css/js/same-origin images): network-first, cache fallback.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(RUNTIME).then(function (c) { c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
