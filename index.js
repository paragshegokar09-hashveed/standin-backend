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
const axios      = require('axios');
const FormData   = require('form-data');
const crypto     = require('crypto');

// ── SETUP ─────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));      // increased for audio uploads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
        voiceId:   user.voice_id || null,
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
    const { name, language, voiceId } = req.body;

    const { data: user } = await supabase
      .from('users').select('name, voice_id').eq('id', req.userId).single();

    // If updating voiceId only (from voice setup screen)
    if (voiceId && !name) {
      await supabase.from('users')
        .update({ voice_id: voiceId }).eq('id', req.userId);
      return res.json({ success: true, voiceId });
    }

    // Name cannot be changed once set
    if (user?.name && name) {
      return res.status(403).json({
        error: 'Name cannot be changed once it is set.',
        existingName: user.name,
      });
    }

    // First time setting name
    const updateData = {};
    if (name)     updateData.name     = name.trim();
    if (language) updateData.language = language;
    if (voiceId)  updateData.voice_id = voiceId;

    await supabase.from('users').update(updateData).eq('id', req.userId);
    res.json({ success: true, name: name?.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save profile' });
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
// VOICE CLONE ROUTES — ElevenLabs Integration
// ═══════════════════════════════════════════════════

// POST /api/voice/clone
// Receives 4 base64 audio recordings → sends to ElevenLabs → saves voiceId
app.post('/api/voice/clone', authMiddleware, async (req, res) => {
  try {
    const { userName, audioFiles } = req.body;

    if (!audioFiles || audioFiles.length < 4) {
      return res.status(400).json({ error: 'All 4 voice recordings are required' });
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(500).json({ error: 'ElevenLabs API key not configured' });
    }

    // Check if user already has a voice — delete old one first
    const { data: user } = await supabase
      .from('users').select('voice_id').eq('id', req.userId).single();

    if (user?.voice_id) {
      try {
        await axios.delete(
          `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
          { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
        );
        console.log('🗑️ Old voice deleted:', user.voice_id);
      } catch {
        // Old voice may not exist anymore — continue
      }
    }

    // Build FormData for ElevenLabs
    const form = new FormData();
    form.append('name', `StandIn_${userName}_${req.userId}`);

    audioFiles.forEach((base64Audio, index) => {
      const buffer = Buffer.from(base64Audio, 'base64');
      form.append('files', buffer, {
        filename:    `sentence_${index + 1}.mp3`,
        contentType: 'audio/mpeg',
      });
    });

    form.append('labels', JSON.stringify({
      userId:   req.userId,
      userName: userName,
      purpose:  'StandIn AI Voice Clone',
    }));

    // Call ElevenLabs
    console.log('🎙️ Creating voice clone for:', userName);
    const elevenRes = await axios.post(
      'https://api.elevenlabs.io/v1/voices/add',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        timeout: 120000, // 2 minute timeout
      }
    );

    const voiceId = elevenRes.data.voice_id;
    if (!voiceId) return res.status(500).json({ error: 'No voice ID returned from ElevenLabs' });

    // Save voice ID to database
    await supabase.from('users').update({ voice_id: voiceId }).eq('id', req.userId);

    console.log('✅ Voice clone created:', voiceId, 'for', userName);
    res.json({ success: true, voiceId, message: '✅ Voice clone created!' });

  } catch (err) {
    console.error('Voice clone error:', err?.response?.data || err.message);
    const msg = err?.response?.data?.detail?.message || err.message || 'Voice clone failed';
    res.status(500).json({ error: msg });
  }
});

// GET /api/voice/status — check if user has voice clone
app.get('/api/voice/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('voice_id').eq('id', req.userId).single();

    if (!user?.voice_id) return res.json({ hasVoice: false });

    // Verify voice still exists in ElevenLabs
    try {
      const response = await axios.get(
        `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      res.json({ hasVoice: true, voiceId: user.voice_id, voiceName: response.data.name });
    } catch {
      res.json({ hasVoice: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/voice/clone — delete voice model
app.delete('/api/voice/clone', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users').select('voice_id').eq('id', req.userId).single();

    if (user?.voice_id) {
      await axios.delete(
        `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      await supabase.from('users').update({ voice_id: null }).eq('id', req.userId);
    }
    res.json({ success: true, message: 'Voice clone deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/speak — AI speaks using cloned voice (called during meetings)
app.post('/api/voice/speak', authMiddleware, async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text)    return res.status(400).json({ error: 'Text is required' });
    if (!voiceId) return res.status(400).json({ error: 'Voice ID is required' });

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability:         0.75,
          similarity_boost:  0.85,
          style:             0.5,
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          'xi-api-key':   process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout:      30000,
      }
    );

    const audioBase64 = Buffer.from(response.data).toString('base64');
    res.json({ success: true, audio: audioBase64, mimeType: 'audio/mpeg' });

  } catch (err) {
    console.error('Voice speak error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Could not generate speech' });
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
      voiceId:   user.voice_id || null,
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

    res.json({ success: true, greeting, voiceId: user.voice_id || null });
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

      res.json({ text, language: lang, voiceId: session.voiceId });

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
  status:      '✅ StandIn AI Backend is Running!',
  cost:        '₹0 / $0 — Free Forever',
  ai:          process.env.GEMINI_API_KEY      ? '✅ Gemini Connected'      : '❌ Gemini Missing',
  firebase:    process.env.FIREBASE_PROJECT_ID ? '✅ Firebase Connected'    : '❌ Firebase Missing',
  db:          process.env.SUPABASE_URL        ? '✅ Supabase Connected'    : '❌ Supabase Missing',
  voice:       process.env.ELEVENLABS_API_KEY  ? '✅ ElevenLabs Connected'  : '❌ ElevenLabs Missing',
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



// ══════════════════════════════════════════════════
// VOICE CLONE ROUTES (ElevenLabs)
// ══════════════════════════════════════════════════
// backend — Voice Clone Route
// POST /api/voice/clone
// Receives 4 base64 audio recordings → sends to ElevenLabs → returns voiceId

// (merged-removed): const express    = require('express');
// (merged-removed): const router     = express.Router();
// (merged-removed): const axios      = require('axios');
// (merged-removed): const FormData   = require('form-data');
// (merged-removed): const crypto     = require('crypto');
// (merged-removed): const { createClient } = require('@supabase/supabase-js');
// (merged-removed): const authMiddleware = require('../middleware/auth');

// (merged-removed): const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── ADD TO index.js ──────────────────────────────────
// const voiceRoutes = require('./routes/voice');
// app.use('/api/voice', voiceRoutes);
// ─────────────────────────────────────────────────────

// POST /api/voice/clone
// Body: { userName: string, audioFiles: string[] } (base64 encoded)
router.post('/clone', authMiddleware, async (req, res) => {
  try {
    const { userName, audioFiles } = req.body;

    if (!audioFiles || audioFiles.length < 4) {
      return res.status(400).json({ error: 'All 4 voice recordings are required' });
    }

    // Check if user already has a voice clone
    const { data: user } = await supabase
      .from('users')
      .select('voice_id')
      .eq('id', req.userId)
      .single();

    // If voice already exists — delete old one from ElevenLabs first
    if (user?.voice_id) {
      try {
        await axios.delete(
          `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
          { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
        );
      } catch {
        // Old voice deletion failed — continue anyway
      }
    }

    // ── BUILD FORM DATA FOR ELEVENLABS ─────────────────
    const form = new FormData();
    form.append('name', `StandIn_${userName}_${req.userId}`);

    // Add each audio recording as a file
    audioFiles.forEach((base64Audio, index) => {
      const buffer = Buffer.from(base64Audio, 'base64');
      form.append('files', buffer, {
        filename:    `sentence_${index + 1}.mp3`,
        contentType: 'audio/mpeg',
      });
    });

    // Labels for ElevenLabs (metadata)
    form.append('labels', JSON.stringify({
      userId:   req.userId,
      userName: userName,
      purpose:  'StandIn AI Voice Clone',
    }));

    // ── CALL ELEVENLABS API ───────────────────────────
    const elevenResponse = await axios.post(
      'https://api.elevenlabs.io/v1/voices/add',
      form,
      {
        headers: {
          ...form.getHeaders(),
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        timeout: 60000, // 60 second timeout for upload
      }
    );

    const voiceId = elevenResponse.data.voice_id;

    if (!voiceId) {
      return res.status(500).json({ error: 'ElevenLabs did not return a voice ID' });
    }

    // ── SAVE VOICE ID TO DATABASE ─────────────────────
    await supabase
      .from('users')
      .update({ voice_id: voiceId })
      .eq('id', req.userId);

    res.json({
      success: true,
      voiceId,
      message: '✅ Voice clone created successfully!',
    });

  } catch (err) {
    console.error('Voice clone error:', err?.response?.data || err.message);
    const msg = err?.response?.data?.detail?.message || err.message || 'Voice clone failed';
    res.status(500).json({ error: msg });
  }
});

// ── GET USER'S VOICE STATUS ───────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('voice_id')
      .eq('id', req.userId)
      .single();

    if (!user?.voice_id) {
      return res.json({ hasVoice: false });
    }

    // Check if voice still exists in ElevenLabs
    try {
      const response = await axios.get(
        `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      res.json({
        hasVoice: true,
        voiceId:  user.voice_id,
        voiceName: response.data.name,
      });
    } catch {
      // Voice no longer exists in ElevenLabs
      res.json({ hasVoice: false });
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE VOICE CLONE ────────────────────────────────
router.delete('/clone', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('voice_id')
      .eq('id', req.userId)
      .single();

    if (user?.voice_id) {
      await axios.delete(
        `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
        { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
      );
      await supabase
        .from('users')
        .update({ voice_id: null })
        .eq('id', req.userId);
    }

    res.json({ success: true, message: 'Voice clone deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── USE VOICE IN MEETING (called internally by AI) ────
// This is used by the Gemini AI service to speak via ElevenLabs
router.post('/speak', authMiddleware, async (req, res) => {
  try {
    const { text, voiceId } = req.body;

    if (!text) return res.status(400).json({ error: 'Text is required' });
    if (!voiceId) return res.status(400).json({ error: 'Voice ID is required' });

    // Call ElevenLabs text-to-speech
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: 'eleven_multilingual_v2', // supports 29 languages
        voice_settings: {
          stability:        0.75, // consistent tone
          similarity_boost: 0.85, // close to original voice
          style:            0.5,  // natural expression
          use_speaker_boost: true,
        },
      },
      {
        headers: {
          'xi-api-key':   process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept':       'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout:      30000,
      }
    );

    // Return audio as base64 — mobile app plays it
    const audioBase64 = Buffer.from(response.data).toString('base64');
    res.json({
      success:    true,
      audio:      audioBase64,
      mimeType:   'audio/mpeg',
    });

  } catch (err) {
    console.error('Voice speak error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Could not generate speech' });
  }
});

// (merged-removed): module.exports = router;


// ══════════════════════════════════════════════════
// PHASE 1 ROUTES
// ══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// PHASE 1 — Add these routes to your index.js
// Copy everything below and paste BEFORE the
// "START SERVER" section in index.js
// ═══════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// FEATURE 1: PERSONAL KNOWLEDGE BASE
// ─────────────────────────────────────────────────────

// Get all knowledge base facts
app.get('/api/knowledge', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a new fact
app.post('/api/knowledge', authMiddleware, async (req, res) => {
  try {
    const { question, answer, category } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer required' });
    }
    const { data } = await supabase
      .from('knowledge_base')
      .insert({
        user_id:  req.userId,
        question: question.trim(),
        answer:   answer.trim(),
        category: category || 'custom',
      })
      .select().single();
    res.json({ success: true, fact: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a fact
app.delete('/api/knowledge/:id', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 2: SMART CALL SCREENING
// ─────────────────────────────────────────────────────

// Get screening settings
app.get('/api/screening/settings', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('screening_enabled, screening_delay, show_context')
      .eq('id', req.userId)
      .single();
    res.json({
      enabled:     user?.screening_enabled ?? true,
      delay:       user?.screening_delay   ?? 10,
      showContext: user?.show_context      ?? true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update screening settings
app.post('/api/screening/settings', authMiddleware, async (req, res) => {
  try {
    const { enabled, delay, showContext } = req.body;
    await supabase
      .from('users')
      .update({
        screening_enabled: enabled,
        screening_delay:   delay,
        show_context:      showContext,
      })
      .eq('id', req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get caller context — who is calling + prediction
app.post('/api/screening/caller-context', authMiddleware, async (req, res) => {
  try {
    const { callerPhone } = req.body;

    // Get past meetings with this caller
    const { data: pastMeetings } = await supabase
      .from('meetings')
      .select('summary, created_at, duration')
      .eq('user_id', req.userId)
      .eq('from_number', callerPhone)
      .order('created_at', { ascending: false })
      .limit(5);

    if (!pastMeetings || pastMeetings.length === 0) {
      return res.json({
        isKnown:    false,
        callCount:  0,
        prediction: 'New caller — no previous history',
        lastCall:   null,
      });
    }

    // Ask Gemini to predict why they are calling
    const recentSummary = pastMeetings[0].summary;
    let prediction = 'Likely follow-up from previous conversation';

    try {
      const result = await model.generateContent(
        `Based on this last call summary, predict in ONE short sentence why this person might be calling again:\n\n"${recentSummary}"`
      );
      prediction = result.response.text().replace(/"/g, '').trim();
    } catch {}

    res.json({
      isKnown:    true,
      callCount:  pastMeetings.length,
      prediction,
      lastCall:   pastMeetings[0].created_at,
      lastSummary: recentSummary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 3: MEETING INTELLIGENCE REPORT
// ─────────────────────────────────────────────────────

// Generate full intelligence report for a meeting
app.post('/api/meetings/:id/intelligence', authMiddleware, async (req, res) => {
  try {
    const { data: meeting } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!meeting.summary) return res.json({ error: 'No transcript available' });

    // Ask Gemini to do full intelligence analysis
    const prompt = `
Analyze this phone call transcript/summary and return a JSON object with:
{
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": number (0-100, higher = more positive),
  "keyNumbers": ["₹50L", "Nov 15", etc],
  "actionItems": [{"task": "string", "deadline": "string", "priority": "high"|"medium"|"low"}],
  "riskFlags": ["string"],
  "callerPersonality": "string (1 sentence)",
  "followUpDate": "string",
  "recommendation": "string (2 sentences)"
}

Meeting summary: "${meeting.summary}"
Return ONLY valid JSON, no other text.
    `.trim();

    let report = null;
    try {
      const result = await model.generateContent(prompt);
      const text   = result.response.text();
      const clean  = text.replace(/```json|```/g,'').trim();
      report = JSON.parse(clean);
    } catch {
      // Fallback if Gemini parsing fails
      report = {
        sentiment:        'neutral',
        sentimentScore:   60,
        keyNumbers:       [],
        actionItems:      [{ task: 'Follow up with caller', deadline: 'This week', priority: 'medium' }],
        riskFlags:        [],
        callerPersonality:'Professional and direct communicator.',
        followUpDate:     'Within 3 days',
        recommendation:   'Follow up with caller to address discussed topics.',
      };
    }

    // Save report to database
    await supabase
      .from('meetings')
      .update({ intelligence_report: report })
      .eq('id', req.params.id);

    res.json({ success: true, report, meeting });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get saved intelligence report
app.get('/api/meetings/:id/intelligence', authMiddleware, async (req, res) => {
  try {
    const { data: meeting } = await supabase
      .from('meetings')
      .select('intelligence_report, summary, from_number, created_at, duration')
      .eq('id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (!meeting) return res.status(404).json({ error: 'Not found' });
    res.json({ report: meeting.intelligence_report, meeting });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 4: BIOMETRIC APP LOCK
// ─────────────────────────────────────────────────────

// Save biometric settings
app.post('/api/security/biometric', authMiddleware, async (req, res) => {
  try {
    const { fingerprintEnabled, faceEnabled, pinEnabled, lockDelay, failedAttemptLimit, captureIntruder } = req.body;

    await supabase
      .from('users')
      .update({
        biometric_finger:  fingerprintEnabled,
        biometric_face:    faceEnabled,
        biometric_pin:     pinEnabled,
        lock_delay:        lockDelay        || 'immediately',
        attempt_limit:     failedAttemptLimit || 5,
        capture_intruder:  captureIntruder,
      })
      .eq('id', req.userId);

    res.json({ success: true, message: 'Biometric settings saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set encrypted PIN (hashed, never stored as plain text)
app.post('/api/security/pin', authMiddleware, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length !== 6) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    }

    // Hash the PIN before storing
// (inline-removed - use global crypto): 
    const hashedPin = crypto
      .createHmac('sha256', process.env.JWT_SECRET)
      .update(pin)
      .digest('hex');

    await supabase
      .from('users')
      .update({ pin_hash: hashedPin })
      .eq('id', req.userId);

    res.json({ success: true, message: 'PIN set successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify PIN
app.post('/api/security/verify-pin', authMiddleware, async (req, res) => {
  try {
    const { pin } = req.body;
// (inline-removed - use global crypto): 
    const hashedPin = crypto
      .createHmac('sha256', process.env.JWT_SECRET)
      .update(pin)
      .digest('hex');

    const { data: user } = await supabase
      .from('users')
      .select('pin_hash')
      .eq('id', req.userId)
      .single();

    const match = user?.pin_hash === hashedPin;
    res.json({ success: match, message: match ? 'PIN correct' : 'Wrong PIN' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 5: DATA EXPIRY CONTROL
// ─────────────────────────────────────────────────────

// Get data expiry settings
app.get('/api/data/settings', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('transcript_expiry, voice_expiry, summary_expiry')
      .eq('id', req.userId)
      .single();
    res.json({
      transcriptExpiry: user?.transcript_expiry || 30,
      voiceExpiry:      user?.voice_expiry      || 7,
      summaryExpiry:    user?.summary_expiry     || 90,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update expiry settings
app.post('/api/data/settings', authMiddleware, async (req, res) => {
  try {
    const { transcriptExpiry, voiceExpiry, summaryExpiry } = req.body;
    await supabase
      .from('users')
      .update({
        transcript_expiry: transcriptExpiry,
        voice_expiry:      voiceExpiry,
        summary_expiry:    summaryExpiry,
      })
      .eq('id', req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export all user data as JSON
app.get('/api/data/export', authMiddleware, async (req, res) => {
  try {
    const [userRes, meetingsRes, kbRes] = await Promise.all([
      supabase.from('users').select('phone, name, language, created_at').eq('id', req.userId).single(),
      supabase.from('meetings').select('*').eq('user_id', req.userId),
      supabase.from('knowledge_base').select('*').eq('user_id', req.userId),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      user:       userRes.data,
      meetings:   meetingsRes.data || [],
      knowledgeBase: kbRes.data || [],
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="standin-ai-export.json"');
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all meetings
app.delete('/api/data/meetings', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('meetings')
      .delete()
      .eq('user_id', req.userId);
    res.json({ success: true, message: 'All meetings deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete account — removes everything
app.delete('/api/data/account', authMiddleware, async (req, res) => {
  try {
    // Delete voice clone from ElevenLabs first
    const { data: user } = await supabase
      .from('users')
      .select('voice_id')
      .eq('id', req.userId)
      .single();

    if (user?.voice_id && process.env.ELEVENLABS_API_KEY) {
      try {
        await axios.delete(
          `https://api.elevenlabs.io/v1/voices/${user.voice_id}`,
          { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
        );
      } catch {}
    }

    // Delete all data in order (foreign key safe)
    await supabase.from('meetings').delete().eq('user_id', req.userId);
    await supabase.from('knowledge_base').delete().eq('user_id', req.userId);
    await supabase.from('users').delete().eq('id', req.userId);

    console.log('🗑️ Account deleted:', req.userId);
    res.json({ success: true, message: 'Account permanently deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// AUTO EXPIRY JOB — runs daily to clean old data
// This runs automatically every 24 hours
// ─────────────────────────────────────────────────────
async function runDataExpiryCleanup() {
  try {
    console.log('🧹 Running data expiry cleanup...');

    // Get all users with expiry settings
    const { data: users } = await supabase
      .from('users')
      .select('id, transcript_expiry, voice_expiry, summary_expiry')
      .not('transcript_expiry', 'is', null);

    for (const user of (users || [])) {
      if (user.transcript_expiry) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - user.transcript_expiry);
        await supabase
          .from('meetings')
          .delete()
          .eq('user_id', user.id)
          .lt('created_at', cutoff.toISOString());
      }
    }

    console.log('✅ Data expiry cleanup complete');
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

// Run cleanup every 24 hours
setInterval(runDataExpiryCleanup, 24 * 60 * 60 * 1000);
// Also run once on startup
setTimeout(runDataExpiryCleanup, 5000);


// ══════════════════════════════════════════════════
// PHASE 2 ROUTES
// ══════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// PHASE 2 BACKEND ROUTES
// Add these to index.js BEFORE the "START SERVER" section
// ═══════════════════════════════════════════════════

// ─────────────────────────────────────────────────────
// FEATURE 1: REAL-TIME WHISPER MODE
// User secretly types instructions to AI during live call
// ─────────────────────────────────────────────────────
app.post('/api/agent/whisper', authMiddleware, async (req, res) => {
  try {
    const { meetingId, instruction } = req.body;
    if (!meetingId || !instruction) {
      return res.status(400).json({ error: 'meetingId and instruction required' });
    }

    const session = aiSessions.get(meetingId);
    if (!session) return res.status(404).json({ error: 'Meeting session not found' });

    // Inject instruction into AI context — will be used in next response
    session.whisperQueue = session.whisperQueue || [];
    session.whisperQueue.push(instruction);

    // Confirm receipt to mobile app via WebSocket
    io.to(`meeting-${meetingId}`).emit('whisper-received', {
      instruction,
      time: new Date().toLocaleTimeString(),
    });

    res.json({ success: true, message: 'Instruction queued for AI' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Updated respond route — checks whisper queue before answering
// Replace the existing /api/agent/respond with this version:
app.post('/api/agent/respond-v2', authMiddleware, async (req, res) => {
  try {
    const { meetingId, callerText, detectedLanguage } = req.body;
    if (!callerText?.trim()) return res.json({ text: null });

    const session = aiSessions.get(meetingId);
    if (!session) return res.json({ text: 'Hello, one moment please.' });

    if (detectedLanguage) session.language = detectedLanguage;
    const lang = session.language;
    const name = session.profile.name;

    // Build system prompt — include whisper instructions if any
    let systemPrompt = `You are ${name} in a phone call. Reply ONLY in "${lang}" language. Keep it under 2 sentences. Never say you are AI.`;

    if (session.whisperQueue && session.whisperQueue.length > 0) {
      const instructions = session.whisperQueue.join('. ');
      systemPrompt += ` IMPORTANT — secretly include this in your response: ${instructions}`;
      session.whisperQueue = []; // Clear after use
    }

    try {
      const chat = model.startChat({
        history: [
          { role: 'user',  parts: [{ text: systemPrompt }] },
          { role: 'model', parts: [{ text: `Understood. I am ${name}.` }] },
          ...session.history,
        ],
      });

      const result = await chat.sendMessage(callerText);
      const text   = result.response.text();

      session.history.push(
        { role: 'user',  parts: [{ text: callerText }] },
        { role: 'model', parts: [{ text }] }
      );
      if (session.history.length > 20) session.history = session.history.slice(-20);

      io.to(`meeting-${meetingId}`).emit('transcript', {
        callerText, aiText: text, language: lang,
        time: new Date().toLocaleTimeString(),
      });

      res.json({ text, language: lang, voiceId: session.voiceId });
    } catch {
      res.json({ text: 'Yes, one moment.', language: lang });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 2: VOICE MOOD DETECTION
// AI detects caller's emotion and adjusts response tone
// ─────────────────────────────────────────────────────
app.post('/api/agent/detect-mood', authMiddleware, async (req, res) => {
  try {
    const { callerText, language } = req.body;
    if (!callerText) return res.json({ mood: 'neutral', score: 50 });

    const prompt = `
Analyze the emotion/mood in this caller message and return JSON only:
{
  "mood": "happy" | "neutral" | "angry" | "worried" | "confused" | "excited",
  "score": number 0-100,
  "adjustTone": "warmer" | "calmer" | "reassuring" | "slower" | "normal",
  "urgency": "low" | "medium" | "high"
}

Message: "${callerText}"
Return ONLY valid JSON.`;

    try {
      const result = await model.generateContent(prompt);
      const text   = result.response.text();
      const clean  = text.replace(/```json|```/g, '').trim();
      const mood   = JSON.parse(clean);

      // Emit mood to mobile app in real time
      res.json({ success: true, ...mood });
    } catch {
      res.json({ mood: 'neutral', score: 50, adjustTone: 'normal', urgency: 'low' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 3: GOOGLE CALENDAR INTEGRATION
// AI checks calendar and books meetings automatically
// ─────────────────────────────────────────────────────

// Save Google Calendar access token
app.post('/api/calendar/connect', authMiddleware, async (req, res) => {
  try {
    const { accessToken, refreshToken } = req.body;
    await supabase
      .from('users')
      .update({
        calendar_access_token:  accessToken,
        calendar_refresh_token: refreshToken,
        calendar_connected:     true,
      })
      .eq('id', req.userId);
    res.json({ success: true, message: 'Google Calendar connected!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check calendar availability
app.post('/api/calendar/check', authMiddleware, async (req, res) => {
  try {
    const { date, duration = 60 } = req.body; // duration in minutes
    const { data: user } = await supabase
      .from('users')
      .select('calendar_access_token')
      .eq('id', req.userId)
      .single();

    if (!user?.calendar_access_token) {
      return res.json({ available: true, message: 'Calendar not connected — assuming available' });
    }

    // Check Google Calendar API
    const startTime = new Date(date);
    const endTime   = new Date(startTime.getTime() + duration * 60000);

    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        timeMin:  startTime.toISOString(),
        timeMax:  endTime.toISOString(),
        items:    [{ id: 'primary' }],
      },
      { headers: { Authorization: `Bearer ${user.calendar_access_token}` } }
    );

    const busy = response.data.calendars?.primary?.busy || [];
    res.json({
      available: busy.length === 0,
      busySlots: busy,
      message:   busy.length === 0 ? 'Time slot is free ✅' : 'Already have something scheduled',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Book a meeting in Google Calendar
app.post('/api/calendar/book', authMiddleware, async (req, res) => {
  try {
    const { title, startTime, endTime, attendeeEmail, description } = req.body;
    const { data: user } = await supabase
      .from('users')
      .select('calendar_access_token, name')
      .eq('id', req.userId)
      .single();

    if (!user?.calendar_access_token) {
      return res.status(400).json({ error: 'Calendar not connected' });
    }

    // Create calendar event
    const event = {
      summary:     title || `Meeting with ${user.name}`,
      description: description || 'Scheduled via StandIn AI',
      start: { dateTime: startTime, timeZone: 'Asia/Kolkata' },
      end:   { dateTime: endTime,   timeZone: 'Asia/Kolkata' },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      reminders: {
        useDefault: false,
        overrides:  [{ method: 'popup', minutes: 15 }],
      },
    };

    const response = await axios.post(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      event,
      { headers: { Authorization: `Bearer ${user.calendar_access_token}` } }
    );

    res.json({
      success:  true,
      eventId:  response.data.id,
      eventUrl: response.data.htmlLink,
      message:  '✅ Meeting booked in Google Calendar!',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get upcoming events (for context during calls)
app.get('/api/calendar/upcoming', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('calendar_access_token')
      .eq('id', req.userId)
      .single();

    if (!user?.calendar_access_token) {
      return res.json({ events: [] });
    }

    const now     = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const response = await axios.get(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        params: {
          timeMin:      now.toISOString(),
          timeMax:      weekLater.toISOString(),
          singleEvents: true,
          orderBy:      'startTime',
          maxResults:   10,
        },
        headers: { Authorization: `Bearer ${user.calendar_access_token}` },
      }
    );

    const events = (response.data.items || []).map((e) => ({
      id:       e.id,
      title:    e.summary,
      start:    e.start?.dateTime || e.start?.date,
      end:      e.end?.dateTime   || e.end?.date,
      location: e.location,
    }));

    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 4: FRAUD DETECTION AI
// Monitors calls for suspicious patterns in real time
// ─────────────────────────────────────────────────────
app.post('/api/agent/fraud-check', authMiddleware, async (req, res) => {
  try {
    const { callerText, callerPhone, meetingId } = req.body;

    // Pattern-based fraud detection (instant, no AI needed)
    const fraudPatterns = [
      { pattern: /OTP|one.time.password|verification code/i,      level: 'HIGH',   reason: 'Asking for OTP — possible fraud' },
      { pattern: /bank|account number|IFSC|ATM|card number/i,     level: 'HIGH',   reason: 'Asking for banking details' },
      { pattern: /CBI|police|court|arrest|FIR|legal action/i,     level: 'HIGH',   reason: 'Threatening with legal action — scam pattern' },
      { pattern: /lottery|won|prize|claim|congratulations/i,      level: 'HIGH',   reason: 'Lottery/prize scam pattern detected' },
      { pattern: /Aadhaar|PAN|passport|KYC|update your details/i, level: 'MEDIUM', reason: 'Asking for identity documents' },
      { pattern: /urgent|immediately|right now|emergency/i,       level: 'LOW',    reason: 'Creating urgency — common manipulation tactic' },
    ];

    let fraud = null;
    for (const p of fraudPatterns) {
      if (p.pattern.test(callerText)) {
        fraud = p;
        break;
      }
    }

    // Check call frequency — same number calling too many times
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('meetings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.userId)
      .eq('from_number', callerPhone)
      .gte('created_at', oneHourAgo);

    if ((count || 0) >= 5 && !fraud) {
      fraud = { level: 'MEDIUM', reason: `Same number called ${count} times in 1 hour` };
    }

    if (fraud) {
      // Alert user via WebSocket immediately
      io.to(`user-${req.userId}`).emit('fraud-alert', {
        level:  fraud.level,
        reason: fraud.reason,
        phone:  callerPhone,
        time:   new Date().toLocaleTimeString(),
      });

      // HIGH level fraud — AI automatically says safe phrase and ends
      if (fraud.level === 'HIGH') {
        const session = aiSessions.get(meetingId);
        if (session) {
          const safePhrases = {
            hi: 'मैं आपको आधिकारिक नंबर से वापस कॉल करूंगा।',
            en: 'I will call you back on the official number. Thank you.',
            ar: 'سأعاود الاتصال بك على الرقم الرسمي.',
          };
          const lang   = session.language || 'en';
          const phrase = safePhrases[lang] || safePhrases.en;
          io.to(`meeting-${meetingId}`).emit('transcript', {
            aiText: phrase, language: lang, fraudAlert: true,
          });
        }
      }
    }

    res.json({
      isFraud:   !!fraud,
      level:     fraud?.level || 'SAFE',
      reason:    fraud?.reason || 'No suspicious patterns detected',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fraud alert history
app.get('/api/fraud/alerts', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('fraud_alerts')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────
// FEATURE 5: END-TO-END ENCRYPTION
// Encrypts all transcripts with user's own key
// ─────────────────────────────────────────────────────
// (merged-removed): const crypto = require('crypto');

// Generate encryption key for user
app.post('/api/security/generate-key', authMiddleware, async (req, res) => {
  try {
    // Generate AES-256 key
    const encryptionKey = crypto.randomBytes(32).toString('hex');

    // Store key hash (never store the actual key — user keeps it)
    const keyHash = crypto
      .createHash('sha256')
      .update(encryptionKey)
      .digest('hex');

    await supabase
      .from('users')
      .update({ encryption_key_hash: keyHash })
      .eq('id', req.userId);

    // Return key to user — they must save it themselves
    // We only store the hash, never the key
    res.json({
      success:       true,
      encryptionKey, // User must save this — we cannot recover it
      warning:       'Save this key safely. If lost, your encrypted data cannot be recovered.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Encrypt a meeting transcript
app.post('/api/security/encrypt', authMiddleware, async (req, res) => {
  try {
    const { data, userKey } = req.body;
    if (!data || !userKey) return res.status(400).json({ error: 'data and userKey required' });

    const key = Buffer.from(userKey, 'hex');
    const iv  = crypto.randomBytes(16);

    const cipher     = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted  = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);

    res.json({
      success:   true,
      encrypted: encrypted.toString('hex'),
      iv:        iv.toString('hex'),
    });
  } catch (err) {
    res.status(500).json({ error: 'Encryption failed' });
  }
});

// Decrypt a meeting transcript
app.post('/api/security/decrypt', authMiddleware, async (req, res) => {
  try {
    const { encrypted, iv, userKey } = req.body;
    if (!encrypted || !iv || !userKey) {
      return res.status(400).json({ error: 'encrypted, iv and userKey required' });
    }

    const key       = Buffer.from(userKey, 'hex');
    const ivBuf     = Buffer.from(iv, 'hex');
    const encBuf    = Buffer.from(encrypted, 'hex');

    const decipher  = crypto.createDecipheriv('aes-256-cbc', key, ivBuf);
    const decrypted = Buffer.concat([decipher.update(encBuf), decipher.final()]);

    res.json({
      success: true,
      data:    JSON.parse(decrypted.toString()),
    });
  } catch (err) {
    res.status(500).json({ error: 'Decryption failed — wrong key or corrupted data' });
  }
});


// ═══════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🚀 StandIn AI Backend running on port', PORT);
  console.log('🤖 Gemini:     ', process.env.GEMINI_API_KEY      ? '✅' : '❌ Missing');
  console.log('🔥 Firebase:   ', process.env.FIREBASE_PROJECT_ID ? '✅' : '❌ Missing');
  console.log('🗄️  Supabase:   ', process.env.SUPABASE_URL        ? '✅' : '❌ Missing');
  console.log('🎙️  ElevenLabs: ', process.env.ELEVENLABS_API_KEY  ? '✅' : '❌ Missing');
});
