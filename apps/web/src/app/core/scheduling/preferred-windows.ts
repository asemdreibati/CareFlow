import { PreferredWindow } from '../models';

/**
 * Pure model for the preferred-windows editor (weekday + from/to rows) used by the
 * Find-a-slot panel and the waitlist dialog. Rows are kept immutable; every helper returns a new list.
 */
export const DEFAULT_WINDOW: PreferredWindow = { weekday: 1, startTime: '09:00', endTime: '12:00' };

export function addWindow(rows: PreferredWindow[], row: Partial<PreferredWindow> = {}): PreferredWindow[] {
  const last = rows[rows.length - 1];
  const base: PreferredWindow = last ? { ...last, weekday: (last.weekday + 1) % 7 } : DEFAULT_WINDOW;
  return [...rows, { ...base, ...row }];
}
export function updateWindow(rows: PreferredWindow[], index: number, patch: Partial<PreferredWindow>): PreferredWindow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch, weekday: Number(patch.weekday ?? r.weekday) } : r));
}
export function removeWindow(rows: PreferredWindow[], index: number): PreferredWindow[] {
  return rows.filter((_, i) => i !== index);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Structured validation problem (translate with `errors.windows.<key>` and the params). */
export interface WindowsProblem { key: 'invalidWeekday' | 'timeFormat' | 'endAfterStart'; params: Record<string, unknown>; }

/** First invalid row as a translatable problem, or null when all rows are valid. */
export function windowsProblem(rows: PreferredWindow[], weekdayNames: string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']): WindowsProblem | null {
  for (const r of rows) {
    const day = weekdayNames[r.weekday] ?? `weekday ${r.weekday}`;
    if (!Number.isInteger(r.weekday) || r.weekday < 0 || r.weekday > 6) return { key: 'invalidWeekday', params: { weekday: r.weekday } };
    if (!TIME_RE.test(r.startTime) || !TIME_RE.test(r.endTime)) return { key: 'timeFormat', params: { day } };
    if (r.startTime >= r.endTime) return { key: 'endAfterStart', params: { day } };
  }
  return null;
}

const PROBLEM_TEXT: Record<WindowsProblem['key'], (p: Record<string, unknown>) => string> = {
  invalidWeekday: (p) => `Invalid weekday (${p['weekday']}).`,
  timeFormat: (p) => `${p['day']}: times must be HH:mm.`,
  endAfterStart: (p) => `${p['day']}: end time must be after start time.`,
};

/** Returns a human-readable (English) problem for the first invalid row, or null when all rows are valid. */
export function validateWindows(rows: PreferredWindow[], weekdayNames?: string[]): string | null {
  const p = windowsProblem(rows, weekdayNames);
  return p ? PROBLEM_TEXT[p.key](p.params) : null;
}

/** Normalises for the API: drops invalid rows, sorts by weekday/start, merges duplicate rows. */
export function normalizeWindows(rows: PreferredWindow[]): PreferredWindow[] {
  const valid = rows.filter((r) => validateWindows([r]) === null);
  const seen = new Set<string>();
  return valid
    .map((r) => ({ weekday: Number(r.weekday), startTime: r.startTime, endTime: r.endTime }))
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))
    .filter((r) => { const k = `${r.weekday}|${r.startTime}|${r.endTime}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Short summary such as "Mon 09:00–12:00, Wed 14:00–17:00" (or "Any time" when empty). */
export function describeWindows(rows: PreferredWindow[], weekdayNames: string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']): string {
  if (!rows.length) return 'Any time';
  return rows.map((r) => `${weekdayNames[r.weekday] ?? r.weekday} ${r.startTime}–${r.endTime}`).join(', ');
}

/** Parses the API representation (array, JSON string, or null) defensively. */
export function parseWindows(raw: unknown): PreferredWindow[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return normalizeWindows(v.filter((x): x is PreferredWindow => !!x && typeof x === 'object' && 'weekday' in x && 'startTime' in x && 'endTime' in x));
}
