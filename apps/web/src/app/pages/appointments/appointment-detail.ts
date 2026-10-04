import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { RecordsApi } from '../../core/api/records.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { APPOINTMENT_TRANSITIONS, APPOINTMENT_TYPES, Appointment, AppointmentStatus, AppointmentType } from '../../core/models';
import { fmtDateTime, toLocalInput } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';

const LABELS: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Schedule', CONFIRMED: 'Confirm', CHECKED_IN: 'Check in', IN_PROGRESS: 'Start visit', COMPLETED: 'Complete', CANCELLED: 'Cancel', NO_SHOW: 'No-show',
};

@Component({
  selector: 'cf-appointment-detail',
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, DialogComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (appt(); as a) {
        <cf-page-header title="Appointment" [subtitle]="fmt(a.startsAt) + ' → ' + fmtTime(a.endsAt)">
          <cf-chip [status]="a.status" />
          <a class="btn" routerLink="/calendar">Back to calendar</a>
        </cf-page-header>

        <div class="grid" style="grid-template-columns: 3fr 2fr">
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>Details</h3>
                @if (canWrite && editable()) { <button type="button" class="btn sm" (click)="startEdit()">Reschedule / edit</button> }
              </div>
              <div class="card-body">
                <dl class="kv">
                  <dt>Patient</dt><dd><a [routerLink]="['/patients', a.patientId]">{{ a.patient?.firstName }} {{ a.patient?.lastName }}</a> <span class="muted">· {{ a.patient?.mrn }}@if (a.patient?.phone) { · {{ a.patient?.phone }} }</span></dd>
                  <dt>Doctor</dt><dd><span class="row gap-1"><span class="pill-color" [style.background]="a.doctor?.color || '#94a3b8'"></span><a [routerLink]="['/doctors', a.doctorId]">{{ a.doctor?.title }} {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</a></span></dd>
                  <dt>When</dt><dd>{{ fmt(a.startsAt) }} – {{ fmtTime(a.endsAt) }}</dd>
                  <dt>Type</dt><dd>{{ a.type || '—' }}</dd>
                  <dt>Reason</dt><dd>{{ a.reason || '—' }}</dd>
                  <dt>Notes</dt><dd style="white-space: pre-line">{{ a.notes || '—' }}</dd>
                  @if (a.cancellationNote) { <dt>Cancellation</dt><dd class="danger-text">{{ a.cancellationNote }}</dd> }
                  <dt>Created</dt><dd class="muted">{{ fmt(a.createdAt) }}</dd>
                </dl>
              </div>
            </div>
          </div>
          <div class="col">
            @if (canWrite) {
              <div class="card">
                <div class="card-header"><h3>Status</h3></div>
                <div class="card-body">
                  @if (!nextStatuses().length) { <div class="muted">No further actions — this appointment is {{ a.status.toLowerCase().replace('_', ' ') }}.</div> }
                  <div class="btn-group">
                    @for (s of nextStatuses(); track s) {
                      <button type="button" class="btn" [class.primary]="s === 'CONFIRMED' || s === 'CHECKED_IN' || s === 'IN_PROGRESS'" [class.success]="s === 'COMPLETED'"
                        [class.danger-outline]="s === 'CANCELLED' || s === 'NO_SHOW'" [disabled]="busy()" (click)="transition(s)">{{ labels[s] }}</button>
                    }
                  </div>
                </div>
              </div>
            }
            @if (canRecords) {
              <div class="card">
                <div class="card-header"><h3>Encounter</h3></div>
                <div class="card-body">
                  @if (a.encounter) {
                    <div class="row between"><span>Encounter <cf-chip [status]="a.encounter.status" /></span><a class="btn sm primary" [routerLink]="['/encounters', a.encounter.id]">Open encounter</a></div>
                  } @else {
                    <p class="muted">No encounter documented yet.</p>
                    @if (canWriteRecords) {
                      <button type="button" class="btn primary" (click)="openEncounter()" [disabled]="busy() || a.status === 'CANCELLED' || a.status === 'NO_SHOW'">Open encounter</button>
                      @if (needsDoctor) { <div class="subtle mt-1">Will be created on behalf of {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}.</div> }
                    }
                  }
                </div>
              </div>
            }
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> Loading…</div> }
    </div>

    @if (cancelDialog()) {
      <cf-dialog title="Cancel appointment" [width]="440" (closed)="cancelDialog.set(false)">
        <div class="field"><label>Cancellation note</label><textarea class="input" rows="3" [(ngModel)]="cancelNote" placeholder="Reason (optional)"></textarea></div>
        <div footer>
          <button type="button" class="btn" (click)="cancelDialog.set(false)">Keep</button>
          <button type="button" class="btn danger" (click)="doCancel()" [disabled]="busy()">Cancel appointment</button>
        </div>
      </cf-dialog>
    }
    @if (editDialog()) {
      <cf-dialog title="Reschedule / edit" [width]="520" (closed)="editDialog.set(false)">
        <div class="form-grid">
          <div class="field"><label>Starts at</label><input class="input" type="datetime-local" [(ngModel)]="edit.startsAt" /></div>
          <div class="field"><label>Ends at</label><input class="input" type="datetime-local" [(ngModel)]="edit.endsAt" /></div>
          <div class="field"><label>Type</label><select class="input" [(ngModel)]="edit.type">@for (t of types; track t) { <option [value]="t">{{ t }}</option> }</select></div>
          <div class="field span-2"><label>Reason</label><input class="input" [(ngModel)]="edit.reason" /></div>
          <div class="field span-2"><label>Notes</label><textarea class="input" rows="2" [(ngModel)]="edit.notes"></textarea></div>
        </div>
        @if (editError()) { <div class="inline-alert error">{{ editError() }}</div> }
        <div footer>
          <button type="button" class="btn" (click)="editDialog.set(false)">Cancel</button>
          <button type="button" class="btn primary" (click)="saveEdit()" [disabled]="busy()">Save</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class AppointmentDetailPage {
  private readonly api = inject(AppointmentsApi);
  private readonly records = inject(RecordsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  readonly id = input.required<string>();
  readonly fmt = fmtDateTime;
  readonly fmtTime = (v: string) => fmtDateTime(v).split(', ')[1] ?? '';
  readonly labels = LABELS;
  readonly types = APPOINTMENT_TYPES;
  readonly appt = signal<Appointment | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly cancelDialog = signal(false);
  readonly editDialog = signal(false);
  readonly editError = signal<string | null>(null);
  cancelNote = '';
  edit: { startsAt: string; endsAt: string; type: AppointmentType; reason: string; notes: string } = { startsAt: '', endsAt: '', type: 'CONSULTATION', reason: '', notes: '' };
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly canRecords = this.auth.hasPermission('records:read');
  readonly canWriteRecords = this.auth.hasPermission('records:write');
  readonly needsDoctor = !this.auth.doctorId();
  readonly nextStatuses = computed(() => (this.appt() ? APPOINTMENT_TRANSITIONS[this.appt()!.status] : []));
  readonly editable = computed(() => !!this.appt() && !['COMPLETED', 'CANCELLED'].includes(this.appt()!.status));

  ngOnInit() { this.load(); }
  load() {
    this.api.get(this.id()).subscribe({ next: (a) => this.appt.set(a), error: (err) => { this.error.set('Could not load appointment.'); this.toast.fromError(err); } });
  }

  async transition(s: AppointmentStatus) {
    if (s === 'CANCELLED') { this.cancelNote = ''; this.cancelDialog.set(true); return; }
    if (s === 'NO_SHOW' && !(await this.confirm.ask({ title: 'Mark as no-show', message: 'Mark this appointment as a no-show?', confirmText: 'Mark no-show', danger: true }))) return;
    this.setStatus(s);
  }
  doCancel() { this.setStatus('CANCELLED', this.cancelNote || undefined); }
  private setStatus(s: AppointmentStatus, note?: string) {
    this.busy.set(true);
    this.api.setStatus(this.id(), s, note).subscribe({
      next: () => { this.busy.set(false); this.cancelDialog.set(false); this.toast.success(`Appointment ${s.toLowerCase().replace('_', ' ')}`); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }

  startEdit() {
    const a = this.appt()!;
    this.edit = { startsAt: toLocalInput(a.startsAt), endsAt: toLocalInput(a.endsAt), type: a.type ?? 'CONSULTATION', reason: a.reason ?? '', notes: a.notes ?? '' };
    this.editError.set(null);
    this.editDialog.set(true);
  }
  saveEdit() {
    const a = this.appt()!;
    const dto: Record<string, unknown> = {};
    const s = new Date(this.edit.startsAt).toISOString(); const e = new Date(this.edit.endsAt).toISOString();
    if (s !== a.startsAt) dto['startsAt'] = s;
    if (e !== a.endsAt) dto['endsAt'] = e;
    if (this.edit.type !== a.type) dto['type'] = this.edit.type;
    if ((this.edit.reason || '') !== (a.reason || '')) dto['reason'] = this.edit.reason;
    if ((this.edit.notes || '') !== (a.notes || '')) dto['notes'] = this.edit.notes;
    if (!Object.keys(dto).length) { this.editDialog.set(false); return; }
    this.busy.set(true);
    this.api.update(a.id, dto).subscribe({
      next: () => { this.busy.set(false); this.editDialog.set(false); this.toast.success('Appointment updated'); this.load(); },
      error: (err) => { this.busy.set(false); this.editError.set(err?.error?.message ? [].concat(err.error.message).join('\n') : 'Could not update'); },
    });
  }

  openEncounter() {
    const a = this.appt()!;
    if (a.encounter) { void this.router.navigate(['/encounters', a.encounter.id]); return; }
    this.busy.set(true);
    this.records.createEncounter(a.patientId, { appointmentId: a.id, chiefComplaint: a.reason ?? undefined, doctorId: this.needsDoctor ? a.doctorId : undefined }).subscribe({
      next: (e) => void this.router.navigate(['/encounters', e.id]),
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
}
