import { Component, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService, SUPPORTED_LOCALES } from '../core/i18n/language.service';

/** AR / EN segmented switch. Applies immediately (no reload) and persists via LanguageService. */
@Component({
  selector: 'cf-language-switcher',
  imports: [TranslatePipe],
  template: `
    <div class="ls" role="group" [class.light]="light()" [attr.aria-label]="'app.language' | translate">
      @for (l of locales; track l) {
        <button type="button" [class.on]="lang.locale() === l" (click)="lang.set(l)" [attr.aria-pressed]="lang.locale() === l" [lang]="l">{{ labels[l] }}</button>
      }
    </div>
  `,
  styles: [`
    .ls { display: inline-flex; border: 1px solid var(--cf-border-strong); border-radius: 999px; overflow: hidden; background: var(--cf-surface); }
    .ls button { border: none; background: transparent; padding: 0 10px; height: 28px; font: inherit; font-size: 12px; font-weight: 600; color: var(--cf-text-2); cursor: pointer; letter-spacing: 0.02em; }
    .ls button.on { background: var(--cf-primary); color: #fff; }
    .ls.light { border-color: rgba(255,255,255,0.35); background: rgba(255,255,255,0.08); }
    .ls.light button { color: #e2e8f0; }
    .ls.light button.on { background: #fff; color: var(--cf-primary); }
  `],
})
export class LanguageSwitcherComponent {
  readonly lang = inject(LanguageService);
  /** Light variant for dark backgrounds (auth side panel). */
  readonly light = input(false);
  readonly locales = SUPPORTED_LOCALES;
  readonly labels: Record<string, string> = { ar: 'عربي', en: 'EN' };
}
