// ============================================================
// TOKEN SYSTEM — core logic + endpoints (Phase 1)
// ============================================================
// Balance is derived by summing token_ledger (single source of truth).
// Two buckets: 'utlt' (monthly grant, expires) and 'cot' (carry-over,
// never expires). Spend order: utlt first, then cot.
//
// Per-model cost lives in app_settings as token_cost:<model>, default 1.
// Stripe is NOT wired here yet — creditTokens is the seam Stripe will
// call later. For now an admin endpoint credits tokens for testing.

const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');

// ------------------------------------------------------------
// Cost lookup — per model, defaults to 1 if unset.
// ------------------------------------------------------------
async function getTokenCost(model) {
  try {
    const db = await getDb();
    const key = 'token_cost:' + (model || 'nano2');
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get(key);
    const cost = row && row.value != null ? parseInt(row.value, 10) : 1;
    return Number.isFinite(cost) && cost >= 0 ? cost : 1;
  } catch (e) {
    return 1;
  }
}

// ------------------------------------------------------------
// Balance — sum the ledger, per bucket and total.
// ------------------------------------------------------------
async function getBalance(userId) {
  const db = await getDb();
  const rows = await db.prepare(
    "SELECT bucket, COALESCE(SUM(amount),0) AS bal FROM token_ledger WHERE user_id = ? GROUP BY bucket"
  ).all(userId);
  let utlt = 0, cot = 0;
  for (const r of rows) {
    if (r.bucket === 'utlt') utlt = parseInt(r.bal, 10) || 0;
    else if (r.bucket === 'cot') cot = parseInt(r.bal, 10) || 0;
  }
  return { utlt, cot, total: utlt + cot };
}

async function canAfford(userId, cost) {
  const { total } = await getBalance(userId);
  return total >= cost;
}

// ------------------------------------------------------------
// Credit tokens. bucket defaults to 'cot' (purchases, bonuses, carry-
// over all land in cot). Monthly grants pass bucket='utlt'.
// Writes a single positive ledger row. This is the seam Stripe calls.
// ------------------------------------------------------------
async function creditTokens(userId, amount, opts = {}) {
  if (!amount || amount <= 0) throw new Error('Credit amount must be positive');
  const db = await getDb();
  const bucket = opts.bucket || 'cot';
  const eventType = opts.event_type || 'manual_credit';
  await db.prepare(
    `INSERT INTO token_ledger
       (user_id, amount, bucket, event_type, source, triggered_by_user_id, related_campaign_id, related_purchase_id, stripe_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, amount, bucket, eventType,
    opts.source || null,
    opts.triggered_by_user_id || null,
    opts.related_campaign_id || null,
    opts.related_purchase_id || null,
    opts.stripe_event_id || null
  );
  return getBalance(userId);
}

// ------------------------------------------------------------
// Spend tokens. Debits utlt first, then cot. Writes one negative
// ledger row per bucket touched. Throws if insufficient balance —
// callers must check canAfford first for batch all-or-nothing.
// ------------------------------------------------------------
async function spendTokens(userId, amount, opts = {}) {
  if (!amount || amount <= 0) throw new Error('Spend amount must be positive');
  const db = await getDb();
  const bal = await getBalance(userId);
  if (bal.total < amount) {
    const err = new Error('Insufficient tokens');
    err.code = 'INSUFFICIENT_TOKENS';
    err.balance = bal;
    throw err;
  }
  const eventType = opts.event_type || 'generation_spend';
  const fromUtlt = Math.min(bal.utlt, amount);
  const fromCot = amount - fromUtlt;

  if (fromUtlt > 0) {
    await db.prepare(
      `INSERT INTO token_ledger (user_id, amount, bucket, event_type, source, related_campaign_id)
       VALUES (?, ?, 'utlt', ?, ?, ?)`
    ).run(userId, -fromUtlt, eventType, opts.source || null, opts.related_campaign_id || null);
  }
  if (fromCot > 0) {
    await db.prepare(
      `INSERT INTO token_ledger (user_id, amount, bucket, event_type, source, related_campaign_id)
       VALUES (?, ?, 'cot', ?, ?, ?)`
    ).run(userId, -fromCot, eventType, opts.source || null, opts.related_campaign_id || null);
  }
  return getBalance(userId);
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------
function requireSession(req, res) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  return true;
}

async function requireAdmin(req, res) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
  const db = await getDb();
  const user = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
  if (!user || !adminEmails.includes(user.email)) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

// GET /api/tokens/balance — current user's balance
router.get('/balance', async function(req, res) {
  if (!requireSession(req, res)) return;
  try {
    const bal = await getBalance(req.session.userId);
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: 'Could not load balance' });
  }
});

// GET /api/tokens/ledger — current user's recent transactions
router.get('/ledger', async function(req, res) {
  if (!requireSession(req, res)) return;
  try {
    const db = await getDb();
    const rows = await db.prepare(
      "SELECT amount, bucket, event_type, source, created_at FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
    ).all(req.session.userId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load ledger' });
  }
});

// POST /api/tokens/admin/credit — admin-only manual credit (testing)
// body: { user_id, amount, bucket?, source? }
router.post('/admin/credit', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!(await requireAdmin(req, res))) return;
  const { user_id, amount, bucket, source } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!user_id || !Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'Provide user_id and a positive amount' });
  }
  if (bucket && bucket !== 'utlt' && bucket !== 'cot') {
    return res.status(400).json({ error: "bucket must be 'utlt' or 'cot'" });
  }
  try {
    const bal = await creditTokens(user_id, amt, {
      bucket: bucket || 'cot',
      event_type: 'manual_credit',
      source: source || 'admin'
    });
    res.json({ ok: true, balance: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/tokens/admin/set-balance — admin-only TESTING helper.
// Wipes the user's ledger and credits a fresh balance in COT. Use ONLY
// in staging for exercising edge cases (exactly N tokens, zero, etc.).
// Writes a marker row in the ledger so the wipe is auditable.
// body: { user_id, amount }   amount >= 0
router.post('/admin/set-balance', async function(req, res) {
  if (!requireSession(req, res)) return;
  if (!(await requireAdmin(req, res))) return;
  const { user_id, amount } = req.body || {};
  const amt = parseInt(amount, 10);
  if (!user_id || !Number.isFinite(amt) || amt < 0) {
    return res.status(400).json({ error: 'Provide user_id and a non-negative amount' });
  }
  try {
    const db = await getDb();
    // Wipe existing ledger rows for this user.
    await db.prepare('DELETE FROM token_ledger WHERE user_id = ?').run(user_id);
    // Audit marker: a zero-amount note documenting the wipe.
    await db.prepare(
      "INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES (?, 0, 'cot', 'admin_reset', ?)"
    ).run(user_id, 'set_balance to ' + amt);
    // Credit the requested amount (skip if 0 — the marker is enough).
    let bal;
    if (amt > 0) {
      bal = await creditTokens(user_id, amt, {
        bucket: 'cot',
        event_type: 'manual_credit',
        source: 'admin_set_balance'
      });
    } else {
      bal = await getBalance(user_id);
    }
    res.json({ ok: true, balance: bal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = {
  router,
  getTokenCost,
  getBalance,
  canAfford,
  creditTokens,
  spendTokens
};
