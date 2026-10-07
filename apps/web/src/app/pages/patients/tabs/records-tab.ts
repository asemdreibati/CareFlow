import { Component, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { RecordsApi } from '../../../core/api/records.api';
import { AuthService } from '../../../core/auth.service';
import { ToastService } from '../../../core/toast.service';
import { LanguageService } from '../../../core/i18n/language.service';
import { Encounter, Patient } from '../../../core/models';
import { StatusChipComponent } from '../../../shared/status-chip';
import { DialogComponent } from '../../../shared/dialog';
import { DoctorsApi } from '../../../core/api/doctors.api';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'cf-patient-records',
  imports: [RouterLink, TranslatePipe, StatusChipComponent, DialogComponent, FormsModule],
  template: `
    <div class="card">
      <div class="card-header">
        <h3>{{ 'encounters.title' | translate }}</h3>
        @if (canWrite) { <button type="button" class="btn sm primary" (click)="startCreate()" [disabled]="creating()">+ {{ 'encounters.new' | translate }}</button> }
      </div>
      @if (loading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
      @else if (error()) { <div class="empty">{{ error() }}</div> }
      @else {
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{{ 'common.date' | translate }}</th><th>{{ 'common.doctor' | translate }}</th><th>{{ 'encounters.chiefComplaint' | translate }}</th><th>{{ 'encounters.diagnoses' | translate }}</th><th>{{ 'common.status' | translate }}</th><th></th></tr></thead>
            <tbody>
              @for (e of encounters(); track e.id) {
                <tr class="clickable" (click)="open(e)">
                  <td class="nowrap">{{ lang.formatDateTime(e.occurredAt) }}</td>
                  <td>{{ e.doctor?.title }} {{ e.doctor?.firstName }} {{ e.doctor?.lastName }}</td>
                  <td class="truncate" style="max-width: 260px">{{ e.chiefComplaint || '—' }}</td>
                  <td class="muted small">@for (d of e.diagnoses ?? []; track d.id) { <span class="chip gray" [class.teal]="d.isPrimary">{{ d.code }}</span> } @empty { — }</td>
                  <td><cf-chip [status]="e.status" group="status" /></td>
                  <td class="actions"><a class="btn xs" [routerLink]="['/encounters', e.id]" (click)="$event.stopPropagation()">{{ 'common.open' | translate }}</a></td>
                </tr>
              } @empty { <tr><td colspan="6" class="empty">{{ 'encounters.none' | translate }}</td></tr> }
            </tbody>
          </table>
        </div>
      }
    </div>
    @if (dialog()) {
      <cf-dialog [title]="'encounters.new' | translate" [width]="460" (closed)="dialog.set(false)">
        <p class="muted">{{ 'encounters.draftFor' | translate: { name: p().firstName + ' ' + p().lastName } }}</p>
        @if (needsDoctor) {
          <div class="field"><label class="req">{{ 'common.doctor' | translate }}</label>
            <select class="input" [(ngModel)]="doctorId"><option value="">{{ 'doctors.select' | translate }}</option>@for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }</select>
          </div>
        }
        <div class="field"><label>{{ 'encounters.chiefComplaint' | translate }}</label><input class="input" [(ngModel)]="chiefComplaint" [placeholder]="'encounters.chiefComplaintPlaceholder' | translate" /></div>
        <div footer>
          <button type="button" class="btn" (click)="dialog.set(false)">{{ 'common.cancel' | translate }}</button>
          <button type="button" class="btn primary" (click)="create()" [disabled]="creating() || (needsDoctor && !doctorId)">{{ (creating() ? 'common.creating' : 'encounters.createOpen') | translate }}</button>
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
  readonly lang = inject(LanguageService);
  readonly p = input.required<Patient>({ alias: 'patient' });
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
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('encounters.unavailable'))); },
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
