const OpenAI = require('openai');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_APIDEEP_KEY,
  baseURL: 'https://api.deepseek.com'
});

const MODELS = {
  flash: 'deepseek-v4-flash',
  chat:  'deepseek-chat',
  pro:   'deepseek-reasoner'
};

// ── Original callAI — kept for backward compatibility ─────────────────────────
async function callAI(model, messages, options = {}) {
  return client.chat.completions.create({
    model: MODELS[model] || model,
    messages,
    ...options
  });
}

// ── Agentic Loop: chat with tool-calling support ───────────────────────────────
// Used by agent/index.js (Hybrid Agentic + Guardrails architecture).
// Model: deepseek-v4-flash (low cost, OpenAI-compatible tool calling).
async function chatWithTools(messages, tools, options = {}) {
  return client.chat.completions.create({
    model:       MODELS.flash,          // deepseek-v4-flash
    messages,
    tools,                              // OpenAI-compatible tool definitions
    tool_choice: 'auto',               // LLM decides when to call tools
    max_tokens:  options.max_tokens || 1024,
    temperature: options.temperature !== undefined ? options.temperature : 0.3,
    ...options
  });
}

module.exports = { client, MODELS, callAI, chatWithTools };
