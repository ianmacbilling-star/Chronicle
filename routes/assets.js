const express = require('express');
const router = express.Router({ mergeParams: true });
const { getDb } = require('../database/db');
const { requireAuth, verifyCampaignDM, verifyCampaignMember, verifyCampaignAssetCreator } = require('../middleware/auth');
const { getEffectiveTier, getTier } = require('../middleware/tiers');
const { uploadFile, deleteFile, restoreCopy, releaseImage } = require('../storage/storage');
const multer = require('multer');
const { imageFileFilter, guardUpload } = require('../middleware/uploadGuard');
const path = require('path');
const imageHelpers = require('./images');
const { getTokenCost, canAfford, recordGeneration } = require('./tokens');
const { HELP_MODEL } = require('../config/models');
const { getBalance } = require('./tokens');   // v3.1.9 -- TD-908 (a second destructure; the line above is untouched)
const { resolveActingFork, requestedForkIdOf } = require('../database/db');
const { getCampaignRole } = require('../middleware/auth');
const assetSuggest = require('../services/assetSuggestions');

// Memory storage — we push to the R2 storage layer ourselves.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter
});
const uploadSingle = upload.single('image');

// Valid asset categories for v1.
const CATEGORIES = ['location', 'npc', 'item'];
function cleanCategory(c) {
  c = String(c || '').toLowerCase().trim();
  return CATEGORIES.indexOf(c) !== -1 ? c : 'location';
}

async function handleAssetUpload(file, oldUrl) {
  if (!file) return null;
  if (oldUrl) {
    try { await deleteFile(oldUrl); } catch (e) { /* non-fatal */ }
  }
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = 'asset-' + Date.now() + ext;
  return await uploadFile(file.buffer, filename, file.mimetype);
}

// GET all assets for a campaign.
router.get('/', requireAuth, verifyCampaignMember, async function(req, res) {
  try {
    const db = await getDb();
    const assets = await db.prepare(
      'SELECT * FROM campaign_assets WHERE campaign_id = ? ORDER BY created_at ASC'
    ).all(req.params.campaignId);
    res.json(assets);
  } catch (e) {
    console.error('list assets error:', e.message);
    res.json({ error: 'Could not load assets.' });
  }
});

// Tier gate: cap assets per campaign by the creating DM's EFFECTIVE tier (max of
// their own tier and the campaign SM's). Returns an error string to send back, or
// null to allow. max_assets === null means unlimited; 0 blocks new assets entirely.
// v3.1.9 -- TD-908. THE CAP IS READ IN ONE PLACE. assetCapBlock kept its exact message and verdict;
// it now asks assetCapInfo, which the suggestions route also asks for "how much room is left".
// cap null = unlimited. A read fault returns cap null, which is what assetCapBlock always did.
async function assetCapInfo(db, userId, campaignId) {
  try {
    const effName = await getEffectiveTier(userId, campaignId);
    const effTier = getTier(effName);
    const cap = effTier ? effTier.max_assets : null;
    if (cap !== null && cap !== undefined) {
      const cnt = await db.prepare('SELECT COUNT(*) AS c FROM campaign_assets WHERE campaign_id = ?').get(campaignId);
      return { cap: cap, used: Number(cnt && cnt.c) || 0, tierName: effTier.name };
    }
  } catch (e) {
    console.error('asset cap check error:', e.message);
  }
  return { cap: null, used: 0, tierName: null };
}
async function assetCapBlock(db, userId, campaignId) {
  const info = await assetCapInfo(db, userId, campaignId);
  if (info.cap !== null && info.used >= info.cap) {
    return 'This campaign has hit its asset limit of ' + info.cap + ' on the ' + info.tierName + ' tier. Upgrade for more.';
  }
  return null;
}

// v3.1.9 -- TD-908. QUEUE ONE GENERATED ASSET: submit to fal, then create the row and its job. Was
// written inline in POST /generate; the suggestions route needs the identical three steps, and two
// copies of a generate path is how this project's twins are born (section 5c). Same order as before:
// the asset row is created only after the submit succeeds, so fal being down leaves no orphan.
async function queueAssetGeneration(db, o) {
  const sub = await imageHelpers.submitAssetReference(o.falKey, o.description, o.category, o.modelKey, o.webhookUrl);
  const now = new Date().toISOString();
  const result = await db.prepare(
    'INSERT INTO campaign_assets (campaign_id, name, category, image_url, description, created_at, created_by) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(o.campaignId, o.name, o.category, null, o.description, now, o.userId);
  const assetId = result.lastInsertRowid;
  const jobIns = await db.prepare(
    'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sub.request_id, o.userId, parseInt(o.campaignId, 10), assetId, 'asset_ref', 'queued', sub.model, o.cost, now, now);
  const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(assetId);
  return { asset: asset, request_id: sub.request_id, image_job_id: jobIns.lastInsertRowid };
}

// POST create a new asset (with image upload).
router.post('/', requireAuth, verifyCampaignAssetCreator, guardUpload(uploadSingle, 'assets'), async function(req, res) {
  const name = (req.body && req.body.name || '').trim();
  const category = cleanCategory(req.body && req.body.category);
  const description = (req.body && req.body.description || '').trim();
  if (!name) return res.json({ error: 'Asset name is required' });

  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });
    let imageUrl = null;
    if (req.file) imageUrl = await handleAssetUpload(req.file, null);
    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_assets (campaign_id, name, category, image_url, description, created_at, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name, category, imageUrl, description, now, req.session.userId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(result.lastInsertRowid);
    res.json(asset);
  } catch (e) {
    console.error('create asset error:', e.message);
    res.json({ error: 'Could not create the asset.' });
  }
});

// ============================================================================
// v3.0.915 -- TD-783. CLASSIFY ASSET NAMES. ONE call for a whole import, and it is FREE.
//
// WHY IT EXISTS: the bulk importer's word test scored 2 of 14 on Ian's first real import. The
// misses were proper nouns (Vallynne, Ythryn), creatures (Aboleth, Manes, Boneclaw, Tabaxi) and
// people's names -- the class a keyword list cannot do at any length.
//
// NO TOKENS ARE SPENT AND NONE ARE QUOTED. Ian: "If we can keep it free to the user I'd really
// like to", then "I'm ok with the minute cost. Make it automatic." So this is the one place in
// the product that calls a model on the house. It is deliberately the cheapest possible shape:
// HELP_MODEL (Haiku), NAMES ONLY -- never the images -- and one request for the whole batch.
//
// IT IS STILL RECORDED. recordGeneration() logs it with tokens_redeemed 0, so a free-but-costly
// call shows up in the same place every other generation does rather than being invisible spend.
//
// IT MAY ANSWER "I DON'T KNOW", AND THAT MATTERS. The prompt asks it to omit rather than guess,
// and anything outside CATEGORIES is dropped below. A name nobody can place reaches the review
// list still flagged -- which is the rule the feature had before a model was involved.
//
// NEVER AN ERROR THE CALLER HAS TO HANDLE. Every failure returns an empty map, and the client
// then behaves exactly as v3.0.914 did: the rows stay unset and a person picks.
// ============================================================================
var CLASSIFY_MAX_NAMES = 50;
var CLASSIFY_MAX_LEN = 120;
var CLASSIFY_SYSTEM =
  'You sort the names of story assets into exactly one of three categories.' +
  ' location = a place, building, room or setting.' +
  ' npc = any living or once-living being: a person, a creature, a monster, an animal.' +
  ' item = a physical object a character could carry, wear, wield or use.' +
  ' Names may be invented, may come from tabletop games, or may be real people.' +
  ' Return ONLY a JSON object whose keys are the input names exactly as given and whose values' +
  ' are one of location, npc, item. OMIT any name you cannot place with reasonable confidence --' +
  ' a missing entry is better than a wrong one. No prose, no code fence, JSON only.';

router.post('/classify-names', requireAuth, verifyCampaignAssetCreator, async function (req, res) {
  try {
    var raw = (req.body && Array.isArray(req.body.names)) ? req.body.names : [];
    var names = [], seen = {};
    raw.forEach(function (n) {
      var v = String(n == null ? '' : n).trim().slice(0, CLASSIFY_MAX_LEN);
      if (!v || seen[v]) return;
      seen[v] = 1;
      if (names.length < CLASSIFY_MAX_NAMES) names.push(v);
    });
    if (!names.length) return res.json({ map: {} });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.json({ map: {} });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HELP_MODEL,
        max_tokens: 1000,
        system: CLASSIFY_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(names) }]
      })
    });
    const data = await response.json();
    if (!data || data.error) return res.json({ map: {} });
    var text = (data.content || []).map(function (b) { return b.text || ''; }).join('').trim();
    var m = text.indexOf('{') >= 0 ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : '';
    var parsed = null;
    try { parsed = JSON.parse(m); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return res.json({ map: {} });

    // ONLY the three categories, and ONLY names we actually asked about. A model that invents a
    // fourth category, or answers about something we did not send, is dropped rather than trusted.
    var out = {};
    names.forEach(function (n) {
      var v = parsed[n];
      if (typeof v !== 'string') return;
      v = v.toLowerCase().trim();
      if (CATEGORIES.indexOf(v) !== -1) out[n] = v;
    });

    try {
      await recordGeneration(req.session.userId, {
        event_type: 'asset_classify_names', tokens_redeemed: 0,
        quantity: names.length, unit: 'names', model: HELP_MODEL,
        related_campaign_id: req.params.campaignId
      });
    } catch (e) {}

    res.json({ map: out });
  } catch (e) {
    console.error('classify asset names error:', e.message);
    res.json({ map: {} });
  }
});

// POST create an asset FROM an existing archived image. The image is copied to
// a fresh R2 object so the asset owns its bytes independently -- asset deletion
// hard-deletes its image, so it must never share the archive's object.
router.post('/from-archive', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });
    const archiveId = req.body && req.body.archive_id;
    const name = (req.body && req.body.name || '').trim();
    const category = cleanCategory(req.body && req.body.category);
    if (!archiveId) return res.json({ error: 'Missing source image.' });
    if (!name) return res.json({ error: 'Asset name is required' });
    const archive = await db.prepare(
      'SELECT * FROM campaign_archives WHERE id = ? AND campaign_id = ?'
    ).get(archiveId, req.params.campaignId);
    if (!archive || !archive.image_url) return res.status(404).json({ error: 'Source image not found.' });

    let imageUrl;
    try {
      imageUrl = await restoreCopy(archive.image_url);
    } catch (e) {
      console.error('copy-to-asset image copy failed:', e.message);
      return res.json({ error: 'Could not copy the image. Please try again.' });
    }

    const now = new Date().toISOString();
    const result = await db.prepare(
      'INSERT INTO campaign_assets (campaign_id, name, category, image_url, created_at, created_by) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.params.campaignId, name, category, imageUrl, now, req.session.userId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(result.lastInsertRowid);
    res.json(asset);
  } catch (e) {
    console.error('copy-to-asset error:', e.message);
    res.json({ error: 'Could not copy this image to Assets.' });
  }
});

// PUT update an asset's name/category, and optionally replace the image.
// POST generate an asset image FROM a text description ("describe it"). Async:
// create the asset row now (image fills in via the fal webhook), queue a
// text-to-image job, and return immediately. The description is stored so the
// asset can later be Regenerated. Costs 1 token, spent on webhook success.
router.post('/generate', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  const name = (req.body && req.body.name || '').trim();
  const category = cleanCategory(req.body && req.body.category);
  const description = (req.body && req.body.description || '').trim();
  if (!name) return res.json({ error: 'Asset name is required' });
  if (!description) return res.json({ error: 'A description is required to generate an image.' });

  try {
    const db = await getDb();
    const capMsg = await assetCapBlock(db, req.session.userId, req.params.campaignId);
    if (capMsg) return res.json({ error: capMsg });

    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });

    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Generating an asset image costs a token. Add more to continue.' });
    }

    // Queue the generation first; only create the asset if the submit succeeds
    // (avoids leaving an image-less orphan asset when fal is unavailable).
    // v3.1.9 -- the three steps now live in queueAssetGeneration, shared with the suggestions route.
    const q = await queueAssetGeneration(db, { falKey: falKey, description: description, category: category, modelKey: modelKey, webhookUrl: webhookUrl,
      campaignId: req.params.campaignId, name: name, userId: req.session.userId, cost: cost });
    res.json({ success: true, queued: true, asset: q.asset, request_id: q.request_id, image_job_id: q.image_job_id });
  } catch (e) {
    console.error('generate asset error:', e.message);
    res.json({ error: 'Could not generate the asset image.' });
  }
});

// =============================================================================================
// v3.1.9 -- TD-908. SUGGESTED ASSETS. Spec: claude/ASSET_SUGGESTIONS_SPEC.md.
//
// Generate Story leaves up to eight suggestions on the version it built (session_forks.
// asset_suggestions). These three routes read them, turn the ticked ones into assets, and record
// a No. Ian: "Do you want Campaignia to generate these for you? It will cost x tokens. Yes or no."
//
// WHO: reading is any member (the list is harmless and a member can see the panels anyway);
// generating goes through verifyCampaignAssetCreator, which is the Story Master, or a member when
// "Allow Members to Add Assets" is on -- Ian's rule, and the rule every other asset route uses.
// WHICH VERSION: resolveActingFork, the one place that answers that. A version that is not yours
// to act on reads as an empty list rather than an error.
// =============================================================================================
async function suggestionFork(db, req, role) {
  const sess = await db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(req.params.sessionId, req.params.campaignId);
  if (!sess) return null;
  return await resolveActingFork(db, sess.id, req.session.userId, role, requestedForkIdOf(req));
}
async function readSuggestions(db, forkId) {
  const row = await db.prepare('SELECT asset_suggestions FROM session_forks WHERE id = ?').get(forkId);
  return assetSuggest.parseStored(row && row.asset_suggestions);
}
async function writeSuggestions(db, forkId, stored) {
  await db.prepare('UPDATE session_forks SET asset_suggestions = ? WHERE id = ?').run(JSON.stringify(stored), forkId);
}
// A created suggestion whose asset has since been deleted is offered again.
function refreshCreated(stored, assets) {
  const live = {};
  (assets || []).forEach(function (a) { live[String(a.id)] = a; });
  stored.items.forEach(function (it) {
    if (it.status === 'created' && (it.asset_id == null || !live[String(it.asset_id)])) { it.status = 'declined'; it.asset_id = null; }
  });
  return stored;
}
function memberMayCreate(campaign, role) {
  if (role === 'dm') return true;
  const v = campaign && campaign.allow_member_assets;
  return v === true || v === 1 || v === 't' || v === 'true';
}
const _suggestBusy = {};   // one accept per version at a time, so a double click cannot create twins

router.get('/suggestions/:sessionId', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    const db = await getDb();
    const role = await getCampaignRole(req.session.userId, req.params.campaignId);
    const forkId = await suggestionFork(db, req, role);
    if (!forkId) return res.json({ items: [], can_create: false });
    const assets = await db.prepare('SELECT id, name, image_url FROM campaign_assets WHERE campaign_id = ?').all(req.params.campaignId);
    const stored = refreshCreated(await readSuggestions(db, forkId), assets);
    const campaign = await db.prepare('SELECT allow_member_assets FROM campaigns WHERE id = ?').get(req.params.campaignId);
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    let balance = null;
    try { balance = (await getBalance(req.session.userId)).total; } catch (e) { balance = null; }
    const cap = await assetCapInfo(db, req.session.userId, req.params.campaignId);
    const imgById = {};
    assets.forEach(function (a) { imgById[String(a.id)] = !!a.image_url; });
    res.json({
      fork_id: forkId,
      items: stored.items.map(function (it) {
        return { key: it.key, name: it.name, aliases: it.aliases || [], category: it.category, description: it.description,
          panels: (it.panels || []).length, mentions: it.mentions || 0, status: it.status, asset_id: it.asset_id,
          asset_ready: it.asset_id != null ? !!imgById[String(it.asset_id)] : false };
      }),
      can_create: memberMayCreate(campaign, role),
      cost_per_asset: cost,
      balance: balance,
      cap: cap.cap, cap_used: cap.used
    });
  } catch (e) {
    console.error('asset suggestions read error:', e.message);
    res.json({ items: [], can_create: false });
  }
});

router.post('/suggestions/:sessionId/decline', requireAuth, verifyCampaignMember, async function (req, res) {
  try {
    const db = await getDb();
    const role = await getCampaignRole(req.session.userId, req.params.campaignId);
    const forkId = await suggestionFork(db, req, role);
    if (!forkId) return res.status(403).json({ error: 'That version is not yours to change.' });
    const stored = await readSuggestions(db, forkId);
    assetSuggest.applyDescriptionEdits(stored, req.body && req.body.descriptions);   // v3.1.12 -- edited in the modal
    stored.items.forEach(function (it) { if (it.status === 'open') it.status = 'declined'; });
    await writeSuggestions(db, forkId, stored);
    res.json({ success: true });
  } catch (e) {
    console.error('asset suggestions decline error:', e.message);
    res.json({ error: 'Could not save that choice.' });
  }
});

router.post('/suggestions/:sessionId/accept', requireAuth, verifyCampaignAssetCreator, async function (req, res) {
  const db = await getDb();
  const forkId = await suggestionFork(db, req, req.campaignRole);
  if (!forkId) return res.status(403).json({ error: 'That version is not yours to change.' });
  if (_suggestBusy[forkId]) return res.json({ error: 'BUSY', message: 'Those assets are already being created.' });
  _suggestBusy[forkId] = 1;
  try {
    const keys = {};
    ((req.body && Array.isArray(req.body.keys)) ? req.body.keys : []).forEach(function (k) { keys[String(k)] = 1; });
    const assetsNow = await db.prepare('SELECT id, name FROM campaign_assets WHERE campaign_id = ?').all(req.params.campaignId);
    const stored = refreshCreated(await readSuggestions(db, forkId), assetsNow);
    // v3.1.12 -- descriptions edited in the modal, applied BEFORE anything is drawn from them.
    assetSuggest.applyDescriptionEdits(stored, req.body && req.body.descriptions);
    // Characters are never built here (Ian: "we won't automatically build characters").
    const chosen = stored.items.filter(function (it) { return it.category !== 'character' && it.status !== 'created' && keys[it.key]; });
    // Unticked is a No for that item: its description goes into the panel prompts instead.
    stored.items.forEach(function (it) { if (it.status === 'open' && it.category !== 'character' && !keys[it.key]) it.status = 'declined'; });
    if (!chosen.length) { await writeSuggestions(db, forkId, stored); return res.json({ success: true, created: [], failed: [] }); }

    // EVERY CHECK BEFORE THE FIRST SUBMIT (Ian: "check the tokens ahead of time"), all or nothing,
    // like Generate Images: a partial set would leave the reader guessing which ones happened.
    const cap = await assetCapInfo(db, req.session.userId, req.params.campaignId);
    if (cap.cap !== null && cap.used + chosen.length > cap.cap) {
      const room = Math.max(0, cap.cap - cap.used);
      return res.json({ error: 'ASSET_LIMIT', room: room, message: 'This campaign has room for ' + room + ' more asset' + (room === 1 ? '' : 's') + ' on the ' + cap.tierName + ' tier. Untick some, or upgrade for more.' });
    }
    const falKey = process.env.FAL_API_KEY;
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    const total = cost * chosen.length;
    if (!(await canAfford(req.session.userId, total))) {
      let bal = null;
      try { bal = (await getBalance(req.session.userId)).total; } catch (e) {}
      return res.json({ error: 'INSUFFICIENT_TOKENS', needed: total, balance: bal,
        message: 'Creating ' + chosen.length + ' asset' + (chosen.length === 1 ? '' : 's') + ' costs ' + total + ' token' + (total === 1 ? '' : 's') + (bal != null ? (', and you have ' + bal) : '') + '. Untick some, or add tokens.' });
    }

    const created = [], failed = [];
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i];
      try {
        const q = await queueAssetGeneration(db, { falKey: falKey, description: it.description || it.name, category: it.category, modelKey: modelKey,
          webhookUrl: webhookUrl, campaignId: req.params.campaignId, name: assetSuggest.assetNameFor(it), userId: req.session.userId, cost: cost });
        it.status = 'created'; it.asset_id = q.asset.id;
        created.push(q.asset);
      } catch (e) {
        console.error('suggested asset submit failed (' + it.key + '):', e.message);
        failed.push(it.name);
      }
    }
    await writeSuggestions(db, forkId, stored);

    // ATTACH. Panels on automatic casting pick the new assets up by name -- the suggestion was only
    // offered because the matcher found it there. A panel whose cast was chosen by hand ignores
    // name-matching, so the asset is added to its explicit list, which is what Ian's "auto attach
    // them to the scenes where they were needed" means for those panels.
    let attached = 0;
    if (created.length) {
      const explicit = await db.prepare('SELECT id, prompt, description, title FROM moments WHERE fork_id = ? AND cast_explicit IS TRUE').all(forkId);
      for (let j = 0; j < explicit.length; j++) {
        const mo = explicit[j];
        const text = ((mo.prompt || '') + ' ' + (mo.description || '') + ' ' + (mo.title || '')).toLowerCase();
        for (let k = 0; k < created.length; k++) {
          if (imageHelpers.assetNameMatches(created[k].name, text)) {
            await db.prepare('INSERT INTO moment_assets (moment_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(mo.id, created[k].id);
            attached++;
          }
        }
      }
    }
    try {
      await recordGeneration(req.session.userId, { event_type: 'asset_suggestions_accept', tokens_redeemed: 0, quantity: created.length,
        unit: 'assets', model: modelKey, related_campaign_id: req.params.campaignId, related_session_id: req.params.sessionId });
    } catch (e) {}
    res.json({ success: true, created: created, failed: failed, attached_explicit: attached, cost_each: cost });
  } catch (e) {
    console.error('asset suggestions accept error:', e.message);
    res.json({ error: 'Could not create those assets.' });
  } finally {
    delete _suggestBusy[forkId];
  }
});

// POST retouch an asset image: apply an instruction to the CURRENT image. Works
// on ANY asset (uploaded, from-archive, or generated). Async; arms one-step
// revert. Costs 1 token, spent on webhook success.
router.post('/:assetId/retouch', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) return res.json({ error: 'Describe the change to make.' });
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.image_url) return res.json({ error: 'This asset has no image to retouch yet.' });
    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Retouching costs a token. Add more to continue.' });
    }
    const sub = await imageHelpers.submitRetouch(asset.image_url, instruction, '', falKey, webhookUrl, null, 'square');
    const now = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), asset.id, 'asset_retouch', 'queued', sub.model, cost, asset.image_url, now, now);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('asset retouch error:', e.message);
    res.json({ error: 'Could not retouch the asset image.' });
  }
});

// POST regenerate an asset image from its stored description (re-roll). Only
// available when the asset has a description. Async; arms one-step revert.
router.post('/:assetId/regenerate', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.description) return res.json({ error: 'This asset has no description to regenerate from.' });
    const falKey = process.env.FAL_API_KEY || (req.body && req.body.fal_key);
    const webhookUrl = imageHelpers.falWebhookUrl();
    if (!falKey || !webhookUrl) return res.json({ error: 'Image generation is not configured.' });
    const modelKey = await imageHelpers.getSelectedModel(db);
    const cost = await getTokenCost(modelKey);
    if (!(await canAfford(req.session.userId, cost))) {
      return res.json({ error: 'INSUFFICIENT_TOKENS', message: 'You are out of tokens. Regenerating costs a token. Add more to continue.' });
    }
    const sub = await imageHelpers.submitAssetReference(falKey, asset.description, asset.category, modelKey, webhookUrl);
    const now = new Date().toISOString();
    const jobIns = await db.prepare(
      'INSERT INTO image_jobs (request_id, user_id, campaign_id, asset_id, kind, status, model, cost, prev_image, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sub.request_id, req.session.userId, parseInt(req.params.campaignId, 10), asset.id, 'asset_ref', 'queued', sub.model, cost, asset.image_url || null, now, now);
    res.status(202).json({ status: 'queued', job_id: jobIns.lastInsertRowid });
  } catch (e) {
    console.error('asset regenerate error:', e.message);
    res.json({ error: 'Could not regenerate the asset image.' });
  }
});

// POST revert an asset image: one-deep undo of the last retouch/regenerate.
// Free (no token spend). Restores the retained prior image, releases the current.
router.post('/:assetId/revert', requireAuth, verifyCampaignAssetCreator, async function(req, res) {
  try {
    const db = await getDb();
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?').get(req.params.assetId, req.params.campaignId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    if (!asset.revert_image_url) return res.json({ error: 'There is no previous image to revert to.' });
    const current = asset.image_url;
    const now = new Date().toISOString();
    await db.prepare('UPDATE campaign_assets SET image_url = ?, revert_image_url = NULL, edited_at = ?, edited_by = ? WHERE id = ?')
      .run(asset.revert_image_url, now, req.session.userId, asset.id);
    if (current && current !== asset.revert_image_url) await releaseImage(db, current);
    res.json({ success: true, image_url: asset.revert_image_url });
  } catch (e) {
    console.error('asset revert error:', e.message);
    res.json({ error: 'Could not revert the asset image.' });
  }
});

router.put('/:assetId', requireAuth, verifyCampaignAssetCreator, guardUpload(uploadSingle, 'assets'), async function(req, res) {
  try {
    const db = await getDb();
    const existing = await db.prepare(
      'SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?'
    ).get(req.params.assetId, req.params.campaignId);
    if (!existing) return res.status(404).json({ error: 'Asset not found' });

    const name = (req.body && req.body.name || '').trim() || existing.name;
    const category = req.body && req.body.category
      ? cleanCategory(req.body.category)
      : existing.category;
    const description = (req.body && typeof req.body.description === 'string') ? req.body.description.trim() : existing.description;
    let imageUrl = existing.image_url;
    if (req.file) imageUrl = await handleAssetUpload(req.file, existing.image_url);

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE campaign_assets SET name = ?, category = ?, image_url = ?, description = ?, edited_at = ?, edited_by = ? ' +
      'WHERE id = ?'
    ).run(name, category, imageUrl, description, now, req.session.userId, req.params.assetId);
    const asset = await db.prepare('SELECT * FROM campaign_assets WHERE id = ?').get(req.params.assetId);
    res.json(asset);
  } catch (e) {
    console.error('update asset error:', e.message);
    res.json({ error: 'Could not update the asset.' });
  }
});

// DELETE an asset (and its image from storage).
router.delete('/:assetId', requireAuth, verifyCampaignDM, async function(req, res) {
  try {
    const db = await getDb();
    const existing = await db.prepare(
      'SELECT * FROM campaign_assets WHERE id = ? AND campaign_id = ?'
    ).get(req.params.assetId, req.params.campaignId);
    if (!existing) return res.status(404).json({ error: 'Asset not found' });

    if (existing.image_url) {
      try { await deleteFile(existing.image_url); } catch (e) { /* non-fatal */ }
    }
    await db.prepare('DELETE FROM campaign_assets WHERE id = ?').run(req.params.assetId);
    res.json({ success: true });
  } catch (e) {
    console.error('delete asset error:', e.message);
    res.json({ error: 'Could not delete the asset.' });
  }
});

module.exports = router;
