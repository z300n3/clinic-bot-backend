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

// ── GET /api/appointments/queue-estimate ─────────────────────────────────────
// Query: ?clinic_id=...&date=YYYY-MM-DD
// Returns the expected queue number for the given date.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/queue-estimate', async (req, res) => {
  try {
    const { clinic_id, date } = req.query;
    if (!clinic_id || !date) {
      return res.status(400).json({ error: 'clinic_id and date are required' });
    }

    const startOfDay = dayjs.tz(date, TIMEZONE).startOf('day').toISOString();
    const endOfDay = dayjs.tz(date, TIMEZONE).endOf('day').toISOString();

    const { count, error } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('clinic_id', clinic_id)
      .gte('scheduled_at', startOfDay)
      .lte('scheduled_at', endOfDay)
      .not('status', 'in', '("cancelled","cancelled_by_clinic")');

    if (error) throw error;

    return res.json({ expected_queue: count + 1 });
  } catch (err) {
    logger.error('Error fetching queue estimate', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch queue estimate' });
  }
});

// ── POST /api/appointments/web ──────────────────────────────────────────────
//
// Body: { clinic_id, patient_name, phone_number, scheduled_at }
// Creates a new appointment from the web landing page.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/web', async (req, res) => {
  let { clinic_id, patient_name, phone_number, scheduled_at } = req.body;

  if (!clinic_id || !patient_name || !phone_number || !scheduled_at) {
    return res.status(400).json({ error: 'جميع الحقول المطلوبة يجب تعبئتها' });
  }

  // Format phone number: 07729243035 -> 9647729243035
  if (phone_number.startsWith('07') && phone_number.length === 11) {
    phone_number = '964' + phone_number.substring(1);
  }

  try {
    // 1. Get Clinic info for duration and whatsapp ID
    const { data: clinic, error: clinicErr } = await supabase
      .from('clinics')
      .select('id, name, doctor_name, appointment_duration_minutes, whatsapp_phone_number_id')
      .eq('id', clinic_id)
      .single();

    if (clinicErr || !clinic) {
      return res.status(404).json({ error: 'العيادة غير موجودة' });
    }

    // 2. Find or create patient
    let patientId;
    const { data: existingPatient } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinic_id)
      .eq('phone_number', phone_number)
      .maybeSingle();

    if (existingPatient) {
      patientId = existingPatient.id;
      // Update last_seen and name
      await supabase.from('patients').update({ name: patient_name, last_seen_at: new Date().toISOString() }).eq('id', patientId);
    } else {
      const { data: newPatient, error: newPatientErr } = await supabase
        .from('patients')
        .insert({
          clinic_id,
          phone_number,
          name: patient_name
        })
        .select('id')
        .single();
        
      if (newPatientErr) throw newPatientErr;
      patientId = newPatient.id;
    }

    // 3. Calculate queue number for the day
    const startOfDay = dayjs(scheduled_at).tz(TIMEZONE).startOf('day').toISOString();
    const endOfDay = dayjs(scheduled_at).tz(TIMEZONE).endOf('day').toISOString();
    const { count: currentQueue } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('clinic_id', clinic_id)
      .gte('scheduled_at', startOfDay)
      .lte('scheduled_at', endOfDay)
      .not('status', 'in', '("cancelled","cancelled_by_clinic")');

    const queueNumber = (currentQueue || 0) + 1;

    // 4. Create appointment
    const { data: newAppt, error: apptErr } = await supabase
      .from('appointments')
      .insert({
        clinic_id,
        patient_id: patientId,
        patient_name,
        scheduled_at,
        duration_minutes: clinic.appointment_duration_minutes,
        status: 'scheduled',
        queue_number: queueNumber
      })
      .select('id, queue_number')
      .single();

    if (apptErr) throw apptErr;

    // 5. Send Confirmation WhatsApp (Best effort) - Meta 24h Window Check
    let whatsappSent = false;
    try {
      const { data: convState } = await supabase
        .from('conversation_state')
        .select('last_message_at')
        .eq('clinic_id', clinic_id)
        .eq('patient_phone', phone_number)
        .maybeSingle();

      let within24h = false;
      if (convState && convState.last_message_at) {
        const hoursSinceLastMessage = dayjs().diff(dayjs(convState.last_message_at), 'hour');
        if (hoursSinceLastMessage < 24) within24h = true;
      }

      if (within24h) {
        const slotDate = dayjs(scheduled_at).tz(TIMEZONE);
        const dayOfWeek = slotDate.day();
        const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        const dayName = days[dayOfWeek];
        const dateStr = slotDate.format('YYYY-MM-DD');
        
        // Fetch the schedule for this day from DB
        const { data: sched } = await supabase
          .from('availability_schedules')
          .select('is_working_day, shifts')
          .eq('clinic_id', clinic_id)
          .eq('day_of_week', dayOfWeek)
          .maybeSingle();

        let timeStr = 'حسب دورك';
        if (sched && sched.is_working_day && sched.shifts && sched.shifts.length > 0) {
          const formatTime12Hour = (time24) => {
            if (!time24) return '';
            const [hours, minutes] = time24.split(':');
            let h = parseInt(hours, 10);
            const ampm = h >= 12 ? 'م' : 'ص';
            h = h % 12 || 12;
            return `${String(h).padStart(2, '0')}:${minutes} ${ampm}`;
          };
          const shift = sched.shifts[0];
          timeStr = `${formatTime12Hour(shift.open)} - ${formatTime12Hour(shift.close)}`;
        }
        
        const message = `مرحباً ${patient_name} 👋\n\nتم تأكيد حجز موعدك بنجاح في ${clinic.name}.\n\n📅 التاريخ: ${dateStr} (${dayName})\n⏰ أوقات الدوام: ${timeStr}\n🔢 الدور المتوقع: ${queueNumber}\n\nنتمنى لك السلامة والشفاء العاجل!`;
        
        await sendWhatsAppMessage(clinic.whatsapp_phone_number_id, phone_number, message);
        whatsappSent = true;
      } else {
        logger.info('Skipped WhatsApp confirmation due to Meta 24h window limit', { phone_number });
      }
    } catch (waErr) {
      logger.error('WhatsApp confirmation failed', { error: waErr.message });
    }

    // Send back whatsappSent so frontend knows whether to show a warning
    return res.status(201).json({ success: true, appointment: newAppt, whatsappSent });
  } catch (error) {
    logger.error('Error creating web appointment', { error: error.message });
    return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الموعد' });
  }
});

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

// ── PATCH /api/appointments/:id/status ───────────────────────────────────────
//
// Body: { status: 'completed' | 'no_show' }
// Marks attendance for a past confirmed appointment.
// If no_show: increments patients.no_show_count and sends a WhatsApp follow-up.
// ─────────────────────────────────────────────────────────────────────────────

router.patch('/:id/status', async (req, res) => {
  const { id }     = req.params;
  const { status } = req.body;

  if (!['completed', 'no_show'].includes(status)) {
    return res.status(400).json({ error: 'الحالة يجب أن تكون completed أو no_show' });
  }

  // 1. Load appointment + patient + clinic
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .select(`
      id, scheduled_at, queue_number, status, reason, patient_name,
      patients ( id, name, phone_number, no_show_count ),
      clinics  ( id, name, whatsapp_phone_number_id )
    `)
    .eq('id', id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: 'الموعد غير موجود' });
  }

  if (!['scheduled', 'confirmed'].includes(appt.status)) {
    return res.status(400).json({ error: 'يمكن تسجيل الحضور فقط للمواعيد المحجوزة أو المؤكدة' });
  }

  // 2. Update appointment status
  const { error: updateErr } = await supabase
    .from('appointments')
    .update({ status })
    .eq('id', id);

  if (updateErr) {
    logger.error('status update failed', { id, status, error: updateErr.message });
    return res.status(500).json({ error: 'فشل تحديث حالة الموعد' });
  }

  logger.info('Appointment status updated', { id, status });

  // 3. If no_show: increment counter + send WhatsApp follow-up
  let whatsappSent  = false;
  let whatsappError = null;

  if (status === 'no_show') {
    const patient = appt.patients;

    // Increment no_show_count
    const { error: countErr } = await supabase
      .from('patients')
      .update({ no_show_count: (patient.no_show_count || 0) + 1 })
      .eq('id', patient.id);

    if (countErr) {
      logger.error('no_show_count increment failed', { patientId: patient.id, error: countErr.message });
    }

    // Send WhatsApp follow-up (best-effort)
    try {
      const clinic      = appt.clinics;
      const patientName = appt.patient_name || patient.name || 'مريضنا العزيز';

      const message =
        `مرحبا ${patientName} 👋\n` +
        `لاحظنا انك ما كدرت تحضر لموعدك اليوم.\n` +
        `إذا تريد تحجز موعد جديد، راسلنا وبكل سرور نساعدك 🙏`;

      await sendWhatsAppMessage(
        clinic.whatsapp_phone_number_id,
        patient.phone_number,
        message
      );

      whatsappSent = true;
      logger.info('No-show follow-up WhatsApp sent', { to: patient.phone_number });
    } catch (err) {
      whatsappError = err.message;
      logger.error('No-show WhatsApp failed', { id, error: err.message });
    }
  }

  return res.json({
    success: true,
    whatsappSent,
    whatsappError: whatsappError || undefined,
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
