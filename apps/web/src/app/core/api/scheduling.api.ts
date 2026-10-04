import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map } from 'rxjs';
import { BASE, params } from './http-utils';
import {
  Appointment, CreateProposalDto, NoShowModel, Paginated, ProposalStatus, Reminder, ReminderStatus, RescheduleProposal, TimeOffImpact, TimeOffImpactDto,
} from '../models';

const unwrap = <T>(r: T[] | Paginated<T> | null | undefined): T[] => (Array.isArray(r) ? r : r?.items ?? []);

@Injectable({ providedIn: 'root' })
export class SchedulingApi {
  private readonly http = inject(HttpClient);

  // ----- Reschedule cascade (§6) -----
  timeOffImpact(dto: TimeOffImpactDto) { return this.http.post<TimeOffImpact>(`${BASE}/scheduling/time-off-impact`, dto); }
  createProposal(dto: CreateProposalDto) { return this.http.post<RescheduleProposal>(`${BASE}/scheduling/reschedule-proposals`, dto); }
  proposals(status?: ProposalStatus) {
    return this.http
      .get<RescheduleProposal[] | Paginated<RescheduleProposal>>(`${BASE}/scheduling/reschedule-proposals`, { params: params({ status }) })
      .pipe(map(unwrap));
  }
  proposal(id: string) { return this.http.get<RescheduleProposal>(`${BASE}/scheduling/reschedule-proposals/${id}`); }
  applyProposal(id: string, itemAppointmentIds?: string[]) {
    return this.http.post<RescheduleProposal>(`${BASE}/scheduling/reschedule-proposals/${id}/apply`, itemAppointmentIds ? { itemAppointmentIds } : {});
  }
  dismissProposal(id: string) { return this.http.post<RescheduleProposal>(`${BASE}/scheduling/reschedule-proposals/${id}/dismiss`, {}); }

  // ----- No-show model + reminders (§7) -----
  noShowModel() { return this.http.get<NoShowModel | null>(`${BASE}/scheduling/no-show-model`); }
  trainNoShowModel() { return this.http.post<NoShowModel>(`${BASE}/scheduling/no-show-model/train`, {}); }
  /** Appointments of `date` (YYYY-MM-DD) with risk ≥ 0.5, sorted desc. */
  atRisk(date: string) {
    return this.http.get<Appointment[] | Paginated<Appointment>>(`${BASE}/scheduling/no-show/at-risk`, { params: params({ date }) }).pipe(map(unwrap));
  }
  reminders(q: { appointmentId?: string; status?: ReminderStatus }) {
    return this.http.get<Reminder[] | Paginated<Reminder>>(`${BASE}/scheduling/reminders`, { params: params(q) }).pipe(map(unwrap));
  }
}
