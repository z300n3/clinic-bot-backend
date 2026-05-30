const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

const TIMEZONE     = 'Asia/Baghdad';
const BOOKING_HOUR = 12; // appointments are day-based; we store a fixed marker time (noon Baghdad)

// ── Tool Schemas for Claude ───────────────────────────────────────────────────

const toolDefinitions = [
  {
    name: 'check_availability',
    description: 'يعرض المواعيد المتاحة',
    input_schema: {
      type: 'object',
      properties: {
        date_preference: { type: 'string', description: 'اليوم أو التاريخ المطلوب' },
      },
      required: ['date_preference'],
    },
  },
  {
    name: 'book_appointment',
    description: 'يحجز موعد للمريض',
    input_schema: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: 'الاسم الكامل للمريض' },
        appointment_date: { type: 'string', description: 'تاريخ الحجز YYYY-MM-DD' },
        reason: { type: 'string', description: 'سبب الزيارة' },
      },
      required: ['patient_name', 'appointment_date', 'reason'],
    },
  },
  {
    name: 'get_day_bookings',
    description: 'يرجع عدد الحجوزات في يوم معين',
    input_schema: {
      type: 'object',
      properties: {
        date_preference: { type: 'string', description: 'تاريخ اليوم المطلوب' },
      },
      required: ['date_preference'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'يلغي الموعد القادم',
    input_schema: {
      type: 'object',
      properties: {
        patient_phone: { type: 'string', description: 'رقم هاتف المريض' },
      },
      required: ['patient_phone'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'يحول للموظف البشري',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'سبب التصعيد' },
      },
      required: ['reason'],
    },
  },
];

// ── Router ────────────────────────────────────────────────────────────────────

async function executeTool(name, input, context) {
  switch (name) {
    case 'check_availability':  return checkAvailability(input, context);
    case 'book_appointment':    return bookAppointment(input, context);
    case 'get_day_bookings':    return getDayBookings(input, context);
    case 'cancel_appointment':  return cancelAppointment(input, context);
    case 'escalate_to_human':   return escalateToHuman(input, context);
    default:
      return { error: `أداة غير معروفة: ${name}` };
  }
}

// ── check_availability (day-based) ─────────────────────────────────────────────

async function checkAvailability({ date_preference }, { clinic }) {
  try {
    const now        = dayjs().tz(TIMEZONE);
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
        .select('start_at, end_at, is_full_day')
        .eq('clinic_id', clinic.id)
        .lt('start_at', horizon.toISOString())
        .gt('end_at',   searchFrom.toISOString()),
    ]);

    if (bookedRes.error)    return { error: 'فشل في تحميل المواعيد المحجوزة' };
    if (schedulesRes.error) logger.warn('availability_schedules load warning', { error: schedulesRes.error.message });
    if (blocksRes.error)    logger.warn('blocked_periods load warning',        { error: blocksRes.error.message });

    const schedules = schedulesRes.data || [];
    const blocks    = blocksRes.data    || [];

    // Count booked appointments per calendar day (Baghdad)
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

        if (isWorking && !isDayBlocked(day, blocks)) {
          const booked    = bookedByDay[dateStr] || 0;
          const unlimited = capacity === null || capacity === undefined;
          const isFull    = !unlimited && booked >= capacity;

          const shift = shifts[0];

          // For TODAY: skip if working hours have already ended
          const todayShiftEnded = dateStr === todayStr && (() => {
            if (!shift?.close) return false;
            const [ch, cm] = shift.close.split(':').map(Number);
            const shiftClose = day.hour(ch).minute(cm).second(0).millisecond(0);
            return !now.isBefore(shiftClose);
          })();

          if (!isFull && !todayShiftEnded) {
            const workingHours = shift
              ? `${formatTime12(shift.open)}${shift.close ? ' — ' + formatTime12(shift.close) : ''}`
              : null;

            days.push({
              date:          dateStr,
              display:       formatArabicDay(day),
              booked,
              capacity:      unlimited ? null : capacity,
              remaining:     unlimited ? null : capacity - booked,
              working_hours: workingHours,
            });
          }
        }
      }

      day = day.add(1, 'day');
    }

    if (days.length === 0) {
      return {
        available: false,
        message:   'ما في أيام متاحة للحجز بالفترة المطلوبة. جرب تاريخاً آخر.',
        days:      [],
      };
    }

    return {
      available: true,
      days,
      message:   'هذي الأيام المتاحة للحجز:',
    };
  } catch (err) {
    logger.error('checkAvailability error', { error: err.message });
    return { error: 'خطأ في فحص الأيام المتاحة: ' + err.message };
  }
}

// ── book_appointment (day-based, auto queue number) ────────────────────────────

async function bookAppointment({ patient_name, appointment_date, reason }, { clinic, patient }) {
  try {
    const now       = dayjs().tz(TIMEZONE);
    const targetDay = parseArabicDatePreference(appointment_date, now).startOf('day');

    if (!targetDay.isValid()) {
      return { success: false, error: 'التاريخ غير صحيح' };
    }
    if (targetDay.format('YYYY-MM-DD') < now.format('YYYY-MM-DD')) {
      return { success: false, error: 'لا يمكن الحجز في يوم مضى' };
    }

    const dayStartISO = targetDay.toISOString();
    const dayEndISO   = targetDay.endOf('day').toISOString();

    const [schedulesRes, blocksRes, bookedRes] = await Promise.all([
      supabase
        .from('availability_schedules')
        .select('day_of_week, specific_date, is_working_day, daily_capacity, shifts')
        .eq('clinic_id', clinic.id),

      supabase
        .from('blocked_periods')
        .select('start_at, end_at, is_full_day')
        .eq('clinic_id', clinic.id)
        .lt('start_at', dayEndISO)
        .gt('end_at',   dayStartISO),

      supabase
        .from('appointments')
        .select('id')
        .eq('clinic_id', clinic.id)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', dayStartISO)
        .lte('scheduled_at', dayEndISO),
    ]);

    const schedules = schedulesRes.data || [];
    const blocks    = blocksRes.data    || [];
    const booked    = (bookedRes.data || []).length;

    const { isWorking, capacity, shifts } = getDayConfig(targetDay, schedules, clinic.working_hours || {});

    if (!isWorking) {
      return { success: false, error: `${formatArabicDay(targetDay)} ليس يوم دوام في العيادة.` };
    }
    if (isDayBlocked(targetDay, blocks)) {
      return { success: false, error: `${formatArabicDay(targetDay)} الدكتور غير متوفر (إجازة/غياب).` };
    }

    const unlimited = capacity === null || capacity === undefined;
    if (!unlimited && booked >= capacity) {
      return {
        success: false,
        error:   `عذراً، اكتمل العدد ليوم ${formatArabicDay(targetDay)} (${capacity} موعد). جرب يوماً آخر.`,
      };
    }

    // If booking for TODAY, reject if the shift has already ended
    const shift0 = shifts[0];
    if (targetDay.format('YYYY-MM-DD') === now.format('YYYY-MM-DD') && shift0?.close) {
      const [ch, cm] = shift0.close.split(':').map(Number);
      const shiftClose = targetDay.hour(ch).minute(cm).second(0).millisecond(0);
      if (!now.isBefore(shiftClose)) {
        return {
          success: false,
          error: `انتهى دوام الدكتور اليوم (${formatTime12(shift0.close)}). جرب تحجز ليوم ثاني.`,
        };
      }
    }

    const queueNumber = booked + 1;
    const scheduledAt = targetDay.hour(BOOKING_HOUR).minute(0).second(0).millisecond(0);
    const duration    = clinic.appointment_duration_minutes || 30;

    // ── Compute estimated arrival time ────────────────────────────────────────
    const shift = shifts[0];
    let estimatedLine  = '';
    let workHoursLine  = '';

    if (shift?.open) {
      const [sh, sm] = shift.open.split(':').map(Number);
      const estimated  = targetDay.hour(sh).minute(sm || 0).second(0)
                          .add((queueNumber - 1) * duration, 'minute');
      estimatedLine = `⏰ وقتك التقريبي للمراجعة: ${formatTime12(estimated.format('HH:mm'))}`;

      const openFmt  = formatTime12(shift.open);
      const closeFmt = shift.close ? ` — ${formatTime12(shift.close)}` : '';
      workHoursLine  = `🕐 دوام العيادة: ${openFmt}${closeFmt}`;
    }

    const { data: appt, error } = await supabase
      .from('appointments')
      .insert({
        clinic_id:        clinic.id,
        patient_id:       patient.id,
        scheduled_at:     scheduledAt.toISOString(),
        duration_minutes: clinic.appointment_duration_minutes || 30,
        queue_number:     queueNumber,
        status:           'scheduled',
        reason,
        patient_name:     patient_name || null,   // name as spoken in this conversation
      })
      .select('id')
      .single();

    if (error) return { success: false, error: 'فشل الحجز: ' + error.message };

    const ref = appt.id.slice(-6).toUpperCase();

    const lines = [
      `تم تثبيت موعدك بنجاح! ✅`,
      ``,
      `📅 ${formatArabicDay(scheduledAt)}`,
      `🎫 رقمك بالدور: ${queueNumber}`,
      estimatedLine  || null,
      workHoursLine  || null,
      `👤 ${patient_name}`,
      `📝 ${reason}`,
      ``,
      `رقم الحجز: #${ref}`,
      ``,
      `راجع العيادة بهذا اليوم وبيكون دورك حسب رقمك.${estimatedLine ? ' الوقت التقريبي المذكور أعلاه هو تخمين فقط.' : ''} لو تحتاج تلغي أو تغيّر، كلمنا!`,
    ].filter((l) => l !== null).join('\n');

    return {
      success:        true,
      appointment_id: appt.id,
      queue_number:   queueNumber,
      message:        lines,
    };
  } catch (err) {
    logger.error('bookAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الحجز: ' + err.message };
  }
}

// ── get_day_bookings (how many booked on a given day) ──────────────────────────

async function getDayBookings({ date_preference }, { clinic }) {
  try {
    const now = dayjs().tz(TIMEZONE);
    const day = parseArabicDatePreference(date_preference, now).startOf('day');

    const dayStartISO = day.toISOString();
    const dayEndISO   = day.endOf('day').toISOString();

    const { data, error } = await supabase
      .from('appointments')
      .select('id')
      .eq('clinic_id', clinic.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', dayStartISO)
      .lte('scheduled_at', dayEndISO);

    if (error) return { error: 'فشل في جلب عدد الحجوزات' };

    const count = (data || []).length;
    return {
      date:         day.format('YYYY-MM-DD'),
      display:      formatArabicDay(day),
      booked_count: count,
      message:      `عدد الحجوزات ليوم ${formatArabicDay(day)}: ${count} موعد.`,
    };
  } catch (err) {
    logger.error('getDayBookings error', { error: err.message });
    return { error: 'خطأ في جلب عدد الحجوزات: ' + err.message };
  }
}

/**
 * Resolves whether a day is a working day + its daily capacity.
 * Priority: specific_date override > day_of_week rule > clinic.working_hours fallback.
 * capacity: null = unlimited / open.
 */
function getDayConfig(dayObj, schedules, clinicWorkingHours) {
  const dateStr = dayObj.format('YYYY-MM-DD');
  const dayNum  = dayObj.day(); // 0=Sunday

  // 1. Specific-date override (highest priority)
  const override = schedules.find((s) => s.specific_date === dateStr);
  if (override) {
    return {
      isWorking: override.is_working_day,
      capacity:  override.daily_capacity ?? null,
      shifts:    override.shifts || [],
    };
  }

  // 2. Weekly recurring rule
  const weekly = schedules.find((s) => s.day_of_week === dayNum && s.specific_date === null);
  if (weekly) {
    return {
      isWorking: weekly.is_working_day,
      capacity:  weekly.daily_capacity ?? null,
      shifts:    weekly.shifts || [],
    };
  }

  // 3. Fallback to legacy clinic.working_hours JSONB (no capacity → unlimited)
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
 * Returns true if any blocked period overlaps the given calendar day.
 */
function isDayBlocked(dayObj, blocks) {
  const dayStart = dayObj.startOf('day');
  const dayEnd   = dayObj.endOf('day');
  return blocks.some((block) => {
    const bStart = dayjs(block.start_at).tz(TIMEZONE);
    const bEnd   = dayjs(block.end_at).tz(TIMEZONE);
    return bStart.isBefore(dayEnd) && bEnd.isAfter(dayStart);
  });
}

// ── cancel_appointment ────────────────────────────────────────────────────────

async function cancelAppointment({ patient_phone }, { clinic }) {
  try {
    const { data: pat } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone_number', patient_phone)
      .maybeSingle();

    if (!pat) return { success: false, message: 'ما وجدنا بيانات لهذا الرقم.' };

    const { data: appt } = await supabase
      .from('appointments')
      .select('id, scheduled_at, reason')
      .eq('clinic_id', clinic.id)
      .eq('patient_id', pat.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!appt) {
      return { success: false, message: 'ما عندك مواعيد قادمة محجوزة.' };
    }

    const { error } = await supabase
      .from('appointments')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', appt.id);

    if (error) return { success: false, error: 'فشل الإلغاء: ' + error.message };

    const slotDate = dayjs(appt.scheduled_at).tz(TIMEZONE);
    return {
      success: true,
      message: `تم إلغاء موعدك ✅\n\nالموعد الملغي: ${formatArabicDay(slotDate)}\n\nلو تريد تحجز موعد جديد، أنا هنا! 😊`,
    };
  } catch (err) {
    logger.error('cancelAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الإلغاء: ' + err.message };
  }
}

// ── get_faq_answer ────────────────────────────────────────────────────────────

async function checkFaqDirect(question, clinicId) {
  try {
    const words = extractKeywords(question);
    if (words.length === 0) return { found: false, answer: null };

    // Build OR filter: match any keyword against question or answer text
    const orParts = words
      .flatMap((w) => [`question.ilike.%${w}%`, `answer.ilike.%${w}%`])
      .join(',');

    const { data: results } = await supabase
      .from('faqs')
      .select('question, answer')
      .eq('clinic_id', clinicId)
      .eq('is_active', true)
      .or(orParts)
      .limit(1);

    if (results && results.length > 0) {
      return {
        found:   true,
        answer:  results[0].answer,
      };
    }

    return { found: false, answer: null };
  } catch (err) {
    logger.error('checkFaqDirect error', { error: err.message });
    return { found: false, error: 'خطأ في البحث: ' + err.message };
  }
}

// ── escalate_to_human ─────────────────────────────────────────────────────────

async function escalateToHuman({ reason }, { clinic, patientPhone }) {
  try {
    await supabase
      .from('conversation_state')
      .upsert(
        {
          clinic_id:       clinic.id,
          patient_phone:   patientPhone,
          state:           'awaiting_human',
          state_data:      { reason, escalated_at: new Date().toISOString() },
          last_message_at: new Date().toISOString(),
        },
        { onConflict: 'clinic_id,patient_phone' }
      );

    return {
      success: true,
      message: 'راح يتواصل معاك أحد من فريق العيادة قريباً إن شاء الله. شكراً على صبرك! 🙏',
      state:   'awaiting_human',
    };
  } catch (err) {
    logger.error('escalateToHuman error', { error: err.message });
    return { success: false, error: 'خطأ في التصعيد: ' + err.message };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArabicDatePreference(pref, now) {
  const lower = (pref || '').toLowerCase();

  if (lower.includes('اليوم') || lower.includes('today'))             return now;
  if (lower.includes('غداً') || lower.includes('غد') || lower.includes('بكره') || lower.includes('tomorrow')) return now.add(1, 'day');
  if (lower.includes('بعد غد') || lower.includes('بعد بكره'))         return now.add(2, 'day');
  if (lower.includes('الأسبوع القادم') || lower.includes('الجاي'))    return now.add(7, 'day');

  const dayNames = {
    'الأحد': 0, 'الاثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3,
    'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  for (const [name, num] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      let target = now.day(num);
      if (!target.isAfter(now.endOf('day'))) {
        target = target.add(7, 'day');
      }
      return target;
    }
  }

  // Explicit date string (YYYY-MM-DD) interpreted in Baghdad time
  const parsed = dayjs.tz(pref, TIMEZONE);
  if (parsed.isValid() && !parsed.isBefore(now.startOf('day'))) return parsed;

  return now.add(1, 'day'); // safe default
}

/**
 * Format HH:MM time string to 12-hour Arabic (e.g. "09:00" → "9:00 ص")
 */
function formatTime12(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const h12    = h % 12 || 12;
  const mm     = String(m || 0).padStart(2, '0');
  const period = h >= 12 ? 'م' : 'ص';
  return `${h12}:${mm} ${period}`;
}

function formatArabicDay(d) {
  const days   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${days[d.day()]} ${d.date()} ${months[d.month()]} ${d.year()}`;
}

const ARABIC_STOP_WORDS = new Set([
  'هل','ما','هو','هي','في','من','إلى','على','عن','مع','لي','لك','له','لها',
  'هذا','هذه','ذلك','تلك','التي','الذي','و','أو','لكن','أن','إن','كان',
  'يكون','قد','لا','ليس','عند','كل','بعض','مثل','هنا','هناك',
]);

function extractKeywords(text) {
  return text
    .replace(/[،,\.!؟?؛]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[الـ]/, ''))  // strip definite article
    .filter((w) => w.length >= 3 && !ARABIC_STOP_WORDS.has(w))
    .slice(0, 5);
}

module.exports = { toolDefinitions, executeTool, checkFaqDirect };
