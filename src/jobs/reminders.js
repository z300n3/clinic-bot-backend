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
  logger.info('Reminders job: starting smart free reminders');

  try {
    const now = new Date();

    // Fetch ALL active appointments that haven't been reminded
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('id, scheduled_at, patient_name, reason, patient_id, clinic_id')
      .gt('scheduled_at', now.toISOString())
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

    let sentCount = 0;

    for (const appt of appointments) {
      try {
        const sent = await processReminder(appt, now);
        if (sent) sentCount++;
      } catch (err) {
        logger.error('Reminders: failed for appointment', {
          apptId: appt.id,
          error:  err.message,
        });
      }
    }
    
    logger.info(`Reminders: finished, sent ${sentCount} reminder(s)`);
  } catch (err) {
    logger.error('Reminders job error', { error: err.message });
  }
}

// ── processReminder ───────────────────────────────────────────────────────────

async function processReminder(appt, now) {
  // Get patient's last message time from conversation_state
  const { data: stateData } = await supabase
    .from('conversation_state')
    .select('last_message_at')
    .eq('patient_id', appt.patient_id)
    .eq('clinic_id', appt.clinic_id)
    .single();

  if (!stateData || !stateData.last_message_at) {
    return false;
  }

  const lastMessageAt = new Date(stateData.last_message_at);
  const msSinceLastMessage = now.getTime() - lastMessageAt.getTime();
  const hoursSinceLastMessage = msSinceLastMessage / (1000 * 60 * 60);

  // If the window is already closed, we can't send a free message
  if (hoursSinceLastMessage >= 24) {
    return false;
  }

  const scheduledAt = new Date(appt.scheduled_at);
  const msUntilAppt = scheduledAt.getTime() - now.getTime();
  const hoursUntilAppt = msUntilAppt / (1000 * 60 * 60);

  let reminderType = null;
  let messageText = '';
  const timeFormatted = formatAppointmentTime(appt.scheduled_at);

  // Condition 1: The 23-hour save (Appointment is far, window is closing)
  // Give it a buffer from 22.5 to 23.9 hours to ensure the cron job catches it
  if (hoursUntilAppt > 24 && hoursSinceLastMessage >= 22.5 && hoursSinceLastMessage < 24) {
    reminderType = 'early_save';
    messageText = `تذكير مبكر بموعدك 🔔\nتم تثبيت الموعد ليوم: ${timeFormatted}\n\nنتمنى لك دوام الصحة. إذا احتجت لأي مساعدة أخرى لا تتردد بمراسلتنا!`;
  }
  // Condition 2: Standard reminder (Appointment is close, window is open)
  // We send this around 24h before the appointment, OR immediately if the appointment is very soon
  else if (hoursUntilAppt <= 24 && hoursUntilAppt > 0 && hoursSinceLastMessage < 24) {
    reminderType = 'standard';
    messageText = `تذكير بموعدك القادم 🔔\n📅 ${timeFormatted}\n👤 ${appt.patient_name || 'غير محدد'}\n\nإذا تريد إلغاء الموعد كلمنا.`;
  }

  if (!reminderType) {
    return false; // Conditions not met yet
  }

  // Load patient phone
  const { data: patient } = await supabase
    .from('patients')
    .select('phone_number')
    .eq('id', appt.patient_id)
    .single();

  if (!patient?.phone_number) return false;

  // Load clinic
  const { data: clinic } = await supabase
    .from('clinics')
    .select('name, address, meta_access_token, whatsapp_phone_number_id, whatsapp_setup_status')
    .eq('id', appt.clinic_id)
    .single();

  if (!clinic || clinic.whatsapp_setup_status !== 'completed') return false;

  if (reminderType === 'standard' && clinic.address) {
    messageText += `\n📍 ${clinic.address}`;
  }

  await sendWhatsAppReminder(
    clinic.whatsapp_phone_number_id,
    patient.phone_number,
    messageText,
    clinic.meta_access_token
  );

  // Mark as sent
  await supabase
    .from('appointments')
    .update({ reminder_sent_at: new Date().toISOString() })
    .eq('id', appt.id);

  logger.info(`Reminder sent (${reminderType})`, {
    apptId: appt.id,
    to:     patient.phone_number,
  });

  return true;
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
