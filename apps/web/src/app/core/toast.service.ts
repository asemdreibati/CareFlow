import { Injectable, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';
export interface ToastAction { label: string; run: () => void; }
export interface Toast { id: number; kind: ToastKind; text: string; action?: ToastAction; }

/** Extract the API `message` (string | string[]) from an HttpErrorResponse. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server.';
    const body = err.error as { message?: string | string[] } | string | null | undefined;
    if (typeof body === 'string' && body) return body;
    const m = body && typeof body === 'object' ? body.message : undefined;
    if (Array.isArray(m)) return m.join('\n');
    if (typeof m === 'string' && m) return m;
    if (err.status === 404) return 'Not found (this feature may not be available yet).';
    if (err.status === 501) return 'Not implemented yet.';
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
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
    this.errorWithAction('This appointment was modified by someone else. Reload to see the latest version.', { label: 'Reload', run: reload });
  }
  success(text: string) { this.show('success', text); }
  info(text: string) { this.show('info', text); }
  warn(text: string) { this.show('warn', text); }
  error(text: string) { this.show('error', text, 6500); }
  /** Show the API error message from an HTTP error. */
  fromError(err: unknown, fallback?: string) { this.error(errorMessage(err, fallback)); }
  dismiss(id: number) { this.toasts.update((t) => t.filter((x) => x.id !== id)); }
}
