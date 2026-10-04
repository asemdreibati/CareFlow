import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { RecordsApi } from '../../core/api/records.api';
import { SeriesApi } from '../../core/api/series.api';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { isResourceConflict, isVersionConflict } from '../../core/api/booking-headers';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { APPOINTMENT_TRANSITIONS, APPOINTMENT_TYPES, Appointment, AppointmentStatus, AppointmentType, Reminder } from '../../core/models';
import { fmtDateTime, toLocalInput } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';
import { RiskBadgeComponent } from '../../shared/risk-badge';
import { ResourceSelectComponent } from '../../shared/resource-select';

const LABELS: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Schedule', CONFIRMED: 'Confirm', CHECKED_IN: 'Check in', IN_PROGRESS: 'Start visit', COMPLETED: 'Complete', CANCELLED: 'Cancel', NO_SHOW: 'No-show',
};

@Component({
  selector: 'cf-appointment-detail',
  imports: [FormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, DialogComponent, RiskBadgeComponent, ResourceSelectComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (appt(); as a) {
        <cf-page-header title="Appointment" [subtitle]="fmt(a.startsAt) + ' → ' + fmtTime(a.endsAt)">
          <cf-chip [status]="a.status" />
          <cf-risk-badge [risk]="a.noShowRisk" />
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
                  <dt>Resources</dt><dd>
                    @if (a.resources?.length) {
                      <span class="row gap-1 wrap">@for (r of a.resources; track r.id) { <span class="chip" [class]="'chip ' + resourceColor(r.type)"><span class="pill-color" [style.background]="r.color || '#6b7280'"></span>{{ r.name }}</span> }</span>
                    } @else { <span class="muted">None</span> }
                  </dd>
                  @if (a.cancellationNote) { <dt>Cancellation</dt><dd class="danger-text">{{ a.cancellationNote }}</dd> }
                  @if (a.holdExpiresAt) { <dt>Hold</dt><dd class="danger-text">Waitlist offer — held until {{ fmt(a.holdExpiresAt) }}</dd> }
                  <dt>Created</dt><dd class="muted">{{ fmt(a.createdAt) }}@if (a.version) { <span class="subtle"> · v{{ a.version }}</span> }</dd>
                </dl>
              </div>
            </div>

            @if (a.seriesId) {
              <div class="card">
                <div class="card-header"><h3>Recurring series</h3>
                  <div class="row gap-1">
                    <a class="btn sm" [routerLink]="['/series', a.seriesId]">Open series</a>
                    @if (canWrite && editable()) { <button type="button" class="btn sm" (click)="detach()" [disabled]="busy()">Detach</button> }
                  </div>
                </div>
                <div class="card-body">
                  <div class="row gap-2 wrap">
                    <span><strong>Occurrence {{ (a.occurrenceIndex ?? 0) + 1 }}</strong>@if (seriesTotal(); as n) { of {{ n }} }</span>
                    @if (a.series?.frequency) { <span class="chip teal">{{ a.series!.frequency.toLowerCase() }}@if (a.series!.interval > 1) { · every {{ a.series!.interval }} }</span> }
                    @if (a.isException) { <span class="chip amber" title="Edited or moved away from the series rule">exception</span> }
                  </div>
                  <p class="subtle mt-1">Editing this occurrence marks it as an exception; detaching removes it from the series so it can be managed independently.</p>
                </div>
              </div>
            }

            @if (canSchedule) {
              <div class="card">
                <div class="card-header"><h3>Reminders</h3>@if (remindersLoading()) { <span class="spinner"></span> }</div>
                @if (remindersError()) { <div class="empty">{{ remindersError() }}</div> }
                @else {
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>Channel</th><th>Scheduled</th><th>Status</th><th>Sent / error</th></tr></thead>
                      <tbody>
                        @for (r of reminders(); track r.id) {
                          <tr>
                            <td><cf-chip [status]="r.channel" /></td>
                            <td class="nowrap">{{ fmt(r.scheduledFor) }}</td>
                            <td><cf-chip [status]="r.status" /></td>
                            <td class="small">@if (r.sentAt) { {{ fmt(r.sentAt) }} } @else if (r.lastError) { <span class="danger-text">{{ r.lastError }}</span> } @else { <span class="muted">—@if (r.attempts) { {{ r.attempts }} attempt(s) }</span> }</td>
                          </tr>
                        } @empty { <tr><td colspan="4" class="empty">No reminders scheduled.</td></tr> }
                      </tbody>
                    </table>
                  </div>
                }
              </div>
            }
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
        @if (appt()?.seriesId) { <div class="inline-alert info">This appointment belongs to a series — saving marks it as an exception.</div> }
        <div class="form-grid">
          <div class="field"><label>Starts at</label><input class="input" type="datetime-local" [(ngModel)]="edit.startsAt" /></div>
          <div class="field"><label>Ends at</label><input class="input" type="datetime-local" [(ngModel)]="edit.endsAt" /></div>
          <div class="field"><label>Type</label><select class="input" [(ngModel)]="edit.type">@for (t of types; track t) { <option [value]="t">{{ t }}</option> }</select></div>
          <div class="field span-2"><label>Reason</label><input class="input" [(ngModel)]="edit.reason" /></div>
          <div class="field span-2"><label>Notes</label><textarea class="input" rows="2" [(ngModel)]="edit.notes"></textarea></div>
          <div class="field span-2"><label>Resources</label><cf-resource-select [selected]="edit.resourceIds" (selectedChange)="edit.resourceIds = $event" /></div>
        </div>
        @if (editError()) { <div class="inline-alert error" style="white-space: pre-line">{{ editError() }}</div> }
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
  private readonly seriesApi = inject(SeriesApi);
  private readonly scheduling = inject(SchedulingApi);
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
  edit: { startsAt: string; endsAt: string; type: AppointmentType; reason: string; notes: string; resourceIds: string[] } = { startsAt: '', endsAt: '', type: 'CONSULTATION', reason: '', notes: '', resourceIds: [] };
  readonly reminders = signal<Reminder[]>([]);
  readonly remindersLoading = signal(false);
  readonly remindersError = signal<string | null>(null);
  readonly seriesTotal = signal<number | null>(null);
  readonly canWrite = this.auth.hasPermission('appointments:write');
  readonly canSchedule = this.auth.hasPermission('scheduling:manage');
  readonly canRecords = this.auth.hasPermission('records:read');
  readonly canWriteRecords = this.auth.hasPermission('records:write');
  readonly needsDoctor = !this.auth.doctorId();
  readonly nextStatuses = computed(() => (this.appt() ? APPOINTMENT_TRANSITIONS[this.appt()!.status] : []));
  readonly editable = computed(() => !!this.appt() && !['COMPLETED', 'CANCELLED'].includes(this.appt()!.status));

  ngOnInit() { this.load(); }
  load() {
    this.api.get(this.id()).subscribe({
      next: (a) => {
        this.appt.set(a);
        if (a.seriesId && this.seriesTotal() === null) this.seriesApi.get(a.seriesId).subscribe({
          next: (s) => this.seriesTotal.set(s.count ?? (s.occurrences ?? s.appointments)?.length ?? null), error: () => undefined,
        });
        if (this.canSchedule) this.loadReminders();
      },
      error: (err) => { this.error.set('Could not load appointment.'); this.toast.fromError(err); },
    });
  }
  loadReminders() {
    this.remindersLoading.set(true); this.remindersError.set(null);
    this.scheduling.reminders({ appointmentId: this.id() }).subscribe({
      next: (r) => { this.reminders.set([...r].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))); this.remindersLoading.set(false); },
      error: (err) => { this.remindersLoading.set(false); this.remindersError.set(errorMessage(err, 'Reminders unavailable.')); },
    });
  }
  resourceColor(type: string) { return ({ ROOM: 'teal', EQUIPMENT: 'purple', STAFF: 'blue' } as Record<string, string>)[type] ?? 'gray'; }
  /** Optimistic-locking conflict → toast with a Reload action that refetches the appointment. */
  private handleConflict(err: unknown): boolean {
    if (!isVersionConflict(err)) return false;
    this.toast.versionConflict(() => this.load());
    return true;
  }
  async detach() {
    const a = this.appt();
    if (!a?.seriesId || a.occurrenceIndex === null || a.occurrenceIndex === undefined) return;
    if (!(await this.confirm.ask({ title: 'Detach from series', message: 'Remove this occurrence from its series? It will keep its time and can then be edited independently.', confirmText: 'Detach' }))) return;
    this.busy.set(true);
    this.seriesApi.detach(a.seriesId, a.occurrenceIndex).subscribe({
      next: () => { this.busy.set(false); this.toast.success('Detached from series'); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }

  async transition(s: AppointmentStatus) {
    if (s === 'CANCELLED') { this.cancelNote = ''; this.cancelDialog.set(true); return; }
    if (s === 'NO_SHOW' && !(await this.confirm.ask({ title: 'Mark as no-show', message: 'Mark this appointment as a no-show?', confirmText: 'Mark no-show', danger: true }))) return;
    this.setStatus(s);
  }
  doCancel() { this.setStatus('CANCELLED', this.cancelNote || undefined); }
  private setStatus(s: AppointmentStatus, note?: string) {
    this.busy.set(true);
    this.api.setStatus(this.id(), s, note, this.appt()?.version).subscribe({
      next: () => { this.busy.set(false); this.cancelDialog.set(false); this.toast.success(`Appointment ${s.toLowerCase().replace('_', ' ')}`); this.load(); },
      error: (err) => { this.busy.set(false); if (!this.handleConflict(err)) this.toast.fromError(err); },
    });
  }

  startEdit() {
    const a = this.appt()!;
    this.edit = { startsAt: toLocalInput(a.startsAt), endsAt: toLocalInput(a.endsAt), type: a.type ?? 'CONSULTATION', reason: a.reason ?? '', notes: a.notes ?? '', resourceIds: (a.resources ?? []).map((r) => r.id) };
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
    const currentRes = (a.resources ?? []).map((r) => r.id).sort().join(',');
    if ([...this.edit.resourceIds].sort().join(',') !== currentRes) dto['resourceIds'] = this.edit.resourceIds;
    if (!Object.keys(dto).length) { this.editDialog.set(false); return; }
    this.busy.set(true);
    this.api.update(a.id, dto, a.version).subscribe({
      next: () => { this.busy.set(false); this.editDialog.set(false); this.toast.success('Appointment updated'); this.load(); },
      error: (err) => {
        this.busy.set(false);
        if (this.handleConflict(err)) { this.editDialog.set(false); return; }
        this.editError.set(isResourceConflict(err) ? errorMessage(err) : err?.error?.message ? [].concat(err.error.message).join('\n') : 'Could not update');
      },
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
