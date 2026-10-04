import { Component, inject } from '@angular/core';
import { ConfirmService } from './confirm.service';
import { DialogComponent } from './dialog';

@Component({
  selector: 'cf-confirm-host',
  imports: [DialogComponent],
  template: `
    @if (confirm.pending(); as p) {
      <cf-dialog [title]="p.title" [width]="440" (closed)="confirm.answer(false)">
        <p style="white-space: pre-line">{{ p.message }}</p>
        <div footer>
          <button type="button" class="btn" (click)="confirm.answer(false)">Cancel</button>
          <button type="button" class="btn" [class.danger]="p.danger" [class.primary]="!p.danger" (click)="confirm.answer(true)">{{ p.confirmText || 'Confirm' }}</button>
        </div>
      </cf-dialog>
    }
  `,
})
export class ConfirmHostComponent { readonly confirm = inject(ConfirmService); }
