function decide(extracted, checks, currentState, stateData) {

  const { intent } = extracted;

  // ── Gate Collecting (المريض يجاوب أسئلة Gate) ────────────────────────
  if (currentState === 'gate_collecting') {
    return { action: 'GATE_CONTINUE', step: stateData.escalation?.gate_step || 1, userMessage: extracted.userMessage };
  }

  // ── Escalation to Doctor ──────────────────────────────────────────────
  if (intent === 'escalate_to_doctor') {
    return { action: 'GATE_START' };
  }

  // ── Confirmation/Rejection (state-dependent) ──────────────────────────────
  if (intent === 'confirmation') {
    if (currentState === 'awaiting_rebook_confirm')
      return { action: 'DO_REBOOK', data: stateData };
    if (currentState === 'awaiting_cancel_confirm')
      return { action: 'DO_CANCEL', data: stateData };
    if (currentState === 'awaiting_cancel_all_confirm')
      return { action: 'DO_CANCEL_ALL', data: stateData };
    if (currentState === 'awaiting_voice_confirm')
      return { action: 'DO_VOICE_BOOK', data: stateData };
    return { action: 'UNCLEAR' };
  }

  if (intent === 'rejection') {
    if (['awaiting_rebook_confirm','awaiting_cancel_confirm','awaiting_cancel_all_confirm'].includes(currentState))
      return { action: 'CANCEL_FLOW' };
    if (currentState === 'awaiting_voice_confirm')
      return { action: 'REJECT_VOICE_BOOK' };
    return { action: 'UNCLEAR' };
  }

  // ── Awaiting Cancel Select ──────────────────────────────────────────────────
  if (currentState === 'awaiting_cancel_select') {
    if (extracted.patient_name || intent === 'cancellation') {
      const targetName = (extracted.patient_name || '').trim().toLowerCase();
      const appts = stateData.cancel_appts || [];
      const matched = appts.find(a => (a.patient_name || '').trim().toLowerCase() === targetName);
      if (matched) {
        return { action: 'CONFIRM_CANCEL', targetAppt: matched };
      }
    }
    return { action: 'ASK_CANCEL_SELECT', appts: stateData.cancel_appts || [] };
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
  if (intent === 'cancel_all') {
    if (checks.upcomingAppts.length === 0)
      return { action: 'NO_APPOINTMENTS' };
    return { action: 'CONFIRM_CANCEL_ALL', appts: checks.upcomingAppts };
  }

  if (intent === 'cancellation') {
    if (checks.upcomingAppts.length === 0)
      return { action: 'NO_APPOINTMENTS' };
      
    if (checks.upcomingAppts.length === 1)
      return { action: 'CONFIRM_CANCEL', targetAppt: checks.upcomingAppts[0] };
      
    if (extracted.patient_name) {
      const targetName = extracted.patient_name.trim().toLowerCase();
      const matched = checks.upcomingAppts.find(a => (a.patient_name || '').trim().toLowerCase() === targetName);
      if (matched)
        return { action: 'CONFIRM_CANCEL', targetAppt: matched };
    }
    
    return { action: 'ASK_CANCEL_SELECT', appts: checks.upcomingAppts };
  }

  // ── Booking ───────────────────────────────────────────────────────────────
  if (intent === 'booking') {
    // Collect missing fields
    const missing = [];
    if (!extracted.patient_name)    missing.push('الاسم الثنائي للمريض');
    if (!extracted.date_preference) missing.push('اليوم المطلوب للحجز');

    if (missing.length > 0)
      return { action: 'ASK_MISSING', fields: missing, extracted, answer: checks.combinedAnswer };

    // Only check dayInfo if we have a date
    if (!checks.dayInfo)
      return { action: 'ASK_MISSING', fields: ['اليوم المطلوب للحجز'], extracted, answer: checks.combinedAnswer };

    // Name must be two words
    if (!checks.nameValid)
      return { action: 'ASK_FULL_NAME', extracted, answer: checks.combinedAnswer };

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

    if (extracted.messageType === 'voice') {
      return { action: 'ASK_VOICE_CONFIRM', extracted, dayInfo: checks.dayInfo };
    }

    return { action: 'BOOK', extracted, dayInfo: checks.dayInfo };
  }

  // ── Unclear ───────────────────────────────────────────────────────────────
  return { action: 'UNCLEAR' };
}

module.exports = { decide };
