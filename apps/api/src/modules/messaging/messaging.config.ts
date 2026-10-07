/**
 * Messaging + patient-portal configuration, read straight from the environment
 * (documented in `.env.example`). Kept out of `config/env.ts` so the messaging
 * and portal modules own their settings; values are read when the module is
 * instantiated, so tests can set `process.env` before the app boots.
 */
export interface MessagingConfig {
  smsProvider: 'twilio' | 'log';
  whatsappProvider: 'twilio' | 'log';
  emailProvider: 'smtp' | 'log';
  twilio: {
    accountSid: string;
    /**
     * Never logged. When empty, webhooks are rejected (403) unless
     * `insecureWebhooks` is on (development only).
     */
    authToken: string;
    /**
     * `TWILIO_WEBHOOK_INSECURE=1`: accept UNSIGNED webhooks from loopback when no
     * auth token is configured. Always false when `NODE_ENV=production`.
     */
    insecureWebhooks: boolean;
    smsFrom: string;
    whatsappFrom: string;
  };
  smtp: { url: string; from: string };
  /** Public base URL of the API (webhook signature URLs). No trailing slash. */
  publicApiUrl: string;
  publicWebUrl: string;
  /** Default country calling code (digits only) for local phone numbers. */
  defaultCountryCode: string;
  portal: {
    jwtExpiresIn: string;
    otpTtlMinutes: number;
    /** Wrong codes allowed per issued code. */
    otpMaxAttempts: number;
    /** OTP requests allowed per (clinic, phone) within `otpRequestWindowMinutes`. */
    otpRequestLimit: number;
    otpRequestWindowMinutes: number;
    /** Minimum gap between two OTP requests of the same (clinic, phone). */
    otpCooldownSeconds: number;
    /** Failed verifications per (clinic, phone), across codes, within `otpFailureWindowMinutes` before the phone is locked out. */
    otpFailureBudget: number;
    otpFailureWindowMinutes: number;
    /** request-otp responses and failed verifies are padded to at least this latency (no timing oracle). */
    otpMinLatencyMs: number;
  };
  /** Inbound `1` / `2` replies only apply to an outbound message with reply instructions sent within this many days. */
  replyWindowDays: number;
}

/** Explicit opt-in, never honoured in production. */
export function insecureWebhooksAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TWILIO_WEBHOOK_INSECURE?.trim() === '1' && env.NODE_ENV !== 'production';
}

export const MESSAGING_CONFIG = Symbol('MESSAGING_CONFIG');

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like `int` but 0 is allowed (e.g. disabling the latency padding). */
function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name, fallback).toLowerCase() as T;
  return allowed.includes(v) ? v : fallback;
}

export function loadMessagingConfig(): MessagingConfig {
  return {
    smsProvider: oneOf('MESSAGING_SMS_PROVIDER', ['twilio', 'log'] as const, 'log'),
    whatsappProvider: oneOf('MESSAGING_WHATSAPP_PROVIDER', ['twilio', 'log'] as const, 'log'),
    emailProvider: oneOf('MESSAGING_EMAIL_PROVIDER', ['smtp', 'log'] as const, 'log'),
    twilio: {
      accountSid: str('TWILIO_ACCOUNT_SID'),
      authToken: str('TWILIO_AUTH_TOKEN'),
      smsFrom: str('TWILIO_SMS_FROM'),
      whatsappFrom: str('TWILIO_WHATSAPP_FROM'),
      insecureWebhooks: insecureWebhooksAllowed(),
    },
    smtp: { url: str('SMTP_URL'), from: str('SMTP_FROM', 'CareFlow <no-reply@example.com>') },
    publicApiUrl: str('PUBLIC_API_URL', 'http://localhost:3000').replace(/\/+$/, ''),
    publicWebUrl: str('PUBLIC_WEB_URL', 'http://localhost:4200').replace(/\/+$/, ''),
    defaultCountryCode: str('MESSAGING_DEFAULT_COUNTRY_CODE', '966').replace(/\D/g, '') || '966',
    portal: {
      jwtExpiresIn: str('PORTAL_JWT_EXPIRES_IN', '12h'),
      otpTtlMinutes: int('PORTAL_OTP_TTL_MINUTES', 5),
      otpMaxAttempts: int('PORTAL_OTP_MAX_ATTEMPTS', 5),
      otpRequestLimit: int('PORTAL_OTP_REQUEST_LIMIT', 3),
      otpRequestWindowMinutes: int('PORTAL_OTP_REQUEST_WINDOW_MINUTES', 15),
      otpCooldownSeconds: nonNegativeInt('PORTAL_OTP_COOLDOWN_SECONDS', 60),
      otpFailureBudget: int('PORTAL_OTP_FAILURE_BUDGET', 10),
      otpFailureWindowMinutes: int('PORTAL_OTP_FAILURE_WINDOW_MINUTES', 60),
      otpMinLatencyMs: nonNegativeInt('PORTAL_OTP_MIN_LATENCY_MS', 400),
    },
    replyWindowDays: int('MESSAGING_REPLY_WINDOW_DAYS', 7),
  };
}
