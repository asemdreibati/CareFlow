import { Injectable, Logger } from '@nestjs/common';

/**
 * Email integration point.
 *
 * The MVP ships a logging stub: nothing leaves the process. To plug in a real
 * provider (SES, SendGrid, Postmark, SMTP…) replace the body of `send()` - or
 * provide a subclass in `NotificationsModule` with `{ provide: EmailSender, useClass: SesEmailSender }` -
 * keeping the same `send(to, subject, body)` signature. Callers must treat it as
 * best-effort: it never throws for delivery problems.
 */
@Injectable()
export class EmailSender {
  private readonly logger = new Logger(EmailSender.name);

  async send(to: string, subject: string, body: string): Promise<void> {
    this.logger.log(`[email stub] to=${to} subject="${subject}" bodyLength=${body.length}`);
  }
}
