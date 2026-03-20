require('dotenv').config();
const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const { Server } = require('socket.io');

const authRoutes    = require('./routes/auth');
const agentRoutes   = require('./routes/agent');
const meetingRoutes = require('./routes/meetings');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth',     authRoutes);
app.use('/api/agent',    agentRoutes);
app.use('/api/meetings', meetingRoutes);

app.get('/', (_, res) => res.json({
  status:  '✅ StandIn AI Backend is Running!',
  cost:    '₹0 / $0 Free Forever',
  ai:      'Google Gemini (Free)',
  auth:    'Firebase Phone Auth (Free)',
  db:      'Supabase (Free)',
}));

app.set('io', io);
io.on('connection', socket => {
  socket.on('join-meeting', id => socket.join(`meeting-${id}`));
  socket.on('join-user',    id => socket.join(`user-${id}`));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n🚀 StandIn AI Backend Running on port', PORT);
  console.log('🤖 Gemini:   ', process.env.GEMINI_API_KEY   ? '✅ Connected' : '❌ Missing Key');
  console.log('🔥 Firebase: ', process.env.FIREBASE_PROJECT_ID ? '✅ Connected' : '❌ Missing Key');
  console.log('🗄️  Supabase: ', process.env.SUPABASE_URL    ? '✅ Connected' : '❌ Missing Key');
});

module.exports = { app, io };
