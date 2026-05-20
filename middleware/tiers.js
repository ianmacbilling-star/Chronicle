// ============================================================
// TIER CONFIGURATION
// Change limits here or via environment variables
// ============================================================

const TIERS = {
  copper: {
    name: 'Copper',
    price: 0,
    trial_days: 30,
    max_campaigns: 1,
    max_sessions: 5,         // per campaign
    moment_algorithm: 'standard',
    max_moments_short: 3,    // < 2000 words
    max_moments_medium: 4,   // 2000-5000
    max_moments_long: 5,     // 5000-10000
    max_moments_epic: 6,     // 10000+
    watermark: true,
    can_export: false,
    can_print: false,
    can_edit_prompts: false,
    description: '30-day free trial'
  },
  silver: {
    name: 'Silver',
    price: 9,
    max_campaigns: 1,
    max_sessions: null,      // unlimited
    moment_algorithm: 'standard',
    max_moments_short: 3,
    max_moments_medium: 4,
    max_moments_long: 6,
    max_moments_epic: 8,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: false,
    description: '1 campaign, unlimited sessions'
  },
  gold: {
    name: 'Gold',
    price: 12,
    max_campaigns: 3,
    max_sessions: null,
    moment_algorithm: 'extended',
    max_moments_short: 5,
    max_moments_medium: 8,
    max_moments_long: 12,
    max_moments_epic: 15,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: false,
    description: '3 campaigns, extended moment counts'
  },
  platinum: {
    name: 'Platinum',
    price: 15,
    max_campaigns: null,     // unlimited
    max_sessions: null,
    moment_algorithm: 'extended',
    max_moments_short: 5,
    max_moments_medium: 8,
    max_moments_long: 12,
    max_moments_epic: 15,
    watermark: false,
    can_export: true,
    can_print: true,
    can_edit_prompts: true,  // exclusive perk
    description: 'Unlimited everything + prompt editing'
  }
};

function getTier(tierName) {
  return TIERS[tierName] || TIERS.copper;
}

function getMomentRange(tier, wordCount) {
  const t = getTier(tier);
  if (wordCount < 2000) return t.max_moments_short + '-' + (t.max_moments_short + 1);
  if (wordCount < 5000) return t.max_moments_medium + '-' + (t.max_moments_medium + 1);
  if (wordCount < 10000) return t.max_moments_long + '-' + (t.max_moments_long + 1);
  return t.max_moments_epic + '-' + Math.min(t.max_moments_epic + 2, 15);
}

function isTrialExpired(user) {
  if (user.tier !== 'copper') return false;
  if (!user.trial_started_at) return false;
  const trialDays = getTier('copper').trial_days;
  const started = new Date(user.trial_started_at);
  const expires = new Date(started.getTime() + trialDays * 24 * 60 * 60 * 1000);
  return new Date() > expires;
}

// Middleware to check campaign limit
async function checkCampaignLimit(req, res, next) {
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const tier = getTier(user.tier);

    // Check trial expiry
    if (isTrialExpired(user)) {
      return res.status(403).json({
        error: 'Your free trial has expired. Please upgrade to continue.',
        code: 'TRIAL_EXPIRED'
      });
    }

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

    const tier = getTier(user.tier);

    if (isTrialExpired(user)) {
      return res.status(403).json({
        error: 'Your free trial has expired. Please upgrade to continue.',
        code: 'TRIAL_EXPIRED'
      });
    }

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

// Middleware to attach tier info to request
async function attachTier(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  const { getDb } = require('../database/db');
  try {
    const db = await getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      req.userTier = getTier(user.tier);
      req.trialExpired = isTrialExpired(user);
    }
    next();
  } catch(e) { next(e); }
}

module.exports = { TIERS, getTier, getMomentRange, isTrialExpired, checkCampaignLimit, checkSessionLimit, attachTier };
