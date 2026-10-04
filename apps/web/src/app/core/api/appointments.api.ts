import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import {
  Appointment, AppointmentQuery, AppointmentStatus, AvailabilityResponse, CreateAppointmentDto, Paginated, UpdateAppointmentDto,
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
  get(id: string) { return this.http.get<Appointment>(`${BASE}/appointments/${id}`); }
  create(dto: CreateAppointmentDto) { return this.http.post<Appointment>(`${BASE}/appointments`, dto); }
  update(id: string, dto: UpdateAppointmentDto) { return this.http.patch<Appointment>(`${BASE}/appointments/${id}`, dto); }
  setStatus(id: string, status: AppointmentStatus, cancellationNote?: string) {
    return this.http.post<Appointment>(`${BASE}/appointments/${id}/status`, cancellationNote ? { status, cancellationNote } : { status });
  }
}
