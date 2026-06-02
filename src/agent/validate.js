const { supabase } = require('../services/supabase');
const { getBaghdadNow, TIMEZONE, dayjs } = require('../utils/time');
const { searchFAQ } = require('./tools');
const logger = require('../utils/logger');

async function validateExtracted(extracted, clinic, patient, stateData) {
  // Merge partial booking context if available
  if (stateData.booking_substate === 'awaiting_date' && stateData.partial_booking) {
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

  // 3. Check day availability
  if (extracted.date_preference && String(extracted.date_preference).toLowerCase() !== 'null' && extracted.intent === 'booking') {
    result.dayInfo = await checkDayInfo(extracted.date_preference, clinic);
  }

  // 4. FAQ answer
  if (extracted.faq_topic || extracted.intent === 'inquiry') {
    const searchTerm = extracted.faq_topic || extracted.date_preference || '';
    const faq = await searchFAQ(clinic.id, searchTerm);
    result.faqAnswer = faq.found ? faq.answer : null;
  }

  // 5. Check patient's upcoming appointments (for check_appointment intent)
  if (extracted.intent === 'check_appointment') {
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
