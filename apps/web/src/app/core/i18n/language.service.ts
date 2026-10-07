import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from '../auth.service';
import { mapApiError, registerErrorTranslator } from './api-errors';
import { INTL_TAGS, clinicTimeZone, isPortalMode, setActiveLocale } from './locale-registry';

export type { AppLocale } from './locale-registry';
import type { AppLocale } from './locale-registry';

export const SUPPORTED_LOCALES: readonly AppLocale[] = ['ar', 'en'];
export const DEFAULT_LOCALE: AppLocale = 'ar';
const STORAGE_KEY = 'cf.locale';
const EMPTY = '—';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Enum groups searched (in order) by `enumLabel` when no group is given. */
const ENUM_GROUPS = ['status', 'role', 'type', 'priority', 'channel', 'resourceType', 'severity', 'gender', 'paymentMethod', 'frequency', 'risk'];

type DateInput = Date | string | number | null | undefined;

/**
 * Runtime language + text direction. Persists the choice per browser, applies
 * `lang`/`dir` on <html>, drives ngx-translate and mirrors the staff preference
 * (`session.user.locale`, saved via PATCH /auth/me). Components call `t()` or use
 * the `translate` pipe; dates/numbers/money go through the `format*` helpers,
 * which always use Latin digits and a 24-hour clock.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);
  private readonly auth = inject(AuthService);

  readonly locale = signal<AppLocale>(this.restore());
  readonly dir = computed<'rtl' | 'ltr'>(() => (this.locale() === 'ar' ? 'rtl' : 'ltr'));
  readonly intlTag = computed(() => INTL_TAGS[this.locale()]);
  readonly isRtl = computed(() => this.dir() === 'rtl');
  /** Bumped whenever the loaded translations change, so `t()` is reactive inside computed()/templates. */
  private readonly version = signal(0);
  private lastSessionKey: string | null = null;

  constructor() {
    this.translate.addLangs([...SUPPORTED_LOCALES]);
    this.translate.setFallbackLang('en');
    const bump = () => this.version.update((v) => v + 1);
    this.translate.onLangChange.pipe(takeUntilDestroyed()).subscribe(bump);
    this.translate.onTranslationChange.pipe(takeUntilDestroyed()).subscribe(bump);
    registerErrorTranslator((err, fallback) => this.errorMessage(err, fallback));

    effect(() => {
      const locale = this.locale();
      setActiveLocale(locale);
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

    // Apply the preference stored on the staff account whenever a (new) session carries one (not inside the patient portal).
    effect(() => {
      const user = this.auth.session()?.user;
      const key = user ? `${user.id}:${user.locale ?? ''}` : null;
      if (key === this.lastSessionKey) return;
      this.lastSessionKey = key;
      const pref = user?.locale;
      if (pref && SUPPORTED_LOCALES.includes(pref) && !untracked(() => isPortalMode())) untracked(() => this.locale.set(pref));
    });
  }

  /**
   * Switches the UI language immediately. With a staff session the choice is saved on the staff
   * account (PATCH /auth/me, best effort) unless `save: false` — the patient portal always passes
   * `save: false` (and never saves while the portal tree is mounted) since it has its own `/portal/me`.
   */
  set(locale: AppLocale, opts: { save?: boolean } = {}): void {
    if (!SUPPORTED_LOCALES.includes(locale) || locale === this.locale()) return;
    this.locale.set(locale);
    if (opts.save !== false && !isPortalMode() && this.auth.isAuthenticated()) {
      this.auth.updateLocale(locale).subscribe({ error: () => undefined });
    }
  }

  toggle(opts: { save?: boolean } = {}): void {
    this.set(this.locale() === 'ar' ? 'en' : 'ar', opts);
  }

  /** Synchronous translation (for toasts, titles, aria labels). Reactive: re-evaluates in computed()/templates on language change. */
  t(key: string, params?: Record<string, unknown>): string {
    this.version();
    return this.translate.instant(key, params);
  }

  /** True when the key exists in the active (or fallback) bundle. */
  has(key: string): boolean {
    return this.t(key) !== key;
  }

  /**
   * Label for an enum value (status, role, type…) from `enums.<group>.<VALUE>`.
   * Without a group every group is searched; unknown values are humanised ("NO_SHOW" → "No show").
   */
  enumLabel(value: string | null | undefined, group?: string): string {
    if (value === null || value === undefined || value === '') return EMPTY;
    const v = String(value).toUpperCase();
    const groups = group ? [group] : ENUM_GROUPS;
    for (const g of groups) {
      const key = `enums.${g}.${v}`;
      const label = this.t(key);
      if (label !== key) return label;
    }
    return v.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Translated API error (known server messages + HTTP statuses), falling back to the raw message. */
  errorMessage(err: unknown, fallback?: string): string {
    return mapApiError(err, (k, p) => this.t(k, p), fallback);
  }

  // ---------- Formatting (Latin digits, 24h, clinic timezone) ----------

  /**
   * Instants are rendered in the clinic's timezone (`clinicTimeZone()`), not the browser's; pass
   * `options.timeZone` to override. A date-only string ("2026-10-07", e.g. a birth date) is a calendar
   * date, not an instant, and is shown as-is.
   */
  formatDate(value: DateInput, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }): string {
    const d = this.toDate(value);
    if (!d) return EMPTY;
    const dateOnly = typeof value === 'string' && DATE_ONLY.test(value);
    const timeZone = dateOnly ? 'UTC' : options.timeZone ?? clinicTimeZone() ?? undefined;
    try {
      return new Intl.DateTimeFormat(this.intlTag(), { ...options, timeZone }).format(d);
    } catch {
      return new Intl.DateTimeFormat(this.intlTag(), { ...options, timeZone: undefined }).format(d);
    }
  }

  /** "06 Oct 2026, 14:05" */
  formatDateTime(value: DateInput): string {
    return this.formatDate(value, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  /** "14:05" */
  formatTime(value: DateInput): string {
    return this.formatDate(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  /** "Tuesday, 6 October 2026" */
  formatLongDate(value: DateInput): string {
    return this.formatDate(value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  /** "Tue 06 Oct" */
  formatWeekdayDate(value: DateInput): string {
    return this.formatDate(value, { weekday: 'short', day: '2-digit', month: 'short' });
  }

  /** "06 Oct" */
  formatDayMonth(value: DateInput): string {
    return this.formatDate(value, { day: '2-digit', month: 'short' });
  }

  /** "06 Oct, 14:05" */
  formatDayMonthTime(value: DateInput): string {
    return this.formatDate(value, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }

  /** "14:05–14:35", wrapped in a left-to-right isolate so the order is stable inside RTL text. */
  formatTimeRange(from: DateInput, to: DateInput): string {
    return `\u2066${this.formatTime(from)}–${this.formatTime(to)}\u2069`;
  }

  formatNumber(value: number | string | null | undefined, options?: Intl.NumberFormatOptions): string {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (n === null || n === undefined || Number.isNaN(n)) return EMPTY;
    return new Intl.NumberFormat(this.intlTag(), options).format(n);
  }

  /** "SAR 1,234.50" / "1,234.50 SAR" — ISO code in both languages so amounts stay unambiguous. */
  formatMoney(value: number | string | null | undefined, currency?: string | null): string {
    const n = typeof value === 'string' ? parseFloat(value) : (value ?? 0);
    if (Number.isNaN(n)) return EMPTY;
    const cur = currency || this.auth.clinic()?.currency || 'SAR';
    try {
      return new Intl.NumberFormat(this.intlTag(), { style: 'currency', currency: cur, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${cur}`;
    }
  }

  /** "62%" */
  formatPercent(ratio: number | null | undefined): string {
    return typeof ratio === 'number' && !Number.isNaN(ratio) ? this.formatNumber(ratio, { style: 'percent', maximumFractionDigits: 0 }) : EMPTY;
  }

  /** "30 min" with the localised unit. */
  formatMinutes(minutes: number | null | undefined): string {
    return minutes === null || minutes === undefined ? EMPTY : this.t('common.units.minutes', { n: this.formatNumber(minutes) });
  }

  /** Compact remaining-time label: "1d 2h", "3h 05m", "12m 30s", "45s" with localised units. */
  formatRemaining(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (v: number) => String(v).padStart(2, '0');
    const u = (k: string) => this.t(`common.units.${k}`);
    if (d > 0) return `${d}${u('d')} ${h}${u('h')}`;
    if (h > 0) return `${h}${u('h')} ${two(m)}${u('m')}`;
    if (m > 0) return `${m}${u('m')} ${two(s)}${u('s')}`;
    return `${s}${u('s')}`;
  }

  /** Weekday names indexed like `Date.getDay()` (0 = Sunday). */
  weekdayNames(style: 'long' | 'short' | 'narrow' = 'long'): string[] {
    const f = new Intl.DateTimeFormat(this.intlTag(), { weekday: style, timeZone: 'UTC' });
    // 2023-01-01 is a Sunday.
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i, 12))));
  }

  /** Month names, January first. */
  monthNames(style: 'long' | 'short' = 'long'): string[] {
    const f = new Intl.DateTimeFormat(this.intlTag(), { month: style, timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2023, i, 1, 12))));
  }

  private toDate(value: DateInput): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
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
