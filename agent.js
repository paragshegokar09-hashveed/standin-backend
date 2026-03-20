const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const gemini  = require('../services/geminiService');
const db      = require('../models/db');

// Start AI session when call begins
router.post('/start', auth, async (req, res) => {
  try {
    const { meetingId, callerLanguage } = req.body;
    const user = await db.getUserById(req.userId);

    gemini.initSession(meetingId, {
      name:  user.name  || 'Professional',
      role:  user.role  || 'Business Professional',
      phone: user.phone,
    }, callerLanguage || user.language || 'en');

    const greeting = await gemini.greeting(meetingId);

    res.json({ success: true, greeting });

  } catch (err) {
    console.error('Start session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Process caller speech and get AI response
router.post('/respond', auth, async (req, res) => {
  try {
    const { meetingId, callerText, detectedLanguage } = req.body;

    if (!callerText?.trim()) {
      return res.json({ text: null });
    }

    const result = await gemini.respond(meetingId, callerText, detectedLanguage);

    // Send live update to mobile app
    const io = req.app.get('io');
    io.to(`meeting-${meetingId}`).emit('transcript', {
      callerText,
      aiText:   result?.text,
      language: result?.language,
      time:     new Date().toLocaleTimeString(),
    });

    res.json(result || { text: null });

  } catch (err) {
    console.error('Respond error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// End meeting and get summary
router.post('/end', auth, async (req, res) => {
  try {
    const { meetingId, fromNumber, duration } = req.body;

    const result = await gemini.summary(meetingId);

    // Save meeting to database
    await db.saveMeeting({
      userId:     req.userId,
      fromNumber: fromNumber || 'Unknown',
      language:   result.language || 'en',
      summary:    result.summary,
      transcript: result.transcript,
      duration:   duration || result.duration,
    });

    // Notify mobile app
    const io = req.app.get('io');
    io.to(`meeting-${meetingId}`).emit('meeting-ended', result);

    res.json(result);

  } catch (err) {
    console.error('End meeting error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Toggle AI on or off
router.post('/toggle', auth, async (req, res) => {
  try {
    const { enabled } = req.body;
    await db.setAIEnabled(req.userId, enabled);
    res.json({
      enabled,
      message: enabled ? '✅ AI Agent is now ON' : '⏸️ AI Agent is now OFF',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle' });
  }
});

module.exports = router;
