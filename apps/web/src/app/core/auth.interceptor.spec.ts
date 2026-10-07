import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;
  let router: Router;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    router = TestBed.inject(Router);
    auth.tokens.set({ accessToken: 'old', refreshToken: 'r1', expiresIn: '8h' });
  });

  it('adds the bearer token to API requests', () => {
    http.get('/api/v1/patients').subscribe();
    const req = ctrl.expectOne('/api/v1/patients');
    expect(req.request.headers.get('Authorization')).toBe('Bearer old');
    req.flush({ items: [] });
    ctrl.verify();
  });

  it('refreshes once on 401 and retries with the new token', () => {
    const results: unknown[] = [];
    http.get('/api/v1/patients').subscribe((r) => results.push(r));

    ctrl.expectOne('/api/v1/patients').flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });

    const refresh = ctrl.expectOne('/api/v1/auth/refresh');
    expect(refresh.request.body).toEqual({ refreshToken: 'r1' });
    expect(refresh.request.headers.has('Authorization')).toBe(false);
    refresh.flush({ tokens: { accessToken: 'new', refreshToken: 'r2', expiresIn: '8h' }, session: { user: {}, clinic: {}, role: 'OWNER', permissions: [], clinics: [] } });

    const retry = ctrl.expectOne('/api/v1/patients');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new');
    retry.flush({ items: [1] });

    expect(results).toEqual([{ items: [1] }]);
    expect(auth.tokens()?.refreshToken).toBe('r2');
    ctrl.verify();
  });

  it('logs out and navigates to /login when the refresh fails', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let error: unknown;
    http.get('/api/v1/patients').subscribe({ error: (e) => (error = e) });

    ctrl.expectOne('/api/v1/patients').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/auth/refresh').flush({ message: 'expired' }, { status: 401, statusText: 'Unauthorized' });

    expect(error).toBeTruthy();
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    ctrl.verify();
  });

  it('does not try to refresh a failed login', () => {
    let status = 0;
    http.post('/api/v1/auth/login', {}).subscribe({ error: (e) => (status = e.status) });
    ctrl.expectOne('/api/v1/auth/login').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectNone('/api/v1/auth/refresh');
    expect(status).toBe(401);
    ctrl.verify();
  });

  // ---- Regressions (review findings) ----
  const session = { user: {}, clinic: {}, role: 'OWNER', permissions: [], clinics: [] };
  const rotated = (accessToken: string, refreshToken: string) => ({ tokens: { accessToken, refreshToken, expiresIn: '8h' }, session });

  it('propagates an error of the retried request untouched and keeps the session (409 after a successful refresh)', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let status = 0;
    http.post('/api/v1/appointments', {}).subscribe({ error: (e) => (status = e.status) });
    ctrl.expectOne('/api/v1/appointments').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    ctrl.expectOne('/api/v1/appointments').flush({ message: 'Slot taken' }, { status: 409, statusText: 'Conflict' });
    expect(status).toBe(409);
    expect(auth.token()).toBe('new');
    expect(navigate).not.toHaveBeenCalled();
    ctrl.verify();
  });

  it.each([400, 404, 500])('does not log out when the retried request fails with %i', (code) => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let status = 0;
    http.get('/api/v1/patients/x').subscribe({ error: (e) => (status = e.status) });
    ctrl.expectOne('/api/v1/patients/x').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    ctrl.expectOne('/api/v1/patients/x').flush({}, { status: code, statusText: 'err' });
    expect(status).toBe(code);
    expect(auth.token()).toBe('new');
    expect(navigate).not.toHaveBeenCalled();
    ctrl.verify();
  });

  it('a late 401 for a request sent with the old token retries with the current token instead of refreshing again', () => {
    http.get('/api/v1/a').subscribe({ error: () => undefined });
    http.get('/api/v1/b').subscribe({ error: () => undefined });
    ctrl.expectOne('/api/v1/a').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    ctrl.expectOne('/api/v1/a').flush({});
    ctrl.expectOne('/api/v1/b').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectNone('/api/v1/auth/refresh');
    const retry = ctrl.expectOne('/api/v1/b');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer new');
    retry.flush({});
    ctrl.verify();
  });

  it('retries with the token another tab stored instead of refreshing with a rotated refresh token', () => {
    let result: unknown;
    http.get('/api/v1/patients').subscribe((r) => (result = r));
    // Tab B refreshed meanwhile; its storage event has not reached us yet.
    localStorage.setItem('cf.tokens', JSON.stringify({ accessToken: 'other-tab', refreshToken: 'r9', expiresIn: '8h' }));
    ctrl.expectOne('/api/v1/patients').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectNone('/api/v1/auth/refresh');
    const retry = ctrl.expectOne('/api/v1/patients');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer other-tab');
    retry.flush({ ok: true });
    expect(result).toEqual({ ok: true });
    expect(auth.tokens()?.refreshToken).toBe('r9');
    ctrl.verify();
  });

  it('a refresh that loses the race against another tab adopts that tab\'s tokens instead of logging out', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let result: unknown;
    http.get('/api/v1/patients').subscribe((r) => (result = r));
    ctrl.expectOne('/api/v1/patients').flush({}, { status: 401, statusText: 'Unauthorized' });
    const refresh = ctrl.expectOne('/api/v1/auth/refresh');
    localStorage.setItem('cf.tokens', JSON.stringify({ accessToken: 'other-tab', refreshToken: 'r9', expiresIn: '8h' }));
    refresh.flush({ message: 'reused' }, { status: 401, statusText: 'Unauthorized' });
    const retry = ctrl.expectOne('/api/v1/patients');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer other-tab');
    retry.flush({ ok: true });
    expect(result).toEqual({ ok: true });
    expect(navigate).not.toHaveBeenCalled();
    ctrl.verify();
  });

  it('concurrent 401s share a single refresh', () => {
    http.get('/api/v1/a').subscribe({ error: () => undefined });
    http.get('/api/v1/b').subscribe({ error: () => undefined });
    ctrl.expectOne('/api/v1/a').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/b').flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectOne('/api/v1/auth/refresh').flush(rotated('new', 'r2'));
    for (const url of ['/api/v1/a', '/api/v1/b']) {
      const retry = ctrl.expectOne(url);
      expect(retry.request.headers.get('Authorization')).toBe('Bearer new');
      retry.flush({});
    }
    ctrl.verify();
  });

  it('logout during an in-flight refresh does not resurrect the session', () => {
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
    let error: unknown;
    http.get('/api/v1/patients').subscribe({ error: (e) => (error = e) });
    ctrl.expectOne('/api/v1/patients').flush({}, { status: 401, statusText: 'Unauthorized' });
    const refresh = ctrl.expectOne('/api/v1/auth/refresh');
    auth.logout();
    ctrl.expectOne('/api/v1/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    refresh.flush(rotated('new', 'r2'));
    expect(auth.token()).toBeNull();
    expect(auth.session()).toBeNull();
    expect(localStorage.getItem('cf.tokens')).toBeNull();
    expect(error).toBeTruthy();
    ctrl.expectNone('/api/v1/patients');
    ctrl.verify();
  });
});
