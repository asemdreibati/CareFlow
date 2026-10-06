import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LanguageService } from '../core/i18n/language.service';
import { PORTAL_TOKEN_KEY, portalLoginPath } from './portal-url';
import { PortalClinic, PortalMe, PortalPatient, PortalVerifyResponse } from './portal.models';

const SESSION_KEY = 'cf.portal.session';
const SLUG_KEY = 'cf.portal.clinicSlug';

function read<T>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function readString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/**
 * Patient session: token in `cf.portal.token` (separate from the staff `cf.tokens`), patient + clinic
 * signals, the last clinic slug (so a logged-out patient lands on the right login page) and the
 * loaded `/portal/me` profile (consent gate). Pure state — HTTP lives in `PortalApi`.
 */
@Injectable({ providedIn: 'root' })
export class PortalAuthService {
  private readonly router = inject(Router);
  private readonly lang = inject(LanguageService);

  readonly token = signal<string | null>(readString(PORTAL_TOKEN_KEY));
  readonly patient = signal<PortalPatient | null>(read<{ patient: PortalPatient; clinic: PortalClinic }>(SESSION_KEY)?.patient ?? null);
  readonly clinic = signal<PortalClinic | null>(read<{ patient: PortalPatient; clinic: PortalClinic }>(SESSION_KEY)?.clinic ?? null);
  readonly clinicSlug = signal<string | null>(readString(SLUG_KEY));
  /** `/portal/me` profile (loaded lazily by the consent guard / profile page). */
  readonly profile = signal<PortalMe | null>(null);

  readonly isAuthenticated = computed(() => !!this.token());
  readonly patientName = computed(() => {
    const p = this.profile() ?? this.patient();
    return p ? `${p.firstName} ${p.lastName}`.trim() : '';
  });
  readonly currency = computed(() => this.clinic()?.currency || 'SAR');

  rememberSlug(slug: string): void {
    const s = slug.trim().toLowerCase();
    if (!s) return;
    this.clinicSlug.set(s);
    write(SLUG_KEY, s);
  }

  /** Stores the verified session and applies the patient's preferred language. */
  apply(res: PortalVerifyResponse): void {
    this.token.set(res.accessToken);
    write(PORTAL_TOKEN_KEY, res.accessToken);
    this.patient.set(res.patient);
    this.clinic.set(res.clinic);
    write(SESSION_KEY, JSON.stringify({ patient: res.patient, clinic: res.clinic }));
    if (res.clinic?.slug) this.rememberSlug(res.clinic.slug);
    this.profile.set(null);
    if (res.patient?.locale === 'ar' || res.patient?.locale === 'en') this.lang.set(res.patient.locale);
  }

  setProfile(me: PortalMe | null): void {
    this.profile.set(me);
    if (me) this.patient.update((p) => ({ ...(p ?? { id: me.id }), firstName: me.firstName, lastName: me.lastName, locale: me.locale ?? p?.locale }));
  }

  /** Drops the patient session (token + cached profile); keeps the clinic slug for re-login. */
  clear(): void {
    this.token.set(null);
    this.patient.set(null);
    this.clinic.set(null);
    this.profile.set(null);
    write(PORTAL_TOKEN_KEY, null);
    write(SESSION_KEY, null);
  }

  logout(navigate = true): void {
    this.clear();
    if (navigate) void this.router.navigate(portalLoginPath(this.clinicSlug()));
  }
}
