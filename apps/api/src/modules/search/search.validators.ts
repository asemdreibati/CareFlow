import { ValidateBy, type ValidationOptions } from 'class-validator';

/**
 * Rejects strings containing a NUL character (U+0000). PostgreSQL text cannot
 * hold it, so it would otherwise surface as a 500 from the driver.
 */
export function NoNulChars(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'noNulChars',
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || !value.includes('\u0000'),
        defaultMessage: (args) => `${args?.property ?? 'value'} must not contain NUL characters`,
      },
    },
    options,
  );
}

/** Minimum length AFTER trimming, so a whitespace-only query does not match everything. */
export function MinTrimmedLength(min: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'minTrimmedLength',
      constraints: [min],
      validator: {
        validate: (value: unknown) => typeof value === 'string' && value.trim().length >= min,
        defaultMessage: (args) => `${args?.property ?? 'value'} must contain at least ${min} non-blank character${min === 1 ? '' : 's'}`,
      },
    },
    options,
  );
}
