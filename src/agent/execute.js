const { supabase, saveMessage, upsertConversationState } = require('../services/supabase');
const { getBaghdadNow, formatTime12, TIMEZONE, dayjs } = require('../utils/time');
const logger = require('../utils/logger');

const BOOKING_HOUR = 12;

async function execute(decision, clinic, patient, patientPhone) {
  const { action } = decision;

  switch (action) {

    case 'REPLY_GREETING':
      return `أهلاً بك في عيادة ${clinic.name}! 😊\nأكدر أساعدك بـ: حجز موعد، أوقات الدوام، العنوان، أو السعر.`;

    case 'REPLY_MEDICAL_REJECT':
      return 'ما أكدر أساعدك بهالموضوع، بس أكدر أساعدك بحجز موعد عند الدكتور وهو يفيدك أكثر 😊';

    case 'REPLY_FAQ':
      return decision.answer;

    case 'REPLY_DIRECT':
    case 'REPLY_COMBINED':
      return decision.answer;

    case 'REPLY_SPECIFIC_DAY': {
      const { dayInfo } = decision;
      if (!dayInfo.isWorking || dayInfo.isBlocked) {
        return `🔹 بخصوص يوم ${dayInfo.displayDate}، العيادة ستكون مغلقة (عطلة/إجازة).`;
      }
      if (dayInfo.substitute) {
        return `🔹 بخصوص يوم ${dayInfo.displayDate}، الدكتور الأساسي غائب وسيتواجد مكانه الطبيب البديل: ${dayInfo.substitute}.`;
      }
      return `🔹 نعم، بخصوص يوم ${dayInfo.displayDate}، الطبيب متواجد والدوام مستمر بشكل طبيعي.`;
    }

    case 'REPLY_ABSENCE':
      return decision.summary;

    case 'REPLY_SCHEDULE':
      return decision.summary;

    case 'REPLY_CONTACT_CLINIC':
      return 'ما عندي معلومة عن هذا الموضوع، تواصل مع العيادة مباشرة للاستفسار.';

    case 'ASK_MISSING': {
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_info',
        partial_booking: {
          patient_name: decision.extracted?.patient_name || null,
          reason:       decision.extracted?.reason || null,
        }
      });
      const fields = decision.fields.join(' و ');
      let msg = '';
      if (decision.answer) msg += decision.answer + '\n\n---\n\n';
      msg += `أحتاج منك ${fields} لإكمال الحجز 😊`;
      return msg;
    }

    case 'ASK_FULL_NAME': {
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_info',
        partial_booking: {
          patient_name: decision.extracted?.patient_name || null,
          reason:       decision.extracted?.reason || null,
        }
      });
      let msg = '';
      if (decision.answer) msg += decision.answer + '\n\n---\n\n';
      msg += `عذراً، أحتاج منك كتابة الاسم الثنائي (الاسم الأول واسم الأب) لتسجيل الحجز بشكل صحيح.`;
      return msg;
    }

    case 'NO_APPOINTMENTS':
      return 'ما عندك أي موعد قادم مسجل حالياً.';

    case 'SHOW_APPOINTMENTS': {
      const { appts } = decision;
      const lines = appts.map(a => {
        const d = dayjs(a.scheduled_at).tz(TIMEZONE);
        const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                        'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
        const dateStr = `${days[d.day()]} ${d.date()} ${months[d.month()]}`;
        return `📅 ${dateStr} — 🎫 رقم الدور: ${a.queue_number} — 👤 ${a.patient_name || ''}`;
      });
      return `مواعيدك القادمة:\n${lines.join('\n')}`;
    }

    case 'ASK_CANCEL_SELECT': {
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_cancel_select',
        cancel_appts: decision.appts
      });
      const lines = decision.appts.map(a => {
        const d = dayjs(a.scheduled_at).tz(TIMEZONE);
        const dateStr = `${d.date()}/${d.month()+1}`;
        return `🔹 ${a.patient_name || 'بدون اسم'} (يوم ${dateStr})`;
      });
      return `عندك أكثر من موعد قادم:\n${lines.join('\n')}\n\nاكتب اسم المريض اللي تريد تلغي موعده، أو اكتب "الغي كل مواعيدي".`;
    }

    case 'CONFIRM_CANCEL_ALL': {
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_cancel_all_confirm',
        cancel_appt_ids: decision.appts.map(a => a.id)
      });
      return `تأكد إنك تريد إلغاء جميع مواعيدك القادمة (${decision.appts.length} مواعيد)؟ (نعم / لا)`;
    }

    case 'CONFIRM_CANCEL': {
      const targetAppt = decision.targetAppt || {};
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_cancel_confirm',
        cancel_target_id: targetAppt.id
      });
      const d = targetAppt.scheduled_at ? dayjs(targetAppt.scheduled_at).tz(TIMEZONE) : dayjs().tz(TIMEZONE);
      const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
      const dateStr = `${days[d.day()]} ${d.date()}/${d.month()+1}`;
      return `تأكد إنك تريد إلغاء موعد "${targetAppt.patient_name || 'بدون اسم'}" يوم ${dateStr}؟ (نعم / لا)`;
    }

    case 'DO_CANCEL': {
      const { cancel_target_id } = decision.data || {};
      
      if (cancel_target_id) {
        await supabase.from('appointments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', cancel_target_id);
      } else {
        // Fallback for safety
        const { data: pat } = await supabase
          .from('patients').select('id')
          .eq('clinic_id', clinic.id).eq('phone_number', patientPhone).maybeSingle();

        if (pat) {
          const { data: appt } = await supabase
            .from('appointments').select('id')
            .eq('clinic_id', clinic.id).eq('patient_id', pat.id)
            .in('status', ['scheduled','confirmed'])
            .gte('scheduled_at', new Date().toISOString())
            .order('scheduled_at', { ascending: true }).limit(1).maybeSingle();
          if (appt) {
            await supabase.from('appointments')
              .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
              .eq('id', appt.id);
          }
        }
      }

      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      return 'تم إلغاء موعدك بنجاح ✅';
    }

    case 'DO_CANCEL_ALL': {
      const { cancel_appt_ids } = decision.data || {};
      if (cancel_appt_ids && cancel_appt_ids.length > 0) {
        await supabase.from('appointments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .in('id', cancel_appt_ids);
      }
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      return 'تم إلغاء جميع مواعيدك بنجاح ✅';
    }

    case 'CONFIRM_REBOOK': {
      const { existingAppt } = decision;
      const d = dayjs(existingAppt.scheduled_at).tz(TIMEZONE);
      const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
      const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                      'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
      const dateStr = `${days[d.day()]} ${d.date()} ${months[d.month()]}`;

      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_rebook_confirm',
        existing_appt_id: existingAppt.id,
      });

      return `عندك موعد محجوز يوم ${dateStr} باسم "${existingAppt.patient_name}" 📅\nتريد تلغيه وتحجز غيره؟ (نعم / لا)`;
    }

    case 'DO_REBOOK': {
      const { existing_appt_id } = decision.data;
      if (existing_appt_id) {
        await supabase.from('appointments')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', existing_appt_id);
      }
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      return 'تم إلغاء الموعد السابق ✅\nأي يوم يناسبك للحجز الجديد؟';
    }

    case 'CANCEL_FLOW':
      await upsertConversationState(clinic.id, patientPhone, 'active', {});
      return 'تمام، موعدك محجوز كما هو 👍';

    case 'DAY_NOT_WORKING': {
      const { dayInfo } = decision;
      return `${dayInfo.displayDate} مو يوم دوام في العيادة. تكدر تحجز يوم ثاني؟`;
    }

    case 'DAY_BLOCKED': {
      const { dayInfo } = decision;
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_date',
        partial_booking: {
          patient_name: decision.extracted?.patient_name || null,
          reason:       decision.extracted?.reason || null,
        }
      });
      return `${dayInfo.displayDate} الدكتور غير متوفر ولا يوجد بديل. تكدر تحجز يوم ثاني؟`;
    }

    case 'SHIFT_ENDED': {
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_date',
        partial_booking: {
          patient_name: decision.extracted?.patient_name || null,
          reason:       decision.extracted?.reason || null,
        }
      });
      return 'انتهى دوام العيادة اليوم 🕐\nتكدر تحجز ليوم ثاني؟ قولي أي يوم يناسبك.';
    }

    case 'DAY_FULL': {
      const { dayInfo } = decision;
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'awaiting_date',
        partial_booking: {
          patient_name: decision.extracted?.patient_name || null,
          reason:       decision.extracted?.reason || null,
        }
      });
      return `عذراً، اكتمل العدد ليوم ${dayInfo.displayDate}. جرب يوماً آخر.`;
    }

    case 'BOOK':
    case 'BOOK_WITH_SUBSTITUTE': {
      const result = await doBooking(decision, clinic, patient, patientPhone);
      await upsertConversationState(clinic.id, patientPhone, 'active', {
        booking_substate: 'idle'
      });
      return result;
    }

    case 'UNCLEAR':
      return 'ما فهمت طلبك. تكدر توضح شنو تريد؟ 😊';

    default:
      logger.warn('[Execute] Unknown action', { action });
      return 'عذراً، صار خطأ. حاول مرة ثانية.';
  }
}

async function doBooking(decision, clinic, patient) {
  try {
    if (!decision.dayInfo || !decision.dayInfo.targetDay) {
      return 'أحتاج تحديد اليوم المطلوب للحجز. أي يوم يناسبك؟';
    }
    const { extracted, dayInfo } = decision;
    const now = getBaghdadNow();

    const targetDay = dayjs(dayInfo.targetDay).tz(TIMEZONE);
    const dayStartISO = targetDay.toISOString();
    const dayEndISO   = targetDay.endOf('day').toISOString();

    const { data: bookedAppts } = await supabase
      .from('appointments').select('id')
      .eq('clinic_id', clinic.id)
      .in('status', ['scheduled','confirmed'])
      .gte('scheduled_at', dayStartISO)
      .lte('scheduled_at', dayEndISO);

    const booked      = (bookedAppts || []).length;
    const queueNumber = booked + 1;
    const duration    = clinic.appointment_duration_minutes || 30;
    const scheduledAt = targetDay.hour(BOOKING_HOUR).minute(0).second(0).millisecond(0);

    // Estimated time
    const shift = dayInfo.shifts?.[0];
    let estimatedLine = '';
    let workHoursLine = '';
    if (shift?.open) {
      const [sh, sm] = shift.open.split(':').map(Number);
      const estimated = targetDay.hour(sh).minute(sm || 0)
        .add((queueNumber - 1) * duration, 'minute');
      estimatedLine = `⏰ وقتك التقريبي: ${formatTime12(estimated.format('HH:mm'))}`;
      const openFmt  = formatTime12(shift.open);
      const closeFmt = shift.close ? ` — ${formatTime12(shift.close)}` : '';
      workHoursLine  = `🕐 دوام العيادة: ${openFmt}${closeFmt}`;
    }

    const servedBy = dayInfo.substitute || null;

    const { data: appt, error } = await supabase
      .from('appointments')
      .insert({
        clinic_id:        clinic.id,
        patient_id:       patient.id,
        scheduled_at:     scheduledAt.toISOString(),
        duration_minutes: duration,
        queue_number:     queueNumber,
        status:           'scheduled',
        reason:           extracted.reason,
        patient_name:     extracted.patient_name,
        served_by:        servedBy,
      })
      .select('id').single();

    if (error) {
      logger.error('[Execute] Booking insert failed', { error: error.message });
      return 'فشل حفظ الموعد. حاول مرة ثانية أو تواصل معنا مباشرة.';
    }

    const ref = appt.id.slice(-6).toUpperCase();
    const substituteNote = servedBy
      ? `⚠️ ملاحظة: ${clinic.doctor_name} غائب هذا اليوم. البديل: ${servedBy}`
      : null;

    return [
      'تم تثبيت موعدك بنجاح! ✅',
      `📅 ${dayInfo.displayDate}`,
      substituteNote,
      `🎫 رقمك بالدور: ${queueNumber}`,
      estimatedLine || null,
      workHoursLine || null,
      `👤 ${extracted.patient_name}`,
      `📝 ${extracted.reason}`,
      `رقم الحجز: #${ref}`,
      'راجع العيادة بهذا اليوم وبيكون دورك حسب رقمك.',
    ].filter(Boolean).join('\n');
  } catch (err) {
    logger.error('[Execute] doBooking error', { error: err.message });
    return 'صار خطأ بالحجز. حاول مرة ثانية أو تواصل معنا مباشرة.';
  }
}

module.exports = { execute };
