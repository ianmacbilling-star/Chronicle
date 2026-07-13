'use strict';

// ============================================================
// layoutAI.js  -  AI layout-optimization pass (DRY RUN / Phase 0).
// ------------------------------------------------------------
// Fully self-contained + admin + feature-flag gated. Rebuilds the REAL book,
// renders it to PDF, hands the PDF to LAYOUT_MODEL, and returns the model's
// layout SIGNALS as JSON. It LOGS and RETURNS -- it writes NOTHING (no
// layout_meta changes). Pure read-only critique so it cannot affect a book.
//
// Segmentation / rollback:
//   * New file. Mounted with ONE line in server.js (`/api/layout-ai`).
//     Rollback = remove that line (or `git revert` the commit).
//   * Off by default: app setting `layout_ai_dryrun` must be 1, AND the caller
//     must be an admin. Flip the setting to 0 to hide/disable instantly, no deploy.
//   * Nothing else in the app imports this module.
// ============================================================

const express = require('express');
const router = express.Router();
const { PDFDocument } = require('pdf-lib');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getAppSettingInt } = require('../database/db');
const { renderHtmlToPdf } = require('../services/printing/renderPdf');
const { assembleNovelHtml } = require('./pdf');
const { LAYOUT_MODEL } = require('../config/models');
const { buildPrompt } = require('../services/layoutAI/brief');

const FLAG = 'layout_ai_dryrun';       // app_settings int; 1 = feature on
const MAX_PAGES_PER_CALL = 12;         // small chunks so per-page JSON never truncates
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;  // keep each request PDF under the 32MB API cap (base64 inflates ~33%)
const INPUT_COST_PER_TOKEN = 3 / 1e6;     // Sonnet ~ $3 / M input tokens (PDF pages billed as input)
const OUTPUT_COST_PER_TOKEN = 15 / 1e6;   // Sonnet ~ $15 / M output tokens
const CASCADE_PASS = true;   // 2nd (reflow) pass catches gaps that open after the first round; the 'unknown' poll issue is handled client-side by retry
const ANTHROPIC_VERSION = '2023-06-01';

async function isEnabled() {
  // TEMP (staging testing): hard-coded ON so no app_settings row is needed.
  // Admin gate still applies via requireAdmin on the routes below.
  // To restore the runtime flag, replace this body with:
  //   try { return (await getAppSettingInt(FLAG, 0)) === 1; } catch (e) { return false; }
  return true;
}

// GET /api/layout-ai/status -> { enabled, model }. Drives whether the UI shows the tab.
router.get('/status', requireAuth, requireAdmin, async function (req, res) {
  res.json({ enabled: await isEnabled(), model: LAYOUT_MODEL });
});

// Split a PDF into base64 chunks that each stay under the API's request-size limit.
// Full-res panel art can push a whole book well past 32MB, so we chunk by BYTES,
// not just page count. Per-page sizes are summed (which OVERestimates the merged
// chunk, since merged PDFs dedupe shared resources), so the budget errs safe.
async function splitPdf(buf) {
  const src = await PDFDocument.load(buf);
  const total = src.getPageCount();

  const pageBytes = [];
  for (let i = 0; i < total; i++) {
    const one = await PDFDocument.create();
    const cp = await one.copyPages(src, [i]);
    one.addPage(cp[0]);
    pageBytes.push((await one.save()).length);
  }

  const groups = [];
  let start = 0, bytes = 0, count = 0;
  for (let i = 0; i < total; i++) {
    if (count > 0 && (bytes + pageBytes[i] > MAX_CHUNK_BYTES || count >= MAX_PAGES_PER_CALL)) {
      groups.push([start, i]); start = i; bytes = 0; count = 0;
    }
    bytes += pageBytes[i]; count++;
  }
  if (count > 0) groups.push([start, total]);

  const chunks = [];
  for (const g of groups) {
    const out = await PDFDocument.create();
    const idx = [];
    for (let i = g[0]; i < g[1]; i++) idx.push(i);
    const copied = await out.copyPages(src, idx);
    copied.forEach(function (p) { out.addPage(p); });
    const outBytes = await out.save();
    chunks.push({ startPage: g[0] + 1, data: Buffer.from(outBytes).toString('base64') });
  }
  return { total: total, chunks: chunks };
}

// Tolerant JSON: the model sometimes wraps its JSON in a sentence of prose or a code
// fence. Try a direct parse, then fall back to the outermost { ... } span.
function extractJson(text) {
  if (!text) return null;
  var t = String(text).replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  var a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) {} }
  // Truncation salvage: output cut off mid-array. Close it at the last complete object.
  if (a >= 0) {
    var body = t.slice(a);
    var lb = body.lastIndexOf('}');
    var tries = 0;
    while (lb > 0 && tries < 200) {
      var head = body.slice(0, lb + 1);
      try { return JSON.parse(head + ']}'); } catch (e3) {}
      try { return JSON.parse(head + '}'); } catch (e4) {}
      try { return JSON.parse(head); } catch (e5) {}
      lb = body.lastIndexOf('}', lb - 1); tries++;
    }
  }
  return null;
}

async function critiqueChunk(pdfB64, prompt, startPage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const note = startPage > 1
    ? '\n\nIMPORTANT: The attached PDF contains only PART of the book, starting at book page ' + startPage +
      '. The panel MANIFEST above lists ALL panels in the whole book -- use it ONLY to look up the idx of the panels you can SEE in this PDF. Assess ONLY the pages present here, and report page numbers as BOOK pages (this PDF starts at book page ' + startPage + '). Output MUST be pure JSON with no prose before or after.'
    : '';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: LAYOUT_MODEL,
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } },
          { type: 'text', text: prompt + note }
        ]
      }]
    })
  });
  const data = await resp.json();
  if (data && data.error) throw new Error('API: ' + (data.error.message || JSON.stringify(data.error)));
  const text = (data.content || []).map(function (i) { return i.type === 'text' ? i.text : ''; }).filter(Boolean).join('\n');
  const _usage = { input: (data.usage && data.usage.input_tokens) || 0, output: (data.usage && data.usage.output_tokens) || 0 };
  const parsed = extractJson(text);
  if (parsed) { parsed._usage = _usage; return parsed; }
  return { parseError: true, raw: text.slice(0, 500), _usage: _usage };
}

// POST /api/layout-ai/:campaignId/dry-run
// Query params mirror the export (?layout=&co=&bookTitle=&titleColor=&as_user=) so the
// critique targets the exact book the user is viewing. Body may override the brief:
//   { houseRules?: string, styleBrief?: string }
// Returns the model's JSON. Writes nothing.
// Shared: assemble the real book, render to PDF, chunk, critique -> merged result.
// overridesForRender (or null) is applied in-memory during render, so ONE path serves
// both the read-only dry run and the optimize preview (no persistence either way).
async function analyzeBook(req, campaignId, overridesForRender, fills) {
  const built = await assembleNovelHtml(req, campaignId, overridesForRender);
  const pdfBuf = await renderHtmlToPdf(built.html, {});
  const split = await splitPdf(pdfBuf);
  const prompt = buildPrompt(built.layoutStyle, {
    houseRules: req.body && req.body.houseRules,
    styleBrief: req.body && req.body.styleBrief,
    manifest: built.manifest,
    fills: fills
  });
  let pages = [];
  const assessments = [];
  const notes = [];
  var usage = { input: 0, output: 0 };
  for (const ch of split.chunks) {
    const out = await critiqueChunk(ch.data, prompt, ch.startPage);
    if (out && out._usage) { usage.input += out._usage.input; usage.output += out._usage.output; }
    if (out && out.parseError) { notes.push('chunk@' + ch.startPage + ': unparseable model output'); continue; }
    if (out && out.book_assessment) assessments.push(out.book_assessment);
    if (out && Array.isArray(out.pages)) pages = pages.concat(out.pages);
  }
  return { built: built, book_assessment: assessments.join(' '), pages: pages, notes: notes, total_pages: split.total, usage: usage };
}

// Turn the AI's per-panel signals into an in-memory layout_meta override map keyed by
// manifest idx. size_hint drives prominence (grow -> Maximize, shrink -> Minimize),
// otherwise emphasis; focal/crop_safe/group_break pass through when present.
// Bigger images can give up more height. Full-page can shrink up to 40%, half-page 30%, small 20%.
function shrinkFloor(shape) {
  shape = String(shape || '').toLowerCase();
  if (/full|tall|tower/.test(shape)) return 0.60;           // up to 40%
  if (/wide|panoram|square|half/.test(shape)) return 0.70;  // up to 30%
  return 0.80;                                              // up to 20%
}
function buildOverrides(pages, manifest, fills) {
  var byTitle = {};
  var shapeByIdx = {};
  (manifest || []).forEach(function (m) { if (m && m.title) byTitle[String(m.title).trim().toLowerCase()] = m.idx; if (m) shapeByIdx[m.idx] = String(m.shape || '').toLowerCase(); });
  var ov = {};
  (pages || []).forEach(function (pg) {
    var _pageNum = Number(pg.page);
    (pg.panels || []).forEach(function (pn) {
      if (pn == null) return;
      var idx = (pn.idx != null) ? pn.idx : null;
      if (idx == null && pn.label) { var k = String(pn.label).trim().toLowerCase(); if (byTitle[k] != null) idx = byTitle[k]; }
      if (idx == null) return;
      var e = Number(pn.emphasis);
      var base = (e >= 1 && e <= 5) ? Math.round(e) : 3;
      var prom = pn.size_hint === 'grow' ? 5 : (pn.size_hint === 'shrink' ? 1 : base);
      var patch = { prominence: prom };
      if (['center', 'top', 'bottom', 'left', 'right'].indexOf(pn.focal) >= 0) patch.focal = pn.focal;
      if (pn.crop_safe === true || pn.crop_safe === false) patch.crop_safe = pn.crop_safe;
      if (pn.group_break === true || pn.group_break === false) patch.group_break = pn.group_break;
      if (pn.flow === true) patch.flow = true;
      // Measured shrink-to-fit: an image flagged "shrink" tucks into the PRIOR page's
      // gap. The client-measured fill of that prior page sets the amount (capped 50%).
      if (pn.size_hint === 'shrink' && fills && _pageNum >= 2) {
        var _floor = shrinkFloor(shapeByIdx[idx]);
        var _pf = fills[_pageNum - 1];
        if (_pf == null) _pf = fills[String(_pageNum - 1)];
        if (_pf != null) { patch.scale = Math.max(_floor, Math.min(1, 1 - (Number(_pf) / 100))); }
        else { patch.scale = _floor; }
      }
      ov[idx] = patch;
    });
  });
  return ov;
}

// Transient store for optimize overrides (PREVIEW only). Keyed by a short token the
// 'After' iframe fetches back. Pruned after 15 min; nothing is written to the DB.
const _optCache = new Map();
function cachePut(overrides, campaignId) {
  var token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  _optCache.set(token, { overrides: overrides, campaignId: String(campaignId), ts: Date.now() });
  for (const kv of _optCache) { if (Date.now() - kv[1].ts > 15 * 60 * 1000) _optCache.delete(kv[0]); }
  return token;
}

// POST /:campaignId/dry-run  -> read-only analysis, no overrides, writes nothing.
router.post('/:campaignId/dry-run', requireAuth, requireAdmin, async function (req, res) {
  if (!(await isEnabled())) return res.status(403).json({ error: 'Layout AI is disabled.' });
  const t0 = Date.now();
  try {
    const a = await analyzeBook(req, req.params.campaignId, null);
    const result = {
      dry_run: true, campaign: a.built.campaign.name, layout: a.built.layoutStyle, model: LAYOUT_MODEL,
      settings: { layout: a.built.layoutStyle, co: a.built.co || null, panels: (a.built.manifest || []).length },
      total_pages: a.total_pages, pages_flagged: a.pages.length, book_assessment: a.book_assessment,
      pages: a.pages, notes: a.notes, ms: Date.now() - t0
    };
    console.log('[layout-ai dry-run]', result.campaign, '|', result.layout, '|', result.total_pages + 'pp', '| flagged=' + result.pages_flagged, '| ' + result.ms + 'ms');
    res.json(result);
  } catch (e) {
    console.error('[layout-ai dry-run] error:', e && e.message);
    res.status((e && e.status === 403) ? 403 : 500).json({ error: (e && e.message) || 'dry-run failed', dry_run: true });
  }
});

// ---- Async optimize: a whole-book render + vision analysis takes longer than the edge
// proxy's request timeout ("upstream error"), so we run it as a BACKGROUND job and let the
// client poll. Jobs are in-memory (like the override cache) and pruned after 30 min.
// Nothing is persisted to the DB.
const _optJobs = new Map();
function jobNew() {
  var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  _optJobs.set(id, { status: 'running', ts: Date.now() });
  for (const kv of _optJobs) { if (Date.now() - kv[1].ts > 30 * 60 * 1000) _optJobs.delete(kv[0]); }
  return id;
}

// POST /:campaignId/optimize  -> start a background job, return its id immediately.
router.post('/:campaignId/optimize', requireAuth, requireAdmin, async function (req, res) {
  if (!(await isEnabled())) return res.status(403).json({ error: 'Layout AI is disabled.' });
  const jobId = jobNew();
  const campaignId = req.params.campaignId;
  const _fills = (req.body && req.body.fills) || null;   // client-measured per-page fill, for shrink-to-fit
  res.json({ job: jobId, status: 'running' });   // return immediately -- no proxy timeout
  // Heavy work runs in the background (not awaited); the client polls optimize-status.
  (async function () {
    const t0 = Date.now();
    try {
      // Pass 1: analyze the original book and build the first round of overrides.
      const a1 = await analyzeBook(req, campaignId, null, _fills);
      var overrides = buildOverrides(a1.pages, a1.built.manifest, _fills);
      var usage = a1.usage || { input: 0, output: 0 };
      var passes = 1;
      // Pass 2 (cascade): if pass 1 changed the layout, re-analyze the REFLOWED book so
      // gaps that only appear AFTER the first round get caught (the page-49 case). Pass 2
      // saw the reflowed state, so its signals win on any panel it also touches.
      if (CASCADE_PASS && Object.keys(overrides).length > 0) {
        try {
          const a2 = await analyzeBook(req, campaignId, overrides, _fills);
          const overrides2 = buildOverrides(a2.pages, a2.built.manifest, _fills);
          overrides = Object.assign({}, overrides, overrides2);
          if (a2.usage) { usage = { input: usage.input + a2.usage.input, output: usage.output + a2.usage.output }; }
          passes = 2;
        } catch (e2) { console.error('[layout-ai] cascade pass 2 failed, using pass 1:', e2 && e2.message); }
      }
      const token = cachePut(overrides, campaignId);
      const cost = usage.input * INPUT_COST_PER_TOKEN + usage.output * OUTPUT_COST_PER_TOKEN;
      console.log('[layout-ai optimize]', a1.built.campaign.name, '|', a1.built.layoutStyle, '| overrides=' + Object.keys(overrides).length, '| passes=' + passes, '| tok in/out=' + usage.input + '/' + usage.output, '| $' + cost.toFixed(4), '| ' + (Date.now() - t0) + 'ms');
      _optJobs.set(jobId, { status: 'done', ts: Date.now(), result: {
        dry_run: false, token: token, campaign: a1.built.campaign.name, layout: a1.built.layoutStyle, model: LAYOUT_MODEL,
        settings: { layout: a1.built.layoutStyle, co: a1.built.co || null, panels: (a1.built.manifest || []).length },
        total_pages: a1.total_pages, pages_flagged: a1.pages.length, applied: Object.keys(overrides).length,
        book_assessment: a1.book_assessment, pages: a1.pages, notes: a1.notes,
        usage: usage, cost_usd: Math.round(cost * 10000) / 10000, passes: passes, ms: Date.now() - t0
      } });
    } catch (e) {
      console.error('[layout-ai optimize] error:', e && e.message);
      _optJobs.set(jobId, { status: 'error', ts: Date.now(), error: (e && e.message) || 'optimize failed' });
    }
  })();
});

// GET /:campaignId/optimize-status/:job  -> poll the background job.
router.get('/:campaignId/optimize-status/:job', requireAuth, requireAdmin, function (req, res) {
  const job = _optJobs.get(req.params.job);
  if (!job) return res.json({ status: 'unknown' });
  if (job.status === 'done') return res.json(Object.assign({ status: 'done' }, job.result));
  if (job.status === 'error') return res.json({ status: 'error', error: job.error });
  res.json({ status: 'running' });
});

// GET /:campaignId/optimized/:token  -> re-render the WHOLE book with the cached overrides
// applied in-memory, streamed as a PDF for the 'After' pane. Persists nothing.
router.get('/:campaignId/optimized/:token', requireAuth, requireAdmin, async function (req, res) {
  try {
    const cached = _optCache.get(req.params.token);
    if (!cached || cached.campaignId !== String(req.params.campaignId)) return res.status(404).send('Optimize preview expired -- run Optimize again.');
    const built = await assembleNovelHtml(req, req.params.campaignId, cached.overrides);
    const pdfBuf = await renderHtmlToPdf(built.html, {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="optimized-preview.pdf"');
    res.send(Buffer.from(pdfBuf));
  } catch (e) {
    console.error('[layout-ai optimized] error:', e && e.message);
    res.status(500).send('Render failed: ' + ((e && e.message) || 'error'));
  }
});

module.exports = router;
