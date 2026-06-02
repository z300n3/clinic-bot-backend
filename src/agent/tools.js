const OpenAI = require('openai');
const { getBaghdadNow, formatTime12, TIMEZONE, dayjs } = require('../utils/time');

const { supabase, upsertConversationState } = require('../services/supabase');
const logger = require('../utils/logger');

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
    description: 'يلغي الموعد القادم للمريض. ملاحظة هامة: النظام يتعرف على المريض تلقائياً من رقم هاتفه، لذلك لا تسأل المريض عن اسمه أو رقمه أبداً! فقط تأكد من رغبته بالإلغاء ثم استدعِ الأداة.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'check_my_appointment',
    description: 'يبحث عن موعد المريض القادم ويعرض تفاصيله. ملاحظة هامة: النظام يتعرف على المريض تلقائياً من رقم الواتساب، لا تسأله عن اسمه أو رقمه أبداً! استدعِ الأداة مباشرة بمجرد سؤاله عن موعده.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
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
  {
    name: 'out_of_scope_response',
    description: 'استخدم هذه الأداة للرد بشكل ثابت عندما يسأل المريض عن موضوع خارج نطاق العيادة أو الحجوزات تماماً.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'greeting_response',
    description: 'استخدم هذه الأداة للرد بشكل ثابت عندما تكون رسالة المريض عبارة عن ترحيب فقط (مثل: السلام عليكم، هلو، مرحبا) ولا تحتوي على طلب واضح.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
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
    case 'check_my_appointment': return checkMyAppointment(input, context);
    case 'escalate_to_human':   return escalateToHuman(input, context);
    default:
      return { error: `أداة غير معروفة: ${name}` };
  }
}

// ── check_availability (day-based) ─────────────────────────────────────────────

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

        const block = getBlockForDay(day, blocks);
        const isBlockedNoSub = block && !block.substitute_doctor_name;

        if (isWorking && !isBlockedNoSub) {
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
              display:       formatArabicDay(day) + (block?.substitute_doctor_name ? ` (مع الطبيب البديل: ${block.substitute_doctor_name})` : ''),
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
    const nameParts = (patient_name || '').trim().split(/\s+/).filter(Boolean);
    if (nameParts.length < 2) {
      return { 
        success: false, 
        error: 'الاسم يجب أن يكون ثنائي على الأقل (اسم + اسم الأب أو العائلة).' 
      };
    }

    const now       = getBaghdadNow();
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
        .select('start_at, end_at, is_full_day, substitute_doctor_name, substitute_doctor_note')
        .eq('clinic_id', clinic.id)
        .lt('start_at', dayEndISO)
        .gt('end_at',   dayStartISO),

      supabase
        .from('appointments')
        .select('id, patient_id')
        .eq('clinic_id', clinic.id)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', dayStartISO)
        .lte('scheduled_at', dayEndISO),
    ]);

    const schedules = schedulesRes.data || [];
    const blocks    = blocksRes.data    || [];
    const bookedAppts = bookedRes.data || [];
    const booked    = bookedAppts.length;

    // Fix 5: Prevent duplicate bookings for the EXACT same name from the same phone
    const sameDayAppt = bookedAppts.find(a => String(a.patient_id) === String(patient.id) && a.patient_name === patient_name);
    if (sameDayAppt) {
      return { success: false, error: `يوجد موعد محجوز مسبقاً باسم "${patient_name}" في هذا اليوم. لا يمكن حجز موعدين بنفس الاسم في نفس اليوم.` };
    }

    const { isWorking, capacity, shifts } = getDayConfig(targetDay, schedules, clinic.working_hours || {});

    if (!isWorking) {
      return { success: false, error: `${formatArabicDay(targetDay)} ليس يوم دوام في العيادة.` };
    }
    let servedBy = null; // null = main doctor
    let substituteNotice = '';

    const block = getBlockForDay(targetDay, blocks);

    if (block) {
      if (block.substitute_doctor_name) {
        // Substitute available — allow booking, same hours
        servedBy = block.substitute_doctor_name;
        substituteNotice = `⚠️ ملاحظة: ${clinic.doctor_name || 'الدكتور الأساسي'} غائب هذا اليوم. الطبيب البديل: ${block.substitute_doctor_name}`;
      } else {
        // No substitute — block as before
        return { 
          success: false, 
          error: `${formatArabicDay(targetDay)} الدكتور غير متوفر (إجازة/غياب) ولا يوجد بديل.` 
        };
      }
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

    console.log('[BOOKING ATTEMPT]', {
      patientName: patient_name,
      reason: reason,
      scheduledAt: scheduledAt.toISOString(),
      patientId: patient.id,
      clinicId: clinic.id
    });

    // Direct Booking Insertion (Confirmation Step Removed)
    const { data: appt, error } = await supabase
      .from('appointments')
      .insert({
        clinic_id: clinic.id,
        patient_id: patient.id,
        scheduled_at: scheduledAt.toISOString(),
        duration_minutes: duration,
        queue_number: queueNumber,
        status: 'scheduled',
        reason: reason,
        patient_name: patient_name || null,
        served_by: servedBy
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Booking insert error', { error: error.message });
      return { success: false, error: 'فشل حفظ الموعد في النظام.' };
    }

    const ref = appt.id.slice(-6).toUpperCase();

    const lines = [
      `تم تثبيت موعدك بنجاح! ✅`,
      `📅 ${formatArabicDay(scheduledAt)}`,
      substituteNotice || null,
      `🎫 رقمك بالدور: ${queueNumber}`,
      estimatedLine || null,
      workHoursLine || null,
      `👤 ${patient_name || ''}`,
      `📝 ${reason || ''}`,
      `رقم الحجز: #${ref}`,
      `راجع العيادة بهذا اليوم وبيكون دورك حسب رقمك.`
    ].filter(Boolean).join('\n');

    return {
      success: true,
      message: lines
    };
  } catch (err) {
    logger.error('bookAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الحجز: ' + err.message };
  }
}

// ── get_day_bookings (how many booked on a given day) ──────────────────────────

async function getDayBookings({ date_preference }, { clinic }) {
  try {
    const now = getBaghdadNow();
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
function getBlockForDay(targetDay, blocks) {
  // targetDay is a dayjs object in Baghdad timezone
  const targetDateStr = targetDay.tz(TIMEZONE).format('YYYY-MM-DD');
  
  return (blocks || []).find(b => {
    // Convert block start/end to Baghdad dates
    const blockStartDate = dayjs(b.start_at).tz(TIMEZONE).format('YYYY-MM-DD');
    const blockEndDate = dayjs(b.end_at).tz(TIMEZONE).format('YYYY-MM-DD');
    
    // Compare as date strings (YYYY-MM-DD) — no time component
    return targetDateStr >= blockStartDate && targetDateStr <= blockEndDate;
  });
}

// ── cancel_appointment ────────────────────────────────────────────────────────

async function cancelAppointment(input, { clinic, patientPhone }) {
  try {
    const { data: pat } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone_number', patientPhone)
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

    await supabase.from('appointments').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', appt.id);

    return {
      success: true,
      message: `تم إلغاء الموعد بنجاح ✅`
    };
  } catch (err) {
    logger.error('cancelAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في الإلغاء: ' + err.message };
  }
}

// ── check_my_appointment ──────────────────────────────────────────────────────

async function checkMyAppointment(input, { clinic, patientPhone }) {
  try {
    const { data: pat } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinic.id)
      .eq('phone_number', patientPhone)
      .maybeSingle();

    if (!pat) return { success: false, message: 'ما عندك أي موعد مسجل حالياً.' };

    const { data: appt } = await supabase
      .from('appointments')
      .select('id, scheduled_at, queue_number, reason')
      .eq('clinic_id', clinic.id)
      .eq('patient_id', pat.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!appt) {
      return { success: false, message: 'ما عندك أي موعد قادم مسجل.' };
    }

    const slotDate = dayjs(appt.scheduled_at).tz(TIMEZONE);
    return {
      success: true,
      message: `عندك موعد مسجل يوم ${formatArabicDay(slotDate)} 📅\n🎫 رقمك بالدور هو: ${appt.queue_number}`
    };
  } catch (err) {
    logger.error('checkMyAppointment error', { error: err.message });
    return { success: false, error: 'خطأ في البحث عن الموعد: ' + err.message };
  }
}

async function searchFAQ(clinicId, message) {
  try {
    const { data: faqs } = await supabase
      .from('faqs')
      .select('question, answer, keywords')
      .eq('clinic_id', clinicId)
      .eq('is_active', true);

    if (!faqs || faqs.length === 0) return { found: false, answer: null };

    const msg = message.replace(/[؟?!،,.]/g, '').trim();

    const scored = faqs.map(faq => {
      let score = 0;
      const keywords = faq.keywords || [];

      // Direct keyword match
      for (const kw of keywords) {
        if (msg.includes(kw)) score += 3;
      }

      // Word-level partial match
      const words = msg.split(' ').filter(w => w.length > 2);
      for (const word of words) {
        for (const kw of keywords) {
          if (kw.includes(word) || word.includes(kw)) score += 1;
        }
      }

      // Common pattern matching
      const patterns = {
        location:  ['وين','فين','موقع','عنوان','مكان','كيف اوصل','خارطة'],
        hours:     ['دوام','ساعات','تفتح','تسكر','متى','يمته','وقت'],
        price:     ['سعر','كلفة','كم','فلوس','دينار','اجور','اسعار'],
        specialty: ['تخصص','اختصاص','شنو تعالج','تعالجون','خدمات']
      };

      for (const [category, categoryWords] of Object.entries(patterns)) {
        if (categoryWords.some(w => msg.includes(w))) {
          for (const kw of keywords) {
            if (kw.includes(category) || 
                categoryWords.some(w => kw.includes(w))) {
              score += 2;
            }
          }
        }
      }

      return { ...faq, score };
    });

    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 2) {
      return { found: true, answer: best.answer };
    }
    return { found: false, answer: null };
  } catch (err) {
    logger.error('searchFAQ error', { error: err.message });
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
  const lower = (pref || '').toLowerCase().trim();

  // Today
  if (lower.includes('اليوم') || lower.includes('today')) {
    return now.clone();
  }

  // Day after tomorrow (check BEFORE tomorrow to avoid partial match)
  if (lower.includes('بعد غد') || lower.includes('بعد بكره') || lower.includes('بعد باجر')) {
    return now.add(2, 'day');
  }

  // Tomorrow
  if (lower.includes('غد') || lower.includes('بكره') || lower.includes('باجر') || lower.includes('tomorrow')) {
    return now.add(1, 'day');
  }

  // Next week
  if (lower.includes('الأسبوع القادم') || lower.includes('الاسبوع الجاي') || lower.includes('الجاي')) {
    return now.add(7, 'day');
  }

  // Day names
  const dayNames = {
    'الأحد': 0, 'الاحد': 0, 'الاثنين': 1, 'الإثنين': 1, 'الثلاثاء': 2,
    'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  for (const [name, num] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      let target = now.day(num);
      // If that day already passed this week, move to next week
      if (target.format('YYYY-MM-DD') <= now.format('YYYY-MM-DD')) {
        target = target.add(7, 'day');
      }
      return target;
    }
  }

  // Try parsing as explicit date (YYYY-MM-DD)
  const isoMatch = /\d{4}-\d{2}-\d{2}/.exec(pref || '');
  if (isoMatch) {
    const parsed = dayjs.tz(isoMatch[0], 'YYYY-MM-DD', TIMEZONE);
    if (parsed.isValid() && parsed.format('YYYY-MM-DD') >= now.format('YYYY-MM-DD')) {
      return parsed;
    }
  }

  // Safe default: tomorrow (NEVER return invalid)
  return now.add(1, 'day');
}

// Removed formatTime12 since we use it from utils

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

module.exports = { 
  toolDefinitions, 
  executeTool, 
  searchFAQ,
  getDayConfig,
  parseArabicDatePreference
};
