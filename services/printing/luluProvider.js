'use strict';

const { PrintProvider } = require('./PrintProvider');

/**
 * Lulu adapter.
 *
 * Auth:    OpenID Connect / OAuth2 client_credentials. POST client_key +
 *          client_secret (Basic auth) to the token endpoint, cache the bearer.
 * Base:    prod    https://api.lulu.com
 *          sandbox https://api.sandbox.lulu.com
 * Token:   <base>/auth/realms/glasstree/protocol/openid-connect/token
 * Calls:   POST /print-job-cost-calculations/   (quote)
 *          POST /print-jobs/                     (create)
 *          GET  /print-jobs/{id}/                (status)
 *          PUT  /print-jobs/{id}/status/         (cancel -> status REJECTED/CANCELED)
 *
 * Env:     LULU_CLIENT_KEY, LULU_CLIENT_SECRET, LULU_USE_SANDBOX ('true'|'false')
 *
 * NOTE: Written against Lulu's documented API shapes but NOT yet exercised
 * against a live endpoint (no network in the build sandbox). Run it against
 * Lulu's SANDBOX first (test cards, jobs never reach production) before prod.
 */

const PROD = {
  api: 'https://api.lulu.com',
  token: 'https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token',
};
const SANDBOX = {
  api: 'https://api.sandbox.lulu.com',
  token: 'https://api.sandbox.lulu.com/auth/realms/glasstree/protocol/openid-connect/token',
};

// Neutral shipping level -> Lulu shipping_level enum.
const SHIPPING = {
  cheapest: 'MAIL',
  standard: 'GROUND',
  expedited: 'EXPEDITED',
  express: 'EXPRESS',
};

// Neutral Lulu status -> our lifecycle. Lulu job states include CREATED,
// UNPAID, PAYMENT_IN_PROGRESS, PRODUCTION_DELAYED, PRODUCTION_READY,
// IN_PRODUCTION, SHIPPED, REJECTED, CANCELED.
const STATUS = {
  CREATED: 'created',
  UNPAID: 'created',
  PAYMENT_IN_PROGRESS: 'accepted',
  PRODUCTION_READY: 'accepted',
  PRODUCTION_DELAYED: 'in_production',
  IN_PRODUCTION: 'in_production',
  SHIPPED: 'shipped',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
};

// --- SKU encoding -------------------------------------------------------
//
// pod_package_id (legacy 27-char) = Trim + Color + Quality + Bind + Paper
//                                   + Finish + Linen + Foil.
//
// Binding codes: PB = perfect-bound paperback, SS = saddle stitch,
// CW = casewrap hardcover. PB/SS are documented; CW is best-effort and
// MUST be confirmed (run a sandbox getQuote -- a 400 means the code/paper
// is wrong; fix the constant or add a SKU_OVERRIDES entry).
const BIND_CODE = { paperback: 'PB', saddle: 'SS', hardcover: 'CW' };

// 60# uncoated white. Confirmed for paperback standard color. VERIFY for
// premium color and for casewrap (color books often want a coated stock).
const PAPER_CODE = '060UW444';

// Confirmed SKUs win over the parametric builder below. Read exact codes
// off Lulu's Pricing Calculator (it prints the pod_package_id per option
// set) or confirm via sandbox quote, then lock them in here keyed by
// `${binding}:${quality}:${coverFinish}`.
const SKU_OVERRIDES = {
  'paperback:standard:gloss': '0850X1100FCSTDPB060UW444GXX', // sandbox-confirmed (8.5x11 FC std PB gloss)
};

class LuluProvider extends PrintProvider {
  constructor(config = {}) {
    super(config);
    const sandbox = config.useSandbox != null
      ? !!config.useSandbox
      : String(process.env.LULU_USE_SANDBOX || '').toLowerCase() === 'true';
    const env = sandbox ? SANDBOX : PROD;
    this.apiBase = config.apiBase || env.api;
    this.tokenUrl = config.tokenUrl || env.token;
    this.clientKey = config.clientKey || process.env.LULU_CLIENT_KEY || '';
    this.clientSecret = config.clientSecret || process.env.LULU_CLIENT_SECRET || '';
    this._token = null;        // cached bearer
    this._tokenExpiresAt = 0;  // epoch ms
  }

  get name() {
    return 'lulu';
  }

  normalizeStatus(vendorStatus) {
    return STATUS[String(vendorStatus || '').toUpperCase()] || 'unknown';
  }

  /**
   * Map our neutral BookSpec to a Lulu pod_package_id.
   *
   * A confirmed SKU in SKU_OVERRIDES (keyed by binding:quality:finish) is
   * used verbatim. Otherwise the SKU is assembled parametrically from the
   * documented component codes -- valid in shape, but the casewrap/premium/
   * paper pieces are best-effort and must be confirmed against a sandbox
   * quote (a 400 means a code is wrong; fix the constant or add an override).
   *
   * Legacy 27-char SKU = Trim + Color + Quality + Bind + Paper + Finish
   *                      + Linen + Foil. Confirmed example:
   *   0600X0900BWSTDPB060UW444MXX = 6x9 B&W standard paperback, matte.
   */
  _packageId(spec) {
    const quality = spec.quality === 'premium' ? 'PRE' : 'STD';
    const finishKey = spec.coverFinish === 'gloss' ? 'gloss' : 'matte';
    const overrideKey = `${spec.binding}:${spec.quality === 'premium' ? 'premium' : 'standard'}:${finishKey}`;
    if (SKU_OVERRIDES[overrideKey]) return SKU_OVERRIDES[overrideKey];

    const bind = BIND_CODE[spec.binding];
    if (!bind) throw new Error('lulu: unsupported binding ' + spec.binding);
    const trim = `${pad4(spec.trimWidthIn)}X${pad4(spec.trimHeightIn)}`; // e.g. 0850X1100
    const color = spec.ink === 'color' ? 'FC' : 'BW';
    const finish = spec.coverFinish === 'matte' ? 'M' : 'G';
    // Trailing Linen/Foil = 'XX' (none).
    return `${trim}${color}${quality}${bind}${PAPER_CODE}${finish}XX`;
  }

  _lineItem(req) {
    return {
      external_id: req.externalId,
      title: req.title,
      cover_source_url: req.coverPdfUrl,
      interior_source_url: req.interiorPdfUrl,
      pod_package_id: this._packageId(req.spec),
      quantity: req.quantity,
    };
  }

  _address(a) {
    return {
      name: a.name,
      street1: a.street1,
      street2: a.street2 || '',
      city: a.city,
      postcode: a.postcode,
      state_code: a.stateCode || '',
      country_code: a.countryCode,
      phone_number: a.phone || '',
    };
  }

  _shippingLevel(neutral) {
    return SHIPPING[neutral || 'standard'] || 'GROUND';
  }

  // --- auth -------------------------------------------------------------

  async _getToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 30000) {
      return this._token;
    }
    if (!this.clientKey || !this.clientSecret) {
      throw new Error('lulu: LULU_CLIENT_KEY / LULU_CLIENT_SECRET not set');
    }
    const basic = Buffer.from(`${this.clientKey}:${this.clientSecret}`).toString('base64');
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`lulu: token request failed (${res.status}): ${await safeText(res)}`);
    }
    const json = await res.json();
    this._token = json.access_token;
    this._tokenExpiresAt = now + (Number(json.expires_in || 3600) * 1000);
    return this._token;
  }

  async _fetch(path, { method = 'GET', body } = {}) {
    const token = await this._getToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`lulu: ${method} ${path} failed (${res.status}): ${await safeText(res)}`);
    }
    return res.json();
  }

  // --- PrintProvider impl ----------------------------------------------

  async getQuote(req) {
    const raw = await this._fetch('/print-job-cost-calculations/', {
      method: 'POST',
      body: {
        line_items: [{
          pod_package_id: this._packageId(req.spec),
          page_count: req.spec.pageCount,
          quantity: req.quantity,
        }],
        shipping_address: this._address(req.shipTo),
        shipping_level: this._shippingLevel(req.shippingLevel),
      },
    });
    const print = Number(raw.line_item_costs?.[0]?.total_cost_incl_tax || raw.total_cost_incl_tax || 0);
    const shipping = Number(raw.shipping_cost?.total_cost_incl_tax || 0);
    return {
      printCost: print,
      shippingCost: shipping,
      totalCost: Number(raw.total_cost_incl_tax || print + shipping),
      currency: raw.currency || 'USD',
      raw,
    };
  }

  async createOrder(req) {
    const raw = await this._fetch('/print-jobs/', {
      method: 'POST',
      body: {
        external_id: req.externalId,
        contact_email: req.contactEmail,
        line_items: [this._lineItem(req)],
        shipping_address: this._address(req.shipTo),
        shipping_level: this._shippingLevel(req.shippingLevel),
      },
    });
    return this._toOrder(raw, req.externalId);
  }

  async getOrderStatus(providerOrderId) {
    const raw = await this._fetch(`/print-jobs/${encodeURIComponent(providerOrderId)}/`);
    return this._toOrder(raw);
  }

  async cancelOrder(providerOrderId) {
    const raw = await this._fetch(`/print-jobs/${encodeURIComponent(providerOrderId)}/status/`, {
      method: 'PUT',
      body: { name: 'CANCELED' },
    });
    return this._toOrder(raw, undefined, providerOrderId);
  }

  _toOrder(raw, externalId, fallbackId) {
    const statusName = raw?.status?.name || raw?.status || '';
    const tracking = firstTracking(raw);
    return {
      providerOrderId: String(raw?.id != null ? raw.id : (fallbackId || '')),
      externalId: externalId || raw?.external_id || '',
      status: this.normalizeStatus(statusName),
      trackingUrl: tracking.url,
      carrier: tracking.carrier,
      raw,
    };
  }
}

// --- helpers ------------------------------------------------------------

function pad4(inches) {
  // 8.5 -> '0850', 11 -> '1100' (hundredths of an inch, 4 digits).
  const hundredths = Math.round(Number(inches) * 100);
  return String(hundredths).padStart(4, '0');
}

function firstTracking(raw) {
  const items = (raw && raw.line_items) || [];
  for (const li of items) {
    const t = li.tracking_urls || li.tracking_url;
    if (Array.isArray(t) && t.length) return { url: t[0], carrier: li.carrier_name };
    if (typeof t === 'string') return { url: t, carrier: li.carrier_name };
  }
  return { url: undefined, carrier: undefined };
}

async function safeText(res) {
  try { return await res.text(); } catch (_e) { return '<no body>'; }
}

module.exports = { LuluProvider };
