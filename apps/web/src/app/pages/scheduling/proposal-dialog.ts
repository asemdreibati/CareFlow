import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { ToastService, errorMessage } from '../../core/toast.service';
import { Doctor, ProposalItem, RescheduleProposal, TimeOffImpact, TimeOffImpactDto } from '../../core/models';
import { fmtDateTime, fmtTime } from '../../core/date-utils';
import { DialogComponent } from '../../shared/dialog';
import { StatusChipComponent } from '../../shared/status-chip';

/** Two-step: impact preview (affected appointments) → create the persisted proposal. */
@Component({
  selector: 'cf-proposal-dialog',
  imports: [FormsModule, DialogComponent, StatusChipComponent],
  template: `
    <cf-dialog title="Plan time off with rescheduling" [width]="640" (closed)="closed.emit()">
      @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      <div class="form-grid">
        <div class="field span-2"><label class="req">Doctor</label>
          <select class="input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); impact.set(null)">
            <option value="">Select doctor…</option>
            @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
          </select>
        </div>
        <div class="field"><label class="req">Time off from</label><input class="input" type="datetime-local" [ngModel]="startsAt()" (ngModelChange)="startsAt.set($event); impact.set(null)" /></div>
        <div class="field"><label class="req">To</label><input class="input" type="datetime-local" [ngModel]="endsAt()" (ngModelChange)="endsAt.set($event); impact.set(null)" /></div>
        <div class="field span-2"><label>Reason</label><input class="input" [(ngModel)]="reason" placeholder="Vacation, conference…" /></div>
        <div class="field"><label>Search window</label>
          <div class="row gap-1"><input class="input" type="number" min="1" max="60" style="width: 90px" [(ngModel)]="searchDays" /><span class="muted small">days after the time off</span></div>
        </div>
        <div class="field" style="justify-content: flex-end">
          <label class="checkbox"><input type="checkbox" [(ngModel)]="allowOtherDoctors" /> Allow other doctors of the same specialty</label>
          <label class="checkbox"><input type="checkbox" [(ngModel)]="createTimeOff" /> Also create the time-off entry</label>
        </div>
      </div>

      @if (impact(); as im) {
        <div class="divider"></div>
        <h3 class="mb-1">Impact preview</h3>
        @if (!im.affected.length) {
          <div class="inline-alert success">No active appointments fall in this range — the time off can be added directly.</div>
        } @else {
          <div class="inline-alert info">
            <strong>{{ im.affected.length }}</strong> appointment{{ im.affected.length === 1 ? '' : 's' }} affected
            · {{ movable() }} can be moved automatically
            @if (im.unresolvedAppointmentIds.length) { · <span class="danger-text">{{ im.unresolvedAppointmentIds.length }} without a free slot</span> }
            · total displacement {{ im.totalDisplacementMinutes }} min
            @if (im.candidateCount !== undefined) { <span class="subtle">· {{ im.candidateCount }} candidate slots</span> }
          </div>
          <div class="table-wrap" style="max-height: 240px; overflow-y: auto">
            <table class="table">
              <thead><tr><th>When</th><th>Patient</th><th>Status</th><th>Proposed</th></tr></thead>
              <tbody>
                @for (a of im.affected; track a.id) {
                  <tr>
                    <td class="nowrap">{{ fmtDateTime(a.startsAt) }}</td>
                    <td>{{ a.patientName }}</td>
                    <td><cf-chip [status]="a.status" /></td>
                    <td class="nowrap">@if (proposedFor(a.id); as it) { {{ fmtDateTime(it.to) }}@if (it.toDoctorId && it.toDoctorId !== it.fromDoctorId) { <span class="chip purple" style="margin-left: 6px">→ {{ it.toDoctorName || 'other doctor' }}</span> } } @else { <span class="danger-text">unresolved</span> }</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      }
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        @if (!impact()) {
          <button type="button" class="btn primary" (click)="preview()" [disabled]="!valid() || busy()">{{ busy() ? 'Computing…' : 'Preview impact' }}</button>
        } @else {
          <button type="button" class="btn" (click)="impact.set(null)">Edit</button>
          <button type="button" class="btn primary" (click)="create()" [disabled]="busy()">{{ busy() ? 'Creating…' : 'Create proposal' }}</button>
        }
      </div>
    </cf-dialog>
  `,
})
export class ProposalDialogComponent {
  private readonly api = inject(SchedulingApi);
  private readonly toast = inject(ToastService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly closed = output<void>();
  readonly created = output<RescheduleProposal>();
  readonly fmtDateTime = fmtDateTime;
  readonly fmtTime = fmtTime;
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
      error: (err) => { this.busy.set(false); this.error.set(errorMessage(err, 'Impact preview unavailable.')); },
    });
  }
  create() {
    this.busy.set(true); this.error.set(null);
    this.api.createProposal({ ...this.range(), reason: this.reason || undefined, createTimeOff: this.createTimeOff }).subscribe({
      next: (p) => { this.busy.set(false); this.toast.success('Proposal created'); this.created.emit(p); },
      error: (err) => { this.busy.set(false); this.error.set(errorMessage(err)); },
    });
  }
}
