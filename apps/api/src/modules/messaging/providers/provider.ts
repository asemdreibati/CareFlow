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

/**
 * Extra, non-delivered information about a send. Providers must only ever log
 * `redactedBody` (never `body`) when the message carries secrets.
 */
export interface SendOptions {
  /** Template key the body was rendered from, if any. */
  template?: string | null;
  /** The body with secret parameters masked: what may be logged or kept in a history. */
  redactedBody?: string;
  /** Secret template parameters (e.g. the OTP `code`). Never log these. */
  secrets?: Readonly<Record<string, string>>;
}

export interface SmsProvider {
  readonly name: string;
  sendSms(to: string, body: string, options?: SendOptions): Promise<ProviderResult>;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendWhatsApp(to: string, body: string, options?: SendOptions): Promise<ProviderResult>;
}

export interface EmailProvider {
  readonly name: string;
  sendEmail(to: string, subject: string, body: string, options?: SendOptions): Promise<ProviderResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
