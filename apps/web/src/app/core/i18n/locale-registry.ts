/**
 * Tiny module-level mirror of the active locale so pure helpers that are not
 * injectable (date-utils, money) can format in the user's language without
 * depending on Angular DI. `LanguageService` is the only writer.
 */
import { computed, signal } from '@angular/core';
import { arSA, enGB } from 'date-fns/locale';
import type { Locale } from 'date-fns';

export type AppLocale = 'ar' | 'en';

/** Intl tags: Arabic with Latin digits and an explicit Gregorian calendar (Chromium defaults ar-SA to Umm al-Qura). */
export const INTL_TAGS: Record<AppLocale, string> = { ar: 'ar-SA-u-nu-latn-ca-gregory', en: 'en-GB' };
const DATE_FNS_LOCALES: Record<AppLocale, Locale> = { ar: arSA, en: enGB };

let active: AppLocale = 'en';

export function setActiveLocale(locale: AppLocale): void { active = locale; }
export function activeLocale(): AppLocale { return active; }
export function activeIntlTag(): string { return INTL_TAGS[active]; }
export function activeDateFnsLocale(): Locale { return DATE_FNS_LOCALES[active]; }

// ---------- Clinic timezone ----------
// Dates/times are always shown in the clinic's zone, never the browser's. The staff `AuthService`
// registers `session.clinic.timezone` as the staff source, `PortalAuthService` registers the portal
// clinic's zone; while the portal tree is mounted (`setPortalMode(true)` from PortalRoot) the portal
// source wins. Sources are functions so signal reads inside them stay reactive and synchronous.

type ZoneSource = () => string | null | undefined;
const NONE: ZoneSource = () => null;
const staffSource = signal<ZoneSource>(NONE);
const portalSource = signal<ZoneSource>(NONE);
const portalMode = signal(false);

function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Active clinic IANA zone (null = unknown → runtime zone). Reactive. */
export const clinicTimeZone = computed<string | null>(() => validZone((portalMode() ? portalSource() : staffSource())()));

/** Registers where the staff/portal clinic zone comes from (e.g. `() => auth.session()?.clinic.timezone`). */
export function setClinicTimeZoneSource(source: 'staff' | 'portal', fn: ZoneSource): void {
  (source === 'staff' ? staffSource : portalSource).set(fn);
}
/** Fixed zone for a source (tests, or a zone known up front). */
export function setClinicTimeZone(source: 'staff' | 'portal', tz: string | null | undefined): void {
  setClinicTimeZoneSource(source, () => tz);
}
export function setPortalMode(on: boolean): void { portalMode.set(on); }
export function isPortalMode(): boolean { return portalMode(); }
