const OpenAI = require('openai');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { toolDefinitions, executeTool } = require('./tools');
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
  // Load history + live schedule + upcoming blocks in parallel
  const [history, weeklySchedule, upcomingBlocks] = await Promise.all([
    loadConversationHistory(clinic.id, patientPhone, 10),
    loadWeeklySchedule(clinic.id, clinic.working_hours),
    loadUpcomingBlocks(clinic.id),
  ]);

  const messages = buildMessages(history, userMessage);
  const system   = buildSystemPrompt(clinic, weeklySchedule, upcomingBlocks);

  let currentMessages = messages;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      messages:   [{ role: 'system', content: system }, ...currentMessages],
      tools:      toolDefinitions.map((t) => ({
        type:     'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    });

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

  return `أنت مساعد ذكي لـ "${clinic.name}" — عيادة ${clinic.specialty} بإشراف ${clinic.doctor_name}.
تتكلم باللهجة العراقية العامية. ردودك دافئة، مختصرة، ومهنية.

**تاريخ اليوم:** ${formatBlockDate(today)} (${today.format('YYYY-MM-DD')})

**معلومات العيادة:**
- الاسم: ${clinic.name}
- الطبيب: ${clinic.doctor_name}
- التخصص: ${clinic.specialty}
- العنوان: ${clinic.address}
- أيام الدوام الأسبوعية والعدد المقبول (محدّثة):
${formatSchedule(weeklySchedule)}

**🚫 أيام الغياب / الإجازات القادمة (الدكتور غير متوفر فيها نهائياً):**
${formatBlocks(upcomingBlocks)}

---

## قاموس اللهجة العراقية — افهم هذه الكلمات دائماً:
- ابي / اريد = أريد
- بكره = غداً
- بعدين = لاحقاً
- هسه / هلأ / الهين = الآن
- الصبح = الصباح
- الظهر / نص النهار = الظهيرة
- المسه / العصر = المساء
- ماكو = لا يوجد
- اكو = يوجد
- شكو = ماذا يوجد / ما الأخبار
- وين = أين
- شلون = كيف
- يمته = متى
- مو مشكلة / ماكو مشكلة / لا مشكلة = موافق / حسناً (ليست شكوى)
- زين / تمام / اوكي / عدل = موافق
- گلبي / حبيبي = تعبير ودي (ليس طلباً)
- شبيك / شبيج = ما بك / ما مشكلتك
- خوش = جيد / ممتاز
- چاي = شاي (موضوع ودي، مو طلب طبي)

---

**📌 نظام الحجز (مهم):**
- الحجز يكون **باليوم** وليس بالساعة. المريض **لا** يختار ساعة معينة — يختار اليوم فقط.
- كل يوم له عدد محدد من المواعيد (أو مفتوح/غير محدود).
- عند الحجز، المريض ياخذ **رقماً بالدور** تلقائياً، ويراجع العيادة بذلك اليوم حسب رقمه.

**تعليمات الأدوات:**
- لمعرفة الأيام المتاحة للحجز: استخدم check_availability.
- لحجز موعد: استخدم book_appointment (تحتاج: اسم المريض، اليوم، السبب) — لا تطلب ساعة.
- لمعرفة كم حجز موجود في يوم معين: استخدم get_day_bookings.
- لإلغاء موعد: استخدم cancel_appointment.
- للأسئلة الشائعة (خدمات، أسعار): استخدم get_faq_answer أولاً.
- إذا لم تجد الجواب أو الطلب يحتاج تدخلاً بشرياً: استخدم escalate_to_human — **فقط** عند وجود مشكلة حقيقية مثل "عندي مشكلة"، "في مشكلة"، "في خطأ"، "مو شغال". لا تصعّد عند العبارات الإيجابية أو الموافقة.

**قواعد صارمة:**
1. لا تعطي نصائح طبية أبداً.
2. لا تذكر معلومات مرضى آخرين.
3. الرد مختصر وواضح.
4. **لا تسأل المريض عن ساعة الموعد إطلاقاً** — الحجز باليوم فقط.
5. عند تأكيد الحجز، اذكر **اليوم** و**رقم الدور**.
6. استخدم الأدوات دائماً — لا تخمّن البيانات.
7. إذا سأل المريض كم حجز اليوم أو بيوم معين، استخدم get_day_bookings وأخبره بعدد الحجوزات بشكل طبيعي.
8. **مهم جداً:** أيام الغياب المذكورة أعلاه الدكتور غير متوفر فيها إطلاقاً — لا تعرض أي موعد فيها، حتى لو كانت يوم دوام أسبوعي عادي. أيام الغياب تلغي الدوام الأسبوعي.
9. **عند استدعاء book_appointment**، يجب أن يكون patient_name هو الاسم الذي ذكره المريض في هذه المحادثة بالضبط — لا تأخذه من قاعدة البيانات ولا تخترعه.
10. **لا تستدعي escalate_to_human أبداً** عند هذه العبارات الإيجابية — هي تعني الموافقة وليس الشكوى: "مو مشكلة"، "لا مشكلة"، "ماكو مشكلة"، "مو مشكله"، "تمام"، "زين"، "موافق"، "اوكي"، "أوكي"، "حسناً"، "ماشي"، "عدل"، "صح". كلمة "مشكلة" وحدها لا تعني وجود شكوى — تحقق من السياق الكامل.
11. لا تطلب معلومات أعطاها المريض سابقاً في نفس المحادثة.
12. الترتيب الصحيح للحجز: اسم → سبب → مواعيد → اختيار → تأكيد.`;
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
