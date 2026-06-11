const express = require('express');
const router  = express.Router();
const { supabase } = require('../services/supabase');
const logger = require('../utils/logger');

// GET /api/clinics/:slug
// Fetches clinic details, available schedules, faqs, and blocked periods by slug.
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // 1. Fetch clinic details (Exclude sensitive data)
    const { data: clinic, error: clinicErr } = await supabase
      .from('clinics')
      .select(`
        id, name, doctor_name, specialty, address, working_hours, 
        appointment_duration_minutes, consultation_price, treated_diseases, map_link, phone_number
      `)
      .eq('slug', slug)
      .single();

    if (clinicErr || !clinic) {
      return res.status(404).json({ error: 'العيادة غير موجودة' });
    }

    // 2. Fetch Availability Schedules
    const { data: schedules, error: schedErr } = await supabase
      .from('availability_schedules')
      .select('*')
      .eq('clinic_id', clinic.id);

    if (schedErr) {
      logger.error('Error fetching schedules', { error: schedErr });
    }

    // 3. Fetch Blocked Periods
    const { data: blocked, error: blockedErr } = await supabase
      .from('blocked_periods')
      .select('*')
      .eq('clinic_id', clinic.id);
    
    if (blockedErr) {
      logger.error('Error fetching blocked periods', { error: blockedErr });
    }

    // 4. Fetch FAQs
    const { data: faqs, error: faqsErr } = await supabase
      .from('faqs')
      .select('question, answer')
      .eq('clinic_id', clinic.id)
      .eq('is_active', true);

    if (faqsErr) {
      logger.error('Error fetching FAQs', { error: faqsErr });
    }

    // Return the aggregated data
    return res.json({
      clinic,
      schedules: schedules || [],
      blocked_periods: blocked || [],
      faqs: faqs || []
    });

  } catch (error) {
    logger.error('Error in GET /api/clinics/:slug', { error: error.message });
    return res.status(500).json({ error: 'حدث خطأ في السيرفر' });
  }
});

module.exports = router;
