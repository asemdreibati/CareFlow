/**
 * Transaction-level helpers that keep a waitlist hold (an appointment created
 * with `holdExpiresAt`) and its waitlist entry consistent, whichever module
 * changes the appointment. No Nest dependencies so `AppointmentsService` can use
 * them without importing the waitlist module.
 */
import type { AppointmentStatus, Prisma } from '@prisma/client';

export const HOLD_NOTE = 'Waitlist offer';
export const HOLD_EXPIRED_NOTE = 'Hold expired';
/** Replaces HOLD_NOTE once the patient took the slot (accepted / confirmed / checked in). */
export const HOLD_BOOKED_NOTE = 'Booked from waitlist';

/** Statuses meaning the patient took the held slot: the hold must never expire any more. */
export const HOLD_SETTLING_STATUSES: readonly AppointmentStatus[] = ['CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'];

export function isHoldSettlingStatus(status: AppointmentStatus | string): boolean {
  return (HOLD_SETTLING_STATUSES as readonly string[]).includes(status);
}

/**
 * The held appointment became firm: clears `holdExpiresAt` (so the expiry job
 * leaves it alone and a later cancellation backfills normally), replaces the
 * hold note and marks the OFFERED entry BOOKED. Idempotent; returns whether
 * anything changed.
 */
export async function settleHold(tx: Prisma.TransactionClient, appointmentId: string): Promise<boolean> {
  const cleared = await tx.appointment.updateMany({ where: { id: appointmentId, holdExpiresAt: { not: null } }, data: { holdExpiresAt: null } });
  if (cleared.count > 0) await tx.appointment.updateMany({ where: { id: appointmentId, notes: HOLD_NOTE }, data: { notes: HOLD_BOOKED_NOTE } });
  const booked = await tx.waitlistEntry.updateMany({ where: { offeredAppointmentId: appointmentId, status: 'OFFERED' }, data: { status: 'BOOKED', offerExpiresAt: null } });
  return cleared.count > 0 || booked.count > 0;
}

/**
 * The held appointment is gone (cancelled / no-show): entries still OFFERED for
 * it wait again (offerCount + 1). Returns the released entry ids.
 */
export async function releaseOfferedEntries(tx: Prisma.TransactionClient, appointmentId: string): Promise<string[]> {
  const entries = await tx.waitlistEntry.findMany({ where: { offeredAppointmentId: appointmentId, status: 'OFFERED' }, select: { id: true } });
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.id);
  await tx.waitlistEntry.updateMany({
    where: { id: { in: ids }, offeredAppointmentId: appointmentId, status: 'OFFERED' },
    data: { status: 'WAITING', offeredAppointmentId: null, offerExpiresAt: null, offerCount: { increment: 1 } },
  });
  return ids;
}

/** Side effects of an appointment leaving the active set: rooms/equipment are released and an outstanding offer goes back to waiting. */
export async function releaseInactiveAppointment(tx: Prisma.TransactionClient, appointmentId: string): Promise<string[]> {
  await tx.resourceBooking.updateMany({ where: { appointmentId, active: true }, data: { active: false } });
  return releaseOfferedEntries(tx, appointmentId);
}
