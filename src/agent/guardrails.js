'use strict';

/**
 * guardrails.js
 *
 * Three-layer safety system surrounding the LLM in the Hybrid Agentic architecture:
 *
 *   1. preGuardrails  — runs BEFORE the LLM sees the message
 *   2. validateToolCall — runs BEFORE a tool is executed
 *   3. postGuardrails — runs AFTER the LLM produces its final reply
 *
 * These replace the hard-coded state machine logic in the old:
 *   index.js (doctor_active bypass), decide.js (validation), execute.js (post-processing)
 */

const { getConversationState } = require('../services/supabase');
const { getBaghdadNow, TIMEZONE } = require('../utils/time');
const logger = require('../utils/logger');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: Pre-Guardrails
// Runs before the LLM is invoked. Can short-circuit the entire pipeline.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} clinic
 * @param {string} patientPhone
 * @returns {Promise<{bypass: boolean, reply?: string, stateContext?: string}>}
 *
 * bypass=true  → skip the LLM entirely, send `reply` directly
 * stateContext → extra context string to inject into system prompt
 */
async function preGuardrails(clinic, patientPhone) {
  const stateRow = await getConversationState(clinic.id, patientPhone);
  const currentState = stateRow?.state || 'active';

  // ── doctor_active: Bypass the LLM — doctor is actively reviewing ───────────
  if (currentState === 'doctor_active') {
    logger.info('[PreGuardrail] doctor_active bypass', { patientPhone });
    return {
      bypass: true,
      reply: 'الطبيب يراجع حالتك حالياً. الرد قريب إن شاء الله 🙏',
    };
  }

  // ── doctor_pending: Allow normal services but inject context ───────────────
  if (currentState === 'doctor_pending') {
    logger.info('[PreGuardrail] doctor_pending — injecting context', { patientPhone });
    return {
      bypass: false,
      stateContext: 'عندك طلب بانتظار مراجعة الطبيب. يمكنك استخدام خدمات الحجز والاستفسار العادية. إذا سألك المريض عن حالة طلبه للطبيب، أخبره أنه بانتظار المراجعة وسيتم الرد قريباً.',
    };
  }

  // ── Active (normal state) ──────────────────────────────────────────────────
  return { bypass: false, stateContext: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: Tool-Level Guardrails
// Runs BEFORE each tool call the LLM requests.
// Returns {blocked, reason} — reason is sent back to LLM as a tool error.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} toolName
 * @param {object} toolInput  — parsed tool arguments from the LLM
 * @param {object} context    — { clinic, patient, patientPhone }
 * @returns {{blocked: boolean, reason?: string}}
 */
function validateToolCall(toolName, toolInput, context) {
  const errors = [];

  switch (toolName) {

    // ── book_appointment ─────────────────────────────────────────────────────
    case 'book_appointment': {
      // G1: Dual name required
      const nameParts = (toolInput.patient_name || '').trim().split(/\s+/).filter(Boolean);
      if (nameParts.length < 2) {
        errors.push(
          'خطأ في الحجز: الاسم يجب أن يكون ثنائي على الأقل (الاسم + اسم الأب). ' +
          'اسأل المريض عن اسمه الكامل ثم حاول مرة أخرى.'
        );
      }

      // G2: appointment_date required and valid format
      if (!toolInput.appointment_date) {
        errors.push('خطأ في الحجز: appointment_date مطلوب بصيغة YYYY-MM-DD.');
      } else {
        // G3: Cannot book in the past
        const target = dayjs.tz(toolInput.appointment_date, 'YYYY-MM-DD', TIMEZONE);
        if (target.isValid() && target.isBefore(getBaghdadNow(), 'day')) {
          errors.push(
            'خطأ في الحجز: لا يمكن الحجز في تاريخ ماضي. ' +
            'اسأل المريض عن تاريخ مستقبلي.'
          );
        }
      }
      break;
    }

    // ── cancel_appointment ───────────────────────────────────────────────────
    case 'cancel_appointment': {
      if (!toolInput.appointment_id) {
        errors.push(
          'خطأ في الإلغاء: appointment_id مطلوب. ' +
          'استدعي get_my_appointments أولاً لمعرفة IDs المواعيد المتاحة.'
        );
      }
      break;
    }

    // ── reschedule_appointment ───────────────────────────────────────────────
    case 'reschedule_appointment': {
      if (!toolInput.appointment_id) {
        errors.push(
          'خطأ في التأجيل: appointment_id مطلوب. ' +
          'استدعي get_my_appointments أولاً.'
        );
      }
      if (!toolInput.new_date) {
        errors.push('خطأ في التأجيل: new_date مطلوب بصيغة YYYY-MM-DD.');
      } else {
        const target = dayjs.tz(toolInput.new_date, 'YYYY-MM-DD', TIMEZONE);
        if (target.isValid() && target.isBefore(getBaghdadNow(), 'day')) {
          errors.push('خطأ في التأجيل: التاريخ الجديد لا يمكن أن يكون في الماضي.');
        }
      }
      break;
    }

    // ── escalate_to_doctor ───────────────────────────────────────────────────
    case 'escalate_to_doctor': {
      // G4: Must have collected a complaint before escalating
      if (!toolInput.complaint || toolInput.complaint.trim().length < 5) {
        errors.push(
          'خطأ في التصعيد: يجب جمع وصف مشكلة المريض أولاً. ' +
          'اسأله عن مشكلته وأعراضه، ثم استدعِ هذه الأداة.'
        );
      }
      break;
    }
  }

  if (errors.length > 0) {
    const reason = errors.join('\n');
    logger.warn('[ToolGuardrail] Blocked tool call', { tool: toolName, reason });
    return { blocked: true, reason };
  }

  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3: Post-Guardrails
// Runs AFTER the LLM produces its final text reply.
// Filters the reply before sending to patient.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} reply  — raw LLM reply
 * @returns {string}      — filtered/sanitized reply
 */
function postGuardrails(reply) {
  let filtered = reply || '';

  // PG1: Strip any technical data leaks
  filtered = filtered.replace(/\b(clinic_id|patient_id|supabase|uuid|api_key|access_token)\b/gi, '***');

  // PG2: Hard length cap for WhatsApp (4096 chars official limit, we use 2000 for readability)
  if (filtered.length > 2000) {
    filtered = filtered.substring(0, 1950) + '\n\n...للمزيد من المعلومات تواصل مع العيادة مباشرة. 🙏';
    logger.warn('[PostGuardrail] Reply truncated to 2000 chars');
  }

  // PG3: Detect and replace medical advice
  const medicalAdvicePattern = /\b(وصفة طبية|اشرب|تناول|جرعة.*يومياً|حبة.*مرتين|ملغ.*مرة|خذ.*الدواء)\b/i;
  if (medicalAdvicePattern.test(filtered)) {
    logger.warn('[PostGuardrail] Medical advice pattern detected — replacing reply');
    filtered =
      'ما أكدر أعطيك نصيحة طبية. أنصحك تحجز موعد عند الدكتور وهو يفيدك أكثر 😊\n' +
      'إذا تريد أحجزلك موعد، قولي اسمك الكامل واليوم المناسب.';
  }

  return filtered;
}

module.exports = { preGuardrails, validateToolCall, postGuardrails };
