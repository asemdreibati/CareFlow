import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE } from './http-utils';
import { Clinic, ClinicStats, NullablePatch } from '../models';

@Injectable({ providedIn: 'root' })
export class ClinicApi {
  private readonly http = inject(HttpClient);
  get() { return this.http.get<Clinic>(`${BASE}/clinic`); }
  update(dto: NullablePatch<Clinic>) { return this.http.patch<Clinic>(`${BASE}/clinic`, dto); }
  stats() { return this.http.get<ClinicStats>(`${BASE}/clinic/stats`); }
}
