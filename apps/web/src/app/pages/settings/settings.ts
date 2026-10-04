import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { ClinicApi } from '../../core/api/clinic.api';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { clean } from '../../core/api/http-utils';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { Clinic, NoShowModel } from '../../core/models';
import { fmtDateTime } from '../../core/date-utils';
import { errorMessage } from '../../core/toast.service';
import { PageHeaderComponent } from '../../shared/page-header';
import { FieldErrorComponent } from '../../shared/field-error';
import { passwordValidator } from '../../shared/validators';

@Component({
  selector: 'cf-settings',
  imports: [ReactiveFormsModule, PageHeaderComponent, FieldErrorComponent],
  template: `
    <div class="page" style="max-width: 860px">
      <cf-page-header title="Settings" />
      <div class="tabs">
        @if (canEditClinic) { <button type="button" [class.active]="tab() === 'clinic'" (click)="tab.set('clinic')">Clinic profile</button> }
        <button type="button" [class.active]="tab() === 'password'" (click)="tab.set('password')">Change password</button>
        @if (canSchedule) { <button type="button" [class.active]="tab() === 'noshow'" (click)="tab.set('noshow'); loadModel()">No-show model</button> }
      </div>

      @if (tab() === 'clinic') {
        <form [formGroup]="clinicForm" (ngSubmit)="saveClinic()" class="card">
          <div class="card-header"><h3>Clinic profile</h3>@if (clinic()) { <span class="subtle">Slug: {{ clinic()!.slug }}</span> }</div>
          <div class="card-body form-grid">
            <div class="field"><label class="req">Name</label><input class="input" formControlName="name" /><cf-field-error [control]="clinicForm.controls.name" /></div>
            <div class="field"><label>Timezone</label><input class="input" formControlName="timezone" /></div>
            <div class="field"><label>Phone</label><input class="input" formControlName="phone" /></div>
            <div class="field"><label>Email</label><input class="input" type="email" formControlName="email" /><cf-field-error [control]="clinicForm.controls.email" /></div>
            <div class="field"><label>Currency (ISO)</label><input class="input" formControlName="currency" maxlength="3" style="text-transform: uppercase" /></div>
            <div class="field span-2"><label>Address</label><input class="input" formControlName="address" /></div>
          </div>
          <div class="card-footer"><button class="btn primary" type="submit" [disabled]="savingClinic() || clinicForm.invalid">{{ savingClinic() ? 'Saving…' : 'Save' }}</button></div>
        </form>
      } @else if (tab() === 'noshow') {
        <div class="card">
          <div class="card-header"><h3>No-show prediction model</h3>
            <button type="button" class="btn primary" (click)="train()" [disabled]="training()">{{ training() ? 'Training…' : model() ? 'Retrain model' : 'Train model' }}</button>
          </div>
          <div class="card-body">
            <p class="muted">A per-clinic logistic regression trained on completed vs. no-show visits (history, lead time, time of day, patient age…). Every new or updated appointment gets a risk score; appointments at ≥ 50% appear in the dashboard's "At risk today" list. The model also retrains nightly.</p>
            @if (modelError()) { <div class="inline-alert info">{{ modelError() }}</div> }
            @else if (modelLoading()) { <div class="loading"><span class="spinner"></span> Loading…</div> }
            @else if (model(); as m) {
              <div class="grid grid-4">
                <div class="card stat"><span class="label">Accuracy</span><span class="value">{{ pct(m.metrics?.accuracy) }}</span><span class="hint">on the training set</span></div>
                <div class="card stat"><span class="label">AUC</span><span class="value">{{ num(m.metrics?.auc) }}</span><span class="hint">ranking quality (0.5 = random)</span></div>
                <div class="card stat"><span class="label">Sample size</span><span class="value">{{ m.sampleSize ?? m.metrics?.n ?? '—' }}</span><span class="hint">{{ pct(m.metrics?.positiveRate) }} no-shows</span></div>
                <div class="card stat"><span class="label">Trained</span><span class="value" style="font-size: 16px">{{ fmt(m.trainedAt) }}</span><span class="hint">retrains nightly</span></div>
              </div>
            } @else {
              <div class="empty">No model yet. Train one once the clinic has at least 30 completed or no-show appointments.</div>
            }
          </div>
        </div>
      } @else {
        <form [formGroup]="pwForm" (ngSubmit)="changePassword()" class="card">
          <div class="card-header"><h3>Change password</h3></div>
          <div class="card-body" style="max-width: 420px">
            <div class="field"><label class="req">Current password</label><input class="input" type="password" formControlName="currentPassword" autocomplete="current-password" /></div>
            <div class="field"><label class="req">New password</label><input class="input" type="password" formControlName="newPassword" autocomplete="new-password" /><cf-field-error [control]="pwForm.controls.newPassword" /></div>
            <div class="field"><label class="req">Confirm new password</label><input class="input" type="password" formControlName="confirm" autocomplete="new-password" />
              @if (pwForm.controls.confirm.touched && pwForm.value.confirm !== pwForm.value.newPassword) { <div class="field-error">Passwords do not match</div> }
            </div>
          </div>
          <div class="card-footer"><button class="btn primary" type="submit" [disabled]="savingPw() || pwForm.invalid || pwForm.value.confirm !== pwForm.value.newPassword">{{ savingPw() ? 'Saving…' : 'Update password' }}</button></div>
        </form>
      }
    </div>
  `,
})
export class SettingsPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(ClinicApi);
  private readonly scheduling = inject(SchedulingApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  readonly canEditClinic = this.auth.hasPermission('clinic:update');
  readonly canSchedule = this.auth.hasPermission('scheduling:manage');
  readonly tab = signal<'clinic' | 'password' | 'noshow'>(this.initialTab());
  readonly model = signal<NoShowModel | null>(null);
  readonly modelLoading = signal(false);
  readonly modelError = signal<string | null>(null);
  readonly training = signal(false);
  readonly fmt = fmtDateTime;
  readonly pct = (v?: number | null) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
  readonly num = (v?: number | null) => (typeof v === 'number' ? v.toFixed(2) : '—');
  readonly clinic = signal<Clinic | null>(null);
  readonly savingClinic = signal(false);
  readonly savingPw = signal(false);
  readonly clinicForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]], timezone: [''], phone: [''], email: ['', Validators.email], currency: [''], address: [''],
  });
  readonly pwForm = this.fb.nonNullable.group({
    currentPassword: ['', Validators.required], newPassword: ['', [Validators.required, passwordValidator]], confirm: ['', Validators.required],
  });

  private initialTab(): 'clinic' | 'password' | 'noshow' {
    const t = this.route.snapshot.queryParamMap.get('tab');
    if (t === 'noshow' && this.canSchedule) return 'noshow';
    if (t === 'password' || !this.canEditClinic) return 'password';
    return 'clinic';
  }
  loadModel() {
    this.modelLoading.set(true); this.modelError.set(null);
    this.scheduling.noShowModel().subscribe({
      next: (m) => { this.model.set(m && (m.trainedAt || m.metrics) ? m : null); this.modelLoading.set(false); },
      error: (err) => { this.modelLoading.set(false); if (err?.status === 404 && !/not available|feature/i.test(errorMessage(err))) this.model.set(null); else this.modelError.set(errorMessage(err, 'No-show model is not available yet.')); },
    });
  }
  train() {
    this.training.set(true);
    this.scheduling.trainNoShowModel().subscribe({
      next: (m) => { this.training.set(false); this.model.set(m); this.toast.success('Model trained'); },
      error: (err) => { this.training.set(false); this.toast.fromError(err, 'Training failed'); },
    });
  }
  constructor() {
    if (this.tab() === 'noshow') this.loadModel();
    if (this.canEditClinic) {
      this.api.get().subscribe({
        next: (c) => { this.clinic.set(c); this.clinicForm.patchValue({ name: c.name, timezone: c.timezone ?? '', phone: c.phone ?? '', email: c.email ?? '', currency: c.currency ?? '', address: c.address ?? '' }); },
        error: (err) => this.toast.fromError(err),
      });
    }
  }
  saveClinic() {
    if (this.clinicForm.invalid) return;
    this.savingClinic.set(true);
    const v = this.clinicForm.getRawValue();
    this.api.update(clean({ ...v, currency: v.currency.toUpperCase() })).subscribe({
      next: (c) => { this.savingClinic.set(false); this.clinic.set(c); this.toast.success('Clinic updated'); this.auth.me().subscribe({ error: () => undefined }); },
      error: (err) => { this.savingClinic.set(false); this.toast.fromError(err); },
    });
  }
  changePassword() {
    if (this.pwForm.invalid) return;
    this.savingPw.set(true);
    const v = this.pwForm.getRawValue();
    this.auth.changePassword(v.currentPassword, v.newPassword).subscribe({
      next: () => { this.savingPw.set(false); this.pwForm.reset(); this.toast.success('Password changed'); },
      error: (err) => { this.savingPw.set(false); this.toast.fromError(err); },
    });
  }
}
