const OpenAI = require('openai');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { toolDefinitions, executeTool, checkFaqDirect } = require('./tools');
const { saveMessage, loadConversationHistory, supabase } = require('../services/supabase');
const logger = require('../utils/logger');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL           = 'gpt-4o-mini';
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

  // 2. Out of Scope Check
  const outOfScopeRegex = /(دواء|علاج|تشخيص|مرض|عملية)/i;
  if (outOfScopeRegex.test(trimmedMsg)) {
    const reply = "عذراً، أنا مساعد حجز فقط 😊\nأكدر أساعدك بـ: حجز موعد، أوقات الدوام، العنوان، أو السعر.";
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
    return reply;
  }

  // 3. Price intent check — let AI decide regardless of phrasing
  if (clinic.consultation_price) {
    const askingPrice = await isAskingAboutConsultationPrice(trimmedMsg);
    if (askingPrice) {
      const reply = `سعر الكشفية ${clinic.consultation_price} دينار 😊`;
      await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: reply });
      return reply;
    }
  }

  // 4. FAQ Check
  const faqRes = await checkFaqDirect(trimmedMsg, clinic.id);
  if (faqRes.found && faqRes.answer) {
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: faqRes.answer });
    return faqRes.answer;
  }

  // Load history + live schedule + upcoming blocks + conversation state in parallel
  const [history, weeklySchedule, upcomingBlocks, stateRes] = await Promise.all([
    loadConversationHistory(clinic.id, patientPhone, 10),
    loadWeeklySchedule(clinic.id, clinic.working_hours),
    loadUpcomingBlocks(clinic.id),
    supabase.from('conversation_state').select('state_data').eq('clinic_id', clinic.id).eq('patient_phone', patientPhone).maybeSingle(),
  ]);

  const stateData = stateRes.data?.state_data || {};
  const subState  = stateData.booking_substate || 'idle';

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
        const input = JSON.parse(toolCall.function.arguments);

        logger.info('Tool call', { name, input });

        const result = await executeTool(name, input, {
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

  return `أنت مساعد حجز لـ "${clinic.name}" (${clinic.specialty}).
تحدث باللهجة العراقية باختصار.

نطاق عملك المسموح:
1. الحجز والإلغاء (حسب القواعد).
2. الإجابة عن أوقات الدوام، العنوان، والأسعار.
${priceInstruction}

**قاعدة السعر (مهم جداً):**
- إذا سأل المريض عن "السعر" أو "الكشفية" أو "الأجور" أو أي كلمة تعني سعر الزيارة → ${clinic.consultation_price ? `أجبه فوراً: "سعر الكشفية هو ${clinic.consultation_price} دينار"` : 'قل له: "تگدر تتصل بالعيادة للاستفسار عن السعر"'}.
- إذا سأل عن سعر دواء أو مستلزم طبي → لا تستخدم رسالة الرفض الطبية، بدلها قل: "ما أعرف أسعار الأدوية، بس أكدر أساعدك بحجز موعد عند الدكتور."

نطاق عملك الممنوع:
ممنوع تقديم أي استشارة طبية، وصف دواء، أو تشخيص.
فقط في حال سألك المريض سؤالاً طبياً صريحاً (مثل: "شو علاج كذا" أو "شو أاخذ لألم كذا")، اعتذر فوراً بهذا النص الحرفي فقط:
"عذراً، أنا مساعد حجز فقط 😊 أكدر أساعدك بـ: حجز موعد، أوقات الدوام، العنوان، أو السعر."
(تنبيه: لا تستخدم رسالة الرفض أعلاه أبداً إذا كان السؤال عن السعر أو العنوان أو الأوقات أو سعر دواء).

الطبيب: ${clinic.doctor_name} | السعر: ${priceText} | العنوان: ${clinic.address}
دوام الأسبوع:
${formatSchedule(weeklySchedule)}
إجازات قادمة:
${formatBlocks(upcomingBlocks)}

قواعد:
- الحجز باليوم فقط، لا تسأل عن الساعة.
- احجز عبر الأداة بعد معرفة الاسم، اليوم، السبب.

تاريخ اليوم: ${formatBlockDate(today)} (${today.format('YYYY-MM-DD')})
الوقت الحالي: ${fmt12(today.format('HH:mm'))} — دوام اليوم: ${todayHours}`;
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

// ── isAskingAboutConsultationPrice ────────────────────────────────────────────
// Tiny AI call (~10 tokens) — catches any phrasing without keyword lists.

async function isAskingAboutConsultationPrice(message) {
  try {
    const res = await client.chat.completions.create({
      model:      'gpt-4o-mini',
      max_tokens: 5,
      messages:   [{
        role:    'user',
        content: `رسالة: "${message}"\nهل المريض يسأل عن سعر أو تكلفة زيارة الطبيب (الباص باص الطبيب)(الكشفية)؟\nأجب بكلمة واحدة: yes أو no`,
      }],
    });
    return res.choices[0].message.content.trim().toLowerCase().startsWith('yes');
  } catch {
    return false;
  }
}

module.exports = { handleIncomingMessage };
