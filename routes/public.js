// ============================================================
// PUBLIC (UNAUTHENTICATED) ROUTES
// Small, read-only endpoints safe to expose to logged-out visitors.
// ============================================================
const express = require('express');
const router = express.Router();
const { TIERS, getTier } = require('../middleware/tiers');

// GET /api/public/pricing -- per-tier monthly price (whole dollars) for the
// landing page. Reads the live tier config (admin overrides + code defaults).
router.get('/pricing', function (req, res) {
  try {
    const pricing = {};
    Object.keys(TIERS).forEach(function (name) {
      const t = getTier(name);
      pricing[name] = (t && typeof t.price === 'number') ? t.price : 0;
    });
    res.json({ pricing: pricing });
  } catch (e) {
    console.error('GET public pricing error:', e.message);
    res.status(500).json({ error: 'pricing unavailable' });
  }
});

module.exports = router;
