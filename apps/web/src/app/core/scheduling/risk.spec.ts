import { describe, expect, it } from 'vitest';
import { riskLevel, riskView } from './risk';

describe('no-show risk thresholds', () => {
  it('classifies ≥0.75 as high, ≥0.5 as medium, below as low, missing as none', () => {
    expect(riskLevel(0.75)).toBe('high');
    expect(riskLevel(0.99)).toBe('high');
    expect(riskLevel(0.5)).toBe('medium');
    expect(riskLevel(0.749)).toBe('medium');
    expect(riskLevel(0.49)).toBe('low');
    expect(riskLevel(0)).toBe('low');
    expect(riskLevel(null)).toBe('none');
    expect(riskLevel(undefined)).toBe('none');
    expect(riskLevel(Number.NaN)).toBe('none');
  });
  it('renders badge label, color and percentage', () => {
    expect(riskView(0.8)).toEqual({ level: 'high', label: 'High risk', color: 'red', percent: 80 });
    expect(riskView(0.5)).toEqual({ level: 'medium', label: 'At risk', color: 'amber', percent: 50 });
    expect(riskView(0.123)).toMatchObject({ level: 'low', color: 'green', percent: 12 });
    expect(riskView(null)).toMatchObject({ level: 'none', percent: null });
    expect(riskView(1.4).percent).toBe(100);
  });
});
