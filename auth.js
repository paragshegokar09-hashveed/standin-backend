const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const jwt     = require('jsonwebtoken');
const db      = require('../models/db');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// ── STEP 1: App sends Firebase token → we verify and return our JWT ──
router.post('/verify-firebase', async (req, res) => {
  try {
    const { firebaseToken, language } = req.body;

    if (!firebaseToken) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Verify with Firebase (free)
    const decoded = await admin.auth().verifyIdToken(firebaseToken);
    const phone   = decoded.phone_number;

    if (!phone) {
      return res.status(400).json({ error: 'No phone number found' });
    }

    // Get or create user automatically
    let user = await db.getUserByPhone(phone);
    if (!user) {
      const lang = language || detectLanguage(phone);
      user = await db.createUser({ phone, language: lang });
      console.log('✅ New user registered:', phone);
    } else {
      console.log('✅ User logged in:', phone);
    }

    // Create JWT token (valid 30 days)
    const token = jwt.sign(
      { userId: user.id, phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id:        user.id,
        phone:     user.phone,
        name:      user.name,
        language:  user.language,
        isNewUser: !user.name,
        aiEnabled: user.ai_enabled,
      },
    });

  } catch (err) {
    console.error('Firebase verify error:', err.message);
    res.status(401).json({ error: 'Login failed. Please try again.' });
  }
});

// ── UPDATE PROFILE (name, language) ──
router.post('/profile', require('../middleware/auth'), async (req, res) => {
  try {
    const { name, language } = req.body;
    await db.updateProfile(req.userId, { name, language });
    res.json({ success: true, message: 'Profile updated!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── GET CURRENT USER ──
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id:        user.id,
      phone:     user.phone,
      name:      user.name,
      language:  user.language,
      aiEnabled: user.ai_enabled,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Auto detect language from phone country code
function detectLanguage(phone) {
  const map = {
    '+91': 'hi',  // India
    '+92': 'ur',  // Pakistan
    '+880':'bn',  // Bangladesh
    '+966':'ar',  // Saudi Arabia
    '+971':'ar',  // UAE
    '+86': 'zh',  // China
    '+81': 'ja',  // Japan
    '+82': 'ko',  // Korea
    '+55': 'pt',  // Brazil
    '+34': 'es',  // Spain
    '+33': 'fr',  // France
    '+49': 'de',  // Germany
    '+7':  'ru',  // Russia
    '+254':'sw',  // Kenya
    '+234':'en',  // Nigeria
    '+1':  'en',  // USA
    '+44': 'en',  // UK
  };
  for (const [prefix, lang] of Object.entries(map)) {
    if (phone.startsWith(prefix)) return lang;
  }
  return 'en';
}

module.exports = router;
