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
const MAX_PAGES_PER_CALL = 40;         // secondary page cap (API allows ~100)
const MAX_CHUNK_BYTES = 15 * 1024 * 1024;  // keep each request PDF well under the 32MB API cap (base64 inflates ~33%)
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

async function critiqueChunk(pdfB64, prompt, startPage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const note = startPage > 1
    ? '\n\nNOTE: this is a chunk of a larger book; its first page is book page ' + startPage +
      '. Report every page number as the BOOK page (add ' + (startPage - 1) + ' to the in-chunk index).'
    : '';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: LAYOUT_MODEL,
      max_tokens: 8000,
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
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch (e) { return { parseError: true, raw: text.slice(0, 4000) }; }
}

// POST /api/layout-ai/:campaignId/dry-run
// Query params mirror the export (?layout=&co=&bookTitle=&titleColor=&as_user=) so the
// critique targets the exact book the user is viewing. Body may override the brief:
//   { houseRules?: string, styleBrief?: string }
// Returns the model's JSON. Writes nothing.
router.post('/:campaignId/dry-run', requireAuth, requireAdmin, async function (req, res) {
  if (!(await isEnabled())) {
    return res.status(403).json({ error: 'Layout AI dry-run is disabled. Set app setting layout_ai_dryrun=1 to enable.' });
  }
  const t0 = Date.now();
  try {
    const built = await assembleNovelHtml(req, req.params.campaignId);   // reuses the real export assembly
    const pdfBuf = await renderHtmlToPdf(built.html, {});
    const split = await splitPdf(pdfBuf);
    const prompt = buildPrompt(built.layoutStyle, {
      houseRules: req.body && req.body.houseRules,
      styleBrief: req.body && req.body.styleBrief
    });

    let pages = [];
    const assessments = [];
    const notes = [];
    for (const ch of split.chunks) {
      const out = await critiqueChunk(ch.data, prompt, ch.startPage);
      if (out && out.parseError) { notes.push('chunk@' + ch.startPage + ': unparseable model output'); continue; }
      if (out && out.book_assessment) assessments.push(out.book_assessment);
      if (out && Array.isArray(out.pages)) pages = pages.concat(out.pages);
    }

    const result = {
      dry_run: true,
      campaign: built.campaign.name,
      layout: built.layoutStyle,
      model: LAYOUT_MODEL,
      total_pages: split.total,
      pages_flagged: pages.length,
      book_assessment: assessments.join(' '),
      pages: pages,
      notes: notes,
      ms: Date.now() - t0
    };
    console.log('[layout-ai dry-run]', result.campaign, '|', result.layout, '|', result.total_pages + 'pp',
      '| flagged=' + result.pages_flagged, '| ' + result.ms + 'ms');
    res.json(result);
  } catch (e) {
    console.error('[layout-ai dry-run] error:', e && e.message);
    const code = (e && e.status === 403) ? 403 : 500;
    res.status(code).json({ error: (e && e.message) || 'dry-run failed', dry_run: true });
  }
});

module.exports = router;
