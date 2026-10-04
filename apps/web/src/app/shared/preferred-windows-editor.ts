import { Component, computed, input, output } from '@angular/core';
import { PreferredWindow } from '../core/models';
import { WEEKDAYS_SHORT, timeOptions } from '../core/date-utils';
import { addWindow, removeWindow, updateWindow, validateWindows } from '../core/scheduling/preferred-windows';

/** Weekday + from/to rows. Controlled: emits the full new list on every change. */
@Component({
  selector: 'cf-preferred-windows',
  template: `
    <div class="pw">
      @for (w of windows(); track $index; let i = $index) {
        <div class="pw-row">
          <select class="input sm" (change)="patch(i, { weekday: +$any($event.target).value })" [disabled]="disabled()" aria-label="Weekday">
            @for (d of dayOrder; track d) { <option [value]="d" [selected]="d === w.weekday">{{ days[d] }}</option> }
          </select>
          <select class="input sm" (change)="patch(i, { startTime: $any($event.target).value })" [disabled]="disabled()" aria-label="From">
            @for (t of times; track t) { <option [value]="t" [selected]="t === w.startTime">{{ t }}</option> }
          </select>
          <span class="muted small">to</span>
          <select class="input sm" (change)="patch(i, { endTime: $any($event.target).value })" [disabled]="disabled()" aria-label="To">
            @for (t of times; track t) { <option [value]="t" [selected]="t === w.endTime">{{ t }}</option> }
          </select>
          @if (!disabled()) { <button type="button" class="btn ghost xs danger-text" (click)="remove(i)" aria-label="Remove window">✕</button> }
        </div>
      } @empty { <div class="muted small">{{ emptyText() }}</div> }
      @if (problem()) { <div class="field-error">{{ problem() }}</div> }
      @if (!disabled()) { <button type="button" class="btn ghost xs" (click)="add()">+ Add window</button> }
    </div>
  `,
  styles: [`
    .pw { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .pw-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .pw-row select { width: auto; }
  `],
})
export class PreferredWindowsEditorComponent {
  readonly windows = input<PreferredWindow[]>([]);
  readonly disabled = input(false);
  readonly emptyText = input('No preferred windows — any time works.');
  readonly windowsChange = output<PreferredWindow[]>();
  readonly days = WEEKDAYS_SHORT;
  readonly dayOrder = [1, 2, 3, 4, 5, 6, 0];
  readonly times = timeOptions(30, 6, 22);
  readonly problem = computed(() => validateWindows(this.windows(), this.days));

  add() { this.windowsChange.emit(addWindow(this.windows())); }
  remove(i: number) { this.windowsChange.emit(removeWindow(this.windows(), i)); }
  patch(i: number, p: Partial<PreferredWindow>) { this.windowsChange.emit(updateWindow(this.windows(), i, p)); }
}
