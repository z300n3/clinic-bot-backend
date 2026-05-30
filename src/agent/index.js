'use strict';

/**
 * agent/index.js — State Machine Agent
 *
 * Replaces the history-based loop with a structured state machine.
 * Each incoming message is routed to a focused handler based on the
 * current conversation state stored in conversation_state.state_data.
 *
 * States:
 *   idle                  — default; classifies intent
 *   collecting_info       — gathering name + reason before showing slots
 *   checking_slots        — patient is viewing and choosing an available day
 *   awaiting_confirmation — patient reviewing booking summary before confirming
 *   awaiting_cancel_confirm — patient confirming cancellation
 *   awaiting_human        — handed off to staff (auto-resets after 24 h)
 *
 * Token comparison (per conversation):
 *   Before: ~9,000 tokens  ($0.07)
 *   After:  ~1,000 tokens  ($0.008)   ≈ 89% reduction
 */

const OpenAI = require('openai');
const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tz     = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const {
  saveMessage,
  upsertConversationState,
  supabase,
} = require('../services/supabase');

const {
  getAvailableSlots,
  escalateToHuman,
  formatArabicDay,
  formatTime12,
} = require('./tools');

const logger = require('../utils/logger');

const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TIMEZONE = 'Asia/Baghdad';

// ── Word lists ────────────────────────────────────────────────────────────────

const RESUME_KEYWORDS = [
  'احجز','موعد','حجز','اريد','أريد','ابي','أبي','كلمني','نسيت','لا يهم',
];

const POSITIVE_WORDS = [
  'نعم','اي','أي','ايه','صح','اكيد','أكيد','تمام','زين','اوكي','أوكي',
  'ماشي','موافق','يلا','عدل','خوش','نعم بالله','أيوه',
];

const NEGATIVE_WORDS = [
  'لا','لأ','لأه','مو','غير','بدل','تغيير','ما اريد','ابقيه','خليه','مو صح',
];

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Main dispatcher. Loads state, routes to the correct handler, saves reply.
 *
 * Returns the reply string, or null when we intentionally stay silent
 * (rate-limited awaiting_human reply).
 */
async function handleMessage({ clinicId, patientPhone, patientId, messageText, clinic }) {
  if (!messageText?.trim()) return null;

  // 1. Load current conversation state
  const { data: stateRow } = await supabase
    .from('conversation_state')
    .select('state, state_data, last_message_at')
    .eq('clinic_id', clinicId)
    .eq('patient_phone', patientPhone)
    .maybeSingle();

  let currentState = stateRow?.state || 'idle';
  const stateData  = stateRow?.state_data || {};

  // 2. Handle awaiting_human branch
  if (currentState === 'awaiting_human') {
    // Resume keywords let the patient restart the bot without staff intervention
    const wantsResume = RESUME_KEYWORDS.some((kw) => messageText.includes(kw));
    if (wantsResume) {
      logger.info('Auto-resuming bot from awaiting_human', { patientPhone });
      await upsertConversationState(clinicId, patientPhone, 'idle', {});
      currentState = 'idle';
    } else {
      const lastMsg      = stateRow?.last_message_at ? new Date(stateRow.last_message_at) : new Date(0);
      const msElapsed    = Date.now() - lastMsg.getTime();
      const hoursSince   = msElapsed / (1000 * 60 * 60);
      const minutesSince = msElapsed / (1000 * 60);

      if (hoursSince >= 24) {
        // Stale — auto-reset to idle and fall through
        logger.info('Auto-resetting stale awaiting_human', { patientPhone });
        await upsertConversationState(clinicId, patientPhone, 'idle', {});
        currentState = 'idle';
      } else {
        // Rate-limit the "received" reply to once per 5 minutes
        if (minutesSince < 5) return null;
        await upsertConversationState(clinicId, patientPhone, 'awaiting_human', stateData);
        return 'تم استلام رسالتك ✅ فريق العيادة سيرد عليك قريباً.';
      }
    }
  }

  // 3. Route to the correct state handler
  const ctx   = { clinicId, patientPhone, patientId, messageText, clinic };
  let   reply;

  try {
    switch (currentState) {
      case 'idle':
        reply = await handleIdle(ctx);
        break;
      case 'collecting_info':
        reply = await handleCollectingInfo({ ...ctx, stateData });
        break;
      case 'checking_slots':
        reply = await handleCheckingSlots({ ...ctx, stateData });
        break;
      case 'awaiting_confirmation':
        reply = await handleAwaitingConfirmation({ ...ctx, stateData });
        break;
      case 'awaiting_cancel_confirm':
        reply = await handleAwaitingCancelConfirm({ ...ctx, stateData });
        break;
      case 'awaiting_duplicate_decision':
        reply = await handleAwaitingDuplicateDecision({ ...ctx, stateData });
        break;
      default:
        logger.warn('Unknown state — resetting to idle', { currentState, patientPhone });
        await upsertConversationState(clinicId, patientPhone, 'idle', {});
        reply = await handleIdle(ctx);
    }
  } catch (err) {
    logger.error('Handler error', { state: currentState, error: err.message });
    reply = 'عذراً، صار خطأ تقني. حاول مرة ثانية بعد شوي. 🙏';
  }

  reply = reply || 'عذراً، ما قدرت أفهم طلبك. حاول مرة ثانية.';

  // 4. Persist the assistant reply
  await saveMessage({
    clinicId,
    patientId,
    patientPhone,
    role:    'assistant',
    content: reply,
  }).catch((err) => logger.warn('saveMessage (assistant) failed', { error: err.message }));

  return reply;
}

// ══════════════════════════════════════════════════════════════════════════════
// State handlers
// ══════════════════════════════════════════════════════════════════════════════

// ── handleIdle ────────────────────────────────────────────────────────────────

async function handleIdle({ clinicId, patientPhone, patientId, messageText, clinic }) {
  // 0. Try FAQ lookup first — zero AI tokens
  const faqAnswer = await searchFAQ(clinicId, messageText);
  if (faqAnswer) return faqAnswer;

  // 1. Classify intent with a minimal single-word AI call
  const now       = dayjs().tz(TIMEZONE);
  const classifyPrompt = `عيادة ${clinic.name} — د.${clinic.doctor_name}
الدوام اليوم: ${getTodayHours(clinic, now)}
الوقت: ${now.format('HH:mm')}

رسالة المريض: "${messageText}"

صنّف الرسالة بكلمة واحدة فقط:
booking | cancellation | inquiry | greeting | urgent

الجواب:`;

  const aiRes  = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 10,
    messages:   [{ role: 'user', content: classifyPrompt }],
  });
  const intent = aiRes.choices[0].message.content.trim().toLowerCase();
  logger.info('Intent classified', { patientPhone, intent, preview: messageText.slice(0, 60) });

  // ── booking ────────────────────────────────────────────────────────────────
  if (intent.includes('booking')) {
    // Prevent duplicate bookings — check for an existing upcoming appointment
    const existingAppt = await getNextAppointment(clinicId, patientPhone);
    if (existingAppt) {
      const apptTime = formatAppointmentTime(existingAppt.scheduled_at);
      await upsertConversationState(clinicId, patientPhone, 'awaiting_duplicate_decision', {
        intent:                    'duplicate_check',
        existing_appointment_id:   existingAppt.id,
        existing_appointment_time: apptTime,
      });
      return `عندك موعد محجوز مسبقاً يوم ${apptTime} 📅\n\nتريد تلغيه وتحجز غيره؟ (نعم / لا)`;
    }

    const extracted = extractBookingInfo(messageText);

    if (extracted.name && extracted.reason) {
      // All info present in the first message — skip collecting_info
      const slots = await getAvailableSlots(clinicId, extracted.time_preference, clinic.working_hours || {});
      if (slots.length === 0) {
        await upsertConversationState(clinicId, patientPhone, 'idle', {});
        return 'عذراً، ما اكو مواعيد متاحة هاي الفترة.\nتكدر تتصل بالعيادة مباشرة.';
      }
      await upsertConversationState(clinicId, patientPhone, 'checking_slots', {
        intent: 'booking', patient_name: extracted.name,
        reason: extracted.reason, candidate_slots: slots,
      });
      return formatSlotsMessage(slots);
    }

    // Missing info — ask for it
    await upsertConversationState(clinicId, patientPhone, 'collecting_info', {
      intent:          'booking',
      patient_name:    extracted.name,
      reason:          extracted.reason,
      time_preference: extracted.time_preference,
    });

    if (!extracted.name && !extracted.reason) {
      return `بكل سرور! 😊 أحتاج منك:\n1️⃣ اسمك الكامل؟\n2️⃣ سبب الزيارة؟`;
    }
    if (!extracted.name) return 'شنو اسمك الكامل؟';
    return 'شنو سبب الزيارة؟';
  }

  // ── cancellation ────────────────────────────────────────────────────────────
  if (intent.includes('cancellation')) {
    const appt = await getNextAppointment(clinicId, patientPhone);
    if (!appt) return 'ما عندك مواعيد قادمة محجوزة للإلغاء.';

    const apptTime = formatAppointmentTime(appt.scheduled_at);
    await upsertConversationState(clinicId, patientPhone, 'awaiting_cancel_confirm', {
      intent:           'cancellation',
      appointment_id:   appt.id,
      appointment_time: apptTime,
      patient_name:     appt.patient_name || '',
    });
    const nameNote = appt.patient_name ? ` باسم "${appt.patient_name}"` : '';
    return `عندك موعد يوم ${apptTime}${nameNote}.\nتريد تلغيه؟ (نعم / لا)`;
  }

  // ── urgent ─────────────────────────────────────────────────────────────────
  if (intent.includes('urgent')) {
    await escalateToHuman(clinicId, patientPhone, 'حالة طارئة');
    const phone = clinic.phone_number ? `\n📞 ${clinic.phone_number}` : '';
    return `شكراً لتواصلك 🙏\nفهمنا إنك تحتاج مساعدة عاجلة. سيتواصل معك أحد من فريق العيادة فوراً.${phone}`;
  }

  // ── greeting ────────────────────────────────────────────────────────────────
  if (intent.includes('greeting')) {
    return `وعليكم السلام! أهلاً وسهلاً بعيادة ${clinic.name} 😊\nشنو أكدر أساعدك؟ حجز موعد؟ إلغاء؟ سؤال عن العيادة؟`;
  }

  // ── inquiry — answer with minimal AI prompt ────────────────────────────────
  return answerInquiry(messageText, clinic);
}

// ── handleCollectingInfo ──────────────────────────────────────────────────────

async function handleCollectingInfo({ clinicId, patientPhone, patientId, messageText, clinic, stateData }) {
  const data = { ...stateData };

  // Fill the first missing field with whatever the patient sent
  if (!data.patient_name) {
    data.patient_name = messageText.trim();
  } else if (!data.reason) {
    data.reason = messageText.trim();
  }

  // Still missing?
  if (!data.patient_name) {
    await upsertConversationState(clinicId, patientPhone, 'collecting_info', data);
    return 'اسمك الكامل؟';
  }
  if (!data.reason) {
    await upsertConversationState(clinicId, patientPhone, 'collecting_info', data);
    return 'سبب الزيارة؟';
  }

  // All info collected — fetch slots
  const slots = await getAvailableSlots(clinicId, data.time_preference, clinic.working_hours || {});
  if (slots.length === 0) {
    await upsertConversationState(clinicId, patientPhone, 'idle', {});
    return 'للأسف ما اكو مواعيد متاحة هاي الأسبوع.\nتكدر تتصل بالعيادة مباشرة.';
  }

  await upsertConversationState(clinicId, patientPhone, 'checking_slots', {
    ...data,
    candidate_slots: slots,
  });
  return formatSlotsMessage(slots);
}

// ── handleCheckingSlots ───────────────────────────────────────────────────────

async function handleCheckingSlots({ clinicId, patientPhone, patientId, messageText, clinic, stateData }) {
  const slots = stateData.candidate_slots || [];

  // Patient asking for different time options?
  const wantsDifferent = ['ثاني','غير','بكره','يوم ثاني','وقت ثاني','مو هذا','الأسبوع الجاي']
    .some((k) => messageText.includes(k));

  if (wantsDifferent) {
    const newSlots = await getAvailableSlots(clinicId, messageText, clinic.working_hours || {});
    const list = newSlots.length > 0 ? newSlots : slots;
    await upsertConversationState(clinicId, patientPhone, 'checking_slots', {
      ...stateData,
      candidate_slots: list,
    });
    return newSlots.length > 0
      ? formatSlotsMessage(newSlots)
      : `ما اكو مواعيد ثانية بهاي الفترة. اختار من المواعيد الموجودة:\n${formatSlotsMessage(slots)}`;
  }

  const chosenSlot = detectSlotChoice(messageText, slots);

  if (!chosenSlot) {
    return `اختار رقم الموعد المناسب 👇\n${formatSlotsMessage(slots)}`;
  }

  await upsertConversationState(clinicId, patientPhone, 'awaiting_confirmation', {
    intent:        'booking',
    patient_name:  stateData.patient_name,
    reason:        stateData.reason,
    selected_slot: chosenSlot,
  });

  return `تأكيد الحجز:\n👤 ${stateData.patient_name}\n📋 ${stateData.reason}\n📅 ${chosenSlot.formatted}\n\nصح؟ (نعم / لا)`;
}

// ── handleAwaitingConfirmation ────────────────────────────────────────────────

async function handleAwaitingConfirmation({ clinicId, patientPhone, patientId, messageText, clinic, stateData }) {
  const isPositive = POSITIVE_WORDS.some((w) => messageText.includes(w));
  const isNegative = NEGATIVE_WORDS.some((w) => messageText.includes(w));

  if (isPositive) {
    let appt;
    try {
      appt = await createAppointment({
        clinicId,
        patientId,
        patientName:     stateData.patient_name,
        reason:          stateData.reason,
        scheduledAt:     stateData.selected_slot.datetime,
        durationMinutes: clinic.appointment_duration_minutes || 30,
        clinic,
      });
    } catch (err) {
      logger.error('createAppointment failed', { error: err.message });
      await upsertConversationState(clinicId, patientPhone, 'idle', {});
      return 'عذراً، صار خطأ أثناء الحجز. حاول مرة ثانية أو تواصل مع العيادة مباشرة.';
    }

    await upsertConversationState(clinicId, patientPhone, 'idle', {});

    const lines = [
      'تم تثبيت موعدك بنجاح! ✅',
      '',
      `📅 ${stateData.selected_slot.formatted}`,
      `🎫 رقمك بالدور: ${appt.queue_number}`,
    ];
    if (appt.estimated_arrival) lines.push(`⏰ وقتك التقريبي: ${appt.estimated_arrival}`);
    lines.push(
      `👤 ${stateData.patient_name}`,
      `📝 ${stateData.reason}`,
      '',
      `📍 ${clinic.address}`,
      '',
      'راح نذكرك قبل الموعد بيوم 😊 لو تحتاج تلغي كلمنا!'
    );

    return lines.join('\n');
  }

  if (isNegative) {
    const slots = await getAvailableSlots(clinicId, null, clinic.working_hours || {});
    if (slots.length === 0) {
      await upsertConversationState(clinicId, patientPhone, 'idle', {});
      return 'لا مشكلة! ما اكو مواعيد ثانية متاحة حالياً. كلمنا لاحقاً 😊';
    }
    await upsertConversationState(clinicId, patientPhone, 'checking_slots', {
      intent:          'booking',
      patient_name:    stateData.patient_name,
      reason:          stateData.reason,
      candidate_slots: slots,
    });
    return `لا مشكلة 😊 اختار موعد ثاني:\n${formatSlotsMessage(slots)}`;
  }

  // Unclear — repeat the confirmation prompt
  return `تأكيد الحجز:\n👤 ${stateData.patient_name}\n📋 ${stateData.reason}\n📅 ${stateData.selected_slot.formatted}\n\nاكتب "نعم" للتأكيد أو "لا" للتغيير`;
}

// ── handleAwaitingCancelConfirm ───────────────────────────────────────────────

async function handleAwaitingCancelConfirm({ clinicId, patientPhone, patientId, messageText, clinic, stateData }) {
  const isPositive = POSITIVE_WORDS.some((w) => messageText.includes(w));
  const isNegative = NEGATIVE_WORDS.some((w) => messageText.includes(w));

  if (isPositive) {
    const { error } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', stateData.appointment_id);

    if (error) logger.error('cancelAppointment failed', { error: error.message, id: stateData.appointment_id });

    await upsertConversationState(clinicId, patientPhone, 'idle', {});
    return `تم إلغاء موعدك ليوم ${stateData.appointment_time} ✅\nإذا تريد تحجز موعد جديد كلمنا 😊`;
  }

  if (isNegative) {
    await upsertConversationState(clinicId, patientPhone, 'idle', {});
    return 'تمام، موعدك محجوز كما هو 👍';
  }

  return `موعدك يوم ${stateData.appointment_time}\nاكتب "نعم" للإلغاء أو "لا" للإبقاء عليه`;
}

// ── handleAwaitingDuplicateDecision ───────────────────────────────────────────

async function handleAwaitingDuplicateDecision({ clinicId, patientPhone, patientId, messageText, clinic, stateData }) {
  // Normalize message: trim, collapse spaces, lowercase
  const msg = messageText.trim().replace(/\s+/g, ' ').toLowerCase();

  const positiveWords = [
    'نعم','اي','ايه','آيه','اه','أه','صح','اكيد','أكيد',
    'تمام','زين','اوكي','أوكي','ماشي','موافق','يلا','عدل','طيب','يعني نعم',
  ];
  const negativeWords = [
    'لا','لأ','لآ','لاء','مو','ما','ابقيه','خليه','بلا','ما ابي','لا اريد',
  ];

  const isPositive = positiveWords.some((w) => msg.includes(w));
  const isNegative = negativeWords.some((w) => msg.includes(w));

  if (isPositive) {
    // 1. Cancel the existing appointment
    const { error } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', stateData.existing_appointment_id);

    if (error) logger.error('handleAwaitingDuplicateDecision cancel failed', { error: error.message });

    // 2. Transition to collecting_info to start a fresh booking
    await upsertConversationState(clinicId, patientPhone, 'collecting_info', {
      intent:          'booking',
      patient_name:    null,
      reason:          null,
      time_preference: null,
    });

    // 3. Return confirmation + first question
    return `تم إلغاء موعدك ✅\nالحين نحجز موعد جديد.\n\nاسمك الكامل؟`;
  }

  if (isNegative) {
    await upsertConversationState(clinicId, patientPhone, 'idle', {});
    return `تمام، موعدك محجوز يوم ${stateData.existing_appointment_time} 👍`;
  }

  // Unclear — repeat the question
  return `عندك موعد يوم ${stateData.existing_appointment_time}\nتريد تلغيه وتحجز غيره؟ (نعم / لا)`;
}

// ══════════════════════════════════════════════════════════════════════════════
// DB helpers
// ══════════════════════════════════════════════════════════════════════════════

async function getNextAppointment(clinicId, patientPhone) {
  const { data: patient } = await supabase
    .from('patients')
    .select('id')
    .eq('clinic_id', clinicId)
    .eq('phone_number', patientPhone)
    .maybeSingle();

  if (!patient) return null;

  const { data } = await supabase
    .from('appointments')
    .select('id, scheduled_at, patient_name')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patient.id)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return data;
}

async function createAppointment({ clinicId, patientId, patientName, reason, scheduledAt, durationMinutes, clinic }) {
  const day      = dayjs(scheduledAt).tz(TIMEZONE);
  const dayStart = day.startOf('day').toISOString();
  const dayEnd   = day.endOf('day').toISOString();

  // Count existing appointments to determine queue position
  const { count } = await supabase
    .from('appointments')
    .select('*', { count: 'exact', head: true })
    .eq('clinic_id', clinicId)
    .in('status', ['scheduled', 'confirmed'])
    .gte('scheduled_at', dayStart)
    .lte('scheduled_at', dayEnd);

  const queueNumber = (count || 0) + 1;

  // Try to compute an estimated arrival time from clinic working_hours
  let estimatedArrival = null;
  try {
    const dayKey = day.format('dddd').toLowerCase();
    const shift  = (clinic.working_hours?.[dayKey]);
    if (shift?.open && !shift.closed) {
      const [sh, sm] = shift.open.split(':').map(Number);
      const estimated = day.hour(sh).minute(sm || 0).second(0)
        .add((queueNumber - 1) * (durationMinutes || 30), 'minute');
      estimatedArrival = formatTime12(estimated.format('HH:mm'));
    }
  } catch (_) { /* non-critical */ }

  const { data: appt, error } = await supabase
    .from('appointments')
    .insert({
      clinic_id:        clinicId,
      patient_id:       patientId,
      patient_name:     patientName,
      reason,
      scheduled_at:     scheduledAt,
      duration_minutes: durationMinutes || 30,
      queue_number:     queueNumber,
      status:           'scheduled',
    })
    .select('id, queue_number')
    .single();

  if (error) throw new Error(error.message);
  return { ...appt, estimated_arrival: estimatedArrival };
}

// ══════════════════════════════════════════════════════════════════════════════
// Formatting / classification helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Search FAQs with keyword matching — no AI tokens.
 */
async function searchFAQ(clinicId, message) {
  try {
    const { data: faqs } = await supabase
      .from('faqs')
      .select('question, answer, keywords')
      .eq('clinic_id', clinicId)
      .eq('is_active', true);

    if (!faqs || faqs.length === 0) return null;

    const normalizedMsg = message
      .replace(/[؟?!،,]/g, '')
      .trim()
      .toLowerCase();

    // Semantic category shortcuts — map common question patterns to FAQ keywords
    const PATTERNS = {
      location:  ['وين', 'فين', 'موقع', 'عنوان', 'كيف اوصل'],
      hours:     ['دوام', 'ساعات', 'تفتح', 'تسكر', 'متى', 'يمته'],
      price:     ['سعر', 'كلفة', 'كم', 'فلوس', 'دينار', 'اجور'],
      services:  ['خدمات', 'تعملون', 'تعالجون', 'اختصاص'],
      insurance: ['تامين', 'بطاقة', 'صحي'],
    };

    const scored = faqs.map((faq) => {
      let score = 0;
      const keywords = faq.keywords || [];
      const msgWords = normalizedMsg.split(/\s+/).filter((w) => w.length > 2);

      // Exact keyword match in message (highest signal)
      for (const kw of keywords) {
        if (normalizedMsg.includes(kw)) score += 3;
      }

      // Partial overlap between message words and keywords
      for (const word of msgWords) {
        for (const kw of keywords) {
          if (kw.includes(word) || word.includes(kw)) score += 1;
        }
      }

      // Category-level boost: message mentions a topic → check if FAQ covers it
      for (const [category, words] of Object.entries(PATTERNS)) {
        if (words.some((w) => normalizedMsg.includes(w))) {
          for (const kw of keywords) {
            if (kw.includes(category) || words.some((w) => kw.includes(w))) {
              score += 2;
            }
          }
        }
      }

      return { ...faq, score };
    });

    const best = scored.sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 2 ? best.answer : null;
  } catch {
    return null;
  }
}

/**
 * Answer a general inquiry with a minimal AI prompt (~150 tokens).
 */
async function answerInquiry(message, clinic) {
  const prompt = `عيادة "${clinic.name}" — د.${clinic.doctor_name} (${clinic.specialty})
العنوان: ${clinic.address}
سعر الكشفية: ${clinic.consultation_price ? clinic.consultation_price + ' دينار' : 'غير محدد'}

سؤال المريض: "${message}"
أجب بجملة أو جملتين باللهجة العراقية. لا تعطي نصائح طبية:`;

  const res = await openai.chat.completions.create({
    model:      'gpt-4o-mini',
    max_tokens: 150,
    messages:   [{ role: 'user', content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

function formatSlotsMessage(slots) {
  if (!slots || slots.length === 0) return 'ما اكو مواعيد متاحة هاي الأسبوع.';
  const EMOJI_NUMS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
  return 'المواعيد المتاحة:\n' +
    slots.map((s, i) => `${EMOJI_NUMS[i] || (i + 1) + '.'} ${s.formatted}`).join('\n') +
    '\n\nاختار رقم الموعد:';
}

/**
 * Detect which slot the patient chose by number (1,2,٢…) or day name.
 */
function detectSlotChoice(message, slots) {
  const ARABIC_DIGITS = ['١','٢','٣','٤','٥'];
  for (let i = 0; i < slots.length; i++) {
    if (message.includes(String(i + 1)) || message.includes(ARABIC_DIGITS[i] || '')) {
      return slots[i];
    }
  }
  // Fall back to matching the day name from formatted ("الأحد ...")
  for (const slot of slots) {
    const dayName = slot.formatted.split(' ')[0];
    if (dayName && message.includes(dayName)) return slot;
  }
  return null;
}

/**
 * Naive extraction — returns name only when message is short and looks like
 * just a name (no booking keywords, no time keywords).
 */
function extractBookingInfo(message) {
  const timeKeywords    = ['بكره','الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس',
                           'هاي الأسبوع','الأسبوع الجاي','اليوم','بعد غد'];
  const bookingKeywords = ['احجز','اريد','ابي','موعد','حجز','أريد','أبي','ابغى'];

  const timePref  = timeKeywords.find((k) => message.includes(k)) || null;
  const words     = message.trim().split(/\s+/);
  const hasBookKW = bookingKeywords.some((k) => message.includes(k));
  const hasTimeKW = Boolean(timePref);
  const likelyName = words.length <= 3 && !hasBookKW && !hasTimeKW
    ? message.trim()
    : null;

  return { name: likelyName, reason: null, time_preference: timePref };
}

function getTodayHours(clinic, now) {
  const keys    = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayConf = clinic.working_hours?.[keys[now.day()]];
  if (!dayConf || dayConf.closed) return 'مغلق اليوم';
  if (dayConf.open && dayConf.close) return `${dayConf.open} - ${dayConf.close}`;
  return 'الدوام متاح';
}

function formatAppointmentTime(isoString) {
  return formatArabicDay(dayjs(isoString).tz(TIMEZONE));
}

module.exports = { handleMessage };
