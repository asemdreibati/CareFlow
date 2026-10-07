import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../core/i18n/language.service';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';
import { REQUIRED_CONSENT } from '../portal.models';

/** First-login gate: PRIVACY v1 must be accepted before the shell opens. */
@Component({
  selector: 'cf-portal-consent-gate',
  imports: [TranslatePipe],
  template: `
    <div class="pt-frame">
      <header class="pt-header">
        <div class="pt-brand"><span class="pt-logo">{{ (auth.clinic()?.name || 'C').charAt(0) }}</span><div class="name">{{ auth.clinic()?.name }}</div></div>
        <button type="button" class="pt-lang" (click)="lang.toggle({ save: false })">{{ lang.locale() === 'ar' ? ('portal.common.english' | translate) : ('portal.common.arabic' | translate) }}</button>
      </header>
      <main class="pt-main pt-fade" style="padding-bottom:24px">
        <h1 class="pt-title">{{ 'portal.consent.title' | translate }}</h1>
        <p class="pt-muted">{{ 'portal.consent.intro' | translate }}</p>
        <div class="pt-card">
          <h2 style="font-size:16px;margin-bottom:8px">{{ 'portal.consent.privacyTitle' | translate }}</h2>
          <p style="font-size:14px;line-height:1.6">{{ 'portal.consent.privacyBody' | translate }}</p>
          <button type="button" class="pt-btn primary block" style="margin-top:8px" (click)="accept()" [disabled]="saving()">{{ (saving() ? 'portal.consent.accepting' : 'portal.consent.accept') | translate }}</button>
          <button type="button" class="pt-btn ghost block" style="margin-top:8px" (click)="auth.logout()">{{ 'portal.consent.later' | translate }}</button>
        </div>
      </main>
    </div>
  `,
})
export class PortalConsentGatePage {
  readonly auth = inject(PortalAuthService);
  readonly lang = inject(LanguageService);
  private readonly api = inject(PortalApi);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly saving = signal(false);

  accept() {
    this.saving.set(true);
    this.api.acceptConsent(REQUIRED_CONSENT).subscribe({
      next: () => void this.router.navigate(['/portal', 'app', 'home']),
      error: (err: unknown) => { this.saving.set(false); this.toast.fromError(err, this.lang.t('portal.errors.generic')); },
    });
  }
}
