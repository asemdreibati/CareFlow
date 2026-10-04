import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/toast.service';
import { FieldErrorComponent } from '../../shared/field-error';

@Component({
  selector: 'cf-login',
  imports: [ReactiveFormsModule, RouterLink, FieldErrorComponent],
  styleUrl: './auth-layout.scss',
  template: `
    <div class="auth">
      <div class="side">
        <h1>CareFlow</h1>
        <p>Multi-tenant clinic management: scheduling, medical records, billing and AI-assisted documentation in one place.</p>
        <ul><li>Conflict-free appointment booking</li><li>SOAP encounters with sign-off</li><li>Invoices, payments and audit trail</li></ul>
      </div>
      <div class="form-wrap">
        <div class="card card-body">
          <div class="brand"><span class="logo">C</span>Sign in to CareFlow</div>
          @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
          <form [formGroup]="form" (ngSubmit)="submit()">
            <div class="field">
              <label class="req">Email</label>
              <input class="input" type="email" formControlName="email" autocomplete="username" />
              <cf-field-error [control]="form.controls.email" />
            </div>
            <div class="field">
              <label class="req">Password</label>
              <input class="input" type="password" formControlName="password" autocomplete="current-password" />
              <cf-field-error [control]="form.controls.password" />
            </div>
            <button class="btn primary block" type="submit" [disabled]="loading()">{{ loading() ? 'Signing in…' : 'Sign in' }}</button>
          </form>
          <p class="mt-2 text-center muted">New clinic? <a routerLink="/register">Create an account</a></p>
          <div class="hint"><strong>Demo:</strong> owner@demo.clinic / Password123 (also dr.salem@, reception@, finance@)</div>
        </div>
      </div>
    </div>
  `,
})
export class LoginPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
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
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Login failed')); },
    });
  }
}
