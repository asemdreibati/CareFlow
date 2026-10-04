import { Component, input } from '@angular/core';
import { AbstractControl } from '@angular/forms';

const MESSAGES: Record<string, (e: unknown) => string> = {
  required: () => 'This field is required',
  email: () => 'Enter a valid email address',
  minlength: (e) => `Must be at least ${(e as { requiredLength: number }).requiredLength} characters`,
  maxlength: (e) => `Must be at most ${(e as { requiredLength: number }).requiredLength} characters`,
  pattern: () => 'Invalid format',
  min: (e) => `Must be at least ${(e as { min: number }).min}`,
  max: (e) => `Must be at most ${(e as { max: number }).max}`,
  password: () => 'Min 10 characters with an uppercase letter and a digit',
};

@Component({
  selector: 'cf-field-error',
  template: `@if (read(); as m) { <div class="field-error">{{ m }}</div> }`,
})
export class FieldErrorComponent {
  readonly control = input.required<AbstractControl | null>();
  /** Called from the template on each change detection pass; reactive form errors aren't signals. */
  read(): string | null {
    const c = this.control();
    if (!c || !c.errors || !(c.touched || c.dirty)) return null;
    const [key, val] = Object.entries(c.errors)[0];
    return MESSAGES[key]?.(val) ?? 'Invalid value';
  }
}
