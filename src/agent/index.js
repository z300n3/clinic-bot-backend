const { extractIntent }     = require('./extract');
const { validateExtracted } = require('./validate');
const { decide }            = require('./decide');
const { execute }           = require('./execute');
const { saveMessage, loadConversationHistory, supabase } = require('../services/supabase');
const logger = require('../utils/logger');

async function handleIncomingMessage({ clinic, patient, patientPhone, userMessage }) {

  // 1. Load state
  const { data: stateRow } = await supabase
    .from('conversation_state')
    .select('state, state_data')
    .eq('clinic_id', clinic.id)
    .eq('patient_phone', patientPhone)
    .maybeSingle();

  const currentState = stateRow?.state      || 'active';
  const stateData    = stateRow?.state_data || {};
  const subState     = stateData.booking_substate || 'idle';

  // 2. Handle awaiting_human (bypass pipeline)
  if (currentState === 'awaiting_human') {
    const reply = 'راح يتواصل معاك أحد من فريق العيادة قريباً. شكراً على صبرك! 🙏';
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 3. Extract
  const extracted = await extractIntent(userMessage, subState, stateData);
  logger.info('[Pipeline] Extracted', { intent: extracted.intent });

  // 4. Validate
  const checks = await validateExtracted(extracted, clinic, patient, stateData, userMessage);
  logger.info('[Pipeline] Validated', { nameValid: checks.nameValid, dayAvail: checks.dayInfo?.isWorking });

  // 5. Decide
  const decision = decide(extracted, checks, subState, stateData);
  logger.info('[Pipeline] Decision', { action: decision.action });

  // 6. Execute
  const reply = await execute(decision, clinic, patient, patientPhone);

  // 7. Save
  await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });

  return reply;
}

module.exports = { handleIncomingMessage };
