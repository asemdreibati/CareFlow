import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../core/auth.service';
import { BookingDialogComponent } from './booking-dialog';

describe('BookingDialogComponent series (clinic timezone)', () => {
  it('sends startsOn/startTime/byWeekday derived in session.clinic.timezone, not the browser zone', () => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideTranslateService()] });
    const auth = TestBed.inject(AuthService);
    auth.session.set({
      user: { id: 'u', email: 'a@b.c', firstName: 'A', lastName: 'B' },
      clinic: { id: 'c', name: 'C', slug: 'c', timezone: 'Asia/Riyadh', currency: 'SAR' }, role: 'OWNER', permissions: ['appointments:read_all'], clinics: [],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(BookingDialogComponent);
    fixture.componentRef.setInput('doctors', []);
    const c = fixture.componentInstance;
    c.patient.set({ id: 'p1', mrn: 'M1', firstName: 'N', lastName: 'A' });
    c.doctorId.set('d1');
    c.date.set('2026-10-08');
    // 21:30Z Wed 7 Oct = 00:30 Thu 8 Oct in Riyadh (the test process runs in UTC).
    c.selected.set('2026-10-07T21:30:00.000Z');
    c.repeat.set(true);
    c.frequency.set('WEEKLY');
    c.book();
    const body = http.expectOne((r) => r.method === 'POST' && r.url === '/api/v1/series').request.body;
    expect({ startsOn: body.startsOn, startTime: body.startTime, byWeekday: body.byWeekday }).toEqual({ startsOn: '2026-10-08', startTime: '00:30', byWeekday: [4] });

    c.frequency.set('MONTHLY');
    c.book();
    expect(http.expectOne((r) => r.method === 'POST' && r.url === '/api/v1/series').request.body.byMonthDay).toBe(8);
  });
});
