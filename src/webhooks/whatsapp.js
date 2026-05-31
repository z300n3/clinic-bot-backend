const express = require('express');
const router = express.Router();

const { handleIncomingMessage } = require('../agent');
const {
  getClinicByPhoneNumberId,
  findOrCreatePatient,
  saveMessage,
  getConversationState,
  upsertConversationState,
} = require('../services/supabase');
const { sendWhatsAppMessage, markMessageRead, sendTypingIndicator, downloadWhatsAppMedia } = require('../services/whatsapp');
const { transcribeAudio } = require('../services/transcription');
const { debounceMessage } = require('../services/messageDebouncer');
const logger = require('../utils/logger');

// ── GET /webhook — Meta verification challenge ────────────────────────────────

router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    logger.info('Webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed', { mode, token: token?.slice(0, 8) });
  return res.sendStatus(403);
});

// ── POST /webhook — Incoming events from Meta ─────────────────────────────────

router.post('/', async (req, res) => {
  // Must acknowledge immediately — Meta retries if it doesn't get 200 within 5 s
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value         = change.value;
        const phoneNumberId = value.metadata?.phone_number_id;
        const profileName   = value.contacts?.[0]?.profile?.name || null;

        // Log status updates (read receipts, delivery) but don't act on them
        for (const status of value.statuses || []) {
          logger.debug('Message status', { id: status.id, status: status.status });
        }

        for (const message of value.messages || []) {
          let text            = null;
          let messageType     = 'text';
          let originalMediaId = null;

          // ── Text message ───────────────────────────────────────────────────
          if (message.type === 'text') {
            text = message.text.body.trim();

          // ── Voice / audio message ──────────────────────────────────────────
          } else if (message.type === 'audio') {
            logger.info('Voice message received — transcribing', {
              from:    message.from,
              mediaId: message.audio.id,
            });

            try {
              const audioBuffer = await downloadWhatsAppMedia(message.audio.id);
              text              = await transcribeAudio(audioBuffer);
              messageType       = 'voice';
              originalMediaId   = message.audio.id;

              logger.info('Voice→Text', { from: message.from, transcript: text.slice(0, 120) });
            } catch (err) {
              logger.error('Voice transcription failed', { from: message.from, error: err.message });
              await sendWhatsAppMessage(
                phoneNumberId,
                message.from,
                'عذراً، ما كدرت أسمع الرسالة الصوتية بوضوح 😅\nممكن تكتب طلبك بالنص؟'
              ).catch(() => {});
              continue;
            }

          // ── Unsupported type (image, video, sticker, document …) ───────────
          } else {
            logger.info('Unsupported message type — skipping', {
              type: message.type,
              from: message.from,
            });
            await sendWhatsAppMessage(
              phoneNumberId,
              message.from,
              'نأسف، ما نقدر نقرأ هذا النوع من الرسائل حالياً. يرجى إرسال رسالة نصية أو صوتية. 🙏'
            ).catch(() => {});
            continue;
          }

          // Fire-and-forget; errors are handled inside processMessage
          processMessage({
            phoneNumberId,
            from:           message.from,
            profileName,
            messageId:      message.id,
            text,
            messageType,
            originalMediaId,
          }).catch((err) =>
            logger.error('Unhandled processMessage error', { error: err.message })
          );
        }
      }
    }
  } catch (err) {
    logger.error('Webhook handler error', { error: err.message, stack: err.stack });
  }
});

// ── Phase 1: per-message (runs immediately on every incoming message) ──────────
//
// Handles deduplication and starts/resets the debounce timer.
// The heavy AI work is deferred to processDebounced().

async function processMessage({ phoneNumberId, from, profileName, messageId, text, messageType, originalMediaId }) {
  logger.info('Processing message', {
    from,
    messageId,
    type:    messageType,
    preview: text.slice(0, 60),
  });

  // 1. Resolve clinic
  const clinic = await getClinicByPhoneNumberId(phoneNumberId);
  if (!clinic) {
    logger.error('No active clinic for phoneNumberId', { phoneNumberId });
    return;
  }

  // 2. Upsert patient
  const patient = await findOrCreatePatient(clinic.id, from, profileName);

  // 3. Save user message — returns null if duplicate (idempotent)
  const saved = await saveMessage({
    clinicId:          clinic.id,
    patientId:         patient.id,
    patientPhone:      from,
    role:              'user',
    content:           text,
    whatsappMessageId: messageId,
    messageType,
    originalMediaId,
  });

  if (saved === null) {
    logger.info('Duplicate message ignored', { messageId });
    return;
  }

  // Mark this message read immediately (best-effort)
  markMessageRead(phoneNumberId, messageId).catch(() => {});

  // 4. Hand off to the debouncer.
  //    If the user sends more messages within DEBOUNCE_DELAY_MS, the timer
  //    resets and all fragments are joined before the agent is called.
  debounceMessage(clinic.id, from, text, (combinedText) => {
    logger.info('Debounce settled', {
      from,
      combined: combinedText.slice(0, 120),
    });
    processDebounced({ clinic, patient, phoneNumberId, from, combinedText }).catch((err) =>
      logger.error('processDebounced error', { from, error: err.message })
    );
  });
}

// ── Phase 2: debounced (runs once per burst, with the combined text) ───────────

// Keywords that mean the patient wants the bot to resume (booking/dismissal intent)
const RESUME_KEYWORDS = [
  'احجز', 'موعد', 'حجز', 'اريد', 'أريد', 'ابي', 'أبي',
  'كلمني', 'ليس ميحتاج', 'ما ميحتاج', 'لا يهم', 'نسيت',
];

// Iraqi-Arabic positive/agreement phrases — must NEVER trigger awaiting_human
// (kept here as a reference; the enforcement is in the system prompt)
// "مو مشكلة", "لا مشكلة", "ماكو مشكلة", "تمام", "زين", "موافق" …

async function processDebounced({ clinic, patient, phoneNumberId, from, combinedText }) {
  // 1. Check conversation state
  const state = await getConversationState(clinic.id, from);

  if (state?.state === 'awaiting_human') {
    // If patient sends a booking or dismissal keyword → auto-resume the bot
    const wantsResume = RESUME_KEYWORDS.some((kw) => combinedText.includes(kw));

    if (wantsResume) {
      logger.info('Auto-resuming bot from awaiting_human', { from, trigger: combinedText.slice(0, 60) });
      await upsertConversationState(clinic.id, from, 'active', {});
      // Fall through — process normally with Claude
    } else {
      // Rate-limit the "received" reply: send it at most once every 5 minutes
      const FIVE_MIN_MS    = 5 * 60 * 1000;
      const lastReplyTime  = state.last_message_at ? new Date(state.last_message_at).getTime() : 0;
      const shouldNotify   = (Date.now() - lastReplyTime) >= FIVE_MIN_MS;

      if (shouldNotify) {
        await upsertConversationState(clinic.id, from, 'awaiting_human', state.state_data);
        await sendWhatsAppMessage(phoneNumberId, from, 'تم استلام رسالتك، فريق العيادة سيرد قريباً ⏳');
      }
      return;
    }
  }

  // 2. Update state to active + touch last_message_at
  await upsertConversationState(clinic.id, from, 'active', state?.state_data || {});

  // 3. Show typing indicator so the patient knows the bot is working
  sendTypingIndicator(phoneNumberId, from).catch(() => {});

  // 4. Run AI agent with the combined (debounced) text
  let reply;
  try {
    reply = await handleIncomingMessage({
      clinic,
      patient,
      patientPhone: from,
      userMessage:  combinedText,
    });
  } catch (err) {
    logger.error('Agent error', { from, error: err.message });
    reply = 'عذراً، صار خطأ تقني. حاول مرة ثانية بعد شوي. 🙏';
  }

  // 5. Send reply
  try {
    await sendWhatsAppMessage(phoneNumberId, from, reply);
  } catch (sendErr) {
    logger.error('Failed to deliver reply', { from, error: sendErr.message });
  }
}

module.exports = router;
