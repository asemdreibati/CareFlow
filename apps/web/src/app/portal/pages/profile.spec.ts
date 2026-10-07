import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { PortalAuthService } from '../portal-auth.service';
import { PortalProfilePage, profilePatch } from './profile';

function open(me: { email: string | null; address: string | null }) {
  localStorage.clear();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
  const ctrl = TestBed.inject(HttpTestingController);
  TestBed.inject(PortalAuthService).token.set('ptok');
  const page = TestBed.createComponent(PortalProfilePage).componentInstance;
  ctrl.match(() => true).forEach((r) => r.flush(r.request.url.endsWith('/me') ? { id: 'p', firstName: 'a', lastName: 'b', ...me, consents: [] } : []));
  return { ctrl, page };
}

describe('Portal profile save', () => {
  it('omits an empty email instead of sending "" (API rejects it)', () => {
    const { ctrl, page } = open({ email: null, address: null });
    page.address = 'Riyadh';
    page.save();
    const body = ctrl.expectOne((r) => r.method === 'PATCH').request.body;
    expect('email' in body).toBe(false);
    expect(body.address).toBe('Riyadh');
  });

  it('sends null when the patient cleared an existing email', () => {
    const { ctrl, page } = open({ email: 'nora@example.com', address: 'Riyadh' });
    expect(page.email).toBe('nora@example.com');
    page.email = '  ';
    page.save();
    const body = ctrl.expectOne((r) => r.method === 'PATCH').request.body;
    expect(body.email).toBeNull();
    expect(body.address).toBe('Riyadh');
  });

  it('profilePatch: trims filled values, omits untouched empties, nulls cleared ones', () => {
    expect(profilePatch('ar', { email: ' a@b.co ', address: '' }, { email: '', address: 'x' })).toEqual({ locale: 'ar', email: 'a@b.co', address: null });
    expect(profilePatch('en', { email: '', address: '' }, { email: '', address: '' })).toEqual({ locale: 'en' });
  });

  it('changing the language from the profile saves it on the patient only, never on the staff account', () => {
    const { ctrl, page } = open({ email: null, address: null });
    // Same browser also holds a staff session.
    TestBed.inject(AuthService).tokens.set({ accessToken: 'staff', refreshToken: 'r', expiresIn: '8h' });
    page.setLocale(page.locale() === 'ar' ? 'en' : 'ar');
    expect(ctrl.match((r) => r.url === '/api/v1/auth/me').length).toBe(0);
    expect(ctrl.match((r) => r.method === 'PATCH' && r.url.endsWith('/portal/me')).length).toBe(1);
  });
});
