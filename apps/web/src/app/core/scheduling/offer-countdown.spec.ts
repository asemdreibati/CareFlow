import { describe, expect, it } from 'vitest';
import { formatRemaining, offerCountdown } from './offer-countdown';

describe('formatRemaining', () => {
  it('formats days, hours, minutes and seconds', () => {
    expect(formatRemaining(26 * 3600_000 + 5 * 60_000)).toBe('1d 2h');
    expect(formatRemaining(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
    expect(formatRemaining(12 * 60_000 + 30_000)).toBe('12m 30s');
    expect(formatRemaining(45_000)).toBe('45s');
    expect(formatRemaining(-5)).toBe('0s');
  });
});

describe('offerCountdown', () => {
  const now = new Date('2026-10-04T10:00:00Z');
  it('counts down to the expiry and flags the last hour as urgent', () => {
    const c = offerCountdown('2026-10-04T13:30:00Z', now);
    expect(c.expired).toBe(false);
    expect(c.label).toBe('3h 30m');
    expect(c.urgent).toBe(false);
    const u = offerCountdown('2026-10-04T10:20:00Z', now);
    expect(u.urgent).toBe(true);
    expect(u.label).toBe('20m 00s');
  });
  it('reports expiry at or after the deadline', () => {
    expect(offerCountdown('2026-10-04T10:00:00Z', now)).toMatchObject({ expired: true, label: 'Expired', ms: 0 });
    expect(offerCountdown('2026-10-03T10:00:00Z', now.getTime()).expired).toBe(true);
  });
  it('handles missing or invalid deadlines', () => {
    expect(offerCountdown(null, now)).toMatchObject({ expired: true, label: '—' });
    expect(offerCountdown('garbage', now)).toMatchObject({ expired: true, label: '—' });
  });
});
