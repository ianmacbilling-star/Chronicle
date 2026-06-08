'use strict';

// ============================================================
// PRINT ORDERS — customer-facing print-on-demand (Phase: skeleton)
// ============================================================
// Mounts the vendor-neutral PrintProvider behind a small REST surface:
//   GET  /api/print/options       -> the curated menu for a page count
//   POST /api/print/quote         -> live price for a selection + address
//   POST /api/print/order         -> place an order (payment-first)
//   GET  /api/print/order/:id     -> status + tracking for one order
//
// CRITICAL ORDERING RULE (see createOrder handler): the customer payment
// must SUCCEED before we submit the print job to the vendor. Vendor billing
// always lands on Campaignia's own account, so we never submit a job we
// haven't been paid for. Stripe isn't wired yet, so payment is STUBBED here
// (payment_status='stubbed'); the sequence and failure handling are built so
// dropping Stripe into the marked seam is the only change needed.
//
// Interior/cover PDF URLs are taken from the request body for now so the
// flow is testable against Lulu's sandbox with placeholder PDFs. They will
// be replaced by the server-side print-ready PDF generator (R2-hosted URLs).

const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { getPrintProvider } = require('../services/printing');
const catalog = require('../services/printing/catalog');

// Markup is read from app_settings ('print_markup_pct', default 10) and
// applied to the PRINT cost only -- shipping (and tax) pass through at cost.
const DEFAULT_PRINT_MARKUP_PCT = 10;
async function getPrintMarkupPct(db) {
  try {
    const r = await db.prepare("SELECT value FROM app_settings WHERE setting_key = ?").get('print_markup_pct');
    const p = r && r.value != null ? parseFloat(r.value) : NaN;
    return Number.isFinite(p) && p >= 0 ? p : DEFAULT_PRINT_MARKUP_PCT;
  } catch (e) { return DEFAULT_PRINT_MARKUP_PCT; }
}
function applyPrintMarkup(totalCost, printCost, pct) {
  var charge = Number(totalCost || 0) + Number(printCost || 0) * (pct / 100);
  return Math.round(charge * 100) / 100;
}

function requireSession(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Map the public request body to a neutral OrderRequest the provider takes.
function buildOrderRequest(body, spec, externalId, contactEmail) {
  const s = body.shipTo || {};
  return {
    externalId: externalId,
    title: body.title || 'Campaignia',
    contactEmail: contactEmail || body.contactEmail || '',
    interiorPdfUrl: body.interiorPdfUrl || '',
    coverPdfUrl: body.coverPdfUrl || '',
    spec: spec,
    quantity: Math.max(1, parseInt(body.quantity, 10) || 1),
    shippingLevel: body.shippingLevel || 'cheapest',
    shipTo: {
      name: s.name, street1: s.street1, street2: s.street2,
      city: s.city, postcode: s.postcode, stateCode: s.stateCode,
      countryCode: s.countryCode, phone: s.phone,
    },
  };
}

// ------------------------------------------------------------
// GET /options?pageCount=76  -> bindings that fit + color/finish axes.
// ------------------------------------------------------------
router.get('/options', requireSession, function (req, res) {
  const pageCount = parseInt(req.query.pageCount, 10);
  if (!(pageCount > 0)) return res.status(400).json({ error: 'pageCount required' });
  res.json(catalog.optionsForPageCount(pageCount));
});

// ------------------------------------------------------------
// GET /novel-info/:campaignId  -> campaign name, the versions the caller
// may order (canonical + members), and a page-count ESTIMATE.
//
// Version rules: canonical is always orderable. A DM may also order any
// player's version (those who have one); a player may order only their own.
// ------------------------------------------------------------
router.get('/novel-info/:campaignId', requireSession, async function (req, res) {
  try {
    const db = await getDb();
    const campaignId = parseInt(req.params.campaignId, 10);
    const userId = req.session.userId;

    const camp = await db.prepare('SELECT id, name, allow_player_novel_access FROM campaigns WHERE id = ?').get(campaignId);
    if (!camp) return res.status(404).json({ error: 'Campaign not found' });
    const mem = await db.prepare('SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?').get(campaignId, userId);
    if (!mem) return res.status(403).json({ error: 'Not a member of this campaign' });
    const isDm = mem.role === 'dm';
    if (!isDm && !camp.allow_player_novel_access) {
      return res.status(403).json({ error: 'Graphic novel access is disabled for players in this campaign' });
    }

    const versions = [{ kind: 'canonical', userId: null, name: 'Canonical (Story Master)' }];
    if (isDm) {
      const rows = await db.prepare(
        'SELECT u.id AS user_id, u.name, u.email FROM campaign_members cm JOIN users u ON u.id = cm.user_id ' +
        "WHERE cm.campaign_id = ? AND cm.role = 'player' AND EXISTS(" +
        'SELECT 1 FROM session_forks sf JOIN sessions s ON s.id = sf.session_id ' +
        "WHERE s.campaign_id = ? AND sf.user_id = u.id AND sf.role = 'player') ORDER BY u.name ASC"
      ).all(campaignId, campaignId);
      rows.forEach(function (r) {
        versions.push({ kind: 'member', userId: r.user_id, name: (r.name || r.email) + ' (member)' });
      });
    } else {
      const me = await db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
      versions.push({ kind: 'member', userId: userId, name: 'My version' + (me && me.name ? ' (' + me.name + ')' : '') });
    }

    // Page-count ESTIMATE only. The true printed count is set when the
    // print-ready PDF is generated (that generator is the next milestone);
    // ~1 panel/page from the campaign's moment count is close enough to gate
    // which bindings are offered.
    const cnt = await db.prepare(
      'SELECT COUNT(*) AS c FROM moments m JOIN sessions s ON s.id = m.session_id WHERE s.campaign_id = ?'
    ).get(campaignId);
    const moments = Number((cnt && cnt.c) || 0);
    const pageEstimate = Math.max(8, moments);

    res.json({ campaignName: camp.name, role: mem.role, versions: versions, pageEstimate: pageEstimate, momentCount: moments, estimated: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e && e.message || e) });
  }
});

// ------------------------------------------------------------
// POST /quote  body: { selection:{binding,colorTier,coverFinish}, pageCount,
//                      quantity, shipTo, shippingLevel }
// Returns a live vendor quote + the customer-facing charge (cost + margin).
// ------------------------------------------------------------
router.post('/quote', requireSession, async function (req, res) {
  try {
    const { selection, pageCount } = req.body || {};
    const built = catalog.buildSpec(selection, parseInt(pageCount, 10));
    if (!built.ok) return res.status(400).json({ error: 'Invalid selection', details: built.errors });

    const provider = getPrintProvider();
    const orderReq = buildOrderRequest(req.body, built.spec, 'quote', null);
    const quote = await provider.getQuote(orderReq);
    const db = await getDb();
    const pct = await getPrintMarkupPct(db);

    res.json({
      podPackageId: provider._packageId ? provider._packageId(built.spec) : undefined,
      printedPageCount: built.spec.pageCount,
      providerCost: quote.totalCost,
      currency: quote.currency,
      customerCharge: applyPrintMarkup(quote.totalCost, quote.printCost, pct),
      markupPct: pct,
      breakdown: { print: quote.printCost, shipping: quote.shippingCost },
    });
  } catch (e) {
    res.status(502).json({ error: 'Quote failed', detail: String(e && e.message || e) });
  }
});

// ------------------------------------------------------------
// POST /order  body: { campaignId?, sessionId?, selection, pageCount,
//                      quantity, shipTo, shippingLevel,
//                      interiorPdfUrl, coverPdfUrl, title }
//
// Sequence: validate -> fresh quote -> CHARGE CUSTOMER (stubbed) ->
// persist -> submit to vendor -> reconcile. If the vendor submit fails
// after a (real) charge, the order is marked order_failed for refund.
// ------------------------------------------------------------
router.post('/order', requireSession, async function (req, res) {
  const userId = req.session.userId;
  const body = req.body || {};
  const built = catalog.buildSpec(body.selection, parseInt(body.pageCount, 10));
  if (!built.ok) return res.status(400).json({ error: 'Invalid selection', details: built.errors });
  if (!body.interiorPdfUrl || !body.coverPdfUrl) {
    return res.status(400).json({ error: 'interiorPdfUrl and coverPdfUrl are required' });
  }

  let db, provider, contactEmail = null;
  try {
    db = await getDb();
    provider = getPrintProvider();
    const u = await db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
    contactEmail = u && u.email ? u.email : null;
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e && e.message || e) });
  }

  try {
    // 1) Fresh quote at the moment of checkout (prices/shipping move).
    const quoteReq = buildOrderRequest(body, built.spec, 'quote', contactEmail);
    const quote = await provider.getQuote(quoteReq);
    const pct = await getPrintMarkupPct(db);
    const customerCharge = applyPrintMarkup(quote.totalCost, quote.printCost, pct);
    const podPackageId = provider._packageId ? provider._packageId(built.spec) : null;

    // 2) Persist the order up-front (status pending) so we have a stable
    //    external_id and a record even if a later step throws.
    //    Snapshot the campaign + version names server-side so the order
    //    record stays meaningful even if things are later renamed/removed.
    const s = body.shipTo || {};
    const orderName = (body.orderName != null ? String(body.orderName) : '').trim().slice(0, 200) || null;
    const sourceUserId = body.sourceUserId ? parseInt(body.sourceUserId, 10) : null;
    const sourceKind = sourceUserId ? 'member' : 'canonical';
    let campaignName = null, sourceUserName = null;
    if (body.campaignId) {
      const c = await db.prepare('SELECT name FROM campaigns WHERE id = ?').get(body.campaignId);
      campaignName = c && c.name ? c.name : null;
    }
    if (sourceUserId) {
      const su = await db.prepare('SELECT name, email FROM users WHERE id = ?').get(sourceUserId);
      sourceUserName = su ? (su.name || su.email || null) : null;
    }
    const ins = await db.prepare(
      `INSERT INTO print_orders
        (user_id, campaign_id, session_id, provider, pod_package_id,
         binding, color_tier, cover_finish, page_count, quantity,
         interior_pdf_url, cover_pdf_url,
         ship_name, ship_street1, ship_street2, ship_city, ship_state,
         ship_postcode, ship_country, ship_phone, shipping_level,
         provider_cost, currency, customer_charge, payment_status, status,
         order_name, campaign_name, source_kind, source_user_id, source_user_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      userId, body.campaignId || null, body.sessionId || null, provider.name, podPackageId,
      built.spec.binding, (body.selection || {}).colorTier, built.spec.coverFinish,
      built.spec.pageCount, quoteReq.quantity,
      body.interiorPdfUrl, body.coverPdfUrl,
      s.name || null, s.street1 || null, s.street2 || null, s.city || null, s.stateCode || null,
      s.postcode || null, s.countryCode || null, s.phone || null, quoteReq.shippingLevel,
      quote.totalCost, quote.currency, customerCharge, 'pending', 'pending',
      orderName, campaignName, sourceKind, sourceUserId, sourceUserName
    );
    const orderId = ins.lastInsertRowid;
    const externalId = 'po-' + orderId;

    // 3) CHARGE THE CUSTOMER. This must succeed before we submit to Lulu.
    //    >>> Stripe seam: charge `customerCharge` here; on failure, mark the
    //    order payment_failed and return WITHOUT submitting. <<<
    //    Stubbed for now:
    const paymentStatus = 'stubbed';
    await db.prepare('UPDATE print_orders SET payment_status = ?, external_id = ? WHERE id = ?')
      .run(paymentStatus, externalId, orderId);

    // 4) Submit to the vendor only now that "payment" has cleared.
    try {
      const orderReq = buildOrderRequest(body, built.spec, externalId, contactEmail);
      const placed = await provider.createOrder(orderReq);
      await db.prepare(
        'UPDATE print_orders SET provider_order_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(placed.providerOrderId, placed.status || 'created', orderId);
      return res.json({ orderId, externalId, providerOrderId: placed.providerOrderId, status: placed.status, customerCharge, currency: quote.currency });
    } catch (submitErr) {
      // Paid but the print job didn't go. Flag for refund + retry.
      // >>> Stripe seam: refund `customerCharge` here if payment was real. <<<
      await db.prepare(
        'UPDATE print_orders SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run('order_failed', String(submitErr && submitErr.message || submitErr), orderId);
      return res.status(502).json({ error: 'Print job submission failed after payment; order flagged for refund', orderId });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Order failed', detail: String(e && e.message || e) });
  }
});

// ------------------------------------------------------------
// GET /order/:id  -> the caller's order, status refreshed from the vendor.
// ------------------------------------------------------------
router.get('/order/:id', requireSession, async function (req, res) {
  try {
    const db = await getDb();
    const row = await db.prepare('SELECT * FROM print_orders WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!row || row.user_id !== req.session.userId) return res.status(404).json({ error: 'Not found' });

    if (row.provider_order_id) {
      try {
        const provider = getPrintProvider();
        const live = await provider.getOrderStatus(row.provider_order_id);
        if (live && live.status && live.status !== row.status) {
          await db.prepare(
            'UPDATE print_orders SET status = ?, tracking_url = ?, carrier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(live.status, live.trackingUrl || null, live.carrier || null, row.id);
          row.status = live.status; row.tracking_url = live.trackingUrl || null; row.carrier = live.carrier || null;
        }
      } catch (_e) { /* status refresh is best-effort */ }
    }
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: 'Server error', detail: String(e && e.message || e) });
  }
});

module.exports = router;
