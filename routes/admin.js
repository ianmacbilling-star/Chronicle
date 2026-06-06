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

module.exports = router;
