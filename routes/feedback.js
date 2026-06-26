const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { sendFeedbackEmail } = require('./email');

// POST /api/feedback -- user-submitted feedback (suggestions, bugs, questions)
// routed to support. The user's email is set as Reply-To so support can reply
// directly; the destination address is never exposed to the client.
router.post('/', async function(req, res) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    var category = String((req.body && req.body.category) || 'Other').slice(0, 40);
    var subject = String((req.body && req.body.subject) || '').trim().slice(0, 160);
    var message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.json({ error: 'Please enter a message before sending.' });
    if (message.length > 5000) message = message.slice(0, 5000);
    const db = await getDb();
    const user = await db.prepare('SELECT id, name, email, tier FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    await sendFeedbackEmail({
      from_name: user.name || 'Campaignia user',
      from_email: user.email,
      tier: user.tier || 'unknown',
      category: category,
      subject: subject,
      message: message
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Feedback submit error:', e.message);
    res.json({ error: 'Could not send your feedback right now. Please try again in a moment.' });
  }
});

module.exports = router;
