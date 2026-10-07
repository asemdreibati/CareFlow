import { HttpParams } from '@angular/common/http';

export const BASE = '/api/v1';

/** Build HttpParams skipping undefined/null/empty values. */
export function params(obj: object | undefined): HttpParams {
  let p = new HttpParams();
  if (!obj) return p;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    p = p.set(k, String(v));
  }
  return p;
}

/** Remove empty strings / undefined so optional DTO fields are omitted (API rejects unknown/empty values). */
export function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * For PATCH bodies: the optional `keys` the user cleared — empty now but set in `original` — mapped to
 * `null` so the API clears them (`clean()` would silently omit them and the old value would stay).
 * Fields that were already empty stay omitted. Merge over `clean(...)`: `{ ...clean(v), ...clearedToNull(v, orig, keys) }`.
 */
export function clearedToNull<K extends string>(
  values: Partial<Record<K, unknown>>,
  original: Partial<Record<K, unknown>> | null | undefined,
  keys: readonly K[],
): Partial<Record<K, null>> {
  const out: Partial<Record<K, null>> = {};
  if (!original) return out;
  for (const k of keys) if (isEmpty(values[k]) && !isEmpty(original[k])) out[k] = null;
  return out;
}
