import { addDays, addMinutes, differenceInYears, format, isSameDay, parseISO, startOfDay } from 'date-fns';
import { activeDateFnsLocale } from './i18n/locale-registry';
import {
  DayKey, activeTimeZone, addDaysToKey, dayBounds, dayKey, fromZonedInput, isDayKey, startOfDayInZone, startOfWeekKey,
  toZonedInput, toZonedWallClock, zonedHHmm,
} from './timezone';

export const toDate = (v: string | Date): Date => (typeof v === 'string' ? parseISO(v) : v);

/**
 * date-fns formatting in the active UI language (month/weekday names) and the clinic timezone.
 * Prefer `LanguageService.formatDate/…` in components; this stays for pattern-based needs.
 * A date-only string ("2026-10-07") is a calendar date and is formatted as-is.
 */
export function fmtDate(v?: string | Date | null, pattern = 'dd MMM yyyy', tz: string | undefined = activeTimeZone()): string {
  if (!v) return '—';
  try {
    const d = isDayKey(v) ? parseISO(v) : toZonedWallClock(toDate(v), tz);
    return format(d, pattern, { locale: activeDateFnsLocale() });
  } catch { return String(v); }
}
export const fmtDateTime = (v?: string | Date | null) => fmtDate(v, 'dd MMM yyyy, HH:mm');
export const fmtTime = (v?: string | Date | null) => fmtDate(v, 'HH:mm');
/** Clinic-local calendar date of an instant: "YYYY-MM-DD". */
export const isoDate = (d: Date, tz: string | undefined = activeTimeZone()): DayKey => dayKey(d, tz);
/** Clinic-local YYYY-MM-DDTHH:mm for <input type="datetime-local">. */
export const toLocalInput = (v?: string | Date | null, tz: string | undefined = activeTimeZone()) => (v ? toZonedInput(toDate(v), tz) : '');
/** ISO instant of a clinic-local datetime-local value, or `null` when empty/invalid. */
export function fromLocalInput(v: string | null | undefined, tz: string | undefined = activeTimeZone()): string | null {
  const d = fromZonedInput(v, tz);
  return d ? d.toISOString() : null;
}

/** Whole years since `dob`, or null when unknown/invalid. */
export function ageYears(dob?: string | null): number | null {
  if (!dob) return null;
  try { const n = differenceInYears(new Date(), parseISO(dob)); return Number.isNaN(n) ? null : n; } catch { return null; }
}
export function age(dob?: string | null): string {
  const n = ageYears(dob);
  return n === null ? '—' : `${n} y`;
}

/** [start, end) of the clinic-local day (an instant, or a "YYYY-MM-DD" key) as ISO strings. */
export function dayRange(d: Date | DayKey, tz: string | undefined = activeTimeZone()): { from: string; to: string } {
  const key = typeof d === 'string' ? d : dayKey(d, tz);
  const { from, to } = dayBounds(key, tz);
  return { from: from.toISOString(), to: to.toISOString() };
}
/** Clinic-local Monday-to-Monday week containing `d`; `start` is the Monday's midnight instant, `startKey` its date. */
export function weekRange(d: Date | DayKey, tz: string | undefined = activeTimeZone()): { from: string; to: string; start: Date; startKey: DayKey } {
  const startKey = startOfWeekKey(typeof d === 'string' ? d : dayKey(d, tz), 1);
  const start = startOfDayInZone(startKey, tz);
  return { from: start.toISOString(), to: startOfDayInZone(addDaysToKey(startKey, 7), tz).toISOString(), start, startKey };
}
/**
 * Inclusive clinic-local date filter → ISO bounds (for APIs comparing `gte from` / `lte to`):
 * `from` = start of the first day, `to` = last millisecond of the last day. Empty inputs stay undefined.
 */
export function dateFilterRange(fromKey: string | null | undefined, toKey: string | null | undefined, tz: string | undefined = activeTimeZone()): { from?: string; to?: string } {
  return {
    from: isDayKey(fromKey) ? startOfDayInZone(fromKey, tz).toISOString() : undefined,
    to: isDayKey(toKey) ? new Date(dayBounds(toKey, tz).to.getTime() - 1).toISOString() : undefined,
  };
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface SlotView { startsAt: string; endsAt: string; label: string; disabled: boolean; }

/**
 * Pure helper for rendering availability slots as buttons: labels in clinic time,
 * and slots in the past (for today) are disabled.
 */
export function renderSlots(slots: { startsAt: string; endsAt: string }[], now: Date = new Date(), tz: string | undefined = activeTimeZone()): SlotView[] {
  return [...slots]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => {
      const start = toDate(s.startsAt);
      return {
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        label: `${zonedHHmm(start, tz)} – ${zonedHHmm(toDate(s.endsAt), tz)}`,
        disabled: start.getTime() < now.getTime(),
      };
    });
}

/** Builds HH:mm options for time selects (wall-clock strings, zone-independent). */
export function timeOptions(stepMinutes = 15, from = 6, to = 22): string[] {
  const out: string[] = [];
  let d = new Date(2000, 0, 1, from, 0, 0);
  const end = new Date(2000, 0, 1, to, 0, 0);
  while (d <= end) { out.push(format(d, 'HH:mm')); d = addMinutes(d, stepMinutes); }
  return out;
}

export { isSameDay, addDays, startOfDay };
