const OpenAI = require('openai');
const logger = require('../utils/logger');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_APIDEEP_KEY,
  baseURL: 'https://api.deepseek.com'
});

const MODEL = 'deepseek-v4-pro';

async function extractIntent(userMessage, currentState, stateData) {
  // Fast-path: detect confirmation/rejection without AI
  const msg = userMessage.trim();
  
  const isYes = /^(نعم|اي|إي|صح|اكيد|أكيد|تمام|زين|موافق|ي|yep|yes|ok)[.!?]*$/i.test(msg);
  const isNo  = /^(لا|كلا|خطأ|غلط|مو صح|غير|بدل|no|nope|cancel)[.!?]*$/i.test(msg);
  
  if (isYes) return { intent: 'confirmation', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  if (isNo)  return { intent: 'rejection',    patient_name: null, date_preference: null, reason: null, faq_topic: null };

  // Fast-path: detect greeting without AI
  const greetingRegex = /^(مرحبا|السلام عليكم|هلو|هلا|شلونك|كيفك|مرحباً|صباح الخير|مساء الخير|صباح النور|مساء النور)[.!?،\s]*$/i;
  if (greetingRegex.test(msg)) {
    return { intent: 'greeting', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  }

  const dateOnlyRegex = /^(باجر|بكره|غداً|غدا|اليوم|بعد غد|بعد بكره|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعة|السبت|الاحد)[.!?،\s]*$/i;
  if (dateOnlyRegex.test(msg)) {
    return { 
      intent: 'booking', 
      patient_name: null, 
      date_preference: msg.trim(), 
      reason: null, 
      faq_topic: null 
    };
  }

  // Fast paths for price and location have been removed to support compound inquiries via LLM.

  // Fast-path: medical advice (reject immediately)
  const medicalRegex = /^.*(وصف|وصفلي|اعطني|شنو علاج|شنو دواء|كيف اعالج).*(دواء|علاج|حبوب)/i;
  if (medicalRegex.test(msg)) {
    return { intent: 'medical_advice', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  }

  // AI extraction for everything else
  const prompt = `استخرج من رسالة المريض المعلومات التالية وأرجع JSON فقط بدون أي نص آخر.

الحالة الحالية: ${currentState}
رسالة المريض: "${userMessage}"

{
  "intent": "booking (للحجز) | cancellation (لإلغاء الحجز) | inquiry (للاستفسار) | check_appointment (للسؤال عن مواعيدي وحجوزاتي) | greeting (ترحيب) | unclear (غير واضح)",
  "patient_name": "الاسم الكامل أو null — فقط إذا ذُكر صراحةً",
  "date_preference": "التاريخ أو اليوم أو null",
  "reason": "سبب الزيارة أو null",
  "faq_topics": ["topic1", "topic2"] 
}
ملاحظة للـ faq_topics: استبدل ["topic1", "topic2"] بمصفوفة المواضيع المطلوبة من هذه القائمة (hours, absence, price, location, specialty, services, custom)، أو ضع مصفوفة فارغة [] إذا لم يكن هناك سؤال.

قواعد:
- patient_name: اسم شخص فقط (كلمة أو كلمتين تبدو كاسم). لا تضع جمل.
- date_preference: أي إشارة زمنية (باجر، الخميس، هاي الأسبوع، اليوم...).
- reason: الشكوى الطبية أو سبب الزيارة.
- faq_topics: **تنبيه هام جداً**: استخرج **جميع** المواضيع التي سأل عنها المريض بدون استثناء. إذا احتوت الرسالة على عدة أسئلة (مثل السعر والعنوان والدوام)، يجب أن تحتوي المصفوفة على جميع هذه المواضيع ["price", "location", "hours"].
  * specialty: إذا سأل عن تخصص الطبيب، شنو يعالج، هل يعالج مرض كذا، أو الأمراض التي يعالجها.
  * price: حصراً إذا سأل عن مقدار السعر، كم الكشفية، أو التكلفة. إذا سأل عن (طرق الدفع، بطاقة، زين كاش، تأمين) فاختر custom.
  * location: أي سؤال عن العنوان/الموقع/كيف يوصل.
  * hours: أي سؤال عن الدوام/الأوقات/متى تفتح.
  * absence: إذا سأل عن غياب الدكتور أو إجازته أو الطبيب البديل.
  * services: أي سؤال عن الخدمات المتوفرة في العيادة.
  * custom: أي سؤال عام عن العيادة لا يندرج تحت التصنيفات السابقة.
- ملاحظة هامة جداً للأسئلة المزدوجة (حجز + استفسار):
  إذا احتوت الرسالة على طلب حجز وسؤال استفساري في نفس الوقت (مثل: "اريد حجز وكم السعر؟")، يجب أن تختار دائماً intent = "booking"، وتستخرج المواضيع المطلوبة وتضعها في faq_topics. إياك أن تختار "unclear" إذا كان هناك حجز واضح.
- ملاحظة هامة: إذا كانت الحالة الحالية (awaiting_info أو awaiting_date):
  1. أولاً، تأكد ما إذا كانت الرسالة سؤالاً استفسارياً واضحاً (عن السعر، المكان، الاختصاص، الخ). إذا كانت كذلك، اجعل intent = "inquiry" واستخرج faq_topics المناسبة.
  2. ثانياً، إذا لم تكن سؤالاً بل نصاً قصيراً (اسم، يوم، شكوى مرضية)، افترض أنه إجابة لإكمال الحجز، واجعل intent = "booking" وقم بتعبئة الحقول (patient_name, date_preference, reason).`

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.choices[0].message.content?.trim() || '';
    
    // Extract JSON block even if there is surrounding text
    let clean = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      clean = jsonMatch[0];
    }
    
    clean = clean.replace(/```json|```/g, '').trim();
    
    if (!clean) {
      logger.warn('[Extract] Empty AI response', { userMessage });
      return { intent: 'unclear', patient_name: null, date_preference: null, reason: null, faq_topic: null };
    }

    try {
      const parsed = JSON.parse(clean);
      logger.debug('[Extract]', parsed);
      return parsed;
    } catch (parseErr) {
      logger.error('[Extract] JSON Parse Error', { text, clean, error: parseErr.message });
      throw parseErr;
    }
  } catch (err) {
    logger.error('[Extract] failed', { error: err.message });
    return { intent: 'unclear', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  }
}

module.exports = { extractIntent };
