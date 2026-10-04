import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE, params } from './http-utils';
import { AvailabilitySlot, Doctor, DoctorDto, Paginated, TimeOff } from '../models';

@Injectable({ providedIn: 'root' })
export class DoctorsApi {
  private readonly http = inject(HttpClient);
  /** The API returns a paginated envelope; tolerate a bare array too. */
  list(includeInactive = false) {
    return this.http
      .get<Paginated<Doctor> | Doctor[]>(`${BASE}/doctors`, { params: params({ includeInactive: includeInactive || undefined, pageSize: 100 }) })
      .pipe(map((r) => (Array.isArray(r) ? r : r.items)));
  }
  get(id: string) { return this.http.get<Doctor>(`${BASE}/doctors/${id}`); }
  create(dto: DoctorDto) { return this.http.post<Doctor>(`${BASE}/doctors`, dto); }
  update(id: string, dto: Partial<DoctorDto>) { return this.http.patch<Doctor>(`${BASE}/doctors/${id}`, dto); }
  deactivate(id: string) { return this.http.delete<void>(`${BASE}/doctors/${id}`); }
  setAvailability(id: string, slots: AvailabilitySlot[]) {
    return this.http.put<Doctor>(`${BASE}/doctors/${id}/availability`, { slots });
  }
  addTimeOff(id: string, dto: { startsAt: string; endsAt: string; reason?: string }) {
    return this.http.post<TimeOff>(`${BASE}/doctors/${id}/time-off`, dto);
  }
  removeTimeOff(id: string, timeOffId: string) { return this.http.delete<void>(`${BASE}/doctors/${id}/time-off/${timeOffId}`); }
}
