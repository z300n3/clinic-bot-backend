const express = require('express');
const router  = express.Router();
const dayjs   = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { supabase }           = require('../services/supabase');
const { sendWhatsAppMessage } = require('../services/whatsapp');
const logger                  = require('../utils/logger');

const TIMEZONE = 'Asia/Baghdad';

// ── POST /api/appointments/:id/cancel-by-clinic ───────────────────────────────
//
// Body: { reason?: string }
// Cancels the appointment, then sends a WhatsApp notification to the patient.
// The appointment is always cancelled in DB even if WhatsApp delivery fails.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/cancel-by-clinic', async (req, res) => {
  const { id }                  = req.params;
  const { reason = 'ظرف طارئ' } = req.body;

  // 1. Load appointment + patient + clinic in one query
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .select(`
      id, scheduled_at, queue_number, status, reason,
      patients ( id, name, phone_number, clinic_id ),
      clinics  ( id, name, doctor_name, whatsapp_phone_number_id )
    `)
    .eq('id', id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: 'الموعد غير موجود' });
  }

  if (!['scheduled', 'confirmed'].includes(appt.status)) {
    return res.status(400).json({ error: 'الموعد ليس في حالة تسمح بالإلغاء' });
  }

  // 2. Cancel in DB  — always do this first
  const { error: updateErr } = await supabase
    .from('appointments')
    .update({
      status:       'cancelled_by_clinic',
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateErr) {
    logger.error('cancel-by-clinic DB update failed', { id, error: updateErr.message });
    return res.status(500).json({ error: 'فشل تحديث الموعد في قاعدة البيانات' });
  }

  logger.info('Appointment cancelled by clinic', { id, reason });

  // 3. Send WhatsApp notification (best-effort — never block the response on this)
  let whatsappSent  = false;
  let whatsappError = null;

  try {
    const patient     = appt.patients;
    const clinic      = appt.clinics;
    const slotDate    = dayjs(appt.scheduled_at).tz(TIMEZONE);
    const patientName = patient.name || 'مريضنا العزيز';
    const message     = buildCancellationMessage(patientName, slotDate, reason, appt.queue_number);

    await sendWhatsAppMessage(
      clinic.whatsapp_phone_number_id,
      patient.phone_number,
      message
    );

    whatsappSent = true;
    logger.info('Cancellation WhatsApp sent', { to: patient.phone_number });
  } catch (err) {
    whatsappError = err.message;
    logger.error('Cancellation WhatsApp send failed (appointment already cancelled)', {
      id,
      error: err.message,
    });
  }

  return res.json({
    success:      true,
    whatsappSent,
    whatsappError: whatsappError || undefined,
    message:       whatsappSent
      ? 'تم الإلغاء وإرسال إشعار للمريض ✅'
      : 'تم الإلغاء، لكن فشل إرسال إشعار الواتساب',
  });
});

// ── Helper: format cancellation message ──────────────────────────────────────

function buildCancellationMessage(patientName, slotDate, reason, queueNumber) {
  const days   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

  const dayName = days[slotDate.day()];
  const dateStr = `${dayName} ${slotDate.date()} ${months[slotDate.month()]}`;
  const queueStr = (queueNumber !== null && queueNumber !== undefined)
    ? ` (الدور رقم ${queueNumber})`
    : '';

  return `عزيزي ${patientName} 👋\n\nنعتذر منك، تم إلغاء موعدك المحجوز يوم ${dateStr}${queueStr} من قبل العيادة.\n\nالسبب: ${reason}\n\nتكدر تحجز موعد جديد بمراسلتنا مباشرة على هذا الرقم 🙏`;
}

module.exports = router;
