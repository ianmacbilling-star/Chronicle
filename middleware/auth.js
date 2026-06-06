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

// Session check — must be logged in.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
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

// Admin gate. Source of truth = ADMIN_EMAILS env var (comma-separated
// list of emails). Express middleware for admin-only routes.
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
  getCampaignRole,
  verifyCampaignMember,
  verifyCampaignDM,
  verifyCampaignDmOrCharacterOwner,
  verifyForkOwnerOrDm,
  isCampaignLocked,
  memberSubquery,
  dmSubquery
};
