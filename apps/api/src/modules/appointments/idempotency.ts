import type { Prisma } from '@prisma/client';

/**
 * Serialises concurrent bookings that carry the same Idempotency-Key within a
 * clinic: takes a transaction-scoped advisory lock on (clinic, key), then returns
 * the id of the appointment already stored under that key, if any. Must run
 * inside the booking transaction BEFORE anything is inserted, so the second
 * request waits for the first to commit and then replays its row instead of
 * hitting the overlap constraint.
 */
export async function lockIdempotencyKey(tx: Prisma.TransactionClient, clinicId: string, idempotencyKey: string): Promise<string | null> {
  const lockKey = `${clinicId}:${idempotencyKey}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`;
  const existing = await tx.appointment.findFirst({ where: { clinicId, idempotencyKey }, select: { id: true } });
  return existing?.id ?? null;
}
