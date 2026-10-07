import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { TranslatePipe } from '@ngx-translate/core';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { SeriesApi } from '../../core/api/series.api';
import { isResourceConflict, newIdempotencyKey } from '../../core/api/booking-headers';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import {
  APPOINTMENT_TYPES, Appointment, AppointmentType, CreateSeriesDto, CreateSeriesResponse, Doctor, PatientRef, RECURRENCE_FREQUENCIES, RecurrenceFrequency,
  SeriesResolvePolicy,
} from '../../core/models';
import { SlotView, isoDate, renderSlots } from '../../core/date-utils';
import { activeTimeZone, dayKey, isValidTimeZone, zonedHHmm, zonedParts } from '../../core/timezone';

/**
 * Recurrence anchor of a series in the clinic's timezone — the API expands `startsOn`/`startTime`/
 * `byWeekday`/`byMonthDay` in clinic time, so they must not be derived from the browser's zone.
 */
export function seriesAnchor(startsAt: string | Date, tz: string | undefined): { startsOn: string; startTime: string; weekday: number; monthDay: number } {
  const start = new Date(startsAt);
  const p = zonedParts(start, tz);
  return { startsOn: dayKey(start, tz), startTime: zonedHHmm(start, tz), weekday: p.weekday, monthDay: p.day };
}
import { DialogComponent } from '../../shared/dialog';
import { PatientSearchComponent } from '../../shared/patient-search';
import { ResourceSelectComponent } from '../../shared/resource-select';

@Component({
  selector: 'cf-booking-dialog',
  imports: [FormsModule, RouterLink, TranslatePipe, DialogComponent, PatientSearchComponent, ResourceSelectComponent],
  template: `
    <cf-dialog [title]="(result() ? 'series.created' : 'appointments.new') | translate" [width]="680" (closed)="closed.emit()">
      @if (result(); as r) {
        <div class="inline-alert success">
          {{ 'series.createdCount' | translate: { n: r.created.length } }}
          @if (r.skipped.length) { · {{ 'series.skippedCount' | translate: { n: r.skipped.length } }} }
          @if (r.series.id) { · <a [routerLink]="['/series', r.series.id]" (click)="closed.emit()">{{ 'series.open' | translate }}</a> }
        </div>
        <div class="summary">
          @for (a of r.created; track a.id) {
            <div class="list-item small">
              <span class="mono">#{{ (a.occurrenceIndex ?? $index) + 1 }}</span>
              <span class="flex-1">{{ lang.formatDateTime(a.startsAt) }}@if (a.isException) { <span class="chip amber" style="margin-inline-start: 6px">{{ 'series.moved' | translate }}</span> }</span>
              <a class="btn xs ghost" [routerLink]="['/appointments', a.id]" (click)="closed.emit()">{{ 'common.open' | translate }}</a>
            </div>
          }
          @for (s of r.skipped; track s.index) {
            <div class="list-item small">
              <span class="mono">#{{ s.index + 1 }}</span>
              <span class="flex-1 muted"><s>{{ lang.formatDateTime(s.plannedStartsAt) }}</s> — {{ s.reason }}</span>
              <span class="chip gray">{{ 'series.skipped' | translate }}</span>
            </div>
          }
        </div>
      } @else {
        @if (conflict()) { <div class="inline-alert error" style="white-space: pre-line">{{ conflict() }}</div> }
        <div class="form-grid">
          <div class="field span-2"><label class="req">{{ 'common.patient' | translate }}</label><cf-patient-search [initial]="initialPatient()" (selectedChange)="patient.set($event)" /></div>
          <div class="field"><label class="req">{{ 'common.doctor' | translate }}</label>
            <select class="input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); loadSlots()" [disabled]="lockDoctor">
              <option value="">{{ 'doctors.select' | translate }}</option>
              @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
            </select>
          </div>
          <div class="field"><label class="req">{{ (repeat() ? 'booking.firstDate' : 'common.date') | translate }}</label><input class="input" type="date" [ngModel]="date()" (ngModelChange)="date.set($event); loadSlots()" /></div>
          <div class="field"><label>{{ 'common.duration' | translate }}</label>
            <select class="input" [ngModel]="duration()" (ngModelChange)="duration.set(+$event); loadSlots()">
              @for (m of durations(); track m) { <option [ngValue]="m">{{ lang.formatMinutes(m) }}</option> }
            </select>
          </div>
          <div class="field"><label>{{ 'common.type' | translate }}</label>
            <select class="input" [(ngModel)]="type">@for (t of types; track t) { <option [value]="t">{{ lang.enumLabel(t, 'type') }}</option> }</select>
          </div>
          <div class="field span-2">
            <label class="req">{{ 'booking.availableSlots' | translate }}</label>
            @if (slotsLoading()) { <div class="muted small">{{ 'booking.loadingAvailability' | translate }}</div> }
            @else if (slotsError()) { <div class="inline-alert info">{{ slotsError() }}</div> }
            @else if (!doctorId() || !date()) { <div class="muted small">{{ 'booking.chooseDoctorDate' | translate }}</div> }
            @else if (!slots().length) { <div class="muted small">{{ 'booking.noFreeSlots' | translate }}</div> }
            @else {
              <div class="slots">
                @for (s of slots(); track s.startsAt) {
                  <button type="button" class="btn sm" [class.primary]="selected() === s.startsAt" [disabled]="s.disabled" (click)="selected.set(s.startsAt)">{{ s.label }}</button>
                }
              </div>
            }
          </div>
          <div class="field span-2"><label>{{ 'nav.resources' | translate }} <span class="subtle">({{ 'resources.hint' | translate }})</span></label>
            <cf-resource-select [selected]="resourceIds()" (selectedChange)="resourceIds.set($event)" />
          </div>
          <div class="field span-2"><label>{{ 'common.reason' | translate }}</label><input class="input" [(ngModel)]="reason" [placeholder]="'booking.reasonPlaceholder' | translate" /></div>
          <div class="field span-2"><label>{{ 'common.notes' | translate }}</label><textarea class="input" rows="2" [(ngModel)]="notes"></textarea></div>

          <div class="span-2 repeat" [class.open]="repeat()">
            <label class="checkbox"><input type="checkbox" [ngModel]="repeat()" (ngModelChange)="repeat.set($event)" /> <strong>{{ 'booking.repeat' | translate }}</strong> <span class="muted small">{{ 'booking.repeatHint' | translate }}</span></label>
            @if (repeat()) {
              <div class="form-grid mt-1">
                <div class="field"><label>{{ 'series.frequency' | translate }}</label>
                  <select class="input" [ngModel]="frequency()" (ngModelChange)="frequency.set($event)">
                    @for (f of frequencies; track f) { <option [value]="f">{{ lang.enumLabel(f, 'frequency') }}</option> }
                  </select>
                </div>
                <div class="field"><label>{{ 'series.every' | translate }}</label>
                  <div class="row gap-1"><input class="input" type="number" min="1" max="52" style="width: 90px" [(ngModel)]="interval" /><span class="muted small">{{ intervalUnit() }}</span></div>
                </div>
                @if (frequency() === 'WEEKLY') {
                  <div class="field span-2"><label>{{ 'series.onWeekdays' | translate }}</label>
                    <div class="row gap-1 wrap">
                      @for (d of dayOrder; track d) {
                        <button type="button" class="day-chip" [class.on]="byWeekday().includes(d)" (click)="toggleWeekday(d)">{{ weekdays()[d] }}</button>
                      }
                    </div>
                  </div>
                }
                @if (frequency() === 'MONTHLY') {
                  <div class="field"><label>{{ 'series.dayOfMonth' | translate }}</label><input class="input" type="number" min="1" max="31" [(ngModel)]="byMonthDay" /></div>
                }
                <div class="field"><label>{{ 'series.ends' | translate }}</label>
                  <div class="row gap-1">
                    <select class="input" style="width: 130px" [ngModel]="endMode()" (ngModelChange)="endMode.set($event)">
                      <option value="count">{{ 'series.after' | translate }}</option><option value="until">{{ 'series.onDate' | translate }}</option>
                    </select>
                    @if (endMode() === 'count') { <input class="input" type="number" min="1" max="365" style="width: 90px" [(ngModel)]="count" /><span class="muted small">{{ 'series.times' | translate }}</span> }
                    @else { <input class="input" type="date" [(ngModel)]="until" /> }
                  </div>
                </div>
                <div class="field"><label>{{ 'series.ifBusy' | translate }}</label>
                  <select class="input" [(ngModel)]="resolve">
                    <option value="next-slot">{{ 'series.resolve.nextSlot' | translate }}</option>
                    <option value="skip">{{ 'series.resolve.skip' | translate }}</option>
                    <option value="fail">{{ 'series.resolve.fail' | translate }}</option>
                  </select>
                </div>
                <div class="span-2 subtle">{{ repeatSummary() }}@if (resourceIds().length || notes) { <br />{{ 'booking.seriesNoResources' | translate }} }</div>
              </div>
            }
          </div>
        </div>
      }
      <div footer>
        @if (result()) {
          <button type="button" class="btn primary" (click)="finish()">{{ 'common.done' | translate }}</button>
        } @else {
          <button type="button" class="btn" (click)="closed.emit()">{{ 'common.cancel' | translate }}</button>
          <button type="button" class="btn primary" (click)="book()" [disabled]="!canBook() || saving()">{{ (saving() ? 'booking.booking' : repeat() ? 'series.create' : 'booking.book') | translate }}</button>
        }
      </div>
    </cf-dialog>
  `,
  styles: [`
    .slots { display: flex; flex-wrap: wrap; gap: 6px; max-height: 160px; overflow-y: auto; padding: 2px; }
    .repeat { border: 1px dashed var(--cf-border-strong); border-radius: var(--cf-radius-sm); padding: 10px 12px; margin-bottom: 14px; }
    .repeat.open { border-style: solid; background: var(--cf-surface-2); }
    .repeat .form-grid .field { margin-bottom: 10px; }
    .day-chip { height: 28px; min-width: 40px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--cf-border-strong); background: var(--cf-surface); font: inherit; font-size: 12px; cursor: pointer; }
    .day-chip.on { background: var(--cf-primary); border-color: var(--cf-primary); color: #fff; font-weight: 600; }
    .summary { max-height: 320px; overflow-y: auto; }
    .summary .list-item { padding: 8px 0; }
  `],
})
export class BookingDialogComponent {
  private readonly api = inject(AppointmentsApi);
  private readonly seriesApi = inject(SeriesApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly initialDate = input<Date | null>(null);
  readonly initialPatient = input<PatientRef | null>(null);
  readonly initialDuration = input<number | null>(null);
  readonly initialResourceIds = input<string[]>([]);
  readonly closed = output<void>();
  readonly booked = output<Appointment>();

  readonly types = APPOINTMENT_TYPES;
  readonly frequencies = RECURRENCE_FREQUENCIES;
  readonly weekdays = computed(() => this.lang.weekdayNames('short'));
  readonly dayOrder = [1, 2, 3, 4, 5, 6, 0];
  readonly lockDoctor = !!this.auth.doctorId() && !this.auth.hasPermission('appointments:read_all');
  readonly doctorId = signal('');
  readonly date = signal('');
  readonly duration = signal(30);
  readonly durations = computed(() => { const base = [15, 20, 30, 45, 60, 90]; return base.includes(this.duration()) ? base : [...base, this.duration()].sort((a, b) => a - b); });
  readonly patient = signal<PatientRef | null>(null);
  readonly selected = signal<string | null>(null);
  readonly slots = signal<SlotView[]>([]);
  readonly slotsLoading = signal(false);
  readonly slotsError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly conflict = signal<string | null>(null);
  readonly resourceIds = signal<string[]>([]);
  /** One key per dialog open; regenerated after a successful booking so the next booking is a new one. */
  idempotencyKey = newIdempotencyKey();
  type: AppointmentType = 'CONSULTATION';
  reason = '';
  notes = '';
  // Repeat… (series)
  readonly repeat = signal(false);
  readonly frequency = signal<RecurrenceFrequency>('WEEKLY');
  readonly byWeekday = signal<number[]>([]);
  readonly endMode = signal<'count' | 'until'>('count');
  readonly result = signal<CreateSeriesResponse | null>(null);
  interval = 1;
  byMonthDay: number | null = null;
  count = 6;
  until = '';
  resolve: SeriesResolvePolicy = 'next-slot';
  readonly canBook = computed(() => !!this.patient() && !!this.doctorId() && !!this.selected() && (!this.repeat() || this.repeatValid()));
  readonly intervalUnit = computed(() => this.lang.t(`series.units.${this.frequency()}`));
  readonly repeatSummary = computed(() => {
    const f = this.frequency();
    const every = this.interval > 1 ? this.lang.t('series.everyN', { n: this.interval, unit: this.intervalUnit() }) : this.lang.enumLabel(f, 'frequency');
    const on = f === 'WEEKLY' && this.byWeekday().length ? ' ' + this.lang.t('series.onDays', { days: this.byWeekday().map((d) => this.weekdays()[d]).join(this.lang.t('common.listSeparator')) })
      : f === 'MONTHLY' && this.byMonthDay ? ' ' + this.lang.t('series.onDay', { day: this.byMonthDay }) : '';
    const end = this.endMode() === 'count' ? this.lang.t('series.occurrencesCount', { n: this.count }) : this.until ? this.lang.t('series.until', { date: this.lang.formatDate(this.until) }) : this.lang.t('series.pickDate');
    const conflicts = this.lang.t(`series.conflicts.${this.resolve}`);
    return this.lang.t('series.summary', { every, on, end, conflicts });
  });

  ngOnInit() {
    this.doctorId.set(this.lockDoctor ? this.auth.doctorId()! : this.initialDoctorId());
    const d = this.initialDate() ?? new Date();
    this.date.set(isoDate(d));
    if (this.initialDuration()) this.duration.set(this.initialDuration()!);
    this.resourceIds.set(this.initialResourceIds());
    this.patient.set(this.initialPatient());
    this.loadSlots(this.initialDate() ? d.toISOString() : null);
  }

  repeatValid() {
    if (this.interval < 1) return false;
    if (this.frequency() === 'MONTHLY' && this.byMonthDay !== null && (this.byMonthDay < 1 || this.byMonthDay > 31)) return false;
    return this.endMode() === 'count' ? this.count >= 1 : !!this.until;
  }
  toggleWeekday(d: number) { this.byWeekday.update((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort())); }

  loadSlots(preselect: string | null = null) {
    this.selected.set(null);
    this.conflict.set(null);
    if (!this.doctorId() || !this.date()) { this.slots.set([]); return; }
    this.slotsLoading.set(true);
    this.slotsError.set(null);
    this.api.availability({ doctorId: this.doctorId(), date: this.date(), durationMinutes: this.duration() }).subscribe({
      next: (r) => {
        const views = renderSlots(r.slots ?? []);
        this.slots.set(views);
        this.slotsLoading.set(false);
        if (preselect) {
          const t = new Date(preselect).getTime();
          const hit = views.find((s) => !s.disabled && new Date(s.startsAt).getTime() === t) ?? views.find((s) => !s.disabled && new Date(s.startsAt).getTime() >= t);
          if (hit) this.selected.set(hit.startsAt);
        }
      },
      error: (err) => { this.slotsLoading.set(false); this.slots.set([]); this.slotsError.set(this.lang.errorMessage(err, this.lang.t('booking.availabilityUnavailable'))); },
    });
  }

  book() {
    if (!this.canBook()) return;
    this.saving.set(true);
    this.conflict.set(null);
    if (this.repeat()) { this.createSeries(); return; }
    this.api.create({
      doctorId: this.doctorId(), patientId: this.patient()!.id, startsAt: this.selected()!, durationMinutes: this.duration(),
      type: this.type, reason: this.reason || undefined, notes: this.notes || undefined,
      resourceIds: this.resourceIds().length ? this.resourceIds() : undefined,
    }, this.idempotencyKey).subscribe({
      next: (a) => { this.saving.set(false); this.idempotencyKey = newIdempotencyKey(); this.toast.success(this.lang.t('booking.booked')); this.booked.emit(a); },
      error: (err) => this.onError(err),
    });
  }

  private createSeries() {
    const clinicTz = this.auth.clinic()?.timezone;
    const anchor = seriesAnchor(this.selected()!, isValidTimeZone(clinicTz) ? clinicTz : activeTimeZone());
    const dto: CreateSeriesDto = {
      doctorId: this.doctorId(), patientId: this.patient()!.id, frequency: this.frequency(), interval: Number(this.interval) || 1,
      startsOn: anchor.startsOn, startTime: anchor.startTime, durationMinutes: this.duration(), type: this.type,
      reason: this.reason || undefined, resolve: this.resolve,
    };
    if (this.frequency() === 'WEEKLY') dto.byWeekday = this.byWeekday().length ? this.byWeekday() : [anchor.weekday];
    if (this.frequency() === 'MONTHLY') dto.byMonthDay = this.byMonthDay ?? anchor.monthDay;
    if (this.endMode() === 'count') dto.count = Number(this.count); else dto.until = this.until;
    this.seriesApi.create(dto).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.idempotencyKey = newIdempotencyKey();
        this.result.set({ series: r.series, created: r.created ?? [], skipped: r.skipped ?? [] });
        this.toast.success(this.lang.t('series.createdToast', { n: r.created?.length ?? 0 }));
      },
      error: (err) => this.onError(err),
    });
  }

  private onError(err: unknown) {
    this.saving.set(false);
    if (err instanceof HttpErrorResponse && (err.status === 409 || err.status === 400)) {
      if (isResourceConflict(err)) this.conflict.set(this.lang.errorMessage(err));
      else { this.conflict.set(err.status === 409 ? this.lang.t('booking.slotTaken', { message: this.lang.errorMessage(err) }) : this.lang.errorMessage(err)); if (!this.repeat()) this.loadSlots(); }
    } else this.toast.fromError(err);
  }

  finish() {
    const first = this.result()?.created[0];
    if (first) this.booked.emit(first); else this.closed.emit();
  }
}
