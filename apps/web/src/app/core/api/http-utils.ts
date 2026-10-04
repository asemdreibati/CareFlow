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
