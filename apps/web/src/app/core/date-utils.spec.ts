import { describe, expect, it } from 'vitest';
import { renderSlots, timeOptions } from './date-utils';

describe('renderSlots', () => {
  const now = new Date('2026-10-04T10:00:00');
  it('sorts slots, labels them in local time and disables past ones', () => {
    const slots = [
      { startsAt: new Date('2026-10-04T11:00:00').toISOString(), endsAt: new Date('2026-10-04T11:30:00').toISOString() },
      { startsAt: new Date('2026-10-04T09:00:00').toISOString(), endsAt: new Date('2026-10-04T09:30:00').toISOString() },
    ];
    const out = renderSlots(slots, now);
    expect(out.map((s) => s.label)).toEqual(['09:00 – 09:30', '11:00 – 11:30']);
    expect(out[0].disabled).toBe(true);
    expect(out[1].disabled).toBe(false);
  });
  it('returns an empty list for no slots', () => {
    expect(renderSlots([], now)).toEqual([]);
  });
});

describe('timeOptions', () => {
  it('builds HH:mm options at the given step', () => {
    const t = timeOptions(30, 8, 10);
    expect(t).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00']);
  });
});
