import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth.service';
import { LanguageService } from '../../core/i18n/language.service';
import { FieldErrorComponent } from '../../shared/field-error';
import { LanguageSwitcherComponent } from '../../shared/language-switcher';

@Component({
  selector: 'cf-login',
  imports: [ReactiveFormsModule, RouterLink, TranslatePipe, FieldErrorComponent, LanguageSwitcherComponent],
  styleUrl: './auth-layout.scss',
  template: `
    <div class="auth">
      <div class="side">
        <h1>{{ 'app.name' | translate }}</h1>
        <p>{{ 'auth.tagline' | translate }}</p>
        <ul><li>{{ 'auth.feature1' | translate }}</li><li>{{ 'auth.feature2' | translate }}</li><li>{{ 'auth.feature3' | translate }}</li></ul>
      </div>
      <div class="form-wrap">
        <div class="lang-corner"><cf-language-switcher /></div>
        <div class="card card-body">
          <div class="brand"><span class="logo">C</span>{{ 'auth.signInTitle' | translate }}</div>
          @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
          <form [formGroup]="form" (ngSubmit)="submit()">
            <div class="field">
              <label class="req">{{ 'common.email' | translate }}</label>
              <input class="input" type="email" formControlName="email" autocomplete="username" dir="ltr" />
              <cf-field-error [control]="form.controls.email" />
            </div>
            <div class="field">
              <label class="req">{{ 'auth.password' | translate }}</label>
              <input class="input" type="password" formControlName="password" autocomplete="current-password" dir="ltr" />
              <cf-field-error [control]="form.controls.password" />
            </div>
            <button class="btn primary block" type="submit" [disabled]="loading()">{{ (loading() ? 'auth.signingIn' : 'auth.signIn') | translate }}</button>
          </form>
          <p class="mt-2 text-center muted">{{ 'auth.newClinic' | translate }} <a routerLink="/register">{{ 'auth.createAccount' | translate }}</a></p>
          <div class="hint"><strong>{{ 'auth.demo' | translate }}</strong><div dir="ltr" class="mono">owner@demo.clinic / Password123</div><div class="muted small">{{ 'auth.demoOthers' | translate }} <bdi dir="ltr">dr.salem@, reception@, finance@</bdi></div></div>
        </div>
      </div>
    </div>
  `,
})
export class LoginPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly lang = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  submit() {
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }
    this.loading.set(true);
    this.error.set(null);
    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => {
        const redirect = this.route.snapshot.queryParamMap.get('redirect');
        void this.router.navigateByUrl(redirect && redirect.startsWith('/') ? redirect : '/dashboard');
      },
      error: (err) => { this.loading.set(false); this.error.set(this.lang.errorMessage(err, this.lang.t('auth.loginFailed'))); },
    });
  }
}
