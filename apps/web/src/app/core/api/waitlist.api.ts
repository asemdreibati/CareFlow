import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE, params } from './http-utils';
import { Appointment, Paginated, SlotSearchResponse, WaitlistDto, WaitlistEntry, WaitlistQuery } from '../models';

@Injectable({ providedIn: 'root' })
export class WaitlistApi {
  private readonly http = inject(HttpClient);
  list(q: WaitlistQuery = {}) {
    return this.http
      .get<Paginated<WaitlistEntry> | WaitlistEntry[]>(`${BASE}/waitlist`, { params: params({ pageSize: 100, ...q }) })
      .pipe(map((r): Paginated<WaitlistEntry> => (Array.isArray(r) ? { items: r, total: r.length, page: 1, pageSize: r.length } : r)));
  }
  get(id: string) { return this.http.get<WaitlistEntry>(`${BASE}/waitlist/${id}`); }
  create(dto: WaitlistDto) { return this.http.post<WaitlistEntry>(`${BASE}/waitlist`, dto); }
  update(id: string, dto: Partial<WaitlistDto>) { return this.http.patch<WaitlistEntry>(`${BASE}/waitlist/${id}`, dto); }
  cancel(id: string) { return this.http.delete<WaitlistEntry | void>(`${BASE}/waitlist/${id}`); }
  /** Slots that would satisfy the entry now (smart-search shape). */
  matches(id: string) {
    return this.http
      .get<SlotSearchResponse | SlotSearchResponse['candidates']>(`${BASE}/waitlist/matches/${id}`)
      .pipe(map((r) => (Array.isArray(r) ? r : r?.candidates ?? [])));
  }
  book(id: string, dto: { startsAt: string; doctorId: string }) {
    return this.http.post<{ entry?: WaitlistEntry; appointment?: Appointment } | Appointment>(`${BASE}/waitlist/${id}/book`, dto);
  }
  accept(id: string) { return this.http.post<WaitlistEntry>(`${BASE}/waitlist/${id}/accept`, {}); }
  decline(id: string) { return this.http.post<WaitlistEntry>(`${BASE}/waitlist/${id}/decline`, {}); }
}
