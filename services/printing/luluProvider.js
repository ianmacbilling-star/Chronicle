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
// CW = casewrap hardcover. PB and CW are sandbox-confirmed for 8.5x11 FC.
// SS is not yet confirmed (saddle needs a <=48pp book to quote); confirm it
// the first time a short-enough book is ordered.
const BIND_CODE = { paperback: 'PB', saddle: 'SS', hardcover: 'CW' };

// 60# uncoated white. Sandbox-confirmed for 8.5x11 paperback (standard AND
// premium color) and for casewrap hardcover premium. Re-confirm if a new
// trim/paper is added.
const PAPER_CODE = '060UW444';
// 60# uncoated cream. Lulu's SKU spec shows FC+cream is valid (060UC444);
// SANDBOX-CONFIRM a cream quote before the first real cream order.
const PAPER_CODE_CREAM = '060UC444';
// v3.0.783 -- TD-579. NO CONFIRMED CREAM SKU EXISTS, SO THERE IS NO CREAM SKU.
// Every other product in this file is a string that produced a real quote. The cream one was
// the white one with four characters changed, which is a BELIEF, and it failed on first real
// use -- the quote could not be priced at all. Add a verified entry here, keyed exactly like
// SKU_OVERRIDES, and set available:true on cream in catalog.js; both are needed and neither
// alone does anything.
// v3.0.784 -- TD-585. Cream is a paper-code swap again, and this time only where the product
// exists. v3.0.783 removed the swap because it was being applied to a FULL COLOUR SKU, which
// Lulu rejects; the same swap on a BW SKU is Lulu's ordinary novel stock. The guard below is
// what makes the difference, and it is an assertion about the vendor's catalogue, not a
// preference -- so it throws rather than quietly substituting white.

// Confirmed SKUs win over the parametric builder so a future code change
// can't silently break a known-good product. All entries below are
// sandbox-confirmed (8.5x11 full color); keyed by `${binding}:${quality}:${coverFinish}`.
// v3.0.376 -- LULU IS MIGRATING pod_package_id TO A DOTTED FORMAT.
//   0850X1100FCPRECW060UW444MXX  ->  0850X1100.FC.PRE.CW.060UW444.MXX
// Dotted went live 2026-03-31, the API accepts BOTH, and legacy 27-character
// support ends 2027-02-01. Only the string changes -- same endpoints, same auth,
// same payloads.
//
// The confirmed SKUs below are deliberately kept in LEGACY form and converted at
// the boundary. They are the only values known to produce a real quote; retyping
// them as dotted would replace confirmed constants with believed-equivalent ones,
// and the failure mode is a 400 at order time. Converting instead keeps the
// confirmed strings as documentation and puts the risk in one testable function.
//
// Field widths are fixed: Trim 9, Ink 2, Quality 3, Binding 2, Paper 8, Finish 3.
// Anything that is not exactly 27 characters, or already dotted, is passed through
// untouched -- a SKU we do not recognise is not one to start reformatting.
const SKU_DOTTED = String(process.env.LULU_SKU_DOTTED || 'true').toLowerCase() !== 'false';
function toDottedSku(sku) {
  var s = String(sku || '');
  if (!s || s.indexOf('.') >= 0 || s.length !== 27) return s;
  return [s.slice(0, 9), s.slice(9, 11), s.slice(11, 14), s.slice(14, 16), s.slice(16, 24), s.slice(24, 27)].join('.');
}

// v3.0.784 -- TD-585. THE KEY GAINS THE INK, because quality alone no longer identifies a
// product: 'paperback:premium:matte' was unambiguous when every book was full colour and now
// describes two different SKUs. Rekeyed rather than extended, so an old key cannot match a new
// product by accident -- a stale two-part key now simply misses and falls through to the
// parametric builder instead of silently returning the colour SKU for a BW order.
// The four strings themselves are UNCHANGED and still the sandbox-confirmed ones.
const SKU_OVERRIDES = {
  'paperback:color:standard:gloss': '0850X1100FCSTDPB060UW444GXX', // $7.01 print
  'paperback:color:standard:matte': '0850X1100FCSTDPB060UW444MXX', // $7.01 print
  'paperback:color:premium:matte':  '0850X1100FCPREPB060UW444MXX', // $18.97 print
  'hardcover:color:premium:matte':  '0850X1100FCPRECW060UW444MXX', // $28.57 print
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
    // v3.0.784 -- TD-585. ink joins the key. See SKU_OVERRIDES above.
    const inkKey = spec.ink === 'bw' ? 'bw' : 'color';
    const overrideKey = `${spec.binding}:${inkKey}:${spec.quality === 'premium' ? 'premium' : 'standard'}:${finishKey}`;
    let sku = SKU_OVERRIDES[overrideKey];
    if (!sku) {
      const bind = BIND_CODE[spec.binding];
      if (!bind) throw new Error('lulu: unsupported binding ' + spec.binding);
      const trim = `${pad4(spec.trimWidthIn)}X${pad4(spec.trimHeightIn)}`; // e.g. 0850X1100
      const color = spec.ink === 'color' ? 'FC' : 'BW';
      const finish = spec.coverFinish === 'matte' ? 'M' : 'G';
      // Trailing Linen/Foil = 'XX' (none).
      sku = `${trim}${color}${quality}${bind}${PAPER_CODE}${finish}XX`;
    }
    // v3.0.783 -- TD-579. A CONFIRMED CREAM SKU, OR NOTHING.
    // This used to swap the paper code on the resolved white SKU and hope. It produced a string
    // Lulu rejects, and the rejection surfaced as "could not get a price" with nothing naming
    // the cause. Throwing here names it, and it is unreachable in normal use because catalog.js
    // refuses cream before this is called -- which is the point: the picker, buildSpec and the
    // SKU builder all say the same thing, so no one of them can be the only guard.
    if (spec.paper === 'cream') {
      // Cream exists as BW novel stock. On a full-colour SKU it is the combination that failed
      // on 2026-08-24, so it is refused here as well as in the catalog -- the picker, buildSpec
      // and the SKU builder all say the same thing, and no one of them is the only guard.
      if (inkKey !== 'bw') {
        throw new Error('lulu: cream paper is only available for black and white interiors (asked for ' +
          overrideKey + '). Nothing was sent to the printer.');
      }
      sku = sku.replace(PAPER_CODE, PAPER_CODE_CREAM);
    }
    // Convert LAST: the cream swap above matches the legacy run, and the paper code
    // also sits whole between two dots, so either order works -- but converting last
    // keeps every constant in this file in the one form that is sandbox-confirmed.
    return SKU_DOTTED ? toDottedSku(sku) : sku;
  }

  // v3.0.781 -- TD-575. THE FIELD NAMES WERE NOT LULU FIELD NAMES.
  //
  // This sent cover_source_url and interior_source_url. Those are not fields in the Lulu
  // Print API. They were ignored as unknown, the fields Lulu DOES require arrived empty,
  // and the first real live order came back:
  //     400 {"interior":["This field may not be null."],"cover":["This field may not be null."]}
  //
  // Read that error literally, the way TD-434 says to: it names interior and cover, which
  // are exactly the two fields we never sent. It names NOTHING ELSE -- so the address, the
  // phone, the shipping level, the SKU, the quantity and the contact email all passed
  // validation. One fault, not a broken order path.
  //
  // Lulu openapi_public.yml, line item schema: cover and interior are each either an object
  // with a required source_url, or a bare URL string, and "if used together it can replace
  // printable_normalization". The nested printable_normalization form is equivalent. The
  // shorthand is used here because the 400 above is DIRECT EVIDENCE that the line-item
  // serializer carries fields by these names -- evidence beats picking the prettier shape.
  //
  // The object form rather than the bare string, because it leaves room for source_md5_sum,
  // which is how a half-uploaded PDF would be caught rather than printed.
  //
  // WHERE THE WRONG SHAPE CAME FROM, so it is not repeated: cover_source_url and
  // interior_source_url are the keys a third-party Python client uses for ITS OWN input dict,
  // which it then converts before posting. The shape was copied from a client library rather
  // than from the vendor. The header of this file has always said these calls were written
  // against documented shapes and never exercised live; the quote endpoint has since been
  // exercised, and this one had not been until 2026-08-24.
  _lineItem(req) {
    return {
      external_id: req.externalId,
      title: req.title,
      cover: { source_url: req.coverPdfUrl },
      interior: { source_url: req.interiorPdfUrl },
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
    // v3.0.784 -- TD-585. A quote is where a wrong product code shows up first, and it is the
    // cheapest place to learn it: no money has moved and no job exists. _skuError names the SKU
    // that was refused, which on 2026-08-24 was the single missing fact.
    let raw;
    try {
      raw = await this._fetch('/print-job-cost-calculations/', {
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
    } catch (err) {
      throw this._skuError(err, req.spec);
    }
    // v3.0.425 -- CARRY THE TAX, DO NOT JUST SWALLOW IT.
    // These were the incl-tax figures only, so tax sat inside the price and was invisible: nothing
    // logged it, nothing stored it, and the print markup was being applied on top of it. Lulu computes
    // tax from the shipping address, and a real Lulu invoice shows it as roughly 8 percent of the WHOLE
    // order -- items AND shipping -- which is larger than the print markup itself. Getting this wrong
    // is the difference between a margin and a loss on every book sold.
    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const li = raw.line_item_costs?.[0] || {};
    const sh = raw.shipping_cost || {};
    const printIncl = n(li.total_cost_incl_tax || raw.total_cost_incl_tax);
    const shipIncl = n(sh.total_cost_incl_tax);
    // Fall back to the incl figure when the excl one is absent, so a response carrying only one of
    // them is read as tax-free rather than as free.
    const printExcl = n(li.total_cost_excl_tax) || printIncl;
    const shipExcl = n(sh.total_cost_excl_tax) || shipIncl;
    const totalIncl = n(raw.total_cost_incl_tax) || (printIncl + shipIncl);
    const totalExcl = n(raw.total_cost_excl_tax) || (printExcl + shipExcl);
    // total_tax when Lulu reports it; otherwise the difference, which is the same number.
    const tax = raw.total_tax != null ? n(raw.total_tax) : Math.round((totalIncl - totalExcl) * 100) / 100;
    return {
      printCost: printIncl,          // unchanged meaning, so nothing already reading this shifts
      shippingCost: shipIncl,
      printCostExclTax: printExcl,
      shippingCostExclTax: shipExcl,
      taxCost: Math.max(0, Math.round(tax * 100) / 100),
      totalCost: Number(totalIncl || printIncl + shipIncl),
      totalCostExclTax: totalExcl,
      currency: raw.currency || 'USD',
      raw,
    };
  }

  // Full-wrap cover dimensions (back + spine + front, including bleed) for a
  // spec + interior page count. Lulu derives the spine width from page count +
  // paper, and the casewrap allowance for hardcover. Normalized to inches.
  // v3.0.429 -- THE v3.0.376 NOTE BELOW WAS TWO-THIRDS WRONG, AND IT COST A FORTNIGHT.
  // It was written to Lulu's DOCUMENTED shape and never confirmed against a live call -- the note
  // said so itself, and nobody did it. The path change was right; the other two broke the request:
  //   path   '/print-job-cover-dimensions/'  ->  '/cover-dimensions/'   CORRECT
  //   field  interior_page_count             ->  page_count            WRONG, reverted in .429
  //   unit   'in'                            ->  'IN'                  WRONG, reverted in .429
  // So this call 404d before .376 and 400d after it, and has NEVER returned a real dimension. The
  // one-shot success log in resolveCoverDims is the proof: it has never fired. Do not change a field
  // on this request again without a [cover-dims] success line to show for it.
  // v3.0.376 -- THREE THINGS WERE WRONG AND NOTHING CALLED IT.
  // Meanwhile computeCoverDims in routes/pdf.js kept guessing the geometry, and the
  // guess was wrong: Lulu wants 19.00 x 12.75in for a 64-page 8.5x11 casewrap and we
  // produced 18.78 x 12.50, so every hardcover order was rejected on dimensions.
  //
  // DO NOT TRUST THE UNIT FIELD. Lulu's own prose says the endpoint returns 'print
  // points by default'; the IN/MM/PT parameter is documented by a client library, not
  // by Lulu's schema. So the answer is normalised by MAGNITUDE instead: a book cover
  // is 8-40 inches, 200-1000 millimetres or 600-3000 points, and those ranges do not
  // overlap. That is correct whether the unit parameter is honoured, ignored, or
  // named something else entirely.
  // v3.0.784 -- TD-585. A REJECTED SKU MUST SAY WHICH SKU.
  // The BW products are built parametrically and have never been confirmed against a live quote.
  // When the cream order failed on 2026-08-24 the message named no product, and working out that
  // the SKU was even involved took the rest of the session. Wrapping the two calls that carry a
  // pod_package_id means a bad code identifies itself in the first line of the error, and the fix
  // is one confirmed string in SKU_OVERRIDES rather than an investigation.
  _skuError(err, spec) {
    var sku = '(unknown)';
    try { sku = this._packageId(spec); } catch (e) { sku = '(could not be built: ' + ((e && e.message) || e) + ')'; }
    var msg = (err && err.message) || String(err);
    if (msg.indexOf('pod_package_id') !== -1 || /\b400\b/.test(msg)) {
      var e2 = new Error('lulu: the product code was not accepted -- pod_package_id ' + sku + '. ' + msg);
      e2.podPackageId = sku;
      return e2;
    }
    return err;
  }

  async getCoverDimensions(spec, pageCount) {
    const sku = this._packageId(spec);
    const raw = await this._fetch('/cover-dimensions/', {
      method: 'POST',
      // v3.0.429 -- WHAT LULU ACTUALLY ASKS FOR. This call has NEVER succeeded: before v3.0.376 the
      // path was wrong (404), and v3.0.376 fixed the path while changing two fields that were right
      // into two that are rejected (400). Lulu names both in its own error:
      //     {"interior_page_count":["This field is required."],"unit":["\"IN\" is not a valid choice."]}
      // Every cover shipped so far was sized by the LOCAL ESTIMATE, and the fallback warning went to
      // the server log only, so nothing surfaced it. interior_page_count is sent alongside page_count
      // rather than instead of it: an unrecognised field is ignored, a missing required one is a 400.
      // v3.0.430 -- NO unit FIELD AT ALL.
      // .429 got interior_page_count accepted; unit was the last complaint, and Lulu has now rejected
      // BOTH 'IN' and 'in' without ever saying what it does want. Guessing a third string is how the
      // last two versions were spent. Read the first error again instead: it called
      // interior_page_count REQUIRED and unit merely an invalid CHOICE -- so unit is optional, and
      // Lulu prose says the endpoint returns print points by default. Omit it and let the magnitude
      // normalisation below do its job. That normalisation was written for precisely this and is
      // correct whether the answer arrives in points, millimetres or inches.
      body: {
        pod_package_id: sku,
        interior_page_count: pageCount,
        page_count: pageCount,
      },
    });
    let w = Number(raw.width != null ? raw.width : raw.width_in);
    let h = Number(raw.height != null ? raw.height : raw.height_in);
    if (!(w > 0 && h > 0)) throw new Error('lulu: cover-dimensions returned no usable width/height: ' + JSON.stringify(raw).slice(0, 300));
    // Normalise by magnitude, largest unit first.
    let unitSeen = 'in';
    if (w > 200) { w = w / 72; h = h / 72; unitSeen = 'pt'; }
    else if (w > 100) { w = w / 25.4; h = h / 25.4; unitSeen = 'mm'; }
    // A cover is wider than it is tall and never smaller than its trim.
    if (!(w >= 8 && w <= 40 && h >= 8 && h <= 20 && w > h)) {
      throw new Error('lulu: cover-dimensions out of plausible range (' + w.toFixed(3) + ' x ' + h.toFixed(3) + 'in from ' + unitSeen + ')');
    }
    return { widthIn: w, heightIn: h, sku, unitSeen, raw };
  }

  // v3.0.376 -- Lulu will tell us whether a cover PDF passes BEFORE an order is
  // placed: the same check Ian has been running by hand in the manual order flow.
  // Returns the validation record; poll getCoverValidation for the final status.
  async validateCover(spec, pageCount, coverUrl) {
    return this._fetch('/validate-cover/', {
      method: 'POST',
      // v3.0.429 -- same field as cover-dimensions, for the same reason. This check has probably
      // never run either.
      body: { pod_package_id: this._packageId(spec), interior_page_count: pageCount, page_count: pageCount, source_url: coverUrl },
    });
  }
  async getCoverValidation(id) {
    return this._fetch('/validate-cover/' + encodeURIComponent(id) + '/');
  }

  async createOrder(req) {
    // v3.0.781 -- TD-575. DO NOT ASK LULU WHETHER WE FORGOT THE FILES.
    // buildOrderRequest and buildOrderRequestFromRow both coalesce a missing url to an EMPTY
    // STRING, so an order with no files reaches here looking well formed and comes back as a
    // vendor 400 -- which is how a local omission gets reported as a printer problem, and the
    // reorder dialog then tells the reader their FILES were rejected when nothing was sent.
    // Checked here rather than at the route, because this is the last place before the wire
    // and both callers pass through it.
    const _missing = [];
    if (!(typeof req.interiorPdfUrl === 'string' && /^https?:\/\//i.test(req.interiorPdfUrl))) _missing.push('interior');
    if (!(typeof req.coverPdfUrl === 'string' && /^https?:\/\//i.test(req.coverPdfUrl))) _missing.push('cover');
    if (_missing.length) {
      throw new Error('lulu: refusing to submit -- no usable ' + _missing.join(' or ') +
        ' file URL on this order. Nothing was sent to the printer, so this is not a problem with the PDF itself.');
    }
    let raw;
    try {
      raw = await this._fetch('/print-jobs/', {
      method: 'POST',
      body: {
        external_id: req.externalId,
        contact_email: req.contactEmail,
        line_items: [this._lineItem(req)],
        shipping_address: this._address(req.shipTo),
        shipping_level: this._shippingLevel(req.shippingLevel),
        // v3.0.782 -- TD-578. HOW LONG BEFORE THIS BECOMES A REAL BOOK.
        // Lulu holds a new job for production_delay minutes and only then sends it to print and
        // charges the card on file. We never sent the field, so every job took Lulu default of
        // 60 minutes -- fine for a customer, tight for anyone testing against the live endpoint,
        // where a mistake is a printed book and a charge within the hour.
        // Env-driven and OMITTED when unset, so the default behaviour is unchanged: set
        // LULU_PRODUCTION_DELAY_MIN while testing, remove it after. Clamped to Lulu documented
        // 60..2880 rather than trusted, because an out-of-range value is a 400 at the worst
        // possible moment.
        ...(function () {
          var raw = process.env.LULU_PRODUCTION_DELAY_MIN;
          if (raw == null || String(raw).trim() === '') return {};
          var n = parseInt(String(raw).trim(), 10);
          if (!Number.isFinite(n)) return {};
          return { production_delay: Math.max(60, Math.min(2880, n)) };
        })(),
      },
      });
    } catch (err) {
      // v3.0.784 -- TD-585. Same treatment as the quote. A job POST can refuse a product code the
      // cost endpoint accepted, and this one happens AFTER the customer has paid, so naming the
      // SKU in the error is what turns a support ticket into a one-line fix.
      throw this._skuError(err, req.spec);
    }
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
