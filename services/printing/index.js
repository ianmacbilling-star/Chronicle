'use strict';

const { PrintProvider } = require('./PrintProvider');
const { LuluProvider } = require('./luluProvider');

/**
 * Provider registry. Add a new vendor here (and a new adapter file) to make
 * it selectable; nothing else in the app changes because everyone codes
 * against the PrintProvider contract.
 */
const PROVIDERS = {
  lulu: LuluProvider,
};

let _instance = null;

/**
 * Return the configured print provider (singleton).
 * Selected by env PRINT_PROVIDER (default 'lulu').
 * @param {Object} [config] optional per-call overrides for the adapter
 * @returns {PrintProvider}
 */
function getPrintProvider(config) {
  if (_instance && !config) return _instance;
  const key = String(process.env.PRINT_PROVIDER || 'lulu').toLowerCase();
  const Ctor = PROVIDERS[key];
  if (!Ctor) {
    throw new Error(`Unknown PRINT_PROVIDER '${key}'. Known: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const inst = new Ctor(config || {});
  if (!config) _instance = inst;
  return inst;
}

module.exports = { getPrintProvider, PrintProvider, PROVIDERS };
