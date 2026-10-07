import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, SessionChangedError } from './auth.service';
import { clinicTimeZone } from './i18n/locale-registry';
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

describe('AuthService session lifecycle (regressions)', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  let router: Router;
  const rotated = (accessToken: string, refreshToken: string, tz = 'UTC') => ({
    tokens: { accessToken, refreshToken, expiresIn: '8h' },
    session: { ...session, clinic: { ...session.clinic, timezone: tz } },
  });

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    auth.tokens.set({ accessToken: 'old', refreshToken: 'r1', expiresIn: '8h' });
  });

  it('discards a refresh result that arrives after logout (session epoch)', () => {
    let error: unknown;
    auth.refresh().subscribe({ error: (e) => (error = e) });
    const req = http.expectOne('/api/v1/auth/refresh');
    auth.logout(false);
    http.expectOne('/api/v1/auth/logout').flush(null);
    req.flush(rotated('new', 'r2'));
    expect(error).toBeInstanceOf(SessionChangedError);
    expect(auth.token()).toBeNull();
    expect(auth.session()).toBeNull();
    expect(localStorage.getItem('cf.tokens')).toBeNull();
    expect(localStorage.getItem('cf.session')).toBeNull();
  });

  it('applies a refresh that completes within the same session', () => {
    auth.refresh().subscribe();
    http.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    expect(auth.token()).toBe('new');
    expect(JSON.parse(localStorage.getItem('cf.tokens')!).refreshToken).toBe('r2');
  });

  it('refreshShared deduplicates concurrent callers', () => {
    const seen: string[] = [];
    auth.refreshShared().subscribe((r) => seen.push(r.tokens.accessToken));
    auth.refreshShared().subscribe((r) => seen.push(r.tokens.accessToken));
    http.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    expect(seen).toEqual(['new', 'new']);
    auth.refreshShared().subscribe();
    http.expectOne('/api/v1/auth/refresh').flush(rotated('n3', 'r3'));
    http.verify();
  });

  it('mirrors token rotation from another tab (storage event)', () => {
    const next = { accessToken: 'tab2', refreshToken: 'r5', expiresIn: '8h' };
    window.dispatchEvent(new StorageEvent('storage', { key: 'cf.tokens', newValue: JSON.stringify(next) }));
    expect(auth.tokens()).toEqual(next);
    window.dispatchEvent(new StorageEvent('storage', { key: 'cf.session', newValue: JSON.stringify(session) }));
    expect(auth.session()?.clinic.id).toBe('c1');
  });

  it('logs out when another tab logs out, and a refresh in flight is discarded', () => {
    auth.session.set(session);
    let error: unknown;
    auth.refresh().subscribe({ error: (e) => (error = e) });
    window.dispatchEvent(new StorageEvent('storage', { key: 'cf.tokens', newValue: null }));
    expect(auth.token()).toBeNull();
    expect(auth.session()).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
    http.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    expect(error).toBeInstanceOf(SessionChangedError);
    expect(auth.token()).toBeNull();
  });

  it('syncFromStorage adopts newer stored tokens but never clears on a missing entry', () => {
    auth.syncFromStorage();
    expect(auth.token()).toBe('old');
    localStorage.setItem('cf.tokens', JSON.stringify({ accessToken: 'stored', refreshToken: 'r7', expiresIn: '8h' }));
    auth.syncFromStorage();
    expect(auth.token()).toBe('stored');
  });

  it('publishes the session clinic timezone as the active clinic timezone', () => {
    auth.session.set({ ...session, clinic: { ...session.clinic, timezone: 'Asia/Riyadh' } });
    expect(clinicTimeZone()).toBe('Asia/Riyadh');
    auth.clear();
    expect(clinicTimeZone()).toBeNull();
  });
});
