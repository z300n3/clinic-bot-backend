const { extractIntent }     = require('./extract');
const { validateExtracted } = require('./validate');
const { decide }            = require('./decide');
const { execute }           = require('./execute');
const { saveMessage, loadConversationHistory, supabase, upsertConversationState } = require('../services/supabase');
const logger = require('../utils/logger');

async function handleIncomingMessage({ clinic, patient, patientPhone, userMessage, messageType }) {

  // 1. Load state
  const { data: stateRow, error: stateErr } = await supabase
    .from('conversation_state')
    .select('state, state_data, last_message_at')
    .eq('clinic_id', clinic.id)
    .eq('patient_phone', patientPhone)
    .maybeSingle();

  logger.info('[STATE READ]', {
    clinicId: clinic.id,
    patientPhone: patientPhone,
    currentState: stateRow?.state || 'NONE',
    gateStep: stateRow?.state_data?.escalation?.gate_step || null,
    readError: stateErr?.message || null
  });

  const currentState = stateRow?.state      || 'active';
  const stateData    = stateRow?.state_data || {};
  const subState     = stateData.booking_substate || 'idle';

  // 2. Handle doctor_active (bypass pipeline)
  if (currentState === 'doctor_active') {
    const reply = 'الطبيب يراجع حالتك حالياً. الرد قريب 🙏';
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 3. Run Extract FIRST (works for all states now)
  const extracted = await extractIntent(userMessage, subState, stateData);
  extracted.userMessage = userMessage; // pass raw message for gate answers
  extracted.messageType = messageType; // pass messageType to decide
  logger.info('[Pipeline] Extracted', { 
    intent: extracted.intent,
    msgPreview: userMessage.slice(0, 30),
    stateAtExtract: currentState
  });

  // 4. GATE handling — intent-aware
  if (currentState === 'gate_collecting') {
    // 4a. Explicit cancel/exit keywords
    if (/الغاء|إلغاء|خروج|رجوع|بطلت|ما اريد|لا اريد/i.test(userMessage)) {
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      const reply = 'تم إلغاء الطلب والتراجع. كيف أقدر أساعدك الآن؟ 😊';
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }

    // 4b. Strong NEW intent → leave gate and process new request
    const strongIntents = ['booking', 'cancellation', 'cancel_all', 'check_appointment', 'reschedule'];
    if (strongIntents.includes(extracted.intent)) {
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      const checks = await validateExtracted(extracted, clinic, patient, {}, userMessage);
      const decision = decide(extracted, checks, 'idle', {});
      const reply = await execute(decision, clinic, patient, patientPhone);
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }

    // 4c. Otherwise → treat as a gate answer (continue gate)
    const decision = { 
      action: 'GATE_CONTINUE', 
      step: stateData.escalation?.gate_step || 1, 
      userMessage 
    };
    const reply = await execute(decision, clinic, patient, patientPhone);
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 5. doctor_pending handling (unchanged hybrid logic)
  if (currentState === 'doctor_pending') {
    if (['booking', 'inquiry', 'check_appointment', 'greeting', 'cancellation', 'cancel_all', 'reschedule'].includes(extracted.intent)) {
      const checks = await validateExtracted(extracted, clinic, patient, stateData, userMessage);
      const decision = decide(extracted, checks, subState, stateData);
      const reply = await execute(decision, clinic, patient, patientPhone);
      
      await upsertConversationState(clinic.id, patientPhone, 'doctor_pending', stateData);
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }

    const reply = 'طلبك بانتظار مراجعة الطبيب. سيتم الرد قريباً 🙏\nإذا تحتاج حجز أو استفسار، تكدر تسأل عادي.';
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 6. SUBSTATE ESCAPE — stale confirmation substate blocked by new intent
  const confirmSubstates = ['awaiting_cancel_confirm','awaiting_cancel_all_confirm',
                            'awaiting_rebook_confirm','awaiting_cancel_select', 'awaiting_voice_confirm',
                            'awaiting_reschedule_confirm', 'awaiting_reschedule_select'];
  const bookingSubstates = ['awaiting_info', 'awaiting_date', 'awaiting_reschedule_date'];
  const escapeIntents = ['booking','escalate_to_doctor','cancellation','cancel_all','inquiry','check_appointment','reschedule'];

  // 6a. For booking substates: merge partial data
  if (bookingSubstates.includes(subState) && (extracted.intent === 'booking' || extracted.intent === 'reschedule')) {
    const partial = stateData.partial_booking || {};
    if (!extracted.patient_name && partial.patient_name) {
      extracted.patient_name = partial.patient_name;
    }
    if (!extracted.date_preference && partial.date_preference) {
      extracted.date_preference = partial.date_preference;
    }
    // Keep substate so pipeline continues normally
  }

  // 6b. For confirmation substates: escape if new strong intent
  if (confirmSubstates.includes(subState) &&
      extracted.intent !== 'confirmation' &&
      extracted.intent !== 'rejection' &&
      escapeIntents.includes(extracted.intent)) {
    await upsertConversationState(clinic.id, patientPhone, 'active', {});
    stateData.booking_substate = 'idle';
  }

  // 7. SUBSTATE EXPIRY — any substate older than 10 minutes auto-resets
  if (subState && subState !== 'idle' && stateRow?.last_message_at) {
    const minutesSince = (Date.now() - new Date(stateRow.last_message_at).getTime()) / 60000;
    if (minutesSince > 10) {
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      stateData.booking_substate = 'idle';
    }
  }

  // 8. escalate_to_doctor intent (NOT in gate) → start gate
  if (extracted.intent === 'escalate_to_doctor') {
    const decision = { action: 'GATE_START' };
    const reply = await execute(decision, clinic, patient, patientPhone);
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 9. Normal pipeline: Validate → Decide → Execute
  const recomputedSubState = stateData.booking_substate || 'idle';
  const checks = await validateExtracted(extracted, clinic, patient, stateData, userMessage);
  logger.info('[Pipeline] Validated', { nameValid: checks.nameValid, dayAvail: checks.dayInfo?.isWorking });

  const decision = decide(extracted, checks, recomputedSubState, stateData);
  logger.info('[Pipeline] Decision', { action: decision.action });

  const reply = await execute(decision, clinic, patient, patientPhone);
  await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });

  return reply;
}

module.exports = { handleIncomingMessage };
