import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { AccessLogRow, Allergy, AllergySeverity, Paginated, Patient, PatientDto } from '../models';

@Injectable({ providedIn: 'root' })
export class PatientsApi {
  private readonly http = inject(HttpClient);
  list(q: { search?: string; page?: number; pageSize?: number; includeInactive?: boolean }) {
    return this.http.get<Paginated<Patient>>(`${BASE}/patients`, { params: params(q) });
  }
  get(id: string) { return this.http.get<Patient>(`${BASE}/patients/${id}`); }
  create(dto: PatientDto) { return this.http.post<Patient>(`${BASE}/patients`, dto); }
  update(id: string, dto: Partial<PatientDto>) { return this.http.patch<Patient>(`${BASE}/patients/${id}`, dto); }
  deactivate(id: string) { return this.http.delete<void>(`${BASE}/patients/${id}`); }
  addAllergy(id: string, dto: { substance: string; reaction?: string; severity?: AllergySeverity }) {
    return this.http.post<Allergy>(`${BASE}/patients/${id}/allergies`, dto);
  }
  removeAllergy(id: string, allergyId: string) { return this.http.delete<void>(`${BASE}/patients/${id}/allergies/${allergyId}`); }
  accessLog(id: string) { return this.http.get<AccessLogRow[]>(`${BASE}/patients/${id}/access-log`); }
}
