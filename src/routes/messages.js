const express = require('express');
const router  = express.Router();

const { supabase }           = require('../services/supabase');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const logger                  = require('../utils/logger');

// ── POST /api/messages/send ───────────────────────────────────────────────────
//
// Body: { clinic_id, patient_phone, message }
//
// 1. Saves the doctor message to the conversations table (always).
// 2. Sends it to the patient via Meta WhatsApp API (best-effort).
// 3. If the conversation was awaiting_human, resets it to 'active' so the
//    bot can pick up again after the doctor is done.
//
// Returns { success: true } on WhatsApp delivery, or { success: false, error }
// if the API send failed (message is still saved to DB regardless).
// ─────────────────────────────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  const { clinic_id, patient_phone, message } = req.body;

  // ── Validate inputs ───────────────────────────────────────────────────────
  if (!clinic_id || !patient_phone || !message?.trim()) {
    return res.status(400).json({ error: 'clinic_id و patient_phone و message مطلوبة' });
  }

  const text = message.trim();

  // ── Load clinic to get its WhatsApp phone number ID ───────────────────────
  const { data: clinic, error: clinicErr } = await supabase
    .from('clinics')
    .select('id, name, whatsapp_phone_number_id')
    .eq('id', clinic_id)
    .single();

  if (clinicErr || !clinic) {
    logger.error('messages/send: clinic not found', { clinic_id });
    return res.status(404).json({ error: 'العيادة غير موجودة' });
  }

  // ── Save to conversations table ───────────────────────────────────────────
  const { error: saveErr } = await supabase
    .from('conversations')
    .insert({
      clinic_id,
      patient_phone,
      role:    'doctor',
      content: text,
    });

  if (saveErr) {
    logger.error('messages/send: DB insert failed', { error: saveErr.message });
    return res.status(500).json({ success: false, error: 'فشل حفظ الرسالة في قاعدة البيانات' });
  }

  logger.info('Doctor message saved', { to: patient_phone, clinic_id });

  // ── If awaiting_human → reset to active so the bot can resume later ───────
  await supabase
    .from('conversation_state')
    .update({ state: 'active', state_data: {} })
    .eq('clinic_id', clinic_id)
    .eq('patient_phone', patient_phone)
    .eq('state', 'awaiting_human');

  // ── Send via WhatsApp Meta API (best-effort) ──────────────────────────────
  const phoneNumberId = clinic.whatsapp_phone_number_id || process.env.META_PHONE_NUMBER_ID;

  try {
    await sendWhatsAppMessage(phoneNumberId, patient_phone, text);
    logger.info('Doctor WhatsApp message sent', { to: patient_phone });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Doctor WhatsApp send failed (message already saved to DB)', {
      to:    patient_phone,
      error: err.message,
    });
    return res.json({ success: false, error: 'فشل إرسال الرسالة عبر واتساب' });
  }
});

module.exports = router;
