import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { loadMessagingConfig } from './messaging.config.js';
import type { ListMessagesQuery } from './messaging.dto.js';
import { MessagingService } from './messaging.service.js';
import type { EmailProvider, SmsProvider, WhatsAppProvider } from './providers/provider.js';

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    db: {
      message: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `m${rows.size + 1}`, ...data };
          rows.set(row.id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = { ...rows.get(where.id), ...data };
          rows.set(where.id, row);
          return row;
        }),
        findMany: vi.fn(),
        count: vi.fn(),
      },
    },
  };
  const sms: SmsProvider = { name: 'fake', sendSms: vi.fn(async () => ({ provider: 'fake', providerMessageId: 'SM1' })) };
  const none = { name: 'none' } as unknown as WhatsAppProvider & EmailProvider;
  const service = new MessagingService(prisma as unknown as PrismaService, loadMessagingConfig(), sms, none, none);
  return { service, prisma, sms, rows };
}

describe('MessagingService OTP masking', () => {
  it('sends the real code to the provider but stores only the masked body', async () => {
    const { service, sms, rows } = setup();
    const msg = await service.send({ clinicId: 'c1', channel: 'SMS', to: '0501234567', template: 'portal.otp', locale: 'en', params: { code: '482913', minutes: 5, clinicName: 'Demo' } });

    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    const [to, body, options] = (sms.sendSms as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(to).toBe('+966501234567');
    expect(body).toContain('482913');
    expect(options).toMatchObject({ template: 'portal.otp', secrets: { code: '482913' } });
    expect(options.redactedBody).toContain('******');
    expect(options.redactedBody).not.toContain('482913');

    expect(msg.body).not.toContain('482913');
    expect(msg.body).toContain('******');
    expect([...rows.values()].every((r) => !String(r.body).includes('482913'))).toBe(true);
  });

  it('stores ordinary template bodies unchanged', async () => {
    const { service, sms } = setup();
    const msg = await service.send({ clinicId: 'c1', channel: 'SMS', to: '0501234567', template: 'appointment.reminder', locale: 'en', params: { when: '5 Oct 2026, 10:00' } });
    expect(msg.body).toContain('5 Oct 2026, 10:00');
    expect((sms.sendSms as ReturnType<typeof vi.fn>).mock.calls[0][2].secrets).toBeUndefined();
  });

  it('GET /messages masks OTP rows stored in clear by earlier versions', async () => {
    const { service, prisma } = setup();
    prisma.db.message.findMany.mockResolvedValue([
      { id: 'a', template: 'portal.otp', body: '482913 is your Demo login code. It expires in 5 minutes.' },
      { id: 'b', template: null, body: 'Your code 1234 for parking' },
    ]);
    prisma.db.message.count.mockResolvedValue(2);
    const user = { id: 'u', email: 'x', clinicId: 'c1', role: 'ADMIN', permissions: new Set<string>() } as const;
    const page = await service.list(user as never, { page: 1, pageSize: 25, skip: 0 } as ListMessagesQuery);
    expect(page.items[0].body).toBe('****** is your Demo login code. It expires in 5 minutes.');
    expect(page.items[1].body).toBe('Your code 1234 for parking');
  });
});
