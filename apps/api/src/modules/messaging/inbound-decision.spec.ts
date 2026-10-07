import { describe, expect, it } from 'vitest';
import { decideInbound, patientMayCancel, type InboundDecisionInput, type ReplyAppointment } from './inbound-decision.js';

const now = new Date('2026-10-07T10:00:00.000Z');
const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
const appt = (over: Partial<ReplyAppointment> = {}): ReplyAppointment => ({ id: 'a1', status: 'SCHEDULED', startsAt: inHours(48), holdExpiresAt: null, ...over });
const input = (over: Partial<InboundDecisionInput> = {}): InboundDecisionInput => ({ intent: 'CANCEL', appointment: appt(), alreadyActedOn: false, heldOfferEntryId: null, now, ...over });

describe('decideInbound', () => {
  it('never acts without a resolved appointment (no "next appointment" fallback)', () => {
    expect(decideInbound(input({ appointment: null, intent: 'CANCEL' }))).toEqual({ action: 'none', reply: 'contactClinic' });
    expect(decideInbound(input({ appointment: null, intent: 'CONFIRM' }))).toEqual({ action: 'none', reply: 'contactClinic' });
    expect(decideInbound(input({ appointment: null, intent: 'UNKNOWN' }))).toEqual({ action: 'none', reply: 'contactClinic' });
  });

  it('ignores appointments that are no longer SCHEDULED/CONFIRMED or already started', () => {
    for (const status of ['CANCELLED', 'NO_SHOW', 'COMPLETED', 'CHECKED_IN', 'IN_PROGRESS'] as const) {
      expect(decideInbound(input({ appointment: appt({ status }) })).action).toBe('none');
    }
    expect(decideInbound(input({ appointment: appt({ startsAt: inHours(-1) }), intent: 'CONFIRM' }))).toEqual({ action: 'none', reply: 'contactClinic' });
  });

  it('confirms / cancels the resolved appointment', () => {
    expect(decideInbound(input({ intent: 'CONFIRM' }))).toEqual({ action: 'confirm', reply: 'confirmed' });
    expect(decideInbound(input({ intent: 'CANCEL' }))).toEqual({ action: 'cancel', reply: 'cancelled' });
    expect(decideInbound(input({ intent: 'UNKNOWN' }))).toEqual({ action: 'none', reply: 'unknown' });
  });

  it('acknowledges a repeated confirmation without acting again', () => {
    expect(decideInbound(input({ intent: 'CONFIRM', appointment: appt({ status: 'CONFIRMED' }), alreadyActedOn: true }))).toEqual({ action: 'none', reply: 'confirmed' });
  });

  it('lets a patient cancel after confirming the same message, but never acts twice otherwise', () => {
    expect(decideInbound(input({ intent: 'CANCEL', appointment: appt({ status: 'CONFIRMED' }), alreadyActedOn: true }))).toEqual({ action: 'cancel', reply: 'cancelled' });
    expect(decideInbound(input({ intent: 'CANCEL', appointment: appt({ status: 'CANCELLED' }), alreadyActedOn: true }))).toEqual({ action: 'none', reply: 'contactClinic' });
    expect(decideInbound(input({ intent: 'CONFIRM', alreadyActedOn: true }))).toEqual({ action: 'none', reply: 'contactClinic' });
    expect(decideInbound(input({ intent: 'CONFIRM', appointment: appt({ holdExpiresAt: inHours(20) }), heldOfferEntryId: 'e1', alreadyActedOn: true })).action).toBe('none');
  });

  it('applies the 2-hour cancellation cut-off', () => {
    expect(decideInbound(input({ appointment: appt({ startsAt: inHours(1.5) }) }))).toEqual({ action: 'none', reply: 'tooLateToCancel' });
    expect(decideInbound(input({ appointment: appt({ startsAt: inHours(2) }) }))).toEqual({ action: 'cancel', reply: 'cancelled' });
    // Confirming late is fine
    expect(decideInbound(input({ intent: 'CONFIRM', appointment: appt({ startsAt: inHours(1) }) })).action).toBe('confirm');
  });

  it('routes held waitlist offers to accept / decline', () => {
    const held = appt({ holdExpiresAt: inHours(20), startsAt: inHours(1) });
    expect(decideInbound(input({ intent: 'CONFIRM', appointment: held, heldOfferEntryId: 'e1' }))).toEqual({ action: 'acceptOffer', entryId: 'e1', reply: 'confirmed' });
    expect(decideInbound(input({ intent: 'CANCEL', appointment: held, heldOfferEntryId: 'e1' }))).toEqual({ action: 'declineOffer', entryId: 'e1', reply: 'offerDeclined' });
    // A hold without an open offer is never "confirmed" directly
    expect(decideInbound(input({ intent: 'CONFIRM', appointment: held, heldOfferEntryId: null }))).toEqual({ action: 'none', reply: 'contactClinic' });
  });
});

describe('patientMayCancel', () => {
  it('is false within 2 hours of the start', () => {
    expect(patientMayCancel(inHours(3), now)).toBe(true);
    expect(patientMayCancel(inHours(1.99), now)).toBe(false);
  });
});
