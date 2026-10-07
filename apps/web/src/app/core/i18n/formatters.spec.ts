import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageService } from './language.service';
import { mapApiError } from './api-errors';
import { fmtDate, age } from '../date-utils';
import { money } from '../money';

const d = new Date(2026, 9, 6, 14, 5); // Tue 6 Oct 2026, 14:05 local
/** Intl may use a non-breaking space between code and amount. */
const nbsp = (s: string) => s.replace(/\u00a0/g, ' ');

describe('LanguageService formatters', () => {
  let lang: LanguageService;
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    TestBed.inject(TranslateService).setTranslation('ar', { common: { units: { d: 'ي', h: 'س', m: 'د', s: 'ث', minutes: '{{n}} دقيقة' } } });
    TestBed.inject(TranslateService).setTranslation('en', { common: { units: { d: 'd', h: 'h', m: 'm', s: 's', minutes: '{{n}} minutes' } } });
    lang = TestBed.inject(LanguageService);
    TestBed.flushEffects();
  });

  it('formats dates in English (en-GB, 24h)', () => {
    lang.set('en');
    TestBed.flushEffects();
    expect(lang.formatDate(d)).toBe('06 Oct 2026');
    expect(lang.formatDateTime(d)).toBe('06 Oct 2026, 14:05');
    expect(lang.formatTime(d)).toBe('14:05');
    expect(lang.formatLongDate(d)).toBe('Tuesday, 6 October 2026');
    expect(lang.formatWeekdayDate(d)).toBe('Tue 06 Oct');
    expect(lang.formatTimeRange(d, new Date(2026, 9, 6, 14, 35))).toBe('\u206614:05–14:35\u2069');
    expect(lang.weekdayNames('short')).toEqual(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(lang.monthNames('long')[0]).toBe('January');
    expect(lang.formatMinutes(30)).toBe('30 minutes');
    expect(lang.formatRemaining(3 * 3600_000 + 5 * 60_000)).toBe('3h 05m');
  });

  it('formats dates in Arabic with Latin digits, Gregorian months and a 24h clock', () => {
    lang.set('ar');
    TestBed.flushEffects();
    expect(lang.formatDate(d)).toBe('06 أكتوبر 2026');
    expect(lang.formatTime(d)).toBe('14:05');
    expect(lang.formatDateTime(d)).toContain('أكتوبر');
    expect(lang.formatDateTime(d)).toContain('14:05');
    expect(lang.formatLongDate(d)).toContain('الثلاثاء');
    expect(lang.weekdayNames('long')[5]).toBe('الجمعة');
    expect(lang.monthNames('long')[0]).toBe('يناير');
    expect(lang.formatMinutes(30)).toBe('30 دقيقة');
    expect(lang.formatRemaining(26 * 3600_000)).toBe('1ي 2س');
    expect(lang.formatDate(d)).not.toMatch(/[٠-٩]/);
  });

  it('formats numbers, money and percentages with Latin digits in both languages', () => {
    lang.set('en');
    TestBed.flushEffects();
    expect(nbsp(lang.formatMoney(1234.5, 'SAR'))).toBe('SAR 1,234.50');
    expect(lang.formatNumber(1234567.891)).toBe('1,234,567.891');
    expect(lang.formatPercent(0.62)).toBe('62%');
    expect(nbsp(money(1234.5, 'SAR'))).toBe('SAR 1,234.50');
    lang.set('ar');
    TestBed.flushEffects();
    const m = lang.formatMoney('1234.5', 'SAR');
    expect(m).toContain('1,234.50');
    expect(m).toContain('SAR');
    expect(m).not.toMatch(/[٠-٩]/);
    expect(lang.formatPercent(0.62)).toContain('62');
    expect(money('abc')).toBe('—');
    expect(lang.formatNumber(null)).toBe('—');
  });

  it('returns a dash for missing dates and keeps date-utils locale-aware', () => {
    expect(lang.formatDate(null)).toBe('—');
    expect(lang.formatDateTime(undefined)).toBe('—');
    expect(lang.formatDate('not a date')).toBe('—');
    lang.set('ar');
    TestBed.flushEffects();
    expect(fmtDate(d, 'dd MMMM yyyy')).toBe('06 أكتوبر 2026');
    lang.set('en');
    TestBed.flushEffects();
    expect(fmtDate(d)).toBe('06 Oct 2026');
    expect(age(null)).toBe('—');
  });
});

describe('mapApiError', () => {
  const t = (k: string, p?: Record<string, unknown>) => `${k}${p ? ':' + JSON.stringify(p) : ''}`;
  const http = (status: number, message?: string | string[]) => new HttpErrorResponse({ status, error: message === undefined ? null : { message } });

  it('maps known server messages and statuses to translation keys', () => {
    expect(mapApiError(http(409, 'Appointment was modified by someone else (version 3)'), t)).toBe('errors.versionConflict');
    expect(mapApiError(http(409, 'Resource "Room 2" is not available'), t)).toBe('errors.resourceBusy:{"name":"Room 2"}');
    expect(mapApiError(http(409, 'This time slot overlaps another appointment for the doctor'), t)).toBe('errors.slotOverlap');
    expect(mapApiError(http(401, 'Invalid credentials'), t)).toBe('errors.invalidCredentials');
    expect(mapApiError(http(403, 'Missing permission: billing:write'), t)).toBe('errors.forbidden');
    expect(mapApiError(http(404, 'Patient not found'), t)).toBe('errors.notFound');
    expect(mapApiError(http(429), t)).toBe('errors.rateLimited');
    expect(mapApiError(http(500), t)).toBe('errors.server');
    expect(mapApiError(http(0), t)).toBe('errors.network');
  });

  it('falls back to the raw server message for validation lists and unknown conflicts', () => {
    expect(mapApiError(http(400, ['email must be an email', 'firstName should not be empty']), t)).toBe('email must be an email\nfirstName should not be empty');
    expect(mapApiError(http(409, 'Something very specific'), t)).toBe('Something very specific');
    expect(mapApiError(new Error('boom'), t)).toBe('boom');
    expect(mapApiError('?', t, 'fallback')).toBe('fallback');
    expect(mapApiError('?', t)).toBe('common.error');
  });
});
