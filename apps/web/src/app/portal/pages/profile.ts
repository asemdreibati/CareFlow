import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { AppLocale, LanguageService } from '../../core/i18n/language.service';
import { ToastService } from '../../core/toast.service';
import { PortalApi } from '../portal-api.service';
import { PortalAuthService } from '../portal-auth.service';
import { useFormat } from '../portal-ui';
import { KNOWN_CONSENTS, PortalConsent, PortalMePatch, hasConsent } from '../portal.models';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * PATCH /portal/me body: a filled field is sent trimmed; an empty one is omitted (the API rejects
 * `email: ''`) unless the patient cleared a previously stored value, which is sent as `null`.
 */
export function profilePatch(locale: AppLocale, values: { email: string; address: string }, original: { email: string; address: string }): PortalMePatch {
  const patch: PortalMePatch = { locale };
  for (const k of ['email', 'address'] as const) {
    const v = (values[k] ?? '').trim();
    if (v) patch[k] = v;
    else if (original[k]) patch[k] = null;
  }
  return patch;
}

@Component({
  selector: 'cf-portal-profile',
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="pt-fade">
      <h1 class="pt-title">{{ 'portal.profile.title' | translate }}</h1>
      <div class="pt-card">
        <div class="pt-row" style="margin-bottom:12px"><span class="avatar" style="width:44px;height:44px;font-size:16px">{{ initials() }}</span><div><div class="pt-strong" style="font-size:16px">{{ auth.patientName() }}</div><div class="pt-muted pt-small" dir="ltr">{{ auth.profile()?.phone || '' }}</div></div></div>
        <form (ngSubmit)="save()" novalidate>
          <div class="pt-field">
            <label>{{ 'portal.profile.language' | translate }}</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <label class="pt-radio" [class.active]="locale() === 'ar'"><input type="radio" name="locale" value="ar" [checked]="locale() === 'ar'" (change)="setLocale('ar')" />{{ 'portal.common.arabic' | translate }}</label>
              <label class="pt-radio" [class.active]="locale() === 'en'"><input type="radio" name="locale" value="en" [checked]="locale() === 'en'" (change)="setLocale('en')" />{{ 'portal.common.english' | translate }}</label>
            </div>
          </div>
          <div class="pt-field">
            <label for="email">{{ 'portal.profile.email' | translate }}</label>
            <input id="email" class="pt-input" type="email" inputmode="email" autocomplete="email" dir="ltr" [(ngModel)]="email" name="email" [class.invalid]="email && !emailValid()" />
            @if (email && !emailValid()) { <div class="pt-error">{{ 'portal.profile.invalidEmail' | translate }}</div> }
          </div>
          <div class="pt-field">
            <label for="address">{{ 'portal.profile.address' | translate }}</label>
            <textarea id="address" class="pt-input" [(ngModel)]="address" name="address" rows="2" autocomplete="street-address"></textarea>
          </div>
          <button type="submit" class="pt-btn primary block" [disabled]="saving() || !emailValid()">{{ (saving() ? 'portal.profile.saving' : 'portal.profile.save') | translate }}</button>
        </form>
      </div>

      <div class="pt-section">{{ 'portal.profile.consents' | translate }}</div>
      <div class="pt-card">
        @for (c of consentRows(); track c.type + c.version) {
          <div class="pt-row between" style="padding:8px 0">
            <div>
              <div class="pt-strong">{{ ('portal.profile.consentNames.' + c.type) | translate }} <span class="pt-muted pt-small">{{ c.version }}</span></div>
              <div class="pt-small" [class.pt-muted]="!c.accepted" [class.success-text]="c.accepted">{{ c.accepted ? ('portal.profile.acceptedOn' | translate: { date: f.date(c.acceptedAt) }) : ('portal.profile.notAccepted' | translate) }}</div>
            </div>
            @if (!c.accepted) { <button type="button" class="pt-btn sm primary" (click)="accept(c)" [disabled]="busy()">{{ 'portal.profile.accept' | translate }}</button> }
          </div>
        }
      </div>

      <button type="button" class="pt-btn danger block" style="margin-top:20px" (click)="auth.logout()">{{ 'portal.profile.logout' | translate }}</button>
    </div>
  `,
  styles: [`.pt-radio { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px solid var(--cf-border); border-radius: 12px; cursor: pointer; font-size: 15px; } .pt-radio.active { border-color: var(--cf-primary); background: var(--cf-primary-soft); } .pt-radio input { accent-color: var(--cf-primary); width: 18px; height: 18px; }`],
})
export class PortalProfilePage {
  readonly auth = inject(PortalAuthService);
  readonly f = useFormat();
  private readonly lang = inject(LanguageService);
  private readonly api = inject(PortalApi);
  private readonly toast = inject(ToastService);
  readonly saving = signal(false);
  readonly busy = signal(false);
  readonly locale = computed(() => this.lang.locale());
  readonly extraConsents = signal<PortalConsent[]>([]);
  email = '';
  address = '';
  /** Values loaded from `/portal/me`, to tell "left empty" (omit) from "cleared" (send null). */
  private original = { email: '', address: '' };

  readonly consentRows = computed(() => {
    const mine = [...(this.auth.profile()?.consents ?? []), ...this.extraConsents()];
    const known = KNOWN_CONSENTS.map((k) => ({ ...k, ...(mine.find((m) => hasConsent([m], k)) ?? {}), accepted: hasConsent(mine, k) }));
    const others = mine.filter((m) => !KNOWN_CONSENTS.some((k) => hasConsent([m], k))).map((m) => ({ ...m, accepted: true }));
    return [...known, ...others];
  });

  constructor() {
    this.api.me().subscribe({
      next: (me) => {
        this.email = me?.email ?? '';
        this.address = me?.address ?? '';
        this.original = { email: this.email.trim(), address: this.address.trim() };
      },
      error: () => undefined,
    });
    this.api.consents().subscribe({ next: (list) => this.extraConsents.set(list), error: () => undefined });
  }

  initials() { const n = this.auth.patientName().split(' ').filter(Boolean); return (n[0]?.[0] ?? '') + (n[1]?.[0] ?? ''); }
  emailValid() { return !this.email.trim() || EMAIL_RE.test(this.email.trim()); }

  setLocale(l: AppLocale) {
    this.lang.set(l, { save: false });
    this.api.updateMe({ locale: l }).subscribe({ error: () => undefined });
  }
  save() {
    if (!this.emailValid()) return;
    this.saving.set(true);
    this.api.updateMe(profilePatch(this.locale(), { email: this.email, address: this.address }, this.original)).subscribe({
      next: () => { this.saving.set(false); this.toast.success(this.f.lang.t('portal.profile.saved')); },
      error: (err: unknown) => { this.saving.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); },
    });
  }
  accept(c: PortalConsent) {
    this.busy.set(true);
    this.api.acceptConsent({ type: c.type, version: c.version }).subscribe({
      next: (saved) => { this.busy.set(false); this.extraConsents.update((l) => [...l, saved ?? { ...c, acceptedAt: new Date().toISOString() }]); this.toast.success(this.f.lang.t('portal.profile.consentAccepted')); },
      error: (err: unknown) => { this.busy.set(false); this.toast.fromError(err, this.f.lang.t('portal.errors.generic')); },
    });
  }
}
