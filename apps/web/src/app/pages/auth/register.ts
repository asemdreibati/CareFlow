import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errorMessage } from '../../core/toast.service';
import { FieldErrorComponent } from '../../shared/field-error';
import { passwordValidator } from '../../shared/validators';

@Component({
  selector: 'cf-register',
  imports: [ReactiveFormsModule, RouterLink, FieldErrorComponent],
  styleUrl: './auth-layout.scss',
  template: `
    <div class="auth">
      <div class="side">
        <h1>Set up your clinic</h1>
        <p>Create a clinic workspace and the owner account in one step. You can invite doctors, nurses and staff afterwards.</p>
      </div>
      <div class="form-wrap">
        <div class="card card-body" style="max-width: 560px">
          <div class="brand"><span class="logo">C</span>Register a clinic</div>
          @if (error()) { <div class="inline-alert error">{{ error() }}</div> }
          <form [formGroup]="form" (ngSubmit)="submit()">
            <h3 class="mb-1">Clinic</h3>
            <div class="form-grid">
              <div class="field"><label class="req">Clinic name</label><input class="input" formControlName="clinicName" (input)="suggestSlug()" /><cf-field-error [control]="form.controls.clinicName" /></div>
              <div class="field"><label class="req">Slug</label><input class="input" formControlName="slug" placeholder="my-clinic" /><cf-field-error [control]="form.controls.slug" /></div>
              <div class="field span-2"><label>Timezone</label><input class="input" formControlName="timezone" /></div>
            </div>
            <h3 class="mb-1">Owner account</h3>
            <div class="form-grid">
              <div class="field"><label class="req">First name</label><input class="input" formControlName="firstName" /><cf-field-error [control]="form.controls.firstName" /></div>
              <div class="field"><label class="req">Last name</label><input class="input" formControlName="lastName" /><cf-field-error [control]="form.controls.lastName" /></div>
              <div class="field span-2"><label class="req">Email</label><input class="input" type="email" formControlName="email" /><cf-field-error [control]="form.controls.email" /></div>
              <div class="field span-2"><label class="req">Password</label><input class="input" type="password" formControlName="password" autocomplete="new-password" /><cf-field-error [control]="form.controls.password" /></div>
            </div>
            <button class="btn primary block" type="submit" [disabled]="loading()">{{ loading() ? 'Creating…' : 'Create clinic' }}</button>
          </form>
          <p class="mt-2 text-center muted">Already have an account? <a routerLink="/login">Sign in</a></p>
        </div>
      </div>
    </div>
  `,
})
export class RegisterPage {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
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
  private slugTouched = false;

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
      error: (err) => { this.loading.set(false); this.error.set(errorMessage(err, 'Registration failed')); },
    });
  }
}
