import { AbstractControl, ValidationErrors } from '@angular/forms';

/** Mirrors the API password rule: 10–128 chars, one uppercase letter, one digit. */
export function passwordValidator(c: AbstractControl): ValidationErrors | null {
  const v = String(c.value ?? '');
  if (!v) return null;
  return v.length >= 10 && v.length <= 128 && /[A-Z]/.test(v) && /[0-9]/.test(v) ? null : { password: true };
}
