import { Component, inject, input } from '@angular/core';
import { AbstractControl } from '@angular/forms';
import { LanguageService } from '../core/i18n/language.service';

/** Validation error → `validation.<key>` with the validator's parameter (requiredLength, min, max). */
const PARAMS: Record<string, (e: unknown) => Record<string, unknown>> = {
  minlength: (e) => ({ n: (e as { requiredLength: number }).requiredLength }),
  maxlength: (e) => ({ n: (e as { requiredLength: number }).requiredLength }),
  min: (e) => ({ n: (e as { min: number }).min }),
  max: (e) => ({ n: (e as { max: number }).max }),
};
const KNOWN = ['required', 'email', 'minlength', 'maxlength', 'pattern', 'min', 'max', 'password'];

@Component({
  selector: 'cf-field-error',
  template: `@if (read(); as m) { <div class="field-error">{{ m }}</div> }`,
})
export class FieldErrorComponent {
  private readonly lang = inject(LanguageService);
  readonly control = input.required<AbstractControl | null>();
  /** Called from the template on each change detection pass; reactive form errors aren't signals. */
  read(): string | null {
    const c = this.control();
    if (!c || !c.errors || !(c.touched || c.dirty)) return null;
    const [key, val] = Object.entries(c.errors)[0];
    return KNOWN.includes(key) ? this.lang.t(`validation.${key}`, PARAMS[key]?.(val)) : this.lang.t('validation.invalid');
  }
}
