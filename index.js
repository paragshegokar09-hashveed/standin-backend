// StandIn AI — Complete Backend Server
// Single file — easy to upload to GitHub
require('dotenv').config();

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const { Server } = require('socket.io');
const admin      = require('firebase-admin');
const jwt        = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── SETUP ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── SUPABASE DATABASE ─────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── FIREBASE ──────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// ── GOOGLE GEMINI AI ──────────────────────────────
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const aiSessions = new Map();

// ── JWT MIDDLEWARE ────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Please login again.' });
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please login again.' });
  }
}

// ═══════════════════════════════════════════════════
// AUTH ROUTES — Phone Login with Firebase
// ═══════════════════════════════════════════════════

// Customer sends Firebase token → we give back our JWT
app.post('/api/auth/verify-firebase', async (req, res) => {
  try {
    const { firebaseToken, language } = req.body;
    if (!firebaseToken) return res.status(400).json({ error: 'Token required' });

    // Verify with Firebase (free)
    const decoded = await admin.auth().verifyIdToken(firebaseToken);
    const phone   = decoded.phone_number;
    if (!phone) return res.status(400).json({ error: 'No phone number found' });

    // Find or create user
    let { data: user } = await supabase
      .from('users').select('*').eq('phone', phone).single();

    if (!user) {
      const lang = language || detectLanguage(phone);
      const { data: newUser, error } = await supabase
        .from('users')
        .insert({ phone, language: lang, ai_enabled: true })
        .select().single();
      if (error) throw error;
      user = newUser;
      console.log('✅ New user:', phone);
    }

    // Create JWT (30 days)
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
    console.error('Auth error:', err.message);
    res.status(401).json({ error: 'Login failed. Please try again.' });
  }
});

// Set name — ONE TIME ONLY, cannot be changed after first save
app.post('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, language } = req.body;

    // Check if name already set
    const { data: user } = await supabase
      .from('users').select('name').eq('id', req.userId).single();

    if (user?.name) {
      // Name already set — return it, do not update
      return res.status(403).json({
        error: 'Name cannot be changed once it is set.',
        existingName: user.name,
      });
    }

    // First time setting name — save it permanently
    await supabase.from('users')
      .update({ name: name.trim(), language }).eq('id', req.userId);

    res.json({ success: true, name: name.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save name' });
  }
});

// Get current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('*').eq('id', req.userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════
// AI AGENT ROUTES — Gemini AI for meetings
// ═══════════════════════════════════════════════════

// Start AI session when meeting begins
app.post('/api/agent/start', authMiddleware, async (req, res) => {
  try {
    const { meetingId, callerLanguage } = req.body;
    const { data: user } = await supabase
      .from('users').select('*').eq('id', req.userId).single();

    // Save session
    aiSessions.set(meetingId, {
      history:   [],
      profile:   { name: user.name || 'Professional', role: 'Business Professional' },
      language:  callerLanguage || user.language || 'en',
      startTime: Date.now(),
    });

    // Generate greeting
    const greetings = {
      hi:'हाँ, बोलिए?', ar:'نعم، أهلاً؟', zh:'你好，请讲。',
      ja:'はい、もしもし。', ko:'네, 말씀하세요.',
      es:'¿Sí, dígame?', fr:'Oui, allô?', de:'Ja, hallo?',
      pt:'Sim, pode falar.', ru:'Да, слушаю.',
      sw:'Ndio, karibu.', ta:'ஆமாம், சொல்லுங்கள்.',
      te:'అవును, చెప్పండి.', bn:'হ্যাঁ, বলুন।',
      ur:'جی، بولیں؟', en:'Hello?',
    };

    const lang     = callerLanguage || user.language || 'en';
    const greeting = greetings[lang] || greetings.en;

    res.json({ success: true, greeting });
  } catch (err) {
    console.error('Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Process what caller said, get AI response
app.post('/api/agent/respond', authMiddleware, async (req, res) => {
  try {
    const { meetingId, callerText, detectedLanguage } = req.body;
    if (!callerText?.trim()) return res.json({ text: null });

    const session = aiSessions.get(meetingId);
    if (!session) return res.json({ text: 'Hello, one moment please.' });

    if (detectedLanguage) session.language = detectedLanguage;
    const lang = session.language;
    const name = session.profile.name;

    // Ask Gemini for response
    try {
      const chat = model.startChat({
        history: [
          {
            role:  'user',
            parts: [{ text: `You are ${name} in a phone call. Reply ONLY in "${lang}" language. Keep it under 2 sentences. Never say you are AI.` }],
          },
          {
            role:  'model',
            parts: [{ text: `Understood. I am ${name}, ready to respond in ${lang}.` }],
          },
          ...session.history,
        ],
      });

      const result = await chat.sendMessage(callerText);
      const text   = result.response.text();

      // Save history
      session.history.push(
        { role: 'user',  parts: [{ text: callerText }] },
        { role: 'model', parts: [{ text }] }
      );
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }

      // Send live update to mobile app
      io.to(`meeting-${meetingId}`).emit('transcript', {
        callerText, aiText: text, language: lang,
        time: new Date().toLocaleTimeString(),
      });

      res.json({ text, language: lang });

    } catch (err) {
      console.error('Gemini error:', err.message);
      const fallbacks = {
        hi:'जी हाँ, एक मिनट।', ar:'نعم، لحظة.', zh:'好的，稍等。',
        es:'Sí, un momento.', fr:'Oui, un instant.', en:'Yes, one moment.',
      };
      res.json({ text: fallbacks[lang] || fallbacks.en, language: lang });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End meeting — generate summary
app.post('/api/agent/end', authMiddleware, async (req, res) => {
  try {
    const { meetingId, fromNumber, duration } = req.body;
    const session = aiSessions.get(meetingId);

    let summary  = 'Meeting completed.';
    let duration_ = duration || 0;

    if (session && session.history.length >= 2) {
      const transcript = session.history
        .map(m => `${m.role === 'user' ? 'Caller' : session.profile.name}: ${m.parts[0].text}`)
        .join('\n');

      try {
        const result = await model.generateContent(
          `Summarize this phone call briefly in English. List key topics and any action items.\n\n${transcript}`
        );
        summary  = result.response.text();
        duration_ = Math.floor((Date.now() - session.startTime) / 60000);
      } catch {}
    }

    aiSessions.delete(meetingId);

    // Save to Supabase
    await supabase.from('meetings').insert({
      user_id:     req.userId,
      from_number: fromNumber || 'Unknown',
      language:    session?.language || 'en',
      summary,
      duration:    duration_,
      status:      'completed',
    });

    io.to(`meeting-${meetingId}`).emit('meeting-ended', { summary });
    res.json({ summary, duration: duration_ });

  } catch (err) {
    console.error('End error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Toggle AI on or off
app.post('/api/agent/toggle', authMiddleware, async (req, res) => {
  try {
    const { enabled } = req.body;
    await supabase.from('users')
      .update({ ai_enabled: enabled }).eq('id', req.userId);
    res.json({ enabled, message: enabled ? '✅ AI is ON' : '⏸️ AI is OFF' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════
// MEETINGS ROUTES
// ═══════════════════════════════════════════════════

// Get all meetings
app.get('/api/meetings', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('meetings').select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Get one meeting
app.get('/api/meetings/:id', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('meetings').select('*').eq('id', req.params.id).single();
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Get stats
app.get('/api/meetings/stats/summary', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('meetings').select('duration').eq('user_id', req.userId);
    const total = (data || []).length;
    const mins  = (data || []).reduce((s, m) => s + (m.duration || 0), 0);
    res.json({ attended: total, timeSaved: (mins / 60).toFixed(1) });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════
app.set('io', io);
io.on('connection', socket => {
  socket.on('join-meeting', id => socket.join(`meeting-${id}`));
  socket.on('join-user',    id => socket.join(`user-${id}`));
});

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════
app.get('/', (_, res) => res.json({
  status:  '✅ StandIn AI Backend is Running!',
  cost:    '₹0 / $0 — Free Forever',
  ai:      process.env.GEMINI_API_KEY      ? '✅ Gemini Connected'   : '❌ Gemini Missing',
  firebase:process.env.FIREBASE_PROJECT_ID ? '✅ Firebase Connected' : '❌ Firebase Missing',
  db:      process.env.SUPABASE_URL        ? '✅ Supabase Connected' : '❌ Supabase Missing',
}));

// ═══════════════════════════════════════════════════
// HELPER — Detect language from phone country code
// ═══════════════════════════════════════════════════
function detectLanguage(phone) {
  const map = {
    '+91':'hi', '+92':'ur', '+880':'bn', '+966':'ar',
    '+971':'ar', '+86':'zh', '+81':'ja', '+82':'ko',
    '+55':'pt', '+34':'es', '+33':'fr', '+49':'de',
    '+7':'ru',  '+254':'sw', '+234':'en', '+1':'en', '+44':'en',
  };
  for (const [prefix, lang] of Object.entries(map)) {
    if (phone.startsWith(prefix)) return lang;
  }
  return 'en';
}

// ═══════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🚀 StandIn AI Backend running on port', PORT);
  console.log('🤖 Gemini:   ', process.env.GEMINI_API_KEY      ? '✅' : '❌ Missing');
  console.log('🔥 Firebase: ', process.env.FIREBASE_PROJECT_ID ? '✅' : '❌ Missing');
  console.log('🗄️  Supabase: ', process.env.SUPABASE_URL        ? '✅' : '❌ Missing');
});
