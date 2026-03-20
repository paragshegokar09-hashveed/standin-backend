const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = {

  // ── USERS ─────────────────────────────────────
  async getUserByPhone(phone) {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('phone', phone)
      .single();
    return data || null;
  },

  async getUserById(id) {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    return data || null;
  },

  async createUser({ phone, language }) {
    const { data, error } = await supabase
      .from('users')
      .insert({ phone, language, ai_enabled: true })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async updateProfile(id, { name, language }) {
    const { error } = await supabase
      .from('users')
      .update({ name, language })
      .eq('id', id);
    if (error) throw error;
  },

  async setAIEnabled(id, enabled) {
    await supabase
      .from('users')
      .update({ ai_enabled: enabled })
      .eq('id', id);
  },

  // ── MEETINGS ───────────────────────────────────
  async saveMeeting({ userId, fromNumber, language, summary, transcript, duration }) {
    const { data, error } = await supabase
      .from('meetings')
      .insert({
        user_id:     userId,
        from_number: fromNumber,
        language,
        summary,
        transcript,
        duration,
        status:      'completed',
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getMeetings(userId, limit = 20) {
    const { data } = await supabase
      .from('meetings')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data || [];
  },

  async getMeetingById(id) {
    const { data } = await supabase
      .from('meetings')
      .select('*')
      .eq('id', id)
      .single();
    return data || null;
  },

  async getStats(userId) {
    const { data } = await supabase
      .from('meetings')
      .select('duration')
      .eq('user_id', userId);
    const total = (data || []).length;
    const mins  = (data || []).reduce((s, m) => s + (m.duration || 0), 0);
    return {
      attended:  total,
      timeSaved: (mins / 60).toFixed(1),
    };
  },
};
