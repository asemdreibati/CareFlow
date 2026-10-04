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
});
