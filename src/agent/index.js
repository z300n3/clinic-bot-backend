const OpenAI = require('openai');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { toolDefinitions, executeTool, searchFAQ } = require('./tools');
const { saveMessage, loadConversationHistory, supabase, upsertConversationState } = require('../services/supabase');
const logger = require('../utils/logger');

const client = new OpenAI({ apiKey: process.env.OPENAI_APIDEEP_KEY,baseURL:"https://api.deepseek.com" });

const MODEL           = 'deepseek-v4-flash';
const MAX_TOKENS      = 1024;
const MAX_TOOL_ROUNDS = 5;
const TIMEZONE        = 'Asia/Baghdad';

const DAY_NAMES   = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MONTH_NAMES = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

// ── Entry point ───────────────────────────────────────────────────────────────

async function handleIncomingMessage({ clinic, patient, patientPhone, userMessage }) {
  const trimmedMsg = userMessage.trim();

  // 1. Greeting Check
  const greetingRegex = /^(مرحبا|السلام عليكم|هلو|هلا|شلونك|كيفك|مرحباً)[.!?]*$/i;
  if (greetingRegex.test(trimmedMsg)) {
    const reply = "أهلاً بك في العيادة! 😊 أكدر أساعدك بـ: حجز موعد، أوقات الدوام، العنوان، أو السعر. تفضل، كيف أقدر أخدمك؟";
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 2. Out of Scope Check — only catch explicit medical advice requests
  //    (e.g. "شنو علاج الصداع", "وصفلي دواء")
  //    Price questions about medicine are NOT medical advice → let AI handle them naturally
  const medicalAdviceRegex = /^.*(وصف|وصفلي|اعطني|شنو علاج|شنو دواء|كيف اعالج).*(دواء|علاج|حبوب)/i;
  if (medicalAdviceRegex.test(trimmedMsg)) {
    const reply = "ما أكدر أساعدك بهالموضوع، بس أكدر أساعدك بحجز موعد عند الدكتور وهو يفيدك أكثر 😊";
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 3. Price intent check — regex covers Iraqi dialect patterns (0 tokens)
  if (clinic.consultation_price) {
    const priceRegex = /(سعر|شكد|شگد|كم|اجور|أجور|كلف|تكلف|كشفية|الكشف|فحص|فلوس|مبلغ|قيمة|ابيش|أبيش|بيش|باص|الباص).*(سعر|كشف|كشفية|فحص|زيارة|دكتور|طبيب|عيادة|موعد|مراجعة|الدوام|باص|الباص|ابيش|أبيش)|^(السعر|سعر الكشفية|شكد الكشفية|كم الكشفية|سعر الكشف|سعر الفحص|شكد|شگد|ابيش|أبيش|الباص|باص الدكتور|باص الطبيب|سعر الباص|شكد الباص|ابيش الباص|الباص شكد|الباص ابيش)$/i;
    if (priceRegex.test(trimmedMsg)) {
      const reply = `سعر الكشفية ${clinic.consultation_price} دينار 😊`;
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }
  }

  // 4. Location intent check (0 tokens)
  const locationRegex = /^(وين|فين|عنوان|مكان|موقع|شلون).*(العيادة|دكتور|طبيب|مكانكم|عنوانكم|اوصل|أوصل)/i;
  if (locationRegex.test(trimmedMsg)) {
    const reply = `عنوان العيادة: ${clinic.address || 'غير محدد في النظام، يرجى الاتصال بنا.'} 📍`;
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 5. Dynamic Context Injection
  const isBookingIntent = /(موعد|حجز|احجز|وقت|ساعة|متى|يوم|باجر|عگب|غدا|اليوم|ايام|داوم|مفتوحين|شوكت|متواجد|يمته|اجي)/i.test(trimmedMsg);

  // Load history + live schedule + upcoming blocks + conversation state in parallel
  const [history, weeklySchedule, upcomingBlocks, stateRes] = await Promise.all([
    loadConversationHistory(clinic.id, patientPhone, 8),
    isBookingIntent ? loadWeeklySchedule(clinic.id, clinic.working_hours) : Promise.resolve([]),
    isBookingIntent ? loadUpcomingBlocks(clinic.id) : Promise.resolve([]),
    supabase.from('conversation_state').select('state_data').eq('clinic_id', clinic.id).eq('patient_phone', patientPhone).maybeSingle(),
  ]);

  const stateData = stateRes.data?.state_data || {};
  const subState  = stateData.booking_substate || 'idle';

  const isYes = /^(نعم|اي|إي|صح|اكيد|أكيد|تمام|زين|موافق|ي|yep|yes|ok)[.!?]*$/i.test(trimmedMsg);
  const isNo = /^(لا|كلا|خطأ|غلط|مو صح|غير|بدل|no|nope|cancel)[.!?]*$/i.test(trimmedMsg);

  // Fix 1: Booking Confirmation
  if (subState === 'awaiting_confirmation') {
    if (isYes) {
      const { pending_booking } = stateData;
      if (pending_booking) {
        const { data: appt, error } = await supabase
          .from('appointments')
          .insert({
            clinic_id: clinic.id,
            patient_id: patient.id,
            scheduled_at: pending_booking.scheduled_at,
            duration_minutes: pending_booking.duration_minutes,
            queue_number: pending_booking.queue_number,
            status: 'scheduled',
            reason: pending_booking.reason,
            patient_name: pending_booking.patient_name
          })
          .select('id')
          .single();
          
        if (!error) {
          await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
          const ref = appt.id.slice(-6).toUpperCase();
          const scheduledAt = dayjs(pending_booking.scheduled_at).tz(TIMEZONE);
          
          const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
          const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
          const dateStr = `${days[scheduledAt.day()]} ${scheduledAt.date()} ${months[scheduledAt.month()]} ${scheduledAt.year()}`;
          
          const reply = [
            `تم تثبيت موعدك بنجاح! ✅\n`,
            `📅 ${dateStr}`,
            `🎫 رقمك بالدور: ${pending_booking.queue_number}`,
            pending_booking.estimatedLine || null,
            pending_booking.workHoursLine || null,
            `👤 ${pending_booking.patient_name || ''}`,
            `📝 ${pending_booking.reason || ''}\n`,
            `رقم الحجز: #${ref}\n`,
            `راجع العيادة بهذا اليوم وبيكون دورك حسب رقمك.`
          ].filter(Boolean).join('\n');
          
          await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
          return reply;
        }
      }
    } else if (isNo) {
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      const reply = "تم الإلغاء. تفضل، متى تحب تحجز بدلاً منه؟";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    } else {
      const reply = "الرجاء تأكيد الحجز بالإجابة بـ (نعم) أو الإلغاء بـ (لا).";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }
  }

  // Fix 2: Cancel Confirmation
  if (subState === 'awaiting_cancel_confirm') {
    if (isYes) {
      const { pending_cancel_id } = stateData;
      if (pending_cancel_id) {
        await supabase.from('appointments').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', pending_cancel_id);
      }
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      const reply = "تم إلغاء موعدك ✅\nلو تريد تحجز موعد جديد، أنا هنا! 😊";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    } else if (isNo) {
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      const reply = "تمام، موعدك محجوز كما هو 👍";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    } else {
      const reply = "هل أنت متأكد من إلغاء الموعد؟ (نعم / لا)";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }
  }

  // Fix 3: Rebook Confirmation
  if (subState === 'awaiting_rebook_confirm') {
    if (isYes) {
      const { existing_appt_id } = stateData;
      if (existing_appt_id) {
        await supabase.from('appointments').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', existing_appt_id);
      }
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      const reply = "تم إلغاء الموعد السابق. تفضل، أي يوم يناسبك للحجز الجديد؟";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    } else if (isNo) {
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      const reply = "تمام، موعدك محجوز كما هو 👍";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    } else {
      const reply = "تريد تلغي الموعد السابق وتحجز غيره؟ (نعم / لا)";
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }
  }

  // 4. FAQ Check (0 tokens)
  const faqMatch = await searchFAQ(clinic.id, trimmedMsg);
  if (faqMatch.found) {
    const reply = faqMatch.answer;
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // History and state already loaded above

  const messages = buildMessages(history, userMessage);
  const system   = buildSystemPrompt(clinic, weeklySchedule, upcomingBlocks);

  let activeTools = subState === 'idle' ? toolDefinitions : [];
  let currentMessages = messages;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const payload = {
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      messages:   [{ role: 'system', content: system }, ...currentMessages],
    };

    if (activeTools.length > 0) {
      payload.tools = activeTools.map((t) => ({
        type:     'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const response = await client.chat.completions.create(payload);

    const choice = response.choices[0];
    logger.debug('OpenAI response', { finishReason: choice.finish_reason, round });

    // ── Final answer ──────────────────────────────────────────────────────────
    if (choice.finish_reason === 'stop') {
      const text = choice.message.content?.trim() || 'عذراً، ما قدرت أفهم. حاول مرة ثانية.';

      await saveMessage({
        clinicId:     clinic.id,
        patientId:    patient.id,
        patientPhone,
        role:         'assistant',
        content:      text,
      });

      return text;
    }

    // ── Tool calls ────────────────────────────────────────────────────────────
    if (choice.finish_reason === 'tool_calls') {
      const toolCalls = choice.message.tool_calls;

      await saveMessage({
        clinicId:     clinic.id,
        patientId:    patient.id,
        patientPhone,
        role:         'assistant',
        content:      choice.message.content || null,
        toolCalls,
      });

      currentMessages = [...currentMessages, choice.message];

      for (const toolCall of toolCalls) {
        const name  = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        logger.info('Tool call', { name, args });

        // Fix 3: Intercept booking flows to check for existing appointment
        if ((name === 'check_availability' || name === 'book_appointment') && subState === 'idle') {
          const { data: existing } = await supabase
            .from('appointments')
            .select('id, scheduled_at, patient_name')
            .eq('clinic_id', clinic.id)
            .eq('patient_id', patient.id)
            .in('status', ['scheduled', 'confirmed'])
            .gte('scheduled_at', new Date().toISOString())
            .lte('scheduled_at', dayjs().add(7, 'day').toISOString())
            .order('scheduled_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (existing) {
            await upsertConversationState(clinic.id, patientPhone, 'active', {
              booking_substate: 'awaiting_rebook_confirm',
              existing_appt_id: existing.id
            });
            
            const eDate = dayjs(existing.scheduled_at).tz(TIMEZONE);
            const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
            const dateStr = `${days[eDate.day()]} ${eDate.format('YYYY/MM/DD')}`;
            
            const reply = `عندك موعد محجوز يوم ${dateStr} 📅\nتريد تلغيه وتحجز غيره؟ (نعم / لا)`;
            await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
            return reply;
          }
        }

        // Out of Scope Interceptor
        if (name === 'out_of_scope_response') {
          const reply = 'عذراً، عملي كسكرتير آلي يقتصر على حجز المواعيد والإجابة على الاستفسارات الخاصة بالعيادة فقط.';
          await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
          return reply;
        }

        const result = await executeTool(name, args, {
          clinic,
          patient,
          patientPhone,
        });

        logger.info('Tool result', {
          name,
          result: JSON.stringify(result).slice(0, 200),
        });

        await saveMessage({
          clinicId:     clinic.id,
          patientId:    patient.id,
          patientPhone,
          role:         'tool',
          content:      JSON.stringify(result),
          toolCalls:    [{ tool_call_id: toolCall.id, name }],
        });

        currentMessages = [
          ...currentMessages,
          { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) },
        ];
      }

      continue;
    }

    logger.warn('Unexpected finish_reason', { finishReason: choice.finish_reason });
    break;
  }

  // Exceeded max rounds
  const fallback = 'عذراً، ما قدرت أكمل طلبك. تواصل معنا مباشرة لو تحتاج مساعدة.';
  await saveMessage({
    clinicId:     clinic.id,
    patientId:    patient.id,
    patientPhone,
    role:         'assistant',
    content:      fallback,
  });
  return fallback;
}

// ── Load weekly schedule from DB ──────────────────────────────────────────────

async function loadWeeklySchedule(clinicId, fallbackWorkingHours) {
  const { data, error } = await supabase
    .from('availability_schedules')
    .select('day_of_week, is_working_day, daily_capacity, shifts')
    .eq('clinic_id', clinicId)
    .is('specific_date', null)
    .order('day_of_week', { ascending: true });

  if (error) {
    logger.warn('loadWeeklySchedule error — falling back to clinic.working_hours', { error: error.message });
  }

  if (data && data.length > 0) return data;

  // Fallback: convert legacy working_hours JSONB → same structure
  const legacyKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return legacyKeys.map((key, i) => {
    const wh = (fallbackWorkingHours || {})[key] || {};
    return {
      day_of_week:    i,
      is_working_day: !wh.closed,
      daily_capacity: null,
      shifts:         wh.closed ? [] : [{ open: wh.open || '09:00', close: wh.close || '17:00' }],
    };
  });
}

// ── Load upcoming blocked periods (next 30 days) ──────────────────────────────

async function loadUpcomingBlocks(clinicId) {
  const now     = dayjs().tz(TIMEZONE);
  const horizon = now.add(30, 'day').endOf('day');

  const { data, error } = await supabase
    .from('blocked_periods')
    .select('start_at, end_at, is_full_day, reason')
    .eq('clinic_id', clinicId)
    .gt('end_at', now.startOf('day').toISOString())
    .lt('start_at', horizon.toISOString())
    .order('start_at', { ascending: true });

  if (error) {
    logger.warn('loadUpcomingBlocks error', { error: error.message });
    return [];
  }
  return data || [];
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildMessages(history, currentUserMessage) {
  // Include user, assistant, AND doctor messages.
  // Doctor messages are mapped to 'assistant' role with a [الطبيب] prefix so the
  // AI knows a human doctor already responded and won't repeat the same information.
  const textRows = history
    .filter((m) => ['user', 'assistant', 'doctor'].includes(m.role) && m.content?.trim())
    .map((m) => ({
      role:    m.role === 'doctor' ? 'assistant' : m.role,
      srcRole: m.role,   // keep original role for deduplication logic
      content: m.role === 'doctor'
        ? `[رسالة الطبيب للمريض]: ${m.content}`
        : m.content,
    }));

  // Deduplicate consecutive messages from the same *original* source only.
  // This prevents doctor messages from being collapsed with AI assistant messages.
  const deduped = [];
  for (const row of textRows) {
    const last = deduped[deduped.length - 1];
    if (last && last.srcRole === row.srcRole) {
      deduped[deduped.length - 1] = row;
    } else {
      deduped.push(row);
    }
  }

  while (deduped.length > 0 && deduped[0].role === 'assistant') deduped.shift();

  const last = deduped[deduped.length - 1];
  if (!last || last.content?.trim() !== currentUserMessage.trim()) {
    deduped.push({ role: 'user', srcRole: 'user', content: currentUserMessage });
  }

  return deduped.map((m) => ({ role: m.role, content: m.content }));
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(clinic, weeklySchedule, upcomingBlocks) {
  const today = dayjs().tz(TIMEZONE);
  
  let todayHours = 'مغلق اليوم';
  const dayConf = weeklySchedule.find(s => s.day_of_week === today.day());
  if (dayConf && dayConf.is_working_day && dayConf.shifts?.[0]) {
    todayHours = `${fmt12(dayConf.shifts[0].open)} - ${fmt12(dayConf.shifts[0].close)}`;
  }

  const priceText = clinic.consultation_price ? `${clinic.consultation_price} دينار` : 'غير محدد';
  const priceInstruction = clinic.consultation_price 
    ? 'أجب المريض بالسعر المذكور أدناه مباشرة إذا سأل عنه.'
    : 'إذا سألك المريض عن السعر، قل له فقط: "عذراً، ما عندي معلومة عن السعر حالياً، تگدر تتصل بالعيادة وتستفسر منهم." (ممنوع استخدام رسالة الرفض الطبية هنا).';

  return `أنت مساعد عيادة "${clinic.name}" (${clinic.specialty}).
تحدث باللهجة العراقية باختصار ودفء.

الطبيب: ${clinic.doctor_name} | سعر الكشفية: ${priceText} | العنوان: ${clinic.address}
دوام الأسبوع:
${formatSchedule(weeklySchedule)}
إجازات قادمة:
${formatBlocks(upcomingBlocks)}
تاريخ اليوم: ${formatBlockDate(today)} (${today.format('YYYY-MM-DD')})
الوقت الحالي: ${fmt12(today.format('HH:mm'))} — دوام اليوم: ${todayHours}

${priceInstruction}

**قواعد الحجز:**
- الحجز باليوم فقط (لا تسأل عن الساعة).
- احجز عبر الأداة بعد معرفة: الاسم، اليوم، السبب.
- لا تعطي نصائح طبية (لا تشخيص، لا وصف دواء).

**سلوكك مع المريض:**
- حاول تساعد المريض دائماً قبل ما ترفض أي طلب.
- إذا سأل "شوكت موعدي" أو "هل انا حاجز" أو "رقمي" → استخدم أداة cancel_appointment للبحث عن موعده (بدون ما تلغيه)، وأخبره بالمعلومات.
- إذا سأل عن السعر/الكشفية/الباص/ابيش بأي صياغة → أجبه بسعر الكشفية: ${priceText}.
- إذا كانت رسالة المريض عبارة عن استفسار أو طلب خارج نطاق مهامك كسكرتير للعيادة أو لا علاقة له بالحجوزات والمواعيد → استخدم أداة out_of_scope_response فوراً لتوجيه رسالة ثابتة للمريض.
- إذا ما فهمت الرسالة → اسأل المريض يوضح شنو يريد، لا ترفض مباشرة.
- إذا طلب شيء فعلاً يخص العيادة لكنه خارج قدرتك → وجّهه بلطف للاتصال بالعيادة مباشرة.`;
}

// ── Format schedule for system prompt ────────────────────────────────────────

function fmt12(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const h12    = h % 12 || 12;
  const mm     = String(m || 0).padStart(2, '0');
  const period = h >= 12 ? 'م' : 'ص';
  return `${h12}:${mm} ${period}`;
}

function formatSchedule(schedule) {
  if (!schedule || schedule.length === 0) return '  غير محدد';

  return schedule.map((day) => {
    const name = DAY_NAMES[day.day_of_week] || `يوم ${day.day_of_week}`;
    if (!day.is_working_day) {
      return `  - ${name}: مغلق (إجازة)`;
    }
    const shift = (day.shifts || [])[0];
    const hours = shift
      ? ` | الدوام: ${fmt12(shift.open)}${shift.close ? ' — ' + fmt12(shift.close) : ''}`
      : '';
    const cap = (day.daily_capacity === null || day.daily_capacity === undefined)
      ? 'العدد مفتوح'
      : `يستقبل ${day.daily_capacity} موعد`;
    return `  - ${name}: مفتوح — ${cap}${hours}`;
  }).join('\n');
}

// ── Format blocked periods for system prompt ─────────────────────────────────

function formatBlocks(blocks) {
  if (!blocks || blocks.length === 0) return '  لا توجد أيام غياب مسجلة.';

  return blocks.map((b) => {
    const start  = dayjs(b.start_at).tz(TIMEZONE);
    const end    = dayjs(b.end_at).tz(TIMEZONE);
    const reason = b.reason ? ` (${b.reason})` : '';

    if (b.is_full_day) {
      const sameDay = start.format('YYYY-MM-DD') === end.format('YYYY-MM-DD');
      const range   = sameDay
        ? formatBlockDate(start)
        : `من ${formatBlockDate(start)} إلى ${formatBlockDate(end)}`;
      return `  - ${range}: مغلق طوال اليوم${reason}`;
    }

    return `  - ${formatBlockDate(start)} من ${fmt12(start.format('HH:mm'))} إلى ${fmt12(end.format('HH:mm'))}: مغلق${reason}`;
  }).join('\n');
}

function formatBlockDate(d) {
  return `${DAY_NAMES[d.day()]} ${d.date()} ${MONTH_NAMES[d.month()]} ${d.year()}`;
}

function extractText(blocks) {
  const block = (blocks || []).find((b) => b.type === 'text');
  return block?.text?.trim() || null;
}

module.exports = { handleIncomingMessage };
