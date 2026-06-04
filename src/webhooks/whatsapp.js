const express = require('express');
const router = express.Router();

const { handleIncomingMessage } = require('../agent');
const {
  getClinicByPhoneNumberId,
  findOrCreatePatient,
  saveMessage,
  getConversationState
} = require('../services/supabase');
const { sendWhatsAppMessage, markMessageRead, sendTypingIndicator, downloadWhatsAppMedia, downloadAndStoreMedia } = require('../services/whatsapp');
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
          let mediaUrl        = null;

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

          // ── Image message ──────────────────────────────────────────
          } else if (message.type === 'image') {
            const clinic = await getClinicByPhoneNumberId(phoneNumberId);
            const stateRow = clinic ? await getConversationState(clinic.id, message.from) : null;
            const acceptMedia = ['gate_collecting', 'doctor_pending', 'doctor_active'].includes(stateRow?.state);
            
            if (acceptMedia && clinic) {
              try {
                mediaUrl = await downloadAndStoreMedia(message.image.id, clinic.id, message.from);
                text = message.image.caption || '📷 صورة مرفقة';
                messageType = 'image';
                originalMediaId = message.image.id;
              } catch (err) {
                logger.error('Failed to download image', { error: err.message });
                await sendWhatsAppMessage(phoneNumberId, message.from, 'نأسف، حدث خطأ أثناء معالجة الصورة.').catch(() => {});
                continue;
              }
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

          // ── Unsupported type (video, sticker, document …) ───────────
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
            mediaUrl,
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

async function processMessage({ phoneNumberId, from, profileName, messageId, text, messageType, originalMediaId, mediaUrl }) {
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
    mediaUrl,
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

async function processDebounced({ clinic, patient, phoneNumberId, from, combinedText }) {
  // 1. Show typing indicator so the patient knows the bot is working
  sendTypingIndicator(phoneNumberId, from).catch(() => {});

  // 2. Run AI agent with the combined (debounced) text
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
