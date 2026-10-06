import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authInterceptor } from '../core/auth.interceptor';
import { AuthService } from '../core/auth.service';
import { PortalApi } from './portal-api.service';
import { PortalAuthService } from './portal-auth.service';
import { PORTAL_TOKEN_KEY, isPortalPublicUrl, isPortalUrl, portalHeaders, portalLoginPath } from './portal-url';

describe('portal URL / token header rule (pure)', () => {
  it('recognises portal URLs', () => {
    expect(isPortalUrl('/api/v1/portal/me')).toBe(true);
    expect(isPortalUrl('http://localhost:3000/api/v1/portal/appointments?scope=upcoming')).toBe(true);
    expect(isPortalUrl('/api/v1/patients')).toBe(false);
    expect(isPortalUrl('/api/v1/portalx/me')).toBe(false);
  });
  it('treats only request-otp and verify as public', () => {
    expect(isPortalPublicUrl('/api/v1/portal/auth/request-otp')).toBe(true);
    expect(isPortalPublicUrl('/api/v1/portal/auth/verify')).toBe(true);
    expect(isPortalPublicUrl('/api/v1/portal/auth/verify?x=1')).toBe(true);
    expect(isPortalPublicUrl('/api/v1/portal/me')).toBe(false);
  });
  it('attaches the bearer token to protected portal URLs only', () => {
    expect(portalHeaders('/api/v1/portal/me', 'tok')).toEqual({ Authorization: 'Bearer tok' });
    expect(portalHeaders('/api/v1/portal/auth/request-otp', 'tok')).toEqual({});
    expect(portalHeaders('/api/v1/patients', 'tok')).toEqual({});
    expect(portalHeaders('/api/v1/portal/me', null)).toEqual({});
    expect(portalHeaders('/api/v1/portal/appointments', 'tok', { 'Idempotency-Key': 'k1', 'X-None': undefined })).toEqual({ Authorization: 'Bearer tok', 'Idempotency-Key': 'k1' });
  });
  it('builds the login path with or without a clinic slug', () => {
    expect(portalLoginPath('demo-clinic')).toEqual(['/portal', 'demo-clinic', 'login']);
    expect(portalLoginPath(null)).toEqual(['/portal', 'login']);
  });
});

describe('portal requests through the HTTP stack', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let staff: AuthService;
  let portalAuth: PortalAuthService;
  let api: PortalApi;
  let router: Router;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([]), provideTranslateService()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    staff = TestBed.inject(AuthService);
    portalAuth = TestBed.inject(PortalAuthService);
    api = TestBed.inject(PortalApi);
    router = TestBed.inject(Router);
    staff.tokens.set({ accessToken: 'staff-token', refreshToken: 'r1', expiresIn: '8h' });
  });
  afterEach(() => ctrl.verify());

  it('staff interceptor skips /api/v1/portal/ URLs (no staff token, no refresh on 401)', () => {
    let status = 0;
    http.get('/api/v1/portal/me').subscribe({ error: (e) => (status = e.status) });
    const req = ctrl.expectOne('/api/v1/portal/me');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
    ctrl.expectNone('/api/v1/auth/refresh');
    expect(status).toBe(401);
    expect(staff.token()).toBe('staff-token');
  });

  it('staff interceptor still attaches the staff token to non-portal URLs', () => {
    http.get('/api/v1/patients').subscribe();
    const req = ctrl.expectOne('/api/v1/patients');
    expect(req.request.headers.get('Authorization')).toBe('Bearer staff-token');
    req.flush({ items: [] });
  });

  it('PortalApi sets the portal bearer token (not the staff one) and the Idempotency-Key on booking', () => {
    portalAuth.token.set('patient-token');
    api.book({ doctorId: 'd1', startsAt: '2026-10-07T09:00:00.000Z' }, 'idem-1').subscribe();
    const req = ctrl.expectOne('/api/v1/portal/appointments');
    expect(req.request.headers.get('Authorization')).toBe('Bearer patient-token');
    expect(req.request.headers.get('Idempotency-Key')).toBe('idem-1');
    expect(req.request.body).toEqual({ doctorId: 'd1', startsAt: '2026-10-07T09:00:00.000Z' });
    req.flush({ id: 'a1' });
  });

  it('PortalApi sends OTP requests without any token', () => {
    portalAuth.token.set('patient-token');
    api.requestOtp('demo-clinic', '0501111111').subscribe();
    const req = ctrl.expectOne('/api/v1/portal/auth/request-otp');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.body).toEqual({ clinicSlug: 'demo-clinic', phone: '0501111111' });
    req.flush({ sent: true });
  });

  it('verify stores the token under cf.portal.token and remembers the clinic slug', () => {
    api.verify('demo-clinic', '0501111111', '123456').subscribe();
    ctrl.expectOne('/api/v1/portal/auth/verify').flush({
      accessToken: 'jwt-1', patient: { id: 'p1', firstName: 'Nora', lastName: 'Ali', locale: 'ar' }, clinic: { name: 'Demo', slug: 'demo-clinic', timezone: 'Asia/Riyadh', currency: 'SAR' },
    });
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe('jwt-1');
    expect(portalAuth.clinicSlug()).toBe('demo-clinic');
    expect(portalAuth.patientName()).toBe('Nora Ali');
    expect(staff.token()).toBe('staff-token');
  });

  it('a 401 on a portal call clears the portal session and navigates to the clinic login', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    portalAuth.token.set('patient-token');
    portalAuth.rememberSlug('demo-clinic');
    let status = 0;
    api.me().subscribe({ error: (e) => (status = e.status) });
    ctrl.expectOne('/api/v1/portal/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(status).toBe(401);
    expect(portalAuth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/portal', 'demo-clinic', 'login'], { queryParams: { expired: 1 } });
  });

  it('falls back to the unfiltered list when the scope query is rejected', () => {
    portalAuth.token.set('patient-token');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    let result: unknown[] = [];
    api.appointments('upcoming').subscribe((r) => (result = r));
    ctrl.expectOne((r) => r.url === '/api/v1/portal/appointments' && r.params.get('scope') === 'upcoming').flush({ message: 'bad' }, { status: 400, statusText: 'Bad Request' });
    ctrl.expectOne((r) => r.url === '/api/v1/portal/appointments' && !r.params.has('scope')).flush([
      { id: 'a', startsAt: future, endsAt: future, status: 'SCHEDULED' }, { id: 'b', startsAt: past, endsAt: past, status: 'COMPLETED' },
    ]);
    expect(result.map((a) => (a as { id: string }).id)).toEqual(['a']);
  });
});
