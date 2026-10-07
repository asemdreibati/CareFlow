import { describe, expect, it } from 'vitest';
import { clean, clearedToNull } from './http-utils';

describe('clean / clearedToNull', () => {
  it('omits empty optional fields (create) and nulls only the ones the user cleared (edit)', () => {
    const values = { phone: '', email: '', notes: '  ', address: 'Riyadh' };
    const original = { phone: '+966500000000', email: null, notes: 'old', address: 'Jeddah' };
    expect(clean(values)).toEqual({ notes: '  ', address: 'Riyadh' });
    expect(clearedToNull(values, original, ['phone', 'email', 'notes', 'address'] as const)).toEqual({ phone: null, notes: null });
    expect(clearedToNull(values, null, ['phone'] as const)).toEqual({});
  });
});
