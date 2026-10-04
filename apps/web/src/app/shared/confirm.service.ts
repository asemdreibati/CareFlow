import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions { title: string; message: string; confirmText?: string; danger?: boolean; }
interface Pending extends ConfirmOptions { resolve: (v: boolean) => void; }

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<Pending | null>(null);
  ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => this.pending.set({ ...opts, resolve }));
  }
  answer(v: boolean) {
    const p = this.pending();
    this.pending.set(null);
    p?.resolve(v);
  }
}
