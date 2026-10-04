import { Component, HostListener, input, output } from '@angular/core';

/** Simple modal overlay. Parent controls visibility with @if. */
@Component({
  selector: 'cf-dialog',
  template: `
    <div class="backdrop" (click)="onBackdrop($event)">
      <div class="modal" [style.max-width.px]="width()" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h2>{{ title() }}</h2>
          <button type="button" class="btn ghost icon sm" (click)="closed.emit()" aria-label="Close">✕</button>
        </div>
        <div class="modal-body"><ng-content /></div>
        <div class="modal-footer"><ng-content select="[footer]" /></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: flex-start; justify-content: center; padding: 48px 16px; z-index: 100; overflow-y: auto; }
    .modal { width: 100%; background: var(--cf-surface); border-radius: var(--cf-radius); box-shadow: var(--cf-shadow-lg); animation: pop 0.15s ease-out; }
    .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid var(--cf-border); }
    .modal-header h2 { font-size: 16px; }
    .modal-body { padding: 20px; }
    .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--cf-border); }
    .modal-footer:empty { display: none; }
    @keyframes pop { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
  `],
})
export class DialogComponent {
  readonly title = input('');
  readonly width = input(560);
  readonly closed = output<void>();
  onBackdrop(e: MouseEvent) { if ((e.target as HTMLElement).classList.contains('backdrop')) this.closed.emit(); }
  @HostListener('document:keydown.escape') onEsc() { this.closed.emit(); }
}
