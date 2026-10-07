import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { addDays } from 'date-fns';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { Doctor, PatientRef, PreferredWindow, SlotCandidate } from '../../core/models';
import { isoDate } from '../../core/date-utils';
import { dayBounds, startOfDayInZone } from '../../core/timezone';
import { normalizeWindows, windowsProblem } from '../../core/scheduling/preferred-windows';
import { PreferredWindowsEditorComponent } from '../../shared/preferred-windows-editor';
import { ResourceSelectComponent } from '../../shared/resource-select';
import { PatientSearchComponent } from '../../shared/patient-search';

export interface SlotPick { candidate: SlotCandidate; durationMinutes: number; resourceIds: string[]; patient: PatientRef | null; }

/** "Find a slot" side panel: smart-search form → ranked candidates → one-click book. */
@Component({
  selector: 'cf-find-slot-panel',
  imports: [FormsModule, TranslatePipe, PreferredWindowsEditorComponent, ResourceSelectComponent, PatientSearchComponent],
  template: `
    <aside class="panel card">
      <div class="card-header"><h3>{{ 'calendar.findSlot' | translate }}</h3><button type="button" class="btn ghost icon sm" (click)="closed.emit()" [attr.aria-label]="'common.close' | translate">✕</button></div>
      <div class="card-body">
        <div class="field"><label class="req">{{ 'common.duration' | translate }}</label>
          <select class="input sm" [ngModel]="duration()" (ngModelChange)="duration.set(+$event)">
            @for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ lang.formatMinutes(m) }}</option> }
          </select>
        </div>
        <div class="field"><label>{{ 'findSlot.searchBy' | translate }}</label>
          <div class="seg">
            <button type="button" [class.on]="mode() === 'doctor'" (click)="mode.set('doctor')">{{ 'common.doctor' | translate }}</button>
            <button type="button" [class.on]="mode() === 'specialty'" (click)="mode.set('specialty')">{{ 'doctors.specialty' | translate }}</button>
          </div>
        </div>
        @if (mode() === 'doctor') {
          <div class="field"><label>{{ 'common.doctor' | translate }}</label>
            <select class="input sm" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event)">
              <option value="">{{ 'doctors.any' | translate }}</option>
              @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }
            </select>
          </div>
        } @else {
          <div class="field"><label>{{ 'doctors.specialty' | translate }}</label>
            <select class="input sm" [ngModel]="specialty()" (ngModelChange)="specialty.set($event)">
              <option value="">{{ 'doctors.anySpecialty' | translate }}</option>
              @for (s of specialties(); track s) { <option [value]="s">{{ s }}</option> }
            </select>
          </div>
        }
        <div class="row gap-1">
          <div class="field flex-1"><label>{{ 'common.from' | translate }}</label><input class="input sm" type="date" [ngModel]="from()" (ngModelChange)="from.set($event)" /></div>
          <div class="field flex-1"><label>{{ 'common.to' | translate }}</label><input class="input sm" type="date" [ngModel]="to()" (ngModelChange)="to.set($event)" /></div>
        </div>
        <div class="field"><label>{{ 'findSlot.preferredDoctor' | translate }} <span class="subtle">({{ 'findSlot.preferredDoctorHint' | translate }})</span></label>
          <select class="input sm" [ngModel]="preferredDoctorId()" (ngModelChange)="preferredDoctorId.set($event)">
            <option value="">{{ 'common.none' | translate }}</option>
            @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }
          </select>
        </div>
        <div class="field"><label>{{ 'windows.title' | translate }}</label><cf-preferred-windows [windows]="windows()" (windowsChange)="windows.set($event)" /></div>
        <div class="field"><label>{{ 'findSlot.requiredResources' | translate }}</label><cf-resource-select [selected]="resourceIds()" (selectedChange)="resourceIds.set($event)" [emptyText]="'findSlot.noResources' | translate" /></div>
        <div class="field"><label>{{ 'common.patient' | translate }} <span class="subtle">({{ 'findSlot.patientHint' | translate }})</span></label><cf-patient-search [initial]="patient()" (selectedChange)="patient.set($event)" /></div>
        <button type="button" class="btn primary block" (click)="search()" [disabled]="loading() || !!problem()">{{ (loading() ? 'common.searching' : 'common.search') | translate }}</button>
        @if (problem()) { <div class="field-error mt-1">{{ problem() }}</div> }
      </div>

      <div class="results">
        @if (error()) { <div class="inline-alert info" style="margin: 12px">{{ error() }}</div> }
        @else if (searched() && !candidates().length && !loading()) { <div class="empty">{{ 'findSlot.noMatch' | translate }}</div> }
        @for (c of candidates(); track c.doctor.id + c.startsAt; let i = $index) {
          <div class="cand" [style.border-inline-start-color]="c.doctor.color || '#94a3b8'">
            <div class="cand-head">
              <span class="rank">#{{ i + 1 }}</span>
              <span class="row gap-1"><span class="pill-color" [style.background]="c.doctor.color || '#94a3b8'"></span><strong>{{ c.doctor.title }} {{ c.doctor.firstName }} {{ c.doctor.lastName }}</strong></span>
              <span class="score" [title]="'findSlot.lowerBetter' | translate">{{ 'findSlot.score' | translate }} {{ lang.formatNumber(c.score, { maximumFractionDigits: 1 }) }}</span>
            </div>
            <div class="when">{{ lang.formatWeekdayDate(c.startsAt) }} · {{ lang.formatTimeRange(c.startsAt, c.endsAt) }}</div>
            @if (c.reasons?.length) {
              <div class="row gap-1 wrap mt-1">@for (r of c.reasons; track r) { <span class="chip teal">{{ r }}</span> }</div>
            }
            <div class="row end mt-1"><button type="button" class="btn sm primary" (click)="pick(c)">{{ 'booking.bookShort' | translate }}</button></div>
          </div>
        }
      </div>
    </aside>
  `,
  styles: [`
    .panel { display: flex; flex-direction: column; max-height: calc(100vh - var(--cf-topbar-h) - 48px); position: sticky; top: calc(var(--cf-topbar-h) + 16px); }
    .card-body { padding: 14px 16px; overflow-y: auto; flex-shrink: 0; max-height: 60%; }
    .field { margin-bottom: 10px; }
    .seg { display: inline-flex; border: 1px solid var(--cf-border-strong); border-radius: 6px; overflow: hidden; }
    .seg button { border: none; background: #fff; padding: 0 12px; height: 28px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .seg button.on { background: var(--cf-primary); color: #fff; }
    .results { overflow-y: auto; border-top: 1px solid var(--cf-border); flex: 1; }
    .cand { border-inline-start: 4px solid; padding: 10px 14px; border-bottom: 1px solid var(--cf-border); }
    .cand-head { display: flex; align-items: center; gap: 8px; }
    .rank { font-size: 11px; font-weight: 700; color: var(--cf-text-3); }
    .score { margin-inline-start: auto; font-size: 11px; color: var(--cf-text-3); font-variant-numeric: tabular-nums; }
    .when { font-size: 13px; margin-top: 2px; }
    @media (max-width: 1100px) { .panel { position: static; max-height: none; } .card-body { max-height: none; } }
  `],
})
export class FindSlotPanelComponent {
  private readonly api = inject(AppointmentsApi);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly closed = output<void>();
  readonly picked = output<SlotPick>();

  readonly duration = signal(30);
  readonly mode = signal<'doctor' | 'specialty'>('doctor');
  readonly doctorId = signal('');
  readonly specialty = signal('');
  readonly from = signal(isoDate(new Date()));
  readonly to = signal(isoDate(addDays(new Date(), 14)));
  readonly preferredDoctorId = signal('');
  readonly windows = signal<PreferredWindow[]>([]);
  readonly resourceIds = signal<string[]>([]);
  readonly patient = signal<PatientRef | null>(null);
  readonly candidates = signal<SlotCandidate[]>([]);
  readonly loading = signal(false);
  readonly searched = signal(false);
  readonly error = signal<string | null>(null);
  readonly specialties = computed(() => [...new Set(this.doctors().map((d) => d.specialty).filter(Boolean))].sort());
  readonly problem = computed(() => {
    if (this.from() && this.to() && this.to() < this.from()) return this.lang.t('errors.endDateAfterStart');
    const p = windowsProblem(this.windows(), this.lang.weekdayNames('short'));
    return p ? this.lang.t(`errors.windows.${p.key}`, p.params) : null;
  });

  ngOnInit() { this.doctorId.set(this.initialDoctorId()); }

  search() {
    if (this.problem()) return;
    this.loading.set(true);
    this.error.set(null);
    this.searched.set(true);
    // Date inputs are clinic-local days.
    const fromD = this.from() ? startOfDayInZone(this.from()) : new Date();
    const from = fromD.getTime() < Date.now() ? new Date() : fromD;
    const to = this.to() ? dayBounds(this.to()).to : undefined;
    this.api.search({
      durationMinutes: this.duration(),
      doctorId: this.mode() === 'doctor' ? this.doctorId() || undefined : undefined,
      specialty: this.mode() === 'specialty' ? this.specialty() || undefined : undefined,
      from: from.toISOString(), to: to?.toISOString(),
      preferredDoctorId: this.preferredDoctorId() || undefined,
      preferredWindows: normalizeWindows(this.windows()),
      resourceIds: this.resourceIds(),
      patientId: this.patient()?.id,
      limit: 20,
    }).subscribe({
      next: (r) => { this.candidates.set(r?.candidates ?? []); this.loading.set(false); },
      error: (err) => {
        this.loading.set(false); this.candidates.set([]);
        this.error.set(this.lang.errorMessage(err, this.lang.t('findSlot.unavailable')));
        this.toast.fromError(err, this.lang.t('findSlot.failed'));
      },
    });
  }
  pick(c: SlotCandidate) { this.picked.emit({ candidate: c, durationMinutes: this.duration(), resourceIds: this.resourceIds(), patient: this.patient() }); }
}
