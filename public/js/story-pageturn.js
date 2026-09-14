// ============================================================
// STORY PAGE -- THE TURNING PAGE IN THE HERO PANEL
// v3.0.902 -- TD-772.
// ============================================================
//
// *(Ian, 2026-09-14: "animate one of those picture boxes to look like pages turning" /
// "Slow it down... maybe 3 to 4 seconds each page.")*
//
// 3.8 SECONDS A PAGE: 2600ms holding still, 1200ms turning. The turn duration lives in the
// stylesheet as a transition; TURN below only has to agree with it, and the guard checks that
// the two numbers match -- a script that swaps the images before the rotation finishes shows
// the reader the trick.
//
// THE PAGE LIST IS ONE LINE. Replacing the placeholders is: drop the new files in, change COUNT
// if it changed, bump V. Nothing else in this file moves.
(function () {
  'use strict';
  var V = '3.0.902';        // cache stamp -- bump when the pictures are replaced in place
  var COUNT = 5;              // story-pic1.jpg .. story-pic5.jpg
  var DWELL = 2600, TURN = 1200;  // TURN must equal the transition in landing-story.css

  function src(n) { return '/images/story-pic' + (((n % COUNT) + COUNT) % COUNT + 1) + '.jpg?v=' + V; }

  var box = document.getElementById('story-pageturn');
  if (!box || COUNT < 2) return;

  // ASKED NOT TO ANIMATE: do not. The panel already shows page one behind this, so returning
  // here leaves a picture rather than an empty box.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}

  var under = box.querySelector('.pt-under'),
      front = box.querySelector('.pt-front'),
      leaf  = box.querySelector('.pt-leaf');
  if (!under || !front || !leaf) return;

  var i = 0, timer = null, visible = true, running = false;

  front.style.backgroundImage = "url('" + src(0) + "')";
  under.style.backgroundImage = "url('" + src(1) + "')";

  // THE NEXT PAGE IS ALREADY FETCHED by the time it is needed: it is sitting in .pt-under for
  // the whole 2.6s dwell. That is the whole lazy-loading strategy -- pages 3 onward are never
  // requested until their turn comes round, so the hero costs one picture on first paint.
  function advance() {
    running = false;
    i++;
    front.style.backgroundImage = "url('" + src(i) + "')";
    under.style.backgroundImage = "url('" + src(i + 1) + "')";
    // Reset the leaf to flat WITHOUT animating back through 172 degrees, which would look like
    // the page flapping shut. Transition off, force a reflow so the browser accepts the new
    // transform as a starting point, transition back on.
    leaf.style.transition = 'none';
    box.classList.remove('turning');
    void leaf.offsetWidth;
    leaf.style.transition = '';
    schedule();
  }

  function turn() {
    // KEEP POLLING, NEVER ANIMATE UNSEEN. Rescheduling instead of cancelling is what stops a
    // scroll-past mid-turn from leaving `running` stuck true forever -- the first version
    // cleared the timer that finishes the turn, and the panel never turned again.
    if (!visible || running) { schedule(); return; }
    running = true;
    box.classList.add('turning');
    timer = setTimeout(advance, TURN);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(turn, DWELL);
  }

  // OFF SCREEN OR IN A BACKGROUND TAB, IT STOPS. An animation nobody is looking at is battery
  // and nothing else, and on a phone this panel leaves the screen almost immediately.
  function setVisible(v) { visible = v; }
  try {
    document.addEventListener('visibilitychange', function () { setVisible(!document.hidden); });
    if (window.IntersectionObserver) {
      new window.IntersectionObserver(function (rows) {
        setVisible(rows[0].isIntersecting && !document.hidden);
      }, { threshold: 0.1 }).observe(box);
    }
  } catch (e) {}

  schedule();
})();
