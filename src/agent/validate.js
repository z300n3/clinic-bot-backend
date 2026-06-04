const { supabase } = require('../services/supabase');
const { getBaghdadNow, TIMEZONE, dayjs } = require('../utils/time');
const { searchFAQ, getDynamicScheduleSummary, getAbsenceSummary } = require('./tools');
const logger = require('../utils/logger');

function formatDayInfo(dayInfo) {
  if (!dayInfo.isWorking || dayInfo.isBlocked) {
    return `🔹 بخصوص يوم ${dayInfo.displayDate}، العيادة ستكون مغلقة (عطلة/إجازة).`;
  }
  if (dayInfo.substitute) {
    return `🔹 بخصوص يوم ${dayInfo.displayDate}، الدكتور الأساسي غائب وسيتواجد مكانه الطبيب البديل: ${dayInfo.substitute}.`;
  }
  return `🔹 نعم، بخصوص يوم ${dayInfo.displayDate}، الطبيب متواجد والدوام مستمر بشكل طبيعي.`;
}

async function buildHoursAnswer(clinic) {
  const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

  // Try availability_schedules first
  const { data: schedules } = await supabase
    .from('availability_schedules')
    .select('day_of_week, is_working_day, shifts')
    .eq('clinic_id', clinic.id)
    .is('specific_date', null)
    .order('day_of_week', { ascending: true });

  if (schedules && schedules.length > 0) {
    const lines = schedules.map(s => {
      const name = dayNames[s.day_of_week];
      if (!s.is_working_day) return `${name}: مغلق`;
      const shift = (s.shifts || [])[0];
      if (!shift) return `${name}: مغلق`;
      return `${name}: ${shift.open} - ${shift.close}`;
    });
    return `🕐 أوقات الدوام:\n${lines.join('\n')}`;
  }

  // Fallback to clinic.working_hours JSONB
  const wh = clinic.working_hours || {};
  const order = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const arabicKeys = {
    sunday: 'الأحد', monday: 'الاثنين', tuesday: 'الثلاثاء',
    wednesday: 'الأربعاء', thursday: 'الخميس', friday: 'الجمعة', saturday: 'السبت'
  };
  const lines = order.map(key => {
    const conf = wh[key];
    if (!conf || conf.closed) return `${arabicKeys[key]}: مغلق`;
    return `${arabicKeys[key]}: ${conf.open || '09:00'} - ${conf.close || '17:00'}`;
  });
  return `🕐 أوقات الدوام:\n${lines.join('\n')}`;
}

async function validateExtracted(extracted, clinic, patient, stateData, userMessage) {
  // Merge partial booking context if available
  if (['awaiting_date', 'awaiting_info'].includes(stateData.booking_substate) && stateData.partial_booking) {
    if (!extracted.patient_name && stateData.partial_booking.patient_name) {
      extracted.patient_name = stateData.partial_booking.patient_name;
    }
    if (!extracted.reason && stateData.partial_booking.reason) {
      extracted.reason = stateData.partial_booking.reason;
    }
  }

  const result = {
    nameValid:      false,
    existingAppt:   null,
    dayInfo:        null,
    faqAnswer:      null,
    scheduleSummary:null,
    absenceSummary: null,
    specificDayInfo:null,
    directAnswer:   null,
    upcomingAppts:  [],
  };

  // 1. Name validation (no DB)
  if (extracted.patient_name) {
    const parts = extracted.patient_name.trim().split(/\s+/).filter(Boolean);
    result.nameValid = parts.length >= 2;
  }

  // 2. Check existing appointment for this name
  if (extracted.patient_name && extracted.intent === 'booking') {
    const now = getBaghdadNow();
    const { data } = await supabase
      .from('appointments')
      .select('id, scheduled_at, patient_name, queue_number')
      .eq('clinic_id', clinic.id)
      .eq('patient_id', patient.id)
      .eq('patient_name', extracted.patient_name.trim())
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    result.existingAppt = data || null;
  }

  // Extract topics robustly
  let parsedTopics = [];
  if (Array.isArray(extracted.faq_topics)) {
    parsedTopics = extracted.faq_topics;
  } else if (typeof extracted.faq_topics === 'string') {
    parsedTopics = extracted.faq_topics.split(',').map(s => s.trim());
  }

  // 3. Check day availability
  if (extracted.date_preference && String(extracted.date_preference).toLowerCase() !== 'null') {
    const isBooking = extracted.intent === 'booking';
    if (isBooking || parsedTopics.includes('absence') || parsedTopics.includes('hours')) {
      result.dayInfo = await checkDayInfo(extracted.date_preference, clinic);
    }
  }

  // 4. Inquiry answer — from clinic fields or FAQ
  if (parsedTopics.length > 0 || extracted.intent === 'inquiry') {
    let combinedAnswers = [];
    
    // If the intent was inquiry but no topics were extracted, fallback to custom search
    const activeTopics = parsedTopics.length > 0 ? parsedTopics : ['custom'];

    for (const topic of activeTopics) {
      switch (topic) {
        case 'absence':
          if (result.dayInfo) {
            combinedAnswers.push(formatDayInfo(result.dayInfo));
          } else {
            const sum = await getAbsenceSummary(clinic.id);
            if (sum) combinedAnswers.push(sum);
          }
          break;

        case 'hours':
          if (result.dayInfo) {
            combinedAnswers.push(formatDayInfo(result.dayInfo));
          } else {
            combinedAnswers.push(await buildHoursAnswer(clinic));
          }
          break;

        case 'price':
          combinedAnswers.push(clinic.consultation_price
            ? `💵 سعر الكشفية ${clinic.consultation_price} دينار 😊`
            : 'سعر الكشفية غير محدد حالياً، تواصل مع العيادة للاستفسار.');
          break;

        case 'location':
          combinedAnswers.push(clinic.address
            ? `📍 عنوان العيادة: ${clinic.address} ${clinic.map_link ? '\n' + clinic.map_link : ''}`
            : 'العنوان غير محدد، تواصل مع العيادة.');
          break;

        case 'specialty':
        case 'services':
          if (clinic.specialty) {
            let ans = `👨‍⚕️ الدكتور ${clinic.doctor_name || 'المختص'} اختصاصه ${clinic.specialty}.`;
            if (clinic.treated_diseases) {
              ans += `\nيعالج الحالات التالية: ${clinic.treated_diseases}`;
            }
            combinedAnswers.push(ans);
          } else {
            combinedAnswers.push(`تكدر تحجز موعد والدكتور يشوف حالتك.`);
          }
          break;

        case 'about': {
          const lines = [`🏥 ${clinic.name}`];
          if (clinic.doctor_name)  lines.push(`👨‍⚕️ الطبيب: ${clinic.doctor_name}`);
          if (clinic.specialty)    lines.push(`🔬 التخصص: ${clinic.specialty}`);
          if (clinic.treated_diseases) lines.push(`🩺 يعالج: ${clinic.treated_diseases}`);
          if (clinic.consultation_price) lines.push(`💵 سعر الكشفية: ${clinic.consultation_price} دينار`);
          if (clinic.address)      lines.push(`📍 العنوان: ${clinic.address}`);
          if (clinic.map_link)     lines.push(`🗺️ الخارطة: ${clinic.map_link}`);
          if (clinic.phone_number) lines.push(`📱 الهاتف: ${clinic.phone_number}`);
          
          const hoursText = await buildHoursAnswer(clinic);
          if (hoursText) lines.push('', hoursText);
          
          lines.push('', 'إذا تريد تحجز موعد، قولي وأساعدك! 😊');
          combinedAnswers.push(lines.join('\n'));
          break;
        }

        case 'doctor_name':
          combinedAnswers.push(
            clinic.doctor_name
              ? `👨‍⚕️ اسم الطبيب: ${clinic.doctor_name}${clinic.specialty ? ` — ${clinic.specialty}` : ''}`
              : 'اسم الطبيب غير متوفر حالياً، تواصل مع العيادة للاستفسار.'
          );
          break;

        case 'custom':
        default:
          const faq = await searchFAQ(clinic.id, userMessage);
          if (faq.found) {
            combinedAnswers.push(faq.answer);
          } else {
            combinedAnswers.push('ما عندي جواب محدد على هالسؤال 😊\nبس أكدر أساعدك بـ: حجز موعد، أوقات الدوام، السعر، العنوان، أو التخصص.');
          }
          break;
      }
    }

    if (combinedAnswers.length > 0) {
      result.combinedAnswer = combinedAnswers.join('\n\n---\n\n');
    }
  }

  // 5. Check patient's upcoming appointments
  if (['check_appointment', 'cancellation', 'cancel_all'].includes(extracted.intent) || stateData.booking_substate === 'awaiting_cancel_select') {
    const now = getBaghdadNow();
    const { data } = await supabase
      .from('appointments')
      .select('id, scheduled_at, queue_number, reason, patient_name')
      .eq('clinic_id', clinic.id)
      .eq('patient_id', patient.id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(3);

    result.upcomingAppts = data || [];
  }

  logger.debug('[Validate]', result);
  return result;
}

async function checkDayInfo(datePreference, clinic) {
  const { getBaghdadNow, dayjs, TIMEZONE } = require('../utils/time');
  const { parseArabicDatePreference } = require('./tools');
  
  const now = getBaghdadNow();
  const targetDay = parseArabicDatePreference(datePreference, now).startOf('day');

  if (!targetDay.isValid()) {
    logger.error('[Validate] Invalid date from preference', { datePreference });
    return null; // decide.js will treat null dayInfo as "ask for date"
  }

  const dayStartISO = targetDay.toISOString();
  const dayEndISO   = targetDay.endOf('day').toISOString();
  const dateStr     = targetDay.format('YYYY-MM-DD');

  const [schedulesRes, blocksRes, bookedRes] = await Promise.all([
    supabase
      .from('availability_schedules')
      .select('day_of_week, specific_date, is_working_day, daily_capacity, shifts')
      .eq('clinic_id', clinic.id),

    supabase
      .from('blocked_periods')
      .select('start_at, end_at, is_full_day, substitute_doctor_name')
      .eq('clinic_id', clinic.id)
      .lt('start_at', dayEndISO)
      .gt('end_at', dayStartISO),

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

  // Get day config
  const { getDayConfig } = require('./tools');
  const { isWorking, capacity, shifts } = getDayConfig(targetDay, schedules, clinic.working_hours || {});

  // Check block + substitute
  const block = getBlockForDay(targetDay, blocks);
  const substitute = block?.substitute_doctor_name || null;
  const isBlocked  = !!block && !substitute;

  const unlimited = capacity === null || capacity === undefined;
  const isFull    = !unlimited && booked >= capacity;

  // Check if today's shift ended
  const shift0 = shifts[0];
  let shiftEnded = false;
  if (dateStr === now.format('YYYY-MM-DD')) {
    if (!shift0?.close) {
      shiftEnded = false;
    } else {
      const [ch, cm] = shift0.close.split(':').map(Number);
      const shiftCloseMinutes = ch * 60 + cm;
      const nowMinutes = now.hour() * 60 + now.minute();
      shiftEnded = nowMinutes >= shiftCloseMinutes;
    }
  }

  return {
    targetDay:   targetDay.toISOString(),
    dateStr,
    displayDate: formatArabicDay(targetDay),
    isWorking,
    isBlocked,
    substitute,
    isFull,
    shiftEnded,
    booked,
    capacity:    unlimited ? null : capacity,
    shifts,
  };
}

function getBlockForDay(targetDay, blocks) {
  const targetDateStr = dayjs(targetDay).tz(TIMEZONE).format('YYYY-MM-DD');
  return (blocks || []).find(b => {
    const start = dayjs(b.start_at).tz(TIMEZONE).format('YYYY-MM-DD');
    const end   = dayjs(b.end_at).tz(TIMEZONE).format('YYYY-MM-DD');
    return targetDateStr >= start && targetDateStr <= end;
  });
}

function formatArabicDay(d) {
  const days   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${days[d.day()]} ${d.date()} ${months[d.month()]} ${d.year()}`;
}

module.exports = { validateExtracted };
