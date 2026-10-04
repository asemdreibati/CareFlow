import { compareCandidates, scoreSlot, searchSlots, type AvailabilityWindow, type DoctorCandidate, type SlotCandidate } from './slot-search.js';
import type { Interval } from './intervals.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Monday 2026-01-05 00:00 "wall clock" (we treat UTC as the clinic timezone in these tests). */
const BASE = Date.UTC(2026, 0, 5);

const dateKey = (dayIndex: number) => `2026-01-${String(5 + dayIndex).padStart(2, '0')}`;
const weekdayOf = (dayIndex: number) => (1 + dayIndex) % 7;
/** Instant of wall-clock HH:mm on day `dayIndex`. */
const t = (dayIndex: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return BASE + dayIndex * DAY + h * HOUR + m * MIN;
};

function block(dayIndex: number, startTime: string, endTime: string): AvailabilityWindow {
  const [h, m] = startTime.split(':').map(Number);
  return { start: t(dayIndex, startTime), end: t(dayIndex, endTime), date: dateKey(dayIndex), weekday: weekdayOf(dayIndex), wallStartMinutes: h * 60 + m };
}

function doctor(id: string, days: number, opts: Partial<DoctorCandidate> & { hours?: [string, string]; slotMinutes?: number } = {}): DoctorCandidate {
  const [open, close] = opts.hours ?? ['09:00', '17:00'];
  const blocks = opts.blocks ?? Array.from({ length: days }, (_, d) => block(d, open, close));
  const slot = opts.slotMinutes ?? 30;
  return {
    id,
    blocks,
    slotMinutesByWeekday: opts.slotMinutesByWeekday ?? { 0: slot, 1: slot, 2: slot, 3: slot, 4: slot, 5: slot, 6: slot },
    busy: opts.busy ?? [],
    bookedMinutesByDay: opts.bookedMinutesByDay ?? {},
  };
}

const starts = (c: SlotCandidate[]) => c.map((x) => x.start);

describe('scoreSlot', () => {
  const gap: Interval = { start: t(0, '09:00'), end: t(0, '12:00') };
  const base = { gap, from: t(0, '09:00'), isPreferredDoctor: false, inPreferredWindow: false, bookedMinutesThatDay: 0, minUsefulMinutes: 30 };

  it('weights soonness in hours and applies the contract bonuses', () => {
    const plain = scoreSlot({ ...base, slot: { start: t(0, '11:00'), end: t(0, '11:30') } });
    expect(plain.breakdown.soonness).toBe(2);
    expect(plain.score).toBe(2);

    const preferred = scoreSlot({ ...base, slot: { start: t(0, '11:00'), end: t(0, '11:30') }, isPreferredDoctor: true, inPreferredWindow: true });
    expect(preferred.breakdown.preferredDoctor).toBe(-6);
    expect(preferred.breakdown.inPreferredWindow).toBe(-3);
    expect(preferred.score).toBe(-7);
    expect(preferred.reasons).toEqual(expect.arrayContaining(['Preferred doctor', 'Within a preferred time window']));

    const loaded = scoreSlot({ ...base, slot: { start: t(0, '09:00'), end: t(0, '09:30') }, bookedMinutesThatDay: 90 });
    expect(loaded.breakdown.loadBalance).toBe(3);
    expect(loaded.reasons).toContain('Doctor already has 90 min booked that day');
  });

  it('charges fragmentation for unusable leftovers (minutes / 10)', () => {
    // 45-minute slot in the middle of a 90-minute gap on a 30-minute grid: 15 min left after → +1.5
    const smallGap: Interval = { start: t(0, '09:00'), end: t(0, '10:30') };
    const middle = scoreSlot({ ...base, gap: smallGap, slot: { start: t(0, '09:30'), end: t(0, '10:15') } });
    expect(middle.breakdown.fragmentation).toBe(1.5);
    expect(middle.reasons).toContain('Leaves 15 min of unusable gap');
    const edge = scoreSlot({ ...base, gap: smallGap, slot: { start: t(0, '09:00'), end: t(0, '09:45') } });
    expect(edge.breakdown.fragmentation).toBe(0);
    expect(edge.reasons).toContain('Fits without leaving an unusable gap');
  });
});

describe('searchSlots', () => {
  it('returns the earliest slots on the doctor grid, sorted by score', () => {
    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [doctor('a', 1)], limit: 3 });
    expect(starts(res)).toEqual([t(0, '09:00'), t(0, '09:30'), t(0, '10:00')]);
    expect(res.map((c) => c.score)).toEqual([0, 0.5, 1]);
    expect(res[0].end - res[0].start).toBe(30 * MIN);
    expect(res[0].reasons.length).toBeGreaterThan(0);
  });

  it('skips busy time and keeps slots aligned to the block grid', () => {
    const d = doctor('a', 1, { busy: [{ start: t(0, '09:00'), end: t(0, '09:40') }] });
    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [d], limit: 5 });
    // 09:40 is free but off-grid: every slot sits on the 30-minute grid of the block and none overlaps the busy time.
    expect(starts(res).every((s) => (s - t(0, '09:00')) % (30 * MIN) === 0)).toBe(true);
    expect(Math.min(...starts(res))).toBeGreaterThanOrEqual(t(0, '10:00'));
    // 10:00 leaves a 20-minute unusable sliver (09:40–10:00) → +2, so 10:30 (0 fragmentation, +1.5 soonness) ranks first.
    // It ties with 12:00 (score 3) and wins on start time.
    expect(starts(res)).toEqual([t(0, '10:30'), t(0, '11:00'), t(0, '11:30'), t(0, '10:00'), t(0, '12:00')]);
    expect(res[3].breakdown.fragmentation).toBe(2);
  });

  it('respects `from` (mid-grid) and `to`', () => {
    const res = searchSlots({ from: t(0, '10:10'), to: t(0, '11:30'), durationMinutes: 30, doctors: [doctor('a', 1)], limit: 10 });
    expect(starts(res)).toEqual([t(0, '10:30'), t(0, '11:00')]);
  });

  it('preferred doctor wins ties', () => {
    const docs = [doctor('a', 1), doctor('b', 1)];
    const neutral = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: docs, limit: 2 });
    expect(neutral.map((c) => c.doctorId)).toEqual(['a', 'b']); // tie → doctor id order

    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: docs, preferredDoctorId: 'b', limit: 4 });
    expect(res[0]).toMatchObject({ doctorId: 'b', start: t(0, '09:00'), score: -6 });
    // The preference is worth 6 hours: b's slots up to 15:00 outrank a's 09:00.
    expect(res.every((c) => c.doctorId === 'b')).toBe(true);
    expect(res[0].reasons).toContain('Preferred doctor');
  });

  it('applies the preferred window bonus', () => {
    const res = searchSlots({
      from: t(0, '09:00'),
      durationMinutes: 30,
      doctors: [doctor('a', 1)],
      preferredWindows: [{ weekday: weekdayOf(0), startTime: '11:00', endTime: '12:00' }],
      limit: 3,
    });
    // 11:00 (2h away −3) and 11:30 (2.5h −3) beat 09:00 (0).
    expect(starts(res)).toEqual([t(0, '11:00'), t(0, '11:30'), t(0, '09:00')]);
    expect(res[0].score).toBe(-1);
    expect(res[0].reasons).toContain('Within a preferred time window');
    // A window on another weekday does not apply.
    const other = searchSlots({
      from: t(0, '09:00'),
      durationMinutes: 30,
      doctors: [doctor('a', 1)],
      preferredWindows: [{ weekday: weekdayOf(1), startTime: '11:00', endTime: '12:00' }],
      limit: 1,
    });
    expect(starts(other)).toEqual([t(0, '09:00')]);
  });

  it('fragmentation prefers edge placement over leaving a useless sliver', () => {
    // Doctor a: free gap 09:15–10:00 → the only grid slot is 09:30, leaving 15 unusable minutes before it.
    const a = doctor('a', 1, { hours: ['09:00', '10:00'], busy: [{ start: t(0, '09:00'), end: t(0, '09:15') }] });
    // Doctor b: block 09:30–10:00 → the slot fills the gap exactly.
    const b = doctor('b', 1, { blocks: [block(0, '09:30', '10:00')] });
    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [a, b], limit: 2 });
    expect(res.map((c) => [c.doctorId, c.start])).toEqual([
      ['b', t(0, '09:30')],
      ['a', t(0, '09:30')],
    ]);
    expect(res[0].breakdown.fragmentation).toBe(0);
    expect(res[1].breakdown.fragmentation).toBe(1.5);
  });

  it('load balancing favours the doctor with fewer booked minutes', () => {
    const busyDoc = doctor('a', 1, { bookedMinutesByDay: { [dateKey(0)]: 120 } });
    const freeDoc = doctor('b', 1);
    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [busyDoc, freeDoc], limit: 20 });
    expect(res[0]).toMatchObject({ doctorId: 'b', score: 0 });
    // 120 booked minutes → +4: doctor a's 09:00 ranks behind b's slots up to 13:00.
    expect(res.find((c) => c.doctorId === 'a')).toMatchObject({ start: t(0, '09:00'), score: 4 });
    expect(res.findIndex((c) => c.doctorId === 'a')).toBe(8);
  });

  it('required resources restrict results to their common free time', () => {
    const roomFree: Interval[] = [{ start: t(0, '10:00'), end: t(0, '12:00') }];
    const deviceFree: Interval[] = [{ start: t(0, '09:00'), end: t(0, '11:00') }];
    const res = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [doctor('a', 1)], resourceFree: [roomFree, deviceFree], limit: 10 });
    expect(starts(res)).toEqual([t(0, '10:00'), t(0, '10:30')]);
    expect(res.every((c) => c.start >= t(0, '10:00') && c.end <= t(0, '11:00'))).toBe(true);

    const none = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [doctor('a', 1)], resourceFree: [roomFree, []], limit: 10 });
    expect(none).toEqual([]);
  });

  it('uses the per-weekday slot grid and spans several days', () => {
    const d = doctor('a', 2, { slotMinutesByWeekday: { [weekdayOf(0)]: 60, [weekdayOf(1)]: 15 } });
    const day0 = searchSlots({ from: t(0, '09:00'), to: t(0, '17:00'), durationMinutes: 30, doctors: [d], limit: 2 });
    expect(starts(day0)).toEqual([t(0, '09:00'), t(0, '10:00')]);
    const day1 = searchSlots({ from: t(1, '09:00'), durationMinutes: 30, doctors: [d], limit: 2 });
    expect(starts(day1)).toEqual([t(1, '09:00'), t(1, '09:15')]);
  });

  it('respects the limit and handles empty input', () => {
    const docs = [doctor('a', 5), doctor('b', 5)];
    expect(searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: docs, limit: 7 })).toHaveLength(7);
    expect(searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: docs })).toHaveLength(10);
    expect(searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [], limit: 5 })).toEqual([]);
    expect(searchSlots({ from: t(0, '09:00'), durationMinutes: 0, doctors: docs, limit: 5 })).toEqual([]);
    expect(searchSlots({ from: t(0, '09:00'), durationMinutes: 600, doctors: docs, limit: 5 })).toEqual([]);
  });

  it('is deterministic: same result regardless of doctor input order, sorted by (score, start, doctorId)', () => {
    const docs = [doctor('c', 2), doctor('a', 2), doctor('b', 2)];
    const run1 = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: docs, limit: 9 });
    const run2 = searchSlots({ from: t(0, '09:00'), durationMinutes: 30, doctors: [...docs].reverse(), limit: 9 });
    expect(run1).toEqual(run2);
    expect(run1.slice(0, 3).map((c) => c.doctorId)).toEqual(['a', 'b', 'c']);
    for (let i = 1; i < run1.length; i++) expect(compareCandidates(run1[i - 1], run1[i])).toBeLessThanOrEqual(0);
  });
});
