const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

class GeminiService {
  constructor() {
    this.sessions = new Map();
  }

  // Start a new meeting session
  initSession(meetingId, userProfile, callerLanguage = 'en') {
    this.sessions.set(meetingId, {
      history:     [],
      profile:     userProfile,
      language:    callerLanguage,
      startTime:   Date.now(),
      actionItems: [],
    });
    console.log(`✅ AI Session started: ${meetingId} | Language: ${callerLanguage}`);
  }

  // Get AI response for what caller said
  async respond(meetingId, callerText, detectedLanguage) {
    const session = this.sessions.get(meetingId);
    if (!session) return null;

    if (detectedLanguage) session.language = detectedLanguage;

    const lang = session.language;
    const p    = session.profile;

    const systemPrompt = `You are attending a phone call on behalf of ${p.name || 'the user'}.
You ARE ${p.name || 'the user'}. Never say you are an AI.
Role: ${p.role || 'Professional'}.

VERY IMPORTANT RULE:
- The caller is speaking in "${lang}" language
- You MUST reply in the EXACT SAME language: "${lang}"
- If caller speaks Hindi → reply in Hindi only
- If caller speaks Arabic → reply in Arabic only
- If caller speaks any language → reply in that same language

Keep your reply SHORT — maximum 2 sentences.
Sound natural like a real phone call.
If you don't know something → say you will follow up later.`;

    try {
      const chat = model.startChat({
        history: [
          {
            role:  'user',
            parts: [{ text: systemPrompt }],
          },
          {
            role:  'model',
            parts: [{ text: `Understood. I am ready as ${p.name || 'the user'}.` }],
          },
          ...session.history,
        ],
      });

      const result = await chat.sendMessage(callerText);
      const text   = result.response.text();

      // Save conversation history
      session.history.push(
        { role: 'user',  parts: [{ text: callerText }] },
        { role: 'model', parts: [{ text }] }
      );

      // Keep last 10 exchanges only
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }

      return { text, language: lang };

    } catch (err) {
      console.error('Gemini error:', err.message);
      return { text: this.fallbackReply(lang), language: lang };
    }
  }

  // Generate greeting when call starts
  async greeting(meetingId) {
    const session = this.sessions.get(meetingId);
    if (!session) return 'Hello?';

    const greetings = {
      hi:  'हाँ, बोलिए?',
      ar:  'نعم، أهلاً؟',
      zh:  '你好，请讲。',
      ja:  'はい、もしもし。',
      ko:  '네, 말씀하세요.',
      es:  '¿Sí, dígame?',
      fr:  'Oui, allô?',
      de:  'Ja, hallo?',
      pt:  'Sim, pode falar.',
      ru:  'Да, слушаю.',
      sw:  'Ndio, karibu.',
      ta:  'ஆமாம், சொல்லுங்கள்.',
      te:  'అవును, చెప్పండి.',
      bn:  'হ্যাঁ, বলুন।',
      ur:  'جی، بولیں؟',
      en:  'Hello?',
    };

    return greetings[session.language] || greetings.en;
  }

  // Generate meeting summary at the end
  async summary(meetingId) {
    const session = this.sessions.get(meetingId);
    if (!session || session.history.length < 2) {
      this.sessions.delete(meetingId);
      return { summary: 'Short call completed.', actionItems: [], duration: 0 };
    }

    const transcript = session.history
      .map(m => `${m.role === 'user' ? 'Caller' : session.profile.name || 'AI'}: ${m.parts[0].text}`)
      .join('\n');

    try {
      const result = await model.generateContent(
        `Please summarize this phone call in English. Include:
1. What was discussed
2. Any decisions made
3. Action items (things to do)

Phone call transcript:
${transcript}`
      );

      const duration = Math.floor((Date.now() - session.startTime) / 60000);
      this.sessions.delete(meetingId);

      return {
        summary:     result.response.text(),
        actionItems: [],
        duration,
        transcript:  session.history,
      };

    } catch (err) {
      console.error('Summary error:', err.message);
      this.sessions.delete(meetingId);
      return {
        summary:     'Meeting completed successfully.',
        actionItems: [],
        duration:    0,
      };
    }
  }

  // Fallback reply if Gemini fails
  fallbackReply(lang) {
    const replies = {
      hi:  'जी हाँ, एक मिनट रुकिए।',
      ar:  'نعم، لحظة من فضلك.',
      zh:  '好的，请稍等。',
      ja:  'はい、少々お待ちください。',
      ko:  '네, 잠깐만요.',
      es:  'Sí, un momento por favor.',
      fr:  'Oui, un instant.',
      de:  'Ja, einen Moment bitte.',
      sw:  'Ndio, subiri kidogo.',
      en:  'Yes, one moment please.',
    };
    return replies[lang] || replies.en;
  }

  isActive(meetingId) {
    return this.sessions.has(meetingId);
  }
}

module.exports = new GeminiService();
