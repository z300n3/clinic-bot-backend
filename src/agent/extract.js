const OpenAI = require('openai');
const logger = require('../utils/logger');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';

async function extractIntent(userMessage, currentState, stateData) {
  // Fast-path: detect confirmation/rejection without AI
  const msg = userMessage.trim();
  
  const isYes = /^(نعم|اي|إي|صح|اكيد|أكيد|تمام|زين|موافق|ي|yep|yes|ok)[.!?]*$/i.test(msg);
  const isNo  = /^(لا|كلا|خطأ|غلط|مو صح|غير|بدل|no|nope|cancel)[.!?]*$/i.test(msg);
  
  if (isYes) return { intent: 'confirmation', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  if (isNo)  return { intent: 'rejection',    patient_name: null, date_preference: null, reason: null, faq_topic: null };

  // Fast-path: detect greeting without AI
  const greetingRegex = /^(مرحبا|السلام عليكم|هلو|هلا|شلونك|كيفك|مرحباً|صباح|مساء)[.!?]*$/i;
  if (greetingRegex.test(msg)) {
    return { intent: 'greeting', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  }

  // Fast-path: price
  const priceRegex = /(سعر|شكد|شگد|كم|اجور|كلف|كشفية|الكشف|فلوس|مبلغ|ابيش|أبيش|بيش|باص)/i;
  if (priceRegex.test(msg)) {
    return { intent: 'inquiry', patient_name: null, date_preference: null, reason: null, faq_topic: 'price' };
  }

  // Fast-path: location
  const locationRegex = /(وين|فين|عنوان|مكان|موقع|اوصل)/i;
  if (locationRegex.test(msg)) {
    return { intent: 'inquiry', patient_name: null, date_preference: null, reason: null, faq_topic: 'location' };
  }

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
  "intent": "booking|cancellation|inquiry|check_appointment|greeting|unclear",
  "patient_name": "الاسم الكامل أو null — فقط إذا ذُكر صراحةً",
  "date_preference": "التاريخ أو اليوم أو null",
  "reason": "سبب الزيارة أو null",
  "faq_topic": "hours|price|location|specialty أو null"
}

قواعد:
- patient_name: اسم شخص فقط (كلمة أو كلمتين تبدو كاسم). لا تضع جمل.
- date_preference: أي إشارة زمنية (باجر، الخميس، هاي الأسبوع، اليوم...).
- reason: الشكوى الطبية أو سبب الزيارة.
- faq_topic: hours إذا سأل عن الدوام، location إذا سأل عن العنوان.`

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.choices[0].message.content?.trim() || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    
    logger.debug('[Extract]', parsed);
    return parsed;
  } catch (err) {
    logger.error('[Extract] failed', { error: err.message });
    return { intent: 'unclear', patient_name: null, date_preference: null, reason: null, faq_topic: null };
  }
}

module.exports = { extractIntent };
