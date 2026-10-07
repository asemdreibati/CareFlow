import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EmailProvider, ProviderResult, SendOptions, SmsProvider, WhatsAppProvider } from './provider.js';

export interface LoggedMessage {
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  to: string;
  subject?: string;
  /** What was "delivered", with secrets (OTP codes) masked. */
  body: string;
  template?: string | null;
  at: Date;
  id: string;
}

const OUTBOX_LIMIT = 500;

/** True only under the test runner: the plaintext test hook is dead code everywhere else. */
function testHooksEnabled(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Development fallback for every channel: prints the message to the server log
 * and keeps the last 500 in an in-memory outbox (`LogProvider.sent`) so tests
 * can read what would have been delivered. Secrets (OTP codes) are masked in
 * both the log line and the outbox; tests read the plain code through
 * `LogProvider.lastOtpForTests`, which only works when `NODE_ENV === 'test'`.
 */
export class LogProvider implements SmsProvider, WhatsAppProvider, EmailProvider {
  static readonly sent: LoggedMessage[] = [];
  /** address → latest OTP code. Only ever written when `NODE_ENV === 'test'`. */
  private static readonly otpsForTests = new Map<string, string>();
  readonly name = 'log';
  private readonly logger = new Logger(LogProvider.name);

  static clear(): void {
    LogProvider.sent.length = 0;
    LogProvider.otpsForTests.clear();
  }

  /** Latest logged message for an address (optionally on one channel). */
  static latest(to: string, channel?: LoggedMessage['channel']): LoggedMessage | undefined {
    for (let i = LogProvider.sent.length - 1; i >= 0; i--) {
      const m = LogProvider.sent[i];
      if (m.to === to && (!channel || m.channel === channel)) return m;
    }
    return undefined;
  }

  /** Test-only hook: the plain OTP code last sent to `to`. Always undefined unless `NODE_ENV === 'test'`. */
  static lastOtpForTests(to: string): string | undefined {
    if (!testHooksEnabled()) return undefined;
    return LogProvider.otpsForTests.get(to);
  }

  sendSms(to: string, body: string, options?: SendOptions): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'SMS', to, body }, options));
  }

  sendWhatsApp(to: string, body: string, options?: SendOptions): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'WHATSAPP', to, body }, options));
  }

  sendEmail(to: string, subject: string, body: string, options?: SendOptions): Promise<ProviderResult> {
    return Promise.resolve(this.record({ channel: 'EMAIL', to, subject, body }, options));
  }

  private record(m: Omit<LoggedMessage, 'at' | 'id' | 'template'>, options?: SendOptions): ProviderResult {
    const id = `log-${randomUUID()}`;
    const hasSecrets = !!options?.secrets && Object.keys(options.secrets).length > 0;
    // Never keep or print a body that carries secrets: fall back to a fully masked one.
    const body = hasSecrets ? (options?.redactedBody ?? '[redacted]') : m.body;
    if (hasSecrets && options?.secrets?.code && testHooksEnabled()) LogProvider.otpsForTests.set(m.to, options.secrets.code);
    LogProvider.sent.push({ ...m, body, template: options?.template ?? null, at: new Date(), id });
    if (LogProvider.sent.length > OUTBOX_LIMIT) LogProvider.sent.splice(0, LogProvider.sent.length - OUTBOX_LIMIT);
    this.logger.log(`[${m.channel}] to=${m.to}${m.subject ? ` subject="${m.subject}"` : ''} body="${body}"`);
    return { provider: this.name, providerMessageId: id };
  }
}
