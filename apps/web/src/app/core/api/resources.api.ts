import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE, params } from './http-utils';
import { Paginated, Resource, ResourceAvailabilityResponse, ResourceBooking, ResourceDto } from '../models';

@Injectable({ providedIn: 'root' })
export class ResourcesApi {
  private readonly http = inject(HttpClient);
  /** Tolerates a bare array or a paginated envelope. */
  list(includeInactive = false) {
    return this.http
      .get<Resource[] | Paginated<Resource>>(`${BASE}/resources`, { params: params({ includeInactive: includeInactive || undefined }) })
      .pipe(map((r) => (Array.isArray(r) ? r : r?.items ?? [])));
  }
  get(id: string) { return this.http.get<Resource>(`${BASE}/resources/${id}`); }
  create(dto: ResourceDto) { return this.http.post<Resource>(`${BASE}/resources`, dto); }
  update(id: string, dto: Partial<ResourceDto>) { return this.http.patch<Resource>(`${BASE}/resources/${id}`, dto); }
  /** The API wraps the rows: `{ resource, from, to, bookings[] }`; a bare array or `{items}` is tolerated too. */
  bookings(id: string, q: { from: string; to: string }) {
    return this.http
      .get<ResourceBooking[] | Paginated<ResourceBooking> | { bookings: ResourceBooking[] }>(`${BASE}/resources/${id}/bookings`, { params: params(q) })
      .pipe(map((r) => (Array.isArray(r) ? r : (r as { bookings?: ResourceBooking[] })?.bookings ?? (r as Paginated<ResourceBooking>)?.items ?? [])));
  }
  /** Free slots common to ALL listed resources on `date`. */
  availability(q: { resourceIds: string[]; date: string; durationMinutes: number }) {
    return this.http.get<ResourceAvailabilityResponse>(`${BASE}/resources/availability`, {
      params: params({ resourceIds: q.resourceIds.join(','), date: q.date, durationMinutes: q.durationMinutes }),
    });
  }
}
