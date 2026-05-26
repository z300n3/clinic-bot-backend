require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');
const logger  = require('./utils/logger');

// Validate required env vars at startup
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'META_VERIFY_TOKEN',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  logger.error('Missing required environment variables', { missing });
  process.exit(1);
}

const whatsappRouter     = require('./webhooks/whatsapp');
const appointmentsRouter = require('./routes/appointments');

const app = express();

// ── CORS — allow the Next.js dashboard to call /api/* ────────────────────────
const DASHBOARD_ORIGIN = process.env.DASHBOARD_URL || 'http://localhost:3001';
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === DASHBOARD_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin',  DASHBOARD_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON bodies (Meta sends application/json)
app.use(express.json());

// HTTP request logging
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);

// Routes
app.use('/webhook',          whatsappRouter);
app.use('/api/appointments', appointmentsRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  logger.info(`Clinic Bot backend running on port ${PORT}`);
});
