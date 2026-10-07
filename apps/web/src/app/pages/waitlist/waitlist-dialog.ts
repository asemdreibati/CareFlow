import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { WaitlistApi } from '../../core/api/waitlist.api';
import { clean } from '../../core/api/http-utils';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { APPOINTMENT_TYPES, AppointmentType, Doctor, PatientRef, PreferredWindow, WAITLIST_PRIORITIES, WaitlistEntry, WaitlistPriority } from '../../core/models';
import { normalizeWindows, validateWindows } from '../../core/scheduling/preferred-windows';
import { DialogComponent } from '../../shared/dialog';
import { PatientSearchComponent } from '../../shared/patient-search';
import { PreferredWindowsEditorComponent } from '../../shared/preferred-windows-editor';
import { fromLocalInput } from '../../core/date-utils';

@Component({
  selector: 'cf-waitlist-dialog',
  imports: [FormsModule, TranslatePipe, DialogComponent, PatientSearchComponent, PreferredWindowsEditorComponent],
  template: `
    <cf-dialog [title]="'waitlist.add' | translate" [width]="620" (closed)="closed.emit()">
      @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
      <div class="form-grid">
        <div class="field span-2"><label class="req">{{ 'common.patient' | translate }}</label><cf-patient-search [initial]="initialPatient()" (selectedChange)="patient.set($event)" /></div>
        <div class="field span-2"><label>{{ 'waitlist.lookingFor' | translate }}</label>
          <div class="row gap-1 wrap">
            <div class="seg">
              <button type="button" [class.on]="mode() === 'doctor'" (click)="mode.set('doctor')">{{ 'waitlist.specificDoctor' | translate }}</button>
              <button type="button" [class.on]="mode() === 'specialty'" (click)="mode.set('specialty')">{{ 'waitlist.anyOfSpecialty' | translate }}</button>
            </div>
            @if (mode() === 'doctor') {
              <select class="input flex-1" style="min-width: 200px" [ngModel]="doctorId()" (ngModelChange)="doctorId.set($event)">
                <option value="">{{ 'doctors.select' | translate }}</option>
                @for (d of doctors(); track d.id) { <option [value]="d.id">{{ d.title }} {{ d.firstName }} {{ d.lastName }} — {{ d.specialty }}</option> }
              </select>
            } @else {
              <select class="input flex-1" style="min-width: 200px" [ngModel]="specialty()" (ngModelChange)="specialty.set($event)">
                <option value="">{{ 'doctors.selectSpecialty' | translate }}</option>
                @for (s of specialties(); track s) { <option [value]="s">{{ s }}</option> }
              </select>
            }
          </div>
        </div>
        <div class="field"><label>{{ 'common.duration' | translate }}</label>
          <select class="input" [(ngModel)]="durationMinutes">@for (m of [15, 20, 30, 45, 60, 90]; track m) { <option [ngValue]="m">{{ lang.formatMinutes(m) }}</option> }</select>
        </div>
        <div class="field"><label>{{ 'waitlist.priority' | translate }}</label>
          <select class="input" [(ngModel)]="priority">@for (p of priorities; track p) { <option [value]="p">{{ lang.enumLabel(p, 'priority') }}</option> }</select>
        </div>
        <div class="field"><label>{{ 'common.type' | translate }}</label>
          <select class="input" [(ngModel)]="type">@for (t of types; track t) { <option [value]="t">{{ lang.enumLabel(t, 'type') }}</option> }</select>
        </div>
        <div class="field"><label>{{ 'waitlist.earliest' | translate }}</label><input class="input" type="datetime-local" [(ngModel)]="earliestAt" /></div>
        <div class="field"><label>{{ 'waitlist.latest' | translate }} <span class="subtle">({{ 'common.optional' | translate }})</span></label><input class="input" type="datetime-local" [(ngModel)]="latestAt" /></div>
        <div class="field span-2"><label>{{ 'windows.title' | translate }}</label><cf-preferred-windows [windows]="windows()" (windowsChange)="windows.set($event)" /></div>
        <div class="field span-2"><label>{{ 'common.notes' | translate }}</label><textarea class="input" rows="2" [(ngModel)]="notes" [placeholder]="'waitlist.notesPlaceholder' | translate"></textarea></div>
      </div>
      <div footer>
        <button type="button" class="btn" (click)="closed.emit()">{{ 'common.cancel' | translate }}</button>
        <button type="button" class="btn primary" (click)="save()" [disabled]="!valid() || saving()">{{ (saving() ? 'waitlist.adding' : 'waitlist.addEntry') | translate }}</button>
      </div>
    </cf-dialog>
  `,
  styles: [`
    .seg { display: inline-flex; border: 1px solid var(--cf-border-strong); border-radius: 6px; overflow: hidden; }
    .seg button { border: none; background: #fff; padding: 0 12px; height: 36px; font: inherit; font-size: 12.5px; cursor: pointer; }
    .seg button.on { background: var(--cf-primary); color: #fff; }
  `],
})
export class WaitlistDialogComponent {
  private readonly api = inject(WaitlistApi);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);
  readonly doctors = input.required<Doctor[]>();
  readonly initialPatient = input<PatientRef | null>(null);
  readonly closed = output<void>();
  readonly saved = output<WaitlistEntry>();
  readonly priorities = WAITLIST_PRIORITIES;
  readonly types = APPOINTMENT_TYPES;
  readonly patient = signal<PatientRef | null>(null);
  readonly mode = signal<'doctor' | 'specialty'>('doctor');
  readonly doctorId = signal('');
  readonly specialty = signal('');
  readonly windows = signal<PreferredWindow[]>([]);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  durationMinutes = 30; priority: WaitlistPriority = 'ROUTINE'; type: AppointmentType = 'CONSULTATION'; earliestAt = ''; latestAt = ''; notes = '';
  readonly specialties = computed(() => [...new Set(this.doctors().map((d) => d.specialty).filter(Boolean))].sort());
  readonly valid = computed(() => !!this.patient() && (this.mode() === 'doctor' ? !!this.doctorId() : !!this.specialty()) && !validateWindows(this.windows()));

  ngOnInit() { this.patient.set(this.initialPatient()); }

  save() {
    if (!this.valid()) return;
    this.saving.set(true); this.error.set(null);
    const dto = clean({
      patientId: this.patient()!.id,
      doctorId: this.mode() === 'doctor' ? this.doctorId() : undefined,
      specialty: this.mode() === 'specialty' ? this.specialty() : undefined,
      durationMinutes: Number(this.durationMinutes), priority: this.priority, type: this.type,
      earliestAt: fromLocalInput(this.earliestAt) ?? undefined,
      latestAt: fromLocalInput(this.latestAt) ?? undefined,
      preferredWindows: this.windows().length ? normalizeWindows(this.windows()) : undefined,
      notes: this.notes.trim(),
    });
    this.api.create(dto as { patientId: string }).subscribe({
      next: (e) => { this.saving.set(false); this.toast.success(this.lang.t('waitlist.added')); this.saved.emit(e); },
      error: (err) => { this.saving.set(false); this.error.set(this.lang.errorMessage(err)); },
    });
  }
}
