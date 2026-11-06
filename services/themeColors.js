'use strict';
// v3.4.60 -- two brands. The brand's theme sheet is the one place its colors live. Pages read it as CSS; the server reads it
// here for anything that cannot use CSS var() -- emails above all (email programs ignore var()). Read once at start-up.
// Each name maps to its value with var() pointers followed, e.g. TC['accent'] = '#c9a84c', TC['accent-rgb'] = '201,168,76'.
// A name that does not exist throws, so a typo shows up at once instead of sending an email with a blank color.
const fs = require('fs'), path = require('path');
function load(file) {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const raw = {}; let m; const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  while ((m = re.exec(css))) if (!(m[1] in raw)) raw[m[1]] = m[2].trim();
  const out = {};
  Object.keys(raw).forEach(function (k) {
    let v = raw[k], n = 0, p;
    while ((p = /^var\(--([\w-]+)\)$/.exec(v)) && n++ < 8) v = raw[p[1]];
    if (v !== undefined) out[k] = v;
  });
  return out;
}
const THEME = load(path.join(__dirname, '..', 'public', 'css', 'themes', 'campaignia.css'));
const PASS = { toJSON: 1, then: 1, inspect: 1, constructor: 1, valueOf: 1, toString: 1 };   // things Node and JSON look up on any object
module.exports = new Proxy(THEME, { get: function (t, k) { if (typeof k !== 'string' || PASS[k] || k in t) return t[k]; throw new Error('themeColors: no color named --' + k); } });
