'use strict';

/**
 * tools.js — Hybrid Agentic Architecture
 *
 * Self-validating tool implementations for the LLM agent.
 * Each tool validates its own inputs and returns clear Arabic error messages
 * that the LLM can interpret and act on.
 *
 * Tools (7 total):
 *   1. check_availability      — returns available days for booking
 *   2. book_appointment        — books a new appointment
 *   3. get_my_appointments     — returns patient's upcoming appointments (with IDs)
 *   4. cancel_appointment      — cancels a specific appointment by ID
 *   5. reschedule_appointment  — cancels old + books new (atomic-ish)
 *   6. escalate_to_doctor      — routes patient to human doctor review
 *
 * Helper functions (reused from old tools.js):
 *   - getDayConfig, getBlockForDay, parseArabicDatePreference
 *   - formatArabicDay, getDynamicScheduleSummary, getAbsenceSummary
 */

const { supabase, upsertConversationState } = require('../services/supabase');
const { getBaghdadNow, formatTime12, TIMEZONE } = require('../utils/time');
const logger = require('../utils/logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const BOOKING_HOUR = 12; // appointments stored at noon Baghdad as a day marker

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (OpenAI-compatible format — works with DeepSeek SDK)
// ═══════════════════════════════════════════════════════════════════════════════

const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description:
        'يعرض الأيام المتاحة للحجز خلال الأسبوعين القادمين. ' +
        'استدعها عندما المريض يسأل عن أي يوم فيه مجال، أو قبل الحجز لتأكيد التوفر.',
      parameters: {
        type: 'object',
        properties: {
          date_preference: {
            type: 'string',
            description:
              'تفضيل المريض الزمني كما قاله: باجر، الخميس، اقرب موعد، 2026-06-15، الخ.',
          },
        },
        required: ['date_preference'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'يحجز موعد للمريض. ' +
        'لا تستدعيها إلا بعد: 1) الحصول على الاسم الثنائي الكامل، 2) تحديد التاريخ. ' +
        'إذا الرسالة صوتية، أكد المعلومات مع المريض أولاً.',
      parameters: {
        type: 'object',
        properties: {
          patient_name: {
            type: 'string',
            description: 'الاسم الكامل للمريض (ثنائي على الأقل: الاسم واسم الأب)',
          },
          appointment_date: {
            type: 'string',
            description: 'تاريخ الحجز بصيغة YYYY-MM-DD',
          },
        },
        required: ['patient_name', 'appointment_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_my_appointments',
      description:
        'تعرض جميع مواعيد المريض القادمة مع IDs كل موعد. ' +
        'استدعها قبل الإلغاء أو التأجيل إذا المريض عنده أكثر من موعد. ' +
        'لا تسأل المريض عن اسمه أو رقمه — النظام يعرفه تلقائياً.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description:
        'تلغي موعد محدد. يجب تحديد appointment_id (تحصله من get_my_appointments). ' +
        'لا تستدعيها بدون تأكيد صريح من المريض.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'معرف الموعد UUID — تحصله من get_my_appointments',
          },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description:
        'تأجيل موعد قائم إلى يوم آخر. ' +
        'تلغي الموعد القديم وتحجز موعد جديد بنفس الاسم تلقائياً. ' +
        'يجب تأكيد اليوم الجديد مع المريض قبل الاستدعاء.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description: 'معرف الموعد المراد تأجيله',
          },
          new_date: {
            type: 'string',
            description: 'التاريخ الجديد بصيغة YYYY-MM-DD',
          },
        },
        required: ['appointment_id', 'new_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_doctor',
      description:
        'تحول طلب المريض للطبيب للمراجعة. ' +
        'استدعها عندما المريض يوصف مشكلة طبية أو أعراض أو يطلب متابعة علاج. ' +
        'لازم تجمع وصف المشكلة والأعراض من المريض أولاً قبل الاستدعاء.',
      parameters: {
        type: 'object',
        properties: {
          complaint: {
            type: 'string',
            description: 'وصف مشكلة المريض أو سبب التصعيد',
          },
          symptoms: {
            type: 'string',
            description: 'الأعراض الحالية إن وُجدت (اختياري)',
          },
          is_followup: {
            type: 'boolean',
            description: 'هل هذه متابعة لزيارة سابقة للعيادة',
          },
        },
        required: ['complaint', 'is_followup'],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

async function executeTool(name, input, context) {
  logger.info('[Tool] Executing', { tool: name, input });
  switch (name) {
    case 'check_availability':      return checkAvailability(input, context);
    case 'book_appointment':        return bookAppointment(input, context);
    case 'get_my_appointments':     return getMyAppointments(input, context);
    case 'cancel_appointment':      return cancelAppointment(input, context);
    case 'reschedule_appointment':  return rescheduleAppointment(input, context);
    case 'escalate_to_doctor':      return escalateToDoctor(input, context);
    default:
      return { error: `أداة غير معروفة: ${name}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 1: check_availability
// Ported from old tools.js checkAvailability() lines 113-220
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAvailability({ date_preference }, { clinic }) {
  try {
    const now        = getBaghdadNow();
    const searchFrom = parseArabicDatePreference(date_preference, now).startOf('day');
    const horizon    = searchFrom.add(14, 'day').endOf('day');

    const [bookedRes, schedulesRes, blocksRes] = await Promise.all([
      supabase
        .from('appointments')
        .select('scheduled_at')
        .eq('clinic_id', clinic.id)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', searchFrom.toISOString())
        .lte('scheduled_at', horizon.toISOString()),

      supabase
        .from('availability_schedules')
        .select('day_of_week, specific_date, is_working_day, daily_capacity, shifts')
        .eq('clinic_id', clinic.id),

      supabase
        .from('blocked_periods')
        .select('start_at, end_at, is_full_day, substitute_doctor_name')
        .eq('clinic_id', clinic.id)
        .lt('start_at', horizon.toISOString())
        .gt('end_at',   searchFrom.toISOString()),
    ]);

    if (bookedRes.error)    return { error: 'فشل في تحميل المواعيد المحجوزة' };
    if (schedulesRes.error) logger.warn('check_availability: schedules load warning', { e: schedulesRes.error.message });
    if (blocksRes.error)    logger.warn('check_availability: blocks load warning', { e: blocksRes.error.message });

    const schedules = schedulesRes.data || [];
    const blocks    = blocksRes.data    || [];

    // Count booked per day
    const bookedByDay = {};
    for (const row of (bookedRes.data || [])) {
      const k = dayjs(row.scheduled_at).tz(TIMEZONE).format('YYYY-MM-DD');
      bookedByDay[k] = (bookedByDay[k] || 0) + 1;
    }

    const todayStr = now.format('YYYY-MM-DD');
    const days     = [];
    let   day      = searchFrom;

    while (day.isBefore(horizon) && days.length < 7) {
      const dateStr = day.format('YYYY-MM-DD');

      if (dateStr >= todayStr) {
        const { isWorking, capacity, shifts } = getDayConfig(day, schedules, clinic.working_hours || {});
        const block             = getBlockForDay(day, blocks);
        const isBlockedNoSub    = block && !block.substitute_doctor_name;

        if (isWorking && !isBlockedNoSub) {
          const booked    = bookedByDay[dateStr] || 0;
          const unlimited = capacity === null || capacity === undefined;
          const isFull    = !unlimited && booked >= capacity;
          const shift     = shifts[0];

          // For today: skip if shift already ended
          const todayShiftEnded = dateStr === todayStr && (() => {
            if (!shift?.close) return false;
            const [ch, cm] = shift.close.split(':').map(Number);
            return !now.isBefore(day.hour(ch).minute(cm).second(0).millisecond(0));
          })();

          if (!isFull && !todayShiftEnded) {
            days.push({
              date:          dateStr,
              display:       formatArabicDay(day) + (block?.substitute_doctor_name ? ` (الطبيب البديل: ${block.substitute_doctor_name})` : ''),
              booked,
              capacity:      unlimited ? null : capacity,
              remaining:     unlimited ? null : capacity - booked,
              working_hours: shift ? `${formatTime12(shift.open)}${shift.close ? ' — ' + formatTime12(shift.close) : ''}` : null,
            });
          }
        }
      }
      day = day.add(1, 'day');
    }

    if (days.length === 0) {
      return { available: false, message: 'ما في أيام متاحة للحجز بالفترة المطلوبة. جرب تاريخاً آخر.', days: [] };
    }
    return { available: true, days, message: 'هذي الأيام المتاحة للحجز:' };

  } catch (err) {
    logger.error('[Tool] checkAvailability error', { error: err.message });
    return { error: 'خطأ في فحص الأيام المتاحة: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 2: book_appointment
// Merged from old tools.js bookAppointment() + execute.js doBooking()
// ═══════════════════════════════════════════════════════════════════════════════

async function bookAppointment({ patient_name, appointment_date }, { clinic, patient }) {
  try {
    // Inner validation (defense-in-depth on top of guardrails.js)
    const nameParts = (patient_name || '').trim().split(/\s+/).filter(Boolean);
    if (nameParts.length < 2) {
      return { success: false, error: 'الاسم يجب أن يكون ثنائي على الأقل (الاسم واسم الأب).' };
    }

    const now       = getBaghdadNow();
    const targetDay = dayjs.tz(appointment_date, 'YYYY-MM-DD', TIMEZONE).startOf('day');

    if (!targetDay.isValid()) {
      return { success: false, error: 'التاريخ غير صحيح. استخدم صيغة YYYY-MM-DD.' };
    }
    if (targetDay.format('YYYY-MM-DD') < now.format('YYYY-MM-DD')) {
      return { success: false, error: 'لا يمكن الحجز في تاريخ ماضٍ.' };
    }

    const dayStartISO = targetDay.toISOString();
    const dayEndISO   = targetDay.endOf('day').toISOString();

    // Check active bookings limit (max 3)
    const { count: activeCount } = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true })
      .eq('clinic_id', clinic.id)
      .eq('patient_id', patient.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', now.toISOString());

    if ((activeCount || 0) >= 3) {
      return { success: false, error: 'لديك 3 مواعيد نشطة وهذا الحد الأقصى. يجب إلغاء أحدها أولاً.' };
    }

    const [schedulesRes, blocksRes, bookedRes] = await Promise.all([
      supabase.from('availability_schedules').select('day_of_week, specific_date, is_working_day, daily_capacity, shifts').eq('clinic_id', clinic.id),
      supabase.from('blocked_periods').select('start_at, end_at, is_full_day, substitute_doctor_name, substitute_doctor_note').eq('clinic_id', clinic.id).lt('start_at', dayEndISO).gt('end_at', dayStartISO),
      supabase.from('appointments').select('id, patient_id, patient_name').eq('clinic_id', clinic.id).in('status', ['scheduled', 'confirmed']).gte('scheduled_at', dayStartISO).lte('scheduled_at', dayEndISO),
    ]);

    const schedules   = schedulesRes.data || [];
    const blocks      = blocksRes.data    || [];
    const bookedAppts = bookedRes.data    || [];
    const booked      = bookedAppts.length;

    // Duplicate booking check (same name same day)
    const duplicate = bookedAppts.find(
      a => String(a.patient_id) === String(patient.id) && a.patient_name === patient_name
    );
    if (duplicate) {
      return { success: false, error: `يوجد موعد محجوز مسبقاً باسم "${patient_name}" في هذا اليوم.` };
    }

    const { isWorking, capacity, shifts } = getDayConfig(targetDay, schedules, clinic.working_hours || {});
    if (!isWorking) {
      return { success: false, error: `${formatArabicDay(targetDay)} ليس يوم دوام في العيادة.` };
    }

    const block = getBlockForDay(targetDay, blocks);
    let servedBy = null;
    let substituteNotice = '';

    if (block) {
      if (block.substitute_doctor_name) {
        servedBy = block.substitute_doctor_name;
        substituteNotice = `⚠️ ملاحظة: ${clinic.doctor_name || 'الدكتور الأساسي'} غائب هذا اليوم. الطبيب البديل: ${block.substitute_doctor_name}`;
      } else {
        return { success: false, error: `${formatArabicDay(targetDay)} الدكتور غير متوفر ولا يوجد بديل.` };
      }
    }

    const unlimited = capacity === null || capacity === undefined;
    if (!unlimited && booked >= capacity) {
      return { success: false, error: `اكتمل العدد ليوم ${formatArabicDay(targetDay)} (${capacity} موعد). جرب يوماً آخر.` };
    }

    // Check if today's shift has ended
    const shift0 = shifts[0];
    if (targetDay.format('YYYY-MM-DD') === now.format('YYYY-MM-DD') && shift0?.close) {
      const [ch, cm] = shift0.close.split(':').map(Number);
      if (!now.isBefore(targetDay.hour(ch).minute(cm).second(0).millisecond(0))) {
        return { success: false, error: `انتهى دوام الدكتور اليوم (${formatTime12(shift0.close)}). جرب تحجز ليوم ثانٍ.` };
      }
    }

    const queueNumber = booked + 1;
    const scheduledAt = targetDay.hour(BOOKING_HOUR).minute(0).second(0).millisecond(0);
    const duration    = clinic.appointment_duration_minutes || 30;

    // Compute estimated arrival
    let estimatedLine = '';
    let workHoursLine = '';
    const shift = shifts[0];
    if (shift?.open) {
      const [sh, sm] = shift.open.split(':').map(Number);
      const estimated = targetDay.hour(sh).minute(sm || 0).add((queueNumber - 1) * duration, 'minute');
      estimatedLine = `⏰ وقتك التقريبي: ${formatTime12(estimated.format('HH:mm'))}`;
      workHoursLine = `🕐 دوام العيادة: ${formatTime12(shift.open)}${shift.close ? ' — ' + formatTime12(shift.close) : ''}`;
    }

    const { data: appt, error } = await supabase
      .from('appointments')
      .insert({
        clinic_id:        clinic.id,
        patient_id:       patient.id,
        scheduled_at:     scheduledAt.toISOString(),
        duration_minutes: duration,
        queue_number:     queueNumber,
        status:           'scheduled',
        reason:           null,
        patient_name:     patient_name,
        served_by:        servedBy,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('[Tool] bookAppointment insert error', { error: error.message });
      return { success: false, error: 'فشل حفظ الموعد. حاول مرة ثانية.' };
    }

    const ref = appt.id.slice(-6).toUpperCase();

    return {
      success: true,
      message: [
        'تم تثبيت موعدك بنجاح! ✅',
        `📅 ${formatArabicDay(scheduledAt)}`,
        substituteNotice || null,
        `🎫 رقمك بالدور: ${queueNumber}`,
        estimatedLine || null,
        workHoursLine || null,
        `👤 ${patient_name}`,
        `رقم الحجز: #${ref}`,
        'راجع العيادة بهذا اليوم وبيكون دورك حسب رقمك.',
      ].filter(Boolean).join('\n'),
    };

  } catch (err) {
    logger.error('[Tool] bookAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الحجز: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 3: get_my_appointments
// Extended from old checkMyAppointment() — returns ALL upcoming with IDs
// ═══════════════════════════════════════════════════════════════════════════════

async function getMyAppointments(_input, { clinic, patient }) {
  try {
    const now = getBaghdadNow();

    const { data, error } = await supabase
      .from('appointments')
      .select('id, scheduled_at, queue_number, reason, patient_name')
      .eq('clinic_id', clinic.id)
      .eq('patient_id', patient.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(10);

    if (error) return { error: 'فشل في جلب مواعيدك.' };
    if (!data || data.length === 0) return { found: false, message: 'ما عندك أي موعد قادم مسجل حالياً.' };

    const appointments = data.map(a => {
      const d = dayjs(a.scheduled_at).tz(TIMEZONE);
      return {
        id:           a.id,
        date:         d.format('YYYY-MM-DD'),
        display:      formatArabicDay(d),
        queue_number: a.queue_number,
        patient_name: a.patient_name || null,
      };
    });

    return { found: true, count: appointments.length, appointments };

  } catch (err) {
    logger.error('[Tool] getMyAppointments error', { error: err.message });
    return { error: 'خطأ في جلب المواعيد: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 4: cancel_appointment
// Updated from old cancelAppointment() — requires explicit appointment_id
// ═══════════════════════════════════════════════════════════════════════════════

async function cancelAppointment({ appointment_id }, { clinic }) {
  try {
    // Verify appointment belongs to this clinic and is cancellable
    const { data: appt, error: fetchErr } = await supabase
      .from('appointments')
      .select('id, scheduled_at, patient_name, status')
      .eq('id', appointment_id)
      .eq('clinic_id', clinic.id)
      .maybeSingle();

    if (fetchErr || !appt) {
      return { success: false, error: 'الموعد غير موجود أو لا يخصك.' };
    }
    if (!['scheduled', 'confirmed'].includes(appt.status)) {
      return { success: false, error: 'هذا الموعد لا يمكن إلغاؤه (قد يكون ملغى مسبقاً أو مكتمل).' };
    }

    const { error: updateErr } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', appointment_id);

    if (updateErr) {
      logger.error('[Tool] cancelAppointment update error', { error: updateErr.message });
      return { success: false, error: 'فشل إلغاء الموعد. حاول مرة ثانية.' };
    }

    const d = dayjs(appt.scheduled_at).tz(TIMEZONE);
    return {
      success: true,
      message: `تم إلغاء موعد "${appt.patient_name || 'المريض'}" يوم ${formatArabicDay(d)} بنجاح ✅`,
    };

  } catch (err) {
    logger.error('[Tool] cancelAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الإلغاء: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 5: reschedule_appointment
// New tool: cancels old + books new (replaces the complex reschedule flow in old execute.js)
// ═══════════════════════════════════════════════════════════════════════════════

async function rescheduleAppointment({ appointment_id, new_date }, { clinic, patient }) {
  try {
    // Fetch the existing appointment
    const { data: oldAppt, error: fetchErr } = await supabase
      .from('appointments')
      .select('id, scheduled_at, patient_name, status')
      .eq('id', appointment_id)
      .eq('clinic_id', clinic.id)
      .maybeSingle();

    if (fetchErr || !oldAppt) {
      return { success: false, error: 'الموعد غير موجود أو لا يخصك.' };
    }
    if (!['scheduled', 'confirmed'].includes(oldAppt.status)) {
      return { success: false, error: 'لا يمكن تأجيل هذا الموعد (ملغى أو مكتمل).' };
    }

    // Cancel old appointment
    await supabase
      .from('appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', appointment_id);

    // Book new appointment with same patient_name
    const bookResult = await bookAppointment(
      { patient_name: oldAppt.patient_name, appointment_date: new_date },
      { clinic, patient }
    );

    if (!bookResult.success) {
      // Rollback: restore old appointment
      await supabase
        .from('appointments')
        .update({ status: 'scheduled', cancelled_at: null })
        .eq('id', appointment_id);

      return {
        success: false,
        error: `فشل حجز الموعد الجديد: ${bookResult.error}\nتم استعادة موعدك القديم.`,
      };
    }

    const oldD = dayjs(oldAppt.scheduled_at).tz(TIMEZONE);
    return {
      success: true,
      message: `تم تأجيل موعد "${oldAppt.patient_name}" من يوم ${formatArabicDay(oldD)} ✅\n\n${bookResult.message}`,
    };

  } catch (err) {
    logger.error('[Tool] rescheduleAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في التأجيل: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL 6: escalate_to_doctor
// Updated from old escalateToHuman() — richer complaint data, drops gate_collecting state
// ═══════════════════════════════════════════════════════════════════════════════

async function escalateToDoctor({ complaint, symptoms, is_followup }, { clinic, patient, patientPhone }) {
  try {
    const summary = [
      `👤 ${patient.name || patientPhone}`,
      `📋 متابعة زيارة سابقة: ${is_followup ? 'نعم' : 'لا'}`,
      `🩺 المشكلة: ${complaint}`,
      symptoms ? `⚠️ الأعراض: ${symptoms}` : null,
      `🕐 وقت الطلب: ${getBaghdadNow().format('YYYY-MM-DD HH:mm')} (بغداد)`,
    ].filter(Boolean).join('\n');

    await upsertConversationState(clinic.id, patientPhone, 'doctor_pending', {
      escalation: {
        complaint,
        symptoms:     symptoms || null,
        is_followup:  !!is_followup,
        summary,
        escalated_at: new Date().toISOString(),
      },
    });

    logger.info('[Tool] escalateToDoctor — state set to doctor_pending', { patientPhone });

    return {
      success: true,
      message:
        'تم تحويل طلبك للطبيب 👨‍⚕️\n' +
        'سيتم الرد هنا بعد المراجعة. الرجاء الانتظار.\n' +
        'إذا احتجت شي ثاني (حجز، استفسار) تكدر تسأل عادي.',
    };

  } catch (err) {
    logger.error('[Tool] escalateToDoctor error', { error: err.message });
    return { success: false, error: 'خطأ في التصعيد: ' + err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// Preserved from old tools.js — used by check_availability, book_appointment,
// validate.js (via systemPrompt.js), and other internal logic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolves whether a day is a working day + its daily capacity.
 * Priority: specific_date override > day_of_week rule > clinic.working_hours fallback.
 */
function getDayConfig(dayObj, schedules, clinicWorkingHours) {
  const dateStr = dayObj.format('YYYY-MM-DD');
  const dayNum  = dayObj.day();

  const override = schedules.find(s => s.specific_date === dateStr);
  if (override) {
    return { isWorking: override.is_working_day, capacity: override.daily_capacity ?? null, shifts: override.shifts || [] };
  }

  const weekly = schedules.find(s => s.day_of_week === dayNum && s.specific_date === null);
  if (weekly) {
    return { isWorking: weekly.is_working_day, capacity: weekly.daily_capacity ?? null, shifts: weekly.shifts || [] };
  }

  const dayKey  = dayObj.format('dddd').toLowerCase();
  const dayConf = clinicWorkingHours[dayKey];
  if (!dayConf || dayConf.closed) return { isWorking: false, capacity: null, shifts: [] };
  return {
    isWorking: true,
    capacity:  null,
    shifts:    [{ open: dayConf.open || '09:00', close: dayConf.close || '17:00' }],
  };
}

/**
 * Returns the blocked_period record that overlaps the given calendar day, or undefined.
 */
function getBlockForDay(targetDay, blocks) {
  const targetDateStr = dayjs(targetDay).tz(TIMEZONE).format('YYYY-MM-DD');
  return (blocks || []).find(b => {
    const start = dayjs(b.start_at).tz(TIMEZONE).format('YYYY-MM-DD');
    const end   = dayjs(b.end_at).tz(TIMEZONE).format('YYYY-MM-DD');
    return targetDateStr >= start && targetDateStr <= end;
  });
}

/**
 * Parses an Arabic/English date preference string into a dayjs object.
 * Covers: اليوم / باجر / بعد غد / day names / YYYY-MM-DD / "اقرب موعد"
 */
function parseArabicDatePreference(pref, now) {
  const lower = (pref || '').toLowerCase().trim();

  if (lower.includes('اليوم') || lower.includes('today')) return now.clone();

  if (lower.includes('بعد غد') || lower.includes('بعد بكره') || lower.includes('بعد باجر') ||
      lower.includes('عگب باجر') || lower.includes('عقب باجر')) return now.add(2, 'day');

  if (lower.includes('غد') || lower.includes('بكره') || lower.includes('باجر') ||
      lower.includes('tomorrow')) return now.add(1, 'day');

  if (lower.includes('الأسبوع القادم') || lower.includes('الاسبوع الجاي') ||
      lower.includes('الجاي')) return now.add(7, 'day');

  if (lower.includes('اقرب') || lower.includes('أقرب') || lower.includes('asap')) {
    // ASAP: find next available — caller should check via check_availability
    return now.add(1, 'day');
  }

  const dayNames = {
    'الأحد': 0, 'الاحد': 0, 'الاثنين': 1, 'الإثنين': 1, 'الثلاثاء': 2,
    'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  };
  for (const [name, num] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      let target = now.day(num);
      if (target.format('YYYY-MM-DD') <= now.format('YYYY-MM-DD')) target = target.add(7, 'day');
      return target;
    }
  }

  const isoMatch = /\d{4}-\d{2}-\d{2}/.exec(pref || '');
  if (isoMatch) {
    const parsed = dayjs.tz(isoMatch[0], 'YYYY-MM-DD', TIMEZONE);
    if (parsed.isValid() && parsed.format('YYYY-MM-DD') >= now.format('YYYY-MM-DD')) return parsed;
  }

  return now.add(1, 'day'); // safe default: tomorrow
}

/** Format a dayjs object as Arabic full date string */
function formatArabicDay(d) {
  const days   = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
                  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
  return `${days[d.day()]} ${d.date()} ${months[d.month()]} ${d.year()}`;
}

// ── getDynamicScheduleSummary ─────────────────────────────────────────────────
// Used by systemPrompt.js to embed the 7-day schedule in the system prompt.
// Ported from old tools.js lines 739-818.

async function getDynamicScheduleSummary(clinicId) {
  const now           = getBaghdadNow();
  const next7DaysEnd  = now.add(7, 'day').endOf('day');

  const [schedulesRes, blocksRes] = await Promise.all([
    supabase.from('availability_schedules').select('day_of_week, specific_date, is_working_day, shifts').eq('clinic_id', clinicId),
    supabase.from('blocked_periods').select('start_at, end_at, is_full_day, reason, substitute_doctor_name, substitute_doctor_note')
      .eq('clinic_id', clinicId)
      .lte('start_at', next7DaysEnd.toISOString())
      .gte('end_at', now.startOf('day').toISOString()),
  ]);

  const schedules = schedulesRes.data || [];
  const blocks    = blocksRes.data    || [];
  const daysAr    = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const lines     = ['🗓️ *أوقات الدوام للعيادة خلال الأيام القادمة:*\n'];

  for (let i = 0; i < 7; i++) {
    const targetDay  = now.add(i, 'day');
    const dayOfWeek  = targetDay.day();
    const dateStr    = targetDay.format('YYYY-MM-DD');
    const displayDate = `${daysAr[dayOfWeek]} (${targetDay.format('DD/MM')})`;

    let isWorking = false;
    let shifts    = [];

    const specificSchedule = schedules.find(s => s.specific_date === dateStr);
    if (specificSchedule) {
      isWorking = specificSchedule.is_working_day;
      shifts    = specificSchedule.shifts || [];
    } else {
      const defaultSchedule = schedules.find(s => s.day_of_week === dayOfWeek && !s.specific_date);
      if (defaultSchedule) { isWorking = defaultSchedule.is_working_day; shifts = defaultSchedule.shifts || []; }
    }

    let scheduleText = (!isWorking || shifts.length === 0) ? 'عطلة / مغلق' :
      shifts.map(sh => {
        const op = formatTime12(sh.open).replace(/^0/, '');
        const cl = formatTime12(sh.close).replace(/^0/, '');
        return `من ${op} لـ ${cl}`;
      }).join(' و ');

    // Check blocks
    const block = blocks.find(b => {
      const s = dayjs(b.start_at).tz(TIMEZONE).format('YYYY-MM-DD');
      const e = dayjs(b.end_at).tz(TIMEZONE).format('YYYY-MM-DD');
      return dateStr >= s && dateStr <= e;
    });

    if (block) {
      scheduleText = block.substitute_doctor_name
        ? scheduleText + ` (⚠️ البديل: ${block.substitute_doctor_name})`
        : 'مغلق (إجازة/غياب)';
    }

    const prefix = i === 0 ? 'اليوم ' : i === 1 ? 'غداً ' : '';
    lines.push(`🔹 *${prefix}${displayDate}:* ${scheduleText}`);
  }

  return lines.join('\n\n');
}

// ── getAbsenceSummary ─────────────────────────────────────────────────────────
// Used by systemPrompt.js to embed absence info in the system prompt.
// Ported from old tools.js lines 821-887.

async function getAbsenceSummary(clinicId) {
  const now          = getBaghdadNow();
  const next7DaysEnd = now.add(7, 'day').endOf('day');

  const [blocksRes, schedulesRes] = await Promise.all([
    supabase.from('blocked_periods').select('start_at, end_at, is_full_day, reason, substitute_doctor_name')
      .eq('clinic_id', clinicId)
      .lte('start_at', next7DaysEnd.toISOString())
      .gte('end_at', now.startOf('day').toISOString()),
    supabase.from('availability_schedules').select('*').eq('clinic_id', clinicId),
  ]);

  const blocks    = blocksRes.data    || [];
  const schedules = schedulesRes.data || [];
  const daysAr    = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const lines     = [];
  let   hasAbsence = false;

  for (let i = 0; i < 7; i++) {
    const targetDay    = now.add(i, 'day');
    const dayOfWeek    = targetDay.day();
    const targetStart  = targetDay.startOf('day').toISOString();
    const targetEnd    = targetDay.endOf('day').toISOString();
    const displayDate  = `${daysAr[dayOfWeek]} (${targetDay.format('DD/MM')})`;

    const generalSched  = schedules.find(s => s.day_of_week === dayOfWeek && s.specific_date === null);
    const specificSched = schedules.find(s => s.specific_date === targetDay.format('YYYY-MM-DD'));
    const activeSched   = specificSched || generalSched;
    const isWorking     = !!(activeSched?.is_working_day);

    const block = blocks.find(b => b.start_at < targetEnd && b.end_at > targetStart);

    if (!isWorking && !block) {
      lines.push(`🔹 *${displayDate}:* عطلة العيادة المعتادة (مغلق)`);
      hasAbsence = true;
    } else if (block) {
      const note = block.substitute_doctor_name
        ? `الدكتور الأساسي غائب (البديل: *${block.substitute_doctor_name}*)`
        : 'العيادة مغلقة (إجازة/غياب الدكتور)';
      lines.push(`🔹 *${displayDate}:* ⚠️ ${note}`);
      hasAbsence = true;
    }
  }

  return hasAbsence
    ? '⚠️ *أيام إجازات وغياب الدكتور للأيام السبعة القادمة:*\n\n' + lines.join('\n')
    : 'لا توجد إجازات أو غيابات مجدولة للأيام القادمة. الدوام مستمر بشكل طبيعي. 😊';
}

// ── searchFAQ ─────────────────────────────────────────────────────────────────
// Keyword-based FAQ search. Kept as fallback — main FAQ answers come from system prompt.
// Ported from old tools.js lines 569-629.

async function searchFAQ(clinicId, message) {
  try {
    const { data: faqs } = await supabase
      .from('faqs').select('question, answer, keywords').eq('clinic_id', clinicId).eq('is_active', true);

    if (!faqs || faqs.length === 0) return { found: false, answer: null };

    const msg    = message.replace(/[؟?!،,.]/g, '').trim();
    const scored = faqs.map(faq => {
      let score = 0;
      for (const kw of (faq.keywords || [])) {
        if (msg.includes(kw)) score += 3;
      }
      const words = msg.split(' ').filter(w => w.length > 2);
      for (const word of words) {
        for (const kw of (faq.keywords || [])) {
          if (kw.includes(word) || word.includes(kw)) score += 1;
        }
      }
      return { ...faq, score };
    });

    const best = scored.sort((a, b) => b.score - a.score)[0];
    return best && best.score >= 2 ? { found: true, answer: best.answer } : { found: false, answer: null };

  } catch (err) {
    logger.error('[Tool] searchFAQ error', { error: err.message });
    return { found: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  toolDefinitions,
  executeTool,
  // Helpers used by systemPrompt.js and guardrails.js
  getDayConfig,
  getBlockForDay,
  parseArabicDatePreference,
  getDynamicScheduleSummary,
  getAbsenceSummary,
  searchFAQ,
};
