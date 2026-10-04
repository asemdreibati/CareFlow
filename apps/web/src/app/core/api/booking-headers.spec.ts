import { describe, expect, it } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';
import { bookingHeaderMap, bookingHttpHeaders, isResourceConflict, isVersionConflict, newIdempotencyKey } from './booking-headers';

describe('newIdempotencyKey', () => {
  it('produces unique RFC-4122 uuids', () => {
    const a = newIdempotencyKey(); const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

describe('bookingHeaderMap', () => {
  it('sends Idempotency-Key only when a key is given', () => {
    expect(bookingHeaderMap({ idempotencyKey: 'k-1' })).toEqual({ 'Idempotency-Key': 'k-1' });
    expect(bookingHeaderMap({ idempotencyKey: null })).toEqual({});
    expect(bookingHeaderMap()).toEqual({});
  });
  it('sends If-Match only when the appointment carries a numeric version', () => {
    expect(bookingHeaderMap({ version: 3 })).toEqual({ 'If-Match': '3' });
    expect(bookingHeaderMap({ version: 0 })).toEqual({ 'If-Match': '0' });
    expect(bookingHeaderMap({ version: undefined })).toEqual({});
    expect(bookingHeaderMap({ version: null })).toEqual({});
    expect(bookingHeaderMap({ version: Number.NaN })).toEqual({});
  });
  it('combines both headers and exposes them as HttpHeaders', () => {
    const h = bookingHttpHeaders({ idempotencyKey: 'abc', version: 7 });
    expect(h.get('Idempotency-Key')).toBe('abc');
    expect(h.get('If-Match')).toBe('7');
  });
});

describe('conflict classification', () => {
  const err = (status: number, message: string | string[]) => new HttpErrorResponse({ status, error: { statusCode: status, message } });
  it('detects the optimistic-locking 409', () => {
    expect(isVersionConflict(err(409, 'Appointment was modified by someone else (version 4)'))).toBe(true);
    expect(isVersionConflict(err(409, 'Doctor already has an appointment in this slot'))).toBe(false);
    expect(isVersionConflict(err(400, 'version'))).toBe(false);
    expect(isVersionConflict(new Error('x'))).toBe(false);
  });
  it('detects resource conflicts', () => {
    expect(isResourceConflict(err(409, 'Resource "Room 2" is not available'))).toBe(true);
    expect(isResourceConflict(err(409, ['Resource "X-ray" is not available']))).toBe(true);
    expect(isResourceConflict(err(409, 'Appointment was modified by someone else (version 2)'))).toBe(false);
  });
});
