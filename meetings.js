const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const db      = require('../models/db');

// Get all meetings for dashboard
router.get('/', auth, async (req, res) => {
  try {
    const meetings = await db.getMeetings(req.userId);
    res.json(meetings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get meetings' });
  }
});

// Get one meeting summary
router.get('/:id', auth, async (req, res) => {
  try {
    const meeting = await db.getMeetingById(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    res.json(meeting);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get meeting' });
  }
});

// Get user stats
router.get('/stats/summary', auth, async (req, res) => {
  try {
    const stats = await db.getStats(req.userId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

module.exports = router;
