import { Component, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { addDays } from 'date-fns';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { ToastService, errorMessage } from '../../core/toast.service';
import { Doctor, PatientRef, PreferredWindow, SlotCandidate } from '../../core/models';
import { fmtDate, fmtTime, isoDate } from '../../core/date-utils';
import { normalizeWindows, validateWindows } from '../../core/scheduling/preferred-windows';
import { PreferredWindowsEditorComponent } from '../../shared/preferred-windows-editor';
import { ResourceSelectComponent } from '../../shared/resource-select';
import { PatientSearchComponent } from '../../shared/patient-search';

export interface SlotPick { candidate: SlotCandidate; durationMinutes: number; resourceIds: string[]; patient: PatientRef | null; }

/** "Find a slot" side panel: smart-search form → ranked candidates → one-click book. */
@Component({
  selector: 'cf-find-slot-panel',
  imports: [FormsModule, DecimalPipe, PreferredWindowsEditorComponent, ResourceSelectComponent, PatientSearchComponent],
  template: `
    <aside class="panel card">
      <div class="card-header"><h3>Find a slot</h3><button type="button" class="btn ghost icon sm" (click)="closed.emit()" aria-label="Close">✕</button></div>
      <div class="card-body">
        <div class="field"><label class="req">Duration</label>
          <select class="input sm" [ngModel]="duration()" (ngModelChange)="duration.set(+$event)">
            @for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ m }} minutes</option> }
          </select>
        </div>
        <div class="field"><label>Search by</label>
          <div class="seg">
            <button type="button" [class.on]="mode() === 'doctor'" (click)="mode.set('doctor')">Doctor</button>
            <button type="button" [class.on]="mode() === 'specialty'" (click)="mode.set('specialty')">Specialty</button>
          </div>
        </div>
        @if (mode() === 'doctor') {
          <div class="field"><label>Doctor</label>
            <select class="input sm" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event)">
              <option value="">Any doctor</option>
              @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }
            </select>
          </div>
        } @else {
          <div class="field"><label>Specialty</label>
            <select class="input sm" [ngModel]="specialty()" (ngModelChange)="specialty.set($event)">
              <option value="">Any specialty</option>
              @for (s of specialties(); track s) { <option [value]="s">{{ s }}</option> }
            </select>
          </div>
        }
        <div class="row gap-1">
          <div class="field flex-1"><label>From</label><input class="input sm" type="date" [ngModel]="from()" (ngModelChange)="from.set($event)" /></div>
          <div class="field flex-1"><label>To</label><input class="input sm" type="date" [ngModel]="to()" (ngModelChange)="to.set($event)" /></div>
        </div>
        <div class="field"><label>Preferred doctor <span class="subtle">(bonus, not a filter)</span></label>
          <select class="input sm" [ngModel]="preferredDoctorId()" (ngModelChange)="preferredDoctorId.set($event)">
            <option value="">None</option>
            @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }}</option> }
          </select>
        </div>
        <div class="field"><label>Preferred windows</label><cf-preferred-windows [windows]="windows()" (windowsChange)="windows.set($event)" /></div>
        <div class="field"><label>Required resources</label><cf-resource-select [selected]="resourceIds()" (selectedChange)="resourceIds.set($event)" emptyText="No resources to require." /></div>
        <div class="field"><label>Patient <span class="subtle">(optional — avoids double-booking)</span></label><cf-patient-search [initial]="patient()" (selectedChange)="patient.set($event)" /></div>
        <button type="button" class="btn primary block" (click)="search()" [disabled]="loading() || !!problem()">{{ loading() ? 'Searching…' : 'Search' }}</button>
        @if (problem()) { <div class="field-error mt-1">{{ problem() }}</div> }
      </div>

      <div class="results">
        @if (error()) { <div class="inline-alert info" style="margin: 12px">{{ error() }}</div> }
        @else if (searched() && !candidates().length && !loading()) { <div class="empty">No free slots match. Try a wider range or fewer constraints.</div> }
        @for (c of candidates(); track c.doctor.id + c.startsAt; let i = $index) {
          <div class="cand" [style.border-left-color]="c.doctor.color || '#94a3b8'">
            <div class="cand-head">
              <span class="rank">#{{ i + 1 }}</span>
              <span class="row gap-1"><span class="pill-color" [style.background]="c.doctor.color || '#94a3b8'"></span><strong>{{ c.doctor.title }} {{ c.doctor.firstName }} {{ c.doctor.lastName }}</strong></span>
              <span class="score" title="Lower is better">score {{ c.score | number: '1.0-1' }}</span>
            </div>
            <div class="when">{{ fmtDate(c.startsAt, 'EEE dd MMM') }} · {{ fmtTime(c.startsAt) }}–{{ fmtTime(c.endsAt) }}</div>
            @if (c.reasons?.length) {
              <div class="row gap-1 wrap mt-1">@for (r of c.reasons; track r) { <span class="chip teal">{{ r }}</span> }</div>
            }
            <div class="row end mt-1"><button type="button" class="btn sm primary" (click)="pick(c)">Book</button></div>
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
    .cand { border-left: 4px solid; padding: 10px 14px; border-bottom: 1px solid var(--cf-border); }
    .cand-head { display: flex; align-items: center; gap: 8px; }
    .rank { font-size: 11px; font-weight: 700; color: var(--cf-text-3); }
    .score { margin-left: auto; font-size: 11px; color: var(--cf-text-3); font-variant-numeric: tabular-nums; }
    .when { font-size: 13px; margin-top: 2px; }
    @media (max-width: 1100px) { .panel { position: static; max-height: none; } .card-body { max-height: none; } }
  `],
})
export class FindSlotPanelComponent {
  private readonly api = inject(AppointmentsApi);
  private readonly toast = inject(ToastService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly closed = output<void>();
  readonly picked = output<SlotPick>();
  readonly fmtDate = fmtDate;
  readonly fmtTime = fmtTime;

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
    if (this.from() && this.to() && this.to() < this.from()) return 'The end date must be after the start date.';
    return validateWindows(this.windows());
  });

  ngOnInit() { this.doctorId.set(this.initialDoctorId()); }

  search() {
    if (this.problem()) return;
    this.loading.set(true);
    this.error.set(null);
    this.searched.set(true);
    const fromD = this.from() ? new Date(`${this.from()}T00:00:00`) : new Date();
    const from = fromD.getTime() < Date.now() ? new Date() : fromD;
    const to = this.to() ? addDays(new Date(`${this.to()}T00:00:00`), 1) : undefined;
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
        this.error.set(errorMessage(err, 'Slot search is not available.'));
        this.toast.fromError(err, 'Slot search failed');
      },
    });
  }
  pick(c: SlotCandidate) { this.picked.emit({ candidate: c, durationMinutes: this.duration(), resourceIds: this.resourceIds(), patient: this.patient() }); }
}
