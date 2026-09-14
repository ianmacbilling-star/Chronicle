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
// THE PAGE LIST IS ONE LINE, and v3.0.903 is the proof: swapping five placeholders for fourteen
// real pages was three edits -- COUNT, V, and the files themselves. Nothing else in here moved.
//
// THE FOURTEEN, in order. The first four are the only ones most visitors see, so they carry the
// argument between them: a dark interior drama, a bright modern real-life page, a finished COVER
// so that "book" registers early, and a full-bleed fantasy battlefield.
//
//   1  Knock at the Closed Door      Our Family Stories     family memoir / period drama
//   2  The Long Way Down             test campaign          real life, modern, textless
//   3  (cover)                       Dojo of the Dragon Spirits   a cover, and a title
//   4  The Last Cultist Falls        The Strangers          dark fantasy, full-bleed
//   5  Paddle Raft Chaos             River of No Return     family adventure
//   6  Filling the Cavity            Going to the Dentist   children's / skill story
//   7  The Drop Point                Streets of Silver Shadow   pen and ink, handwritten type
//   8  The Company                   Embers of Damnation    the character page
//   9  Hell of a First Date          The ANOMALIES          comic-page layout, superhero
//  10  The Signal Arrives            test campaign          science fiction
//  11  The Shadow Grabs a Star       Starbound Skies        anime-leaning, aurora palette
//  12  Stranger at the Door          test campaign          romance / suspense
//  13  Laughter That Becomes Music   Dojo of the Dragon Spirits   luminous high fantasy
//  14  I'd a Bet on Him Too          Our Family Stories     the closing beat
//
// ELEVEN GENRES, SEVEN ART STYLES, FOUR LAYOUTS, a cover and a character page. The two styles
// still unrepresented are watercolor and charcoal.
//
// SLOT TEN WAS RE-PICKED IN v3.0.904. The first science-fiction page was a fleet action -- ships
// and empty space, like every other page in that book. This one is a control room with four
// people around a console, faces lit blue by the screens. It is the only bright page in a very
// dark book, which is what a panel on a near-black page needs, and it is the only one with
// anybody in it.
//
// SLOT ELEVEN WAS RE-PICKED IN v3.0.906, on the same reasoning and at Ian's direction. The
// Aetherheart Disturbance was a sky -- enormous, and nobody in it bigger than a thumbnail. The
// Shadow Grabs a Star is two characters at arm's length, lit by the fragment one of them is
// holding, with the comet field behind them. A panel this small wants faces.
//
// AT 3.8 SECONDS A PAGE THIS IS A 53-SECOND CYCLE and nobody sees the end of it. The coverage is
// for the pages' own sake; the ORDER is what a visitor actually experiences.
(function () {
  'use strict';
  var V = '3.0.906';        // cache stamp -- bump when the pictures are replaced in place
  var COUNT = 14;             // story-pic1.jpg .. story-pic14.jpg
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
