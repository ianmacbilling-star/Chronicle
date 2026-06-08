'use strict';

/**
 * Vendor-neutral print-on-demand abstraction.
 *
 * Every POD vendor (Lulu, Gelato, Prodigi, ...) wants the same four things:
 *   1. A print-ready interior PDF + cover PDF (hosted at a public URL).
 *   2. A product spec (trim / binding / paper / ink / finish).
 *   3. Quantity + shipping destination.
 *   4. ...and hands back an order id, status, tracking, and cost.
 *
 * Concrete adapters (e.g. LuluProvider) translate the neutral shapes below
 * into the vendor's own request bodies and SKUs. Keep ALL vendor-specific
 * details inside the adapter so swapping vendors means writing one new file,
 * not editing the rest of the app.
 *
 * These typedefs are the contract the rest of Campaignia codes against.
 */

/**
 * @typedef {Object} BookSpec
 * @property {number} trimWidthIn   Trim width in inches  (e.g. 8.5)
 * @property {number} trimHeightIn  Trim height in inches (e.g. 11)
 * @property {number} pageCount     Interior page count (even; perfect-bound min applies)
 * @property {'paperback'|'hardcover'|'saddle'} binding
 * @property {'bw'|'color'} ink
 * @property {'standard'|'premium'} quality  Color/print tier (Lulu standard vs premium color)
 * @property {'matte'|'gloss'} coverFinish
 */

/**
 * @typedef {Object} Address
 * @property {string} name
 * @property {string} street1
 * @property {string} [street2]
 * @property {string} city
 * @property {string} postcode
 * @property {string} [stateCode]   Required for US/CA/AU
 * @property {string} countryCode   ISO 3166-1 alpha-2 (e.g. 'US')
 * @property {string} [phone]
 */

/**
 * @typedef {Object} OrderRequest
 * @property {string} externalId      Our own id for this order (idempotency / reconciliation)
 * @property {string} title           Book title (shown on packing slip)
 * @property {string} contactEmail    For shipment notifications
 * @property {string} interiorPdfUrl  Public URL to the print-ready interior PDF
 * @property {string} coverPdfUrl     Public URL to the print-ready one-piece cover PDF
 * @property {BookSpec} spec
 * @property {number} quantity
 * @property {Address} shipTo
 * @property {string} [shippingLevel] Neutral: 'cheapest'|'standard'|'expedited'|'express'
 */

/**
 * @typedef {Object} Quote
 * @property {number} printCost     Per-job print cost (currency units)
 * @property {number} shippingCost
 * @property {number} totalCost
 * @property {string} currency      ISO 4217 (e.g. 'USD')
 * @property {Object} raw           Untouched vendor response, for debugging
 */

/**
 * @typedef {Object} Order
 * @property {string} providerOrderId  Vendor's order/print-job id
 * @property {string} externalId       Echo of our OrderRequest.externalId
 * @property {string} status           Neutral status (see normalizeStatus)
 * @property {string} [trackingUrl]
 * @property {string} [carrier]
 * @property {Object} raw
 */

class PrintProvider {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /** Stable id for this provider, e.g. 'lulu'. */
  get name() {
    return 'abstract';
  }

  /**
   * Price a job without placing it.
   * @param {OrderRequest} _req
   * @returns {Promise<Quote>}
   */
  async getQuote(_req) {
    throw new Error(`${this.name}: getQuote() not implemented`);
  }

  /**
   * Place a print order.
   * @param {OrderRequest} _req
   * @returns {Promise<Order>}
   */
  async createOrder(_req) {
    throw new Error(`${this.name}: createOrder() not implemented`);
  }

  /**
   * Fetch current status for a previously-created order.
   * @param {string} _providerOrderId
   * @returns {Promise<Order>}
   */
  async getOrderStatus(_providerOrderId) {
    throw new Error(`${this.name}: getOrderStatus() not implemented`);
  }

  /**
   * Cancel an order if the vendor still allows it (pre-production only).
   * @param {string} _providerOrderId
   * @returns {Promise<Order>}
   */
  async cancelOrder(_providerOrderId) {
    throw new Error(`${this.name}: cancelOrder() not implemented`);
  }

  /**
   * Map a vendor-specific status string to a neutral lifecycle value so the
   * rest of the app never branches on vendor vocabulary.
   * @param {string} _vendorStatus
   * @returns {'created'|'accepted'|'in_production'|'shipped'|'rejected'|'canceled'|'unknown'}
   */
  normalizeStatus(_vendorStatus) {
    return 'unknown';
  }
}

module.exports = { PrintProvider };
