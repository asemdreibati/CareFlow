import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { Session } from './models';

const session: Session = {
  user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B' },
  clinic: { id: 'c1', name: 'Clinic', slug: 'clinic', timezone: 'UTC', currency: 'USD' },
  role: 'DOCTOR', doctorId: 'd1', permissions: ['patients:read', 'records:write'], clinics: [],
};

describe('AuthService.hasPermission', () => {
  let auth: AuthService;
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    auth = TestBed.inject(AuthService);
  });

  it('is false when logged out', () => {
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.hasPermission('patients:read')).toBe(false);
  });

  it('requires every listed permission, hasAny requires one', () => {
    auth.session.set(session);
    expect(auth.hasPermission('patients:read')).toBe(true);
    expect(auth.hasPermission('patients:read', 'records:write')).toBe(true);
    expect(auth.hasPermission('patients:read', 'billing:read')).toBe(false);
    expect(auth.hasAny('billing:read', 'records:write')).toBe(true);
    expect(auth.hasAny('billing:read')).toBe(false);
    expect(auth.doctorId()).toBe('d1');
  });

  it('clears tokens and session on clear()', () => {
    auth.tokens.set({ accessToken: 'x', refreshToken: 'y', expiresIn: '8h' });
    auth.session.set(session);
    auth.clear();
    expect(auth.token()).toBeNull();
    expect(auth.session()).toBeNull();
  });
});
