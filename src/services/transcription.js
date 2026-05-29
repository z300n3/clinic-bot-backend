'use strict';

/**
 * transcription.js
 *
 * Wraps OpenAI Whisper API to transcribe WhatsApp voice notes (ogg/opus)
 * into Arabic text. Always returns a non-empty string or throws.
 */

const OpenAI   = require('openai');
const { toFile } = require('openai');
const logger   = require('../utils/logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribe an audio Buffer (ogg/opus from WhatsApp) to Arabic text.
 *
 * @param {Buffer} audioBuffer  — raw audio bytes downloaded from Meta
 * @returns {Promise<string>}   — transcribed text
 * @throws if Whisper API fails
 */
async function transcribeAudio(audioBuffer) {
  // Wrap the Buffer in a File-like object the OpenAI SDK can multipart-upload
  const file = await toFile(audioBuffer, 'voice.ogg', { type: 'audio/ogg; codecs=opus' });

  // response_format: 'text' makes the SDK return a plain string directly
  const transcript = await openai.audio.transcriptions.create({
    file,
    model:           'gpt-4o-transcribe',
    language:        'ar',        // force Arabic for better accuracy
    response_format: 'text',
  });

  const text = (transcript || '').trim();

  if (!text) {
    throw new Error('Whisper returned empty transcript');
  }

  logger.debug('Whisper transcription complete', { chars: text.length });
  return text;
}

module.exports = { transcribeAudio };
