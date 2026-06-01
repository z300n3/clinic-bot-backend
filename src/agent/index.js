const OpenAI = require('openai');
const { getBaghdadNow, isTodayOpen, getTodayHoursString, getCurrentTimeString, formatTime12, TIMEZONE, dayjs } = require('../utils/time');

const { toolDefinitions, executeTool, searchFAQ } = require('./tools');
const { saveMessage, loadConversationHistory, supabase, upsertConversationState } = require('../services/supabase');
const logger = require('../utils/logger');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL           = 'gpt-4o-mini';
const MAX_TOKENS      = 1024;
const MAX_TOOL_ROUNDS = 5;

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
  let subState  = stateData.booking_substate || 'idle';

  const isYes = /^(نعم|اي|إي|صح|اكيد|أكيد|تمام|زين|موافق|ي|yep|yes|ok)[.!?]*$/i.test(trimmedMsg);
  const isNo = /^(لا|كلا|خطأ|غلط|مو صح|غير|بدل|no|nope|cancel)[.!?]*$/i.test(trimmedMsg);





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
      // User sent something unrelated — DON'T trap them.
      // Reset to idle and let the message flow through normal processing.
      await upsertConversationState(clinic.id, patientPhone, 'active', { booking_substate: 'idle' });
      subState = 'idle'; // Let the rest of the flow treat it as idle
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
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls) {
      const text = choice.message.content?.trim() || 'عذراً، ما قدرت أفهم. حاول مرة ثانية.';

      // Text-based tool trigger (Bypass broken tool calls for deepseek)
      if (text.includes('CHECK_APPT')) {
        const result = await executeTool('check_my_appointment', {}, { clinic, patient, patientPhone });
        await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: result.message });
        return result.message;
      }

      if (text.includes('BOOK_APPT|')) {
        try {
          const parts = text.split('BOOK_APPT|')[1].split('|');
          const pName = parts[0]?.trim();
          const pDate = parts[1]?.trim();
          const pReason = parts[2]?.trim();
          
          if (pName && pDate && pReason) {
            const result = await executeTool('book_appointment', { patient_name: pName, appointment_date: pDate, reason: pReason }, { clinic, patient, patientPhone });
            await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: result.message });
            return result.message;
          }
        } catch (e) {
          logger.error('Text-based BOOK_APPT parsing failed', { error: e.message });
        }
      }

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

        // Fix 3: Intercept booking flows to check for existing appointment for the SAME person
        if (name === 'book_appointment' && subState === 'idle') {
          const targetName = args.patient_name?.trim() || patient.name?.trim() || '';
          
          const { data: existingAppts } = await supabase
            .from('appointments')
            .select('id, scheduled_at, patient_name')
            .eq('clinic_id', clinic.id)
            .eq('patient_id', patient.id)
            .in('status', ['scheduled', 'confirmed'])
            .gte('scheduled_at', new Date().toISOString())
            .lte('scheduled_at', getBaghdadNow().add(7, 'day').toISOString())
            .order('scheduled_at', { ascending: true });

          const existing = (existingAppts || []).find(a => {
            const aName = a.patient_name?.trim() || patient.name?.trim() || '';
            // If both don't have explicit names, they match (both are the main patient)
            // Or if the names match exactly.
            return (!aName && !targetName) || (aName === targetName);
          });

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

        // Check my appointment Interceptor
        if (name === 'check_my_appointment') {
          const result = await executeTool(name, {}, { clinic, patient, patientPhone });
          await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: result.message });
          return result.message;
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
  const now     = getBaghdadNow();
  const horizon = now.add(30, 'day').endOf('day');

  const { data, error } = await supabase
    .from('blocked_periods')
    .select('start_at, end_at, is_full_day, reason, substitute_doctor_name, substitute_doctor_note')
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
  const today = getBaghdadNow();
  const isOpen = isTodayOpen(weeklySchedule);
  const todayHours = getTodayHoursString(weeklySchedule);
  const currentTime = getCurrentTimeString();

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
الوقت الحالي: ${currentTime} — دوام اليوم: ${todayHours} — ${isOpen ? 'مفتوح الآن ✅' : 'خارج وقت الدوام'}

${priceInstruction}

**قواعد الحجز:**
- الحجز باليوم فقط (لا تسأل عن الساعة).
- مسموح للمريض أن يحجز لنفسه أو لأي شخص آخر (مثل ابنه، زوجته، أو صديقه).
- قبل الحجز، يجب أن تعرف: الاسم، اليوم، السبب.
- لا تعطي نصائح طبية (لا تشخيص، لا وصف دواء).
- تنبيه مهم: إذا كان هناك طبيب بديل مذكور في "إجازات قادمة" أعلاه، فالحجز متاح بذلك اليوم. لا تنكر وجود البديل أبداً. أخبر المريض أن الطبيب الأساسي غائب وأن البديل سيكون موجوداً بنفس الدوام.
- تحذير صارم جداً: إياك أن تقوم بتأكيد الحجز بكتابة رسالة تأكيد نصية عادية! لتأكيد الحجز، يجب عليك إما استدعاء الأداة book_appointment، أو كتابة الأمر التالي حصراً باللغة الإنجليزية:
BOOK_APPT|اسم_المريض|تاريخ_الحجز|السبب
مثال: BOOK_APPT|علي محمد|باجر|مراجعة

**سلوكك مع المريض:**
- حاول تساعد المريض دائماً قبل ما ترفض أي طلب.
- إذا سأل المريض عن موعده أو حجزه الحالي أو رقمه بالدور (مثل: "شوكت موعدي"، "هل انا حاجز"، "رقمي شكد") → ممنوع الرد بأي جملة! اكتب فقط هذه الكلمة باللغة الإنجليزية: CHECK_APPT
- لإلغاء الموعد استخدم أداة cancel_appointment، لكن تأكد من رغبة المريض بالإلغاء أولاً.
- إذا سأل عن السعر/الكشفية/الباص/ابيش بأي صياغة → أجبه بسعر الكشفية: ${priceText}.
- إذا ذكر المريض اسم طبيب يختلف عن اسم دكتور العيادة (${clinic.doctor_name})، أبلغه بلطف أنه ربما أخطأ في الرقم وأن هذه عيادة الدكتور ${clinic.doctor_name}. لا تستخدم أداة out_of_scope_response في هذه الحالة.
- إذا كانت رسالة المريض عبارة عن استفسار أو طلب خارج نطاق مهامك كسكرتير للعيادة أو لا علاقة له بالحجوزات والمواعيد → استخدم أداة out_of_scope_response فوراً لتوجيه رسالة ثابتة للمريض.
- إذا ما فهمت الرسالة → اسأل المريض يوضح شنو يريد، لا ترفض مباشرة.
- إذا طلب شيء فعلاً يخص العيادة لكنه خارج قدرتك → وجّهه بلطف للاتصال بالعيادة مباشرة.`;
}

// ── Format schedule for system prompt ────────────────────────────────────────

// Removed fmt12 since we use formatTime12 from utils

function formatSchedule(schedule) {
  if (!schedule || schedule.length === 0) return '  غير محدد';

  return schedule.map((day) => {
    const name = DAY_NAMES[day.day_of_week] || `يوم ${day.day_of_week}`;
    if (!day.is_working_day) {
      return `  - ${name}: مغلق (إجازة)`;
    }
    const shift = (day.shifts || [])[0];
    const hours = shift
      ? ` | الدوام: ${formatTime12(shift.open)}${shift.close ? ' — ' + formatTime12(shift.close) : ''}`
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
    const startD = dayjs(b.start_at).tz(TIMEZONE);
    const endD = dayjs(b.end_at).tz(TIMEZONE);
    const reason = b.reason ? ` (${b.reason})` : '';
    const sub = b.substitute_doctor_name 
      ? ` ⚠️ يوجد طبيب بديل: ${b.substitute_doctor_name} — الحجز متاح هذا اليوم بنفس الدوام`
      : ' — لا يوجد بديل، الحجز مغلق';

    if (b.is_full_day) {
      const sameDay = startD.format('YYYY-MM-DD') === endD.format('YYYY-MM-DD');
      const range = sameDay ? formatBlockDate(startD)
        : `من ${formatBlockDate(startD)} إلى ${formatBlockDate(endD)}`;
      return `  - ${range}: غياب${reason}${sub}`;
    }
    return `  - ${formatBlockDate(startD)} من ${formatTime12(startD.format('HH:mm'))} إلى ${formatTime12(endD.format('HH:mm'))}: غياب${reason}${sub}`;
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
