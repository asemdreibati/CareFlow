import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE } from './http-utils';
import { Diagnosis, Encounter, EncounterDto, Paginated, Prescription, PrescriptionStatus } from '../models';

@Injectable({ providedIn: 'root' })
export class RecordsApi {
  private readonly http = inject(HttpClient);
  /** The contract describes a list; the API currently returns a paginated envelope. Accept both. */
  listEncounters(patientId: string) {
    return this.http
      .get<Encounter[] | Paginated<Encounter>>(`${BASE}/patients/${patientId}/encounters`, { params: { pageSize: 100 } })
      .pipe(map((r) => (Array.isArray(r) ? r : r.items)));
  }
  createEncounter(patientId: string, dto: EncounterDto) { return this.http.post<Encounter>(`${BASE}/patients/${patientId}/encounters`, dto); }
  getEncounter(id: string) { return this.http.get<Encounter>(`${BASE}/encounters/${id}`); }
  updateEncounter(id: string, dto: EncounterDto) { return this.http.patch<Encounter>(`${BASE}/encounters/${id}`, dto); }
  sign(id: string) { return this.http.post<Encounter>(`${BASE}/encounters/${id}/sign`, {}); }
  addDiagnosis(id: string, dto: { code: string; description: string; isPrimary?: boolean }) {
    return this.http.post<Diagnosis>(`${BASE}/encounters/${id}/diagnoses`, dto);
  }
  removeDiagnosis(id: string, dxId: string) { return this.http.delete<void>(`${BASE}/encounters/${id}/diagnoses/${dxId}`); }
  addPrescription(id: string, dto: { medication: string; dosage: string; frequency: string; durationDays?: number; instructions?: string }) {
    return this.http.post<Prescription>(`${BASE}/encounters/${id}/prescriptions`, dto);
  }
  setPrescriptionStatus(id: string, status: PrescriptionStatus) { return this.http.patch<Prescription>(`${BASE}/prescriptions/${id}`, { status }); }
}
