/**
 * Pure helpers for the OTP step: resend countdown, digit normalisation (Arabic-Indic → Latin) and
 * simple phone/code validation. Kept free of Angular so they are trivially unit-tested.
 */
export const OTP_LENGTH = 6;
export const RESEND_SECONDS = 60;

export interface ResendState { remaining: number; canResend: boolean; label: string; }

/** Seconds left before the patient may request a new code (0 → can resend). */
export function resendCountdown(sentAt: number | null | undefined, now: number = Date.now(), seconds = RESEND_SECONDS): ResendState {
  if (!sentAt) return { remaining: 0, canResend: true, label: '0:00' };
  const remaining = Math.max(0, Math.ceil((sentAt + seconds * 1000 - now) / 1000));
  return { remaining, canResend: remaining === 0, label: formatSeconds(remaining) };
}

/** "1:00", "0:09". */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/** Maps Arabic-Indic / Persian digits to ASCII so phones and codes typed on Arabic keyboards validate. */
export function normalizeDigits(input: string): string {
  return Array.from(input ?? '')
    .map((ch) => {
      const a = ARABIC_INDIC.indexOf(ch);
      if (a >= 0) return String(a);
      const p = EXTENDED_ARABIC_INDIC.indexOf(ch);
      return p >= 0 ? String(p) : ch;
    })
    .join('');
}

/** Keeps only digits, capped to the OTP length. */
export function normalizeOtp(input: string): string {
  return normalizeDigits(input).replace(/\D/g, '').slice(0, OTP_LENGTH);
}
export function isCompleteOtp(code: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}

/** Trims, converts digits and strips spaces/dashes; keeps a leading "+". */
export function normalizePhone(input: string): string {
  const v = normalizeDigits((input ?? '').trim()).replace(/[\s\-().]/g, '');
  return v.startsWith('+') ? `+${v.slice(1).replace(/\D/g, '')}` : v.replace(/\D/g, '');
}
export function isValidPhone(phone: string): boolean {
  return /^\+?\d{8,15}$/.test(phone);
}
