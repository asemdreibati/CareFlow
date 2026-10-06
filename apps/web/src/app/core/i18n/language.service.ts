import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

export type AppLocale = 'ar' | 'en';

export const SUPPORTED_LOCALES: readonly AppLocale[] = ['ar', 'en'];
export const DEFAULT_LOCALE: AppLocale = 'ar';
const STORAGE_KEY = 'cf.locale';

/** Intl locale tags: Arabic with Latin digits so numbers stay readable next to codes. */
const INTL_TAGS: Record<AppLocale, string> = { ar: 'ar-SA-u-nu-latn', en: 'en-GB' };

/**
 * Runtime language + text direction. Persists the choice per browser, applies
 * `lang`/`dir` on <html>, and drives ngx-translate. Components call `t()` or use
 * the `translate` pipe; dates/numbers go through `formatDate`/`formatNumber`.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);

  readonly locale = signal<AppLocale>(this.restore());
  readonly dir = computed<'rtl' | 'ltr'>(() => (this.locale() === 'ar' ? 'rtl' : 'ltr'));
  readonly intlTag = computed(() => INTL_TAGS[this.locale()]);
  readonly isRtl = computed(() => this.dir() === 'rtl');

  constructor() {
    this.translate.addLangs([...SUPPORTED_LOCALES]);
    this.translate.setFallbackLang('en');
    effect(() => {
      const locale = this.locale();
      this.translate.use(locale);
      const html = this.document.documentElement;
      html.setAttribute('lang', locale);
      html.setAttribute('dir', this.dir());
      try {
        localStorage.setItem(STORAGE_KEY, locale);
      } catch {
        /* storage unavailable */
      }
    });
  }

  set(locale: AppLocale): void {
    if (SUPPORTED_LOCALES.includes(locale)) this.locale.set(locale);
  }

  toggle(): void {
    this.set(this.locale() === 'ar' ? 'en' : 'ar');
  }

  /** Synchronous translation (for toasts, titles, aria labels). */
  t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(key, params);
  }

  formatDate(value: Date | string | number, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
    return new Intl.DateTimeFormat(this.intlTag(), options).format(new Date(value));
  }

  formatTime(value: Date | string | number): string {
    return new Intl.DateTimeFormat(this.intlTag(), { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  }

  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.intlTag(), options).format(value);
  }

  formatMoney(value: number, currency: string): string {
    return new Intl.NumberFormat(this.intlTag(), { style: 'currency', currency, minimumFractionDigits: 2 }).format(value);
  }

  private restore(): AppLocale {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as AppLocale | null;
      if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
    } catch {
      /* storage unavailable */
    }
    const browser = (navigator.language || '').toLowerCase();
    return browser.startsWith('ar') ? 'ar' : DEFAULT_LOCALE;
  }
}
