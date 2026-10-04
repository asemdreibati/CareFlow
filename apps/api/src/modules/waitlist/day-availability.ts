/**
 * Glue between the doctor's weekly availability (wall-clock blocks) and the
 * epoch-ms interval algebra of the scheduling engine. Pure.
 */
import type { Interval } from '../../scheduling-engine/intervals.js';
import { blocksForWeekday, dayBounds, hhmmToMinutes, minutesToHhmm, weekdayOfDate, zonedParts, zonedTimeToUtc, type AvailabilityBlock, type TimeRange } from '../appointments/scheduling.js';

export function toInterval(r: TimeRange): Interval {
  return { start: r.startsAt.getTime(), end: r.endsAt.getTime() };
}

export function toRange(i: Interval): TimeRange {
  return { startsAt: new Date(i.start), endsAt: new Date(i.end) };
}

/** The doctor's availability blocks of one calendar day as epoch-ms intervals. */
export function availabilityIntervals(blocks: readonly AvailabilityBlock[], date: string, timeZone: string): Interval[] {
  const out: Interval[] = [];
  for (const b of blocksForWeekday(blocks, weekdayOfDate(date))) {
    const start = zonedTimeToUtc(date, b.startTime, timeZone).getTime();
    const endMin = hhmmToMinutes(b.endTime);
    const end = endMin >= 1440 ? dayBounds(date, timeZone).endsAt.getTime() : zonedTimeToUtc(date, minutesToHhmm(endMin), timeZone).getTime();
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Slot grid (minutes) of the doctor on a calendar day: the first block's slot length, else 30. */
export function slotStepMinutes(blocks: readonly AvailabilityBlock[], date: string): number {
  return blocksForWeekday(blocks, weekdayOfDate(date))[0]?.slotMinutes || 30;
}

/** Calendar dates (clinic wall clock) touched by [from, to), capped at `maxDays`. */
export function daysBetween(from: Date, to: Date, timeZone: string, maxDays = 70): string[] {
  const out: string[] = [];
  if (to <= from) return out;
  let date = zonedParts(from, timeZone).date;
  const last = zonedParts(new Date(to.getTime() - 1), timeZone).date;
  for (let i = 0; i < maxDays && date <= last; i++) {
    out.push(date);
    date = zonedParts(new Date(dayBounds(date, timeZone).endsAt.getTime() + 1), timeZone).date;
  }
  return out;
}
