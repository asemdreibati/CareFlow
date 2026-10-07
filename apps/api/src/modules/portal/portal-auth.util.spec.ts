import { describe, expect, it } from 'vitest';
import { maskPatientName, padLatency } from './portal-auth.util.js';

describe('maskPatientName', () => {
  it('shows the first initial and a masked last name only', () => {
    expect(maskPatientName('Sara', 'Patient')).toBe('S. P***');
    expect(maskPatientName('سارة', 'العتيبي')).toBe('س. ا***');
    expect(maskPatientName('', '')).toBe('***');
  });
});

describe('padLatency', () => {
  it('waits until the minimum latency has elapsed', async () => {
    const started = Date.now();
    await padLatency(started, 60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
  it('does not wait when the work already took longer', async () => {
    const t = Date.now();
    await padLatency(t - 1000, 60);
    expect(Date.now() - t).toBeLessThan(30);
  });
});
