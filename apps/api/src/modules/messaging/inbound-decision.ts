/**
 * What a patient's reply (`1` / `2`) does (pure). The caller resolves the
 * appointment from the latest outbound message WITH reply instructions sent to
 * the phone (see `REPLYABLE_TEMPLATES`) within the reply window; there is no
 * fallback to "the next appointment": when nothing resolves, nothing happens
 * and the patient is asked to contact the clinic.
 */
import type { AppointmentStatus } from '@prisma/client';
import type { InboundIntent } from './inbound-intent.js';
import type { InboundReplyKey } from './messaging.templates.js';

/** Patients may cancel (portal or message) up to 2 hours before the start; later only through the clinic. */
export const PATIENT_CANCEL_LEAD_MS = 2 * 3_600_000;

/** Statuses a reply can still act on. */
export const REPLYABLE_STATUSES: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];

export interface ReplyAppointment {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
  holdExpiresAt: Date | null;
}

export interface InboundDecisionInput {
  intent: InboundIntent;
  /** Appointment of the outbound message being answered; null when none resolved. */
  appointment: ReplyAppointment | null;
  /** An earlier reply to the SAME outbound message already changed something. */
  alreadyActedOn: boolean;
  /** OFFERED waitlist entry of the patient whose held offer `appointment` is (null when none). */
  heldOfferEntryId: string | null;
  now: Date;
}

export type InboundDecision =
  | { action: 'none'; reply: InboundReplyKey }
  | { action: 'confirm' | 'cancel'; reply: InboundReplyKey }
  | { action: 'acceptOffer' | 'declineOffer'; entryId: string; reply: InboundReplyKey };

/** True when patients may still cancel an appointment starting at `startsAt` themselves. */
export function patientMayCancel(startsAt: Date, now: Date = new Date()): boolean {
  return startsAt.getTime() - now.getTime() >= PATIENT_CANCEL_LEAD_MS;
}

export function decideInbound(input: InboundDecisionInput): InboundDecision {
  const a = input.appointment;
  const actionable = !!a && REPLYABLE_STATUSES.includes(a.status) && a.startsAt.getTime() > input.now.getTime();
  if (input.intent === 'UNKNOWN') return { action: 'none', reply: actionable ? 'unknown' : 'contactClinic' };
  if (!a || !actionable) return { action: 'none', reply: 'contactClinic' };

  if (input.intent === 'CONFIRM') {
    if (a.holdExpiresAt) {
      // A held waitlist offer is accepted through the waitlist (clears the hold, books the entry).
      return input.heldOfferEntryId && !input.alreadyActedOn ? { action: 'acceptOffer', entryId: input.heldOfferEntryId, reply: 'confirmed' } : { action: 'none', reply: 'contactClinic' };
    }
    // Idempotent acknowledgement: nothing to change.
    if (a.status === 'CONFIRMED') return { action: 'none', reply: 'confirmed' };
    if (input.alreadyActedOn) return { action: 'none', reply: 'contactClinic' };
    return { action: 'confirm', reply: 'confirmed' };
  }

  // CANCEL. A patient may change their mind after confirming ("1" then "2"): the appointment's
  // current status already makes a repeated cancel a no-op (it is no longer actionable),
  // replies to one message are serialised by a row lock, and provider replays are de-duplicated
  // by MessageSid, so an earlier action on the same message does not block a cancellation.
  if (a.holdExpiresAt && input.heldOfferEntryId) return { action: 'declineOffer', entryId: input.heldOfferEntryId, reply: 'offerDeclined' };
  if (!patientMayCancel(a.startsAt, input.now)) return { action: 'none', reply: 'tooLateToCancel' };
  return { action: 'cancel', reply: 'cancelled' };
}
