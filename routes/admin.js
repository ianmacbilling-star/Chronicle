// ============================================================
// ADMIN ROUTES  (mounted at /api/admin)
// Admin-only. Source of truth for who is an admin = ADMIN_EMAILS env var,
// enforced by the requireAdmin middleware. Home of the admin Settings
// "Tiers" tab backend and (later) the rest of the Admin Dashboard.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const tiers = require('../middleware/tiers');
const { getDb } = require('../database/db');

const TIER_ORDER = ['copper', 'silver', 'gold', 'platinum'];

// GET /api/admin/tier-config
// Returns the EFFECTIVE (code defaults merged with DB overrides) value of
// each admin-editable field, per tier, so the Tiers tab prefills with the
// current live numbers. Also returns the tier order + field list so the UI
// can render generically as the field set grows.
router.get('/tier-config', requireAuth, requireAdmin, async function (req, res) {
  try {
    const out = {};
    TIER_ORDER.forEach(function (name) {
      const t = tiers.getTier(name);
      const row = { name: t.name };
      tiers.EDITABLE_TIER_FIELDS.forEach(function (f) {
        row[f] = (t[f] === undefined ? null : t[f]);
      });
      out[name] = row;
    });
    res.json({ tiers: out, order: TIER_ORDER, fields: tiers.EDITABLE_TIER_FIELDS });
  } catch (e) {
    console.error('GET tier-config error:', e.message);
    res.status(500).json({ error: 'Could not load tier config' });
  }
});

// PUT /api/admin/tier-config
// Body: { tier: 'gold', values: { max_archives_per_campaign: 20, ... } }
// Saves overrides for one tier and returns its merged effective config.
router.put('/tier-config', requireAuth, requireAdmin, async function (req, res) {
  try {
    const tier = req.body && req.body.tier;
    const values = (req.body && req.body.values) || {};
    if (!tier || !tiers.TIERS[tier]) return res.status(400).json({ error: 'Unknown tier' });
    const merged = await tiers.saveTierConfig(tier, values);
    res.json({ success: true, tier: tier, values: merged });
  } catch (e) {
    console.error('PUT tier-config error:', e.message);
    res.status(500).json({ error: 'Could not save tier config' });
  }
});

// GET /api/admin/stats
// Top-line counts for the admin "Stats" tab, queried fresh on each load.
// (Claude story calls are intentionally not included this pass — there is
// no per-call log yet; that needs its own logging hook to be meaningful.)
router.get('/stats', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const q = function (sql) { return db.prepare(sql).get(); };
    const results = await Promise.all([
      q("SELECT COUNT(*) AS c FROM users WHERE status = 'active'"),
      q("SELECT COUNT(*) AS c FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"),
      q("SELECT COUNT(*) AS c FROM users WHERE created_at >= NOW() - INTERVAL '90 days'"),
      q("SELECT COUNT(*) AS c FROM moments WHERE created_at >= NOW() - INTERVAL '30 days'"),
      q("SELECT COUNT(*) AS c FROM moments WHERE created_at >= NOW() - INTERVAL '90 days'"),
      q("SELECT COUNT(*) AS c FROM image_generations"),
      q("SELECT COUNT(*) AS c FROM campaigns WHERE is_active = true"),
      q("SELECT COALESCE(SUM(amount),0) AS c FROM token_ledger WHERE event_type = 'purchase' AND created_at >= NOW() - INTERVAL '30 days'"),
      q("SELECT COALESCE(SUM(amount),0) AS c FROM token_ledger WHERE event_type = 'purchase' AND created_at >= NOW() - INTERVAL '90 days'")
    ]);
    const n = function (r) { return (r && r.c != null) ? Number(r.c) : 0; };
    // Users per tier (all four represented, 0 if none).
    const tierRows = await db.prepare('SELECT tier, COUNT(*) AS c FROM users GROUP BY tier').all();
    const tier_counts = { copper: 0, silver: 0, gold: 0, platinum: 0 };
    tierRows.forEach(function (row) {
      if (row && row.tier && Object.prototype.hasOwnProperty.call(tier_counts, row.tier)) tier_counts[row.tier] = Number(row.c);
    });
    res.json({
      active_users: n(results[0]),
      new_users_30: n(results[1]),
      new_users_90: n(results[2]),
      moments_30: n(results[3]),
      moments_90: n(results[4]),
      fal_calls: n(results[5]),
      active_campaigns: n(results[6]),
      tokens_purchased_30: n(results[7]),
      tokens_purchased_90: n(results[8]),
      tier_counts: tier_counts
    });
  } catch (e) {
    console.error('GET stats error:', e.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

module.exports = router;
