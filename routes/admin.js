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

const TIER_ORDER = ['copper', 'silver', 'gold', 'platinum', 'trial'];

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

// ---- Weekly metric snapshots (true history for current-state metrics) ----
// Current-state metrics (active users, per-tier counts) have no history in the
// live tables, so a weekly job snapshots them into metric_snapshots.
// Timestamp-based metrics (purchases) stay computed live. Idempotent per week.

function mondayOf(dateObj) {
  var d = new Date(dateObj.getTime());
  var day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

async function upsertSnapshot(db, weekStart, metric, tier, value) {
  const existing = await db.prepare(
    'SELECT id FROM metric_snapshots WHERE week_start = ? AND metric = ? AND tier = ?'
  ).get(weekStart, metric, tier);
  const now = new Date().toISOString();
  if (existing) {
    await db.prepare('UPDATE metric_snapshots SET value = ?, created_at = ? WHERE id = ?').run(value, now, existing.id);
  } else {
    await db.prepare(
      'INSERT INTO metric_snapshots (week_start, metric, tier, value, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(weekStart, metric, tier, value, now);
  }
}

async function runSnapshot(db) {
  const weekStart = mondayOf(new Date());
  const active = await db.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").get();
  const tierRows = await db.prepare('SELECT tier, COUNT(*) AS c FROM users GROUP BY tier').all();
  const tierMap = { copper: 0, silver: 0, gold: 0, platinum: 0 };
  tierRows.forEach(function (r) {
    if (r && r.tier && Object.prototype.hasOwnProperty.call(tierMap, r.tier)) tierMap[r.tier] = Number(r.c);
  });
  const rows = [['active_users', '', Number((active && active.c) || 0)]];
  Object.keys(tierMap).forEach(function (t) { rows.push(['tier_count', t, tierMap[t]]); });
  for (var i = 0; i < rows.length; i++) {
    await upsertSnapshot(db, weekStart, rows[i][0], rows[i][1], rows[i][2]);
  }
  return { week_start: weekStart, written: rows.length };
}

// Allow either an admin session OR the cron secret (for the Railway job).
function snapshotAuth(req, res, next) {
  var secret = process.env.SNAPSHOT_SECRET;
  var provided = req.get('X-Snapshot-Secret');
  if (secret && provided && provided === secret) return next();
  requireAuth(req, res, function () { requireAdmin(req, res, next); });
}

// POST /api/admin/snapshot — take this week's snapshot now (manual button or cron).
router.post('/snapshot', snapshotAuth, async function (req, res) {
  try {
    const db = await getDb();
    const result = await runSnapshot(db);
    res.json({ success: true, week_start: result.week_start, written: result.written });
  } catch (e) {
    console.error('snapshot error:', e.message);
    res.status(500).json({ error: 'Snapshot failed' });
  }
});

// GET /api/admin/trends?weeks=12 — weekly series for the Trends charts.
// active_users + per-tier come from snapshots (true history); tokens purchased
// is computed live from the ledger (timestamp-historical).
router.get('/trends', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    var weeks = parseInt(req.query.weeks, 10);
    if (isNaN(weeks) || weeks < 1 || weeks > 104) weeks = 12;
    const since = "NOW() - INTERVAL '" + weeks + " weeks'";
    const activeRows = await db.prepare(
      "SELECT week_start, value FROM metric_snapshots WHERE metric = 'active_users' AND week_start >= (" + since + ")::date ORDER BY week_start"
    ).all();
    const tierRows = await db.prepare(
      "SELECT week_start, tier, value FROM metric_snapshots WHERE metric = 'tier_count' AND week_start >= (" + since + ")::date ORDER BY week_start"
    ).all();
    const purchaseRows = await db.prepare(
      "SELECT date_trunc('week', created_at)::date AS week_start, COALESCE(SUM(amount),0) AS value " +
      "FROM token_ledger WHERE event_type = 'purchase' AND created_at >= " + since + " GROUP BY week_start ORDER BY week_start"
    ).all();
    const tier_counts = { copper: [], silver: [], gold: [], platinum: [] };
    tierRows.forEach(function (r) {
      if (r && r.tier && tier_counts[r.tier]) tier_counts[r.tier].push({ week_start: r.week_start, value: Number(r.value) });
    });
    res.json({
      weeks: weeks,
      active_users: activeRows.map(function (r) { return { week_start: r.week_start, value: Number(r.value) }; }),
      tier_counts: tier_counts,
      tokens_purchased: purchaseRows.map(function (r) { return { week_start: r.week_start, value: Number(r.value) }; })
    });
  } catch (e) {
    console.error('trends error:', e.message);
    res.status(500).json({ error: 'Could not load trends' });
  }
});

// Print pricing: markup % applied to the print cost at order time.
router.get('/print-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('print_markup_pct');
    const p = r && r.value != null ? parseFloat(r.value) : NaN;
    res.json({ printMarkupPct: Number.isFinite(p) ? p : 10 });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/print-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    var pct = parseFloat(req.body && req.body.printMarkupPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000) return res.status(400).json({ error: 'printMarkupPct must be a number >= 0' });
    pct = Math.round(pct * 100) / 100;
    const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get('print_markup_pct');
    if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(pct), 'print_markup_pct');
    else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run('print_markup_pct', String(pct));
    res.json({ ok: true, printMarkupPct: pct });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
