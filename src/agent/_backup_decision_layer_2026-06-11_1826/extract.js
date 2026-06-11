const { callAI } = require('../services/ai');
const logger = require('../utils/logger');
const { trackTokenUsage } = require('../utils/tokenTracker');

async function extractIntent(userMessage, currentState, stateData) {
  // Fast-path: detect confirmation/rejection without AI
  const msg = userMessage.trim();
  
  const isYes = /^(نعم|اي|إي|صح|اكيد|أكيد|تمام|زين|موافق|ي|yep|yes|ok)[.!?]*$/i.test(msg);
  const isNo  = /^(لا|كلا|خطأ|غلط|مو صح|غير|بدل|no|nope|cancel)[.!?]*$/i.test(msg);
  const isReschedule = /^(اجل موعدي|تأجيل|تأجيل موعدي|تأجيل الموعد|غير موعدي|تغيير موعدي|تغيير الموعد|تأخير الموعد)[.!?]*$/i.test(msg);
  
  if (isYes) return { intent: 'confirmation', patient_name: null, date_preference: null, faq_topic: null };
  if (isNo)  return { intent: 'rejection',    patient_name: null, date_preference: null, faq_topic: null };
  if (isReschedule) return { intent: 'reschedule', patient_name: null, date_preference: null, faq_topic: null };

  // Fast-path: detect greeting without AI
  const greetingRegex = /^(مرحبا|السلام عليكم|هلو|هلا|شلونك|كيفك|مرحباً|صباح الخير|مساء الخير|صباح النور|مساء النور)[.!?،\s]*$/i;
  if (greetingRegex.test(msg)) {
    return { intent: 'greeting', patient_name: null, date_preference: null, faq_topic: null };
  }

  const dateOnlyRegex = /^(باجر|بكره|غداً|غدا|اليوم|بعد غد|بعد بكره|عگب باجر|عقب باجر|عقبه|اقرب موعد|اقرب وقت|اسرع وقت|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|السبت|الاحد)[.!?،\s]*$/i;
  if (dateOnlyRegex.test(msg)) {
    return { 
      intent: 'booking', 
      patient_name: null, 
      date_preference: msg.trim(), 
      faq_topic: null 
    };
  }

  // Fast paths for price and location have been removed to support compound inquiries via LLM.

  // Fast-path: medical advice (reject immediately)
  const medicalRegex = /^.*(وصف|وصفلي|اعطني|شنو علاج|شنو دواء|كيف اعالج).*(دواء|علاج|حبوب)/i;
  if (medicalRegex.test(msg)) {
    return { intent: 'medical_advice', patient_name: null, date_preference: null, faq_topic: null };
  }

  // AI extraction for everything else
  const prompt = `استخرج من رسالة المريض المعلومات التالية وأرجع JSON فقط بدون أي نص آخر.

الحالة الحالية: ${currentState}
رسالة المريض: "${userMessage}"

{
  "intent": "booking (للحجز) | cancellation (لإلغاء حجز محدد) | cancel_all (لإلغاء جميع حجوزاتي) | reschedule (لتأجيل أو تغيير أو نقل موعد قائم ليوم آخر) | inquiry (للاستفسار) | check_appointment (للسؤال عن مواعيدي) | greeting (ترحيب) | escalate_to_doctor (يريد الطبيب / رفع تحليل / متابعة علاج) | confirmation (للموافقة وتأكيد الحجز) | rejection (للرفض أو إخبار البوت أن المعلومات خاطئة) | unclear (غير واضح)",
  "patient_name": "الاسم الكامل أو null — فقط إذا ذُكر صراحةً",
  "date_preference": "التاريخ أو اليوم أو null",
  "faq_topics": ["topic1", "topic2"] 
}
ملاحظة للـ faq_topics: استبدل ["topic1", "topic2"] بمصفوفة المواضيع المطلوبة من هذه القائمة (hours, absence, price, location, specialty, services, about, doctor_name, custom)، أو ضع مصفوفة فارغة [] إذا لم يكن هناك سؤال.

قواعد:
- patient_name: اسم شخص فقط (كلمة أو كلمتين تبدو كاسم). لا تضع جمل.
- date_preference: أي إشارة زمنية يذكرها المريض نصاً (مثل: باجر، عگب باجر، عقبه، اقرب موعد ممكن، اسرع وقت، الخميس، اليوم، الخ). يجب أن تستخرج الكلمة كما قالها المريض ولا تتركها null أبداً إذا أشار لأي وقت.
- faq_topics: **تنبيه هام جداً**: استخرج **جميع** المواضيع التي سأل عنها المريض بدون استثناء. إذا احتوت الرسالة على عدة أسئلة (مثل السعر والعنوان والدوام)، يجب أن تحتوي المصفوفة على جميع هذه المواضيع ["price", "location", "hours"].
  * specialty: إذا سأل عن تخصص الطبيب، شنو يعالج، هل يعالج مرض كذا، أو الأمراض التي يعالجها.
  * price: حصراً إذا سأل عن مقدار السعر، كم الكشفية، أو التكلفة. إذا سأل عن (طرق الدفع، بطاقة، زين كاش، تأمين) فاختر custom.
  * location: أي سؤال عن العنوان/الموقع/كيف يوصل.
  * hours: أي سؤال عن الدوام/الأوقات/متى تفتح.
  * absence: إذا سأل عن غياب الدكتور أو إجازته أو الطبيب البديل.
  * services: أي سؤال عن الخدمات المتوفرة في العيادة.
  * about: أي سؤال عام عن العيادة أو تفاصيلها أو شنو شغلها أو تعريف بالعيادة أو "عرفني عن العيادة".
  * doctor_name: إذا سأل تحديداً عن اسم الطبيب أو الدكتور.
  * custom: أي سؤال عام عن العيادة لا يندرج تحت التصنيفات السابقة.
- ملاحظة هامة جداً للأسئلة المزدوجة (حجز + استفسار):
  إذا احتوت الرسالة على طلب حجز وسؤال استفساري في نفس الوقت (مثل: "اريد حجز وكم السعر؟")، يجب أن تختار دائماً intent = "booking"، وتستخرج المواضيع المطلوبة وتضعها في faq_topics. إياك أن تختار "unclear" إذا كان هناك حجز واضح.
- ملاحظة لنية التأكيد والرفض:
  * confirmation: اخترها إذا كان المريض يؤكد صحة معلومات سأله عنها البوت (نعم، صحيح، بالضبط، موافق).
  * rejection: اخترها إذا كان المريض ينفي صحة المعلومات أو يصحح خطأ (لا، الاسم غلط، مو هيج، غير الموعد).
- ملاحظة هامة: إذا كانت الحالة الحالية (awaiting_info أو awaiting_date أو awaiting_cancel_select أو awaiting_reschedule_select أو awaiting_reschedule_date):
  1. أولاً، تأكد ما إذا كانت الرسالة سؤالاً استفسارياً واضحاً (عن السعر، المكان، الاختصاص، الخ). إذا كانت كذلك، اجعل intent = "inquiry" واستخرج faq_topics المناسبة.
  2. ثانياً، إذا لم تكن سؤالاً بل نصاً قصيراً (اسم، يوم، شكوى مرضية)، افترض أنه إجابة لإكمال الحجز أو إلغاء الموعد أو تأجيله، واجعل intent بناءً على السياق (مثل "reschedule" إذا كان المطلوب تاريخاً جديداً للتأجيل، أو "cancellation" لاختيار موعد للإلغاء) وقم بتعبئة الحقل المناسب.
- ملاحظة للفلترة (Gate): إذا كان المريض يصف مشكلته أو أعراضه (وليس يطلب حجز موعد صراحةً)، لا تصنفها booking. booking فقط إذا طلب الحجز بوضوح (احجزلي، اريد موعد).`

  try {
    const response = await callAI('flash', [{ role: 'user', content: prompt }], {
      max_tokens: 1024,
      response_format: { type: 'json_object' }
    });

    // ── تشخيص مفصّل لردود DeepSeek ──────────────────────────────────
    const choice = response.choices[0];
    const finishReason = choice.finish_reason;       // 'stop' | 'length' | 'content_filter' | null
    const rawText = choice.message.content || '';
    const usage = response.usage || {};

    logger.info('[Extract] DeepSeek raw response', {
      userMessage,
      finishReason,
      rawTextLength: rawText.length,
      rawTextPreview: rawText.substring(0, 200),
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cacheHit: usage.prompt_cache_hit_tokens || 0,
      cacheMiss: usage.prompt_cache_miss_tokens || 0
    });

    const text = rawText.trim();

    // ── إذا الرد فارغ أو مقطوع ─────────────────────────────────────
    if (!text) {
      logger.error('[Extract] ❌ EMPTY RESPONSE from DeepSeek', {
        userMessage,
        finishReason,
        possibleCause: finishReason === 'content_filter' ? 'تم حظر المحتوى من DeepSeek'
          : finishReason === 'length' ? 'الرد تجاوز max_tokens'
          : 'الخادم لم يُرجع شيئاً (timeout أو خطأ داخلي)'
      });
      trackTokenUsage(userMessage, 'unclear', finishReason, usage, false);
      return { intent: 'unclear', patient_name: null, date_preference: null, faq_topic: null };
    }

    // Extract JSON block even if there is surrounding text
    let clean = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      clean = jsonMatch[0];
    }
    
    clean = clean.replace(/```json|```/g, '').trim();
    
    if (!clean) {
      logger.error('[Extract] ❌ No JSON found in response', { userMessage, rawText: text });
      trackTokenUsage(userMessage, 'unclear', finishReason, usage, false);
      return { intent: 'unclear', patient_name: null, date_preference: null, faq_topic: null };
    }

    try {
      const parsed = JSON.parse(clean);
      logger.info('[Extract] ✅ Parsed successfully', { userMessage, intent: parsed.intent, faq_topics: parsed.faq_topics });
      trackTokenUsage(userMessage, parsed.intent, finishReason, usage, true);
      return parsed;
    } catch (parseErr) {
      logger.error('[Extract] ❌ JSON Parse Error', { userMessage, text, clean, error: parseErr.message });
      trackTokenUsage(userMessage, 'unclear', finishReason, usage, false);
      throw parseErr;
    }
  } catch (err) {
    logger.error('[Extract] ❌ API CALL FAILED', {
      error: err.message,
      code: err.code || 'N/A',
      status: err.status || err.statusCode || 'N/A',
      type: err.type || 'N/A'
    });
    return { intent: 'unclear', patient_name: null, date_preference: null, faq_topic: null };
  }
}

module.exports = { extractIntent };
