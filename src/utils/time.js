const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = 'Asia/Baghdad';

function getBaghdadNow() {
  return dayjs().tz(TIMEZONE);
}

// Check if currently open based on weeklySchedule
function isTodayOpen(weeklySchedule) {
  const now = getBaghdadNow();
  const dayConf = weeklySchedule.find(s => s.day_of_week === now.day());
  
  if (!dayConf || !dayConf.is_working_day || !dayConf.shifts || dayConf.shifts.length === 0) {
    return false;
  }
  
  const currentMinutes = now.hour() * 60 + now.minute();
  
  return dayConf.shifts.some(shift => {
    const [openH, openM] = shift.open.split(':').map(Number);
    const [closeH, closeM] = (shift.close || '23:59').split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;
    return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
  });
}

function getTodayHoursString(weeklySchedule) {
  const now = getBaghdadNow();
  const dayConf = weeklySchedule.find(s => s.day_of_week === now.day());
  
  if (!dayConf || !dayConf.is_working_day || !dayConf.shifts || dayConf.shifts.length === 0) {
    return 'مغلق اليوم';
  }
  
  return dayConf.shifts.map(s => {
    return `${formatTime12(s.open)} - ${s.close ? formatTime12(s.close) : 'مفتوح'}`;
  }).join(' و ');
}

function getCurrentTimeString() {
  const now = getBaghdadNow();
  return formatTime12(now.format('HH:mm'));
}

function formatTime12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const h12 = h % 12 || 12;
  const mm = String(m || 0).padStart(2, '0');
  const period = h >= 12 ? 'م' : 'ص';
  return `${h12}:${mm} ${period}`;
}

module.exports = {
  dayjs,
  getBaghdadNow,
  isTodayOpen,
  getTodayHoursString,
  getCurrentTimeString,
  formatTime12,
  TIMEZONE
};
