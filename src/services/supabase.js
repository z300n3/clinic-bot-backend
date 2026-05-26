const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ── Clinic ────────────────────────────────────────────────────────────────────

async function getClinicByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('clinics')
    .select('*')
    .eq('whatsapp_phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .single();

  if (error) logger.warn('getClinicByPhoneNumberId error', { error: error.message });
  return data || null;
}

// ── Patients ─────────────────────────────────────────────────────────────────

async function findOrCreatePatient(clinicId, phoneNumber) {
  // Try to find existing patient first
  const { data: existing } = await supabase
    .from('patients')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('patients')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing;
  }

  const { data: created, error } = await supabase
    .from('patients')
    .insert({ clinic_id: clinicId, phone_number: phoneNumber })
    .select()
    .single();

  if (error) {
    // Race condition: another request created it first — fetch again
    if (error.code === '23505') {
      const { data: refetched } = await supabase
        .from('patients')
        .select('*')
        .eq('clinic_id', clinicId)
        .eq('phone_number', phoneNumber)
        .single();
      return refetched;
    }
    throw new Error('Failed to create patient: ' + error.message);
  }

  return created;
}

// ── Conversations ─────────────────────────────────────────────────────────────

/**
 * Atomically inserts a message row.
 * Returns null (not an error) when whatsapp_message_id already exists (dedup).
 */
async function saveMessage({ clinicId, patientId, patientPhone, role, content, toolCalls, whatsappMessageId, messageType, originalMediaId }) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      clinic_id:           clinicId,
      patient_id:          patientId,
      patient_phone:       patientPhone,
      role,
      content:             content || null,
      tool_calls:          toolCalls || null,
      whatsapp_message_id: whatsappMessageId || null,
      message_type:        messageType || 'text',
      original_media_id:   originalMediaId || null,
      created_at:          new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') return null; // duplicate whatsapp_message_id
    logger.error('saveMessage error', { error: error.message, role });
    throw new Error('Failed to save message: ' + error.message);
  }

  return data;
}

/**
 * Loads the last `limit` user/assistant text messages for Claude context.
 * Excludes tool-only messages (no text content).
 */
async function loadConversationHistory(clinicId, patientPhone, limit = 10) {
  const { data, error } = await supabase
    .from('conversations')
    .select('role, content, tool_calls, created_at')
    .eq('clinic_id', clinicId)
    .eq('patient_phone', patientPhone)
    .in('role', ['user', 'assistant'])
    .not('content', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.warn('loadConversationHistory error', { error: error.message });
    return [];
  }

  return (data || []).reverse(); // Return oldest first
}

// ── Conversation State ────────────────────────────────────────────────────────

async function getConversationState(clinicId, patientPhone) {
  const { data } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_phone', patientPhone)
    .maybeSingle();
  return data;
}

async function upsertConversationState(clinicId, patientPhone, state, stateData = {}) {
  const { error } = await supabase
    .from('conversation_state')
    .upsert(
      {
        clinic_id:       clinicId,
        patient_phone:   patientPhone,
        state,
        state_data:      stateData,
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'clinic_id,patient_phone' }
    );

  if (error) logger.error('upsertConversationState error', { error: error.message });
}

module.exports = {
  supabase,
  getClinicByPhoneNumberId,
  findOrCreatePatient,
  saveMessage,
  loadConversationHistory,
  getConversationState,
  upsertConversationState,
};
