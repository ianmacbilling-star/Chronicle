// Phase 3 multi-user — invite creation, landing, acceptance.
//
// Design (locked in V3 handoff doc Section 15):
// - Each invite binds to a specific PC the invitee will own
// - 7-day expiration, single-use
// - DM provides invitee email at creation; stored as email_hint for the
//   landing page + welcome email. NOT enforced — forwarded links work.
// - Creating a new invite to the same (campaign, email) auto-revokes
//   any prior unused invite to that pair
// - Only PCs invitable (NPCs are DM-controlled)
// - Non-Chronicle users can be invited: invite_token passed to register
//   endpoint auto-accepts post-signup

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember, getCampaignRole } = require('../middleware/auth');

const INVITE_TTL_DAYS = 7;

// Generate a URL-safe single-use token. 32 random bytes → 43-char base64url.
function newInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Compute expiry timestamp as ISO string.
function inviteExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + INVITE_TTL_DAYS);
  return d.toISOString();
}

// POST /api/campaigns/:campaignId/invites
// DM-only. Body: { email, character_id?, character_name?, character_class? }
// Either character_id (existing unclaimed PC) OR character_name (creates
// a stub PC) is required.
router.post('/campaigns/:campaignId/invites', requireAuth, verifyCampaignDM, async function(req, res) {
  const { email, character_id, character_name, character_class } = req.body || {};
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Email is required' });
  }
  if (!character_id && !character_name) {
    return res.status(400).json({ error: 'Pick an existing character or provide a name for a new one' });
  }
  const campaignId = parseInt(req.params.campaignId, 10);
  const normalizedEmail = email.trim().toLowerCase();
  const db = await getDb();

  // Resolve the target character — either existing or new stub.
  let targetCharacterId = character_id ? parseInt(character_id, 10) : null;

  if (targetCharacterId) {
    // Verify the character belongs to this campaign, is a PC, and isn't
    // already claimed by another player.
    const ch = await db.prepare(
      'SELECT id, campaign_id, is_npc, owner_user_id FROM characters WHERE id = ?'
    ).get(targetCharacterId);
    if (!ch || ch.campaign_id !== campaignId) {
      return res.status(404).json({ error: 'Character not found in this campaign' });
    }
    if (ch.is_npc) {
      return res.status(400).json({ error: 'NPCs cannot be invited — invites are for PCs only' });
    }
    if (ch.owner_user_id) {
      return res.status(400).json({ error: 'That character already has a player' });
    }
  } else {
    // Create a stub PC awaiting claim. Marked is_claimed=false so the
    // Characters tab can show it as "awaiting invitee" in Deploy 2.
    // Note: the characters table column for character class is 'cls'
    // (not 'class' — 'class' is a reserved word in many SQL dialects).
    const now = new Date().toISOString();
    const stubName = character_name.trim();
    const stubClass = (character_class || '').trim();
    const ins = await db.prepare(
      'INSERT INTO characters (campaign_id, name, cls, is_npc, is_claimed, owner_user_id, created_at) ' +
      'VALUES (?, ?, ?, false, false, NULL, ?)'
    ).run(campaignId, stubName, stubClass, now);
    targetCharacterId = ins.lastInsertRowid;
  }

  // Auto-revoke any prior unused invite to the same (campaign, email).
  // We mark them used_at = now (consumed) and leave used_by NULL — the
  // combination (used_at IS NOT NULL AND used_by IS NULL) means
  // "revoked / superseded by new invite," vs (used_at IS NOT NULL AND
  // used_by IS NOT NULL) which means "genuinely accepted by user N."
  // This sidesteps needing a sentinel value (we tried -1 originally,
  // but used_by is a FK to users.id and -1 doesn't exist there). Future
  // improvement if more states need distinguishing: a dedicated
  // revoked_at column.
  await db.prepare(
    'UPDATE campaign_invites SET used_at = ?, used_by = NULL ' +
    'WHERE campaign_id = ? AND LOWER(email_hint) = ? AND used_at IS NULL'
  ).run(new Date().toISOString(), campaignId, normalizedEmail);

  const token = newInviteToken();
  const expires = inviteExpiresAt();
  const result = await db.prepare(
    'INSERT INTO campaign_invites (token, campaign_id, character_id, role, email_hint, created_by, expires_at) ' +
    "VALUES (?, ?, ?, 'player', ?, ?, ?)"
  ).run(token, campaignId, targetCharacterId, normalizedEmail, req.session.userId, expires);

  // Build the URL the DM can copy. APP_URL is the canonical origin (set
  // per environment). Falls back to the request's host as a last resort.
  const base = process.env.APP_URL || ('https://' + req.get('host'));
  const url = base.replace(/\/$/, '') + '/invite/' + token;

  res.json({
    id: result.lastInsertRowid,
    token: token,
    url: url,
    expires_at: expires,
    character_id: targetCharacterId,
    email_hint: normalizedEmail
  });
});

// GET /api/invites/:token
// PUBLIC — no auth required. Returns invite metadata for the landing
// page so unauthenticated visitors can see what they're being invited
// to. Returns errors for expired, used, or invalid tokens.
router.get('/invites/:token', async function(req, res) {
  const db = await getDb();
  const row = await db.prepare(
    'SELECT i.token, i.campaign_id, i.character_id, i.role, i.email_hint, i.expires_at, i.used_at, ' +
    'c.name AS campaign_name, ' +
    'ch.name AS character_name, ch.cls AS character_class, ' +
    'u.name AS created_by_name ' +
    'FROM campaign_invites i ' +
    'JOIN campaigns c ON i.campaign_id = c.id ' +
    'LEFT JOIN characters ch ON i.character_id = ch.id ' +
    'JOIN users u ON i.created_by = u.id ' +
    'WHERE i.token = ?'
  ).get(req.params.token);

  if (!row) return res.status(404).json({ error: 'INVALID', message: 'Invitation not found' });
  if (row.used_at) return res.status(410).json({ error: 'USED', message: 'This invitation has already been used or revoked' });
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'EXPIRED', message: 'This invitation has expired' });
  }

  res.json({
    token: row.token,
    campaign_name: row.campaign_name,
    character_name: row.character_name,
    character_class: row.character_class,
    role: row.role,
    invited_by: row.created_by_name,
    email_hint: row.email_hint,
    expires_at: row.expires_at
  });
});

// POST /api/invites/:token/accept
// Requires auth (the user accepting). Validates the invite, creates the
// campaign_members row, sets character ownership, marks invite used.
router.post('/invites/:token/accept', requireAuth, async function(req, res) {
  const db = await getDb();
  const invite = await db.prepare(
    'SELECT * FROM campaign_invites WHERE token = ?'
  ).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'INVALID' });
  if (invite.used_at) return res.status(410).json({ error: 'USED' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'EXPIRED' });

  // Reject if the accepting user is already a member of this campaign.
  // This prevents weird states (e.g. a DM accepting their own invite
  // would otherwise demote themselves to player, or stack memberships).
  const existing = await getCampaignRole(req.session.userId, invite.campaign_id);
  if (existing) {
    return res.status(409).json({ error: 'ALREADY_MEMBER', message: 'You are already in this campaign' });
  }

  // Create the membership row.
  await db.prepare(
    'INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?, ?, ?) ' +
    'ON CONFLICT (campaign_id, user_id) DO NOTHING'
  ).run(invite.campaign_id, req.session.userId, invite.role);

  // Claim the character: set ownership, flip is_claimed to true.
  if (invite.character_id) {
    await db.prepare(
      'UPDATE characters SET owner_user_id = ?, is_claimed = true WHERE id = ?'
    ).run(req.session.userId, invite.character_id);
  }

  // Mark the invite consumed.
  await db.prepare(
    'UPDATE campaign_invites SET used_at = ?, used_by = ? WHERE id = ?'
  ).run(new Date().toISOString(), req.session.userId, invite.id);

  res.json({
    success: true,
    campaign_id: invite.campaign_id,
    character_id: invite.character_id
  });
});

// DELETE /api/campaigns/:campaignId/invites/:inviteId
// DM-only. Revokes a pending invite. Deploy 2 will use this from the
// Members tab "pending invites" list. For Deploy 1 it exists so that
// revocation logic is testable.
router.delete('/campaigns/:campaignId/invites/:inviteId', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const inviteId = parseInt(req.params.inviteId, 10);
  const campaignId = parseInt(req.params.campaignId, 10);
  const inv = await db.prepare(
    'SELECT id, campaign_id, used_at FROM campaign_invites WHERE id = ?'
  ).get(inviteId);
  if (!inv || inv.campaign_id !== campaignId) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (inv.used_at) return res.status(409).json({ error: 'Already used or revoked' });
  // Revoked invites have used_at set but used_by NULL — see comment on
  // the auto-revoke logic above for the rationale.
  await db.prepare(
    'UPDATE campaign_invites SET used_at = ?, used_by = NULL WHERE id = ?'
  ).run(new Date().toISOString(), inviteId);
  res.json({ success: true });
});

// ============================================================
// PHASE 3 DEPLOY 2 — Members tab endpoints
// ============================================================

// GET /api/campaigns/:campaignId/members
// Any member of the campaign can see who else is in it. Players can
// view the Members tab read-only; the .dm-only convention hides the
// action menus on the frontend.
//
// Returns one row per member with the fields the UI needs to render
// the list: identity, role, character owned (if any), joined date.
router.get('/campaigns/:campaignId/members', requireAuth, verifyCampaignMember, async function(req, res) {
  const db = await getDb();
  try {
    const members = await db.prepare(
      'SELECT cm.user_id, cm.role, cm.joined_at, ' +
      'u.name AS user_name, u.email AS user_email, ' +
      'ch.id AS character_id, ch.name AS character_name, ch.cls AS character_class ' +
      'FROM campaign_members cm ' +
      'JOIN users u ON u.id = cm.user_id ' +
      'LEFT JOIN characters ch ON ch.owner_user_id = cm.user_id AND ch.campaign_id = cm.campaign_id ' +
      'WHERE cm.campaign_id = ? ' +
      "ORDER BY CASE cm.role WHEN 'dm' THEN 0 ELSE 1 END, cm.joined_at ASC"
    ).all(req.params.campaignId);
    res.json(members);
  } catch (e) {
    console.error('members list error:', e.message);
    res.status(500).json({ error: 'Could not load members' });
  }
});

// DELETE /api/campaigns/:campaignId/members/:userId
// DM-only. Remove a player from the campaign. Side effects:
// - delete the campaign_members row
// - any character they owned in this campaign: owner_user_id → NULL,
//   is_claimed → false (so the character is available for re-invite)
// - pending invites for that user's email are left alone (DM may have
//   sent other invites to the same email for different characters)
// - the user's tokens and image_generations rows are user-level and stay
//
// The DM cannot remove themselves. A second DM removing the first is
// not possible today (one-DM-per-campaign) — we'd revisit if that ever
// changes.
router.delete('/campaigns/:campaignId/members/:userId', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const campaignId = parseInt(req.params.campaignId, 10);
  const targetUserId = parseInt(req.params.userId, 10);

  if (targetUserId === req.session.userId) {
    return res.status(400).json({ error: 'You cannot remove yourself from the campaign' });
  }

  // Confirm the target is actually a member of this campaign.
  const member = await db.prepare(
    'SELECT user_id, role FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
  ).get(campaignId, targetUserId);
  if (!member) return res.status(404).json({ error: 'Member not found in this campaign' });
  if (member.role === 'dm') {
    return res.status(400).json({ error: 'Cannot remove the DM' });
  }

  // Release any characters they owned in this campaign.
  await db.prepare(
    'UPDATE characters SET owner_user_id = NULL, is_claimed = false WHERE campaign_id = ? AND owner_user_id = ?'
  ).run(campaignId, targetUserId);

  // Drop the membership row.
  await db.prepare(
    'DELETE FROM campaign_members WHERE campaign_id = ? AND user_id = ?'
  ).run(campaignId, targetUserId);

  res.json({ success: true });
});

// GET /api/campaigns/:campaignId/invites
// DM-only. List currently-pending invites for the Members tab. A
// "pending" invite is one with no used_at set (i.e. not consumed and
// not revoked). Both active AND expired-but-not-revoked invites are
// returned — the UI shows "expires in X days" or "expired (reactivate?)"
// distinctly. (Reactivation is a separate endpoint.)
router.get('/campaigns/:campaignId/invites', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  try {
    const invites = await db.prepare(
      'SELECT i.id, i.token, i.email_hint, i.expires_at, i.created_at, ' +
      'ch.id AS character_id, ch.name AS character_name, ch.cls AS character_class ' +
      'FROM campaign_invites i ' +
      'LEFT JOIN characters ch ON ch.id = i.character_id ' +
      'WHERE i.campaign_id = ? AND i.used_at IS NULL ' +
      'ORDER BY i.created_at DESC'
    ).all(req.params.campaignId);

    const base = process.env.APP_URL || ('https://' + req.get('host'));
    const baseTrimmed = base.replace(/\/$/, '');
    const now = new Date();
    const enriched = invites.map(function(i) {
      const exp = new Date(i.expires_at);
      const expired = exp < now;
      return {
        id: i.id,
        token: i.token,
        url: baseTrimmed + '/invite/' + i.token,
        email_hint: i.email_hint,
        character_id: i.character_id,
        character_name: i.character_name,
        character_class: i.character_class,
        expires_at: i.expires_at,
        created_at: i.created_at,
        expired: expired
      };
    });
    res.json(enriched);
  } catch (e) {
    console.error('invites list error:', e.message);
    res.status(500).json({ error: 'Could not load invites' });
  }
});

// POST /api/campaigns/:campaignId/invites/:inviteId/reactivate
// DM-only. Silently bumps expires_at to now + 7 days. Used when the DM
// hits Copy link on an expired invite — same token survives, link is
// usable again. The token never changes (so any old URL the DM shared
// via Discord/email still works after reactivation).
router.post('/campaigns/:campaignId/invites/:inviteId/reactivate', requireAuth, verifyCampaignDM, async function(req, res) {
  const db = await getDb();
  const inviteId = parseInt(req.params.inviteId, 10);
  const campaignId = parseInt(req.params.campaignId, 10);
  const inv = await db.prepare(
    'SELECT id, campaign_id, used_at, token FROM campaign_invites WHERE id = ?'
  ).get(inviteId);
  if (!inv || inv.campaign_id !== campaignId) {
    return res.status(404).json({ error: 'Invite not found' });
  }
  if (inv.used_at) {
    return res.status(409).json({ error: 'This invite has been used or revoked — create a new one' });
  }
  const newExpiry = inviteExpiresAt();
  await db.prepare(
    'UPDATE campaign_invites SET expires_at = ? WHERE id = ?'
  ).run(newExpiry, inviteId);
  res.json({ success: true, expires_at: newExpiry, token: inv.token });
});

module.exports = router;
