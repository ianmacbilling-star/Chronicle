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

module.exports = {
  requireAuth,
  getCampaignRole,
  verifyCampaignMember,
  verifyCampaignDM,
  memberSubquery,
  dmSubquery
};
