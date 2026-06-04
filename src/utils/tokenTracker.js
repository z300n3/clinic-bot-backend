const fs = require('fs');
const path = require('path');

// ── مجلد حفظ ملفات التوكنز ─────────────────────────────────────
const LOGS_DIR = path.join(__dirname, '..', '..', 'token_logs');

/**
 * يحفظ بيانات استهلاك التوكنز في ملف JSONL يومي.
 * كل يوم ملف منفصل (مثلاً: tokens_2026-06-04.jsonl)
 * كل سطر في الملف = طلب API واحد مع كل التفاصيل.
 *
 * @param {string} userMessage   - رسالة المريض الأصلية
 * @param {string} intent        - النية المستخرجة (booking, inquiry, etc.)
 * @param {string} finishReason  - سبب توقف النموذج (stop, length, content_filter)
 * @param {object} usage         - بيانات الاستهلاك من DeepSeek API
 * @param {boolean} success      - هل نجح الاستخراج أم فشل
 */
function trackTokenUsage(userMessage, intent, finishReason, usage, success) {
  try {
    // أنشئ المجلد إذا لم يكن موجوداً
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    // اسم الملف حسب التاريخ الحالي
    const today = new Date().toISOString().split('T')[0]; // "2026-06-04"
    const filePath = path.join(LOGS_DIR, `tokens_${today}.jsonl`);

    // بناء سطر البيانات
    const entry = {
      time: new Date().toISOString(),
      message: userMessage.substring(0, 100),  // أول 100 حرف فقط للخصوصية
      intent: intent || 'unknown',
      success,
      finishReason,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      cacheHit: usage.prompt_cache_hit_tokens || 0,
      cacheMiss: usage.prompt_cache_miss_tokens || 0,
    };

    // إضافة السطر للملف (Append)
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (err) {
    // لا نريد أن يتعطل البوت بسبب خطأ في حفظ اللوقات
    console.error('[TokenTracker] Failed to save:', err.message);
  }
}

module.exports = { trackTokenUsage };
