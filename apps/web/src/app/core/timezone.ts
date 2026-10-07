/**
 * Clinic-timezone date math without a tz library. Every staff/portal screen renders and buckets
 * times in the clinic's IANA zone (`clinicTimeZone()`), never the browser's, so a receptionist
 * abroad or a laptop with a wrong TZ still sees the clinic's day. All helpers take an optional
 * explicit `tz`; when omitted they use the active clinic zone, falling back to the runtime zone.
 *
 * Calendar days are passed around as `YYYY-MM-DD` keys ("clinic-local dates"); instants as `Date`.
 */
import { clinicTimeZone } from './i18n/locale-registry';

export type DayKey = string;

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday, like `Date.getDay()`. */
  weekday: number;
}

/** The active clinic zone, or `undefined` (= runtime zone) when no clinic is known. */
export function activeTimeZone(): string | undefined {
  return clinicTimeZone() ?? undefined;
}

/** True for a zone name `Intl` accepts. */
export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = partsFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(key, f);
  }
  return f;
}
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock fields of `date` in `tz`. */
export function zonedParts(date: Date, tz: string | undefined = activeTimeZone()): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out['year']), month: Number(out['month']), day: Number(out['day']),
    hour: Number(out['hour']) % 24, minute: Number(out['minute']), second: Number(out['second']),
    weekday: WEEKDAY_INDEX[out['weekday']] ?? 0,
  };
}

/** Offset of `tz` from UTC at `date`, in milliseconds (Riyadh → +3h). */
export function tzOffsetMs(date: Date, tz: string | undefined = activeTimeZone()): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant whose wall clock in `tz` reads the given fields (month 1–12; overflow normalises like Date.UTC). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour = 0, minute = 0, tz: string | undefined = activeTimeZone()): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  const second = guess - tzOffsetMs(new Date(first), tz);
  return new Date(second);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Clinic-local calendar date of an instant: "2026-10-07". */
export function dayKey(date: Date, tz: string | undefined = activeTimeZone()): DayKey {
  const p = zonedParts(date, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function parseDayKey(key: DayKey): { year: number; month: number; day: number } {
  const [y, m, d] = key.slice(0, 10).split('-').map(Number);
  return { year: y, month: m, day: d };
}

export function isDayKey(v: unknown): v is DayKey {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Pure calendar arithmetic on keys (no zone involved). */
export function addDaysToKey(key: DayKey, n: number): DayKey {
  const { year, month, day } = parseDayKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 0 = Sunday. */
export function weekdayOfKey(key: DayKey): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** First day of the week containing `key` (Monday by default). */
export function startOfWeekKey(key: DayKey, weekStartsOn = 1): DayKey {
  const diff = (weekdayOfKey(key) - weekStartsOn + 7) % 7;
  return addDaysToKey(key, -diff);
}

/** The instant of clinic-local midnight starting `key`. */
export function startOfDayInZone(key: DayKey, tz: string | undefined = activeTimeZone()): Date {
  const { year, month, day } = parseDayKey(key);
  return zonedTimeToUtc(year, month, day, 0, 0, tz);
}

/** [start, end) instants of the clinic-local day `key`. */
export function dayBounds(key: DayKey, tz: string | undefined = activeTimeZone()): { from: Date; to: Date } {
  return { from: startOfDayInZone(key, tz), to: startOfDayInZone(addDaysToKey(key, 1), tz) };
}

/** Minutes since clinic-local midnight (0–1439). */
export function minutesOfDay(date: Date, tz: string | undefined = activeTimeZone()): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "HH:mm" of an instant in the clinic zone. */
export function zonedHHmm(date: Date, tz: string | undefined = activeTimeZone()): string {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A `Date` whose *runtime-local* fields equal the clinic wall clock of `date` — only for
 * handing to pattern formatters (date-fns `format`). Never send it to the API.
 */
export function toZonedWallClock(date: Date, tz: string | undefined = activeTimeZone()): Date {
  const p = zonedParts(date, tz);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, date.getMilliseconds());
}

/** Clinic-local "YYYY-MM-DDTHH:mm" for `<input type="datetime-local">`. */
export function toZonedInput(date: Date, tz: string | undefined = activeTimeZone()): string {
  const p = zonedParts(date, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parses a clinic-local "YYYY-MM-DDTHH:mm" (datetime-local value); `null` when empty or malformed. */
export function fromZonedInput(value: string | null | undefined, tz: string | undefined = activeTimeZone()): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec((value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const out = zonedTimeToUtc(y, mo, d, h, mi, tz);
  return Number.isNaN(out.getTime()) ? null : out;
}
