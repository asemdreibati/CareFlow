/**
 * Helpers shared by the scheduling services: tenant scoping outside requests,
 * event payload construction (mirrors AppointmentsService.emit) and the list of
 * statuses that still occupy a doctor's time.
 */
import type { AppointmentStatus, Prisma } from '@prisma/client';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { AppointmentEvent } from '../appointments/appointments.service.js';

/** Statuses that block a doctor's slot (mirrors the DB exclusion constraint). */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED'];
/** Statuses of appointments that can still be moved by a proposal. */
export const MOVABLE_STATUSES: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];

export const eventInclude = {
  doctor: { select: { id: true, userId: true, firstName: true, lastName: true } },
  patient: { select: { id: true, firstName: true, lastName: true } },
} as const;

export type AppointmentWithEventRelations = Prisma.AppointmentGetPayload<{ include: typeof eventInclude }>;

/** Builds the `appointment.*` payload exactly as AppointmentsService does. */
export function toAppointmentEvent(appt: AppointmentWithEventRelations, actorUserId: string): AppointmentEvent {
  const { doctor, patient, ...rest } = appt;
  return {
    ...rest,
    doctor: { id: doctor.id, userId: doctor.userId, firstName: doctor.firstName, lastName: doctor.lastName },
    patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
    actorUserId,
  };
}

/**
 * Runs `fn` with RLS scoped to `clinicId`. Inside a request for that clinic the
 * current context is reused; otherwise (cron, listener fired from a system job) a
 * plain non-bypass context is created so the policy still applies.
 */
export function inClinic<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = tenantContext.get();
  if (ctx?.clinicId === clinicId) return fn();
  return tenantContext.run({ requestId: ctx?.requestId ?? 'scheduling', userId: ctx?.userId, clinicId }, async () => await fn());
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "YYYY-MM-DD" + n days (calendar arithmetic, timezone independent). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + n));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}
