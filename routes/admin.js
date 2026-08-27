// ============================================================
// ADMIN ROUTES  (mounted at /api/admin)
// Admin-only. Source of truth for who is an admin = ADMIN_EMAILS env var,
// enforced by the requireAdmin middleware. Home of the admin Settings
// "Tiers" tab backend and (later) the rest of the Admin Dashboard.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireImpersonatorOrAdmin, endImpersonation, impersonationExpired, IMPERSONATION_MAX_MS } = require('../middleware/auth');
const tiers = require('../middleware/tiers');
const { getDb } = require('../database/db');
const { friendlyError } = require('../middleware/friendlyErrors');

const TIER_ORDER = ['copper', 'silver', 'gold', 'platinum', 'trial'];
// v3.0.792 -- TD-592. THE TIER LIST WAS WRITTEN OUT THREE MORE TIMES, AND ALL THREE FORGOT TRIAL.
// TIER_ORDER above has always included it -- the tier editor has been showing it since it was
// added -- but /stats, runSnapshot and /trends each carried their own literal
// { copper, silver, gold, platinum }, so free-trial users were counted nowhere and snapshotted
// never. Derived from the one list now, so a sixth tier is one edit rather than four.
function emptyTierMap(init) {
  var out = {};
  TIER_ORDER.forEach(function (t) { out[t] = (typeof init === 'function') ? init() : 0; });
  return out;
}

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
      // v3.0.792 -- TD-592. Ian wants the recent window at the top of the tab. 30 and 90 days are
      // both long enough that a quiet week disappears into them.
      q("SELECT COUNT(*) AS c FROM users WHERE created_at >= NOW() - INTERVAL '5 days'"),
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
    const tier_counts = emptyTierMap();
    tierRows.forEach(function (row) {
      if (row && row.tier && Object.prototype.hasOwnProperty.call(tier_counts, row.tier)) tier_counts[row.tier] = Number(row.c);
    });
    res.json({
      // v3.0.792 -- every index below shifted by one when the 5-day count was inserted at [1].
      // Positional reads into a Promise.all are exactly the kind of thing that silently reports
      // the wrong number, so the whole block is renumbered together rather than patched in place.
      active_users: n(results[0]),
      new_users_5: n(results[1]),
      new_users_30: n(results[2]),
      new_users_90: n(results[3]),
      moments_30: n(results[4]),
      moments_90: n(results[5]),
      fal_calls: n(results[6]),
      active_campaigns: n(results[7]),
      tokens_purchased_30: n(results[8]),
      tokens_purchased_90: n(results[9]),
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
  // v3.0.792 -- TD-592. THIS is the one that mattered for Trends: a tier absent here is a tier
  // with no history, so the chart line would exist and be empty however the client was written.
  const tierMap = emptyTierMap();
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
    const tier_counts = emptyTierMap(function () { return []; });
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

// Two independent toggles for emailing the in-app AI help transcript to
// support: help_ai_done_email (AI marks the chat complete) and
// help_logout_email (on logout). Stored in app_settings as '1'/'0' (default 0).
router.get('/help-email-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const a = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('help_ai_done_email');
    const l = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('help_logout_email');
    res.json({ aiDone: !!(a && a.value === '1'), logout: !!(l && l.value === '1') });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/help-email-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const pairs = [
      ['help_ai_done_email', (req.body && req.body.aiDone) ? '1' : '0'],
      ['help_logout_email', (req.body && req.body.logout) ? '1' : '0']
    ];
    for (var i = 0; i < pairs.length; i++) {
      const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get(pairs[i][0]);
      if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(pairs[i][1], pairs[i][0]);
      else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(pairs[i][0], pairs[i][1]);
    }
    res.json({ ok: true, aiDone: pairs[0][1] === '1', logout: pairs[1][1] === '1' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Generation charging + transcript cache TTL. Charging scales with size:
// Story = tokens per N transcript words, Narrative = tokens per N panels, each
// with a floor (minimum-that-scales, i.e. max(floor, size/N) rounded DOWN).
// All default 0 (= no charge). transcript_cache_ttl is '5m' or '1h' (default 5m).
function _giToInt(v){ var n=parseInt(v,10); return (Number.isFinite(n)&&n>=0)?n:0; }
router.get('/generation-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    async function g(k){ const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(k); return r ? r.value : null; }
    res.json({
      storyWordsPerToken: _giToInt(await g('gen_story_words_per_token')),
      storyFloor: _giToInt(await g('gen_story_floor')),
      narrativePanelsPerToken: _giToInt(await g('gen_narrative_panels_per_token')),
      narrativeFloor: _giToInt(await g('gen_narrative_floor')),
      transcriptCacheTtl: ((await g('transcript_cache_ttl')) === '1h') ? '1h' : '5m',
      // v3.0.356 -- what ONE layout-loop token is worth to us, in cents. The layout charge divides
      // the real Anthropic cost of each AI pass by this, so raising it makes Optimize cheaper for
      // the user and lowering it makes it dearer. Read live at charge time: no deploy to change it.
      // Floor of 1 -- a zero would divide by zero at the charge site.
      layoutLoopCostCents: (function (v) { var n = parseInt(v, 10); return (Number.isFinite(n) && n >= 1) ? n : 8; })(await g('layout_loop_cost_cents'))
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.put('/generation-settings', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const b = req.body || {};
    const ttl = (b.transcriptCacheTtl === '1h') ? '1h' : '5m';
    const pairs = [
      ['gen_story_words_per_token', String(_giToInt(b.storyWordsPerToken))],
      ['gen_story_floor', String(_giToInt(b.storyFloor))],
      ['gen_narrative_panels_per_token', String(_giToInt(b.narrativePanelsPerToken))],
      ['gen_narrative_floor', String(_giToInt(b.narrativeFloor))],
      ['transcript_cache_ttl', ttl],
      // v3.0.356 -- floor of 1 cent, default 8. Never allow 0: the charge site divides by it.
      ['layout_loop_cost_cents', String((function (v) { var n = parseInt(v, 10); return (Number.isFinite(n) && n >= 1) ? n : 8; })(b.layoutLoopCostCents))]
    ];
    for (var i = 0; i < pairs.length; i++) {
      const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get(pairs[i][0]);
      if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(pairs[i][1], pairs[i][0]);
      else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(pairs[i][0], pairs[i][1]);
    }
    res.json({ ok: true });
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

// v3.0.788 -- TD-589. EVERY ORDER, EVERY USER, NEWEST FIRST.
//
// The operational view: what was bought, by whom, for how much, and where it is. Roughly the
// field set of the failed-order support email (TD-582), because that email was written by asking
// what is needed to research and refund an order -- and the same answer applies to looking at one.
//
// ADMIN ONLY, AT THE ROUTE. requireAuth + requireAdmin, exactly like /library and /stories.
// This is the one screen that puts every customer's email, postal address and payment id in one
// place, so the gate has to be the endpoint and not the button: a hidden control protects nobody.
//
// Keyset pagination on id, the same shape /library uses, so a growing order table never turns
// this into a full scan and the client can lazy-load by scrolling.
//
// NO PDF LINKS AND NO SHIPPING ADDRESS. Both are on the row and neither is needed to answer
// "what happened to this order" -- the address is the most sensitive field here and the print
// files are a customer's book. The support email carries them because it fires for ONE order that
// needs acting on; a browsable list of everything is a different exposure, and the narrower
// answer is the right default. Add them later if an actual task needs them.
router.get('/orders', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    let limit = parseInt(req.query.limit, 10) || 25;
    if (limit < 1) limit = 1;
    if (limit > 50) limit = 50;
    const beforeId = parseInt(req.query.beforeId, 10) || 0;
    // v3.0.790 -- TD-590. FILTERED IN SQL, NOT IN THE BROWSER.
    //
    // The list is keyset-paginated 25 at a time, so a client-side filter would only ever search
    // the rows already fetched -- it would look like it worked and quietly miss everything past
    // the first page. That is the worst kind of wrong for a search box.
    //
    // EVERY VALUE IS BOUND. No user input is concatenated into the statement, and the LIKE terms
    // have their wildcards escaped as well: an unescaped % turns "find this customer" into "match
    // everyone", which is a silent wrong answer rather than an error.
    const where = [];
    const params = [];
    function like(v) {
      // \ % and _ are LIKE metacharacters. Escape them so a literal search stays literal.
      return '%' + String(v).replace(/[\\%_]/g, function (m) { return '\\' + m; }) + '%';
    }
    const qOrder = String(req.query.q || '').trim();
    if (qOrder) {
      // "Both order numbers": ours (po-N) and the printer's job id. A reader holding either one
      // should not have to know which field it lives in.
      where.push("(o.external_id ILIKE ? ESCAPE '\\' OR o.provider_order_id ILIKE ? ESCAPE '\\')");
      params.push(like(qOrder), like(qOrder));
    }
    const qCust = String(req.query.customer || '').trim();
    if (qCust) {
      where.push("(u.email ILIKE ? ESCAPE '\\' OR u.name ILIKE ? ESCAPE '\\' OR o.ship_name ILIKE ? ESCAPE '\\')");
      params.push(like(qCust), like(qCust), like(qCust));
    }
    const qTrack = String(req.query.tracking || '').trim();
    if (qTrack) {
      where.push("o.tracking_number ILIKE ? ESCAPE '\\'");
      params.push(like(qTrack));
    }
    // Dates are inclusive of the whole TO day: a reader typing the same date in both boxes means
    // "that day", not "the instant midnight began".
    const qFrom = String(req.query.from || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(qFrom)) { where.push('o.created_at >= ?'); params.push(qFrom + ' 00:00:00'); }
    const qTo = String(req.query.to || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(qTo)) { where.push('o.created_at <= ?'); params.push(qTo + ' 23:59:59'); }
    const qMin = parseFloat(req.query.minPrice);
    if (Number.isFinite(qMin)) { where.push('o.customer_charge >= ?'); params.push(qMin); }
    const qMax = parseFloat(req.query.maxPrice);
    if (Number.isFinite(qMax)) { where.push('o.customer_charge <= ?'); params.push(qMax); }
    let sql =
      'SELECT o.id, o.external_id, o.provider_order_id, o.created_at, o.updated_at, ' +
      '       o.order_name, o.book_title, o.campaign_name, ' +
      '       o.customer_charge, o.currency, o.provider_cost, o.provider_tax, ' +
      '       o.payment_status, o.status, o.error, ' +
      '       o.stripe_payment_intent_id, o.stripe_session_id, o.card_brand, o.card_last4, ' +
      '       o.binding, o.color_tier, o.cover_finish, o.paper, o.page_count, o.quantity, ' +
      '       o.tracking_url, o.tracking_number, o.carrier, o.provider_checked_at, ' +
      '       o.user_id, u.email AS user_email, u.name AS user_name ' +
      '  FROM print_orders o LEFT JOIN users u ON u.id = o.user_id';
    // The cursor is just another condition, so paging and filtering compose instead of fighting.
    if (beforeId > 0) { where.push('o.id < ?'); params.push(beforeId); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY o.id DESC LIMIT ?';
    params.push(limit + 1);
    const stmt = db.prepare(sql);
    const rows = await stmt.all.apply(stmt, params);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    // v3.0.802 -- TD-612. THIS SCREEN ASKED THE PRINTER NOTHING.
    //
    // v3.0.788 built the admin Orders tab as a pure database read, and v3.0.787 had put the vendor
    // refresh on the CUSTOMER's list only. So an order's status became current when its OWNER
    // happened to open My Orders, and not otherwise: a customer who orders a book and never looks
    // again leaves this tab showing `in_production` while the book is on their shelf. This is the
    // screen used to answer "where is this person's book", and it was the one surface that never
    // asked -- TD-588's shape, one level up.
    //
    // The SAME helper as the customer list, exported rather than reimplemented: two copies of this
    // logic is exactly how two surfaces came to disagree about one book in TD-610, one build ago.
    // Bounded by the hour rule, so paging through the tab does not re-ask anything.
    try {
      const _print = require('./print');
      if (typeof _print.sweepLiveOrders === 'function') await _print.sweepLiveOrders(db, items, 'admin orders tab');
    } catch (_e) { /* never let a vendor call stop the admin list rendering */ }
    const nextCursor = items.length ? items[items.length - 1].id : null;
    // The two deep links, built HERE so the client never assembles a vendor URL from parts.
    // Stripe's is certain and already used by the support email. Lulu's is env-overridable
    // because it has not been confirmed against their portal -- a wrong link is one env var to
    // correct rather than a deploy, and guessing vendor strings is what cost us the cream SKU
    // and the print-job field names on 2026-08-24.
    const luluTpl = process.env.LULU_DASHBOARD_URL || 'https://developers.lulu.com/print-jobs/detail/{id}';
    res.json({
      items: items.map(function (r) {
        return Object.assign({}, r, {
          stripeUrl: r.stripe_payment_intent_id
            ? ('https://dashboard.stripe.com/payments/' + encodeURIComponent(r.stripe_payment_intent_id))
            : null,
          luluUrl: r.provider_order_id
            ? luluTpl.replace('{id}', encodeURIComponent(r.provider_order_id))
            : null,
        });
      }),
      hasMore: hasMore, nextCursor: nextCursor,
    });
  } catch (e) {
    console.error('admin orders list error:', e.message);
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
    const pwRow = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'lifecycle_purge_warn_days'").get();
    const idle = idleRow ? parseInt(idleRow.value, 10) : 90;
    const purge = purgeRow ? parseInt(purgeRow.value, 10) : 180;
    const grace = graceRow ? parseInt(graceRow.value, 10) : 14;
    res.json({ idle_days: Number.isFinite(idle) ? idle : 90, purge_days: Number.isFinite(purge) ? purge : 180, grace_days: Number.isFinite(grace) ? grace : 14, purge_warn_days: (pwRow && pwRow.value) ? pwRow.value : '30,7', floor_days: LIFECYCLE_FLOOR_DAYS });
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
    let pwList = ((req.body && req.body.purge_warn_days) || '').split(',').map(function (x) { return parseInt((x || '').trim(), 10); }).filter(function (n) { return Number.isFinite(n) && n >= 1; }).sort(function (a, b) { return b - a; });
    if (!pwList.length) pwList = [30, 7];
    const pwStr = pwList.join(',');
    const db = await getDb();
    const pairs = [['lifecycle_idle_days', String(idle)], ['lifecycle_purge_days', String(purge)], ['lifecycle_warn_grace_days', String(grace)], ['lifecycle_purge_warn_days', pwStr]];
    for (let i = 0; i < pairs.length; i++) {
      const ex = await db.prepare('SELECT 1 FROM app_settings WHERE setting_key = ?').get(pairs[i][0]);
      if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(pairs[i][1], pairs[i][0]);
      else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(pairs[i][0], pairs[i][1]);
    }
    res.json({ ok: true, idle_days: idle, purge_days: purge, grace_days: grace, purge_warn_days: pwStr, floor_days: LIFECYCLE_FLOOR_DAYS });
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
  } catch (e) { console.error('run-sweep error:', e.message); res.status(500).json({ error: friendlyError(e, 'The sweep failed. Please try again.') }); }
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
  } catch (e) { console.error('set-user-dates error:', e.message); res.status(500).json({ error: friendlyError(e, 'Could not update the user dates. Please try again.') }); }
});

// ============================================================
// PROMO CODES (Stage 1): admin CRUD for the app-side promo catalog.
// Codes are normalized uppercase. token_grant is the only action executed
// app-side (wired in Stage 2). percent_off/amount_off are cataloged here for
// attribution; the actual checkout discount is configured in Stripe.
// ============================================================
router.get('/promo-codes', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare('SELECT id, code, label, action_type, action_value, per_user_limit, expires_at, active, redeemed_count, created_at FROM promo_codes ORDER BY created_at DESC').all();
    res.json({ codes: Array.isArray(rows) ? rows : [] });
  } catch (e) { console.error('promo-codes list error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/promo-codes', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const body = req.body || {};
    let code = String(body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code is required.' });
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return res.status(400).json({ error: 'Code must be 2-40 characters: letters, numbers, - or _.' });
    const label = body.label ? String(body.label).trim().slice(0, 120) : null;
    const allowed = ['token_grant', 'percent_off', 'amount_off'];
    const actionType = allowed.indexOf(body.action_type) !== -1 ? body.action_type : 'token_grant';
    let actionValue = parseInt(body.action_value, 10);
    if (!Number.isFinite(actionValue) || actionValue < 0) actionValue = 0;
    let expiresAt = null;
    if (body.expires_at) { const d = new Date(body.expires_at); if (!isNaN(d.getTime())) expiresAt = d.toISOString(); }
    let perUserLimit = parseInt(body.per_user_limit, 10);
    if (!Number.isFinite(perUserLimit) || perUserLimit < 1) perUserLimit = 1;
    const dup = await db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(code);
    if (dup) return res.status(400).json({ error: 'That code already exists.' });
    await db.prepare('INSERT INTO promo_codes (code, label, action_type, action_value, per_user_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(code, label, actionType, actionValue, perUserLimit, expiresAt);
    res.json({ ok: true });
  } catch (e) { console.error('promo-codes create error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/promo-codes/:id/update', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
    const row = await db.prepare('SELECT id FROM promo_codes WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const body = req.body || {};
    const label = body.label ? String(body.label).trim().slice(0, 120) : null;
    const allowed = ['token_grant', 'percent_off', 'amount_off'];
    const actionType = allowed.indexOf(body.action_type) !== -1 ? body.action_type : 'token_grant';
    let actionValue = parseInt(body.action_value, 10);
    if (!Number.isFinite(actionValue) || actionValue < 0) actionValue = 0;
    let perUserLimit = parseInt(body.per_user_limit, 10);
    if (!Number.isFinite(perUserLimit) || perUserLimit < 1) perUserLimit = 1;
    let expiresAt = null;
    if (body.expires_at) { const d = new Date(body.expires_at); if (!isNaN(d.getTime())) expiresAt = d.toISOString(); }
    await db.prepare('UPDATE promo_codes SET label = ?, action_type = ?, action_value = ?, per_user_limit = ?, expires_at = ? WHERE id = ?').run(label, actionType, actionValue, perUserLimit, expiresAt, id);
    res.json({ ok: true });
  } catch (e) { console.error('promo-codes update error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

router.post('/promo-codes/:id/toggle', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id.' });
    const row = await db.prepare('SELECT id, active FROM promo_codes WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    const next = !row.active;
    await db.prepare('UPDATE promo_codes SET active = ? WHERE id = ?').run(next, id);
    res.json({ ok: true, active: next });
  } catch (e) { console.error('promo-codes toggle error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// =================================================================================================
// IMPERSONATION -- TD-179 STAGE 2, v3.0.589. Spec: ADMIN_IMPERSONATION_SPEC.md section 3.
//
// Ian, 2026-08-02: "a screen where I could put in their email address and it would get me in as
// them." That is what this is -- but a SESSION SWAP from an already-authenticated admin session,
// not the master password he first floated. The spec rejected that one: unrevocable for a single
// person, unattributable, works from anywhere with no admin session behind it, and if it leaks
// every account is exposed with no way to tell what was touched. This gives identical access, is
// revoked by removing an email from ADMIN_EMAILS, and is attributable by construction.
//
// WHY IT IS FIVE LINES: every authenticated route in the app resolves identity from exactly one
// place, req.session.userId. So impersonation is swapping one field and remembering the original.
// All the engineering goes into the guard rails, not the mechanism.
// =================================================================================================

// START. Admin-only, by definition -- you must still be yourself to become someone else.
router.post('/impersonate', requireAuth, requireAdmin, async function (req, res) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (!email) return res.status(400).json({ error: 'An email address is required.' });
    const db = await getDb();
    const me = await db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.session.userId);
    const target = await db.prepare('SELECT id, email FROM users WHERE LOWER(email) = ?').get(email);
    if (!target) return res.status(404).json({ error: 'No account with that email address.' });
    if (String(target.id) === String(req.session.userId)) {
      return res.status(400).json({ error: 'That is your own account.' });
    }
    // NO ADMIN-ON-ADMIN (spec 3.1). It keeps the audit trail meaningful -- an admin acting through
    // another admin's account produces a row that names the wrong person for everything that
    // follows -- and it removes any question of chaining.
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
    if (adminEmails.indexOf(String(target.email).toLowerCase()) !== -1) {
      return res.status(400).json({ error: 'That account is an admin. Support access is for customer accounts.' });
    }
    // THE AUDIT ROW IS WRITTEN BEFORE THE SWAP, and a failure here REFUSES the impersonation.
    // Access without a record is the thing the privacy clause promises does not happen, so if the
    // record cannot be made the access must not happen either.
    let rowId = null;
    try {
      const ins = await db.prepare(
        'INSERT INTO admin_impersonations (admin_user_id, admin_email, target_user_id, target_email, reason, started_at) ' +
        'VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
      ).run(me.id, me.email, target.id, target.email, reason || null);
      rowId = ins && ins.lastInsertRowid;
    } catch (e) {
      console.error('[impersonate] audit write failed, refusing: ' + ((e && e.message) || e));
      return res.status(500).json({ error: 'Could not record the support session, so it was not started.' });
    }
    req.session.impersonatorId = req.session.userId;
    req.session.impersonatorEmail = me.email;
    req.session.impersonateTargetEmail = target.email;
    req.session.impersonateStartedAt = Date.now();
    req.session.impersonationRowId = rowId;
    req.session.userId = target.id;
    console.warn('[impersonate] ' + me.email + ' -> ' + target.email + (reason ? (' (' + reason + ')') : ''));
    return res.json({ ok: true, viewingAs: target.email, expiresInMs: IMPERSONATION_MAX_MS });
  } catch (e) {
    return res.status(500).json({ error: friendlyError(e, 'Could not start the support session.') });
  }
});

// STOP. NOT gated on requireAdmin -- see spec 4.1. The moment you impersonate you are not an admin,
// so requiring admin here would lock you inside the customer's account with no way out but clearing
// cookies. Gated on the presence of the impersonator instead.
router.post('/impersonate/stop', requireAuth, async function (req, res) {
  if (!req.session || !req.session.impersonatorId) {
    return res.status(400).json({ error: 'You are not in a support session.' });
  }
  const back = req.session.impersonatorEmail;
  endImpersonation(req, 'manual');
  return res.json({ ok: true, backTo: back });
});

// STATUS. Drives the banner, and it is deliberately the SAME session fields the deny list reads,
// so the banner cannot say one thing while the guard enforces another (spec 6).
router.get('/impersonate/status', requireAuth, function (req, res) {
  if (!req.session || !req.session.impersonatorId) return res.json({ active: false });
  const started = Number(req.session.impersonateStartedAt || 0);
  return res.json({
    active: true,
    viewingAs: req.session.impersonateTargetEmail || null,
    adminEmail: req.session.impersonatorEmail || null,
    startedAt: started || null,
    expiresInMs: Math.max(0, IMPERSONATION_MAX_MS - (Date.now() - started)),
    // Not reported live: the total is computed from token_ledger when the session CLOSES.
    // A live figure would need a counter at every spend site -- see endImpersonation.
    tokensSpent: null
  });
});

// GRANT TOKENS TO THE ACCOUNT YOU ARE VIEWING -- TD-179 stage 5, v3.0.590.
//
// Ian, 2026-08-09: "a user has trouble doing something that costs tokens... I want to just be able
// to give them back the tokens and even more for their trouble. So if you can continue to give me
// access to the Add Tokens admin tool."
//
// IT CANNOT BE THE EXISTING /api/tokens/admin/credit ROUTE. That resolves admin from
// req.session.userId, which while impersonating IS THE CUSTOMER -- so it would 403, and "fixing"
// that by re-enabling admin inside the session would break the rule that stops impersonation
// chaining. This asks the other question instead (requireImpersonatorOrAdmin): is there a real
// admin behind this session.
//
// THE GRANT IS ATTRIBUTED TO THE ADMIN, NOT THE CUSTOMER. triggered_by_user_id carries the real
// admin id, so the ledger does not read as the user crediting themselves -- which is the whole
// difference between a support tool and an unexplained balance change.
router.post('/impersonate/grant-tokens', requireAuth, requireImpersonatorOrAdmin, async function (req, res) {
  try {
    if (!req.session.impersonatorId) {
      return res.status(400).json({ error: 'You are not in a support session.' });
    }
    const amt = parseInt((req.body && req.body.amount), 10);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Enter a positive number of tokens.' });
    if (amt > 100000) return res.status(400).json({ error: 'That is more tokens than any support case needs.' });
    const bucket = (req.body && req.body.bucket === 'utlt') ? 'utlt' : 'cot';
    const tokens = require('./tokens');
    const bal = await tokens.creditTokens(req.session.userId, amt, {
      bucket: bucket,
      event_type: 'admin_credit',
      source: 'support:' + (req.session.impersonatorEmail || 'admin'),
      triggered_by_user_id: req.session.impersonatorId
    });
    console.warn('[impersonate] ' + (req.session.impersonatorEmail || 'admin') + ' granted ' + amt +
      ' ' + bucket + ' tokens to ' + (req.session.impersonateTargetEmail || ('user ' + req.session.userId)));
    return res.json({ ok: true, granted: amt, bucket: bucket, balance: bal || null });
  } catch (e) {
    return res.status(500).json({ error: friendlyError(e, 'Could not add the tokens.') });
  }
});

// RECENT SESSIONS. Admin-only; the audit trail is the point of the feature, so it must be readable
// from inside the product rather than only from a psql prompt.
router.get('/impersonate/log', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const rows = await db.prepare(
      'SELECT id, admin_email, target_email, reason, tokens_spent, started_at, ended_at, end_reason ' +
      'FROM admin_impersonations ORDER BY started_at DESC LIMIT 50'
    ).all();
    return res.json({ sessions: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: friendlyError(e, 'Could not read the support log.') });
  }
});


module.exports = router;
