import { describe, expect, it } from 'vitest';
import { createRedactor, phonePattern, redactIdentifiers, REDACTED } from './redaction.js';

const zelda = {
  firstName: 'Zelda',
  lastName: 'Quartermain',
  phone: '0501234567',
  email: 'zelda.q@example.com',
  mrn: 'MRN-000042',
  nationalId: '9876543210',
};

describe('redactIdentifiers', () => {
  it('replaces the full name, each name and is case-insensitive', () => {
    expect(redactIdentifiers('Zelda Quartermain reports low mood; zelda says QUARTERMAIN family history', zelda)).toBe(
      '[PATIENT] reports low mood; [PATIENT] says [PATIENT] family history',
    );
  });

  it('only replaces whole words', () => {
    expect(redactIdentifiers('Zeldabrand tablets', zelda)).toBe('Zeldabrand tablets');
  });

  it('replaces the phone in every usual format', () => {
    const variants = ['0501234567', '+966501234567', '00966501234567', '966501234567', '501234567', '050 123 4567', '050-123-4567', '+966 50 123 4567'];
    for (const v of variants) expect(redactIdentifiers(`call ${v} today`, zelda)).toBe(`call ${REDACTED.phone} today`);
    // A stored international number is matched in its national form too.
    expect(redactIdentifiers('reach at 0501234567', { phone: '+966 50 123 4567' })).toBe('reach at [PHONE]');
  });

  it('does not touch unrelated numbers', () => {
    expect(redactIdentifiers('BP 120/80, HR 72, dose 500mg, ref 15012345678', zelda)).toBe('BP 120/80, HR 72, dose 500mg, ref 15012345678');
    expect(redactIdentifiers('ref 1501234567', zelda)).toBe('ref [PHONE]'); // same 9 significant digits with a 1-digit prefix
  });

  it('replaces e-mail, MRN (with spacing variants) and national id', () => {
    expect(redactIdentifiers('mail Zelda.Q@Example.com', zelda)).toBe('mail [EMAIL]');
    expect(redactIdentifiers('chart MRN-000042 / mrn 000042 / MRN000042', zelda)).toBe('chart [MRN] / [MRN] / [MRN]');
    expect(redactIdentifiers('ID 9876543210 or 9876-543-210', zelda)).toBe('ID [NATIONAL_ID] or [NATIONAL_ID]');
  });

  it('handles Arabic names', () => {
    expect(redactIdentifiers('المريض محمد الأحمد يشكو من صداع', { firstName: 'محمد', lastName: 'الأحمد' })).toBe('المريض [PATIENT] يشكو من صداع');
  });

  it('leaves text alone without identifiers and passes null through', () => {
    expect(redactIdentifiers('Headache', {})).toBe('Headache');
    expect(redactIdentifiers(null, zelda)).toBeNull();
    expect(createRedactor(null)('Zelda')).toBe('Zelda');
  });

  it('escapes regex metacharacters in identifiers', () => {
    expect(redactIdentifiers('a+b (c) aab a.b@x.io axb@x.io', { email: 'a.b@x.io', firstName: 'a+b' })).toBe('[PATIENT] (c) aab [EMAIL] axb@x.io');
  });
});

describe('phonePattern', () => {
  it('ignores numbers that are too short to be a phone', () => {
    expect(phonePattern('12345')).toBeNull();
    expect(phonePattern(null)).toBeNull();
    expect(phonePattern('050123')).toBeNull(); // 5 significant digits
    expect(phonePattern('0501234')).not.toBeNull();
  });
});
