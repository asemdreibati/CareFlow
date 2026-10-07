import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../core/i18n/language.service';
import { PortalAuthService } from '../portal-auth.service';

/** Authenticated patient shell: clinic header (language switch + logout) and a 5-tab bottom bar. */
@Component({
  selector: 'cf-portal-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  template: `
    <div class="pt-frame">
      <header class="pt-header">
        <div class="pt-brand">
          <span class="pt-logo">{{ initial() }}</span>
          <div style="min-width:0">
            <div class="name">{{ auth.clinic()?.name || ('portal.title' | translate) }}</div>
            <div class="sub">{{ 'portal.title' | translate }}</div>
          </div>
        </div>
        <div class="pt-row" style="gap:4px">
          <button type="button" class="pt-lang" (click)="lang.toggle({ save: false })" [attr.aria-label]="'portal.common.language' | translate">
            {{ lang.locale() === 'ar' ? ('portal.common.english' | translate) : ('portal.common.arabic' | translate) }}
          </button>
          <button type="button" class="pt-btn icon" (click)="auth.logout()" [attr.aria-label]="'portal.common.logout' | translate" [title]="'portal.common.logout' | translate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>
      <main class="pt-main"><router-outlet /></main>
      <nav class="pt-tabbar" aria-label="Portal">
        <a class="pt-tab" routerLink="/portal/app/home" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>
          <span>{{ 'portal.nav.home' | translate }}</span>
        </a>
        <a class="pt-tab" routerLink="/portal/app/appointments" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>{{ 'portal.nav.appointments' | translate }}</span>
        </a>
        <a class="pt-tab" routerLink="/portal/app/book" routerLinkActive="active">
          <span class="fab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
          <span>{{ 'portal.nav.book' | translate }}</span>
        </a>
        <a class="pt-tab" routerLink="/portal/app/invoices" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
          <span>{{ 'portal.nav.invoices' | translate }}</span>
        </a>
        <a class="pt-tab" routerLink="/portal/app/profile" routerLinkActive="active">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>{{ 'portal.nav.profile' | translate }}</span>
        </a>
      </nav>
    </div>
  `,
})
export class PortalShell {
  readonly auth = inject(PortalAuthService);
  readonly lang = inject(LanguageService);
  initial(): string { return (this.auth.clinic()?.name || 'C').trim().charAt(0).toUpperCase(); }
}
