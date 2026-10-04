import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppointmentsApi } from '../../core/api/appointments.api';
import { AuthService } from '../../core/auth.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { APPOINTMENT_TYPES, Appointment, AppointmentType, Doctor, PatientRef } from '../../core/models';
import { SlotView, isoDate, renderSlots } from '../../core/date-utils';
import { DialogComponent } from '../../shared/dialog';
import { PatientSearchComponent } from '../../shared/patient-search';
import { HttpErrorResponse } from '@angular/common/http';

@Component({
  selector: 'cf-booking-dialog',
  imports: [FormsModule, DialogComponent, PatientSearchComponent],
  template: `
    <cf-dialog title="New appointment" [width]="640" (closed)="closed.emit()">
      @if (conflict()) { <div class="inline-alert error">{{ conflict() }}</div> }
      <div class="form-grid">
        <div class="field span-2"><label class="req">Patient</label><cf-patient-search [initial]="initialPatient()" (selectedChange)="patient.set($event)" /></div>
        <div class="field"><label class="req">Doctor</label>
          <select class="input" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event); loadSlots()" [disabled]="lockDoctor">
            <option value="">Select doctor…</option>
            @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
          </select>
        </div>
        <div class="field"><label class="req">Date</label><input class="input" type="date" [ngModel]="date()" (ngModelChange)="date.set($event); loadSlots()" /></div>
        <div class="field"><label>Duration</label>
          <select class="input" [ngModel]="duration()" (ngModelChange)="duration.set(+$event); loadSlots()">
            @for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ m }} minutes</option> }
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
        <div class="field span-2"><label>Reason</label><input class="input" [(ngModel)]="reason" placeholder="Reason for visit" /></div>
        <div class="field span-2"><label>Notes</label><textarea class="input" rows="2" [(ngModel)]="notes"></textarea></div>
      </div>
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        <button type="button" class="btn primary" (click)="book()" [disabled]="!canBook() || saving()">{{ saving() ? 'Booking…' : 'Book appointment' }}</button>
      </div>
    </cf-dialog>
  `,
  styles: [`.slots { display: flex; flex-wrap: wrap; gap: 6px; max-height: 160px; overflow-y: auto; padding: 2px; }`],
})
export class BookingDialogComponent {
  private readonly api = inject(AppointmentsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialDoctorId = input<string>('');
  readonly initialDate = input<Date | null>(null);
  readonly initialPatient = input<PatientRef | null>(null);
  readonly closed = output<void>();
  readonly booked = output<Appointment>();

  readonly types = APPOINTMENT_TYPES;
  readonly lockDoctor = !!this.auth.doctorId() && !this.auth.hasPermission('appointments:read_all');
  readonly doctorId = signal('');
  readonly date = signal('');
  readonly duration = signal(30);
  readonly patient = signal<PatientRef | null>(null);
  readonly selected = signal<string | null>(null);
  readonly slots = signal<SlotView[]>([]);
  readonly slotsLoading = signal(false);
  readonly slotsError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly conflict = signal<string | null>(null);
  type: AppointmentType = 'CONSULTATION';
  reason = '';
  notes = '';
  readonly canBook = computed(() => !!this.patient() && !!this.doctorId() && !!this.selected());

  ngOnInit() {
    this.doctorId.set(this.lockDoctor ? this.auth.doctorId()! : this.initialDoctorId());
    const d = this.initialDate() ?? new Date();
    this.date.set(isoDate(d));
    this.patient.set(this.initialPatient());
    this.loadSlots(this.initialDate() ? d.toISOString() : null);
  }

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
    this.api.create({
      doctorId: this.doctorId(), patientId: this.patient()!.id, startsAt: this.selected()!, durationMinutes: this.duration(),
      type: this.type, reason: this.reason || undefined, notes: this.notes || undefined,
    }).subscribe({
      next: (a) => { this.saving.set(false); this.toast.success('Appointment booked'); this.booked.emit(a); },
      error: (err) => {
        this.saving.set(false);
        if (err instanceof HttpErrorResponse && (err.status === 409 || err.status === 400)) {
          this.conflict.set(err.status === 409 ? `This slot was just taken: ${errorMessage(err)}` : errorMessage(err));
          this.loadSlots();
        } else this.toast.fromError(err);
      },
    });
  }
}
