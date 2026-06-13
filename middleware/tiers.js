// ============================================================
// TIER CONFIGURATION
// Change limits here or via environment variables
// ============================================================

const TIERS = {
  trial: {
    name: 'Free Trial',
    rank: 0,
    price: 0,
    monthly_utlt: 35,        // trial token grant (Platinum-level for now; tunable)
    monthly_cot: 20,
    trial_days: 30,
    max_campaigns: 1,
    max_sessions: 1,         // per campaign -- get them to ONE rendered session (the aha)
    max_characters: 4,       // per campaign (new)
    session_reserve: 8,      // tokens fenced off for sessions (enforced in Part B)
    max_archives_per_campaign: 10,
    max_assets: null,
    moment_algorithm: 'extended',
    max_moments_short: 5,
    max_moments_medium: 8,
    max_moments_long: 12,
    max_moments_epic: 15,
    watermark: true,
    can_export: true,
    can_print: true,
    can_edit_prompts: true,
    description: 'Generous free trial (watermarked); lapses to Copper'
  },
  copper: {
    name: 'Copper',
    rank: 1,
    price: 0,
    monthly_utlt: 0,         // UTOLT: use-it-or-lose-it tokens granted each cycle (expires)
    monthly_cot: 0,          // CO: carry-over tokens granted each cycle (never expires)
    trial_days: 30,
    max_campaigns: 1,
    max_sessions: 5,         // per campaign
    max_archives_per_campaign: 5,
    max_assets: null,
    moment_algorithm: 'standard',
    max_moments_short: 3,    // < 2000 words
    max_moments_medium: 4,   // 2000-5000
    max_moments_long: 5,     // 5000-10000
    max_moments_epic: 6,     // 10000+
    watermark: false,
    can_export: false,
    can_print: false,
    can_edit_prompts: true,
    max_characters: null,
    session_reserve: 0,
    description: '30-day free trial'
  },
  silver: {
    name: 'Silver',
    rank: 2,
    price: 10,
    monthly_utlt: 20,        // UTOLT granted each cycle (expires)
    monthly_cot: 10,         // CO granted each cycle (carries over)
    max_campaigns: 1,
    max_sessions: null,      // unlimited
    max_archives_per_campaign: 10,
    max_assets: null,
    moment_algorithm: 'standard',
    max_moments_short: 3,
    max_moments_medium: 4,
    max_moments_long: 6,
    max_moments_epic: 8,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: true,
    max_characters: null,
    session_reserve: 0,
    description: '1 campaign, unlimited sessions'
  },
  gold: {
    name: 'Gold',
    rank: 3,
    price: 15,
    monthly_utlt: 30,        // UTOLT granted each cycle (expires)
    monthly_cot: 15,         // CO granted each cycle (carries over)
    max_campaigns: 3,
    max_archives_per_campaign: 15,
    max_assets: null,
    max_sessions: null,
    moment_algorithm: 'extended',
    max_moments_short: 5,
    max_moments_medium: 8,
    max_moments_long: 12,
    max_moments_epic: 15,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: true,
    max_characters: null,
    session_reserve: 0,
    description: '3 campaigns, extended moment counts'
  },
  platinum: {
    name: 'Platinum',
    rank: 4,
    price: 22,
    monthly_utlt: 35,        // UTOLT granted each cycle (expires)
    monthly_cot: 20,         // CO granted each cycle (carries over)
    max_campaigns: null,     // unlimited
    max_archives_per_campaign: 20,
    max_assets: null,
    max_sessions: null,
    moment_algorithm: 'extended',
    max_moments_short: 5,
    max_moments_medium: 8,
    max_moments_long: 12,
    max_moments_epic: 15,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: true,
    max_characters: null,
    session_reserve: 0,
    description: 'Unlimited everything + prompt editing'
  }
};

// ============================================================
// DB-BACKED TIER OVERRIDES (admin-editable; code TIERS = fallback).
// A single app_settings row ('tier_config') holds a JSON object of
// per-tier overrides for the whitelisted fields below. Loaded once at
// boot into TIER_OVERRIDES and refreshed on save, so getTier() stays
// synchronous. Missing/empty/corrupt config => code defaults.
// ============================================================
let TIER_OVERRIDES = {};

// Only these fields may be overridden from the admin UI (Phase A). The
// list grows in later phases (styles, startup tokens, SM bonus, ...).
const EDITABLE_TIER_FIELDS = [
  'price',
  'monthly_utlt',
  'monthly_cot',
  'max_campaigns',
  'max_sessions',
  'max_characters',
  'session_reserve',
  'max_archives_per_campaign',
  'max_assets',
  'max_moments_short',
  'max_moments_medium',
  'max_moments_long',
  'max_moments_epic'
];

// Fields where an empty value means "unlimited" (stored as null). Every
// other editable field is a required count: an empty value clears the
// override so the code default applies (never stored as null/NaN).
const NULLABLE_TIER_FIELDS = { max_assets: true, max_campaigns: true, max_sessions: true, max_characters: true };

// Read the tier_config row into the in-memory cache. Call at boot and
// after every save. Never throws -- on any error the cache is left as-is
// (code defaults remain the effective config).
async function loadTierConfig() {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const row = await db.prepare("SELECT value FROM app_settings WHERE setting_key = 'tier_config'").get();
    if (row && row.value) {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') TIER_OVERRIDES = parsed;
    }
  } catch (e) {
    console.error('loadTierConfig failed (using code defaults):', e.message);
  }
  return TIER_OVERRIDES;
}

// A deep copy of the raw overrides (not merged with defaults).
function getTierOverrides() {
  return JSON.parse(JSON.stringify(TIER_OVERRIDES || {}));
}

// Save overrides for ONE tier. Whitelists + coerces values, merges them
// into the cache, persists the whole blob, and returns the tier's merged
// effective config.
async function saveTierConfig(tierName, values) {
  if (!TIERS[tierName]) throw new Error('Unknown tier: ' + tierName);
  const { getDb } = require('../database/db');
  const clean = Object.assign({}, TIER_OVERRIDES[tierName] || {});
  EDITABLE_TIER_FIELDS.forEach(function (f) {
    if (!values || !Object.prototype.hasOwnProperty.call(values, f)) return;
    const raw = values[f];
    const empty = (raw === null || raw === '' || raw === undefined);
    if (empty) {
      if (NULLABLE_TIER_FIELDS[f]) clean[f] = null; else delete clean[f];
      return;
    }
    const n = parseInt(raw, 10);
    if (isNaN(n)) {
      if (NULLABLE_TIER_FIELDS[f]) clean[f] = null; else delete clean[f];
      return;
    }
    if (NULLABLE_TIER_FIELDS[f] && n < 0) { clean[f] = null; return; } // -1 sentinel = unlimited
    clean[f] = n;
  });
  TIER_OVERRIDES[tierName] = clean;
  const db = await getDb();
  const json = JSON.stringify(TIER_OVERRIDES);
  // Upsert via existing-check (matches the image_model pattern in this repo,
  // which avoids the wrapper's RETURNING-id handling on ON CONFLICT).
  const existing = await db.prepare("SELECT setting_key FROM app_settings WHERE setting_key = 'tier_config'").get();
  if (existing) {
    await db.prepare("UPDATE app_settings SET value = ? WHERE setting_key = 'tier_config'").run(json);
  } else {
    await db.prepare("INSERT INTO app_settings (setting_key, value) VALUES ('tier_config', ?)").run(json);
  }
  return getTier(tierName);
}

function getTier(tierName) {
  const base = TIERS[tierName] || TIERS.copper;
  const ov = TIER_OVERRIDES[tierName];
  return ov ? Object.assign({}, base, ov) : base;
}

function getMomentRange(tier, wordCount) {
  const t = getTier(tier);
  if (wordCount < 2000) return t.max_moments_short + '-' + (t.max_moments_short + 1);
  if (wordCount < 5000) return t.max_moments_medium + '-' + (t.max_moments_medium + 1);
  if (wordCount < 10000) return t.max_moments_long + '-' + (t.max_moments_long + 1);
  return t.max_moments_epic + '-' + Math.min(t.max_moments_epic + 2, 15);
}

function isTrialExpired(user) {
  if (!user || user.tier !== 'trial') return false;
  if (!user.trial_started_at) return false;
  const trialDays = getTier('trial').trial_days;
  const started = new Date(user.trial_started_at);
  const expires = new Date(started.getTime() + trialDays * 24 * 60 * 60 * 1000);
  return new Date() > expires;
}

// Lazy trial lapse (no cron): when a trial user's window has elapsed, drop them
// to copper on their next activity. Mutates the in-memory user object AND
// persists, so callers can keep using `user` after this resolves.
async function lapseTrialIfExpired(user, db) {
  try {
    if (user && user.tier === 'trial' && isTrialExpired(user)) {
      await db.prepare('UPDATE users SET tier = ? WHERE id = ?').run('copper', user.id);
      user.tier = 'copper';
      return true;
    }
  } catch (e) { /* non-fatal: keep current tier for this request */ }
  return false;
}

// Middleware to check campaign limit
async function checkCampaignLimit(req, res, next) {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    await lapseTrialIfExpired(user, db);
    const tier = getTier(user.tier);

    // Check campaign limit
    if (tier.max_campaigns !== null) {
      const count = await db.prepare(
        'SELECT COUNT(*) as count FROM campaigns WHERE user_id = ? AND is_active = true'
      ).get(req.session.userId);
      if (count.count >= tier.max_campaigns) {
        return res.status(403).json({
          error: `Your ${tier.name} plan allows ${tier.max_campaigns} active campaign${tier.max_campaigns > 1 ? 's' : ''}. Please upgrade or deactivate an existing campaign.`,
          code: 'CAMPAIGN_LIMIT'
        });
      }
    }

    req.userTier = tier;
    req.user = user;
    next();
  } catch(e) {
    next(e);
  }
}

// Middleware to check session limit
async function checkSessionLimit(req, res, next) {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    await lapseTrialIfExpired(user, db);
    const tier = getTier(user.tier);

    if (tier.max_sessions !== null) {
      const count = await db.prepare(
        'SELECT COUNT(*) as count FROM sessions WHERE campaign_id = ?'
      ).get(req.params.campaignId);
      if (count.count >= tier.max_sessions) {
        return res.status(403).json({
          error: `Your ${tier.name} plan allows ${tier.max_sessions} sessions per campaign. Please upgrade for unlimited sessions.`,
          code: 'SESSION_LIMIT'
        });
      }
    }

    req.userTier = tier;
    req.user = user;
    next();
  } catch(e) {
    next(e);
  }
}

// Middleware: per-campaign character cap (mainly the free trial). Unlimited when
// the tier max_characters is null/negative. Mirrors checkSessionLimit.
async function checkCharacterLimit(req, res, next) {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    await lapseTrialIfExpired(user, db);
    const tier = getTier(user.tier);
    if (tier.max_characters !== null && tier.max_characters !== undefined && tier.max_characters >= 0) {
      const row = await db.prepare('SELECT COUNT(*) as count FROM characters WHERE campaign_id = ?').get(req.params.campaignId);
      if (Number(row.count) >= tier.max_characters) {
        return res.status(403).json({
          error: `Your ${tier.name} plan allows ${tier.max_characters} character${tier.max_characters === 1 ? '' : 's'} per campaign. Please upgrade for more.`,
          code: 'CHARACTER_LIMIT'
        });
      }
    }
    req.userTier = tier;
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

// Middleware to attach tier info to request
async function attachTier(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      await lapseTrialIfExpired(user, db);
      req.user = user;
      req.userTier = getTier(user.tier);
      req.trialExpired = isTrialExpired(user);
    }
    next();
  } catch(e) { next(e); }
}

// ============================================================
// EFFECTIVE TIER (per campaign member). Tier permissions resolve in the
// campaign context, not purely per-account: a member's effective tier is
// the HIGHER of their own account tier and the campaign SM's tier.
// Computed live (never stored) so it's always correct when either party
// changes plan -- if an SM downgrades, players without a higher sub of
// their own immediately lose the richer features.
// ============================================================
function tierRank(tierName) {
  const t = TIERS[tierName];
  return t ? (t.rank || 1) : 1;
}

// The richer of two tier names, by rank.
function maxTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

// Resolve a user's effective tier NAME within a campaign:
//   max(user's own account tier, the campaign SM's tier).
// Pass campaignId null/undefined to get the user's own tier. Pair the
// result with getTier() for the feature set. NOTE: account-level limits
// (e.g. max_campaigns) must still use the user's OWN tier -- joining a
// higher-tier SM does not grant account-level allowances.
async function getEffectiveTier(userId, campaignId) {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const me = await db.prepare('SELECT tier FROM users WHERE id = ?').get(userId);
    const myTier = (me && me.tier) || 'copper';
    if (!campaignId) return myTier;
    const sm = await db.prepare(
      "SELECT u.tier AS tier FROM campaign_members cm JOIN users u ON u.id = cm.user_id " +
      "WHERE cm.campaign_id = ? AND cm.role = 'dm' LIMIT 1"
    ).get(campaignId);
    const smTier = (sm && sm.tier) || myTier;
    return maxTier(myTier, smTier);
  } catch (e) {
    return 'copper';
  }
}

// Convenience: the effective tier's feature set (a TIERS entry).
async function getEffectiveTierFeatures(userId, campaignId) {
  return getTier(await getEffectiveTier(userId, campaignId));
}

// ============================================================
// STYLE TIER GATING. Each art/narrative style has a minimum tier RANK.
// A member may select/generate a style only if their EFFECTIVE tier rank
// (getEffectiveTier -> tierRank) is >= the style's min rank. Base styles
// sit at rank 1 (Copper/floor) so even a Copper member -- e.g. someone who
// inherited a campaign and runs it as SM at the floor tier -- always has a
// working art and narrative style. Ranks: 1 Copper, 2 Silver, 3 Gold,
// 4 Platinum. The 30-day trial grants Platinum-equivalent effective rank
// (wired in the resolver during the monetization pass), so trial users see
// everything unlocked. Edited here today; moves to a tier_config table
// (DB, admin-editable) when the Admin Dashboard lands -- callers read
// through the helpers below, never these maps directly.
// ============================================================
const ART_STYLE_MIN_RANK = {
  'High fantasy illustration': 1,   // base / floor
  'Dark gritty comic book': 3,      // Gold
  'Classic pen and ink': 3,         // Gold
  'Charcoal drawing': 3,            // Gold
  'Watercolor painterly': 4,        // Platinum
  'Anime manga style': 4,           // Platinum
  'Fantasy oil painting': 4,        // Platinum
  'Comic book cel-shaded': 4,       // Platinum
  'Fantasy pastel': 4               // Platinum
};

const NARRATIVE_STYLE_MIN_RANK = {
  classic: 1,      // base / floor
  epic: 3,         // Gold
  journal: 3,      // Gold
  cinematic: 3,    // Gold
  lorekeeper: 4,   // Platinum
  noir: 4,         // Platinum
  grim: 4,         // Platinum
  storybook: 4,    // Platinum
  anime: 4         // Platinum
};

// Unknown ids default to the floor (rank 1) so a never-mapped style never
// hard-locks everyone out; the server also falls back to a base style.
function artStyleMinRank(id) { return ART_STYLE_MIN_RANK[id] || 1; }
function narrativeStyleMinRank(id) { return NARRATIVE_STYLE_MIN_RANK[id] || 1; }
function artStyleAllowed(effectiveRank, id) { return (effectiveRank || 1) >= artStyleMinRank(id); }
function narrativeStyleAllowed(effectiveRank, id) { return (effectiveRank || 1) >= narrativeStyleMinRank(id); }

module.exports = { TIERS, getTier, loadTierConfig, getTierOverrides, saveTierConfig, EDITABLE_TIER_FIELDS, getMomentRange, isTrialExpired, lapseTrialIfExpired, checkCampaignLimit, checkSessionLimit, checkCharacterLimit, attachTier, tierRank, maxTier, getEffectiveTier, getEffectiveTierFeatures, ART_STYLE_MIN_RANK, NARRATIVE_STYLE_MIN_RANK, artStyleMinRank, narrativeStyleMinRank, artStyleAllowed, narrativeStyleAllowed };
