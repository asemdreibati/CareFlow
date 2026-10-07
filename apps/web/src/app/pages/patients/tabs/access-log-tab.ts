import { Component, inject, input, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PatientsApi } from '../../../core/api/patients.api';
import { MembersApi } from '../../../core/api/members.api';
import { LanguageService } from '../../../core/i18n/language.service';
import { AccessLogRow, Patient } from '../../../core/models';

@Component({
  selector: 'cf-patient-access-log',
  imports: [TranslatePipe],
  template: `
    <div class="card">
      <div class="card-header"><h3>{{ 'patients.accessLog.title' | translate }}</h3><span class="subtle">{{ 'patients.accessLog.hint' | translate }}</span></div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{{ 'common.when' | translate }}</th><th>{{ 'common.user' | translate }}</th><th>{{ 'common.action' | translate }}</th><th>{{ 'encounters.encounter' | translate }}</th></tr></thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr><td class="nowrap">{{ lang.formatDateTime(r.createdAt) }}</td><td>{{ userName(r.userId) }}</td><td><span class="chip gray">{{ r.action }}</span></td><td class="mono subtle">{{ r.encounterId ? r.encounterId.slice(0, 8) : '—' }}</td></tr>
              } @empty { <tr><td colspan="4" class="empty">{{ 'patients.accessLog.empty' | translate }}</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class PatientAccessLogTab {
  private readonly api = inject(PatientsApi);
  private readonly members = inject(MembersApi);
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly rows = signal<AccessLogRow[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  private readonly names = signal<Record<string, string>>({});
  ngOnInit() {
    this.api.accessLog(this.p().id).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err)); },
    });
    this.members.list().subscribe({
      next: (list) => this.names.set(Object.fromEntries(list.map((m) => [m.user.id, `${m.user.firstName} ${m.user.lastName}`]))),
      error: () => undefined,
    });
  }
  userName(id: string) { return this.names()[id] ?? id.slice(0, 8); }
}
