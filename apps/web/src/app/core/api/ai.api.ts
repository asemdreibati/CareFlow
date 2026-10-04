import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BASE, params } from './http-utils';
import { AiFeature, AiInteraction, AiStatus } from '../models';

@Injectable({ providedIn: 'root' })
export class AiApi {
  private readonly http = inject(HttpClient);
  status() { return this.http.get<AiStatus>(`${BASE}/ai/status`); }
  patientSummary(patientId: string) { return this.http.post<AiInteraction>(`${BASE}/ai/patients/${patientId}/summary`, {}); }
  soapNote(encounterId: string, transcript: string) {
    return this.http.post<AiInteraction>(`${BASE}/ai/encounters/${encounterId}/soap-note`, { transcript });
  }
  review(id: string, decision: 'APPROVED' | 'REJECTED', applyToEncounter?: boolean) {
    return this.http.post<AiInteraction>(`${BASE}/ai/interactions/${id}/review`, applyToEncounter === undefined ? { decision } : { decision, applyToEncounter });
  }
  interactions(q: { patientId?: string; feature?: AiFeature; encounterId?: string }) {
    return this.http.get<AiInteraction[]>(`${BASE}/ai/interactions`, { params: params(q) });
  }
}
