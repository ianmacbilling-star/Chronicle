// Shared auth middleware. All campaign authorization flows through here
// after the Phase 2 refactor — single source of truth for "can this user
// see / modify this campaign?"
//
// Membership model (Phase 1 schema):
// - A user can be a member of a campaign with role 'dm' or 'player'
// - One role per user per campaign (UNIQUE constraint)
// - The campaign creator gets a 'dm' row at creation time (backfilled
//   on existing campaigns)

const { getDb } = require('../database/db');

// Throttled "last seen" stamp for the account-lifecycle idle clock
// (ACCOUNT_LIFECYCLE_SPEC Phase 0). Updates users.last_active_at at most once
// per ~12h per user per process (in-memory throttle) via a conditional write
// that also no-ops at the DB if the column is already fresh. Fire-and-forget:
// it must never block or fail a request.
const _lastSeenStamp = new Map(); // userId -> ms of last stamp in THIS process
const _SEEN_THROTTLE_MS = 12 * 60 * 60 * 1000;
function stampLastActive(userId) {
  if (!userId) return;
  const nowMs = Date.now();
  const prev = _lastSeenStamp.get(userId);
  if (prev && (nowMs - prev) < _SEEN_THROTTLE_MS) return;
  _lastSeenStamp.set(userId, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - _SEEN_THROTTLE_MS).toISOString();
  Promise.resolve().then(async function () {
    try {
      const db = await getDb();
      await db.prepare(
        'UPDATE users SET last_active_at = ? WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)'
      ).run(nowIso, userId, cutoffIso);
    } catch (e) { /* non-fatal: lifecycle stamp must never break a request */ }
  });
}

// Session check — must be logged in.
// v3.0.589 -- TD-179 STAGE 2. IMPERSONATION EXPIRY AND ACTIVITY POLLUTION.
// Spec sections 3.3 and 4.3.
//
// EXPIRY (3.3): a forgotten browser tab must not leave a session logged in as a customer
// indefinitely. Checked on every authenticated request rather than on a timer, because there is no
// timer that outlives a process restart and this costs one integer comparison.
// The audit row is closed with end_reason 'expiry' -- fire and forget, because a failed audit write
// must never strand an admin inside somebody else's account.
//
// ACTIVITY POLLUTION (4.3): stampLastActive would record the TARGET as active, so support visits
// would look like user activity -- and last-active drives the account-lifecycle idle clock
// (ACCOUNT_LIFECYCLE_SPEC), so a support visit could silently postpone a deletion. The real admin's
// own activity is not stamped either; they are not using their account, they are using someone
// else's.
var IMPERSONATION_MAX_MS = 30 * 60 * 1000;
function impersonationExpired(req) {
  if (!req.session || !req.session.impersonatorId) return false;
  var started = Number(req.session.impersonateStartedAt || 0);
  return !started || (Date.now() - started) > IMPERSONATION_MAX_MS;
}
// THE TOKENS SPENT ARE COUNTED FROM token_ledger, NOT FROM A COUNTER.
// Ian wants to hand tokens back after a support visit -- "give them back the tokens and even more
// for their trouble" -- and guessing the number after the fact is exactly what nobody does
// accurately. A counter would have meant incrementing at every spend site in the app, several of
// which do not have `req` in scope, and a field that only SOME paths remember to update is worse
// than no field: it reads as authoritative and is quietly low.
// The ledger already records every debit with a timestamp, so the honest number is a query over the
// window the session was open. token_ledger is the record; this just reads it.
function endImpersonation(req, reason) {
  var rowId = req.session.impersonationRowId;
  var targetId = req.session.userId;
  var startedMs = Number(req.session.impersonateStartedAt || 0);
  req.session.userId = req.session.impersonatorId;
  delete req.session.impersonatorId;
  delete req.session.impersonatorEmail;
  delete req.session.impersonateTargetEmail;
  delete req.session.impersonateStartedAt;
  delete req.session.impersonationRowId;
  if (rowId) {
    (async function () {
      var spent = 0;
      try {
        const db = await getDb();
        if (targetId && startedMs) {
          const r = await db.prepare(
            'SELECT COALESCE(SUM(-amount), 0) AS spent FROM token_ledger ' +
            'WHERE user_id = ? AND amount < 0 AND created_at >= ?'
          ).get(targetId, new Date(startedMs).toISOString());
          spent = (r && Number(r.spent)) || 0;
        }
      } catch (e) { console.error('[impersonate] could not total tokens for row ' + rowId + ': ' + ((e && e.message) || e)); }
      try {
        const db2 = await getDb();
        await db2.prepare("UPDATE admin_impersonations SET ended_at = CURRENT_TIMESTAMP, end_reason = ?, tokens_spent = ? WHERE id = ? AND ended_at IS NULL")
          .run(String(reason || 'manual'), spent, rowId);
      } catch (e) { console.error('[impersonate] could not close audit row ' + rowId + ': ' + ((e && e.message) || e)); }
    })();
  }
}
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (impersonationExpired(req)) endImpersonation(req, 'expiry');
  if (!req.session.impersonatorId) stampLastActive(req.session.userId);
  next();
}
// v3.0.589 -- TD-179. AUTHORISE ON THE ADMIN BEHIND THE SESSION, NOT THE USER IN FRONT OF IT.
//
// THE TRAP THIS EXISTS FOR (spec 4.1): the moment you impersonate you are NOT an admin, because
// requireAdmin resolves the email of req.session.userId and that is now the customer. That is
// correct and load-bearing -- it stops impersonation chaining and keeps admin routes unreachable
// from an impersonated session. But three things must still work from inside:
//
//   1. STOP. Gated on requireAdmin you would lock yourself into the account.
//   2. ADD TOKENS. Ian, 2026-08-09: "a user has trouble doing something that costs tokens, I go in
//      there, do what I can to fix it, and I want to just be able to give them back the tokens and
//      even more for their trouble." Re-enabling admin inside the session would break the single
//      question; asking a DIFFERENT question -- is there a real admin behind this session -- gives
//      the capability without touching the rule.
//   3. The diagnostics-by-campaign bundle (spec 4.2), when it is built.
//
// The authority is the REAL ADMIN'S and the audit row already names them, so an Add Tokens grant
// made from inside is attributable to the admin rather than appearing as the user crediting
// themselves.
async function requireImpersonatorOrAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.impersonatorId) {
    if (impersonationExpired(req)) {
      endImpersonation(req, 'expiry');
      return res.status(403).json({ error: 'That support session has expired. Start it again.' });
    }
    return next();
  }
  return requireAdmin(req, res, next);
}

// Returns 'dm' | 'player' | null. Plain helper — use inside route bodies
// when you need to KNOW the role (e.g. to gate certain UI fields). Use
// the verify* middleware below when you just need to GATE access.
async function getCampaignRole(userId, campaignId) {
  if (!userId || !campaignId) return null;
  try {
    const db = await getDb();
    const row = await db.prepare(
      'SELECT role FROM campaign_members WHERE user_id = ? AND campaign_id = ?'
    ).get(userId, campaignId);
    return row ? row.role : null;
  } catch (e) {
    return null;
  }
}

// Middleware: any campaign member (DM or player) may proceed.
// For READ-style routes — viewing a campaign, its sessions, its
// storyboard, etc. Phase 4 (forks) will heavily lean on this for the
// player experience.
async function verifyCampaignMember(req, res, next) {
  const campaignId = req.params.campaignId;
  const role = await getCampaignRole(req.session.userId, campaignId);
  if (!role) return res.status(403).json({ error: 'Access denied' });
  req.campaignRole = role;
  // Backward compat: existing route code reads req.campaign — fetch it.
  const db = await getDb();
  req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  next();
}

// Middleware: DM-only. For WRITE-style routes — editing characters,
// creating sessions, deleting things, etc. Today most existing routes
// fall here because no role-aware UI exists yet; Phase 4 may relax some
// of these for players (e.g. fork-scoped writes).
async function verifyCampaignDM(req, res, next) {
  const campaignId = req.params.campaignId;
  const role = await getCampaignRole(req.session.userId, campaignId);
  if (role !== 'dm') return res.status(403).json({ error: 'DM access required' });
  req.campaignRole = role;
  const db = await getDb();
  req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  next();
}

// Asset creation: the DM always; a player only when the campaign's
// allow_member_assets flag is on. Per-tier asset COUNT caps are still
// enforced in the route (assetCapBlock) regardless of this gate.
async function verifyCampaignAssetCreator(req, res, next) {
  const campaignId = req.params.campaignId;
  const role = await getCampaignRole(req.session.userId, campaignId);
  if (!role) return res.status(403).json({ error: 'Access denied' });
  req.campaignRole = role;
  const db = await getDb();
  req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const allowMembers = req.campaign && (req.campaign.allow_member_assets === true || req.campaign.allow_member_assets === 1 || req.campaign.allow_member_assets === 't' || req.campaign.allow_member_assets === 'true');
  if (role !== 'dm' && !allowMembers) {
    return res.status(403).json({ error: 'The Story Master has not enabled members to add assets in this campaign.' });
  }
  next();
}

// Convenience: SQL subquery fragments for inline membership checks. Use
// in routes where the campaign is reached via JOIN and full middleware
// wrapping is awkward (e.g. when only session_id is in the URL params
// and the campaign is derived through the join). Caller binds user_id.
const memberSubquery = '(SELECT campaign_id FROM campaign_members WHERE user_id = ?)';
const dmSubquery = "(SELECT campaign_id FROM campaign_members WHERE user_id = ? AND role = 'dm')";

// Phase 3 Deploy 3 — middleware for routes a player may invoke on their
// OWN character. Passes if user is DM of the campaign, OR is the
// owner_user_id of the character identified by req.params.id (the
// character-id URL segment used by the characters routes). The route
// must additionally enforce campaign-lock state where appropriate (use
// isCampaignLocked() below).
async function verifyCampaignDmOrCharacterOwner(req, res, next) {
  const campaignId = req.params.campaignId;
  const characterId = req.params.id || req.params.characterId;
  const userId = req.session.userId;
  const role = await getCampaignRole(userId, campaignId);
  if (!role) return res.status(403).json({ error: 'Access denied' });
  if (role === 'dm') {
    req.campaignRole = 'dm';
    const db = await getDb();
    req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    return next();
  }
  // role === 'player' — check character ownership
  if (!characterId) return res.status(403).json({ error: 'DM access required' });
  const db = await getDb();
  const ch = await db.prepare(
    'SELECT id, owner_user_id, campaign_id FROM characters WHERE id = ?'
  ).get(characterId);
  if (!ch || String(ch.campaign_id) !== String(campaignId)) {
    return res.status(404).json({ error: 'Character not found in this campaign' });
  }
  if (ch.owner_user_id !== userId) {
    return res.status(403).json({ error: 'You can only edit your own character' });
  }
  req.campaignRole = 'player';
  req.character = ch;
  req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  next();
}

// Phase 3 Deploy 3 — campaign lock check. "Locked" means any session in
// the campaign has player_access_status === 'ready'. Once locked,
// players can no longer canonical-edit their characters — they'd edit
// via forks in Phase 4. Returns boolean.
//
// IMPORTANT (forks migration note): today this reads sessions.player_access_status.
// In Phase 4, this column moves to session_forks.player_access_status —
// the lock semantics will refer to the DM's fork being ready. Update
// this function accordingly when forks land.
async function isCampaignLocked(campaignId) {
  if (!campaignId) return false;
  try {
    const db = await getDb();
    const row = await db.prepare(
      "SELECT 1 AS hit FROM session_forks f JOIN sessions s ON s.id = f.session_id " +
      "WHERE s.campaign_id = ? AND f.role = 'dm' AND f.player_access_status = 'ready' LIMIT 1"
    ).get(campaignId);
    return !!row;
  } catch (e) {
    return false;
  }
}

// Phase 4 Step 2 — write-guard for fork-scoped routes. Passes if the
// caller is the campaign DM, OR owns the fork identified by
// req.params.forkId / body.fork_id / query.fork_id. Used by Step 3
// fork-editing routes. DM may touch any fork; a player only their own.
async function verifyForkOwnerOrDm(req, res, next) {
  const campaignId = req.params.campaignId;
  const forkId = req.params.forkId || (req.body && req.body.fork_id) || req.query.fork_id;
  const userId = req.session.userId;
  const role = await getCampaignRole(userId, campaignId);
  if (!role) return res.status(403).json({ error: 'Access denied' });
  const db = await getDb();
  req.campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (role === 'dm') { req.campaignRole = 'dm'; return next(); }
  if (!forkId) return res.status(403).json({ error: 'Version required' });
  const fork = await db.prepare('SELECT id, user_id, role FROM session_forks WHERE id = ?').get(forkId);
  if (!fork) return res.status(404).json({ error: 'Version not found' });
  if (String(fork.user_id) !== String(userId)) return res.status(403).json({ error: 'You can only edit your own version' });
  req.campaignRole = 'player';
  req.fork = fork;
  next();
}

// v3.0.672 -- TD-475. THE TESTER LIST.
//
// Ian, 2026-08-17: "I have and will always need a few people testing the application. Right now
// there is no way to not charge these testers as they use the system."
//
// Same shape as ADMIN_EMAILS on purpose: an env var, read fresh on every call, never cached and
// never stored on the user row. Two consequences that are the whole point -- adding someone takes
// effect on their next request, and REMOVING someone takes effect just as fast, with no row to go
// and clean up afterwards.
//
// WHAT BEING ON THIS LIST DOES: it exempts nobody from anything automatically. It unlocks the three
// self-only testing controls (set-tier, dev-credit, dev-grant-monthly) that were admin-only, so a
// tester can put themselves on any tier and top up their own tokens. Their tier is then whatever
// they set it to and no Stripe subscription is required to hold it.
//
// WHAT IT DOES NOT DO: book orders. Those charge a real card for real paper, and a tester ordering a
// book pays for it -- which is also the only way the order pipeline ever gets tested (TD-471).
function testerEmails() {
  return (process.env.TESTER_EMAILS || '').split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
}
function isTesterEmail(email) {
  if (!email) return false;
  return testerEmails().indexOf(String(email).trim().toLowerCase()) >= 0;
}

// Admin gate. Source of truth = ADMIN_EMAILS env var (comma-separated
// list of emails). Express middleware for admin-only routes.
// v3.0.672 -- TD-475. ADMIN OR TESTER, for the three SELF-ONLY testing controls.
//
// Deliberately a separate function rather than a flag on requireAdmin: everything else behind the
// Dashboard acts across ALL users, and widening the wrong gate by one character would hand a tester
// the tier editor, the promo codes and the impersonation trail. The three routes this guards write
// to req.session.userId and nothing else -- verified, not assumed -- so the worst a tester can do
// with them is change their own account, which is the entire intent.
async function requireAdminOrTester(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(403).json({ error: 'Admin access required' });
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
    if (adminEmails.includes(user.email) || isTesterEmail(user.email)) return next();
    return res.status(403).json({ error: 'Admin access required' });
  } catch (e) {
    return res.status(500).json({ error: 'Admin check failed' });
  }
}

async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
    if (!user || !adminEmails.includes(user.email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Admin check failed' });
  }
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireAdminOrTester,
  isTesterEmail,
  getCampaignRole,
  verifyCampaignMember,
  verifyCampaignDM,
  verifyCampaignAssetCreator,
  verifyCampaignDmOrCharacterOwner,
  verifyForkOwnerOrDm,
  isCampaignLocked,
  memberSubquery,
  dmSubquery,
  // v3.0.589 -- TD-179 stage 2.
  requireImpersonatorOrAdmin, impersonationExpired, endImpersonation, IMPERSONATION_MAX_MS
};
