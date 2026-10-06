import { Global, Logger, Module } from '@nestjs/common';
import { WaitlistModule } from '../waitlist/waitlist.module.js';
import { InboundService } from './inbound.service.js';
import { loadMessagingConfig, MESSAGING_CONFIG, type MessagingConfig } from './messaging.config.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingListeners } from './messaging.listeners.js';
import { MessagingService } from './messaging.service.js';
import { LogProvider } from './providers/log.provider.js';
import { EMAIL_PROVIDER, SMS_PROVIDER, WHATSAPP_PROVIDER } from './providers/provider.js';
import { SmtpEmailProvider } from './providers/smtp.provider.js';
import { TwilioSmsProvider, TwilioWhatsAppProvider, type TwilioOptions } from './providers/twilio.provider.js';
import { TwilioWebhookController } from './twilio-webhook.controller.js';

const logger = new Logger('MessagingModule');

function twilioOptions(cfg: MessagingConfig): TwilioOptions | null {
  if (!cfg.twilio.accountSid || !cfg.twilio.authToken) return null;
  return { ...cfg.twilio, statusCallbackUrl: cfg.publicApiUrl ? `${cfg.publicApiUrl}/api/v1/webhooks/twilio/status` : undefined };
}

/**
 * Patient messaging: outbound SMS / WhatsApp / email through pluggable
 * providers (Twilio REST, SMTP, or a logging fallback), the `messages` log,
 * Twilio webhooks for replies and delivery status, and staff endpoints.
 * Imports the waitlist module for `AppointmentWriterService` (replies confirm
 * or cancel appointments with the standard events). Global so the scheduling
 * module's reminder worker can inject `MessagingService` without wiring.
 */
@Global()
@Module({
  imports: [WaitlistModule],
  controllers: [MessagingController, TwilioWebhookController],
  providers: [
    { provide: MESSAGING_CONFIG, useFactory: loadMessagingConfig },
    { provide: LogProvider, useFactory: () => new LogProvider() },
    {
      provide: SMS_PROVIDER,
      inject: [MESSAGING_CONFIG, LogProvider],
      useFactory: (cfg: MessagingConfig, log: LogProvider) => {
        const opts = cfg.smsProvider === 'twilio' ? twilioOptions(cfg) : null;
        if (cfg.smsProvider === 'twilio' && !opts) logger.warn('MESSAGING_SMS_PROVIDER=twilio but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are missing; using the log provider');
        return opts ? new TwilioSmsProvider(opts) : log;
      },
    },
    {
      provide: WHATSAPP_PROVIDER,
      inject: [MESSAGING_CONFIG, LogProvider],
      useFactory: (cfg: MessagingConfig, log: LogProvider) => {
        const opts = cfg.whatsappProvider === 'twilio' ? twilioOptions(cfg) : null;
        if (cfg.whatsappProvider === 'twilio' && !opts) logger.warn('MESSAGING_WHATSAPP_PROVIDER=twilio but Twilio credentials are missing; using the log provider');
        return opts ? new TwilioWhatsAppProvider(opts) : log;
      },
    },
    {
      provide: EMAIL_PROVIDER,
      inject: [MESSAGING_CONFIG, LogProvider],
      useFactory: (cfg: MessagingConfig, log: LogProvider) => {
        if (cfg.emailProvider === 'smtp' && cfg.smtp.url) return new SmtpEmailProvider(cfg.smtp.url, cfg.smtp.from);
        if (cfg.emailProvider === 'smtp') logger.warn('MESSAGING_EMAIL_PROVIDER=smtp but SMTP_URL is empty; using the log provider');
        return log;
      },
    },
    MessagingService,
    InboundService,
    MessagingListeners,
  ],
  exports: [MessagingService, InboundService, MESSAGING_CONFIG],
})
export class MessagingModule {}
