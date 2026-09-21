const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, isAdminEmail, isTesterEmail } = require('../middleware/auth');

// =============================================================================================
// v3.0.950 -- TD-804. THE UPDATES LIST. Spec: claude/UPDATES_LIST_SPEC.md.
//
// ONE LIST, TWO AUDIENCES. A normal user sees the entries marked public, as bullets. An admin
// or anyone on TESTER_EMAILS sees every entry with the tester description underneath -- which is
// where the test bots' instructions live.
//
// THE GATE IS HERE, ON THE SERVER, AND THAT IS THE WHOLE SECURITY OF THIS FEATURE. A normal
// user's browser never RECEIVES the descriptions or the non-public entries. Hiding them in the
// page with CSS or an if would be a leak with a stylesheet in front of it: these descriptions
// name admin paths, unreleased work and things deliberately not announced.
// =============================================================================================

// READ ONCE AT STARTUP, exactly like routes/campaignia_brain.md in routes/help.js. A change to
// the file therefore needs a DEPLOY, not a save -- say so on every batch that touches it.
//
// AND IT MUST NOT BE ABLE TO STOP THE BOOT. A blank Updates page is a nuisance; an application
// that will not start because a changelog has a stray comma in it is not acceptable. Every
// failure below returns an empty list and logs.
const UPDATES = (function () {
  var p = path.join(__dirname, '..', 'data', 'updates.json');
  try {
    var parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.error('updates: data/updates.json is not an array; serving an empty list');
      return [];
    }
    return parsed;
  } catch (e) {
    console.error('updates: could not load data/updates.json:', e && e.message);
    return [];
  }
})();

// NUMERIC, PART BY PART. A string sort puts 3.0.95 after 3.0.949, which is wrong and which is
// exactly the kind of thing nobody notices until the list has enough versions in it.
function compareVersions(a, b) {
  var A = String(a || '').split('.');
  var B = String(b || '').split('.');
  for (var i = 0; i < Math.max(A.length, B.length); i++) {
    var x = parseInt(A[i], 10); if (isNaN(x)) x = 0;
    var y = parseInt(B[i], 10); if (isNaN(y)) y = 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// v3.0.951 -- TD-804 batch B. THE OBSERVED DATES.
//
// Read per request rather than cached at startup, because unlike the entries themselves this
// changes WITHOUT a deploy: the row for the running version is written at boot, and on a fresh
// database the first request can arrive before anybody has looked at the page.
//
// A FAILURE HERE COSTS THE DATES AND NOTHING ELSE. Could-not-read is returned as an empty map,
// so the page renders the entries with no date rather than failing -- and an empty map means
// "we have no record", which the page states as such instead of guessing.
async function releaseDates() {
  var map = {};
  try {
    const db = await getDb();
    const rows = await db.prepare('SELECT version, first_seen FROM version_releases').all();
    (rows || []).forEach(function (r) {
      if (!r || !r.version) return;
      var d = r.first_seen;
      var iso = (d && typeof d.toISOString === 'function') ? d.toISOString() : String(d || '');
      if (iso) map[String(r.version)] = iso.slice(0, 10);
    });
  } catch (e) {
    console.error('updates: could not read version_releases:', e && e.message);
  }
  return map;
}

// THE FILTER. Given the whole file and one viewer, return what that viewer is allowed to have.
// Exported so the batch guard can drive it directly with a fixture of each viewer type and assert
// the OUTPUT -- a grep for an if proves nothing about what goes over the wire.
function viewFor(all, privileged, releases) {
  var out = [];

  // v3.0.957 -- WHEN DID THIS VERSION LAND HERE?
  //
  // Every recorded version, in order. A row is an observed boot; the seed fills in the ones
  // that booted before the table existed.
  var _recorded = Object.keys(releases || {}).sort(compareVersions);
  (Array.isArray(all) ? all : []).forEach(function (block) {
    if (!block || !Array.isArray(block.entries)) return;
    var entries = [];
    block.entries.forEach(function (e) {
      if (!e) return;
      if (privileged) {
        entries.push({
          id: e.id,
          kind: e.kind === 'fix' ? 'fix' : 'feature',
          public: e.public === true,
          summary: String(e.summary || ''),
          detail: String(e.detail || ''),
          td: Array.isArray(e.td) ? e.td : []
        });
        return;
      }
      // NOT privileged. Only public entries, and ONLY the two fields a bullet needs. The others
      // are not emptied, they are ABSENT -- an empty detail key still tells a reader that a
      // description exists and that they are not being given it.
      if (e.public !== true) return;
      entries.push({
        kind: e.kind === 'fix' ? 'fix' : 'feature',
        summary: String(e.summary || '')
      });
    });
    // A version with nothing this viewer may see is not an empty heading; it is not there.
    if (!entries.length) return;
    var o = { version: String(block.version || ''), entries: entries };

    // WHAT THIS DATE IS, EXACTLY: the first time this version ran in THIS environment. On
    // production that is the day it went live, which is the date that means something to a
    // reader. On staging it is the day staging got it. No row means no record -- which the
    // page states rather than papering over with a date it does not have.
    //
    // A STAGING DATABASE CANNOT KNOW WHAT PRODUCTION IS RUNNING, and asking it to would mean
    // one environment reaching into the other's database -- the coupling this whole design
    // exists to avoid. So the honest word is HERE, and the page says so.
    // v3.0.957 -- AN EXACT ROW, OR THE PROMOTE THAT CARRIED IT.
    //
    // A version with no row of its own was never deployed here under its own number: it
    // arrived inside the next deploy that was. So the first recorded version ABOVE it is the
    // one that brought it, and that deploy's date is the day this change went live here.
    // That is not an approximation of the landing date; it IS the landing date.
    //
    // Production went 948 -> 955 in a single promote, which is why this matters there and
    // never showed on staging: staging deploys every push, so every version has its own row.
    //
    // NOTHING ABOVE IT AND NO ROW leaves the date empty and the page says nothing. That can
    // only happen if the running version's own boot write failed, and inventing a date to
    // cover for a failure is the thing this whole feature exists not to do.
    var _seen = (releases && releases[o.version]) || '';
    if (!_seen) {
      for (var _ri = 0; _ri < _recorded.length; _ri++) {
        if (compareVersions(_recorded[_ri], o.version) > 0) { _seen = releases[_recorded[_ri]]; break; }
      }
    }
    if (_seen) o.first_seen = _seen;
    // v3.0.957 -- THE BUILD DATE IS GONE, from the payload and not merely from the screen.
    // It answered a question nobody was asking ("when was this compiled") beside the one they
    // were ("when did this reach me"), and two dates on one line made the second harder to
    // read. A field left in the payload that nothing renders is an invitation to render it
    // again. data/updates.json still carries staged_on; it is simply not served.
    out.push(o);
  });
  out.sort(function (a, b) { return compareVersions(b.version, a.version); });
  return out;
}

// ONE PLACE DECIDES, AND IT IS EXPORTED SO THE GUARD CAN DRIVE IT.
//
// This started life as two lines inside the route handler, which meant the batch guard could
// only test viewFor() -- and a mutation that hardcoded the handler's privileged flag to true
// sailed straight through, because nothing exercised the DECISION. Pulling it out is what makes
// the leak testable end to end rather than one layer down from where it would happen.
function isPrivilegedEmail(email) {
  return !!(email && (isAdminEmail(email) || isTesterEmail(email)));
}

function payloadFor(email, releases) {
  var privileged = isPrivilegedEmail(email);
  return { ok: true, privileged: privileged, versions: viewFor(UPDATES, privileged, releases || {}) };
}

// GET /api/updates
//
// WHO IS ASKING IS RESOLVED FROM req.session.userId, NOT FROM ANYTHING THE CLIENT SENDS.
// That also gives impersonation the right answer for free: while an admin is impersonating a
// customer, req.session.userId IS the customer, so the admin sees the page as the customer sees
// it -- which is the entire point of impersonating somebody to reproduce what they are looking
// at. Same property requireAdmin relies on (TD-179).
router.get('/', requireAuth, async function (req, res) {
  try {
    var email = '';
    try {
      const db = await getDb();
      const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
      email = (user && user.email) || '';
    } catch (e) {
      // COULD NOT TELL IS NOT THE SAME AS YES (TD-587). If the lookup fails we do not know who
      // this is, so they get the public view -- the smaller answer, never the larger one.
      console.error('updates: could not resolve the viewer:', e && e.message);
      email = '';
    }
    res.json(payloadFor(email, await releaseDates()));
  } catch (e) {
    console.error('updates error:', e && e.message);
    res.json({ ok: true, privileged: false, versions: [] });
  }
});

module.exports = router;
module.exports.viewFor = viewFor;
module.exports.compareVersions = compareVersions;
module.exports.isPrivilegedEmail = isPrivilegedEmail;
module.exports.payloadFor = payloadFor;
