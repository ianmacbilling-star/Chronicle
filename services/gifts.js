// ============================================================================
// GIFT CERTIFICATES  (v3.1.43 -- TD-934, step 1)
// Spec: claude/GIFT_CERTIFICATES_SPEC.md
//
// A gift is a PRODUCT bought for someone else: a Platinum Pass or a token pack.
// Never a dollar balance. Everything that makes it a gift (the code, the
// recipient, the delivery) is ours; Stripe only ever sees an ordinary payment
// (step 2).
//
// THE PLAIN CODE IS NEVER STORED. Only its sha256 and its last four characters.
// That has one consequence worth knowing: the code is generated AT DELIVERY, and
// a Resend issues a NEW code, which kills the old one. That is the behaviour you
// want when a gift went to the wrong address.
//
// THE SWITCH. app_settings.gifts_enabled = '1' turns gifts on for customers. It
// is per environment (each has its own database) and needs no deploy. Off means
// dormant: no customer route answers, nothing is delivered, and the dashboard
// refuses to issue a gift whose link would not work.
// ============================================================================
const crypto = require('crypto');

// 31 characters: no 0/O, 1/I/L, so a code read aloud or off paper survives.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 12;
const SETTING_KEY = 'gifts_enabled';
const DELIVERY_HOUR_ET = 9;        // Ian, 2026-10-01: dated gifts go out at 9am Eastern
const MAX_DELIVERY_ATTEMPTS = 5;   // then stop and tell Ian, rather than retry forever
const MESSAGE_MAX = 300;
// A PASS CAN BE TAKEN AS TOKENS INSTEAD (Ian, 2026-10-01): its list price divided by this many cents
// per token, rounded down, read AT REDEMPTION so the dashboard dial always applies. Seeded at 20.
const CONVERT_SETTING = 'gift_convert_cents_per_token';
const DEFAULT_CONVERT_CENTS = 20;

function generateCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET.charAt(crypto.randomInt(CODE_ALPHABET.length));
  return s;
}

// GIFT-XXXX-XXXX-XXXX for people; the 12 bare characters for everything else.
function formatCode(bare) {
  return 'GIFT-' + bare.slice(0, 4) + '-' + bare.slice(4, 8) + '-' + bare.slice(8, 12);
}

// Whatever was typed or pasted -> the 12 bare characters, or null. Case, spaces,
// dashes and a leading GIFT are forgiven; a character outside the alphabet is not
// guessed at (an O typed for a 0 can never be right, because there are no zeros).
function normalizeCode(input) {
  let s = String(input == null ? '' : input).toUpperCase().replace(/[\s-]+/g, '');
  if (s.indexOf('GIFT') === 0 && s.length === CODE_LEN + 4) s = s.slice(4);
  if (s.length !== CODE_LEN) return null;
  for (let i = 0; i < s.length; i++) if (CODE_ALPHABET.indexOf(s.charAt(i)) < 0) return null;
  return s;
}

function hashCode(bare) {
  return crypto.createHash('sha256').update('campaignia-gift:' + bare).digest('hex');
}

// ---------------------------------------------------------------------------
// WHAT CAN BE GIFTED, read from the live catalogs every time. Same contract as a
// purchase: the server decides what an id is worth, never the client.
// ---------------------------------------------------------------------------
function catalog() {
  const passes = require('./billing/passes');
  const packs = require('./billing/packs');
  const out = [];
  passes.listPasses().forEach(function (p) {
    out.push({ kind: 'pass', id: p.id, name: p.name, months: p.months, tokens: p.tokens, price_cents: p.price_cents, tier: p.tier || 'platinum' });
  });
  packs.listPacks().forEach(function (p) {
    out.push({ kind: 'pack', id: p.id, name: p.name + ' token pack', months: null, tokens: p.tokens, price_cents: p.price_cents, tier: null });
  });
  return out;
}

// The frozen quote for one item, or null. Saved on the gift row when it is made,
// so the recipient gets what was bought even if Ian changes the catalog later.
function quoteFor(kind, id) {
  const hit = catalog().filter(function (c) { return c.kind === kind && c.id === id; })[0];
  return hit ? Object.assign({}, hit) : null;
}

function describeGift(row) {
  if (!row) return '';
  if (row.item_kind === 'pass') {
    return row.months + ' months of Campaignia Platinum' + (row.tokens > 0 ? ' and ' + row.tokens + ' tokens' : '');
  }
  return row.tokens + ' Campaignia tokens';
}

// ---------------------------------------------------------------------------
// PASS -> TOKENS
// ---------------------------------------------------------------------------
// A rate is a positive number of cents per token, at most two decimals, below $100 a token.
function cleanRate(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || n >= 10000) return null;
  return Math.round(n * 100) / 100;
}
async function getConvertRate(db) {
  try {
    const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(CONVERT_SETTING);
    const n = r ? cleanRate(r.value) : null;
    return n || DEFAULT_CONVERT_CENTS;
  } catch (e) { return DEFAULT_CONVERT_CENTS; }
}
async function setConvertRate(db, v) {
  const n = cleanRate(v);
  if (!n) throw new Error('bad rate');
  const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get(CONVERT_SETTING);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(String(n), CONVERT_SETTING);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(CONVERT_SETTING, String(n));
  return n;
}
// Tokens a gift would convert to at this rate, or null if it cannot convert (not a pass, or no
// recorded list price). Pure, so the guard can drive it.
function convertTokensFor(row, rate) {
  if (!row || row.item_kind !== 'pass') return null;
  const v = parseInt(row.value_cents, 10);
  const r = cleanRate(rate);
  if (!(v > 0) || !r) return null;
  return Math.floor(v / r);
}

// ---------------------------------------------------------------------------
// THE SWITCH
// ---------------------------------------------------------------------------
async function isEnabled(db) {
  try {
    const r = await db.prepare('SELECT value FROM app_settings WHERE setting_key = ?').get(SETTING_KEY);
    return !!(r && r.value === '1');
  } catch (e) { return false; }   // can't tell -> off. Dormant is the safe direction.
}

async function setEnabled(db, on) {
  const v = on ? '1' : '0';
  const ex = await db.prepare('SELECT id FROM app_settings WHERE setting_key = ?').get(SETTING_KEY);
  if (ex) await db.prepare('UPDATE app_settings SET value = ? WHERE setting_key = ?').run(v, SETTING_KEY);
  else await db.prepare('INSERT INTO app_settings (setting_key, value) VALUES (?, ?)').run(SETTING_KEY, v);
  return !!on;
}

// ---------------------------------------------------------------------------
// EASTERN TIME. Delivery dates are days in Eastern, and 9am Eastern is the hour.
// Intl does the DST work; nothing here adds or subtracts hours by hand.
// ---------------------------------------------------------------------------
function easternParts(date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  });
  const o = {};
  f.formatToParts(date || new Date()).forEach(function (p) { o[p.type] = p.value; });
  return { ymd: o.year + '-' + o.month + '-' + o.day, hour: parseInt(o.hour, 10) };
}

// deliver_on comes back from node-pg as a Date at LOCAL midnight of that day (pg parses a DATE
// column in the process's time zone), or as text. Read the Date's local parts, never its ISO form:
// toISOString() shifts the day in any time zone east of UTC. Railway runs in UTC, where both agree.
function dayString(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Is a gift dated `deliverOn` due now? No date -> now. A date in the past -> now
// (a gift is never skipped for being late). Today -> from 9am Eastern.
function isDue(deliverOn, now) {
  const d = dayString(deliverOn);
  if (!d) return true;
  const e = easternParts(now || new Date());
  if (d < e.ymd) return true;
  if (d > e.ymd) return false;
  return e.hour >= DELIVERY_HOUR_ET;
}

// ---------------------------------------------------------------------------
// VALIDATION of a dashboard (comp) gift. Pure, so the guard can drive it.
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// a***@example.com -- enough for the owner to recognise their own address, not enough to hand a
// stranger holding the code somebody's email.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return '';
  return s.charAt(0) + '***' + s.slice(at);
}

function isValidEmail(v) { return EMAIL_RE.test(String(v || '')); }

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function validateGiftInput(body, now) {
  body = body || {};
  const kind = String(body.item_kind || '');
  const id = String(body.item_id || '');
  if (kind !== 'pass' && kind !== 'pack') return { ok: false, error: 'Choose what the gift is.' };
  const quote = quoteFor(kind, id);
  if (!quote) return { ok: false, error: 'That item is not in the catalog.' };
  const recipientEmail = cleanText(body.recipient_email, 254).toLowerCase();
  if (!EMAIL_RE.test(recipientEmail)) return { ok: false, error: "Enter the recipient's email address." };
  const recipientName = cleanText(body.recipient_name, 80);
  if (!recipientName) return { ok: false, error: "Enter the recipient's name." };
  const fromName = cleanText(body.from_name, 80);
  if (!fromName) return { ok: false, error: 'Enter who the gift is from.' };
  const rawMsg = String(body.message == null ? '' : body.message);
  if (rawMsg.trim().length > MESSAGE_MAX) return { ok: false, error: 'The message can be up to ' + MESSAGE_MAX + ' characters.' };
  const message = cleanText(rawMsg, MESSAGE_MAX);
  let deliverOn = null;
  if (body.deliver_on) {
    deliverOn = dayString(body.deliver_on);
    if (!deliverOn || isNaN(Date.parse(deliverOn + 'T12:00:00Z'))) return { ok: false, error: 'The delivery date is not a valid date.' };
    if (deliverOn < easternParts(now || new Date()).ymd) return { ok: false, error: 'The delivery date is in the past.' };
  }
  return { ok: true, v: { quote: quote, recipientEmail: recipientEmail, recipientName: recipientName, fromName: fromName, message: message, deliverOn: deliverOn } };
}

// ---------------------------------------------------------------------------
// DELIVERY. Issue a fresh code, store only its hash, then send. A failed send
// leaves the row 'paid' (not delivered) with the attempt counted; the code that
// failed to send was never seen by anyone, and the next attempt replaces it.
// sendFn(row, formattedCode) is injected so the guard can run this with no mail.
// Returns { ok, error? }.
// ---------------------------------------------------------------------------
async function issueAndSend(db, row, sendFn, opts) {
  opts = opts || {};
  const bare = generateCode();
  const r = await db.prepare(
    "UPDATE gift_certificates SET code_hash = ?, code_last4 = ?, recipient_email = COALESCE(?, recipient_email) " +
    "WHERE id = ? AND status IN ('paid', 'delivered')"
  ).run(hashCode(bare), bare.slice(-4), opts.newEmail || null, row.id);
  if (!r || !r.changes) return { ok: false, error: 'This gift can no longer be sent (it was redeemed or voided).' };
  const fresh = await db.prepare('SELECT * FROM gift_certificates WHERE id = ?').get(row.id);
  try {
    await sendFn(fresh, formatCode(bare));
  } catch (e) {
    await db.prepare('UPDATE gift_certificates SET delivery_attempts = COALESCE(delivery_attempts, 0) + 1, last_error = ? WHERE id = ?')
      .run(String((e && e.message) || e).slice(0, 500), row.id);
    return { ok: false, error: 'The email could not be sent: ' + ((e && e.message) || 'unknown error') };
  }
  await db.prepare(
    "UPDATE gift_certificates SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ? AND status IN ('paid', 'delivered')"
  ).run(row.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// LOOKUP: what a code is, without spending it. Says nothing about who bought it
// for whom beyond the "from" name the gift itself carries, and never whose
// account used it.
// ---------------------------------------------------------------------------
// viewerEmail (signed-in only): when it differs from the address the gift was sent to, say so.
// A WARNING, NEVER A BLOCK (Ian, 2026-10-01): people redeem gifts on a different account than the
// one the email reached all the time. The address is masked, and only a signed-in viewer gets it.
// ---------------------------------------------------------------------------
// WHAT SUBSCRIPTION IS THIS PERSON ON, for the pass-or-tokens choice (Ian, 2026-10-01):
//   'platinum'      -> a gifted pass adds nothing; they take the tokens (the server insists)
//   'silver'/'gold' -> Platinum starts TODAY on top; the subscription is not touched
//   'none'          -> no subscription, or one that is already cancelling: the pass as normal
// "Can still bill" uses the same five statuses as fulfillPassCheckout in routes/tokens.js, which
// asks the same question. TD-793 records that this list is defined in several places.
// ---------------------------------------------------------------------------
const SUB_CAN_BILL = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];
function subscriptionState(u) {
  if (!u) return 'none';
  const tier = String(u.tier || '');
  if (['silver', 'gold', 'platinum'].indexOf(tier) < 0) return 'none';
  if (!u.stripe_subscription_id) return 'none';
  if (SUB_CAN_BILL.indexOf(String(u.subscription_status || '')) < 0) return 'none';
  if (u.cancel_at_period_end === true) return 'none';
  return tier;
}

function sentToOther(row, viewerEmail) {
  const a = String((row && row.recipient_email) || '').trim().toLowerCase();
  const b = String(viewerEmail || '').trim().toLowerCase();
  return !!(a && b && a !== b);
}

async function lookup(db, input, rate, viewer) {
  const viewerEmail = viewer && viewer.email;
  const bare = normalizeCode(input);
  if (!bare) return { ok: false, reason: 'not_found' };
  const row = await db.prepare('SELECT * FROM gift_certificates WHERE code_hash = ?').get(hashCode(bare));
  if (!row) return { ok: false, reason: 'not_found' };
  const state = (row.status === 'paid' || row.status === 'delivered') ? 'available'
    : (row.status === 'redeemed') ? 'redeemed' : (row.status === 'void') ? 'void' : 'not_found';
  if (state === 'not_found') return { ok: false, reason: 'not_found' };
  return { ok: true, state: state, kind: row.item_kind, months: row.months, tokens: row.tokens,
           convertTokens: rate ? convertTokensFor(row, rate) : null,
           sentToOther: viewerEmail ? sentToOther(row, viewerEmail) : false,
           sentToMasked: (viewerEmail && sentToOther(row, viewerEmail)) ? maskEmail(row.recipient_email) : null,
           subscription: viewer ? subscriptionState(viewer) : null,
           subPausedUntil: (viewer && require('./billing/subscriptionPause').isFuture(viewer.sub_paused_until)) ? viewer.sub_paused_until : null,
           description: describeGift(row), fromName: row.buyer_name || null };
}

// ---------------------------------------------------------------------------
// REDEEM. One transaction: the gift row is locked, re-checked and marked
// redeemed, and the grant is written, together. Two tabs racing one code: the
// second waits on the lock, then finds it redeemed. Any throw rolls all of it back.
//
// A PASS stacks exactly as a bought pass does (passStackFrom / passAddMonths in
// routes/tokens.js), and its tokens land as carry-over. Unlike a bought pass it
// does NOT stop a subscription renewing (Ian, 2026-10-01): a gift should never
// change someone's billing.
//
// A TOKEN PACK follows the pack rule (canPurchaseTokens): refused on a Free Trial
// account, with the gift left untouched for later -- it never expires.
//
// opts.convert: take a PASS as tokens instead -- list price / the dashboard rate, read
// now. No months, no pass. Converting makes it a token gift, so the pack rule applies.
//
// Returns { ok:true, kind, months, tokens, runsUntil, converted } or { ok:false, reason }.
// reason: not_found | redeemed | void | needs_plan | cannot_convert | take_tokens
// ---------------------------------------------------------------------------
async function redeem(db, userId, input, deps, opts) {
  deps = deps || {};
  opts = opts || {};
  const convert = opts.convert === true;
  const bare = normalizeCode(input);
  if (!bare) return { ok: false, reason: 'not_found' };
  const hash = hashCode(bare);
  const peek = await db.prepare('SELECT id, item_kind, status, value_cents FROM gift_certificates WHERE code_hash = ?').get(hash);
  if (!peek) return { ok: false, reason: 'not_found' };
  if (peek.status === 'redeemed') return { ok: false, reason: 'redeemed' };
  if (peek.status === 'void') return { ok: false, reason: 'void' };
  if (peek.status !== 'paid' && peek.status !== 'delivered') return { ok: false, reason: 'not_found' };
  let rate = null;
  if (convert) {
    if (peek.item_kind !== 'pass') return { ok: false, reason: 'cannot_convert' };
    rate = opts.rate || await getConvertRate(db);
    if (!convertTokensFor(peek, rate)) return { ok: false, reason: 'cannot_convert' };
  }
  if (peek.item_kind === 'pack' || convert) {
    const canBuy = deps.canPurchaseTokens || require('../middleware/tiers').canPurchaseTokens;
    if (!(await canBuy(userId))) return { ok: false, reason: 'needs_plan' };
  }
  const tok = deps.tokens || require('../routes/tokens');
  const now = deps.now || new Date();
  const result = await db.transaction(async function (tx) {
    const g = (await tx.query('SELECT * FROM gift_certificates WHERE code_hash = $1 FOR UPDATE', [hash])).rows[0];
    if (!g) return { ok: false, reason: 'not_found' };
    if (g.status === 'redeemed') return { ok: false, reason: 'redeemed' };
    if (g.status === 'void') return { ok: false, reason: 'void' };
    if (g.status !== 'paid' && g.status !== 'delivered') return { ok: false, reason: 'not_found' };
    const u = (await tx.query(
      'SELECT tier, pass_expires_at, current_period_end, stripe_subscription_id, subscription_status, cancel_at_period_end, sub_paused_until FROM users WHERE id = $1 FOR UPDATE',
      [userId])).rows[0];
    if (!u) throw new Error('No such user');
    const sub = subscriptionState(u);
    // EVERY REFUSAL COMES BEFORE THE FIRST WRITE. A Platinum subscriber keeping the pass would get
    // months they already have, so they are sent back to take the tokens; nothing is spent.
    if (g.item_kind === 'pass' && !convert && sub === 'platinum') return { ok: false, reason: 'take_tokens' };
    // v3.1.45 -- TD-938. A Silver/Gold subscriber keeping the pass has their billing paused until it
    // ends (extended if already paused for an earlier pass). The Redeem page says so before they click.
    const plan = require('./billing/subscriptionPause').planForPass(u, '', { gift: true, nowMs: now.getTime() });
    const grant = convert ? convertTokensFor(g, rate) : g.tokens;
    if (convert && !grant) throw new Error('conversion lost its value');
    await tx.query(
      "UPDATE gift_certificates SET status = 'redeemed', redeemed_at = $1, redeemed_by_user_id = $2, redeemed_as = $3, redeemed_tokens = $4 WHERE id = $5",
      [now.toISOString(), userId, convert ? 'tokens' : g.item_kind, grant, g.id]);
    let runsUntil = null;
    if (g.item_kind === 'pass' && !convert) {
      // WHEN THE PASS STARTS. A Silver or Gold subscriber who keeps their subscription gets
      // Platinum from TODAY (after any pass they already hold) -- their paid period is not
      // waiting to end, so it must not delay the upgrade. Anyone else stacks exactly as a bought
      // pass does: after the later of now, a live pass, or a paid-up period that is ending.
      const periodEnd = plan.stackPeriodEnd;
      const until = tok.passAddMonths(tok.passStackFrom(now.getTime(), u.pass_expires_at, periodEnd), g.months);
      runsUntil = until.toISOString();
      await tx.query('UPDATE users SET pass_tier = $1, pass_expires_at = $2 WHERE id = $3', ['platinum', runsUntil, userId]);
    }
    if (grant > 0) {
      await tx.query(
        'INSERT INTO token_ledger (user_id, amount, bucket, event_type, source) VALUES ($1, $2, $3, $4, $5)',
        [userId, grant, 'cot', 'gift_redeem', 'gift:' + g.id + (convert ? ':as-tokens' : '')]);
    }
    await tx.query('UPDATE users SET last_purchase_at = $1 WHERE id = $2', [now.toISOString(), userId]);
    const subAction = (g.item_kind === 'pass' && !convert && (sub === 'silver' || sub === 'gold')) ? plan.action : 'none';
    return { ok: true, id: g.id, kind: g.item_kind, converted: convert, months: convert ? null : g.months, tokens: grant,
             runsUntil: runsUntil, subscription: sub, subAction: subAction, _subId: u.stripe_subscription_id, description: describeGift(g) };
  });
  // v3.1.45 -- AFTER THE COMMIT, NEVER INSIDE IT. The pass is theirs whatever Stripe says next. A
  // refused pause leaves them with the pass and a subscription still billing: visible, fixable, and
  // Ian is emailed. Pausing inside the transaction could pause billing for a grant that rolls back.
  if (result && result.ok && result.subAction === 'pause' && result._subId) {
    try {
      await require('./billing/subscriptionPause').pauseForPass(db, userId, result._subId, result.runsUntil, deps);
      result.pausedUntil = result.runsUntil;
    } catch (e) {
      result.pauseFailed = true;
      try {
        const alert = deps.sendAlertEmail || require('../routes/email').sendAlertEmail;
        await alert('Gift redeemed, but the subscription could not be paused',
          'User ' + userId + ' redeemed gift ' + result.id + ' (Platinum until ' + String(result.runsUntil).slice(0, 10) + '). Their ' +
          result.subscription + ' subscription ' + result._subId + ' could not be paused: ' + ((e && e.message) || 'unknown error') +
          String.fromCharCode(10) + 'They are still being billed. Pause it by hand in the Stripe dashboard until that date.');
      } catch (_) {}
    }
  }
  if (result) delete result._subId;
  return result;
}

module.exports = {
  CODE_ALPHABET, CODE_LEN, SETTING_KEY, DELIVERY_HOUR_ET, MAX_DELIVERY_ATTEMPTS, MESSAGE_MAX,
  CONVERT_SETTING, DEFAULT_CONVERT_CENTS, cleanRate, getConvertRate, setConvertRate, convertTokensFor,
  generateCode, formatCode, normalizeCode, hashCode,
  catalog, quoteFor, describeGift,
  isEnabled, setEnabled,
  easternParts, dayString, isDue,
  isValidEmail, maskEmail, sentToOther, subscriptionState, SUB_CAN_BILL, validateGiftInput, issueAndSend,
  lookup, redeem
};
