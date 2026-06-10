require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');
const logger  = require('./utils/logger');

// Validate required env vars at startup
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'META_VERIFY_TOKEN',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  logger.error('Missing required environment variables', { missing });
  process.exit(1);
}

const cookieParser       = require('cookie-parser');
const whatsappRouter     = require('./webhooks/whatsapp');
const appointmentsRouter = require('./routes/appointments');
const messagesRouter     = require('./routes/messages');
const adminRouter        = require('./routes/admin');
const clinicsRouter      = require('./routes/clinics');

const app = express();

// ── CORS — allow the Next.js dashboard to call /api/────────────────────────
const DASHBOARD_ORIGIN = process.env.DASHBOARD_URL || 'http://localhost:3001';
const ALLOWED_ORIGINS = [DASHBOARD_ORIGIN, 'https://clinic-bot-fr89.vercel.app', 'http://localhost:3000'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin) || (origin && origin.endsWith('vercel.app'))) {
    res.setHeader('Access-Control-Allow-Origin',  origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON bodies (Meta sends application/json)
app.use(express.json());

// Cookie parser (required for admin session)
app.use(cookieParser());

// HTTP request logging
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  })
);

// Routes
app.use('/webhook',          whatsappRouter);
app.use('/api/appointments', appointmentsRouter);
app.use('/api/messages',     messagesRouter);
app.use('/api/clinics',      clinicsRouter);
app.use('/admin',            adminRouter);

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
  
  // Fix 4 - Reminders cron job
  const { sendReminders } = require('./jobs/reminders');
  setInterval(sendReminders, 60 * 60 * 1000); // every hour
  sendReminders(); // run once on startup

  // Media Cleanup job
  const { cleanupExpiredMedia } = require('./jobs/mediaCleanup');
  setInterval(cleanupExpiredMedia, 60 * 60 * 1000); // every hour
  cleanupExpiredMedia(); // run once on startup
});
