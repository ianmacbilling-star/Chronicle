// ============================================================================
// GIFT ROUTES  (mounted at /api/gifts)  --  v3.1.43, TD-934 step 1
// Spec: claude/GIFT_CERTIFICATES_SPEC.md
//
// Step 1: the on/off switch, the dashboard list, free (comp) gifts with their
// email, and redeeming. Buying (step 2) arrives in a later batch.
//
// THE SWITCH GATES THE SERVER, NOT THE PAINT. Every customer-facing route reads
// gifts.isEnabled() itself. A hidden button over a live route is not off.
// The admin routes work while it is off -- so Ian can look and switch it on --
// except the ones that would email a link to a customer.
// ============================================================================
const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const gifts = require('../services/gifts');

const LIST_COLUMNS =
  'g.id, g.code_last4, g.item_kind, g.item_id, g.item_name, g.months, g.tokens, g.price_cents, g.value_cents, g.currency, g.comp, ' +
  'g.buyer_email, g.buyer_name, g.recipient_name, g.recipient_email, g.message, g.deliver_on, g.status, ' +
  'g.delivery_attempts, g.last_error, g.delivered_at, g.redeemed_at, g.redeemed_by_user_id, g.redeemed_as, g.redeemed_tokens, g.voided_at, g.void_reason, ' +
  'g.created_by_admin, g.created_at, u.email AS redeemed_by_email';

const STATUSES = ['pending_payment', 'paid', 'delivered', 'redeemed', 'void'];
const OFF_MESSAGE = 'Gifts are switched off on this server. Switch them on first: a gift sent now would carry a link that does not work.';

async function adminEmail(db, req) {
  try {
    const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(req.session.userId);
    return (u && u.email) || null;
  } catch (e) { return null; }
}

function idParam(req) {
  const n = parseInt(req.params.id, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// PUBLIC: is gifting on here? The landing buttons (step 2) ask this.
router.get('/status', async function (req, res) {
  try {
    const db = await getDb();
    res.json({ enabled: await gifts.isEnabled(db) });
  } catch (e) { res.json({ enabled: false }); }
});

// ---------------------------------------------------------------------------
// GUESS LIMIT. A code has about 10^17 combinations, so guessing is hopeless
// anyway; this just stops anyone trying. Only MISSES count (an unknown code),
// per IP and per account, 10 in 15 minutes. In process memory, like the other
// short-lived counters here: a restart forgets, which only ever helps a real user.
// ---------------------------------------------------------------------------
const MISS_LIMIT = 10;
const MISS_WINDOW_MS = 15 * 60 * 1000;
const _misses = new Map();
function _missKeys(req) {
  const keys = ['ip:' + (req.ip || '')];
  if (req.session && req.session.userId) keys.push('u:' + req.session.userId);
  return keys;
}
function tooManyMisses(req, now) {
  now = now || Date.now();
  return _missKeys(req).some(function (k) {
    const e = _misses.get(k);
    return e && now - e.start < MISS_WINDOW_MS && e.count >= MISS_LIMIT;
  });
}
function recordMiss(req, now) {
  now = now || Date.now();
  _missKeys(req).forEach(function (k) {
    const e = _misses.get(k);
    if (!e || now - e.start >= MISS_WINDOW_MS) _misses.set(k, { start: now, count: 1 });
    else e.count++;
  });
  if (_misses.size > 5000) _misses.clear();   // a flood cannot grow this without bound
}
const SLOW_DOWN = 'Too many codes that did not match. Wait 15 minutes, then check the code in your email and try again.';
const NOT_AVAILABLE = 'Gifts are not available right now.';

// PUBLIC: what is this code? Signed in or not -- a visitor deciding whether to make an account
// gets to see what they were given. Never spends anything.
router.post('/lookup', async function (req, res) {
  try {
    const db = await getDb();
    if (!(await gifts.isEnabled(db))) return res.status(404).json({ error: NOT_AVAILABLE, reason: 'off' });
    if (tooManyMisses(req)) return res.status(429).json({ error: SLOW_DOWN, reason: 'slow_down' });
    // Signed in: who is looking, so the page can warn about a different address and offer the
    // right choice for their subscription. Signed out: nothing about anyone.
    let viewer = null;
    if (req.session && req.session.userId) {
      try {
        viewer = await db.prepare('SELECT email, tier, stripe_subscription_id, subscription_status, cancel_at_period_end, sub_paused_until FROM users WHERE id = ?').get(req.session.userId);
      } catch (_) { viewer = null; }
    }
    const r = await gifts.lookup(db, req.body && req.body.code, await gifts.getConvertRate(db), viewer);
    if (!r.ok) recordMiss(req);
    res.json(r);
  } catch (e) {
    console.error('[gifts] lookup error:', e && e.message);
    res.status(500).json({ error: 'Could not check that code.' });
  }
});

// REDEEM, into whoever is signed in. Refused in a support session (impersonationGuard).
router.post('/redeem', requireAuth, async function (req, res) {
  try {
    const db = await getDb();
    if (!(await gifts.isEnabled(db))) return res.status(404).json({ error: NOT_AVAILABLE, reason: 'off' });
    if (tooManyMisses(req)) return res.status(429).json({ error: SLOW_DOWN, reason: 'slow_down' });
    const r = await gifts.redeem(db, req.session.userId, req.body && req.body.code, null, { convert: !!(req.body && req.body.convert === true) });
    if (!r.ok && r.reason === 'not_found') recordMiss(req);
    if (r.ok) console.log('[gifts] gift ' + r.id + ' redeemed by user ' + req.session.userId);
    res.json(r);
  } catch (e) {
    console.error('[gifts] redeem error:', e && e.message);
    res.status(500).json({ error: 'Something went wrong and nothing was redeemed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// ADMIN
// ---------------------------------------------------------------------------
router.get('/admin/overview', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const where = [];
    const params = [];
    const st = String(req.query.status || '');
    if (STATUSES.indexOf(st) >= 0) { where.push('g.status = ?'); params.push(st); }
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 120);
    if (q) {
      where.push("(lower(g.recipient_email) LIKE ? OR lower(COALESCE(g.recipient_name, '')) LIKE ? OR lower(COALESCE(g.buyer_email, '')) LIKE ? OR lower(COALESCE(g.buyer_name, '')) LIKE ? OR upper(COALESCE(g.code_last4, '')) = ?)");
      const like = '%' + q.replace(/[%_\\]/g, '') + '%';
      params.push(like, like, like, like, q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4));
    }
    const rows = await db.prepare(
      'SELECT ' + LIST_COLUMNS + ' FROM gift_certificates g LEFT JOIN users u ON u.id = g.redeemed_by_user_id' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY g.created_at DESC, g.id DESC LIMIT 200'
    ).all(params);
    res.json({ enabled: await gifts.isEnabled(db), convertRate: await gifts.getConvertRate(db), catalog: gifts.catalog(), gifts: rows || [] });
  } catch (e) {
    console.error('[gifts] overview error:', e && e.message);
    res.status(500).json({ error: 'Could not load gifts.' });
  }
});

router.post('/admin/enabled', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const on = !!(req.body && req.body.enabled === true);
    await gifts.setEnabled(db, on);
    console.log('[gifts] switched ' + (on ? 'ON' : 'OFF') + ' by ' + (await adminEmail(db, req)));
    res.json({ ok: true, enabled: on });
  } catch (e) { res.status(500).json({ error: 'Could not save the switch.' }); }
});

// THE PASS-TO-TOKENS RATE, in cents per token. Read at redemption, so a change applies to every
// pass gift not yet redeemed, paid or free.
router.post('/admin/convert-rate', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    if (!gifts.cleanRate(req.body && req.body.cents)) return res.status(400).json({ error: 'Enter the cents per token, more than 0 (for example 20).' });
    const n = await gifts.setConvertRate(db, req.body.cents);
    res.json({ ok: true, convertRate: n });
  } catch (e) { res.status(500).json({ error: 'Could not save the rate.' }); }
});

// A FREE GIFT, issued from the dashboard: giveaways, influencers, apologies. comp = true keeps it out
// of revenue. Sent now, or held for its date and sent by the scheduler at 9am Eastern.
router.post('/admin/comp', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    if (!(await gifts.isEnabled(db))) return res.status(409).json({ error: OFF_MESSAGE });
    const checked = gifts.validateGiftInput(req.body || {}, new Date());
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const v = checked.v;
    const ins = await db.prepare(
      'INSERT INTO gift_certificates (item_kind, item_id, item_name, months, tokens, price_cents, value_cents, currency, comp, ' +
      'buyer_name, recipient_name, recipient_email, message, deliver_on, status, created_by_admin) ' +
      "VALUES (?, ?, ?, ?, ?, 0, ?, 'usd', true, ?, ?, ?, ?, ?, 'paid', ?)"
    ).run(v.quote.kind, v.quote.id, v.quote.name, v.quote.months, v.quote.tokens, v.quote.price_cents,
      v.fromName, v.recipientName, v.recipientEmail, v.message || null, v.deliverOn, await adminEmail(db, req));
    const id = ins && ins.lastInsertRowid;
    const row = await db.prepare('SELECT * FROM gift_certificates WHERE id = ?').get(id);
    if (!gifts.isDue(v.deliverOn, new Date())) {
      return res.json({ ok: true, id: id, sent: false, scheduled: v.deliverOn });
    }
    const sent = await gifts.issueAndSend(db, row, require('./email').sendGiftEmail);
    if (!sent.ok) return res.json({ ok: true, id: id, sent: false, error: sent.error });
    res.json({ ok: true, id: id, sent: true });
  } catch (e) {
    console.error('[gifts] comp error:', e && e.message);
    res.status(500).json({ error: 'Could not create the gift.' });
  }
});

// RESEND: a NEW code, so the old one stops working. Optionally to a corrected address.
router.post('/admin/:id/resend', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    if (!(await gifts.isEnabled(db))) return res.status(409).json({ error: OFF_MESSAGE });
    const id = idParam(req);
    if (!id) return res.status(400).json({ error: 'Bad id.' });
    const row = await db.prepare('SELECT * FROM gift_certificates WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (row.status !== 'paid' && row.status !== 'delivered') return res.status(409).json({ error: 'Only an unredeemed, paid gift can be sent.' });
    let newEmail = null;
    if (req.body && req.body.email) {
      newEmail = String(req.body.email).trim().toLowerCase().slice(0, 254);
      if (!gifts.isValidEmail(newEmail)) return res.status(400).json({ error: 'That email address does not look right.' });
    }
    const sent = await gifts.issueAndSend(db, row, require('./email').sendGiftEmail, { newEmail: newEmail });
    if (!sent.ok) return res.status(502).json({ error: sent.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[gifts] resend error:', e && e.message);
    res.status(500).json({ error: 'Could not resend the gift.' });
  }
});

// CHANGE THE DELIVERY DATE: only while it has not gone out.
router.post('/admin/:id/date', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const id = idParam(req);
    if (!id) return res.status(400).json({ error: 'Bad id.' });
    const d = gifts.dayString(req.body && req.body.deliver_on);
    if (!d || isNaN(Date.parse(d + 'T12:00:00Z'))) return res.status(400).json({ error: 'Enter a valid date.' });
    if (d < gifts.easternParts(new Date()).ymd) return res.status(400).json({ error: 'That date is in the past.' });
    const r = await db.prepare("UPDATE gift_certificates SET deliver_on = ? WHERE id = ? AND status = 'paid'").run(d, id);
    if (!r || !r.changes) return res.status(409).json({ error: 'Only a gift that has not been sent yet can be re-dated.' });
    res.json({ ok: true, deliver_on: d });
  } catch (e) { res.status(500).json({ error: 'Could not change the date.' }); }
});

// VOID: the code stops working. Free gifts only in this step -- voiding a PAID gift must refund it
// in Stripe at the same moment, and that arrives with gift purchases (step 2). Never a redeemed one.
router.post('/admin/:id/void', requireAuth, requireAdmin, async function (req, res) {
  try {
    const db = await getDb();
    const id = idParam(req);
    if (!id) return res.status(400).json({ error: 'Bad id.' });
    const row = await db.prepare('SELECT id, comp, status FROM gift_certificates WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    if (!row.comp) return res.status(409).json({ error: 'A paid gift is voided together with its refund, which is not built yet.' });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200) || null;
    const r = await db.prepare(
      "UPDATE gift_certificates SET status = 'void', voided_at = CURRENT_TIMESTAMP, void_reason = ? " +
      "WHERE id = ? AND comp = true AND status IN ('pending_payment', 'paid', 'delivered')"
    ).run(reason, id);
    if (!r || !r.changes) return res.status(409).json({ error: 'This gift has already been redeemed or voided.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not void the gift.' }); }
});

module.exports = router;
module.exports._test = { tooManyMisses: tooManyMisses, recordMiss: recordMiss, MISS_LIMIT: MISS_LIMIT };
