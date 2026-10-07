/**
 * Tiny module-level mirror of the active locale so pure helpers that are not
 * injectable (date-utils, money) can format in the user's language without
 * depending on Angular DI. `LanguageService` is the only writer.
 */
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
