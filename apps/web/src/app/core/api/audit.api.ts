import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { AuditQuery, AuditRow, Paginated } from '../models';

@Injectable({ providedIn: 'root' })
export class AuditApi {
  private readonly http = inject(HttpClient);
  list(q: AuditQuery) { return this.http.get<Paginated<AuditRow>>(`${BASE}/audit`, { params: params(q) }); }
}
