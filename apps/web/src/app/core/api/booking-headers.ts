import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

/**
 * Pure helpers for the booking-robustness contract (docs/SCHEDULING.md §3):
 * - `Idempotency-Key` on POST /appointments (one uuid per dialog open, regenerated after success);
 * - `If-Match: <version>` on PATCH /appointments/:id and POST /appointments/:id/status when the
 *   appointment carries a `version`.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // RFC-4122 v4 fallback for environments without crypto.randomUUID.
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface BookingHeaderOptions { idempotencyKey?: string | null; version?: number | null; }

/** Plain header map (easy to assert in tests); use `bookingHttpHeaders` for HttpClient. */
export function bookingHeaderMap(opts: BookingHeaderOptions = {}): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.idempotencyKey) h['Idempotency-Key'] = opts.idempotencyKey;
  if (typeof opts.version === 'number' && Number.isFinite(opts.version)) h['If-Match'] = String(opts.version);
  return h;
}
export function bookingHttpHeaders(opts: BookingHeaderOptions = {}): HttpHeaders {
  return new HttpHeaders(bookingHeaderMap(opts));
}

/** True for the optimistic-locking 409 ("Appointment was modified by someone else (version N)"). */
export function isVersionConflict(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse) || err.status !== 409) return false;
  const body = err.error as { message?: string | string[] } | string | null | undefined;
  const msg = typeof body === 'string' ? body : Array.isArray(body?.message) ? body!.message.join(' ') : body?.message ?? '';
  return /modified by someone else|version/i.test(msg);
}

/** True for the resource-busy 409 (`Resource "<name>" is not available`). */
export function isResourceConflict(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse) || err.status !== 409) return false;
  const body = err.error as { message?: string | string[] } | string | null | undefined;
  const msg = typeof body === 'string' ? body : Array.isArray(body?.message) ? body!.message.join(' ') : body?.message ?? '';
  return /resource/i.test(msg);
}
