/**
 * Pure scheduling logic for appointments: timezone-aware slot generation,
 * availability / overlap checks and the status transition table.
 *
 * This file has NO Nest or Prisma dependencies so it can be unit tested in
 * isolation and reused by other modules (e.g. the web client could share it).
 */

export type AppointmentStatus =
  | 'SCHEDULED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'NO_SHOW';

export interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

/** A weekly recurring working block. weekday: 0 = Sunday … 6 = Saturday; times are "HH:mm" in the clinic timezone. */
export interface AvailabilityBlock {
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
}

export interface Slot {
  startsAt: Date;
  endsAt: Date;
}

export const DEFAULT_SLOT_MINUTES = 30;

// ───────────────────────────── status transitions ─────────────────────────────

/** Allowed status transitions (see docs/API.md). Anything not listed is rejected. */
export const STATUS_TRANSITIONS: Readonly<Record<AppointmentStatus, readonly AppointmentStatus[]>> = {
  SCHEDULED: ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** Statuses that do not occupy the doctor's time (mirrors the DB exclusion constraint's WHERE clause). */
export const INACTIVE_STATUSES: readonly AppointmentStatus[] = ['CANCELLED', 'NO_SHOW'];

/** Statuses after which an appointment can no longer be edited or rescheduled. */
export const FINAL_STATUSES: readonly AppointmentStatus[] = ['COMPLETED', 'CANCELLED'];

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isActiveStatus(status: AppointmentStatus): boolean {
  return !INACTIVE_STATUSES.includes(status);
}

export function isFinalStatus(status: AppointmentStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

// ─────────────────────────────── range helpers ───────────────────────────────

/** Half-open interval intersection: [a.start, a.end) ∩ [b.start, b.end) ≠ ∅. */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

export function overlapsAny(range: TimeRange, others: readonly TimeRange[]): boolean {
  return others.some((o) => rangesOverlap(range, o));
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function durationMinutes(range: TimeRange): number {
  return (range.endsAt.getTime() - range.startsAt.getTime()) / 60_000;
}

/** "HH:mm" → minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** minutes since midnight → "HH:mm" (values ≥ 1440 wrap, which only matters for display). */
export function minutesToHhmm(minutes: number): string {
  const total = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─────────────────────────────── timezone helpers ───────────────────────────────

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** "HH:mm" wall-clock time */
  hhmm: string;
  /** "YYYY-MM-DD" wall-clock date */
  date: string;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Breaks an instant into wall-clock parts for the given IANA timezone. Throws on an unknown timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour')) % 24; // some engines return "24" for midnight
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const weekday = WEEKDAYS.indexOf(get('weekday'));
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** Offset (ms) of `timeZone` from UTC at the given instant. Positive east of Greenwich. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision of `date` since the formatted parts have none.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock date + time in `timeZone` to a UTC instant.
 * Handles DST by iterating on the offset; for a non-existent local time (spring
 * forward gap) the result is shifted forward by the gap, for an ambiguous time the
 * earlier instant is used.
 */
export function zonedTimeToUtc(date: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  // Candidate instants: the wall time interpreted with the offsets in force just
  // before and after it (covers both sides of a DST boundary).
  const first = wall - tzOffsetMs(new Date(wall), timeZone);
  const second = wall - tzOffsetMs(new Date(first), timeZone);
  const third = wall - tzOffsetMs(new Date(second), timeZone);
  const candidates = [...new Set([first, second, third])];
  const roundTrips = candidates.filter((c) => tzOffsetMs(new Date(c), timeZone) + c === wall).sort((a, b) => a - b);
  if (roundTrips.length > 0) return new Date(roundTrips[0]); // unique, or the earlier of an ambiguous pair
  return new Date(Math.max(...candidates)); // non-existent wall time (gap): shift forward
}

/** Calendar weekday (0 = Sunday) of a "YYYY-MM-DD" date. Independent of timezone. */
export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidDateString(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Start (inclusive) and end (exclusive) instants of a calendar day in `timeZone`. */
export function dayBounds(date: string, timeZone: string): TimeRange {
  return { startsAt: zonedTimeToUtc(date, '00:00', timeZone), endsAt: zonedTimeToUtc(nextDate(date), '00:00', timeZone) };
}

// ─────────────────────────────── availability ───────────────────────────────

export function blocksForWeekday(blocks: readonly AvailabilityBlock[], weekday: number): AvailabilityBlock[] {
  return blocks.filter((b) => b.weekday === weekday).sort((a, b) => hhmmToMinutes(a.startTime) - hhmmToMinutes(b.startTime));
}

/**
 * Default appointment length: the slot size of the doctor's availability on
 * that weekday (the block containing the start time wins, else the first block),
 * falling back to 30 minutes.
 */
export function defaultDurationMinutes(blocks: readonly AvailabilityBlock[], startsAt: Date, timeZone: string): number {
  const p = zonedParts(startsAt, timeZone);
  const dayBlocks = blocksForWeekday(blocks, p.weekday);
  if (dayBlocks.length === 0) return DEFAULT_SLOT_MINUTES;
  const startMin = p.hour * 60 + p.minute;
  const containing = dayBlocks.find((b) => hhmmToMinutes(b.startTime) <= startMin && startMin < hhmmToMinutes(b.endTime));
  return (containing ?? dayBlocks[0]).slotMinutes || DEFAULT_SLOT_MINUTES;
}

/**
 * True when the whole range fits inside one availability block of the weekday on
 * which it starts (wall clock in `timeZone`). Both ends are compared on the wall
 * clock, so a range crossing a DST change inside the day is judged by the clock
 * on the wall (spring forward: 01:30 + 60 min ends at 03:30; fall back: 00:00 +
 * 210 min ends at 02:30). A range whose wall-clock end falls on another date is
 * rejected, except an end at exactly midnight (a block ending at 24:00).
 */
export function isWithinAvailability(range: TimeRange, blocks: readonly AvailabilityBlock[], timeZone: string): boolean {
  if (range.endsAt.getTime() <= range.startsAt.getTime()) return false;
  const p = zonedParts(range.startsAt, timeZone);
  const e = zonedParts(range.endsAt, timeZone);
  const startMin = p.hour * 60 + p.minute + p.second / 60;
  let endMin = e.hour * 60 + e.minute + e.second / 60;
  if (e.date !== p.date) {
    // Only "24:00" of the start date is acceptable as an end on the next date.
    if (endMin !== 0 || e.date !== nextDate(p.date)) return false;
    endMin = 1440;
  }
  // Fall back can make the wall-clock end precede the start (01:30 EDT + 45 min = 01:15 EST).
  const lo = Math.min(startMin, endMin);
  const hi = Math.max(startMin, endMin);
  const realMinutes = durationMinutes(range);
  return blocksForWeekday(blocks, p.weekday).some((b) => {
    const bStart = hhmmToMinutes(b.startTime);
    const bEnd = hhmmToMinutes(b.endTime);
    if (bStart > lo || hi > bEnd) return false;
    if (endMin > startMin) return true;
    // Wall clock went backwards: the elapsed time must still fit in the block's real length.
    const blockEnd = bEnd >= 1440 ? zonedTimeToUtc(nextDate(p.date), '00:00', timeZone) : zonedTimeToUtc(p.date, b.endTime, timeZone);
    return realMinutes <= (blockEnd.getTime() - zonedTimeToUtc(p.date, b.startTime, timeZone).getTime()) / 60_000;
  });
}

/** "YYYY-MM-DD" of the following calendar day. */
function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

export interface GenerateSlotsInput {
  /** "YYYY-MM-DD" in the clinic timezone. */
  date: string;
  timeZone: string;
  blocks: readonly AvailabilityBlock[];
  /** Overrides the block's slotMinutes (both step and length). */
  durationMinutes?: number;
  /** Ranges that make a slot unavailable: time off and active appointments. */
  busy?: readonly TimeRange[];
  /** Slots starting before this instant are dropped. Defaults to the current time. */
  now?: Date;
}

/**
 * Computes bookable slots for one day: step through every availability block of
 * the weekday, drop slots that intersect a busy range or start in the past.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const now = input.now ?? new Date();
  const busy = input.busy ?? [];
  const slots: Slot[] = [];
  for (const block of blocksForWeekday(input.blocks, weekdayOfDate(input.date))) {
    const step = input.durationMinutes ?? (block.slotMinutes || DEFAULT_SLOT_MINUTES);
    if (step <= 0) continue;
    const blockStart = hhmmToMinutes(block.startTime);
    const blockEnd = hhmmToMinutes(block.endTime);
    for (let m = blockStart; m + step <= blockEnd; m += step) {
      const startsAt = zonedTimeToUtc(input.date, minutesToHhmm(m), input.timeZone);
      const endsAt = zonedTimeToUtc(input.date, minutesToHhmm(m + step), input.timeZone);
      if (m + step === 1440) {
        // "24:00" wraps to 00:00 of the same date; use the real end-of-day instant instead.
        slots.push({ startsAt, endsAt: dayBounds(input.date, input.timeZone).endsAt });
        continue;
      }
      slots.push({ startsAt, endsAt });
    }
  }
  return slots
    .filter((s) => s.endsAt.getTime() > s.startsAt.getTime())
    .filter((s) => s.startsAt.getTime() >= now.getTime())
    .filter((s) => !overlapsAny(s, busy))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Validates a booking against the doctor's schedule. Returns a human readable
 * reason or null when the range is bookable. Overlap with other appointments is
 * reported separately so callers can map it to 409.
 */
export function findScheduleProblem(
  range: TimeRange,
  blocks: readonly AvailabilityBlock[],
  timeOff: readonly TimeRange[],
  timeZone: string,
): string | null {
  if (range.endsAt.getTime() <= range.startsAt.getTime()) return 'endsAt must be after startsAt';
  if (!isWithinAvailability(range, blocks, timeZone)) return "The requested time is outside the doctor's availability";
  if (overlapsAny(range, timeOff)) return 'The doctor is on time off during the requested time';
  return null;
}
