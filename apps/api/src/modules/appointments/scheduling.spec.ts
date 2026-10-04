import { describe, expect, it } from 'vitest';
import {
  canTransition,
  dayBounds,
  defaultDurationMinutes,
  findScheduleProblem,
  generateSlots,
  hhmmToMinutes,
  isActiveStatus,
  isFinalStatus,
  isValidDateString,
  isWithinAvailability,
  minutesToHhmm,
  rangesOverlap,
  STATUS_TRANSITIONS,
  tzOffsetMs,
  weekdayOfDate,
  zonedParts,
  zonedTimeToUtc,
  type AppointmentStatus,
  type AvailabilityBlock,
} from './scheduling.js';

const RIYADH = 'Asia/Riyadh'; // UTC+3, no DST
const NY = 'America/New_York'; // DST
const r = (s: string, e: string) => ({ startsAt: new Date(s), endsAt: new Date(e) });

describe('status transitions', () => {
  const all: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

  it('matches the contract table exactly', () => {
    expect(STATUS_TRANSITIONS.SCHEDULED).toEqual(['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW']);
    expect(STATUS_TRANSITIONS.CONFIRMED).toEqual(['CHECKED_IN', 'CANCELLED', 'NO_SHOW']);
    expect(STATUS_TRANSITIONS.CHECKED_IN).toEqual(['IN_PROGRESS', 'CANCELLED']);
    expect(STATUS_TRANSITIONS.IN_PROGRESS).toEqual(['COMPLETED']);
    expect(STATUS_TRANSITIONS.COMPLETED).toEqual([]);
    expect(STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    expect(STATUS_TRANSITIONS.NO_SHOW).toEqual([]);
  });

  it('canTransition accepts listed transitions and rejects the rest', () => {
    expect(canTransition('SCHEDULED', 'CONFIRMED')).toBe(true);
    expect(canTransition('CHECKED_IN', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransition('SCHEDULED', 'COMPLETED')).toBe(false);
    expect(canTransition('SCHEDULED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('CONFIRMED', 'SCHEDULED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'CANCELLED')).toBe(false);
    for (const to of all) {
      expect(canTransition('COMPLETED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
      expect(canTransition('NO_SHOW', to)).toBe(false);
    }
    // Self transitions are never allowed.
    for (const s of all) expect(canTransition(s, s)).toBe(false);
  });

  it('classifies active and final statuses', () => {
    expect(isActiveStatus('SCHEDULED')).toBe(true);
    expect(isActiveStatus('COMPLETED')).toBe(true);
    expect(isActiveStatus('CANCELLED')).toBe(false);
    expect(isActiveStatus('NO_SHOW')).toBe(false);
    expect(isFinalStatus('COMPLETED')).toBe(true);
    expect(isFinalStatus('CANCELLED')).toBe(true);
    expect(isFinalStatus('NO_SHOW')).toBe(false);
    expect(isFinalStatus('SCHEDULED')).toBe(false);
  });
});

describe('range helpers', () => {
  it('rangesOverlap uses half-open intervals', () => {
    const a = r('2026-10-12T07:00:00Z', '2026-10-12T07:30:00Z');
    expect(rangesOverlap(a, r('2026-10-12T07:30:00Z', '2026-10-12T08:00:00Z'))).toBe(false); // touching
    expect(rangesOverlap(a, r('2026-10-12T06:30:00Z', '2026-10-12T07:00:00Z'))).toBe(false); // touching
    expect(rangesOverlap(a, r('2026-10-12T07:15:00Z', '2026-10-12T07:45:00Z'))).toBe(true);
    expect(rangesOverlap(a, r('2026-10-12T06:45:00Z', '2026-10-12T07:15:00Z'))).toBe(true);
    expect(rangesOverlap(a, r('2026-10-12T06:00:00Z', '2026-10-12T09:00:00Z'))).toBe(true); // containing
    expect(rangesOverlap(a, r('2026-10-12T07:10:00Z', '2026-10-12T07:20:00Z'))).toBe(true); // contained
    expect(rangesOverlap(a, a)).toBe(true);
  });

  it('converts HH:mm both ways', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('09:30')).toBe(570);
    expect(hhmmToMinutes('23:59')).toBe(1439);
    expect(minutesToHhmm(570)).toBe('09:30');
    expect(minutesToHhmm(0)).toBe('00:00');
    expect(minutesToHhmm(1440)).toBe('00:00');
  });

  it('validates date strings', () => {
    expect(isValidDateString('2026-10-12')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('20261012')).toBe(false);
    expect(isValidDateString('2026-1-2')).toBe(false);
  });

  it('weekdayOfDate is a calendar weekday (0 = Sunday)', () => {
    expect(weekdayOfDate('2026-10-11')).toBe(0); // Sunday
    expect(weekdayOfDate('2026-10-12')).toBe(1); // Monday
    expect(weekdayOfDate('2026-10-17')).toBe(6); // Saturday
  });
});

describe('timezone helpers', () => {
  it('zonedParts gives wall-clock parts in the clinic timezone', () => {
    const p = zonedParts(new Date('2026-10-12T07:05:00Z'), RIYADH);
    expect(p).toMatchObject({ year: 2026, month: 10, day: 12, hour: 10, minute: 5, weekday: 1, hhmm: '10:05', date: '2026-10-12' });
    // Crossing midnight: 22:30Z Monday is 01:30 Tuesday in Riyadh.
    const q = zonedParts(new Date('2026-10-12T22:30:00Z'), RIYADH);
    expect(q).toMatchObject({ day: 13, weekday: 2, hhmm: '01:30' });
    // Midnight exactly must be hour 0, not 24.
    const m = zonedParts(new Date('2026-10-11T21:00:00Z'), RIYADH);
    expect(m).toMatchObject({ hour: 0, hhmm: '00:00', day: 12 });
  });

  it('tzOffsetMs reflects fixed and DST offsets', () => {
    expect(tzOffsetMs(new Date('2026-10-12T07:00:00Z'), RIYADH)).toBe(3 * 3_600_000);
    expect(tzOffsetMs(new Date('2026-07-01T12:00:00Z'), NY)).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(new Date('2026-01-01T12:00:00Z'), NY)).toBe(-5 * 3_600_000);
    expect(tzOffsetMs(new Date('2026-01-01T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('zonedTimeToUtc converts wall-clock time to an instant', () => {
    expect(zonedTimeToUtc('2026-10-12', '10:00', RIYADH).toISOString()).toBe('2026-10-12T07:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-12', '00:00', RIYADH).toISOString()).toBe('2026-10-11T21:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-12', '10:00', 'UTC').toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '09:00', NY).toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT
    expect(zonedTimeToUtc('2026-01-15', '09:00', NY).toISOString()).toBe('2026-01-15T14:00:00.000Z'); // EST
  });

  it('zonedTimeToUtc handles DST transitions', () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00); it resolves to 03:30 EDT.
    expect(zonedTimeToUtc('2026-03-08', '02:30', NY).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // Day after the switch is on EDT.
    expect(zonedTimeToUtc('2026-03-09', '09:00', NY).toISOString()).toBe('2026-03-09T13:00:00.000Z');
    // 2026-11-01 01:30 happens twice; the earlier (EDT) instant is used.
    expect(zonedTimeToUtc('2026-11-01', '01:30', NY).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('dayBounds spans the local calendar day', () => {
    const b = dayBounds('2026-10-12', RIYADH);
    expect(b.startsAt.toISOString()).toBe('2026-10-11T21:00:00.000Z');
    expect(b.endsAt.toISOString()).toBe('2026-10-12T21:00:00.000Z');
    const dst = dayBounds('2026-03-08', NY); // 23-hour day
    expect(dst.endsAt.getTime() - dst.startsAt.getTime()).toBe(23 * 3_600_000);
  });

  it('throws on an unknown timezone', () => {
    expect(() => zonedParts(new Date(), 'Mars/Olympus')).toThrow();
  });
});

describe('availability', () => {
  const blocks: AvailabilityBlock[] = [
    { weekday: 1, startTime: '09:00', endTime: '12:00', slotMinutes: 30 },
    { weekday: 1, startTime: '13:00', endTime: '17:00', slotMinutes: 20 },
    { weekday: 3, startTime: '09:00', endTime: '17:00', slotMinutes: 15 },
  ];

  it('defaultDurationMinutes picks the containing block, else first block, else 30', () => {
    expect(defaultDurationMinutes(blocks, new Date('2026-10-12T07:00:00Z'), RIYADH)).toBe(30); // Mon 10:00 → morning block
    expect(defaultDurationMinutes(blocks, new Date('2026-10-12T11:00:00Z'), RIYADH)).toBe(20); // Mon 14:00 → afternoon block
    expect(defaultDurationMinutes(blocks, new Date('2026-10-12T20:00:00Z'), RIYADH)).toBe(30); // Mon 23:00 → no containing, first block
    expect(defaultDurationMinutes(blocks, new Date('2026-10-14T07:00:00Z'), RIYADH)).toBe(15); // Wed
    expect(defaultDurationMinutes(blocks, new Date('2026-10-13T07:00:00Z'), RIYADH)).toBe(30); // Tue: no blocks
    expect(defaultDurationMinutes([], new Date('2026-10-12T07:00:00Z'), RIYADH)).toBe(30);
  });

  it('isWithinAvailability requires the whole range inside one block (clinic timezone)', () => {
    // Monday 09:00–09:30 Riyadh = 06:00–06:30Z
    expect(isWithinAvailability(r('2026-10-12T06:00:00Z', '2026-10-12T06:30:00Z'), blocks, RIYADH)).toBe(true);
    // Ends exactly at block end
    expect(isWithinAvailability(r('2026-10-12T08:30:00Z', '2026-10-12T09:00:00Z'), blocks, RIYADH)).toBe(true);
    // Spills past block end
    expect(isWithinAvailability(r('2026-10-12T08:45:00Z', '2026-10-12T09:15:00Z'), blocks, RIYADH)).toBe(false);
    // In the lunch gap
    expect(isWithinAvailability(r('2026-10-12T09:00:00Z', '2026-10-12T09:30:00Z'), blocks, RIYADH)).toBe(false);
    // Spans two blocks
    expect(isWithinAvailability(r('2026-10-12T08:30:00Z', '2026-10-12T10:30:00Z'), blocks, RIYADH)).toBe(false);
    // Before opening
    expect(isWithinAvailability(r('2026-10-12T05:30:00Z', '2026-10-12T06:00:00Z'), blocks, RIYADH)).toBe(false);
    // Wrong weekday (Tuesday)
    expect(isWithinAvailability(r('2026-10-13T06:00:00Z', '2026-10-13T06:30:00Z'), blocks, RIYADH)).toBe(false);
    // Same instant is a different weekday in another timezone: 06:00Z Mon is 02:00 Mon in NY → outside.
    expect(isWithinAvailability(r('2026-10-12T06:00:00Z', '2026-10-12T06:30:00Z'), blocks, NY)).toBe(false);
    // Monday 09:00 NY = 13:00Z → inside.
    expect(isWithinAvailability(r('2026-10-12T13:00:00Z', '2026-10-12T13:30:00Z'), blocks, NY)).toBe(true);
    // Empty / inverted range
    expect(isWithinAvailability(r('2026-10-12T06:30:00Z', '2026-10-12T06:00:00Z'), blocks, RIYADH)).toBe(false);
    expect(isWithinAvailability(r('2026-10-12T06:00:00Z', '2026-10-12T06:00:00Z'), blocks, RIYADH)).toBe(false);
  });

  it('findScheduleProblem reports the first failing rule', () => {
    const timeOff = [r('2026-10-12T07:00:00Z', '2026-10-12T08:00:00Z')]; // Mon 10:00–11:00 Riyadh
    expect(findScheduleProblem(r('2026-10-12T06:00:00Z', '2026-10-12T06:30:00Z'), blocks, timeOff, RIYADH)).toBeNull();
    expect(findScheduleProblem(r('2026-10-12T06:30:00Z', '2026-10-12T06:00:00Z'), blocks, timeOff, RIYADH)).toMatch(/endsAt/);
    expect(findScheduleProblem(r('2026-10-12T04:00:00Z', '2026-10-12T04:30:00Z'), blocks, timeOff, RIYADH)).toMatch(/availability/);
    expect(findScheduleProblem(r('2026-10-12T07:30:00Z', '2026-10-12T08:00:00Z'), blocks, timeOff, RIYADH)).toMatch(/time off/);
    // Touching time off is fine.
    expect(findScheduleProblem(r('2026-10-12T08:00:00Z', '2026-10-12T08:30:00Z'), blocks, timeOff, RIYADH)).toBeNull();
  });
});

describe('generateSlots', () => {
  const blocks: AvailabilityBlock[] = [
    { weekday: 1, startTime: '09:00', endTime: '11:00', slotMinutes: 30 },
    { weekday: 1, startTime: '13:00', endTime: '14:00', slotMinutes: 20 },
  ];
  const past = new Date('2020-01-01T00:00:00Z');

  it('steps through every block of the weekday in the clinic timezone', () => {
    const slots = generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, now: past });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-12T06:00:00.000Z',
      '2026-10-12T06:30:00.000Z',
      '2026-10-12T07:00:00.000Z',
      '2026-10-12T07:30:00.000Z',
      '2026-10-12T10:00:00.000Z',
      '2026-10-12T10:20:00.000Z',
      '2026-10-12T10:40:00.000Z',
    ]);
    expect(slots[0].endsAt.toISOString()).toBe('2026-10-12T06:30:00.000Z');
    expect(slots[6].endsAt.toISOString()).toBe('2026-10-12T11:00:00.000Z');
  });

  it('returns nothing on a day without availability', () => {
    expect(generateSlots({ date: '2026-10-13', timeZone: RIYADH, blocks, now: past })).toEqual([]);
    expect(generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks: [], now: past })).toEqual([]);
  });

  it('honours a requested duration and drops partial slots at the block end', () => {
    const slots = generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, durationMinutes: 45, now: past });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-12T06:00:00.000Z', // 09:00–09:45
      '2026-10-12T06:45:00.000Z', // 09:45–10:30 (10:30–11:15 would spill over)
      '2026-10-12T10:00:00.000Z', // 13:00–13:45
    ]);
    // A duration longer than every block yields nothing.
    expect(generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, durationMinutes: 150, now: past })).toEqual([]);
  });

  it('removes slots intersecting busy ranges (time off and booked appointments)', () => {
    const busy = [
      r('2026-10-12T06:00:00Z', '2026-10-12T06:30:00Z'), // exactly the first slot
      r('2026-10-12T07:15:00Z', '2026-10-12T07:20:00Z'), // sits inside the 10:00–10:30 slot
      r('2026-10-12T10:30:00Z', '2026-10-12T11:30:00Z'), // 13:30 onwards
    ];
    const slots = generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, busy, now: past });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-12T06:30:00.000Z',
      '2026-10-12T07:30:00.000Z',
      '2026-10-12T10:00:00.000Z',
    ]);
  });

  it('drops slots that start in the past', () => {
    const now = new Date('2026-10-12T07:10:00Z');
    const slots = generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, now });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-10-12T07:30:00.000Z',
      '2026-10-12T10:00:00.000Z',
      '2026-10-12T10:20:00.000Z',
      '2026-10-12T10:40:00.000Z',
    ]);
    expect(generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks, now: new Date('2030-01-01T00:00:00Z') })).toEqual([]);
  });

  it('is timezone-aware: the same weekly schedule maps to different instants per clinic', () => {
    const utc = generateSlots({ date: '2026-10-12', timeZone: 'UTC', blocks, now: past });
    const ny = generateSlots({ date: '2026-10-12', timeZone: NY, blocks, now: past });
    expect(utc[0].startsAt.toISOString()).toBe('2026-10-12T09:00:00.000Z');
    expect(ny[0].startsAt.toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(utc).toHaveLength(ny.length);
  });

  it('handles a block ending at midnight', () => {
    const late: AvailabilityBlock[] = [{ weekday: 1, startTime: '23:00', endTime: '00:00', slotMinutes: 30 }];
    // "00:00" as end parses to 0 minutes, so no slot fits; nothing is generated and nothing throws.
    expect(generateSlots({ date: '2026-10-12', timeZone: RIYADH, blocks: late, now: past })).toEqual([]);
    const toMidnight: AvailabilityBlock[] = [{ weekday: 1, startTime: '23:00', endTime: '23:59', slotMinutes: 30 }];
    const slots = generateSlots({ date: '2026-10-12', timeZone: 'UTC', blocks: toMidnight, now: past });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(['2026-10-12T23:00:00.000Z']);
  });

  it('returns slots sorted by start time even with unsorted blocks', () => {
    const unsorted: AvailabilityBlock[] = [
      { weekday: 1, startTime: '13:00', endTime: '14:00', slotMinutes: 60 },
      { weekday: 1, startTime: '09:00', endTime: '10:00', slotMinutes: 60 },
    ];
    const slots = generateSlots({ date: '2026-10-12', timeZone: 'UTC', blocks: unsorted, now: past });
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(['2026-10-12T09:00:00.000Z', '2026-10-12T13:00:00.000Z']);
  });
});
