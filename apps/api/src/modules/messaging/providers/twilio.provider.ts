import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderResult, SmsProvider, WhatsAppProvider } from './provider.js';

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** E.164 sender for SMS (or a messaging service sender). */
  smsFrom: string;
  /** `whatsapp:+1…` sender. */
  whatsappFrom: string;
  /** Status callback URL (optional). */
  statusCallbackUrl?: string;
}

/**
 * Computes Twilio's request signature: Base64(HMAC-SHA1(authToken, url + sorted
 * POST params concatenated as key+value)). Pure, exported for tests and the
 * webhook controller.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      const v = params[key];
      const values = Array.isArray(v) ? v.map(String) : [v === null || v === undefined ? '' : String(v)];
      return acc + values.map((x) => key + x).join('');
    }, url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, unknown>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Shared REST call: `POST /Accounts/{sid}/Messages.json`, form encoded, Basic auth. The token is never logged. */
async function postMessage(opts: TwilioOptions, logger: Logger, form: Record<string, string>): Promise<ProviderResult> {
  const url = `${TWILIO_API}/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`;
  const body = new URLSearchParams(form);
  if (opts.statusCallbackUrl) body.set('StatusCallback', opts.statusCallbackUrl);
  const auth = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  let json: { sid?: string; status?: string; message?: string; code?: number } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Non-JSON error body: fall through to the status check.
  }
  if (!res.ok) {
    const detail = json.message ? ` ${json.message}` : '';
    logger.warn(`Twilio rejected message to ${form.To}: HTTP ${res.status}${json.code ? ` code ${json.code}` : ''}${detail}`);
    throw new Error(`Twilio HTTP ${res.status}${json.code ? ` (${json.code})` : ''}:${detail || ' request failed'}`);
  }
  return { provider: 'twilio', providerMessageId: json.sid ?? null };
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioSmsProvider.name);

  constructor(private readonly opts: TwilioOptions) {}

  sendSms(to: string, body: string): Promise<ProviderResult> {
    if (!this.opts.smsFrom) return Promise.reject(new Error('TWILIO_SMS_FROM is not configured'));
    return postMessage(this.opts, this.logger, { To: to, From: this.opts.smsFrom, Body: body });
  }
}

export class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger(TwilioWhatsAppProvider.name);

  constructor(private readonly opts: TwilioOptions) {}

  sendWhatsApp(to: string, body: string): Promise<ProviderResult> {
    if (!this.opts.whatsappFrom) return Promise.reject(new Error('TWILIO_WHATSAPP_FROM is not configured'));
    const from = this.opts.whatsappFrom.startsWith('whatsapp:') ? this.opts.whatsappFrom : `whatsapp:${this.opts.whatsappFrom}`;
    const dest = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    return postMessage(this.opts, this.logger, { To: dest, From: from, Body: body });
  }
}
