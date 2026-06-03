function decide(extracted, checks, currentState, stateData) {

  const { intent } = extracted;

  // ── Confirmation/Rejection (state-dependent) ──────────────────────────────
  if (intent === 'confirmation') {
    if (currentState === 'awaiting_rebook_confirm')
      return { action: 'DO_REBOOK', data: stateData };
    if (currentState === 'awaiting_cancel_confirm')
      return { action: 'DO_CANCEL', data: stateData };
    return { action: 'UNCLEAR' };
  }

  if (intent === 'rejection') {
    if (['awaiting_rebook_confirm','awaiting_cancel_confirm'].includes(currentState))
      return { action: 'CANCEL_FLOW' };
    return { action: 'UNCLEAR' };
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  if (intent === 'greeting')
    return { action: 'REPLY_GREETING' };

  // ── Medical advice ────────────────────────────────────────────────────────
  if (intent === 'medical_advice')
    return { action: 'REPLY_MEDICAL_REJECT' };

  // ── FAQ / Inquiry ─────────────────────────────────────────────────────────
  if (intent === 'inquiry') {
    if (checks.combinedAnswer)
      return { action: 'REPLY_COMBINED', answer: checks.combinedAnswer };
    
    // Fallbacks just in case
    if (checks.specificDayInfo)
      return { action: 'REPLY_SPECIFIC_DAY', dayInfo: checks.specificDayInfo };
    if (checks.absenceSummary)
      return { action: 'REPLY_ABSENCE', summary: checks.absenceSummary };
    if (checks.scheduleSummary)
      return { action: 'REPLY_SCHEDULE', summary: checks.scheduleSummary };
    if (checks.directAnswer)
      return { action: 'REPLY_DIRECT', answer: checks.directAnswer };
    if (checks.faqAnswer)
      return { action: 'REPLY_FAQ', answer: checks.faqAnswer };
      
    return { action: 'REPLY_CONTACT_CLINIC' };
  }

  // ── Check appointment ─────────────────────────────────────────────────────
  if (intent === 'check_appointment') {
    if (checks.upcomingAppts.length === 0)
      return { action: 'NO_APPOINTMENTS' };
    return { action: 'SHOW_APPOINTMENTS', appts: checks.upcomingAppts };
  }

  // ── Cancellation ──────────────────────────────────────────────────────────
  if (intent === 'cancellation')
    return { action: 'CONFIRM_CANCEL' };

  // ── Booking ───────────────────────────────────────────────────────────────
  if (intent === 'booking') {
    // Collect missing fields
    const missing = [];
    if (!extracted.patient_name)    missing.push('الاسم الثنائي للمريض');
    if (!extracted.date_preference) missing.push('اليوم المطلوب للحجز');
    if (!extracted.reason)          missing.push('سبب الزيارة');

    if (missing.length > 0)
      return { action: 'ASK_MISSING', fields: missing, extracted };

    // Only check dayInfo if we have a date
    if (!checks.dayInfo)
      return { action: 'ASK_MISSING', fields: ['اليوم المطلوب للحجز'], extracted };

    // Name must be two words
    if (!checks.nameValid)
      return { action: 'ASK_FULL_NAME', extracted };

    // Existing appointment with same name
    if (checks.existingAppt)
      return { action: 'CONFIRM_REBOOK', existingAppt: checks.existingAppt };

    // Day checks
    if (checks.dayInfo) {
      const d = checks.dayInfo;

      if (!d.isWorking)
        return { action: 'DAY_NOT_WORKING', dayInfo: d };

      if (d.isBlocked)
        return { action: 'DAY_BLOCKED', dayInfo: d, extracted };

      if (d.shiftEnded)
        return { action: 'SHIFT_ENDED', dayInfo: d, extracted };

      if (d.isFull)
        return { action: 'DAY_FULL', dayInfo: d, extracted };

      if (d.substitute)
        return { action: 'BOOK_WITH_SUBSTITUTE', dayInfo: d, extracted };
    }

    return { action: 'BOOK', extracted, dayInfo: checks.dayInfo };
  }

  // ── Unclear ───────────────────────────────────────────────────────────────
  return { action: 'UNCLEAR' };
}

module.exports = { decide };
