import { registerDecorator, type ValidationOptions } from 'class-validator';

/** True when the runtime recognises `value` as an IANA time zone (e.g. "Asia/Riyadh"). */
export function isTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Rejects unknown time zones; an invalid clinic time zone would break every scheduling call. */
export function IsTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isTimeZone',
      target: target.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} must be a valid IANA time zone, e.g. Asia/Riyadh`, ...options },
      validator: { validate: (value: unknown) => isTimeZone(value) },
    });
}
