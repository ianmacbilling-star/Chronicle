// v3.3.00 -- TD-1035. "SEE WHAT THEY LOOK LIKE": photographs of real printed Campaignia books.
//
// Ian, 2026-10-27: "a link that opens up a dialog with these pics on it... On the 'A REAL BOOK'
// panel... 'See what they look like' link in small print." Ian's own photographs of books printed
// by Lulu from Campaignia (cropped by him; resized here to 1600px and 360px thumbnails, location
// data stripped). One file for the three landing pages; each page's link says which books lead
// (data-order), so the storyteller page opens on the family story and the game-masters page on
// the fantasy books. Everything is built on first click, so the page loads nothing extra until then.
(function () {
  'use strict';
  var BOOKS = {
    '01': 'Our Family Stories: A Horse Named Asterisk \u2014 front cover',
    '02': 'A Horse Named Asterisk \u2014 inside pages',
    '03': 'Embers of Damnation \u2014 front cover',
    '04': 'Embers of Damnation \u2014 title page and The Company',
    '05': 'For All the Ages \u2014 front cover',
    '06': 'For All the Ages \u2014 Session 1',
    '07': 'Streets of Silver & Shadow \u2014 Session 2',
    '08': 'The Strangers \u2014 front cover',
    '09': 'The Strangers \u2014 Session 2',
    '10': 'The Strangers \u2014 back cover'
  };
  var DEFAULT_ORDER = ['03', '01', '05', '08', '06', '02', '04', '07', '09', '10'];
  var modal = null, list = [], at = 0, lastFocus = null;

  function src(id, thumb) { return '/images/books/book-' + id + (thumb ? '-t' : '') + '.jpg'; }

  function orderFrom(el) {
    var want = String((el && el.getAttribute('data-order')) || '').split(',').map(function (s) { return s.trim(); });
    var out = [];
    want.forEach(function (id) { if (BOOKS[id] && out.indexOf(id) < 0) out.push(id); });
    DEFAULT_ORDER.forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });   // nothing is ever left out
    return out;
  }

  function build() {
    modal = document.createElement('div');
    modal.className = 'bkg-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Photos of printed Campaignia books');
    modal.innerHTML =
      '<div class="bkg-box">' +
        '<div class="bkg-head"><div class="bkg-title">Real books, really printed</div>' +
          '<button type="button" class="bkg-x" aria-label="Close">&times;</button></div>' +
        '<div class="bkg-stage">' +
          '<button type="button" class="bkg-nav bkg-prev" aria-label="Previous photo">&#8249;</button>' +
          '<img class="bkg-img" alt="">' +
          '<button type="button" class="bkg-nav bkg-next" aria-label="Next photo">&#8250;</button>' +
        '</div>' +
        '<div class="bkg-cap"></div>' +
        '<div class="bkg-strip"></div>' +
        '<div class="bkg-note">Photographs of books made with Campaignia and printed for their owners.</div>' +
      '</div>';
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('.bkg-x').addEventListener('click', close);
    modal.querySelector('.bkg-prev').addEventListener('click', function () { show(at - 1); });
    modal.querySelector('.bkg-next').addEventListener('click', function () { show(at + 1); });
    document.body.appendChild(modal);
  }

  function show(i) {
    if (!list.length) return;
    at = (i + list.length) % list.length;
    var id = list[at];
    var img = modal.querySelector('.bkg-img');
    img.src = src(id, false);
    img.alt = 'Photo of a printed Campaignia book: ' + BOOKS[id];
    modal.querySelector('.bkg-cap').textContent = BOOKS[id] + '  \u00b7  ' + (at + 1) + ' of ' + list.length;
    Array.prototype.forEach.call(modal.querySelectorAll('.bkg-thumb'), function (t, k) {
      t.classList.toggle('is-on', k === at);
      if (k === at && t.scrollIntoView) { try { t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    });
  }

  function onKey(e) {
    if (!modal || modal.style.display === 'none') return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); show(at + 1); }
  }

  function open(el) {
    if (!modal) build();
    list = orderFrom(el);
    var strip = modal.querySelector('.bkg-strip');
    strip.innerHTML = '';
    list.forEach(function (id, k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'bkg-thumb';
      b.setAttribute('aria-label', BOOKS[id]);
      b.innerHTML = '<img src="' + src(id, true) + '" alt="" loading="lazy">';
      b.addEventListener('click', function () { show(k); });
      strip.appendChild(b);
    });
    lastFocus = document.activeElement;
    modal.style.display = 'flex';
    document.documentElement.classList.add('bkg-open');
    show(0);
    try { modal.querySelector('.bkg-x').focus(); } catch (e) {}
  }

  function close() {
    if (!modal) return;
    modal.style.display = 'none';
    document.documentElement.classList.remove('bkg-open');
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('.book-gallery-link') : null;
    if (!a) return;
    e.preventDefault();
    open(a);
  });
  window.openBookGallery = open;
})();
