import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth.service';
import { LanguageService } from '../../core/i18n/language.service';
import { FieldErrorComponent } from '../../shared/field-error';
import { LanguageSwitcherComponent } from '../../shared/language-switcher';
import { passwordValidator } from '../../shared/validators';

@Component({
  selector: 'cf-register',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, FieldErrorComponent, LanguageSwitcherComponent],
  styleUrl: './auth-layout.scss',
  template: `
    <div class="auth">
      <div class="side">
        <h1>{{ 'auth.setupTitle' | translate }}</h1>
        <p>{{ 'auth.setupText' | translate }}</p>
      </div>
      <div class="form-wrap">
        <div class="lang-corner"><cf-language-switcher /></div>
        <div class="card card-body" style="max-width: 560px">
          <div class="brand"><span class="logo">C</span>{{ 'auth.registerTitle' | translate }}</div>
          @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
          <form [formGroup]="form" (ngSubmit)="submit()">
            <h3 class="mb-1">{{ 'auth.clinic' | translate }}</h3>
            <div class="form-grid">
              <div class="field"><label class="req">{{ 'auth.clinicName' | translate }}</label><input class="input" formControlName="clinicName" (input)="suggestSlug()" /><cf-field-error [control]="form.controls.clinicName" /></div>
              <div class="field"><label class="req">{{ 'auth.slug' | translate }}</label><input class="input" formControlName="slug" placeholder="my-clinic" dir="ltr" /><cf-field-error [control]="form.controls.slug" /></div>
              <div class="field span-2"><label>{{ 'auth.timezone' | translate }}</label><input class="input" formControlName="timezone" dir="ltr" /></div>
            </div>
            <h3 class="mb-1">{{ 'auth.ownerAccount' | translate }}</h3>
            <div class="form-grid">
              <div class="field"><label class="req">{{ 'common.firstName' | translate }}</label><input class="input" formControlName="firstName" /><cf-field-error [control]="form.controls.firstName" /></div>
              <div class="field"><label class="req">{{ 'common.lastName' | translate }}</label><input class="input" formControlName="lastName" /><cf-field-error [control]="form.controls.lastName" /></div>
              <div class="field span-2"><label class="req">{{ 'common.email' | translate }}</label><input class="input" type="email" formControlName="email" dir="ltr" /><cf-field-error [control]="form.controls.email" /></div>
              <div class="field span-2"><label class="req">{{ 'auth.password' | translate }}</label><input class="input" type="password" formControlName="password" autocomplete="new-password" dir="ltr" /><cf-field-error [control]="form.controls.password" /></div>
            </div>
            <button class="btn primary block" type="submit" [disabled]="loading()">{{ (loading() ? 'common.creating' : 'auth.createClinic') | translate }}</button>
          </form>
          <p class="mt-2 text-center muted">{{ 'auth.haveAccount' | translate }} <a routerLink="/login">{{ 'auth.signIn' | translate }}</a></p>
        </div>
      </div>
    </div>
  `,
})
export class RegisterPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly lang = inject(LanguageService);
  private readonly router = inject(Router);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = this.fb.nonNullable.group({
    clinicName: ['', [Validators.required, Validators.maxLength(120)]],
    slug: ['', [Validators.required, Validators.pattern(/^[a-z0-9-]{3,40}$/)]],
    timezone: [Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'],
    firstName: ['', Validators.required],
    lastName: ['', Validators.required],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, passwordValidator]],
  });

  suggestSlug() {
    if (this.form.controls.slug.dirty) return;
    const s = this.form.controls.clinicName.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    this.form.controls.slug.setValue(s, { emitEvent: false });
  }

  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.loading.set(true);
    this.error.set(null);
    const v = this.form.getRawValue();
    this.auth.register({ ...v, timezone: v.timezone || undefined }).subscribe({
      next: () => void this.router.navigateByUrl('/dashboard'),
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('auth.registrationFailed'))); },
    });
  }
}
