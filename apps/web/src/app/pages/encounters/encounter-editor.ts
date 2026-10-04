import { Component, computed, inject, input, signal } from '@angular/core';
import { FormBuilder, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RecordsApi } from '../../core/api/records.api';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmService } from '../../shared/confirm.service';
import { Encounter, EncounterDto, PrescriptionStatus } from '../../core/models';
import { fmtDateTime } from '../../core/date-utils';
import { PageHeaderComponent } from '../../shared/page-header';
import { StatusChipComponent } from '../../shared/status-chip';
import { EncounterAiPanel } from './ai-panel';

@Component({
  selector: 'cf-encounter-editor',
  imports: [FormsModule, ReactiveFormsModule, RouterLink, PageHeaderComponent, StatusChipComponent, EncounterAiPanel],
  templateUrl: './encounter-editor.html',
  styles: [`
    .soap textarea { min-height: 110px; }
    .vitals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0 12px; }
    @media (max-width: 700px) { .vitals { grid-template-columns: repeat(2, 1fr); } }
    .layout { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; align-items: start; }
    @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } }
    .readonly-note { font-size: 12px; color: var(--cf-text-2); }
  `],
})
export class EncounterEditorPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(RecordsApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly id = input.required<string>();
  readonly fmt = fmtDateTime;
  readonly enc = signal<Encounter | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal(false);
  readonly signing = signal(false);
  readonly busy = signal(false);
  readonly dirty = signal(false);
  readonly canWrite = this.auth.hasPermission('records:write');
  readonly canSign = this.auth.hasPermission('records:sign');
  readonly isAuthor = computed(() => !!this.auth.doctorId() && this.enc()?.doctorId === this.auth.doctorId());
  /** DRAFT: editable with records:write. SIGNED/AMENDED: editable only with records:sign (becomes AMENDED). */
  readonly editable = computed(() => {
    const e = this.enc();
    if (!e) return false;
    return e.status === 'DRAFT' ? this.canWrite : this.canSign;
  });
  readonly form = this.fb.nonNullable.group({
    chiefComplaint: [''], subjective: [''], objective: [''], assessment: [''], plan: [''],
    vitals: this.fb.nonNullable.group({ temperature: [''], heartRate: [''], bloodPressure: [''], weight: [''] }),
  });
  dx = { code: '', description: '', isPrimary: false };
  rx = { medication: '', dosage: '', frequency: '', durationDays: '', instructions: '' };
  readonly rxStatuses: PrescriptionStatus[] = ['ACTIVE', 'COMPLETED', 'DISCONTINUED'];

  ngOnInit() {
    this.form.valueChanges.subscribe(() => this.dirty.set(true));
    this.load();
  }
  load() {
    this.api.getEncounter(this.id()).subscribe({
      next: (e) => {
        this.enc.set(e);
        const v = e.vitals ?? {};
        this.form.patchValue({
          chiefComplaint: e.chiefComplaint ?? '', subjective: e.subjective ?? '', objective: e.objective ?? '', assessment: e.assessment ?? '', plan: e.plan ?? '',
          vitals: { temperature: v.temperature != null ? String(v.temperature) : '', heartRate: v.heartRate != null ? String(v.heartRate) : '', bloodPressure: v.bloodPressure ?? '', weight: v.weight != null ? String(v.weight) : '' },
        }, { emitEvent: false });
        this.dirty.set(false);
        this.editable() ? this.form.enable({ emitEvent: false }) : this.form.disable({ emitEvent: false });
      },
      error: (err) => { this.error.set('Could not load encounter.'); this.toast.fromError(err); },
    });
  }

  private dto(): EncounterDto {
    const v = this.form.getRawValue();
    const vitals: Record<string, unknown> = {};
    if (v.vitals.temperature) vitals['temperature'] = Number(v.vitals.temperature);
    if (v.vitals.heartRate) vitals['heartRate'] = Number(v.vitals.heartRate);
    if (v.vitals.bloodPressure) vitals['bloodPressure'] = v.vitals.bloodPressure;
    if (v.vitals.weight) vitals['weight'] = Number(v.vitals.weight);
    return { chiefComplaint: v.chiefComplaint, subjective: v.subjective, objective: v.objective, assessment: v.assessment, plan: v.plan, vitals };
  }

  save(then?: () => void) {
    this.saving.set(true);
    this.api.updateEncounter(this.id(), this.dto()).subscribe({
      next: () => { this.saving.set(false); this.dirty.set(false); this.toast.success('Encounter saved'); then ? then() : this.load(); },
      error: (err) => { this.saving.set(false); this.toast.fromError(err); },
    });
  }

  async sign() {
    const ok = await this.confirm.ask({
      title: 'Sign encounter',
      message: 'Signing locks this note as the official record and marks the linked appointment completed.\nContinue?',
      confirmText: 'Sign',
    });
    if (!ok) return;
    const doSign = () => {
      this.signing.set(true);
      this.api.sign(this.id()).subscribe({
        next: () => { this.signing.set(false); this.toast.success('Encounter signed'); this.load(); },
        error: (err) => { this.signing.set(false); this.toast.fromError(err); },
      });
    };
    this.dirty() ? this.save(doSign) : doSign();
  }

  addDx() {
    if (!this.dx.code.trim() || !this.dx.description.trim()) return;
    this.busy.set(true);
    this.api.addDiagnosis(this.id(), { code: this.dx.code.trim(), description: this.dx.description.trim(), isPrimary: this.dx.isPrimary }).subscribe({
      next: () => { this.busy.set(false); this.dx = { code: '', description: '', isPrimary: false }; this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  removeDx(dxId: string) {
    this.api.removeDiagnosis(this.id(), dxId).subscribe({ next: () => this.load(), error: (err) => this.toast.fromError(err) });
  }
  addRx() {
    if (!this.rx.medication.trim() || !this.rx.dosage.trim() || !this.rx.frequency.trim()) return;
    this.busy.set(true);
    this.api.addPrescription(this.id(), {
      medication: this.rx.medication.trim(), dosage: this.rx.dosage.trim(), frequency: this.rx.frequency.trim(),
      durationDays: this.rx.durationDays ? Number(this.rx.durationDays) : undefined, instructions: this.rx.instructions.trim() || undefined,
    }).subscribe({
      next: () => { this.busy.set(false); this.rx = { medication: '', dosage: '', frequency: '', durationDays: '', instructions: '' }; this.load(); },
      error: (err) => { this.busy.set(false); this.toast.fromError(err); },
    });
  }
  setRxStatus(rxId: string, e: Event) {
    const status = (e.target as HTMLSelectElement).value as PrescriptionStatus;
    this.api.setPrescriptionStatus(rxId, status).subscribe({ next: () => this.load(), error: (err) => { this.toast.fromError(err); this.load(); } });
  }
}
