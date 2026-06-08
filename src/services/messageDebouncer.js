'use strict';

/**
 * messageDebouncer.js
 *
 * Accumulates rapid successive messages from the same user into a single
 * combined string, then calls onReady() once the burst is over.
 *
 * Typical use-case: a patient types one word per message very quickly.
 * Without debouncing the agent would reply to each fragment separately.
 *
 *   debounceMessage(clinicId, phone, 'أريد', cb)   ← starts 2.5 s timer
 *   debounceMessage(clinicId, phone, 'حجز',  cb)   ← resets timer
 *   debounceMessage(clinicId, phone, 'موعد', cb)   ← resets timer
 *   … 2500 ms of silence …
 *   cb('أريد حجز موعد')                            ← called exactly once
 */

const DEBOUNCE_DELAY_MS = 2500;

// key: `${clinicId}:${phoneNumber}`  →  { timer: TimeoutId, parts: string[] }
const pending = new Map();

/**
 * @param {string}   clinicId
 * @param {string}   phoneNumber  — E.164 phone number
 * @param {string}   messageText  — the individual message fragment
 * @param {Function} onReady      — called with the combined text when the burst settles
 */
function debounceMessage(clinicId, phoneNumber, messageText, messageType, onReady) {
  const key     = `${clinicId}:${phoneNumber}`;
  const existing = pending.get(key);

  if (existing) {
    // Another message arrived before the timer fired — reset it
    clearTimeout(existing.timer);
    existing.parts.push({ text: messageText, type: messageType });
  } else {
    pending.set(key, { timer: null, parts: [{ text: messageText, type: messageType }] });
  }

  const entry = pending.get(key);

  entry.timer = setTimeout(() => {
    const combinedText = entry.parts.map(p => p.text).join(' ');
    const combinedType = entry.parts.some(p => p.type === 'voice') ? 'voice' : 'text';
    pending.delete(key);          // clean up so stale entries don't accumulate
    onReady({ combinedText, combinedType });
  }, DEBOUNCE_DELAY_MS);
}

module.exports = { debounceMessage, DEBOUNCE_DELAY_MS };
