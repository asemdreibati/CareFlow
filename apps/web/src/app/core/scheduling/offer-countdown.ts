/**
 * Pure helper for the waitlist offer countdown: time remaining until `offerExpiresAt`.
 */
export interface Countdown { ms: number; expired: boolean; label: string; urgent: boolean; }

export function offerCountdown(expiresAt: string | Date | null | undefined, now: Date | number = Date.now()): Countdown {
  if (!expiresAt) return { ms: 0, expired: true, label: '—', urgent: false };
  const end = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt.getTime();
  const n = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(end)) return { ms: 0, expired: true, label: '—', urgent: false };
  const ms = end - n;
  if (ms <= 0) return { ms: 0, expired: true, label: 'Expired', urgent: false };
  return { ms, expired: false, label: formatRemaining(ms), urgent: ms < 60 * 60 * 1000 };
}

export interface DurationUnits { d: string; h: string; m: string; s: string; }
const EN_UNITS: DurationUnits = { d: 'd', h: 'h', m: 'm', s: 's' };

/** "1d 2h", "3h 05m", "12m 30s", "45s" (unit suffixes are overridable for other languages). */
export function formatRemaining(ms: number, units: DurationUnits = EN_UNITS): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (v: number) => String(v).padStart(2, '0');
  if (d > 0) return `${d}${units.d} ${h}${units.h}`;
  if (h > 0) return `${h}${units.h} ${two(m)}${units.m}`;
  if (m > 0) return `${m}${units.m} ${two(s)}${units.s}`;
  return `${s}${units.s}`;
}
