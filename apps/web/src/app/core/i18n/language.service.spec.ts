import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../auth.service';
import { Session } from '../models';
import { LanguageService } from './language.service';

const session = (locale: 'ar' | 'en' | null): Session => ({
  user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', locale },
  clinic: { id: 'c1', name: 'Clinic', slug: 'clinic', timezone: 'UTC', currency: 'SAR' },
  role: 'OWNER', permissions: [], clinics: [],
});

describe('LanguageService', () => {
  let lang: LanguageService;
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('dir');
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', { common: { units: { d: 'd', h: 'h', m: 'm', s: 's', minutes: '{{n}} minutes' }, error: 'Something went wrong' }, enums: { status: { PAID: 'Paid' } }, errors: { versionConflict: 'Modified elsewhere', resourceBusy: 'Resource "{{name}}" busy', notFound: 'Not found', network: 'Offline' } });
    translate.setTranslation('ar', { common: { units: { d: 'ي', h: 'س', m: 'د', s: 'ث', minutes: '{{n}} دقيقة' }, error: 'حدث خطأ ما' }, enums: { status: { PAID: 'مدفوعة' } }, errors: { versionConflict: 'عُدّل', resourceBusy: 'المورد «{{name}}» مشغول', notFound: 'غير موجود', network: 'غير متصل' } });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    lang = TestBed.inject(LanguageService);
    TestBed.flushEffects();
  });

  it('defaults to Arabic/RTL and applies lang + dir on <html>', () => {
    expect(lang.locale()).toBe('ar');
    expect(lang.dir()).toBe('rtl');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
  });

  it('switches immediately, flips dir and persists in localStorage', () => {
    lang.set('en');
    TestBed.flushEffects();
    expect(lang.dir()).toBe('ltr');
    expect(lang.isRtl()).toBe(false);
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(localStorage.getItem('cf.locale')).toBe('en');
    expect(lang.t('enums.status.PAID')).toBe('Paid');
    lang.toggle();
    TestBed.flushEffects();
    expect(lang.locale()).toBe('ar');
    expect(lang.t('enums.status.PAID')).toBe('مدفوعة');
  });

  it('restores the persisted locale on startup', () => {
    localStorage.setItem('cf.locale', 'en');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    expect(TestBed.inject(LanguageService).locale()).toBe('en');
  });

  it('applies session.user.locale after login and saves an explicit switch via PATCH /auth/me', () => {
    auth.session.set(session('en'));
    TestBed.flushEffects();
    expect(lang.locale()).toBe('en');
    http.expectNone('/api/v1/auth/me');

    auth.tokens.set({ accessToken: 't', refreshToken: 'r', expiresIn: '8h' });
    lang.set('ar');
    TestBed.flushEffects();
    const req = http.expectOne({ method: 'PATCH', url: '/api/v1/auth/me' });
    expect(req.request.body).toEqual({ locale: 'ar' });
    expect(auth.session()?.user.locale).toBe('ar');
    req.flush(session('ar'));
    expect(lang.locale()).toBe('ar');
    http.verify();
  });

  it('does not call the API when signed out', () => {
    lang.set('en');
    TestBed.flushEffects();
    http.expectNone('/api/v1/auth/me');
    http.verify();
  });

  it('labels enums and maps API errors in the active language', () => {
    expect(lang.enumLabel('PAID', 'status')).toBe('مدفوعة');
    expect(lang.enumLabel('SOMETHING_ELSE')).toBe('Something Else');
    expect(lang.enumLabel(null)).toBe('—');
    expect(lang.errorMessage(new Error('boom'))).toBe('boom');
    expect(lang.errorMessage(null)).toBe('حدث خطأ ما');
  });
});
