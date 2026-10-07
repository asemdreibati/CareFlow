import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PatientsApi } from '../../../core/api/patients.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService } from '../../../core/toast.service';
import { LanguageService } from '../../../core/i18n/language.service';
import { ConfirmService } from '../../../shared/confirm.service';
import { AllergySeverity, Patient } from '../../../core/models';
import { StatusChipComponent } from '../../../shared/status-chip';

@Component({
  selector: 'cf-patient-overview',
  imports: [FormsModule, TranslatePipe, StatusChipComponent],
  template: `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-header"><h3>{{ 'patients.demographics' | translate }}</h3></div>
        <div class="card-body">
          <dl class="kv">
            <dt>{{ 'patients.mrn' | translate }}</dt><dd class="mono">{{ p().mrn }}</dd>
            <dt>{{ 'patients.dob' | translate }}</dt><dd>{{ lang.formatDate(p().dateOfBirth) }}</dd>
            <dt>{{ 'patients.gender' | translate }}</dt><dd>{{ p().gender ? lang.enumLabel(p().gender, 'gender') : '—' }}</dd>
            <dt>{{ 'common.phone' | translate }}</dt><dd dir="ltr" class="text-start">{{ p().phone || '—' }}</dd>
            <dt>{{ 'common.email' | translate }}</dt><dd dir="ltr" class="text-start">{{ p().email || '—' }}</dd>
            <dt>{{ 'common.address' | translate }}</dt><dd>{{ p().address || '—' }}</dd>
            <dt>{{ 'patients.bloodType' | translate }}</dt><dd>{{ p().bloodType || '—' }}</dd>
            <dt>{{ 'patients.nationalId' | translate }}</dt>
            <dd>
              @if (revealed()) { <span class="mono">{{ p().nationalId }}</span> <button type="button" class="btn ghost xs" (click)="revealed.set(false)">{{ 'patients.hide' | translate }}</button> }
              @else {
                <span class="mono">{{ p().nationalIdMasked || '—' }}</span>
                @if (p().nationalId) { <button type="button" class="btn ghost xs" (click)="revealed.set(true)">{{ 'patients.reveal' | translate }}</button> }
                @else if (!canSensitive) { <span class="subtle">({{ 'patients.restricted' | translate }})</span> }
              }
            </dd>
            <dt>{{ 'patients.emergencyContact' | translate }}</dt>
            <dd>@if (p().emergencyContact; as ec) { {{ ec.name || '—' }} @if (ec.relation) { ({{ ec.relation }}) } @if (ec.phone) { · <span dir="ltr">{{ ec.phone }}</span> } } @else { — }</dd>
            <dt>{{ 'common.notes' | translate }}</dt><dd style="white-space: pre-line">{{ p().notes || '—' }}</dd>
          </dl>
        </div>
      </div>
      <div class="col">
        <div class="card">
          <div class="card-header"><h3>{{ 'patients.allergies' | translate }}</h3></div>
          <div class="card-body">
            @for (a of p().allergies ?? []; track a.id) {
              <div class="list-item">
                <div class="flex-1"><span class="strong">{{ a.substance }}</span>@if (a.reaction) { <span class="muted"> — {{ a.reaction }}</span> }</div>
                @if (a.severity) { <cf-chip [status]="a.severity" group="severity" /> }
                @if (canWrite) { <button type="button" class="btn ghost xs danger-text" (click)="removeAllergy(a.id)">{{ 'common.remove' | translate }}</button> }
              </div>
            } @empty { <div class="muted">{{ 'patients.noAllergies' | translate }}</div> }
            @if (canWrite) {
              <form class="row wrap mt-2" (ngSubmit)="addAllergy()">
                <input class="input sm flex-1" [placeholder]="'patients.substance' | translate" [(ngModel)]="substance" name="substance" required />
                <input class="input sm flex-1" [placeholder]="'patients.reaction' | translate" [(ngModel)]="reaction" name="reaction" />
                <select class="input sm" style="width: 150px" [(ngModel)]="severity" name="severity">
                  <option value="">{{ 'patients.severity' | translate }}</option>@for (s of severities; track s) { <option [value]="s">{{ lang.enumLabel(s, 'severity') }}</option> }
                </select>
                <button class="btn sm primary" type="submit" [disabled]="saving() || !substance.trim()">{{ 'common.add' | translate }}</button>
              </form>
            }
          </div>
        </div>
        <div class="card">
          <div class="card-header"><h3>{{ 'patients.activePrescriptions' | translate }}</h3></div>
          <div class="card-body">
            @for (rx of p().prescriptions ?? []; track rx.id) {
              <div class="list-item"><div class="flex-1"><span class="strong">{{ rx.medication }}</span> <span class="muted">{{ rx.dosage }} · {{ rx.frequency }}</span>@if (rx.durationDays) { <span class="muted"> · {{ 'common.units.days' | translate: { n: rx.durationDays } }}</span> }</div><cf-chip [status]="rx.status" group="status" /></div>
            } @empty { <div class="muted">{{ 'patients.noPrescriptions' | translate }}</div> }
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
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
  readonly changed = output<void>();
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
    if (!(await this.confirm.ask({ title: this.lang.t('patients.removeAllergy'), message: this.lang.t('patients.removeAllergyConfirm'), danger: true, confirmText: this.lang.t('common.remove') }))) return;
    this.api.removeAllergy(this.p().id, id).subscribe({ next: () => this.changed.emit(), error: (err) => this.toast.fromError(err) });
  }
}
