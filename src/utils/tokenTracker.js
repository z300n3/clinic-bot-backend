'use strict';

const fs   = require('fs');
const path = require('path');

// ── مجلد حفظ ملفات التوكنز ─────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, '..', '..', 'token_logs');

function ensureDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function todayFilePath() {
  const today = new Date().toISOString().split('T')[0]; // "2026-06-11"
  return path.join(LOGS_DIR, `tokens_${today}.jsonl`);
}

// ── الدالة القديمة (للنظام السابق — محفوظة للتوافق) ─────────────────────────
/**
 * @param {string}  userMessage
 * @param {string}  intent
 * @param {string}  finishReason
 * @param {object}  usage         — { prompt_tokens, completion_tokens, total_tokens }
 * @param {boolean} success
 */
function trackTokenUsage(userMessage, intent, finishReason, usage, success) {
  try {
    ensureDir();
    const entry = {
      time:          new Date().toISOString(),
      arch:          'pipeline',
      message:       (userMessage || '').substring(0, 100),
      intent:        intent || 'unknown',
      success,
      finishReason,
      input_tokens:  usage.prompt_tokens     || 0,
      output_tokens: usage.completion_tokens  || 0,
      total_tokens:  usage.total_tokens       || 0,
      cacheHit:      usage.prompt_cache_hit_tokens  || 0,
      cacheMiss:     usage.prompt_cache_miss_tokens || 0,
    };
    fs.appendFileSync(todayFilePath(), JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[TokenTracker] trackTokenUsage failed:', err.message);
  }
}

// ── الدالة الجديدة (Hybrid Agentic Architecture) ─────────────────────────────
/**
 * Called once per patient message after the full agentic loop completes.
 * Aggregates tokens from ALL LLM calls in that loop (initial + tool rounds).
 *
 * Saved format (one JSON line per message):
 * {
 *   "time": "2026-06-11T18:40:00.000Z",
 *   "arch": "agentic",
 *   "phone_tail": "7890",
 *   "message": "اريد احجز باجر",
 *   "input_tokens": 1200,
 *   "output_tokens": 180,
 *   "total_tokens": 1380,
 *   "tool_rounds": 2,
 *   "tools_called": ["check_availability","book_appointment"],
 *   "success": true,
 *   "finish_reason": "stop"
 * }
 *
 * @param {object} opts
 * @param {string}   opts.patientPhone   — patient identifier (only last 4 digits saved)
 * @param {string}   opts.messagePreview — first 80 chars of patient message
 * @param {number}   opts.totalInput     — sum of prompt_tokens across all LLM calls
 * @param {number}   opts.totalOutput    — sum of completion_tokens across all LLM calls
 * @param {number}   opts.toolRounds     — number of tool-call rounds executed
 * @param {string[]} opts.toolsCalled    — names of tools that were invoked
 * @param {boolean}  opts.success        — did the loop complete without fatal error
 * @param {string}   opts.finishReason   — last LLM finish_reason ('stop'|'length'|...)
 */
function trackAgenticUsage({
  patientPhone,
  messagePreview,
  totalInput,
  totalOutput,
  toolRounds,
  toolsCalled,
  success,
  finishReason,
}) {
  try {
    ensureDir();
    const entry = {
      time:         new Date().toISOString(),
      arch:         'agentic',
      phone_tail:   (patientPhone || '').slice(-4),    // last 4 digits only for privacy
      message:      (messagePreview || '').substring(0, 80),
      input_tokens: totalInput  || 0,
      output_tokens:totalOutput || 0,
      total_tokens: (totalInput || 0) + (totalOutput || 0),
      tool_rounds:  toolRounds  || 0,
      tools_called: toolsCalled || [],
      success,
      finish_reason:finishReason || 'unknown',
    };
    // Each entry on its own line — valid JSONL format
    fs.appendFileSync(todayFilePath(), JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[TokenTracker] trackAgenticUsage failed:', err.message);
  }
}

module.exports = { trackTokenUsage, trackAgenticUsage };
