import { Component, inject, input, signal } from '@angular/core';
import { PatientsApi } from '../../../core/api/patients.api';
import { MembersApi } from '../../../core/api/members.api';
import { errorMessage } from '../../../core/toast.service';
import { AccessLogRow, Patient } from '../../../core/models';
import { fmtDateTime } from '../../../core/date-utils';

@Component({
  selector: 'cf-patient-access-log',
  template: `
    <div class="card">
      <div class="card-header"><h3>Record access log</h3><span class="subtle">Who opened this patient's data (append-only)</span></div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Encounter</th></tr></thead>
            <tbody>
              @for (r of rows(); track r.id) {
                <tr><td class="nowrap">{{ fmt(r.createdAt) }}</td><td>{{ userName(r.userId) }}</td><td><span class="chip gray">{{ r.action }}</span></td><td class="mono subtle">{{ r.encounterId ? r.encounterId.slice(0, 8) : '—' }}</td></tr>
              } @empty { <tr><td colspan="4" class="empty">No access recorded.</td></tr> }
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
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly fmt = fmtDateTime;
  readonly rows = signal<AccessLogRow[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  private readonly names = signal<Record<string, string>>({});
  ngOnInit() {
    this.api.accessLog(this.p().id).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err)); },
    });
    this.members.list().subscribe({
      next: (list) => this.names.set(Object.fromEntries(list.map((m) => [m.user.id, `${m.user.firstName} ${m.user.lastName}`]))),
      error: () => undefined,
    });
  }
  userName(id: string) { return this.names()[id] ?? id.slice(0, 8); }
}
