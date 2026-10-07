import { needsPatientSelection } from '../portal.models';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../core/i18n/language.service';
import { ToastService, errorMessage } from '../../core/toast.service';
import { isCompleteOtp, isValidPhone, normalizeOtp, normalizePhone, resendCountdown } from '../otp-countdown';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';

/**
 * `/portal/:clinicSlug/login` (or `/portal/login` with a clinic-code field):
 * phone → request OTP → 6-digit code (resend after 60 s) → verify → `/portal/app`.
 */
@Component({
  selector: 'cf-portal-login',
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="pt-frame login">
      <header class="pt-header">
        <div class="pt-brand"><span class="pt-logo">{{ initial() }}</span><div class="name">{{ clinicName() }}</div></div>
        <button type="button" class="pt-lang" (click)="lang.toggle({ save: false })">{{ lang.locale() === 'ar' ? ('portal.common.english' | translate) : ('portal.common.arabic' | translate) }}</button>
      </header>
      <main class="pt-main">
        @if (step() === 'phone') {
          <div class="pt-fade">
            <h1 class="pt-title">{{ 'portal.login.title' | translate }}</h1>
            <p class="pt-muted">{{ 'portal.login.subtitle' | translate }}</p>
            @if (expired()) { <div class="pt-alert info">{{ 'portal.login.sessionExpired' | translate }}</div> }
            @if (error()) { <div class="pt-alert error">{{ error() }}</div> }
            <form class="pt-card" (ngSubmit)="requestOtp()" novalidate>
              @if (!slugFromRoute()) {
                <div class="pt-field">
                  <label for="slug">{{ 'portal.login.clinic' | translate }}</label>
                  <input id="slug" class="pt-input" [(ngModel)]="slug" name="slug" [placeholder]="'portal.login.clinicPlaceholder' | translate" autocapitalize="none" autocomplete="organization" dir="ltr" />
                  <div class="pt-hint">{{ 'portal.login.clinicHint' | translate }}</div>
                </div>
              }
              <div class="pt-field">
                <label for="phone">{{ 'portal.login.phone' | translate }}</label>
                <input id="phone" class="pt-input" [class.invalid]="phoneTouched() && !phoneValid()" [(ngModel)]="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" [placeholder]="'portal.login.phonePlaceholder' | translate" (blur)="phoneTouched.set(true)" />
                @if (phoneTouched() && !phoneValid()) { <div class="pt-error">{{ 'portal.login.invalidPhone' | translate }}</div> }
              </div>
              <button type="submit" class="pt-btn primary block" [disabled]="loading()">{{ (loading() ? 'portal.login.sending' : 'portal.login.sendCode') | translate }}</button>
            </form>
          </div>
        } @else {
          <div class="pt-fade">
            <h1 class="pt-title">{{ 'portal.login.codeTitle' | translate }}</h1>
            <p class="pt-muted">{{ 'portal.login.codeSent' | translate: { phone: sentTo() } }}</p>
            @if (error()) { <div class="pt-alert error">{{ error() }}</div> }
            @if (candidates().length) {
              <div class="pt-card" role="group" [attr.aria-label]="'portal.login.choosePatient' | translate">
                <p class="pt-muted">{{ 'portal.login.choosePatient' | translate }}</p>
                @for (c of candidates(); track c.id) {
                  <button type="button" class="pt-btn block" [disabled]="loading()" (click)="choose(c.id)"><bdi>{{ c.displayName }}</bdi></button>
                }
              </div>
            } @else {
            <form class="pt-card" (ngSubmit)="verify()" novalidate>
              <div class="pt-field">
                <label for="code">{{ 'portal.login.code' | translate }}</label>
                <input id="code" class="pt-input pt-otp" [ngModel]="code()" (ngModelChange)="onCode($event)" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" />
                @if (codeTouched() && !codeValid()) { <div class="pt-error">{{ 'portal.login.invalidCode' | translate }}</div> }
              </div>
              <button type="submit" class="pt-btn primary block" [disabled]="loading() || !codeValid()">{{ (loading() ? 'portal.login.verifying' : 'portal.login.verify') | translate }}</button>
              <div class="pt-actions">
                <button type="button" class="pt-btn ghost sm" (click)="resend()" [disabled]="!countdown().canResend || loading()">
                  @if (countdown().canResend) { {{ 'portal.login.resend' | translate }} } @else { <span class="pt-countdown">{{ 'portal.login.resendIn' | translate: { time: countdown().label } }}</span> }
                </button>
                <button type="button" class="pt-btn ghost sm" (click)="changePhone()">{{ 'portal.login.changePhone' | translate }}</button>
              </div>
            </form>
            }
          </div>
        }
        <p class="pt-hint" style="text-align:center;margin-top:24px">{{ 'portal.login.footer' | translate }}</p>
      </main>
    </div>
  `,
  styles: [`.login .pt-main { padding-bottom: 24px; } .login .pt-title { margin-top: 12px; } .pt-otp { text-align: center; font-size: 28px; letter-spacing: 0.4em; font-weight: 700; min-height: 60px; direction: ltr; font-variant-numeric: tabular-nums; }`],
})
export class PortalLoginPage {
  private readonly api = inject(PortalApi);
  private readonly auth = inject(PortalAuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);
  readonly lang = inject(LanguageService);

  /** Bound by the router (`withComponentInputBinding`). */
  readonly clinicSlug = input<string | undefined>();
  readonly slugFromRoute = computed(() => this.clinicSlug()?.trim().toLowerCase() || '');

  slug = this.auth.clinicSlug() ?? '';
  phone = '';
  readonly step = signal<'phone' | 'code'>('phone');
  /** Patients sharing the verified phone; non-empty while the person must choose. */
  readonly candidates = signal<{ id: string; displayName: string }[]>([]);
  private selectionToken: string | null = null;
  readonly code = signal('');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly phoneTouched = signal(false);
  readonly codeTouched = signal(false);
  readonly sentAt = signal<number | null>(null);
  readonly sentTo = signal('');
  private readonly now = signal(Date.now());
  readonly countdown = computed(() => resendCountdown(this.sentAt(), this.now()));
  readonly expired = computed(() => this.route.snapshot.queryParamMap.has('expired'));

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 500);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  clinicName(): string { const c = this.auth.clinic(); return c && c.slug === this.effectiveSlug() ? c.name : this.lang.t('portal.title'); }
  initial(): string { return (this.clinicName() || 'C').charAt(0).toUpperCase(); }
  effectiveSlug(): string { return this.slugFromRoute() || this.slug.trim().toLowerCase(); }
  phoneValid(): boolean { return isValidPhone(normalizePhone(this.phone)); }
  codeValid(): boolean { return isCompleteOtp(this.code()); }
  onCode(v: string) { this.code.set(normalizeOtp(v ?? '')); this.codeTouched.set(true); }

  requestOtp(resend = false) {
    this.phoneTouched.set(true);
    const slug = this.effectiveSlug();
    const phone = normalizePhone(this.phone);
    if (!slug || !isValidPhone(phone)) { if (!slug) this.error.set(this.lang.t('portal.login.clinicHint')); return; }
    this.loading.set(true);
    this.error.set(null);
    this.auth.rememberSlug(slug);
    this.api.requestOtp(slug, phone).subscribe({
      next: () => {
        this.loading.set(false);
        this.sentAt.set(Date.now());
        this.sentTo.set(phone);
        this.step.set('code');
        if (resend) this.toast.success(this.lang.t('portal.login.resent'));
      },
      error: (err: unknown) => { this.loading.set(false); this.error.set(this.describe(err)); },
    });
  }
  resend() { if (this.countdown().canResend) this.requestOtp(true); }
  changePhone() { this.step.set('phone'); this.code.set(''); this.error.set(null); this.codeTouched.set(false); this.candidates.set([]); this.selectionToken = null; }

  verify() {
    this.codeTouched.set(true);
    if (!this.codeValid()) return;
    this.loading.set(true);
    this.error.set(null);
    this.api.verify(this.effectiveSlug(), this.sentTo(), this.code()).subscribe({
      next: (res) => {
        if (needsPatientSelection(res)) {
          // Several patients share this phone (e.g. a parent and a child): ask who is signing in.
          this.loading.set(false);
          this.selectionToken = res.selectionToken;
          this.candidates.set(res.candidates);
          return;
        }
        this.enterApp();
      },
      error: (err: unknown) => { this.loading.set(false); this.error.set(this.describe(err, 'portal.login.failed')); },
    });
  }

  choose(patientId: string) {
    if (!this.selectionToken) return;
    this.loading.set(true);
    this.error.set(null);
    this.api.selectPatient(this.selectionToken, patientId).subscribe({
      next: () => this.enterApp(),
      error: (err: unknown) => {
        // The selection token is short-lived: start over from the code step.
        this.loading.set(false);
        this.candidates.set([]);
        this.selectionToken = null;
        this.error.set(this.describe(err, 'portal.login.failed'));
      },
    });
  }

  private enterApp() {
    const redirect = this.route.snapshot.queryParamMap.get('redirect');
    void this.router.navigateByUrl(redirect && redirect.startsWith('/portal/app') ? redirect : '/portal/app');
  }

  private describe(err: unknown, fallbackKey = 'portal.errors.generic'): string {
    const e = err as { status?: number };
    if (e?.status === 0) return this.lang.t('portal.errors.network');
    if (e?.status === 429) return this.lang.t('portal.errors.tooMany');
    if (e?.status === 404 || e?.status === 501) return this.lang.t('portal.errors.notAvailable');
    if (e?.status === 400 || e?.status === 401) return this.lang.t(fallbackKey);
    return errorMessage(err, this.lang.t(fallbackKey));
  }
}
