import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EmailProvider, ProviderResult, SmsProvider, WhatsAppProvider } from './provider.js';

export interface LoggedMessage {
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  to: string;
  subject?: string;
  body: string;
  at: Date;
  id: string;
}

const OUTBOX_LIMIT = 500;

/**
 * Development fallback for every channel: prints the message to the server log
 * and keeps the last 500 in an in-memory outbox (`LogProvider.sent`) so tests
 * can read what would have been delivered (e.g. the OTP code, which is stored
 * hashed and never returned by the API).
 */
export class LogProvider implements SmsProvider, WhatsAppProvider, EmailProvider {
  static readonly sent: LoggedMessage[] = [];
  readonly name = 'log';
  private readonly logger = new Logger(LogProvider.name);

  static clear(): void {
    LogProvider.sent.length = 0;
  }

  /** Latest logged message for an address (optionally on one channel). */
  static latest(to: string, channel?: LoggedMessage['channel']): LoggedMessage | undefined {
    for (let i = LogProvider.sent.length - 1; i >= 0; i--) {
      const m = LogProvider.sent[i];
      if (m.to === to && (!channel || m.channel === channel)) return m;
    }
    return undefined;
  }

  sendSms(to: string, body: string): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'SMS', to, body }));
  }

  sendWhatsApp(to: string, body: string): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'WHATSAPP', to, body }));
  }

  sendEmail(to: string, subject: string, body: string): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'EMAIL', to, subject, body }));
  }

  private record(m: Omit<LoggedMessage, 'at' | 'id'>): ProviderResult {
    const id = `log-${randomUUID()}`;
    LogProvider.sent.push({ ...m, at: new Date(), id });
    if (LogProvider.sent.length > OUTBOX_LIMIT) LogProvider.sent.splice(0, LogProvider.sent.length - OUTBOX_LIMIT);
    this.logger.log(`[${m.channel}] to=${m.to}${m.subject ? ` subject="${m.subject}"` : ''} body="${m.body}"`);
    return { provider: this.name, providerMessageId: id };
  }
}
