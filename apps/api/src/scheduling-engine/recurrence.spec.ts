import { describe, expect, it } from 'vitest';
import { zonedParts } from '../modules/appointments/scheduling.js';
import { addDays, daysInMonth, expandRecurrence, MAX_OCCURRENCES, RecurrenceRuleError, validateRecurrenceRule, type RecurrenceRule } from './recurrence.js';

const BERLIN = 'Europe/Berlin';
const RIYADH = 'Asia/Riyadh';
const UTC = 'UTC';

const base: RecurrenceRule = { frequency: 'DAILY', startsOn: '2026-03-02', startTime: '10:00', durationMinutes: 30, count: 3 };

describe('calendar helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('knows month lengths including leap years', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('validateRecurrenceRule', () => {
  it('requires exactly one of count / until', () => {
    expect(validateRecurrenceRule({ ...base, count: undefined })).toMatch(/count or until/);
    expect(validateRecurrenceRule({ ...base, until: '2026-03-10' })).toMatch(/count or until/);
    expect(validateRecurrenceRule({ ...base, count: undefined, until: '2026-03-10' })).toBeNull();
  });

  it('rejects malformed fields', () => {
    expect(validateRecurrenceRule({ ...base, startsOn: '2026-02-30' })).toMatch(/startsOn/);
    expect(validateRecurrenceRule({ ...base, startTime: '25:00' })).toMatch(/startTime/);
    expect(validateRecurrenceRule({ ...base, durationMinutes: 0 })).toMatch(/durationMinutes/);
    expect(validateRecurrenceRule({ ...base, interval: 0 })).toMatch(/interval/);
    expect(validateRecurrenceRule({ ...base, count: MAX_OCCURRENCES + 1 })).toMatch(/count/);
    expect(validateRecurrenceRule({ ...base, count: undefined, until: '2026-03-01' })).toMatch(/until/);
    expect(validateRecurrenceRule({ ...base, byWeekday: [1] })).toMatch(/byWeekday/);
    expect(validateRecurrenceRule({ ...base, frequency: 'WEEKLY', byWeekday: [7] })).toMatch(/byWeekday/);
    expect(validateRecurrenceRule({ ...base, byMonthDay: 5 })).toMatch(/byMonthDay/);
    expect(validateRecurrenceRule({ ...base, frequency: 'MONTHLY', byMonthDay: 32 })).toMatch(/byMonthDay/);
    expect(() => expandRecurrence({ ...base, count: 0 }, UTC)).toThrow(RecurrenceRuleError);
  });
});

describe('expandRecurrence DAILY', () => {
  it('produces consecutive days with 0-based indices and the right duration', () => {
    const occ = expandRecurrence(base, RIYADH);
    expect(occ.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
    // 10:00 Riyadh (UTC+3) = 07:00Z
    expect(occ[0].startsAt.toISOString()).toBe('2026-03-02T07:00:00.000Z');
    expect(occ[0].endsAt.toISOString()).toBe('2026-03-02T07:30:00.000Z');
  });

  it('honours interval and until (inclusive)', () => {
    const occ = expandRecurrence({ ...base, interval: 3, count: undefined, until: '2026-03-11' }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-02', '2026-03-05', '2026-03-08', '2026-03-11']);
  });

  it('caps an open-ended until at MAX_OCCURRENCES', () => {
    const occ = expandRecurrence({ ...base, count: undefined, until: '2030-01-01' }, UTC);
    expect(occ).toHaveLength(MAX_OCCURRENCES);
    expect(occ[MAX_OCCURRENCES - 1].index).toBe(MAX_OCCURRENCES - 1);
  });
});

describe('expandRecurrence WEEKLY', () => {
  it('defaults to the weekday of startsOn', () => {
    // 2026-03-02 is a Monday
    const occ = expandRecurrence({ ...base, frequency: 'WEEKLY', count: 4 }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23']);
  });

  it('expands byWeekday within each week, skipping days before startsOn', () => {
    // Start on Wednesday 2026-03-04 with Mon/Wed/Fri: Monday of that week is dropped.
    const occ = expandRecurrence({ ...base, frequency: 'WEEKLY', startsOn: '2026-03-04', byWeekday: [5, 1, 3], count: 5 }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-04', '2026-03-06', '2026-03-09', '2026-03-11', '2026-03-13']);
  });

  it('applies interval in weeks', () => {
    const occ = expandRecurrence({ ...base, frequency: 'WEEKLY', interval: 2, byWeekday: [1, 2], count: 4 }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-02', '2026-03-03', '2026-03-16', '2026-03-17']);
  });

  it('keeps the wall-clock time across the Europe/Berlin DST transition (2026-03-29)', () => {
    // Daily across the spring-forward week: Berlin goes from UTC+1 to UTC+2 on 29 March 2026.
    const occ = expandRecurrence({ ...base, startsOn: '2026-03-26', startTime: '09:00', durationMinutes: 45, count: 6 }, BERLIN);
    for (const o of occ) {
      const p = zonedParts(o.startsAt, BERLIN);
      expect(p.hhmm).toBe('09:00');
      expect(p.date).toBe(o.date);
      expect(o.endsAt.getTime() - o.startsAt.getTime()).toBe(45 * 60_000);
    }
    expect(occ[0].startsAt.toISOString()).toBe('2026-03-26T08:00:00.000Z'); // UTC+1
    expect(occ[3].date).toBe('2026-03-29');
    expect(occ[3].startsAt.toISOString()).toBe('2026-03-29T07:00:00.000Z'); // UTC+2 after the switch
    expect(occ[5].startsAt.toISOString()).toBe('2026-03-31T07:00:00.000Z');

    // Weekly rule straddling the same transition: Thursday before and after.
    const weekly = expandRecurrence({ ...base, frequency: 'WEEKLY', startsOn: '2026-03-26', startTime: '14:30', count: 2 }, BERLIN);
    expect(weekly[0].startsAt.toISOString()).toBe('2026-03-26T13:30:00.000Z');
    expect(weekly[1].startsAt.toISOString()).toBe('2026-04-02T12:30:00.000Z');
    expect(weekly[1].startsAt.getTime() - weekly[0].startsAt.getTime()).toBe(7 * 86_400_000 - 3_600_000);
  });

  it('shifts a non-existent local time forward on the gap day instead of failing', () => {
    // 02:30 does not exist on 2026-03-29 in Berlin; the helper moves it forward by the gap.
    const occ = expandRecurrence({ ...base, startsOn: '2026-03-29', startTime: '02:30', count: 1 }, BERLIN);
    expect(occ[0].startsAt.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('expandRecurrence MONTHLY', () => {
  it('skips months that do not have the 31st', () => {
    const occ = expandRecurrence({ ...base, frequency: 'MONTHLY', startsOn: '2026-01-31', count: 5 }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31']);
    expect(occ.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses byMonthDay, skipping days before startsOn and honouring interval', () => {
    const occ = expandRecurrence({ ...base, frequency: 'MONTHLY', startsOn: '2026-01-20', byMonthDay: 15, interval: 2, count: 3 }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-03-15', '2026-05-15', '2026-07-15']);
    const feb29 = expandRecurrence({ ...base, frequency: 'MONTHLY', startsOn: '2024-01-29', byMonthDay: 29, count: 3 }, UTC);
    expect(feb29.map((o) => o.date)).toEqual(['2024-01-29', '2024-02-29', '2024-03-29']);
  });

  it('terminates for a rule that never matches', () => {
    // Day 31 every 12 months starting in February: no February ever has it.
    const occ = expandRecurrence({ ...base, frequency: 'MONTHLY', startsOn: '2026-02-01', byMonthDay: 31, interval: 12, count: 3 }, UTC);
    expect(occ).toEqual([]);
  });

  it('respects until across years', () => {
    const occ = expandRecurrence({ ...base, frequency: 'MONTHLY', startsOn: '2026-11-10', count: undefined, until: '2027-02-10' }, UTC);
    expect(occ.map((o) => o.date)).toEqual(['2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10']);
  });
});
