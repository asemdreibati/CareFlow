import { describe, expect, it } from 'vitest';
import { isSocketAuthError, jwtExpired } from './notifications-socket.service';

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ sub: 'u', exp })).replace(/=+$/, '')}.s`;

describe('notifications socket auth recovery helpers', () => {
  it('recognises handshake rejections caused by the token', () => {
    expect(isSocketAuthError(new Error('Unauthorized'))).toBe(true);
    expect(isSocketAuthError({ message: 'x', data: { status: 401 } })).toBe(true);
    expect(isSocketAuthError({ message: 'jwt expired' })).toBe(true);
    expect(isSocketAuthError(new Error('xhr poll error'))).toBe(false);
  });

  it('detects an expired access token from its exp claim', () => {
    const now = Date.UTC(2026, 9, 7, 12);
    expect(jwtExpired(jwt(now / 1000 - 60), now)).toBe(true);
    expect(jwtExpired(jwt(now / 1000 + 3600), now)).toBe(false);
    expect(jwtExpired('opaque', now)).toBe(false);
    expect(jwtExpired(null, now)).toBe(false);
  });
});
