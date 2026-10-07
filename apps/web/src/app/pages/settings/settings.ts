import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ClinicApi } from '../../core/api/clinic.api';
import { SchedulingApi } from '../../core/api/scheduling.api';
import { clean } from '../../core/api/http-utils';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { LanguageService } from '../../core/i18n/language.service';
import { rawServerMessage } from '../../core/i18n/api-errors';
import { Clinic, NoShowModel } from '../../core/models';
import { PageHeaderComponent } from '../../shared/page-header';
import { FieldErrorComponent } from '../../shared/field-error';
import { LanguageSwitcherComponent } from '../../shared/language-switcher';
import { passwordValidator } from '../../shared/validators';

@Component({
  selector: 'cf-settings',
  imports: [ReactiveFormsModule, TranslatePipe, PageHeaderComponent, FieldErrorComponent, LanguageSwitcherComponent],
  template: `
    <div class="page" style="max-width: 860px">
      <cf-page-header [title]="'settings.title' | translate" />
      <div class="tabs">
        @if (canEditClinic) { <button type="button" [class.active]="tab() === 'clinic'" (click)="tab.set('clinic')">{{ 'settings.clinicProfile' | translate }}</button> }
        <button type="button" [class.active]="tab() === 'password'" (click)="tab.set('password')">{{ 'settings.changePassword' | translate }}</button>
        <button type="button" [class.active]="tab() === 'language'" (click)="tab.set('language')">{{ 'app.language' | translate }}</button>
        @if (canSchedule) { <button type="button" [class.active]="tab() === 'noshow'" (click)="tab.set('noshow'); loadModel()">{{ 'settings.noShowModel' | translate }}</button> }
      </div>

      @if (tab() === 'clinic') {
        <form [formGroup]="clinicForm" (ngSubmit)="saveClinic()" class="card">
          <div class="card-header"><h3>{{ 'settings.clinicProfile' | translate }}</h3>@if (clinic()) { <span class="subtle">{{ 'auth.slug' | translate }}: <span dir="ltr">{{ clinic()!.slug }}</span></span> }</div>
          <div class="card-body form-grid">
            <div class="field"><label class="req">{{ 'common.name' | translate }}</label><input class="input" formControlName="name" /><cf-field-error [control]="clinicForm.controls.name" /></div>
            <div class="field"><label>{{ 'auth.timezone' | translate }}</label><input class="input" formControlName="timezone" dir="ltr" /></div>
            <div class="field"><label>{{ 'common.phone' | translate }}</label><input class="input" formControlName="phone" dir="ltr" /></div>
            <div class="field"><label>{{ 'common.email' | translate }}</label><input class="input" type="email" formControlName="email" dir="ltr" /><cf-field-error [control]="clinicForm.controls.email" /></div>
            <div class="field"><label>{{ 'settings.currencyIso' | translate }}</label><input class="input" formControlName="currency" maxlength="3" style="text-transform: uppercase" dir="ltr" /></div>
            <div class="field span-2"><label>{{ 'common.address' | translate }}</label><input class="input" formControlName="address" /></div>
          </div>
          <div class="card-footer"><button class="btn primary" type="submit" [disabled]="savingClinic() || clinicForm.invalid">{{ (savingClinic() ? 'common.saving' : 'common.save') | translate }}</button></div>
        </form>
      } @else if (tab() === 'language') {
        <div class="card">
          <div class="card-header"><h3>{{ 'app.language' | translate }}</h3></div>
          <div class="card-body">
            <p class="muted">{{ 'settings.languageHint' | translate }}</p>
            <cf-language-switcher />
          </div>
        </div>
      } @else if (tab() === 'noshow') {
        <div class="card">
          <div class="card-header"><h3>{{ 'settings.noShowTitle' | translate }}</h3>
            <button type="button" class="btn primary" (click)="train()" [disabled]="training()">{{ (training() ? 'settings.training' : model() ? 'settings.retrain' : 'settings.train') | translate }}</button>
          </div>
          <div class="card-body">
            <p class="muted">{{ 'settings.noShowText' | translate }}</p>
            @if (modelError()) { <div class="inline-alert info">{{ modelError() }}</div> }
            @else if (modelLoading()) { <div class="loading"><span class="spinner"></span> {{ 'common.loading' | translate }}</div> }
            @else if (model(); as m) {
              <div class="grid grid-4">
                <div class="card stat"><span class="label">{{ 'settings.accuracy' | translate }}</span><span class="value">{{ lang.formatPercent(m.metrics?.accuracy) }}</span><span class="hint">{{ 'settings.onTrainingSet' | translate }}</span></div>
                <div class="card stat"><span class="label">{{ 'settings.auc' | translate }}</span><span class="value">{{ lang.formatNumber(m.metrics?.auc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}</span><span class="hint">{{ 'settings.aucHint' | translate }}</span></div>
                <div class="card stat"><span class="label">{{ 'settings.sampleSize' | translate }}</span><span class="value">{{ lang.formatNumber(m.sampleSize ?? m.metrics?.n) }}</span><span class="hint">{{ 'settings.noShowRate' | translate: { pct: lang.formatPercent(m.metrics?.positiveRate) } }}</span></div>
                <div class="card stat"><span class="label">{{ 'settings.trained' | translate }}</span><span class="value" style="font-size: 16px">{{ lang.formatDateTime(m.trainedAt) }}</span><span class="hint">{{ 'settings.retrainsNightly' | translate }}</span></div>
              </div>
            } @else {
              <div class="empty">{{ 'settings.noModel' | translate }}</div>
            }
          </div>
        </div>
      } @else {
        <form [formGroup]="pwForm" (ngSubmit)="changePassword()" class="card">
          <div class="card-header"><h3>{{ 'settings.changePassword' | translate }}</h3></div>
          <div class="card-body" style="max-width: 420px">
            <div class="field"><label class="req">{{ 'settings.currentPassword' | translate }}</label><input class="input" type="password" formControlName="currentPassword" autocomplete="current-password" dir="ltr" /></div>
            <div class="field"><label class="req">{{ 'settings.newPassword' | translate }}</label><input class="input" type="password" formControlName="newPassword" autocomplete="new-password" dir="ltr" /><cf-field-error [control]="pwForm.controls.newPassword" /></div>
            <div class="field"><label class="req">{{ 'settings.confirmPassword' | translate }}</label><input class="input" type="password" formControlName="confirm" autocomplete="new-password" dir="ltr" />
              @if (pwForm.controls.confirm.touched && pwForm.value.confirm !== pwForm.value.newPassword) { <div class="field-error">{{ 'validation.passwordMismatch' | translate }}</div> }
            </div>
          </div>
          <div class="card-footer"><button class="btn primary" type="submit" [disabled]="savingPw() || pwForm.invalid || pwForm.value.confirm !== pwForm.value.newPassword">{{ (savingPw() ? 'common.saving' : 'settings.updatePassword') | translate }}</button></div>
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
  readonly lang = inject(LanguageService);
  readonly canEditClinic = this.auth.hasPermission('clinic:update');
  readonly canSchedule = this.auth.hasPermission('scheduling:manage');
  readonly tab = signal<'clinic' | 'password' | 'noshow' | 'language'>(this.initialTab());
  readonly model = signal<NoShowModel | null>(null);
  readonly modelLoading = signal(false);
  readonly modelError = signal<string | null>(null);
  readonly training = signal(false);
  readonly clinic = signal<Clinic | null>(null);
  readonly savingClinic = signal(false);
  readonly savingPw = signal(false);
  readonly clinicForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]], timezone: [''], phone: [''], email: ['', Validators.email], currency: [''], address: [''],
  });
  readonly pwForm = this.fb.nonNullable.group({
    currentPassword: ['', Validators.required], newPassword: ['', [Validators.required, passwordValidator]], confirm: ['', Validators.required],
  });

  private initialTab(): 'clinic' | 'password' | 'noshow' | 'language' {
    const t = this.route.snapshot.queryParamMap.get('tab');
    if (t === 'noshow' && this.canSchedule) return 'noshow';
    if (t === 'language') return 'language';
    if (t === 'password' || !this.canEditClinic) return 'password';
    return 'clinic';
  }
  loadModel() {
    this.modelLoading.set(true); this.modelError.set(null);
    this.scheduling.noShowModel().subscribe({
      next: (m) => { this.model.set(m && (m.trainedAt || m.metrics) ? m : null); this.modelLoading.set(false); },
      error: (err) => {
        this.modelLoading.set(false);
        if (err?.status === 404 && !/not available|feature/i.test(rawServerMessage(err) ?? '')) this.model.set(null);
        else this.modelError.set(this.lang.errorMessage(err, this.lang.t('settings.modelUnavailable')));
      },
    });
  }
  train() {
    this.training.set(true);
    this.scheduling.trainNoShowModel().subscribe({
      next: (m) => { this.training.set(false); this.model.set(m); this.toast.success(this.lang.t('settings.modelTrained')); },
      error: (err) => { this.training.set(false); this.toast.fromError(err, this.lang.t('settings.trainingFailed')); },
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
      next: (c) => { this.savingClinic.set(false); this.clinic.set(c); this.toast.success(this.lang.t('settings.clinicUpdated')); this.auth.me().subscribe({ error: () => undefined }); },
      error: (err) => { this.savingClinic.set(false); this.toast.fromError(err); },
    });
  }
  changePassword() {
    if (this.pwForm.invalid) return;
    this.savingPw.set(true);
    const v = this.pwForm.getRawValue();
    this.auth.changePassword(v.currentPassword, v.newPassword).subscribe({
      next: () => { this.savingPw.set(false); this.pwForm.reset(); this.toast.success(this.lang.t('settings.passwordChanged')); },
      error: (err) => { this.savingPw.set(false); this.toast.fromError(err); },
    });
  }
}
