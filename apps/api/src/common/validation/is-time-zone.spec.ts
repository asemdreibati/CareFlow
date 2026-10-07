import { isTimeZone } from './is-time-zone.js';

describe('isTimeZone', () => {
  it('accepts IANA zones and UTC', () => {
    for (const tz of ['Asia/Riyadh', 'Europe/Berlin', 'America/New_York', 'UTC']) expect(isTimeZone(tz)).toBe(true);
  });
  it('rejects unknown or malformed values', () => {
    for (const tz of ['Not/AZone', '', 'Asia/Riyadh; DROP', 42, null, 'x'.repeat(80)]) expect(isTimeZone(tz)).toBe(false);
  });
});
