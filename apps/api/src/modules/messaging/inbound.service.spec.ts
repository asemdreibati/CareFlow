import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { AppointmentWriterService } from '../waitlist/appointment-writer.service.js';
import type { WaitlistService } from '../waitlist/waitlist.service.js';
import { InboundService } from './inbound.service.js';
import { loadMessagingConfig } from './messaging.config.js';
import { isUniqueViolation } from './patient-phone-lookup.js';

const p2002 = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`provider_message_id`)', { code: 'P2002', clientVersion: 'test' });

/**
 * De-duplication of webhook deliveries, independent of whether the unique index
 * on `messages.provider_message_id` exists: an earlier inbound row with the same
 * id short-circuits, and a unique violation on insert is treated as a duplicate.
 */
function setup(opts: { existingBeforeInsert: boolean; insertFails: boolean }) {
  let insertAttempted = false;
  const existing = { id: 'm-first', appointmentId: 'a1' };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    appointment: {
      findFirst: vi.fn(async () => ({ id: 'a1', status: 'SCHEDULED', startsAt: new Date(Date.now() + 3 * 86_400_000), holdExpiresAt: null })),
      update: vi.fn(),
    },
    message: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => {
        insertAttempted = true;
        if (opts.insertFails) throw p2002();
        return { id: 'm-new' };
      }),
    },
    waitlistEntry: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    db: {
      message: {
        findFirst: vi.fn(async ({ where }: { where: { direction: string } }) => {
          if (where.direction === 'OUTBOUND') return { id: 'o1', clinicId: 'c1', appointmentId: 'a1' };
          return opts.existingBeforeInsert || insertAttempted ? existing : null;
        }),
      },
      appointment: {
        findFirst: vi.fn(async () => ({ id: 'a1', patientId: 'p1', clinicId: 'c1', patient: { locale: 'en' }, clinic: { timezone: 'UTC', settings: {} } })),
      },
    },
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const writer = { cancel: vi.fn(async () => ({ id: 'a1' })), emitCancelled: vi.fn(), emitUpdated: vi.fn() };
  const service = new InboundService(prisma as unknown as PrismaService, writer as unknown as AppointmentWriterService, {} as WaitlistService, loadMessagingConfig());
  return { service, prisma, tx, writer };
}

describe('InboundService de-duplication', () => {
  it('ignores a delivery whose MessageSid was already recorded (no transaction, no action, no reply)', async () => {
    const { service, prisma, writer } = setup({ existingBeforeInsert: true, insertFails: false });
    const r = await service.handle({ from: '+966501234567', body: '2', providerMessageId: 'SM1' });
    expect(r).toMatchObject({ duplicate: true, reply: '', action: 'none', messageId: 'm-first' });
    expect(prisma.transaction).not.toHaveBeenCalled();
    expect(writer.cancel).not.toHaveBeenCalled();
  });

  it('treats a unique violation on insert (concurrent duplicate, with the unique index) as a duplicate', async () => {
    const { service, writer, tx } = setup({ existingBeforeInsert: false, insertFails: true });
    const r = await service.handle({ from: '+966501234567', body: '2', providerMessageId: 'SM1' });
    expect(r).toMatchObject({ duplicate: true, reply: '', action: 'none' });
    // The reply row is inserted BEFORE acting, so the losing delivery never cancels anything
    expect(tx.message.create).toHaveBeenCalledTimes(1);
    expect(writer.cancel).not.toHaveBeenCalled();
    expect(writer.emitCancelled).not.toHaveBeenCalled();
  });

  it('acts once for a new delivery: locks the answered message, records the reply, cancels', async () => {
    const { service, writer, tx } = setup({ existingBeforeInsert: false, insertFails: false });
    const r = await service.handle({ from: '+966501234567', body: '2', providerMessageId: 'SM2' });
    expect(r).toMatchObject({ action: 'cancelled', appointmentId: 'a1', messageId: 'm-new' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1); // SELECT … FOR UPDATE on the outbound message
    expect(tx.message.create.mock.calls[0]).toMatchObject([{ data: { appointmentId: 'a1', inReplyToId: 'o1', providerMessageId: 'SM2', intent: 'CANCEL' } }]);
    expect(writer.cancel).toHaveBeenCalledTimes(1);
    expect(writer.emitCancelled).toHaveBeenCalledTimes(1);
  });
});

describe('isUniqueViolation', () => {
  it('recognises P2002 and raw 23505 errors only', () => {
    expect(isUniqueViolation(p2002())).toBe(true);
    expect(isUniqueViolation(new Error('ERROR: duplicate key value violates unique constraint "messages_provider_message_id_key" (SQLSTATE 23505)'))).toBe(true);
    expect(isUniqueViolation(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: 'test' }))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
