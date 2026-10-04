import { ageAt, extractNoShowFeatures, NO_SHOW_FEATURE_NAMES, patientHistoryBefore, smoothedNoShowRate } from './noshow-features.js';

describe('no-show features', () => {
  it('smooths the historical rate with Laplace counts', () => {
    expect(smoothedNoShowRate(0, 0)).toBe(0.5);
    expect(smoothedNoShowRate(0, 8)).toBe(0.1);
    expect(smoothedNoShowRate(3, 3)).toBe(0.8);
    expect(smoothedNoShowRate(-1, -5)).toBe(0.5); // garbage in, clamped
  });

  it('computes whole years of age, 0 when unknown', () => {
    expect(ageAt(new Date('1990-06-15T00:00:00Z'), new Date('2026-06-14T00:00:00Z'))).toBe(35);
    expect(ageAt(new Date('1990-06-15T00:00:00Z'), new Date('2026-06-16T00:00:00Z'))).toBe(36);
    expect(ageAt(null, new Date())).toBe(0);
    expect(ageAt(new Date('2030-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });

  it('extracts the documented vector in clinic wall-clock time', () => {
    // 2026-10-14 is a Wednesday; 07:30Z = 10:30 in Riyadh (UTC+3).
    const startsAt = new Date('2026-10-14T07:30:00.000Z');
    const f = extractNoShowFeatures({
      startsAt,
      createdAt: new Date('2026-10-04T07:30:00.000Z'),
      type: 'FOLLOW_UP',
      timeZone: 'Asia/Riyadh',
      patientDateOfBirth: new Date('1980-01-01T00:00:00Z'),
      patientPastAppointments: 4,
      patientPastNoShows: 1,
      patientLastVisitAt: new Date('2026-09-14T07:30:00.000Z'),
    });
    expect(f).toHaveLength(NO_SHOW_FEATURE_NAMES.length);
    const byName = Object.fromEntries(NO_SHOW_FEATURE_NAMES.map((n, i) => [n, f[i]]));
    expect(byName.historicalNoShowRate).toBeCloseTo(2 / 6);
    expect(byName.pastAppointments).toBe(4);
    expect(byName.leadTimeDays).toBe(10);
    expect(byName.hourOfDay).toBe(10.5);
    expect(byName.weekday).toBe(3);
    expect(byName.isFollowUp).toBe(1);
    expect(byName.patientAge).toBe(46);
    expect(byName.daysSinceLastVisit).toBe(30);
  });

  it('caps lead time and days since last visit, and treats unknowns as defaults', () => {
    const startsAt = new Date('2026-10-14T07:30:00.000Z');
    const f = extractNoShowFeatures({
      startsAt,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      type: 'CONSULTATION',
      timeZone: 'UTC',
      patientDateOfBirth: null,
      patientPastAppointments: 0,
      patientPastNoShows: 0,
      patientLastVisitAt: null,
    });
    expect(f[2]).toBe(365);
    expect(f[5]).toBe(0);
    expect(f[6]).toBe(0);
    expect(f[7]).toBe(365);
    // Booked after the start (data entry) → lead time clamps at 0.
    expect(extractNoShowFeatures({ startsAt, createdAt: new Date(startsAt.getTime() + 1000), type: 'X', timeZone: 'UTC', patientDateOfBirth: null, patientPastAppointments: 0, patientPastNoShows: 0, patientLastVisitAt: null })[2]).toBe(0);
  });

  it('builds the patient history strictly before a point in time', () => {
    const rows = [
      { patientId: 'p', startsAt: new Date('2026-01-01T00:00:00Z'), status: 'COMPLETED' },
      { patientId: 'p', startsAt: new Date('2026-03-01T00:00:00Z'), status: 'NO_SHOW' },
      { patientId: 'p', startsAt: new Date('2026-02-01T00:00:00Z'), status: 'COMPLETED' },
      { patientId: 'p', startsAt: new Date('2026-04-01T00:00:00Z'), status: 'CANCELLED' },
      { patientId: 'p', startsAt: new Date('2026-05-01T00:00:00Z'), status: 'COMPLETED' },
    ];
    const h = patientHistoryBefore(rows, new Date('2026-04-15T00:00:00Z'));
    expect(h).toEqual({ pastAppointments: 3, pastNoShows: 1, lastVisitAt: new Date('2026-02-01T00:00:00Z') });
    expect(patientHistoryBefore(rows, new Date('2026-01-01T00:00:00Z'))).toEqual({ pastAppointments: 0, pastNoShows: 0, lastVisitAt: null });
  });
});
