import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailProvider, ProviderResult } from './provider.js';

/**
 * SMTP delivery through nodemailer. `url` is a transport URL such as
 * `smtps://user:pass@smtp.example.com:465` (credentials are never logged).
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private transporter: Transporter | undefined;

  constructor(
    private readonly url: string,
    private readonly from: string,
  ) {}

  async sendEmail(to: string, subject: string, body: string): Promise<ProviderResult> {
    const info = await this.transport().sendMail({ from: this.from, to, subject, text: body });
    this.logger.log(`Email sent to ${to} (messageId=${info.messageId ?? 'n/a'})`);
    return { provider: this.name, providerMessageId: info.messageId ?? null };
  }

  private transport(): Transporter {
    if (!this.transporter) this.transporter = createTransport(this.url);
    return this.transporter;
  }
}
