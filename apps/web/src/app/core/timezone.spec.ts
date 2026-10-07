import { resetClinicTimeZone } from './i18n/locale-registry';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { LanguageService } from './i18n/language.service';
import { setClinicTimeZone, setPortalMode } from './i18n/locale-registry';
import { Appointment } from './models';
import { dateFilterRange, dayRange, fmtDate, fromLocalInput, isoDate, renderSlots, toLocalInput, weekRange } from './date-utils';
import { addDaysToKey, dayBounds, minutesOfDay, startOfWeekKey, zonedParts, zonedTimeToUtc } from './timezone';
import { CAL_START, GRID_PX, HOUR_PX, layoutDay } from '../pages/calendar/calendar';
import { seriesAnchor } from '../pages/calendar/booking-dialog';
import { nextDays, slotWindow } from '../portal/pages/book';

// The clinic-zone registry is shared module state: leave it clean for other specs.
afterEach(() => resetClinicTimeZone());

/**
 * Clinic-timezone regressions. The test process runs in UTC, so Asia/Riyadh (UTC+3, no DST) makes any
 * accidental use of the runtime zone visible; New York covers DST.
 */
const RIYADH = 'Asia/Riyadh';
const appt = (id: string, startsAt: string, endsAt: string): Appointment =>
  ({ id, doctorId: 'd', patientId: 'p', startsAt, endsAt, status: 'SCHEDULED', createdAt: '', updatedAt: '' }) as Appointment;

describe('timezone helpers', () => {
  it('reads wall-clock fields in the given zone', () => {
    const p = zonedParts(new Date('2026-10-07T06:00:00Z'), RIYADH);
    expect([p.year, p.month, p.day, p.hour, p.minute, p.weekday]).toEqual([2026, 10, 7, 9, 0, 3]);
    expect(minutesOfDay(new Date('2026-10-07T06:00:00Z'), RIYADH)).toBe(9 * 60);
  });

  it('day bounds for 2026-10-07 in Asia/Riyadh are 2026-10-06T21:00Z..2026-10-07T21:00Z', () => {
    const b = dayBounds('2026-10-07', RIYADH);
    expect(b.from.toISOString()).toBe('2026-10-06T21:00:00.000Z');
    expect(b.to.toISOString()).toBe('2026-10-07T21:00:00.000Z');
    expect(dayRange('2026-10-07', RIYADH)).toEqual({ from: '2026-10-06T21:00:00.000Z', to: '2026-10-07T21:00:00.000Z' });
    // An instant late on the 7th UTC is already the 8th in Riyadh.
    expect(dayRange(new Date('2026-10-07T22:30:00Z'), RIYADH).from).toBe('2026-10-07T21:00:00.000Z');
  });

  it('handles DST days (New York 2026-03-08 is 23 h long)', () => {
    const b = dayBounds('2026-03-08', 'America/New_York');
    expect(b.from.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(b.to.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(zonedTimeToUtc(2026, 11, 1, 12, 0, 'America/New_York').toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });

  it('computes clinic-local dates, weeks and key arithmetic', () => {
    expect(isoDate(new Date('2026-10-07T21:30:00Z'), RIYADH)).toBe('2026-10-08');
    expect(isoDate(new Date('2026-10-07T21:30:00Z'), 'UTC')).toBe('2026-10-07');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(startOfWeekKey('2026-10-07')).toBe('2026-10-05');
    const w = weekRange('2026-10-07', RIYADH);
    expect(w.startKey).toBe('2026-10-05');
    expect(w.from).toBe('2026-10-04T21:00:00.000Z');
    expect(w.to).toBe('2026-10-11T21:00:00.000Z');
  });

  it('builds inclusive audit date filters from clinic-local days', () => {
    expect(dateFilterRange('2026-10-01', '2026-10-07', RIYADH)).toEqual({ from: '2026-09-30T21:00:00.000Z', to: '2026-10-07T20:59:59.999Z' });
    expect(dateFilterRange('', undefined, RIYADH)).toEqual({ from: undefined, to: undefined });
  });

  it('labels slots and formats patterns in clinic time', () => {
    const [s] = renderSlots([{ startsAt: '2026-10-07T06:00:00.000Z', endsAt: '2026-10-07T06:30:00.000Z' }], new Date('2026-10-07T00:00:00Z'), RIYADH);
    expect(s.label).toBe('09:00 – 09:30');
    expect(fmtDate('2026-10-07T21:30:00Z', 'yyyy-MM-dd HH:mm', RIYADH)).toBe('2026-10-08 00:30');
    // Date-only values are calendar dates, never shifted.
    expect(fmtDate('2026-10-07', 'yyyy-MM-dd', 'America/New_York')).toBe('2026-10-07');
  });

  it('round-trips datetime-local values in clinic time and rejects empty ones', () => {
    expect(toLocalInput('2026-10-07T06:00:00.000Z', RIYADH)).toBe('2026-10-07T09:00');
    expect(fromLocalInput('2026-10-07T09:00', RIYADH)).toBe('2026-10-07T06:00:00.000Z');
    expect(fromLocalInput('', RIYADH)).toBeNull();
    expect(fromLocalInput('2026-10-07', RIYADH)).toBeNull();
  });
});

describe('calendar positioning in the clinic timezone', () => {
  it('places 06:00Z on the 09:00 row for Asia/Riyadh', () => {
    const [ev] = layoutDay([appt('a', '2026-10-07T06:00:00.000Z', '2026-10-07T07:00:00.000Z')], RIYADH);
    expect(ev.top).toBe((9 - CAL_START) * HOUR_PX);
    expect(ev.height).toBe(HOUR_PX - 2);
    expect(ev.clipped).toBe(false);
  });

  it('keeps events before 07:00 / after 21:00 visible, pinned to the grid edge', () => {
    const [early] = layoutDay([appt('e', '2026-10-07T03:00:00.000Z', '2026-10-07T04:30:00.000Z')], RIYADH); // 06:00–07:30
    expect(early.top).toBe(0);
    expect(early.height).toBeGreaterThanOrEqual(20);
    expect(early.clipped).toBe(true);
    const [late] = layoutDay([appt('l', '2026-10-07T19:00:00.000Z', '2026-10-07T19:30:00.000Z')], RIYADH); // 22:00
    expect(late.top + late.height).toBeLessThanOrEqual(GRID_PX);
    expect(late.top).toBeGreaterThanOrEqual(0);
    expect(late.clipped).toBe(true);
  });
});

describe('recurring series anchor', () => {
  it('derives startsOn/startTime/weekday/monthDay in the clinic timezone', () => {
    // 21:30Z on Wed 7 Oct = 00:30 Thu 8 Oct in Riyadh.
    expect(seriesAnchor('2026-10-07T21:30:00.000Z', RIYADH)).toEqual({ startsOn: '2026-10-08', startTime: '00:30', weekday: 4, monthDay: 8 });
    expect(seriesAnchor('2026-10-07T21:30:00.000Z', 'UTC')).toEqual({ startsOn: '2026-10-07', startTime: '21:30', weekday: 3, monthDay: 7 });
  });
});

describe('portal booking days', () => {
  it('lists clinic-local days and queries the clinic day window', () => {
    const now = new Date('2026-10-07T22:30:00Z'); // already the 8th in Riyadh
    expect(nextDays(3, now, RIYADH)).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
    const w = slotWindow('2026-10-08', now, RIYADH)!;
    expect(w.from.toISOString()).toBe('2026-10-07T22:30:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-08T21:00:00.000Z');
    expect(slotWindow('2026-10-07', now, RIYADH)).toBeNull();
  });
});

describe('LanguageService formats in the clinic timezone', () => {
  afterEach(() => setPortalMode(false));

  function setup() {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    const auth = TestBed.inject(AuthService);
    const lang = TestBed.inject(LanguageService);
    lang.set('en');
    TestBed.flushEffects();
    return { auth, lang };
  }

  it('renders 06:00Z as 09:00 for a Riyadh clinic session', () => {
    const { auth, lang } = setup();
    auth.session.set({
      user: { id: 'u', email: 'a@b.c', firstName: 'A', lastName: 'B' },
      clinic: { id: 'c', name: 'C', slug: 'c', timezone: RIYADH, currency: 'SAR' }, role: 'OWNER', permissions: [], clinics: [],
    });
    expect(lang.formatTime('2026-10-07T06:00:00.000Z')).toBe('09:00');
    expect(lang.formatDateTime('2026-10-07T21:30:00.000Z')).toBe('08 Oct 2026, 00:30');
    expect(lang.formatDate('2026-10-07T06:00:00.000Z', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })).toBe('06:00');
    // Calendar dates (e.g. birth dates) are not shifted.
    expect(lang.formatDate('2026-10-07')).toBe('07 Oct 2026');
  });

  it('uses the portal clinic timezone while the portal is mounted', () => {
    const { lang } = setup();
    setClinicTimeZone('staff', 'UTC');
    setClinicTimeZone('portal', RIYADH);
    expect(lang.formatTime('2026-10-07T06:00:00.000Z')).toBe('06:00');
    setPortalMode(true);
    expect(lang.formatTime('2026-10-07T06:00:00.000Z')).toBe('09:00');
  });
});
