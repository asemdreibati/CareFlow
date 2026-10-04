import { ConfigService } from '@nestjs/config';
import { FieldEncryptionService } from './field-encryption.service.js';

function make(key: string) {
  return new FieldEncryptionService({ get: () => key } as unknown as ConfigService);
}

describe('FieldEncryptionService', () => {
  it('round-trips and masks values', () => {
    const svc = make('test-key');
    const enc = svc.encrypt('123456789')!;
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('123456789');
    expect(svc.decrypt(enc)).toBe('123456789');
    expect(svc.mask(enc)).toBe('*****6789');
  });

  it('produces different ciphertexts for the same plaintext', () => {
    const svc = make('test-key');
    expect(svc.encrypt('abc')).not.toBe(svc.encrypt('abc'));
  });

  it('fails to decrypt with a different key', () => {
    const enc = make('k1').encrypt('secret')!;
    expect(() => make('k2').decrypt(enc)).toThrow();
  });

  it('handles empty values', () => {
    const svc = make('k');
    expect(svc.encrypt('')).toBeNull();
    expect(svc.decrypt(null)).toBeNull();
    expect(svc.mask(undefined)).toBeNull();
  });
});
