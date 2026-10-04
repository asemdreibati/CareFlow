import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PatientsApi } from '../../core/api/patients.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Patient } from '../../core/models';
import { age, fmtDate } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { HasPermissionDirective } from '../../core/permission.directive';
import { PatientOverviewTab } from './tabs/overview-tab';
import { PatientAppointmentsTab } from './tabs/appointments-tab';
import { PatientRecordsTab } from './tabs/records-tab';
import { PatientInvoicesTab } from './tabs/invoices-tab';
import { PatientAccessLogTab } from './tabs/access-log-tab';
import { PatientAiTab } from './tabs/ai-tab';

type Tab = 'overview' | 'appointments' | 'records' | 'invoices' | 'access' | 'ai';

@Component({
  selector: 'cf-patient-detail',
  imports: [RouterLink, PageHeaderComponent, StatusChipComponent, HasPermissionDirective, PatientOverviewTab, PatientAppointmentsTab, PatientRecordsTab, PatientInvoicesTab, PatientAccessLogTab, PatientAiTab],
  template: `
    <div class="page">
      @if (patient(); as p) {
        <cf-page-header [title]="p.firstName + ' ' + p.lastName" [subtitle]="p.mrn + ' · ' + age(p.dateOfBirth) + ' · ' + (p.gender || 'unknown') + ' · DOB ' + fmtDate(p.dateOfBirth)">
          <cf-chip [status]="p.isActive" />
          <a *hasPermission="'appointments:write'" class="btn" routerLink="/calendar" [queryParams]="{ new: 1, patientId: p.id }">Book appointment</a>
          <a *hasPermission="'patients:write'" class="btn primary" [routerLink]="['/patients', p.id, 'edit']">Edit</a>
        </cf-page-header>

        <div class="tabs">
          @for (t of tabs(); track t.key) {
            <button type="button" [class.active]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }}</button>
          }
        </div>

        @switch (tab()) {
          @case ('overview') { <cf-patient-overview [patient]="p" (changed)="reload()" /> }
          @case ('appointments') { <cf-patient-appointments [patient]="p" /> }
          @case ('records') { <cf-patient-records [patient]="p" /> }
          @case ('invoices') { <cf-patient-invoices [patient]="p" /> }
          @case ('access') { <cf-patient-access-log [patient]="p" /> }
          @case ('ai') { <cf-patient-ai [patient]="p" /> }
        }
      } @else if (error()) {
        <div class="inline-alert error">{{ error() }}</div>
      } @else {
        <div class="loading"><span class="spinner"></span> Loading…</div>
      }
    </div>
  `,
})
export class PatientDetailPage {
  private readonly api = inject(PatientsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly id = input.required<string>();
  readonly age = age;
  readonly fmtDate = fmtDate;
  readonly patient = signal<Patient | null>(null);
  readonly error = signal<string | null>(null);
  readonly tab = signal<Tab>('overview');
  readonly tabs = computed(() => {
    const t: { key: Tab; label: string }[] = [{ key: 'overview', label: 'Overview' }];
    if (this.auth.hasPermission('appointments:read')) t.push({ key: 'appointments', label: 'Appointments' });
    if (this.auth.hasPermission('records:read')) t.push({ key: 'records', label: 'Records' });
    if (this.auth.hasPermission('billing:read')) t.push({ key: 'invoices', label: 'Invoices' });
    if (this.auth.hasPermission('audit:read')) t.push({ key: 'access', label: 'Access log' });
    if (this.auth.hasAny('ai:use', 'ai:review')) t.push({ key: 'ai', label: 'AI summary' });
    return t;
  });

  ngOnInit() { this.reload(); }
  reload() {
    this.api.get(this.id()).subscribe({
      next: (p) => this.patient.set(p),
      error: (err) => { this.error.set('Could not load patient.'); this.toast.fromError(err); },
    });
  }
}
