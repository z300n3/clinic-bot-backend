'use strict';

/**
 * tools.js — Trimmed for the state-machine agent.
 *
 * Exports only what the state machine needs:
 *   getAvailableSlots  — returns [{datetime, formatted}] for the next open days
 *   escalateToHuman    — upserts awaiting_human state
 *
 * All day-config / blocked-period helpers are also exported so the agent
 * can reuse them without duplicate code.
 */

const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { supabase } = require('../services/supabase');
const logger       = require('../utils/logger');

const TIMEZONE     = 'Asia/Baghdad';
const BOOKING_HOUR = 12; // day-based system; appointments stored at Baghdad noon

// ── getAvailableSlots ─────────────────────────────────────────────────────────
/**
 * Returns up to 5 available day-slots starting from the given time preference.
 * Each slot: { datetime: ISO string at noon Baghdad, formatted: Arabic day string }
 *
 * @param {string}  clinicId
 * @param {string|null} timePreference — Arabic date preference ("بكره", "الأحد", etc.)
 * @param {object}  workingHours — clinic.working_hours (legacy fallback)
 */
async function getAvailableSlots(clinicId, timePreference, workingHours = {}) {
  try {
    const now        = dayjs().tz(TIMEZONE);
    const searchFrom = timePreference
      ? parseArabicDatePreference(timePreference, now).startOf('day')
      : now.startOf('day');
    const horizon    = searchFrom.add(14, 'day').endOf('day');

    const [bookedRes, schedulesRes, blocksRes] = await Promise.all([
      supabase
        .from('appointments')
        .select('scheduled_at')
        .eq('clinic_id', clinicId)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', searchFrom.toISOString())
        .lte('scheduled_at', horizon.toISOString()),

      supabase
        .from('availability_schedules')
        .select('day_of_week, specific_date, is_working_day, daily_capacity, shifts')
        .eq('clinic_id', clinicId),

      supabase
        .from('blocked_periods')
        .select('start_at, end_at, is_full_day')
        .eq('clinic_id', clinicId)
        .lt('start_at', horizon.toISOString())
        .gt('end_at',   searchFrom.toISOString()),
    ]);

    const schedules  = schedulesRes.data || [];
    const blocks     = blocksRes.data    || [];
    const todayStr   = now.format('YYYY-MM-DD');

    // Count booked appointments per calendar day (Baghdad)
    const bookedByDay = {};
    for (const row of (bookedRes.data || [])) {
      const k = dayjs(row.scheduled_at).tz(TIMEZONE).format('YYYY-MM-DD');
      bookedByDay[k] = (bookedByDay[k] || 0) + 1;
    }

    const slots = [];
    let day = searchFrom;

    while (day.isBefore(horizon) && slots.length < 5) {
      const dateStr = day.format('YYYY-MM-DD');

      if (dateStr >= todayStr) {
        const { isWorking, capacity, shifts } = getDayConfig(day, schedules, workingHours);

        if (isWorking && !isDayBlocked(day, blocks)) {
          const booked    = bookedByDay[dateStr] || 0;
          const unlimited = capacity === null || capacity === undefined;
          const isFull    = !unlimited && booked >= capacity;

          // Skip today if shift has already ended
          const shift = shifts[0];
          const todayEnded = dateStr === todayStr && (() => {
            if (!shift?.close) return false;
            const [ch, cm] = shift.close.split(':').map(Number);
            return !now.isBefore(day.hour(ch).minute(cm).second(0));
          })();

          if (!isFull && !todayEnded) {
            slots.push({
              datetime:  day.hour(BOOKING_HOUR).minute(0).second(0).millisecond(0).toISOString(),
              formatted: formatArabicDay(day),
            });
          }
        }
      }

      day = day.add(1, 'day');
    }

    return slots;
  } catch (err) {
    logger.error('getAvailableSlots error', { error: err.message });
    return [];
  }
}

// ── escalateToHuman ───────────────────────────────────────────────────────────

async function escalateToHuman(clinicId, patientPhone, reason) {
  const { error } = await supabase
    .from('conversation_state')
    .upsert(
      {
        clinic_id:       clinicId,
        patient_phone:   patientPhone,
        state:           'awaiting_human',
        state_data:      { reason, escalated_at: new Date().toISOString() },
        last_message_at: new Date().toISOString(),
      },
      { onConflict: 'clinic_id,patient_phone' }
    );
  if (error) logger.warn('escalateToHuman upsert error', { error: error.message });
}

// ── getDayConfig ──────────────────────────────────────────────────────────────
/**
 * Returns { isWorking, capacity, shifts } for a given dayjs object.
 * Priority: specific_date override > weekly rule > clinic.working_hours fallback.
 * capacity: null means unlimited.
 */
function getDayConfig(dayObj, schedules, clinicWorkingHours) {
  const dateStr = dayObj.format('YYYY-MM-DD');
  const dayNum  = dayObj.day(); // 0 = Sunday

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

  // 3. Legacy clinic.working_hours JSONB fallback
  const dayKey  = dayObj.format('dddd').toLowerCase();
  const dayConf = (clinicWorkingHours || {})[dayKey];
  if (!dayConf || dayConf.closed) return { isWorking: false, capacity: null, shifts: [] };
  return {
    isWorking: true,
    capacity:  null,
    shifts:    [{ open: dayConf.open || '09:00', close: dayConf.close || '17:00' }],
  };
}

// ── isDayBlocked ──────────────────────────────────────────────────────────────

function isDayBlocked(dayObj, blocks) {
  const dayStart = dayObj.startOf('day');
  const dayEnd   = dayObj.endOf('day');
  return blocks.some((block) => {
    const bStart = dayjs(block.start_at).tz(TIMEZONE);
    const bEnd   = dayjs(block.end_at).tz(TIMEZONE);
    return bStart.isBefore(dayEnd) && bEnd.isAfter(dayStart);
  });
}

// ── parseArabicDatePreference ─────────────────────────────────────────────────

function parseArabicDatePreference(pref, now) {
  const lower = (pref || '').toLowerCase();

  if (lower.includes('اليوم') || lower.includes('today'))                           return now;
  if (lower.includes('غداً') || lower.includes('غد') ||
      lower.includes('بكره') || lower.includes('tomorrow'))                         return now.add(1, 'day');
  if (lower.includes('بعد غد') || lower.includes('بعد بكره'))                      return now.add(2, 'day');
  if (lower.includes('الأسبوع القادم') || lower.includes('الجاي'))                 return now.add(7, 'day');

  const dayNames = {
    'الأحد': 0, 'الاثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3,
    'الخميس': 4, 'الجمعة': 5, 'السبت': 6,
  };
  for (const [name, num] of Object.entries(dayNames)) {
    if (lower.includes(name)) {
      let target = now.day(num);
      if (!target.isAfter(now.endOf('day'))) target = target.add(7, 'day');
      return target;
    }
  }

  const parsed = dayjs.tz(pref, TIMEZONE);
  if (parsed.isValid() && !parsed.isBefore(now.startOf('day'))) return parsed;

  return now.add(1, 'day'); // safe default
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatArabicDay(d) {
  const days   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  return `${days[d.day()]} ${d.date()} ${months[d.month()]} ${d.year()}`;
}

function formatTime12(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const h12    = h % 12 || 12;
  const mm     = String(m || 0).padStart(2, '0');
  const period = h >= 12 ? 'م' : 'ص';
  return `${h12}:${mm} ${period}`;
}

module.exports = {
  getAvailableSlots,
  escalateToHuman,
  getDayConfig,
  isDayBlocked,
  parseArabicDatePreference,
  formatArabicDay,
  formatTime12,
};
