import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Doctor, ProposalItem, RescheduleProposal, TimeOffImpact, TimeOffImpactDto } from '../../core/models';
import { DialogComponent } from '../../shared/dialog';
import { StatusChipComponent } from '../../shared/status-chip';

/** Two-step: impact preview (affected appointments) → create the persisted proposal. */
@Component({
  selector: 'cf-proposal-dialog',
  imports: [FormsModule, TranslatePipe, DialogComponent, StatusChipComponent],
  template: `
    <cf-dialog [title]="'doctors.planTimeOff' | translate" [width]="640" (closed)="closed.emit()">
      @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      <div class="form-grid">
        <div class="field span-2"><label class="req">{{ 'common.doctor' | translate }}</label>
          <select class="input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); impact.set(null)">
            <option value="">{{ 'doctors.select' | translate }}</option>
            @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
          </select>
        </div>
        <div class="field"><label class="req">{{ 'proposals.timeOffFrom' | translate }}</label><input class="input" type="datetime-local" [ngModel]="startsAt()" (ngModelChange)="startsAt.set($event); impact.set(null)" /></div>
        <div class="field"><label class="req">{{ 'common.to' | translate }}</label><input class="input" type="datetime-local" [ngModel]="endsAt()" (ngModelChange)="endsAt.set($event); impact.set(null)" /></div>
        <div class="field span-2"><label>{{ 'common.reason' | translate }}</label><input class="input" [(ngModel)]="reason" [placeholder]="'doctors.timeOffReasonPlaceholder' | translate" /></div>
        <div class="field"><label>{{ 'proposals.searchWindow' | translate }}</label>
          <div class="row gap-1"><input class="input" type="number" min="1" max="60" style="width: 90px" [(ngModel)]="searchDays" /><span class="muted small">{{ 'proposals.daysAfter' | translate }}</span></div>
        </div>
        <div class="field" style="justify-content: flex-end">
          <label class="checkbox"><input type="checkbox" [(ngModel)]="allowOtherDoctors" /> {{ 'proposals.allowOtherDoctors' | translate }}</label>
          <label class="checkbox"><input type="checkbox" [(ngModel)]="createTimeOff" /> {{ 'proposals.alsoCreateTimeOff' | translate }}</label>
        </div>
      </div>

      @if (impact(); as im) {
        <div class="divider"></div>
        <h3 class="mb-1">{{ 'proposals.impactPreview' | translate }}</h3>
        @if (!im.affected.length) {
          <div class="inline-alert success">{{ 'proposals.noneAffected' | translate }}</div>
        } @else {
          <div class="inline-alert info">
            <strong>{{ 'proposals.affectedCount' | translate: { n: im.affected.length } }}</strong>
            · {{ 'proposals.movable' | translate: { n: movable() } }}
            @if (im.unresolvedAppointmentIds.length) { · <span class="danger-text">{{ 'proposals.withoutSlot' | translate: { n: im.unresolvedAppointmentIds.length } }}</span> }
            · {{ 'proposals.totalDisplacement' | translate: { min: lang.formatMinutes(im.totalDisplacementMinutes) } }}
            @if (im.candidateCount !== undefined) { <span class="subtle">· {{ 'proposals.candidateSlots' | translate: { n: im.candidateCount } }}</span> }
          </div>
          <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
            <table class="table">
              <thead><tr><th>{{ 'common.when' | translate }}</th><th>{{ 'common.patient' | translate }}</th><th>{{ 'common.status' | translate }}</th><th>{{ 'proposals.proposed' | translate }}</th></tr></thead>
              <tbody>
                @for (a of im.affected; track a.id) {
                  <tr>
                    <td class="nowrap">{{ lang.formatDateTime(a.startsAt) }}</td>
                    <td>{{ a.patientName }}</td>
                    <td><cf-chip [status]="a.status" group="status" /></td>
                    <td class="nowrap">@if (proposedFor(a.id); as it) { {{ lang.formatDateTime(it.to) }}@if (it.toDoctorId && it.toDoctorId !== it.fromDoctorId) { <span class="chip purple" style="margin-inline-start: 6px"><span class="mirror">→</span> {{ it.toDoctorName || ('proposals.otherDoctor' | translate) }}</span> } } @else { <span class="danger-text">{{ 'proposals.unresolvedLower' | translate }}</span> }</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">{{ 'common.cancel' | translate }}</button>
        @if (!impact()) {
          <button type="button" class="btn primary" (click)="preview()" [disabled]="!valid() || busy()">{{ (busy() ? 'proposals.computing' : 'proposals.previewImpact') | translate }}</button>
        } @else {
          <button type="button" class="btn" (click)="impact.set(null)">{{ 'common.edit' | translate }}</button>
          <button type="button" class="btn primary" (click)="create()" [disabled]="busy()">{{ (busy() ? 'common.creating' : 'proposals.create') | translate }}</button>
        }
      </div>
    </cf-dialog>
  `,
})
export class ProposalDialogComponent {
  private readonly api = inject(SchedulingApi);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly closed = output<void>();
  readonly created = output<RescheduleProposal>();
  readonly doctorId = signal('');
  readonly startsAt = signal('');
  readonly endsAt = signal('');
  readonly impact = signal<TimeOffImpact | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  reason = ''; searchDays = 14; allowOtherDoctors = true; createTimeOff = true;
  readonly valid = computed(() => !!this.doctorId() && !!this.startsAt() && !!this.endsAt() && this.endsAt() > this.startsAt());
  readonly movable = computed(() => (this.impact()?.items ?? []).filter((i) => !!i.to).length);

  ngOnInit() { this.doctorId.set(this.initialDoctorId()); }
  private range(): TimeOffImpactDto {
    return {
      doctorId: this.doctorId(), startsAt: new Date(this.startsAt()).toISOString(), endsAt: new Date(this.endsAt()).toISOString(),
      allowOtherDoctors: this.allowOtherDoctors, searchDays: Number(this.searchDays) || 14,
    };
  }
  proposedFor(appointmentId: string): ProposalItem | null {
    const it = this.impact()?.items.find((i) => i.appointmentId === appointmentId);
    return it?.to ? it : null;
  }
  preview() {
    if (!this.valid()) return;
    this.busy.set(true); this.error.set(null);
    this.api.timeOffImpact(this.range()).subscribe({
      next: (im) => {
        this.busy.set(false);
        this.impact.set({ ...im, affected: im?.affected ?? [], items: im?.items ?? [], unresolvedAppointmentIds: im?.unresolvedAppointmentIds ?? [], totalDisplacementMinutes: im?.totalDisplacementMinutes ?? 0 });
      },
      error: (err) => { this.busy.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('proposals.previewUnavailable'))); },
    });
  }
  create() {
    this.busy.set(true); this.error.set(null);
    this.api.createProposal({ ...this.range(), reason: this.reason || undefined, createTimeOff: this.createTimeOff }).subscribe({
      next: (p) => { this.busy.set(false); this.toast.success(this.lang.t('proposals.created')); this.created.emit(p); },
      error: (err) => { this.busy.set(false); this.error.set(this.lang.errorMessage(err)); },
    });
  }
}
