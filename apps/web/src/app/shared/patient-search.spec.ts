import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PatientSearchComponent } from './patient-search';

describe('PatientSearchComponent', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps searching after one failed request', () => {
    vi.useFakeTimers();
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    const ctrl = TestBed.inject(HttpTestingController);
    const c = TestBed.createComponent(PatientSearchComponent).componentInstance;

    c.onInput({ target: { value: 'ab' } } as unknown as Event);
    vi.advanceTimersByTime(300);
    ctrl.expectOne((r) => r.url === '/api/v1/patients').flush({}, { status: 500, statusText: 'err' });
    expect(c.loading()).toBe(false);
    expect(c.results()).toEqual([]);

    c.onInput({ target: { value: 'abc' } } as unknown as Event);
    vi.advanceTimersByTime(300);
    const req = ctrl.expectOne((r) => r.url === '/api/v1/patients');
    expect(req.request.params.get('search')).toBe('abc');
    req.flush({ items: [{ id: 'p1', mrn: 'M1', firstName: 'Ab', lastName: 'C' }], total: 1 });
    expect(c.results().map((p) => p.id)).toEqual(['p1']);
    ctrl.verify();
  });
});
