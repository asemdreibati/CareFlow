import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE, params } from './http-utils';
import { Appointment, AppointmentSeries, CreateSeriesDto, CreateSeriesResponse, Paginated, SeriesStatus } from '../models';

@Injectable({ providedIn: 'root' })
export class SeriesApi {
  private readonly http = inject(HttpClient);
  create(dto: CreateSeriesDto) { return this.http.post<CreateSeriesResponse>(`${BASE}/series`, dto); }
  list(q: { patientId?: string; doctorId?: string; status?: SeriesStatus } = {}) {
    return this.http
      .get<AppointmentSeries[] | Paginated<AppointmentSeries>>(`${BASE}/series`, { params: params(q) })
      .pipe(map((r) => (Array.isArray(r) ? r : r?.items ?? [])));
  }
  get(id: string) { return this.http.get<AppointmentSeries>(`${BASE}/series/${id}`); }
  /** Cancels all future, non-final occurrences. */
  cancel(id: string, reason?: string) {
    return this.http.patch<AppointmentSeries>(`${BASE}/series/${id}`, reason ? { status: 'CANCELLED', reason } : { status: 'CANCELLED' });
  }
  detach(id: string, index: number) { return this.http.post<Appointment>(`${BASE}/series/${id}/occurrences/${index}/detach`, {}); }
}
