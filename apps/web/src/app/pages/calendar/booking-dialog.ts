import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { format } from 'date-fns';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { SeriesApi } from '../../core/api/series.api';
import { isResourceConflict, newIdempotencyKey } from '../../core/api/booking-headers';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import {
  APPOINTMENT_TYPES, Appointment, AppointmentType, CreateSeriesDto, CreateSeriesResponse, Doctor, PatientRef, RECURRENCE_FREQUENCIES, RecurrenceFrequency,
  SeriesResolvePolicy,
} from '../../core/models';
import { SlotView, WEEKDAYS_SHORT, fmtDateTime, isoDate, renderSlots } from '../../core/date-utils';
import { DialogComponent } from '../../shared/dialog';
import { PatientSearchComponent } from '../../shared/patient-search';
import { ResourceSelectComponent } from '../../shared/resource-select';

@Component({
  selector: 'cf-booking-dialog',
  imports: [FormsModule, RouterLink, DialogComponent, PatientSearchComponent, ResourceSelectComponent],
  template: `
    <cf-dialog [title]="result() ? 'Series created' : 'New appointment'" [width]="680" (closed)="closed.emit()">
      @if (result(); as r) {
        <div class="inline-alert success">
          Created <strong>{{ r.created.length }}</strong> appointment{{ r.created.length === 1 ? '' : 's' }}
          @if (r.skipped.length) { · <strong>{{ r.skipped.length }}</strong> skipped }
          @if (r.series.id) { · <a [routerLink]="['/series', r.series.id]" (click)="closed.emit()">Open series</a> }
        </div>
        <div class="summary">
          @for (a of r.created; track a.id) {
            <div class="list-item small">
              <span class="mono">#{{ (a.occurrenceIndex ?? $index) + 1 }}</span>
              <span class="flex-1">{{ fmt(a.startsAt) }}@if (a.isException) { <span class="chip amber" style="margin-left: 6px">moved</span> }</span>
              <a class="btn xs ghost" [routerLink]="['/appointments', a.id]" (click)="closed.emit()">Open</a>
            </div>
          }
          @for (s of r.skipped; track s.index) {
            <div class="list-item small">
              <span class="mono">#{{ s.index + 1 }}</span>
              <span class="flex-1 muted"><s>{{ fmt(s.plannedStartsAt) }}</s> — {{ s.reason }}</span>
              <span class="chip gray">skipped</span>
            </div>
          }
        </div>
      } @else {
        @if (conflict()) { <div class="inline-alert error" style="white-space: pre-line">{{ conflict() }}</div> }
        <div class="form-grid">
          <div class="field span-2"><label class="req">Patient</label><cf-patient-search [initial]="initialPatient()" (selectedChange)="patient.set($event)" /></div>
          <div class="field"><label class="req">Doctor</label>
            <select class="input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); loadSlots()" [disabled]="lockDoctor">
              <option value="">Select doctor…</option>
              @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
            </select>
          </div>
          <div class="field"><label class="req">{{ repeat() ? 'First date' : 'Date' }}</label><input class="input" type="date" [ngModel]="date()" (ngModelChange)="date.set($event); loadSlots()" /></div>
          <div class="field"><label>Duration</label>
            <select class="input" [ngModel]="duration()" (ngModelChange)="duration.set(+$event); loadSlots()">
              @for (m of durations(); track m) { <option [ngValue]="m">{{ m }} minutes</option> }
            </select>
          </div>
          <div class="field"><label>Type</label>
            <select class="input" [(ngModel)]="type">@for (t of types; track t) { <option [value]="t">{{ t }}</option> }</select>
          </div>
          <div class="field span-2">
            <label class="req">Available slots</label>
            @if (slotsLoading()) { <div class="muted small">Loading availability…</div> }
            @else if (slotsError()) { <div class="inline-alert info">{{ slotsError() }}</div> }
            @else if (!doctorId() || !date()) { <div class="muted small">Choose a doctor and a date to see free slots.</div> }
            @else if (!slots().length) { <div class="muted small">No free slots on this day.</div> }
            @else {
              <div class="slots">
                @for (s of slots(); track s.startsAt) {
                  <button type="button" class="btn sm" [class.primary]="selected() === s.startsAt" [disabled]="s.disabled" (click)="selected.set(s.startsAt)">{{ s.label }}</button>
                }
              </div>
            }
          </div>
          <div class="field span-2"><label>Resources <span class="subtle">(rooms, equipment)</span></label>
            <cf-resource-select [selected]="resourceIds()" (selectedChange)="resourceIds.set($event)" />
          </div>
          <div class="field span-2"><label>Reason</label><input class="input" [(ngModel)]="reason" placeholder="Reason for visit" /></div>
          <div class="field span-2"><label>Notes</label><textarea class="input" rows="2" [(ngModel)]="notes"></textarea></div>

          <div class="span-2 repeat" [class.open]="repeat()">
            <label class="checkbox"><input type="checkbox" [ngModel]="repeat()" (ngModelChange)="repeat.set($event)" /> <strong>Repeat…</strong> <span class="muted small">create a recurring series</span></label>
            @if (repeat()) {
              <div class="form-grid mt-1">
                <div class="field"><label>Frequency</label>
                  <select class="input" [ngModel]="frequency()" (ngModelChange)="frequency.set($event)">
                    @for (f of frequencies; track f) { <option [value]="f">{{ f.toLowerCase() }}</option> }
                  </select>
                </div>
                <div class="field"><label>Every</label>
                  <div class="row gap-1"><input class="input" type="number" min="1" max="52" style="width: 90px" [(ngModel)]="interval" /><span class="muted small">{{ intervalUnit() }}</span></div>
                </div>
                @if (frequency() === 'WEEKLY') {
                  <div class="field span-2"><label>On weekdays</label>
                    <div class="row gap-1 wrap">
                      @for (d of dayOrder; track d) {
                        <button type="button" class="day-chip" [class.on]="byWeekday().includes(d)" (click)="toggleWeekday(d)">{{ weekdays[d] }}</button>
                      }
                    </div>
                  </div>
                }
                @if (frequency() === 'MONTHLY') {
                  <div class="field"><label>Day of month</label><input class="input" type="number" min="1" max="31" [(ngModel)]="byMonthDay" /></div>
                }
                <div class="field"><label>Ends</label>
                  <div class="row gap-1">
                    <select class="input" style="width: 130px" [ngModel]="endMode()" (ngModelChange)="endMode.set($event)">
                      <option value="count">after</option><option value="until">on date</option>
                    </select>
                    @if (endMode() === 'count') { <input class="input" type="number" min="1" max="365" style="width: 90px" [(ngModel)]="count" /><span class="muted small">times</span> }
                    @else { <input class="input" type="date" [(ngModel)]="until" /> }
                  </div>
                </div>
                <div class="field"><label>If a slot is busy</label>
                  <select class="input" [(ngModel)]="resolve">
                    <option value="next-slot">Move to the next free slot</option>
                    <option value="skip">Skip that occurrence</option>
                    <option value="fail">Fail — create nothing</option>
                  </select>
                </div>
                <div class="span-2 subtle">{{ repeatSummary() }}@if (resourceIds().length || notes) { <br />Resources and notes apply to single bookings only — add them per occurrence afterwards. }</div>
              </div>
            }
          </div>
        </div>
      }
      <div footer>
        @if (result()) {
          <button type="button" class="btn primary" (click)="finish()">Done</button>
        } @else {
          <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
          <button type="button" class="btn primary" (click)="book()" [disabled]="!canBook() || saving()">{{ saving() ? 'Booking…' : repeat() ? 'Create series' : 'Book appointment' }}</button>
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
  readonly weekdays = WEEKDAYS_SHORT;
  readonly dayOrder = [1, 2, 3, 4, 5, 6, 0];
  readonly fmt = fmtDateTime;
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
  readonly intervalUnit = computed(() => ({ DAILY: 'day(s)', WEEKLY: 'week(s)', MONTHLY: 'month(s)' })[this.frequency()]);
  readonly repeatSummary = computed(() => {
    const f = this.frequency(); const every = this.interval > 1 ? `every ${this.interval} ${this.intervalUnit()}` : f.toLowerCase();
    const on = f === 'WEEKLY' && this.byWeekday().length ? ` on ${this.byWeekday().map((d) => WEEKDAYS_SHORT[d]).join(', ')}` : f === 'MONTHLY' && this.byMonthDay ? ` on day ${this.byMonthDay}` : '';
    const end = this.endMode() === 'count' ? `${this.count} occurrence(s)` : this.until ? `until ${this.until}` : 'until … (pick a date)';
    return `Repeats ${every}${on}, ${end}. Conflicts: ${this.resolve === 'next-slot' ? 'moved to the next free slot' : this.resolve === 'skip' ? 'skipped' : 'abort'}.`;
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
      error: (err) => { this.slotsLoading.set(false); this.slots.set([]); this.slotsError.set(errorMessage(err, 'Availability unavailable')); },
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
      next: (a) => { this.saving.set(false); this.idempotencyKey = newIdempotencyKey(); this.toast.success('Appointment booked'); this.booked.emit(a); },
      error: (err) => this.onError(err),
    });
  }

  private createSeries() {
    const start = new Date(this.selected()!);
    const dto: CreateSeriesDto = {
      doctorId: this.doctorId(), patientId: this.patient()!.id, frequency: this.frequency(), interval: Number(this.interval) || 1,
      startsOn: this.date(), startTime: format(start, 'HH:mm'), durationMinutes: this.duration(), type: this.type,
      reason: this.reason || undefined, resolve: this.resolve,
    };
    if (this.frequency() === 'WEEKLY') dto.byWeekday = this.byWeekday().length ? this.byWeekday() : [start.getDay()];
    if (this.frequency() === 'MONTHLY') dto.byMonthDay = this.byMonthDay ?? start.getDate();
    if (this.endMode() === 'count') dto.count = Number(this.count); else dto.until = this.until;
    this.seriesApi.create(dto).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.idempotencyKey = newIdempotencyKey();
        this.result.set({ series: r.series, created: r.created ?? [], skipped: r.skipped ?? [] });
        this.toast.success(`Series created: ${r.created?.length ?? 0} appointment(s)`);
      },
      error: (err) => this.onError(err),
    });
  }

  private onError(err: unknown) {
    this.saving.set(false);
    if (err instanceof HttpErrorResponse && (err.status === 409 || err.status === 400)) {
      if (isResourceConflict(err)) this.conflict.set(errorMessage(err));
      else { this.conflict.set(err.status === 409 ? `This slot was just taken: ${errorMessage(err)}` : errorMessage(err)); if (!this.repeat()) this.loadSlots(); }
    } else this.toast.fromError(err);
  }

  finish() {
    const first = this.result()?.created[0];
    if (first) this.booked.emit(first); else this.closed.emit();
  }
}
