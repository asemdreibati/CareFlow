/**
 * Recurrence expansion for appointment series (pure, no Nest/Prisma).
 *
 * A rule is expanded to concrete occurrences in the clinic timezone: the
 * calendar dates are computed with plain (timezone-independent) date arithmetic
 * and each date is then combined with the wall-clock `startTime` through
 * `zonedTimeToUtc`, so an occurrence keeps the same local time across DST
 * transitions (the UTC instant shifts, the clock on the wall does not).
 */
import { addMinutes, isValidDateString, weekdayOfDate, zonedTimeToUtc } from '../modules/appointments/scheduling.js';

export type RecurrenceFrequencyKey = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface RecurrenceRule {
  frequency: RecurrenceFrequencyKey;
  /** Every N days / weeks / months. Default 1. */
  interval?: number;
  /** WEEKLY only: 0 = Sunday … 6 = Saturday. Defaults to the weekday of `startsOn`. */
  byWeekday?: readonly number[];
  /** MONTHLY only: 1..31. Months without that day are skipped. Defaults to the day of `startsOn`. */
  byMonthDay?: number;
  /** First candidate date, "YYYY-MM-DD" (clinic wall-clock). */
  startsOn: string;
  /** "HH:mm" in the clinic timezone. */
  startTime: string;
  durationMinutes: number;
  /** Exactly one of `count` / `until` must be given. */
  count?: number;
  /** Last candidate date, inclusive, "YYYY-MM-DD". */
  until?: string;
}

export interface Occurrence {
  /** 0-based position in the series. */
  index: number;
  /** Calendar date in the clinic timezone, "YYYY-MM-DD". */
  date: string;
  startsAt: Date;
  endsAt: Date;
}

export const MAX_OCCURRENCES = 365;

/** Upper bound on consecutive periods examined, so a rule that never matches (e.g. day 31 every 12 months from February) terminates. */
const MAX_PERIODS = 2000;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Thrown by `expandRecurrence` for an invalid rule; callers map it to a 400. */
export class RecurrenceRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceRuleError';
  }
}

// ─────────────────────────────── calendar helpers ───────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Adds `n` calendar days to a "YYYY-MM-DD" date (UTC arithmetic, timezone independent). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Number of days in month `m` (1..12) of year `y`. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ─────────────────────────────── validation ───────────────────────────────

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Returns a human readable problem or null when the rule is well formed. */
export function validateRecurrenceRule(rule: RecurrenceRule): string | null {
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.frequency)) return 'frequency must be DAILY, WEEKLY or MONTHLY';
  const interval = rule.interval ?? 1;
  if (!isInt(interval) || interval < 1 || interval > 365) return 'interval must be an integer between 1 and 365';
  if (!isValidDateString(rule.startsOn)) return 'startsOn must be a valid YYYY-MM-DD date';
  if (!HHMM.test(rule.startTime)) return 'startTime must be HH:mm';
  if (!isInt(rule.durationMinutes) || rule.durationMinutes < 1) return 'durationMinutes must be a positive integer';
  const hasCount = rule.count !== undefined && rule.count !== null;
  const hasUntil = rule.until !== undefined && rule.until !== null;
  if (hasCount === hasUntil) return 'Provide exactly one of count or until';
  if (hasCount && (!isInt(rule.count) || rule.count < 1 || rule.count > MAX_OCCURRENCES)) {
    return `count must be an integer between 1 and ${MAX_OCCURRENCES}`;
  }
  if (hasUntil) {
    if (!isValidDateString(rule.until as string)) return 'until must be a valid YYYY-MM-DD date';
    if ((rule.until as string) < rule.startsOn) return 'until must not be before startsOn';
  }
  if (rule.byWeekday !== undefined) {
    if (rule.frequency !== 'WEEKLY') return 'byWeekday is only valid for WEEKLY rules';
    if (!Array.isArray(rule.byWeekday) || rule.byWeekday.some((w) => !isInt(w) || w < 0 || w > 6)) {
      return 'byWeekday must contain weekdays 0 (Sunday) to 6 (Saturday)';
    }
  }
  if (rule.byMonthDay !== undefined && rule.byMonthDay !== null) {
    if (rule.frequency !== 'MONTHLY') return 'byMonthDay is only valid for MONTHLY rules';
    if (!isInt(rule.byMonthDay) || rule.byMonthDay < 1 || rule.byMonthDay > 31) return 'byMonthDay must be between 1 and 31';
  }
  return null;
}

// ─────────────────────────────── date generation ───────────────────────────────

/**
 * Candidate dates of the rule in ascending order, BEFORE the `startsOn` / `until`
 * / `count` filters. Bounded by MAX_PERIODS so it always terminates.
 */
function* candidateDates(rule: RecurrenceRule): Generator<string> {
  const interval = rule.interval ?? 1;
  const [y0, m0, d0] = rule.startsOn.split('-').map(Number);

  switch (rule.frequency) {
    case 'DAILY': {
      for (let k = 0; k < MAX_PERIODS; k++) yield addDays(rule.startsOn, k * interval);
      return;
    }
    case 'WEEKLY': {
      const weekdays = rule.byWeekday && rule.byWeekday.length > 0 ? [...new Set(rule.byWeekday)].sort((a, b) => a - b) : [weekdayOfDate(rule.startsOn)];
      // Anchor on the Sunday of the week containing startsOn so byWeekday is honoured in the first week too.
      const weekStart = addDays(rule.startsOn, -weekdayOfDate(rule.startsOn));
      for (let w = 0; w < MAX_PERIODS; w++) {
        const base = addDays(weekStart, w * interval * 7);
        for (const wd of weekdays) yield addDays(base, wd);
      }
      return;
    }
    case 'MONTHLY': {
      const day = rule.byMonthDay ?? d0;
      for (let k = 0; k < MAX_PERIODS; k++) {
        const monthIndex = m0 - 1 + k * interval; // 0-based, may exceed 11
        const y = y0 + Math.floor(monthIndex / 12);
        const m = (monthIndex % 12) + 1;
        if (day <= daysInMonth(y, m)) yield formatDate(y, m, day);
      }
      return;
    }
  }
}

/**
 * Expands a rule into concrete occurrences (at most MAX_OCCURRENCES). Dates before
 * `startsOn` or after `until` are dropped; `count` limits the number of results.
 * Throws RecurrenceRuleError on an invalid rule or an unknown timezone.
 */
export function expandRecurrence(rule: RecurrenceRule, timeZone: string): Occurrence[] {
  const problem = validateRecurrenceRule(rule);
  if (problem) throw new RecurrenceRuleError(problem);
  const limit = rule.count ?? MAX_OCCURRENCES;
  const out: Occurrence[] = [];
  for (const date of candidateDates(rule)) {
    if (date < rule.startsOn) continue;
    if (rule.until && date > rule.until) break;
    const startsAt = zonedTimeToUtc(date, rule.startTime, timeZone);
    out.push({ index: out.length, date, startsAt, endsAt: addMinutes(startsAt, rule.durationMinutes) });
    if (out.length >= limit) break;
  }
  return out;
}
