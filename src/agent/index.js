'use strict';

/**
 * agent/index.js — Hybrid Agentic + Guardrails
 *
 * Replaces the old Extract → Validate → Decide → Execute pipeline.
 *
 * New flow:
 *   1. Pre-Guardrails    → state-based bypass (doctor_active) / context injection
 *   2. Build system prompt → clinic info + schedule + FAQs (dynamic, every call)
 *   3. Load history      → last 15 user/assistant messages
 *   4. Agentic loop      → LLM decides → tool call → guardrail → execute → LLM refines
 *   5. Post-Guardrails   → sanitize final reply
 *   6. Welcome message   → first-ever reply gets a greeting prefix
 *   7. Save & return     → persist to conversations table
 *
 * External signature is IDENTICAL to old index.js — webhooks/whatsapp.js unchanged.
 */

const { chatWithTools }        = require('../services/ai');
const {
  saveMessage,
  loadConversationHistory,
  supabase,
}                              = require('../services/supabase');
const { preGuardrails, validateToolCall, postGuardrails } = require('./guardrails');
const { buildSystemPrompt }    = require('./systemPrompt');
const { toolDefinitions, executeTool } = require('./tools');
const logger                   = require('../utils/logger');

const MAX_TOOL_ROUNDS = 5;   // Guardrail: prevents infinite agentic loops

// ── Main entry point ──────────────────────────────────────────────────────────

async function handleIncomingMessage({ clinic, patient, patientPhone, userMessage, messageType }) {

  // ═══ PHASE 1: Pre-Guardrails ═══════════════════════════════════════════════
  const preCheck = await preGuardrails(clinic, patientPhone);

  if (preCheck.bypass) {
    // doctor_active: respond immediately without calling the LLM
    await saveMessage({
      clinicId:    clinic.id,
      patientId:   patient.id,
      patientPhone,
      role:        'assistant',
      content:     preCheck.reply,
    });
    return preCheck.reply;
  }

  // ═══ PHASE 2: Build system prompt + load history ════════════════════════════
  const [systemPrompt, history] = await Promise.all([
    buildSystemPrompt(clinic, preCheck.stateContext),
    loadConversationHistory(clinic.id, patientPhone, 15),
  ]);

  // ═══ PHASE 3: Assemble messages ═════════════════════════════════════════════
  const messages = [
    { role: 'system', content: systemPrompt },
    // Historical user/assistant turns
    ...history.map(m => ({ role: m.role, content: m.content })),
    // Current user message
    { role: 'user', content: userMessage },
  ];

  // Inject voice annotation so LLM knows to confirm before booking
  if (messageType === 'voice') {
    messages.push({
      role:    'system',
      content: 'ملاحظة: الرسالة السابقة جاءت من تحويل صوتي إلى نص وقد تحتوي على أخطاء. إذا تضمنت اسماً أو تاريخاً للحجز، أكد المعلومات مع المريض قبل استدعاء book_appointment.',
    });
  }

  // ═══ PHASE 4: Agentic Loop ══════════════════════════════════════════════════
  let response;
  try {
    response = await chatWithTools(messages, toolDefinitions);
  } catch (err) {
    logger.error('[Agent] Initial LLM call failed', { error: err.message });
    const fallback = 'عذراً، صار خطأ تقني مؤقت. حاول مرة ثانية بعد شوي. 🙏';
    await saveMessage({ clinicId: clinic.id, patientId: patient.id, patientPhone, role: 'assistant', content: fallback });
    return fallback;
  }

  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const choice  = response.choices[0];
    const message = choice.message;

    // No tool calls → LLM is done, exit loop
    if (!message.tool_calls || message.tool_calls.length === 0) {
      break;
    }

    // Append the assistant's tool-requesting message to the conversation
    messages.push(message);

    // Execute each requested tool call
    for (const toolCall of message.tool_calls) {
      const fnName = toolCall.function.name;
      let   fnArgs;

      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch (_) {
        fnArgs = {};
      }

      logger.info('[Agent] Tool requested', { tool: fnName, args: fnArgs, round: rounds + 1 });

      // ── Tool-Level Guardrail ──
      const guard = validateToolCall(fnName, fnArgs, { clinic, patient, patientPhone });

      let toolResult;
      if (guard.blocked) {
        // Return the guardrail error to the LLM so it can self-correct
        toolResult = { error: guard.reason };
      } else {
        // Execute the tool
        toolResult = await executeTool(fnName, fnArgs, { clinic, patient, patientPhone });
      }

      logger.info('[Agent] Tool result', { tool: fnName, success: !toolResult.error, round: rounds + 1 });

      // Append tool result to messages
      messages.push({
        role:         'tool',
        tool_call_id: toolCall.id,
        content:      JSON.stringify(toolResult),
      });
    }

    // Re-invoke LLM with tool results
    try {
      response = await chatWithTools(messages, toolDefinitions);
    } catch (err) {
      logger.error('[Agent] LLM call failed during tool loop', { round: rounds + 1, error: err.message });
      break;
    }

    rounds++;
  }

  if (rounds >= MAX_TOOL_ROUNDS) {
    logger.warn('[Agent] Max tool rounds reached', { patientPhone, rounds });
  }

  // ═══ PHASE 5: Extract final reply ═══════════════════════════════════════════
  const rawReply = response?.choices?.[0]?.message?.content || '';

  // ═══ PHASE 6: Post-Guardrails ═══════════════════════════════════════════════
  let finalReply = postGuardrails(rawReply);

  if (!finalReply.trim()) {
    finalReply = 'عذراً، ما كدرت أعالج طلبك. حاول مرة ثانية أو تواصل مع العيادة مباشرة. 🙏';
  }

  // ═══ PHASE 7: Welcome message for first-ever reply ══════════════════════════
  try {
    const { count } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('patient_id', patient.id)
      .eq('role', 'assistant');

    if (count === 0) {
      const welcome =
        `أهلاً بك! أنا المساعد الذكي لعيادة د. ${clinic.doctor_name || clinic.name} 🤖\n` +
        `أقدر أساعدك في حجز، إلغاء، أو تأجيل موعدك.\n\n---\n\n`;
      finalReply = welcome + finalReply;
    }
  } catch (_) {
    // Non-critical — skip welcome if count query fails
  }

  // ═══ PHASE 8: Persist & return ══════════════════════════════════════════════
  await saveMessage({
    clinicId:    clinic.id,
    patientId:   patient.id,
    patientPhone,
    role:        'assistant',
    content:     finalReply,
  });

  logger.info('[Agent] Reply sent', { patientPhone, length: finalReply.length, toolRounds: rounds });
  return finalReply;
}

module.exports = { handleIncomingMessage };
