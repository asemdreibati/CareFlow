import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Patient } from '../../../core/models';
import { fmtDateTime } from '../../../core/date-utils';
import { StatusChipComponent } from '../../../shared/status-chip';
import { HasPermissionDirective } from '../../../core/permission.directive';

@Component({
  selector: 'cf-patient-appointments',
  imports: [RouterLink, StatusChipComponent, HasPermissionDirective],
  template: `
    <div class="card">
      <div class="card-header">
        <h3>Recent appointments <span class="muted small">(last 10)</span></h3>
        <a *hasPermission="'appointments:write'" class="btn sm primary" routerLink="/calendar" [queryParams]="{ new: 1, patientId: p().id }">Book appointment</a>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>When</th><th>Doctor</th><th>Type</th><th>Reason</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (a of p().appointments ?? []; track a.id) {
              <tr>
                <td class="nowrap">{{ fmt(a.startsAt) }}</td>
                <td>{{ a.doctor?.title }} {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</td>
                <td class="muted">{{ a.type || '—' }}</td>
                <td class="muted truncate" style="max-width: 240px">{{ a.reason || '—' }}</td>
                <td><cf-chip [status]="a.status" /></td>
                <td class="actions"><a class="btn xs" [routerLink]="['/appointments', a.id]">Open</a></td>
              </tr>
            } @empty { <tr><td colspan="6" class="empty">No appointments yet.</td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class PatientAppointmentsTab {
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly fmt = fmtDateTime;
}
