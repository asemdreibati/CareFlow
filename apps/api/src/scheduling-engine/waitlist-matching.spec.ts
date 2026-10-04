import { describe, expect, it } from 'vitest';
import {
  compareEntries,
  entryAdmitsSlot,
  entryHeap,
  firstAdmittedSlot,
  pickBestEntry,
  rankEntries,
  type WaitlistCandidate,
} from './waitlist-matching.js';

const RIYADH = 'Asia/Riyadh'; // UTC+3, no DST
const d = (s: string) => new Date(s);
const slot = (s: string, e: string) => ({ startsAt: d(s), endsAt: d(e) });

let seq = 0;
function entry(over: Partial<WaitlistCandidate> = {}): WaitlistCandidate {
  seq++;
  return {
    id: `e${String(seq).padStart(3, '0')}`,
    priority: 'ROUTINE',
    createdAt: d(`2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`),
    durationMinutes: 30,
    earliestAt: d('2026-01-01T00:00:00Z'),
    latestAt: null,
    preferredWindows: [],
    ...over,
  };
}

// Monday 2026-03-02, 10:00–11:00 Riyadh = 07:00–08:00Z
const freed = slot('2026-03-02T07:00:00Z', '2026-03-02T08:00:00Z');

describe('entryAdmitsSlot', () => {
  it('requires the duration to fit', () => {
    expect(entryAdmitsSlot(entry({ durationMinutes: 60 }), freed, RIYADH)).toBe(true);
    expect(entryAdmitsSlot(entry({ durationMinutes: 61 }), freed, RIYADH)).toBe(false);
    expect(entryAdmitsSlot(entry({ durationMinutes: 0 }), freed, RIYADH)).toBe(false);
  });

  it('applies earliestAt and latestAt bounds', () => {
    expect(entryAdmitsSlot(entry({ earliestAt: d('2026-03-02T07:00:00Z') }), freed, RIYADH)).toBe(true);
    expect(entryAdmitsSlot(entry({ earliestAt: d('2026-03-02T07:00:01Z') }), freed, RIYADH)).toBe(false);
    expect(entryAdmitsSlot(entry({ latestAt: d('2026-03-02T07:30:00Z') }), freed, RIYADH)).toBe(true);
    expect(entryAdmitsSlot(entry({ latestAt: d('2026-03-02T07:29:00Z') }), freed, RIYADH)).toBe(false);
  });

  it('matches preferred windows on the clinic wall clock', () => {
    const monMorning = [{ weekday: 1, startTime: '09:00', endTime: '12:00' }];
    const monAfternoon = [{ weekday: 1, startTime: '13:00', endTime: '17:00' }];
    const tueMorning = [{ weekday: 2, startTime: '09:00', endTime: '12:00' }];
    expect(entryAdmitsSlot(entry({ preferredWindows: monMorning }), freed, RIYADH)).toBe(true);
    expect(entryAdmitsSlot(entry({ preferredWindows: monAfternoon }), freed, RIYADH)).toBe(false);
    expect(entryAdmitsSlot(entry({ preferredWindows: tueMorning }), freed, RIYADH)).toBe(false);
    expect(entryAdmitsSlot(entry({ preferredWindows: [...monAfternoon, ...monMorning] }), freed, RIYADH)).toBe(true);
    // The window must contain the whole appointment: 10:00–10:30 inside 10:00–10:30 is fine, 10:00–10:31 is not.
    expect(entryAdmitsSlot(entry({ preferredWindows: [{ weekday: 1, startTime: '10:00', endTime: '10:30' }] }), freed, RIYADH)).toBe(true);
    expect(entryAdmitsSlot(entry({ durationMinutes: 31, preferredWindows: [{ weekday: 1, startTime: '10:00', endTime: '10:30' }] }), freed, RIYADH)).toBe(false);
  });
});

describe('ranking', () => {
  it('orders by priority, then createdAt, then id', () => {
    const a = entry({ priority: 'ROUTINE', createdAt: d('2026-01-01T00:00:00Z') });
    const b = entry({ priority: 'URGENT', createdAt: d('2026-01-05T00:00:00Z') });
    const c = entry({ priority: 'SOON', createdAt: d('2026-01-03T00:00:00Z') });
    const e = entry({ priority: 'SOON', createdAt: d('2026-01-02T00:00:00Z') });
    const f = entry({ priority: 'SOON', createdAt: d('2026-01-02T00:00:00Z'), id: 'aaa' });
    expect(rankEntries([a, b, c, e, f]).map((x) => x.id)).toEqual([b.id, 'aaa', e.id, c.id, a.id]);
    expect(compareEntries(a, a)).toBe(0);
    expect(compareEntries(b, a)).toBeLessThan(0);
  });

  it('heap pops in the same order as the sorted comparator for random inputs', () => {
    const priorities: WaitlistCandidate['priority'][] = ['URGENT', 'SOON', 'ROUTINE'];
    const items = Array.from({ length: 200 }, () =>
      entry({ priority: priorities[Math.floor(Math.random() * 3)], createdAt: d(`2026-01-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}T00:00:00Z`) }),
    );
    const expected = [...items].sort(compareEntries).map((x) => x.id);
    const heap = entryHeap(items);
    expect(heap.size).toBe(200);
    expect([...heap.drain()].map((x) => x.id)).toEqual(expected);
  });

  it('pickBestEntry returns the best admitting entry only', () => {
    const urgentTooLong = entry({ priority: 'URGENT', durationMinutes: 90 });
    const soonWrongDay = entry({ priority: 'SOON', preferredWindows: [{ weekday: 3, startTime: '09:00', endTime: '17:00' }] });
    const routineOld = entry({ priority: 'ROUTINE', createdAt: d('2025-12-01T00:00:00Z') });
    const routineNew = entry({ priority: 'ROUTINE', createdAt: d('2026-02-01T00:00:00Z') });
    expect(pickBestEntry([routineNew, urgentTooLong, soonWrongDay, routineOld], freed, RIYADH)?.id).toBe(routineOld.id);
    expect(pickBestEntry([urgentTooLong, soonWrongDay], freed, RIYADH)).toBeUndefined();
    expect(pickBestEntry([], freed, RIYADH)).toBeUndefined();
  });
});

describe('firstAdmittedSlot', () => {
  it('places the entry at the start of the freed interval when unconstrained', () => {
    expect(firstAdmittedSlot(entry(), freed, RIYADH, 30)).toEqual(slot('2026-03-02T07:00:00Z', '2026-03-02T07:30:00Z'));
  });

  it('steps along the grid to satisfy a narrower window or earliestAt', () => {
    const late = entry({ preferredWindows: [{ weekday: 1, startTime: '10:30', endTime: '12:00' }] });
    expect(firstAdmittedSlot(late, freed, RIYADH, 15)).toEqual(slot('2026-03-02T07:30:00Z', '2026-03-02T08:00:00Z'));
    const notBefore = entry({ earliestAt: d('2026-03-02T07:10:00Z') });
    expect(firstAdmittedSlot(notBefore, freed, RIYADH, 15)).toEqual(slot('2026-03-02T07:15:00Z', '2026-03-02T07:45:00Z'));
    expect(firstAdmittedSlot(entry({ durationMinutes: 45, earliestAt: d('2026-03-02T07:20:00Z') }), freed, RIYADH, 15)).toBeUndefined();
  });
});
