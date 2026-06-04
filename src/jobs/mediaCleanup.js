const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

async function cleanupExpiredMedia() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Fetch conversations with images older than 24 hours
  const { data: expired, error: fetchErr } = await supabase
    .from('conversations')
    .select('id, media_url')
    .eq('message_type', 'image')
    .not('media_url', 'is', null)
    .lt('created_at', cutoff);

  if (fetchErr) {
    logger.error('[MediaCleanup] Fetch error', { error: fetchErr.message });
    return;
  }

  if (!expired || expired.length === 0) return;

  // 2. Extract file paths from URLs
  const filePaths = expired.map(row => {
    const url = row.media_url;
    // Extract path after 'patient-media/'
    const match = url.match(/patient-media\/(.+)$/);
    return match ? match[1] : null;
  }).filter(Boolean);

  // 3. Delete files from Storage
  if (filePaths.length > 0) {
    const { error: removeErr } = await supabase.storage
      .from('patient-media')
      .remove(filePaths);
      
    if (removeErr) {
      logger.error('[MediaCleanup] Storage delete error', { error: removeErr.message });
    }
  }

  // 4. Clear media_url from database
  const ids = expired.map(r => r.id);
  
  // We can do an IN update
  // But supabase-js update needs eq or in
  const { error: updateErr } = await supabase
    .from('conversations')
    .update({ media_url: null })
    .in('id', ids);

  if (updateErr) {
    logger.error('[MediaCleanup] DB update error', { error: updateErr.message });
  } else {
    logger.info(`[MediaCleanup] Cleaned ${expired.length} expired media files`);
  }
}

module.exports = { cleanupExpiredMedia };
