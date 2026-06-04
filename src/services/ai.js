const OpenAI = require('openai');

const client = new OpenAI({
  apiKey:  process.env.OPENAI_APIDEEP_KEY,
  baseURL: 'https://api.deepseek.com'
});

const MODELS = {
  flash: 'deepseek-v4-flash',
  chat:  'deepseek-v4-flash',
  pro:   'deepseek-reasoner'
};

async function callAI(model, messages, options = {}) {
  return client.chat.completions.create({
    model: MODELS[model] || model,
    messages,
    ...options
  });
}

module.exports = { client, MODELS, callAI };
