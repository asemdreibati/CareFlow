import { describe, expect, it } from 'vitest';
import { addWindow, describeWindows, normalizeWindows, parseWindows, removeWindow, updateWindow, validateWindows } from './preferred-windows';

describe('preferred windows model', () => {
  it('adds rows without mutating the input and steps the weekday', () => {
    const a = addWindow([]);
    expect(a).toEqual([{ weekday: 1, startTime: '09:00', endTime: '12:00' }]);
    const b = addWindow(a);
    expect(a).toHaveLength(1);
    expect(b[1]).toEqual({ weekday: 2, startTime: '09:00', endTime: '12:00' });
    expect(addWindow([{ weekday: 6, startTime: '08:00', endTime: '10:00' }])[1].weekday).toBe(0);
  });
  it('updates and removes by index, coercing weekday to a number', () => {
    const rows = addWindow(addWindow([]));
    const u = updateWindow(rows, 1, { weekday: '4' as unknown as number, endTime: '18:00' });
    expect(u[1]).toEqual({ weekday: 4, startTime: '09:00', endTime: '18:00' });
    expect(u[0]).toBe(rows[0]);
    expect(removeWindow(u, 0)).toEqual([u[1]]);
  });
  it('validates weekday range, time format and ordering', () => {
    expect(validateWindows([])).toBeNull();
    expect(validateWindows([{ weekday: 1, startTime: '09:00', endTime: '12:00' }])).toBeNull();
    expect(validateWindows([{ weekday: 7, startTime: '09:00', endTime: '12:00' }])).toMatch(/weekday/i);
    expect(validateWindows([{ weekday: 2, startTime: '9:00', endTime: '12:00' }])).toMatch(/HH:mm/);
    expect(validateWindows([{ weekday: 3, startTime: '13:00', endTime: '12:00' }])).toMatch(/Wed: end time/);
  });
  it('normalizes: drops invalid rows, sorts and de-duplicates', () => {
    const out = normalizeWindows([
      { weekday: 3, startTime: '14:00', endTime: '17:00' },
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 1, startTime: '12:00', endTime: '11:00' },
    ]);
    expect(out).toEqual([{ weekday: 1, startTime: '09:00', endTime: '12:00' }, { weekday: 3, startTime: '14:00', endTime: '17:00' }]);
  });
  it('describes and parses the API representation', () => {
    expect(describeWindows([])).toBe('Any time');
    expect(describeWindows([{ weekday: 1, startTime: '09:00', endTime: '12:00' }])).toBe('Mon 09:00–12:00');
    expect(parseWindows('[{"weekday":5,"startTime":"08:00","endTime":"10:00"}]')).toEqual([{ weekday: 5, startTime: '08:00', endTime: '10:00' }]);
    expect(parseWindows('not json')).toEqual([]);
    expect(parseWindows(null)).toEqual([]);
    expect(parseWindows([{ weekday: 1 }, { weekday: 2, startTime: '09:00', endTime: '10:00' }])).toEqual([{ weekday: 2, startTime: '09:00', endTime: '10:00' }]);
  });
});
