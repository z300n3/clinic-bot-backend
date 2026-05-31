'use strict';

/**
 * jobs/reminders.js — Appointment reminder cron job
 *
 * Runs every hour via setInterval started in src/index.js.
 * Finds all confirmed appointments in the 24-25 hour window ahead,
 * sends a WhatsApp reminder to the patient, and marks reminder_sent_at.
 *
 * Requires: ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
 *           (migration 010_reminder_sent_at.sql)
 */

const axios  = require('axios');
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tz     = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const { supabase } = require('../services/supabase');
const logger       = require('../utils/logger');

const TIMEZONE        = 'Asia/Baghdad';
const GRAPH_API_VER   = 'v22.0';
const GRAPH_BASE      = `https://graph.facebook.com/${GRAPH_API_VER}`;

// ── sendReminders ─────────────────────────────────────────────────────────────

async function sendReminders() {
  logger.info('Reminders job: starting');

  try {
    const now   = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    // Fetch appointments due in the next 24-25 h window that haven't been reminded
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('id, scheduled_at, patient_name, reason, patient_id, clinic_id')
      .gte('scheduled_at', in24h.toISOString())
      .lte('scheduled_at', in25h.toISOString())
      .in('status', ['scheduled', 'confirmed'])
      .is('reminder_sent_at', null);

    if (error) {
      logger.error('Reminders: failed to fetch appointments', { error: error.message });
      return;
    }

    if (!appointments || appointments.length === 0) {
      logger.info('Reminders: no appointments to remind');
      return;
    }

    logger.info(`Reminders: sending ${appointments.length} reminder(s)`);

    for (const appt of appointments) {
      try {
        await processReminder(appt);
      } catch (err) {
        // Don't let one failure block the rest
        logger.error('Reminders: failed for appointment', {
          apptId: appt.id,
          error:  err.message,
        });
      }
    }
  } catch (err) {
    logger.error('Reminders job error', { error: err.message });
  }
}

// ── processReminder ───────────────────────────────────────────────────────────

async function processReminder(appt) {
  // Load patient phone
  const { data: patient } = await supabase
    .from('patients')
    .select('phone_number')
    .eq('id', appt.patient_id)
    .single();

  if (!patient?.phone_number) {
    logger.warn('Reminders: no phone for patient', { patientId: appt.patient_id });
    return;
  }

  // Load clinic credentials + name
  const { data: clinic } = await supabase
    .from('clinics')
    .select('name, address, meta_access_token, whatsapp_phone_number_id, whatsapp_setup_status')
    .eq('id', appt.clinic_id)
    .single();

  if (!clinic) {
    logger.warn('Reminders: clinic not found', { clinicId: appt.clinic_id });
    return;
  }

  // Only send for activated clinics (WhatsApp fully set up)
  if (clinic.whatsapp_setup_status !== 'completed' ||
      !clinic.meta_access_token      ||
      !clinic.whatsapp_phone_number_id) {
    logger.info('Reminders: clinic WhatsApp not activated — skipping', { clinicId: appt.clinic_id });
    return;
  }

  const timeFormatted = formatAppointmentTime(appt.scheduled_at);
  const message = `تذكير بموعدك 🔔\n📅 ${timeFormatted}\n👤 ${appt.patient_name || 'غير محدد'}\n📍 ${clinic.address}\n\nإذا تريد إلغاء الموعد كلمنا.`;

  await sendWhatsAppReminder(
    clinic.whatsapp_phone_number_id,
    patient.phone_number,
    message,
    clinic.meta_access_token
  );

  // Mark as sent
  await supabase
    .from('appointments')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', appt.id);

  logger.info('Reminder sent', {
    apptId: appt.id,
    to:     patient.phone_number,
    day:    timeFormatted,
  });
}

// ── sendWhatsAppReminder ──────────────────────────────────────────────────────
// Uses per-clinic access token (not the global env var).

async function sendWhatsAppReminder(phoneNumberId, to, text, accessToken) {
  try {
    await axios.post(
      `${GRAPH_BASE}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    logger.error('sendWhatsAppReminder failed', {
      to,
      status:   err.response?.status,
      apiError: err.response?.data?.error?.message || err.message,
    });
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatAppointmentTime(isoString) {
  const d      = dayjs(isoString).tz(TIMEZONE);
  const days   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${days[d.day()]} ${d.date()} ${months[d.month()]} ${d.year()}`;
}

module.exports = { sendReminders };
