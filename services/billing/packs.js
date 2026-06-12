// Authoritative token-pack catalog (server-side source of truth). The client
// renders its own copy for display, but checkout NEVER trusts client prices --
// the amount charged and the tokens granted are always read from here by id.
// TODO(pricing): confirm final pack sizes/prices before go-live, and keep these
// in sync with TOKEN_PACKS in public/js/app.js.
const PACKS = {
  small:  { id: 'small',  name: 'Small',  tokens: 85,   price_cents: 1500 },
  medium: { id: 'medium', name: 'Medium', tokens: 250,  price_cents: 4000 },
  large:  { id: 'large',  name: 'Large',  tokens: 650,  price_cents: 10000 },
  huge:   { id: 'huge',   name: 'Huge',   tokens: 1700, price_cents: 25000 }
};

function getPack(id) {
  return (id && Object.prototype.hasOwnProperty.call(PACKS, id)) ? PACKS[id] : null;
}

function listPacks() {
  return Object.keys(PACKS).map(function (k) { return PACKS[k]; });
}

module.exports = { PACKS, getPack, listPacks };
