import { Injectable, inject, signal } from '@angular/core';
import { LanguageService } from './i18n/language.service';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';
export interface ToastAction { label: string; run: () => void; }
export interface Toast { id: number; kind: ToastKind; text: string; action?: ToastAction; }

export { errorMessage } from './i18n/api-errors';

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly lang = inject(LanguageService);
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(kind: ToastKind, text: string, ttl = 4500, action?: ToastAction) {
    const id = ++this.seq;
    this.toasts.update((t) => [...t, { id, kind, text, action }]);
    setTimeout(() => this.dismiss(id), ttl);
  }
  /** Error toast with an inline action button (e.g. "Reload" after an optimistic-locking conflict). */
  errorWithAction(text: string, action: ToastAction) { this.show('error', text, 9000, action); }
  /** Standard message for the optimistic-locking 409 — the caller passes what "Reload" should do. */
  versionConflict(reload: () => void) {
    this.errorWithAction(this.lang.t('errors.versionConflict'), { label: this.lang.t('common.reload'), run: reload });
  }
  success(text: string) { this.show('success', text); }
  info(text: string) { this.show('info', text); }
  warn(text: string) { this.show('warn', text); }
  error(text: string) { this.show('error', text, 6500); }
  /** Show the (translated) API error message from an HTTP error. */
  fromError(err: unknown, fallback?: string) { this.error(this.lang.errorMessage(err, fallback)); }
  dismiss(id: number) { this.toasts.update((t) => t.filter((x) => x.id !== id)); }
}
