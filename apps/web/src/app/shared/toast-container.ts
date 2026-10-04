import { Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'cf-toasts',
  template: `
    <div class="toasts">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind" (click)="toasts.dismiss(t.id)">{{ t.text }}</div>
      }
    </div>
  `,
  styles: [`
    .toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 200; max-width: 380px; }
    .toast { padding: 10px 14px; border-radius: 8px; background: #0f172a; color: #fff; font-size: 13.5px; box-shadow: var(--cf-shadow-lg); cursor: pointer; white-space: pre-line; animation: in 0.15s ease-out; border-left: 4px solid #64748b; }
    .toast.success { border-left-color: #22c55e; } .toast.error { border-left-color: #ef4444; } .toast.warn { border-left-color: #f59e0b; } .toast.info { border-left-color: #3b82f6; }
    @keyframes in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
  `],
})
export class ToastContainerComponent { readonly toasts = inject(ToastService); }
