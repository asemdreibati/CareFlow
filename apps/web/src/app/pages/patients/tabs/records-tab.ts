import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { RecordsApi } from '../../../core/api/records.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService, errorMessage } from '../../../core/toast.service';
import { Encounter, Patient } from '../../../core/models';
import { fmtDateTime } from '../../../core/date-utils';
import { StatusChipComponent } from '../../../shared/status-chip';
import { DialogComponent } from '../../../shared/dialog';
import { DoctorsApi } from '../../../core/api/doctors.api';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'cf-patient-records',
  imports: [RouterLink, StatusChipComponent, DialogComponent, FormsModule],
  template: `
    <div class="card">
      <div class="card-header">
        <h3>Encounters</h3>
        @if (canWrite) { <button type="button" class="btn sm primary" (click)="startCreate()" [disabled]="creating()">+ New encounter</button> }
      </div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Date</th><th>Doctor</th><th>Chief complaint</th><th>Diagnoses</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (e of encounters(); track e.id) {
                <tr class="clickable" (click)="open(e)">
                  <td class="nowrap">{{ fmt(e.occurredAt) }}</td>
                  <td>{{ e.doctor?.title }} {{ e.doctor?.firstName }} {{ e.doctor?.lastName }}</td>
                  <td class="truncate" style="max-width: 260px">{{ e.chiefComplaint || '—' }}</td>
                  <td class="muted small">@for (d of e.diagnoses ?? []; track d.id) { <span class="chip gray" [class.teal]="d.isPrimary">{{ d.code }}</span> } @empty { — }</td>
                  <td><cf-chip [status]="e.status" /></td>
                  <td class="actions"><a class="btn xs" [routerLink]="['/encounters', e.id]" (click)="$event.stopPropagation()">Open</a></td>
                </tr>
              } @empty { <tr><td colspan="6" class="empty">No encounters recorded.</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
    @if (dialog()) {
      <cf-dialog title="New encounter" [width]="460" (closed)="dialog.set(false)">
        <p class="muted">A draft encounter will be created for {{ p().firstName }} {{ p().lastName }}.</p>
        @if (needsDoctor) {
          <div class="field"><label class="req">Doctor</label>
            <select class="input" [(ngModel)]="doctorId"><option value="">Select doctor…</option>@for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }</select>
          </div>
        }
        <div class="field"><label>Chief complaint</label><input class="input" [(ngModel)]="chiefComplaint" placeholder="e.g. Headache for 3 days" /></div>
        <div footer>
          <button type="button" class="btn" (click)="dialog.set(false)">Cancel</button>
          <button type="button" class="btn primary" (click)="create()" [disabled]="creating() || (needsDoctor && !doctorId)">{{ creating() ? 'Creating…' : 'Create & open' }}</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class PatientRecordsTab {
  private readonly api = inject(RecordsApi);
  private readonly doctorsApi = inject(DoctorsApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly fmt = fmtDateTime;
  readonly encounters = signal<Encounter[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly creating = signal(false);
  readonly dialog = signal(false);
  readonly doctors = signal<{ id: string; firstName: string; lastName: string; title?: string | null }[]>([]);
  readonly canWrite = this.auth.hasPermission('records:write');
  /** Users without a linked doctor profile (e.g. NURSE) must pick the doctor. */
  readonly needsDoctor = !this.auth.doctorId();
  doctorId = '';
  chiefComplaint = '';

  ngOnInit() {
    this.api.listEncounters(this.p().id).subscribe({
      next: (list) => { this.encounters.set(list); this.loading.set(false); },
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Records are not available yet.')); },
    });
  }
  open(e: Encounter) { void this.router.navigate(['/encounters', e.id]); }
  startCreate() {
    this.dialog.set(true);
    if (this.needsDoctor && !this.doctors().length) this.doctorsApi.list().subscribe((d) => this.doctors.set(d));
  }
  create() {
    this.creating.set(true);
    this.api.createEncounter(this.p().id, { chiefComplaint: this.chiefComplaint || undefined, doctorId: this.needsDoctor ? this.doctorId : undefined }).subscribe({
      next: (e) => void this.router.navigate(['/encounters', e.id]),
      error: (err) => { this.creating.set(false); this.toast.fromError(err); },
    });
  }
}
