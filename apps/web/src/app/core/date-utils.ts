import { addDays, addMinutes, differenceInYears, format, isSameDay, parseISO, startOfDay, startOfWeek } from 'date-fns';
import { activeDateFnsLocale } from './i18n/locale-registry';

export const toDate = (v: string | Date): Date => (typeof v === 'string' ? parseISO(v) : v);

/**
 * date-fns formatting in the active UI language (month/weekday names). Prefer
 * `LanguageService.formatDate/…` in components; this stays for pattern-based needs.
 */
export function fmtDate(v?: string | Date | null, pattern = 'dd MMM yyyy'): string {
  if (!v) return '—';
  try { return format(toDate(v), pattern, { locale: activeDateFnsLocale() }); } catch { return String(v); }
}
export const fmtDateTime = (v?: string | Date | null) => fmtDate(v, 'dd MMM yyyy, HH:mm');
export const fmtTime = (v?: string | Date | null) => fmtDate(v, 'HH:mm');
export const isoDate = (d: Date) => format(d, 'yyyy-MM-dd');
/** Local YYYY-MM-DDTHH:mm for <input type="datetime-local"> */
export const toLocalInput = (v?: string | Date | null) => (v ? format(toDate(v), "yyyy-MM-dd'T'HH:mm") : '');

/** Whole years since `dob`, or null when unknown/invalid. */
export function ageYears(dob?: string | null): number | null {
  if (!dob) return null;
  try { const n = differenceInYears(new Date(), parseISO(dob)); return Number.isNaN(n) ? null : n; } catch { return null; }
}
export function age(dob?: string | null): string {
  const n = ageYears(dob);
  return n === null ? '—' : `${n} y`;
}

/** [start, end) of the local day as ISO strings. */
export function dayRange(d: Date): { from: string; to: string } {
  const from = startOfDay(d);
  return { from: from.toISOString(), to: addDays(from, 1).toISOString() };
}
export function weekRange(d: Date): { from: string; to: string; start: Date } {
  const start = startOfWeek(d, { weekStartsOn: 1 });
  return { from: start.toISOString(), to: addDays(start, 7).toISOString(), start };
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface SlotView { startsAt: string; endsAt: string; label: string; disabled: boolean; }

/**
 * Pure helper for rendering availability slots as buttons: labels in local time,
 * and slots in the past (for today) are disabled.
 */
export function renderSlots(slots: { startsAt: string; endsAt: string }[], now: Date = new Date()): SlotView[] {
  return [...slots]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((s) => {
      const start = toDate(s.startsAt);
      return {
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        label: `${format(start, 'HH:mm')} – ${format(toDate(s.endsAt), 'HH:mm')}`,
        disabled: start.getTime() < now.getTime(),
      };
    });
}

/** Builds HH:mm options for time selects. */
export function timeOptions(stepMinutes = 15, from = 6, to = 22): string[] {
  const out: string[] = [];
  let d = new Date(2000, 0, 1, from, 0, 0);
  const end = new Date(2000, 0, 1, to, 0, 0);
  while (d <= end) { out.push(format(d, 'HH:mm')); d = addMinutes(d, stepMinutes); }
  return out;
}

export { isSameDay, addDays, startOfDay };
