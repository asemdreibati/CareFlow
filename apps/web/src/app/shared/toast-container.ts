import { Component, inject } from '@angular/core';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'cf-toasts',
  template: `
    <div class="toasts">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind" (click)="toasts.dismiss(t.id)">
          <span>{{ t.text }}</span>
          @if (t.action; as act) { <button type="button" class="act" (click)="act.run(); toasts.dismiss(t.id); $event.stopPropagation()">{{ act.label }}</button> }
        </div>
      }
    </div>
  `,
  styles: [`
    .toasts { position: fixed; inset-inline-end: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 200; max-width: 380px; }
    .toast { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 8px; background: #0f172a; color: #fff; font-size: 13.5px; box-shadow: var(--cf-shadow-lg); cursor: pointer; white-space: pre-line; animation: in 0.15s ease-out; border-inline-start: 4px solid #64748b; }
    .toast.success { border-inline-start-color: #22c55e; } .toast.error { border-inline-start-color: #ef4444; } .toast.warn { border-inline-start-color: #f59e0b; } .toast.info { border-inline-start-color: #3b82f6; }
    .act { margin-inline-start: auto; flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.35); background: rgba(255,255,255,0.1); color: #fff; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
    .act:hover { background: rgba(255,255,255,0.2); }
    @keyframes in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
  `],
})
export class ToastContainerComponent { readonly toasts = inject(ToastService); }
