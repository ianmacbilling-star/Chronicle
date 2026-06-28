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

// Signup bonus: carry-over (CO) tokens granted to the Story Master when a new
// member signs up through their campaign invite. Stored in app_settings as
// signup_bonus_cot (default 0 = off).
router.get('/signup-bonus', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('signup_bonus_cot');
    const n = r && r.value != null ? parseInt(r.value, 10) : NaN;
    res.json({ signupBonusCot: Number.isFinite(n) && n >= 0 ? n : 0 });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/signup-bonus', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    var n = parseInt(req.body && req.body.signupBonusCot, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'signupBonusCot must be a whole number >= 0' });
    const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get('signup_bonus_cot');
    if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(n), 'signup_bonus_cot');
    else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run('signup_bonus_cot', String(n));
    res.json({ ok: true, signupBonusCot: n });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /api/admin/library -- moderation view of ALL public Library images (no
// time window), newest first, keyset-paginated. Returns the archive id so an
// admin can pull an item down.
router.get('/library', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 48;
    if (limit < 1) limit = 1;
    if (limit > 60) limit = 60;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    let sql = 'SELECT id, image_url, title, created_at FROM campaign_archives WHERE public = TRUE';
    const params = [];
    if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) { return { id: r.id, image_url: r.image_url, caption: r.title || '', created_at: r.created_at }; });
    const nextCursor = slice.length ? slice[slice.length - 1].id : null;
    res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
  } catch (e) {
    console.error('admin library list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/library/:archiveId/unpublish -- pull an image from the public
// Library (public=false). The owner's archived copy is untouched.
router.post('/library/:archiveId/unpublish', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    await db.prepare('UPDATE campaign_archives SET public = FALSE WHERE id = ?').run(req.params.archiveId);
    res.json({ ok: true });
  } catch (e) {
    console.error('admin unpublish error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/stories -- moderation view of ALL published Stories (no time
// window), newest first, keyset-paginated. Returns the story id so an admin can
// pull one down.
router.get('/stories', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 48;
    if (limit < 1) limit = 1;
    if (limit > 60) limit = 60;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    let sql = 'SELECT id, author_name, title, cover_url, pdf_url, created_at FROM public_stories WHERE public = TRUE';
    const params = [];
    if (beforeId > 0) { sql += ' AND id < ?'; params.push(beforeId); }
    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit);
    const items = slice.map(function (r) { return { id: r.id, author: r.author_name || '', title: r.title || 'Untitled', cover_url: r.cover_url || '', pdf_url: r.pdf_url, created_at: r.created_at }; });
    const nextCursor = slice.length ? slice[slice.length - 1].id : null;
    res.json({ items: items, hasMore: hasMore, nextCursor: nextCursor });
  } catch (e) {
    console.error('admin stories list error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/stories/:id/unpublish -- pull a Story from the public Library
// (public=false). The owner's published PDF + row remain; it just stops listing.
router.post('/stories/:id/unpublish', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    await db.prepare('UPDATE public_stories SET public = FALSE WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('admin story unpublish error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Global Max Pages Per Print limit (applies to ALL layouts). Stored in
// app_settings as max_pages_per_print (default 250).
router.get('/print-page-limit', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const r = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('max_pages_per_print');
    const n = r && r.value != null ? parseInt(r.value, 10) : NaN;
    res.json({ maxPagesPerPrint: Number.isFinite(n) && n > 0 ? n : 250 });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/print-page-limit', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    var n = parseInt(req.body && req.body.maxPagesPerPrint, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10000) return res.status(400).json({ error: 'maxPagesPerPrint must be a whole number between 1 and 10000' });
    const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get('max_pages_per_print');
    if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(n), 'max_pages_per_print');
    else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run('max_pages_per_print', String(n));
    res.json({ ok: true, maxPagesPerPrint: n });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.runSnapshot = runSnapshot;
// ===========================================================================
// Account-lifecycle admin (ACCOUNT_LIFECYCLE_SPEC Phase 2): tunable thresholds,
// on-demand sweep, and a backdate test tool. All admin-gated.
// ===========================================================================
const LIFECYCLE_FLOOR_DAYS = 1; // safety floor; revisit before enabling purge

router.get('/lifecycle-config', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const idleRow = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'lifecycle_idle_days'").get();
    const purgeRow = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'lifecycle_purge_days'").get();
    const graceRow = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'lifecycle_warn_grace_days'").get();
    const idle = idleRow ? parseInt(idleRow.value, 10) : 90;
    const purge = purgeRow ? parseInt(purgeRow.value, 10) : 180;
    const grace = graceRow ? parseInt(graceRow.value, 10) : 14;
    res.json({ idle_days: Number.isFinite(idle) ? idle : 90, purge_days: Number.isFinite(purge) ? purge : 180, grace_days: Number.isFinite(grace) ? grace : 14, floor_days: LIFECYCLE_FLOOR_DAYS });
  } catch (e) { console.error('GET lifecycle-config error:', e.message); res.status(500).json({ error: 'Could not load lifecycle config' }); }
});

router.put('/lifecycle-config', requireAuth, requireAdmin, async function (req, res) {
  try {
    let idle = parseInt(req.body && req.body.idle_days, 10);
    let purge = parseInt(req.body && req.body.purge_days, 10);
    let grace = parseInt(req.body && req.body.grace_days, 10);
    if (!Number.isFinite(idle) || idle < LIFECYCLE_FLOOR_DAYS) idle = LIFECYCLE_FLOOR_DAYS;
    if (!Number.isFinite(purge) || purge < LIFECYCLE_FLOOR_DAYS) purge = LIFECYCLE_FLOOR_DAYS;
    if (!Number.isFinite(grace) || grace < LIFECYCLE_FLOOR_DAYS) grace = LIFECYCLE_FLOOR_DAYS;
    const db = await getDb();
    const pairs = [['lifecycle_idle_days', String(idle)], ['lifecycle_purge_days', String(purge)], ['lifecycle_warn_grace_days', String(grace)]];
    for (let i = 0; i < pairs.length; i++) {
      const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(pairs[i][0]);
      if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(pairs[i][1], pairs[i][0]);
      else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(pairs[i][0], pairs[i][1]);
    }
    res.json({ ok: true, idle_days: idle, purge_days: purge, grace_days: grace, floor_days: LIFECYCLE_FLOOR_DAYS });
  } catch (e) { console.error('PUT lifecycle-config error:', e.message); res.status(500).json({ error: 'Could not save lifecycle config' }); }
});

// Run the sweep on demand (test/ops). Lazy require of the scheduler avoids a
// load-order cycle (scheduler already requires this module for runSnapshot).
router.post('/lifecycle/run-sweep', requireAuth, requireAdmin, async function (req, res) {
  try {
    const { runLifecycleSweep } = require('../scheduler');
    const db = await getDb();
    const summary = await runLifecycleSweep(db, { dryRun: !!(req.body && req.body.dryRun) });
    res.json({ ok: true, summary: summary });
  } catch (e) { console.error('run-sweep error:', e.message); res.status(500).json({ error: 'Sweep failed: ' + e.message }); }
});

// TEST TOOL: backdate a target user's lifecycle timestamps so the sweep can
// move them through stages on demand. Column names come from a fixed allow-list
// (never from the request), values are parameterized.
router.post('/lifecycle/set-user-dates', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const email = ((req.body && req.body.email) || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    const u = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!u) return res.status(404).json({ error: 'No user with that email' });
    const allow = ['tier', 'status', 'last_active_at', 'lone_since', 'last_purchase_at', 'idle_warned_at', 'suspended_at'];
    const sets = []; const vals = [];
    for (let i = 0; i < allow.length; i++) {
      const k = allow[i];
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        sets.push(k + ' = ?');
        vals.push(req.body[k] === '' ? null : req.body[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'no fields to set' });
    vals.push(u.id);
    await db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(vals);
    const after = await db.prepare('SELECT id, email, tier, status, last_active_at, lone_since, last_purchase_at, idle_warned_at, suspended_at FROM users WHERE id = ?').get(u.id);
    res.json({ ok: true, user: after });
  } catch (e) { console.error('set-user-dates error:', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
