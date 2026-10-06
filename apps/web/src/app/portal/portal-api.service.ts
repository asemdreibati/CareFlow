import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, map, tap, throwError } from 'rxjs';
import { params } from '../core/api/http-utils';
import { PortalAuthService } from './portal-auth.service';
import { PORTAL_API_BASE, portalHeaders, portalLoginPath } from './portal-url';
import {
  PortalAppointment, PortalBookDto, PortalClinicInfo, PortalConsent, PortalInvoice, PortalMe, PortalMePatch, PortalSlot,
  PortalSlotsResponse, PortalVerifyResponse, PortalWaitlistDto, PortalWaitlistEntry,
} from './portal.models';

type Paged<T> = T[] | { items: T[]; total?: number };
const unwrap = <T>(r: Paged<T> | null | undefined): T[] => (Array.isArray(r) ? r : r?.items ?? []);

/**
 * Patient-portal HTTP client. Sets the `Authorization: Bearer <portal token>` header explicitly on
 * every call (see `portal-url.ts` for why there is no second interceptor) and turns a 401 into a
 * portal logout + redirect to the clinic's login page. Error payloads are left to the caller/toasts.
 */
@Injectable({ providedIn: 'root' })
export class PortalApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(PortalAuthService);
  private readonly router = inject(Router);

  // ---- auth (public) ----
  requestOtp(clinicSlug: string, phone: string) {
    return this.http.post<{ sent: boolean }>(`${PORTAL_API_BASE}/auth/request-otp`, { clinicSlug, phone });
  }
  verify(clinicSlug: string, phone: string, code: string) {
    return this.http
      .post<PortalVerifyResponse>(`${PORTAL_API_BASE}/auth/verify`, { clinicSlug, phone, code })
      .pipe(tap((r) => this.auth.apply(r)));
  }

  // ---- profile / consents ----
  me() { return this.get<PortalMe>('/me').pipe(tap((me) => this.auth.setProfile(me))); }
  updateMe(patch: PortalMePatch) { return this.patch<PortalMe>('/me', patch).pipe(tap((me) => this.auth.setProfile(me))); }
  consents() { return this.get<Paged<PortalConsent>>('/consents').pipe(map(unwrap)); }
  acceptConsent(c: PortalConsent) {
    return this.post<PortalConsent>('/consents', { type: c.type, version: c.version }).pipe(
      tap((saved) => {
        const me = this.auth.profile();
        if (me) this.auth.setProfile({ ...me, consents: [...(me.consents ?? []).filter((x) => !(x.type === c.type && x.version === c.version)), saved ?? { ...c, acceptedAt: new Date().toISOString() }] });
      }),
    );
  }

  // ---- clinic / booking ----
  clinic() { return this.get<PortalClinicInfo>('/clinic'); }
  slots(q: { doctorId?: string; specialty?: string; durationMinutes?: number; from: string; to: string }): Observable<PortalSlot[]> {
    return this.get<PortalSlotsResponse | PortalSlot[]>('/slots', q).pipe(map((r) => (Array.isArray(r) ? r : r?.candidates ?? [])));
  }
  book(dto: PortalBookDto, idempotencyKey: string) {
    return this.post<PortalAppointment>('/appointments', dto, { 'Idempotency-Key': idempotencyKey });
  }

  // ---- appointments ----
  /** `scope` = upcoming | past. If the backend rejects the query shape (400) we fall back to the full list and filter here. */
  appointments(scope: 'upcoming' | 'past'): Observable<PortalAppointment[]> {
    return this.get<Paged<PortalAppointment>>('/appointments', { scope }).pipe(
      map(unwrap),
      catchError((err: unknown) => {
        if (!(err instanceof HttpErrorResponse) || err.status !== 400) return throwError(() => err);
        return this.get<Paged<PortalAppointment>>('/appointments').pipe(map((r) => splitAppointments(unwrap(r))[scope]));
      }),
    );
  }
  appointment(id: string) { return this.get<PortalAppointment>(`/appointments/${id}`); }
  confirmAppointment(id: string) { return this.post<PortalAppointment>(`/appointments/${id}/confirm`, {}); }
  cancelAppointment(id: string, reason?: string) { return this.post<PortalAppointment>(`/appointments/${id}/cancel`, reason ? { reason } : {}); }

  // ---- invoices ----
  invoices() { return this.get<Paged<PortalInvoice>>('/invoices').pipe(map(unwrap)); }
  invoice(id: string) { return this.get<PortalInvoice>(`/invoices/${id}`); }

  // ---- waitlist ----
  waitlist() { return this.get<Paged<PortalWaitlistEntry>>('/waitlist').pipe(map(unwrap)); }
  joinWaitlist(dto: PortalWaitlistDto) { return this.post<PortalWaitlistEntry>('/waitlist', dto); }
  acceptOffer(id: string) { return this.post<PortalWaitlistEntry>(`/waitlist/${id}/accept`, {}); }
  declineOffer(id: string) { return this.post<PortalWaitlistEntry>(`/waitlist/${id}/decline`, {}); }

  // ---- plumbing ----
  private get<T>(path: string, query?: object) {
    const url = `${PORTAL_API_BASE}${path}`;
    return this.guard(this.http.get<T>(url, { headers: this.headers(url), params: params(query) }));
  }
  private post<T>(path: string, body: unknown, extra: Record<string, string | undefined> = {}) {
    const url = `${PORTAL_API_BASE}${path}`;
    return this.guard(this.http.post<T>(url, body, { headers: this.headers(url, extra) }));
  }
  private patch<T>(path: string, body: unknown) {
    const url = `${PORTAL_API_BASE}${path}`;
    return this.guard(this.http.patch<T>(url, body, { headers: this.headers(url) }));
  }
  private headers(url: string, extra: Record<string, string | undefined> = {}) {
    return portalHeaders(url, this.auth.token(), extra);
  }
  /** 401 → the patient token is gone/expired: drop the session and go back to the clinic login. */
  private guard<T>(obs: Observable<T>): Observable<T> {
    return obs.pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 401 && this.auth.isAuthenticated()) {
          const slug = this.auth.clinicSlug();
          this.auth.clear();
          void this.router.navigate(portalLoginPath(slug), { queryParams: { expired: 1 } });
        }
        return throwError(() => err);
      }),
    );
  }
}

/** Splits a mixed list into upcoming (future, not cancelled/finished) and past. */
export function splitAppointments(list: PortalAppointment[], now: number = Date.now()): { upcoming: PortalAppointment[]; past: PortalAppointment[] } {
  const upcoming: PortalAppointment[] = [];
  const past: PortalAppointment[] = [];
  for (const a of list) {
    const future = new Date(a.endsAt ?? a.startsAt).getTime() >= now;
    const open = a.status === 'SCHEDULED' || a.status === 'CONFIRMED' || a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS';
    (future && open ? upcoming : past).push(a);
  }
  upcoming.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  past.sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { upcoming, past };
}

