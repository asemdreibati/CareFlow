import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { PatientsApi } from '../../core/api/patients.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Patient } from '../../core/models';
import { ageYears } from '../../core/date-utils';
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
  imports: [RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, HasPermissionDirective, PatientOverviewTab, PatientAppointmentsTab, PatientRecordsTab, PatientInvoicesTab, PatientAccessLogTab, PatientAiTab],
  template: `
    <div class="page">
      @if (patient(); as p) {
        <cf-page-header [title]="p.firstName + ' ' + p.lastName" [subtitle]="subtitle()">
          <cf-chip [status]="p.isActive" />
          <a *hasPermission="'appointments:write'" class="btn" routerLink="/calendar" [queryParams]="{ new: 1, patientId: p.id }">{{ 'booking.book' | translate }}</a>
          <a *hasPermission="'patients:write'" class="btn primary" [routerLink]="['/patients', p.id, 'edit']">{{ 'common.edit' | translate }}</a>
        </cf-page-header>

        <div class="tabs">
          @for (t of tabs(); track t.key) {
            <button type="button" [class.active]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label | translate }}</button>
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
        <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div>
      }
    </div>
  `,
})
export class PatientDetailPage {
  private readonly api = inject(PatientsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
  readonly patient = signal<Patient | null>(null);
  readonly error = signal<string | null>(null);
  readonly tab = signal<Tab>('overview');
  readonly subtitle = computed(() => {
    const p = this.patient();
    if (!p) return '';
    const years = ageYears(p.dateOfBirth);
    const age = years === null ? '—' : this.lang.t('patients.years', { n: years });
    const gender = p.gender ? this.lang.enumLabel(p.gender, 'gender') : this.lang.enumLabel('UNKNOWN', 'gender');
    return `${p.mrn} · ${age} · ${gender} · ${this.lang.t('patients.dobShort')} ${this.lang.formatDate(p.dateOfBirth)}`;
  });
  readonly tabs = computed(() => {
    const t: { key: Tab; label: string }[] = [{ key: 'overview', label: 'patients.tabs.overview' }];
    if (this.auth.hasPermission('appointments:read')) t.push({ key: 'appointments', label: 'patients.tabs.appointments' });
    if (this.auth.hasPermission('records:read')) t.push({ key: 'records', label: 'patients.tabs.records' });
    if (this.auth.hasPermission('billing:read')) t.push({ key: 'invoices', label: 'patients.tabs.invoices' });
    if (this.auth.hasPermission('audit:read')) t.push({ key: 'access', label: 'patients.tabs.access' });
    if (this.auth.hasAny('ai:use', 'ai:review')) t.push({ key: 'ai', label: 'patients.tabs.ai' });
    return t;
  });

  ngOnInit() { this.reload(); }
  reload() {
    this.api.get(this.id()).subscribe({
      next: (p) => this.patient.set(p),
      error: (err) => { this.error.set(this.lang.t('patients.loadFailed')); this.toast.fromError(err); },
    });
  }
}
