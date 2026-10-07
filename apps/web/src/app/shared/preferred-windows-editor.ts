import { Component, computed, inject, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PreferredWindow } from '../core/models';
import { timeOptions } from '../core/date-utils';
import { LanguageService } from '../core/i18n/language.service';
import { addWindow, removeWindow, updateWindow, windowsProblem } from '../core/scheduling/preferred-windows';

/** Weekday + from/to rows. Controlled: emits the full new list on every change. */
@Component({
  selector: 'cf-preferred-windows',
  imports: [TranslatePipe],
  template: `
    <div class="pw">
      @for (w of windows(); track $index; let i = $index) {
        <div class="pw-row">
          <select class="input sm" (change)="patch(i, { weekday: +$any($event.target).value })" [disabled]="disabled()" [attr.aria-label]="'windows.weekday' | translate">
            @for (d of dayOrder; track d) { <option [value]="d" [selected]="d === w.weekday">{{ days()[d] }}</option> }
          </select>
          <select class="input sm" (change)="patch(i, { startTime: $any($event.target).value })" [disabled]="disabled()" [attr.aria-label]="'windows.from' | translate">
            @for (t of times; track t) { <option [value]="t" [selected]="t === w.startTime">{{ t }}</option> }
          </select>
          <span class="muted small">{{ 'common.to' | translate }}</span>
          <select class="input sm" (change)="patch(i, { endTime: $any($event.target).value })" [disabled]="disabled()" [attr.aria-label]="'windows.to' | translate">
            @for (t of times; track t) { <option [value]="t" [selected]="t === w.endTime">{{ t }}</option> }
          </select>
          @if (!disabled()) { <button type="button" class="btn ghost xs danger-text" (click)="remove(i)" [attr.aria-label]="'windows.remove' | translate">✕</button> }
        </div>
      } @empty { <div class="muted small">{{ emptyText() || ('windows.empty' | translate) }}</div> }
      @if (problem(); as p) { <div class="field-error">{{ p }}</div> }
      @if (!disabled()) { <button type="button" class="btn ghost xs" (click)="add()">+ {{ 'windows.add' | translate }}</button> }
    </div>
  `,
  styles: [`
    .pw { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .pw-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .pw-row select { width: auto; }
  `],
})
export class PreferredWindowsEditorComponent {
  private readonly lang = inject(LanguageService);
  readonly windows = input<PreferredWindow[]>([]);
  readonly disabled = input(false);
  /** Optional override for the empty-state text (defaults to a translated hint). */
  readonly emptyText = input('');
  readonly windowsChange = output<PreferredWindow[]>();
  readonly days = computed(() => this.lang.weekdayNames('short'));
  readonly dayOrder = [1, 2, 3, 4, 5, 6, 0];
  readonly times = timeOptions(30, 6, 22);
  readonly problem = computed(() => {
    const p = windowsProblem(this.windows(), this.days());
    return p ? this.lang.t(`errors.windows.${p.key}`, p.params) : null;
  });

  add() { this.windowsChange.emit(addWindow(this.windows())); }
  remove(i: number) { this.windowsChange.emit(removeWindow(this.windows(), i)); }
  patch(i: number, p: Partial<PreferredWindow>) { this.windowsChange.emit(updateWindow(this.windows(), i, p)); }
}
