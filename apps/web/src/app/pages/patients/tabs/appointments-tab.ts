import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../../core/i18n/language.service';
import { Patient } from '../../../core/models';
import { StatusChipComponent } from '../../../shared/status-chip';
import { HasPermissionDirective } from '../../../core/permission.directive';

@Component({
  selector: 'cf-patient-appointments',
  imports: [RouterLink, TranslatePipe, StatusChipComponent, HasPermissionDirective],
  template: `
    <div class="card">
      <div class="card-header">
        <h3>{{ 'patients.recentAppointments' | translate }} <span class="muted small">({{ 'patients.last10' | translate }})</span></h3>
        <a *hasPermission="'appointments:write'" class="btn sm primary" routerLink="/calendar" [queryParams]="{ new: 1, patientId: p().id }">{{ 'booking.book' | translate }}</a>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{{ 'common.when' | translate }}</th><th>{{ 'common.doctor' | translate }}</th><th>{{ 'common.type' | translate }}</th><th>{{ 'common.reason' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
          <tbody>
            @for (a of p().appointments ?? []; track a.id) {
              <tr>
                <td class="nowrap">{{ lang.formatDateTime(a.startsAt) }}</td>
                <td>{{ a.doctor?.title }} {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</td>
                <td class="muted">{{ a.type ? lang.enumLabel(a.type, 'type') : '—' }}</td>
                <td class="muted truncate" style="max-width: 240px">{{ a.reason || '—' }}</td>
                <td><cf-chip [status]="a.status" group="status" /></td>
                <td class="actions"><a class="btn xs" [routerLink]="['/appointments', a.id]">{{ 'common.open' | translate }}</a></td>
              </tr>
            } @empty { <tr><td colspan="6" class="empty">{{ 'appointments.none' | translate }}</td></tr> }
          </tbody>
        </table>
      </div>
    </div>
  `,
})
export class PatientAppointmentsTab {
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
}
