/**
 * Provider interfaces. Implementations never throw for "soft" failures without
 * a message: the messaging service records whatever error they raise on the
 * `messages` row and marks it FAILED.
 */
export interface ProviderResult {
  /** Provider name stored on the message row (twilio, smtp, log). */
  provider: string;
  providerMessageId: string | null;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(to: string, body: string): Promise<ProviderResult>;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendWhatsApp(to: string, body: string): Promise<ProviderResult>;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(to: string, subject: string, body: string): Promise<ProviderResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
