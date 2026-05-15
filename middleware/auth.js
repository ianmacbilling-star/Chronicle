const { getDb } = require('../database/db');

// Middleware to protect routes - checks for valid session
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Verify user still exists in DB
  const db = getDb();
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy();
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.user = user;
  next();
}

// Middleware to verify campaign belongs to logged in user
function requireCampaignOwner(req, res, next) {
  const db = getDb();
  const campaignId = req.params.campaignId || req.params.id;
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(campaignId, req.session.userId);
  if (!campaign) {
    return res.status(403).json({ error: 'Access denied' });
  }
  req.campaign = campaign;
  next();
}

module.exports = { requireAuth, requireCampaignOwner };
