const axios = require('axios');
const logger = require('../utils/logger');

// Always target the latest stable Graph API version.
// Check https://developers.facebook.com/docs/graph-api/changelog for updates.
const GRAPH_API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function authHeader() {
  return { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` };
}

/**
 * Send a plain-text WhatsApp message.
 * @param {string} phoneNumberId  — Meta phone-number ID (from your app config)
 * @param {string} to             — recipient WhatsApp number (E.164, e.g. "9647901234567")
 * @param {string} text           — message body
 */
async function sendWhatsAppMessage(phoneNumberId, to, text) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
    );

    logger.info('WhatsApp message sent', {
      to,
      messageId: response.data?.messages?.[0]?.id,
    });

    return response.data;
  } catch (err) {
    logger.error('sendWhatsAppMessage failed', {
      to,
      status:   err.response?.status,
      apiError: err.response?.data,
      message:  err.message,
    });
    throw err;
  }
}

/**
 * Show a "typing…" indicator to the recipient.
 * Best-effort — caller should .catch() silently.
 *
 * @param {string} phoneNumberId  — Meta phone-number ID
 * @param {string} to             — recipient WhatsApp number (E.164)
 */
async function sendTypingIndicator(phoneNumberId, to) {
  try {
    await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to,
        type:              'typing',
      },
      { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Non-critical — log at debug level only
    logger.debug('sendTypingIndicator failed (non-critical)', {
      to,
      status:   err.response?.status,
      apiError: err.response?.data?.error?.message,
    });
  }
}

/**
 * Mark an incoming message as read (shows double-blue-tick to the sender).
 */
async function markMessageRead(phoneNumberId, messageId) {
  try {
    await axios.post(
      `${BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status:            'read',
        message_id:        messageId,
      },
      { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Non-critical — log and continue
    logger.warn('markMessageRead failed', { messageId, error: err.message });
  }
}

/**
 * Download a WhatsApp media file and return it as a Buffer.
 *
 * Meta two-step process:
 *   1. GET /{mediaId} → { url: "https://lookaside.fbsbx.com/..." }
 *   2. GET {url} (with same Bearer token) → binary audio data
 *
 * @param {string} mediaId  — the media ID from the incoming webhook message
 * @returns {Promise<Buffer>}
 */
async function downloadWhatsAppMedia(mediaId) {
  // Step 1: resolve the actual download URL
  const metaRes = await axios.get(
    `${BASE_URL}/${mediaId}`,
    { headers: authHeader() }
  );

  const mediaUrl = metaRes.data?.url;
  if (!mediaUrl) {
    throw new Error(`No URL returned for media ID ${mediaId}`);
  }

  // Step 2: download the binary audio (ogg/opus) into a Buffer
  const audioRes = await axios.get(mediaUrl, {
    headers:      authHeader(),
    responseType: 'arraybuffer',
  });

  logger.debug('Downloaded WhatsApp media', { mediaId, bytes: audioRes.data.byteLength });
  return Buffer.from(audioRes.data);
}

module.exports = { sendWhatsAppMessage, markMessageRead, sendTypingIndicator, downloadWhatsAppMedia };
