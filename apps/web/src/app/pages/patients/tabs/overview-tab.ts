import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PatientsApi } from '../../../core/api/patients.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService } from '../../../core/toast.service';
import { ConfirmService } from '../../../shared/confirm.service';
import { AllergySeverity, Patient } from '../../../core/models';
import { fmtDate } from '../../../core/date-utils';
import { StatusChipComponent } from '../../../shared/status-chip';

@Component({
  selector: 'cf-patient-overview',
  imports: [FormsModule, StatusChipComponent],
  template: `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><h3>Demographics</h3></div>
        <div class="card-body">
          <dl class="kv">
            <dt>MRN</dt><dd class="mono">{{ p().mrn }}</dd>
            <dt>Date of birth</dt><dd>{{ fmtDate(p().dateOfBirth) }}</dd>
            <dt>Gender</dt><dd>{{ p().gender || '—' }}</dd>
            <dt>Phone</dt><dd>{{ p().phone || '—' }}</dd>
            <dt>Email</dt><dd>{{ p().email || '—' }}</dd>
            <dt>Address</dt><dd>{{ p().address || '—' }}</dd>
            <dt>Blood type</dt><dd>{{ p().bloodType || '—' }}</dd>
            <dt>National ID</dt>
            <dd>
              @if (revealed()) { <span class="mono">{{ p().nationalId }}</span> <button type="button" class="btn ghost xs" (click)="revealed.set(false)">Hide</button> }
              @else {
                <span class="mono">{{ p().nationalIdMasked || '—' }}</span>
                @if (p().nationalId) { <button type="button" class="btn ghost xs" (click)="revealed.set(true)">Reveal</button> }
                @else if (!canSensitive) { <span class="subtle">(restricted)</span> }
              }
            </dd>
            <dt>Emergency contact</dt>
            <dd>@if (p().emergencyContact; as ec) { {{ ec.name || '—' }} @if (ec.relation) { ({{ ec.relation }}) } @if (ec.phone) { · {{ ec.phone }} } } @else { — }</dd>
            <dt>Notes</dt><dd style="white-space: pre-line">{{ p().notes || '—' }}</dd>
          </dl>
        </div>
      </div>
      <div class="col">
        <div class="card">
          <div class="card-header"><h3>Allergies</h3></div>
          <div class="card-body">
            @for (a of p().allergies ?? []; track a.id) {
              <div class="list-item">
                <div class="flex-1"><span class="strong">{{ a.substance }}</span>@if (a.reaction) { <span class="muted"> — {{ a.reaction }}</span> }</div>
                @if (a.severity) { <cf-chip [status]="a.severity" /> }
                @if (canWrite) { <button type="button" class="btn ghost xs danger-text" (click)="removeAllergy(a.id)">Remove</button> }
              </div>
            } @empty { <div class="muted">No known allergies.</div> }
            @if (canWrite) {
              <form class="row wrap mt-2" (ngSubmit)="addAllergy()">
                <input class="input sm flex-1" placeholder="Substance" [(ngModel)]="substance" name="substance" required />
                <input class="input sm flex-1" placeholder="Reaction" [(ngModel)]="reaction" name="reaction" />
                <select class="input sm" style="width: 150px" [(ngModel)]="severity" name="severity">
                  <option value="">Severity</option>@for (s of severities; track s) { <option [value]="s">{{ s }}</option> }
                </select>
                <button class="btn sm primary" type="submit" [disabled]="saving() || !substance.trim()">Add</button>
              </form>
            }
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>Active prescriptions</h3></div>
          <div class="card-body">
            @for (rx of p().prescriptions ?? []; track rx.id) {
              <div class="list-item"><div class="flex-1"><span class="strong">{{ rx.medication }}</span> <span class="muted">{{ rx.dosage }} · {{ rx.frequency }}</span>@if (rx.durationDays) { <span class="muted"> · {{ rx.durationDays }} days</span> }</div><cf-chip [status]="rx.status" /></div>
            } @empty { <div class="muted">No active prescriptions.</div> }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class PatientOverviewTab {
  private readonly api = inject(PatientsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly changed = output<void>();
  readonly fmtDate = fmtDate;
  readonly revealed = signal(false);
  readonly saving = signal(false);
  readonly canSensitive = this.auth.hasPermission('patients:sensitive');
  readonly canWrite = this.auth.hasPermission('patients:write');
  readonly severities: AllergySeverity[] = ['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'];
  substance = ''; reaction = ''; severity: AllergySeverity | '' = '';

  addAllergy() {
    if (!this.substance.trim()) return;
    this.saving.set(true);
    this.api.addAllergy(this.p().id, { substance: this.substance.trim(), reaction: this.reaction.trim() || undefined, severity: this.severity || undefined }).subscribe({
      next: () => { this.saving.set(false); this.substance = ''; this.reaction = ''; this.severity = ''; this.changed.emit(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }
  async removeAllergy(id: string) {
    if (!(await this.confirm.ask({ title: 'Remove allergy', message: 'Remove this allergy from the patient record?', danger: true, confirmText: 'Remove' }))) return;
    this.api.removeAllergy(this.p().id, id).subscribe({ next: () => this.changed.emit(), error: (err) => this.toast.fromError(err) });
  }
}
