import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { bookingHttpHeaders } from './booking-headers';
import {
  Appointment, AppointmentQuery, AppointmentStatus, AvailabilityResponse, CreateAppointmentDto, Paginated, SlotSearchQuery, SlotSearchResponse,
  UpdateAppointmentDto,
} from '../models';

@Injectable({ providedIn: 'root' })
export class AppointmentsApi {
  private readonly http = inject(HttpClient);
  list(q: AppointmentQuery) { return this.http.get<Paginated<Appointment>>(`${BASE}/appointments`, { params: params(q) }); }
  calendar(q: { from: string; to: string; doctorId?: string }) {
    return this.http.get<Appointment[]>(`${BASE}/appointments/calendar`, { params: params(q) });
  }
  availability(q: { doctorId: string; date: string; durationMinutes?: number }) {
    return this.http.get<AvailabilityResponse>(`${BASE}/appointments/availability`, { params: params(q) });
  }
  /** Smart slot search (docs/SCHEDULING.md §1). Windows are JSON-encoded, resource ids comma-joined. */
  search(q: SlotSearchQuery) {
    const { preferredWindows, resourceIds, ...rest } = q;
    return this.http.get<SlotSearchResponse>(`${BASE}/appointments/search`, {
      params: params({
        ...rest,
        preferredWindows: preferredWindows?.length ? JSON.stringify(preferredWindows) : undefined,
        resourceIds: resourceIds?.length ? resourceIds.join(',') : undefined,
      }),
    });
  }
  get(id: string) { return this.http.get<Appointment>(`${BASE}/appointments/${id}`); }
  /** `idempotencyKey` is sent as the `Idempotency-Key` header so retries return the original appointment. */
  create(dto: CreateAppointmentDto, idempotencyKey?: string) {
    return this.http.post<Appointment>(`${BASE}/appointments`, dto, { headers: bookingHttpHeaders({ idempotencyKey }) });
  }
  /** `version` (when known) is sent as `If-Match` for optimistic locking. */
  update(id: string, dto: UpdateAppointmentDto, version?: number | null) {
    return this.http.patch<Appointment>(`${BASE}/appointments/${id}`, dto, { headers: bookingHttpHeaders({ version }) });
  }
  setStatus(id: string, status: AppointmentStatus, cancellationNote?: string, version?: number | null) {
    return this.http.post<Appointment>(`${BASE}/appointments/${id}/status`, cancellationNote ? { status, cancellationNote } : { status }, {
      headers: bookingHttpHeaders({ version }),
    });
  }
}
