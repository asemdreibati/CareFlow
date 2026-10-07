import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { RecordsApi } from '../../core/api/records.api';
import { SeriesApi } from '../../core/api/series.api';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { isResourceConflict, isVersionConflict } from '../../core/api/booking-headers';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { rawServerMessage } from '../../core/i18n/api-errors';
import { ConfirmService } from '../../shared/confirm.service';
import { APPOINTMENT_TRANSITIONS, APPOINTMENT_TYPES, Appointment, AppointmentStatus, AppointmentType, Reminder } from '../../core/models';
import { toLocalInput } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { DialogComponent } from '../../shared/dialog';
import { RiskBadgeComponent } from '../../shared/risk-badge';
import { ResourceSelectComponent } from '../../shared/resource-select';

@Component({
  selector: 'cf-appointment-detail',
  imports: [FormsModule, RouterLink, TranslatePipe, PageHeaderComponent, StatusChipComponent, DialogComponent, RiskBadgeComponent, ResourceSelectComponent],
  template: `
    <div class="page" style="max-width: 1000px">
      @if (appt(); as a) {
        <cf-page-header [title]="'appointments.title' | translate" [subtitle]="lang.formatDateTime(a.startsAt) + ' – ' + lang.formatTime(a.endsAt)">
          <cf-chip [status]="a.status" group="status" />
          <cf-risk-badge [risk]="a.noShowRisk" />
          <a class="btn" routerLink="/calendar">{{ 'appointments.backToCalendar' | translate }}</a>
        </cf-page-header>

        <div class="grid" style="grid-template-columns: 3fr 2fr">
          <div class="col">
            <div class="card">
              <div class="card-header"><h3>{{ 'common.details' | translate }}</h3>
                @if (canWrite && editable()) { <button type="button" class="btn sm" (click)="startEdit()">{{ 'appointments.rescheduleEdit' | translate }}</button> }
              </div>
              <div class="card-body">
                <dl class="kv">
                  <dt>{{ 'common.patient' | translate }}</dt><dd><a [routerLink]="['/patients', a.patientId]">{{ a.patient?.firstName }} {{ a.patient?.lastName }}</a> <span class="muted">· {{ a.patient?.mrn }}@if (a.patient?.phone) { · <span dir="ltr">{{ a.patient?.phone }}</span> }</span></dd>
                  <dt>{{ 'common.doctor' | translate }}</dt><dd><span class="row gap-1"><span class="pill-color" [style.background]="a.doctor?.color || '#94a3b8'"></span><a [routerLink]="['/doctors', a.doctorId]">{{ a.doctor?.title }} {{ a.doctor?.firstName }} {{ a.doctor?.lastName }}</a></span></dd>
                  <dt>{{ 'common.when' | translate }}</dt><dd>{{ lang.formatDateTime(a.startsAt) }} – {{ lang.formatTime(a.endsAt) }}</dd>
                  <dt>{{ 'common.type' | translate }}</dt><dd>{{ a.type ? lang.enumLabel(a.type, 'type') : '—' }}</dd>
                  <dt>{{ 'common.reason' | translate }}</dt><dd>{{ a.reason || '—' }}</dd>
                  <dt>{{ 'common.notes' | translate }}</dt><dd style="white-space: pre-line">{{ a.notes || '—' }}</dd>
                  <dt>{{ 'nav.resources' | translate }}</dt><dd>
                    @if (a.resources?.length) {
                      <span class="row gap-1 wrap">@for (r of a.resources; track r.id) { <span class="chip" [class]="'chip ' + resourceColor(r.type)"><span class="pill-color" [style.background]="r.color || '#6b7280'"></span>{{ r.name }}</span> }</span>
                    } @else { <span class="muted">{{ 'common.none' | translate }}</span> }
                  </dd>
                  @if (a.cancellationNote) { <dt>{{ 'appointments.cancellation' | translate }}</dt><dd class="danger-text">{{ a.cancellationNote }}</dd> }
                  @if (a.holdExpiresAt) { <dt>{{ 'appointments.hold' | translate }}</dt><dd class="danger-text">{{ 'appointments.heldUntil' | translate: { until: lang.formatDateTime(a.holdExpiresAt) } }}</dd> }
                  <dt>{{ 'common.created' | translate }}</dt><dd class="muted">{{ lang.formatDateTime(a.createdAt) }}@if (a.version) { <span class="subtle"> · v{{ a.version }}</span> }</dd>
                </dl>
              </div>
            </div>

            @if (a.seriesId) {
              <div class="card">
                <div class="card-header"><h3>{{ 'series.title' | translate }}</h3>
                  <div class="row gap-1">
                    <a class="btn sm" [routerLink]="['/series', a.seriesId]">{{ 'series.open' | translate }}</a>
                    @if (canWrite && editable()) { <button type="button" class="btn sm" (click)="detach()" [disabled]="busy()">{{ 'series.detach' | translate }}</button> }
                  </div>
                </div>
                <div class="card-body">
                  <div class="row gap-2 wrap">
                    <span><strong>{{ 'series.occurrenceN' | translate: { n: (a.occurrenceIndex ?? 0) + 1 } }}</strong>@if (seriesTotal(); as n) { {{ 'series.ofTotal' | translate: { total: n } }} }</span>
                    @if (a.series?.frequency) { <span class="chip teal">{{ lang.enumLabel(a.series!.frequency, 'frequency') }}@if (a.series!.interval > 1) { · {{ 'series.everyShort' | translate: { n: a.series!.interval } }} }</span> }
                    @if (a.isException) { <span class="chip amber" [title]="'series.exceptionHint' | translate">{{ 'series.exception' | translate }}</span> }
                  </div>
                  <p class="subtle mt-1">{{ 'series.occurrenceHint' | translate }}</p>
                </div>
              </div>
            }

            @if (canSchedule) {
              <div class="card">
                <div class="card-header"><h3>{{ 'reminders.title' | translate }}</h3>@if (remindersLoading()) { <span class="spinner"></span> }</div>
                @if (remindersError()) { <div class="empty">{{ remindersError() }}</div> }
                @else {
                  <div class="table-wrap">
                    <table class="table">
                      <thead><tr><th>{{ 'reminders.channel' | translate }}</th><th>{{ 'reminders.scheduled' | translate }}</th><th>{{ 'common.status' | translate }}</th><th>{{ 'reminders.sentError' | translate }}</th></tr></thead>
                      <tbody>
                        @for (r of reminders(); track r.id) {
                          <tr>
                            <td><cf-chip [status]="r.channel" group="channel" /></td>
                            <td class="nowrap">{{ lang.formatDateTime(r.scheduledFor) }}</td>
                            <td><cf-chip [status]="r.status" group="status" /></td>
                            <td class="small">@if (r.sentAt) { {{ lang.formatDateTime(r.sentAt) }} } @else if (r.lastError) { <span class="danger-text">{{ r.lastError }}</span> } @else { <span class="muted">—@if (r.attempts) { {{ 'reminders.attempts' | translate: { n: r.attempts } }} }</span> }</td>
                          </tr>
                        } @empty { <tr><td colspan="4" class="empty">{{ 'reminders.none' | translate }}</td></tr> }
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
                <div class="card-header"><h3>{{ 'common.status' | translate }}</h3></div>
                <div class="card-body">
                  @if (!nextStatuses().length) { <div class="muted">{{ 'appointments.noFurtherActions' | translate: { status: lang.enumLabel(a.status, 'status') } }}</div> }
                  <div class="btn-group">
                    @for (s of nextStatuses(); track s) {
                      <button type="button" class="btn" [class.primary]="s === 'CONFIRMED' || s === 'CHECKED_IN' || s === 'IN_PROGRESS'" [class.success]="s === 'COMPLETED'"
                        [class.danger-outline]="s === 'CANCELLED' || s === 'NO_SHOW'" [disabled]="busy()" (click)="transition(s)">{{ 'appointments.actions.' + s | translate }}</button>
                    }
                  </div>
                </div>
              </div>
            }
            @if (canRecords) {
              <div class="card">
                <div class="card-header"><h3>{{ 'encounters.encounter' | translate }}</h3></div>
                <div class="card-body">
                  @if (a.encounter) {
                    <div class="row between"><span>{{ 'encounters.encounter' | translate }} <cf-chip [status]="a.encounter.status" group="status" /></span><a class="btn sm primary" [routerLink]="['/encounters', a.encounter.id]">{{ 'encounters.open' | translate }}</a></div>
                  } @else {
                    <p class="muted">{{ 'encounters.noneYet' | translate }}</p>
                    @if (canWriteRecords) {
                      <button type="button" class="btn primary" (click)="openEncounter()" [disabled]="busy() || a.status === 'CANCELLED' || a.status === 'NO_SHOW'">{{ 'encounters.open' | translate }}</button>
                      @if (needsDoctor) { <div class="subtle mt-1">{{ 'encounters.onBehalfOf' | translate: { name: (a.doctor?.firstName || '') + ' ' + (a.doctor?.lastName || '') } }}</div> }
                    }
                  }
                </div>
              </div>
            }
          </div>
        </div>
      } @else if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      @else { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
    </div>

    @if (cancelDialog()) {
      <cf-dialog [title]="'appointments.cancelTitle' | translate" [width]="440" (closed)="cancelDialog.set(false)">
        <div class="field"><label>{{ 'appointments.cancellationNote' | translate }}</label><textarea class="input" rows="3" [(ngModel)]="cancelNote" [placeholder]="'appointments.reasonOptional' | translate"></textarea></div>
        <div footer>
          <button type="button" class="btn" (click)="cancelDialog.set(false)">{{ 'appointments.keep' | translate }}</button>
          <button type="button" class="btn danger" (click)="doCancel()" [disabled]="busy()">{{ 'appointments.cancelTitle' | translate }}</button>
        </div>
      </cf-dialog>
    }
    @if (editDialog()) {
      <cf-dialog [title]="'appointments.rescheduleEdit' | translate" [width]="520" (closed)="editDialog.set(false)">
        @if (appt()?.seriesId) { <div class="inline-alert info">{{ 'series.editMarksException' | translate }}</div> }
        <div class="form-grid">
          <div class="field"><label>{{ 'appointments.startsAt' | translate }}</label><input class="input" type="datetime-local" [(ngModel)]="edit.startsAt" /></div>
          <div class="field"><label>{{ 'appointments.endsAt' | translate }}</label><input class="input" type="datetime-local" [(ngModel)]="edit.endsAt" /></div>
          <div class="field"><label>{{ 'common.type' | translate }}</label><select class="input" [(ngModel)]="edit.type">@for (t of types; track t) { <option [value]="t">{{ lang.enumLabel(t, 'type') }}</option> }</select></div>
          <div class="field span-2"><label>{{ 'common.reason' | translate }}</label><input class="input" [(ngModel)]="edit.reason" /></div>
          <div class="field span-2"><label>{{ 'common.notes' | translate }}</label><textarea class="input" rows="2" [(ngModel)]="edit.notes"></textarea></div>
          <div class="field span-2"><label>{{ 'nav.resources' | translate }}</label><cf-resource-select [selected]="edit.resourceIds" (selectedChange)="edit.resourceIds = $event" /></div>
        </div>
        @if (editError()) { <div class="inline-alert error" style="white-space: pre-line">{{ editError() }}</div> }
        <div footer>
          <button type="button" class="btn" (click)="editDialog.set(false)">{{ 'common.cancel' | translate }}</button>
          <button type="button" class="btn primary" (click)="saveEdit()" [disabled]="busy()">{{ 'common.save' | translate }}</button>
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
  readonly lang = inject(LanguageService);
  readonly id = input.required<string>();
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
      error: (err) => { this.error.set(this.lang.t('appointments.loadFailed')); this.toast.fromError(err); },
    });
  }
  loadReminders() {
    this.remindersLoading.set(true); this.remindersError.set(null);
    this.scheduling.reminders({ appointmentId: this.id() }).subscribe({
      next: (r) => { this.reminders.set([...r].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))); this.remindersLoading.set(false); },
      error: (err) => { this.remindersLoading.set(false); this.remindersError.set(this.lang.errorMessage(err, this.lang.t('reminders.unavailable'))); },
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
    if (!(await this.confirm.ask({ title: this.lang.t('series.detachTitle'), message: this.lang.t('series.detachConfirm'), confirmText: this.lang.t('series.detach') }))) return;
    this.busy.set(true);
    this.seriesApi.detach(a.seriesId, a.occurrenceIndex).subscribe({
      next: () => { this.busy.set(false); this.toast.success(this.lang.t('series.detached')); this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }

  async transition(s: AppointmentStatus) {
    if (s === 'CANCELLED') { this.cancelNote = ''; this.cancelDialog.set(true); return; }
    if (s === 'NO_SHOW' && !(await this.confirm.ask({ title: this.lang.t('appointments.noShowTitle'), message: this.lang.t('appointments.noShowConfirm'), confirmText: this.lang.t('appointments.actions.NO_SHOW'), danger: true }))) return;
    this.setStatus(s);
  }
  doCancel() { this.setStatus('CANCELLED', this.cancelNote || undefined); }
  private setStatus(s: AppointmentStatus, note?: string) {
    this.busy.set(true);
    this.api.setStatus(this.id(), s, note, this.appt()?.version).subscribe({
      next: () => { this.busy.set(false); this.cancelDialog.set(false); this.toast.success(this.lang.t('appointments.statusChanged', { status: this.lang.enumLabel(s, 'status') })); this.load(); },
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
      next: () => { this.busy.set(false); this.editDialog.set(false); this.toast.success(this.lang.t('appointments.updated')); this.load(); },
      error: (err) => {
        this.busy.set(false);
        if (this.handleConflict(err)) { this.editDialog.set(false); return; }
        this.editError.set(isResourceConflict(err) ? this.lang.errorMessage(err) : rawServerMessage(err) ? this.lang.errorMessage(err) : this.lang.t('appointments.updateFailed'));
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
