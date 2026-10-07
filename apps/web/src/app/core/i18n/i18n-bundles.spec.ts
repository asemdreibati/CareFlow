import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Bundle parity for the clinic app bundles (public/i18n/{en,ar}.json). The portal
 * bundles have their own spec. Files are read from disk so the JSON stays the
 * single source of truth.
 */
type Tree = { [k: string]: string | Tree };
const ROOT = process.cwd();
const read = (name: string): Tree => JSON.parse(readFileSync(join(ROOT, 'public/i18n', name), 'utf8')) as Tree;

function flatten(obj: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') Object.assign(out, flatten(v, `${prefix}${k}.`));
    else out[`${prefix}${k}`] = v as string;
  }
  return out;
}
const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();

/** Recursively lists .ts/.html files under src/app/{layout,pages,shared,core}, excluding specs. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (!entry.includes('.')) walk(p);
      else if ((entry.endsWith('.ts') || entry.endsWith('.html')) && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const area of ['layout', 'pages', 'shared', 'core']) walk(join(ROOT, 'src/app', area));
  return out;
}

describe('i18n bundles (en/ar)', () => {
  const en = read('en.json');
  const ar = read('ar.json');
  const enFlat = flatten(en);
  const arFlat = flatten(ar);
  const enKeys = Object.keys(enFlat).sort();
  const arKeys = Object.keys(arFlat).sort();

  it('have identical key sets', () => {
    expect(arKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !arKeys.includes(k))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(700);
  });

  it('have no empty values and matching {{placeholders}}', () => {
    for (const key of enKeys) {
      expect(typeof enFlat[key], key).toBe('string');
      expect(enFlat[key].trim().length, key).toBeGreaterThan(0);
      expect(arFlat[key].trim().length, key).toBeGreaterThan(0);
      expect(placeholders(arFlat[key]), key).toEqual(placeholders(enFlat[key]));
    }
  });

  it('do not collide with the portal bundle root key', () => {
    expect(Object.keys(en)).not.toContain('portal');
    expect(Object.keys(ar)).not.toContain('portal');
  });

  it('define every key referenced in the source tree', () => {
    const groups = new Set(Object.keys(en));
    const referenced = new Set<string>();
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8');
      // Any quoted dotted identifier whose first segment is a bundle group: 'patients.title', 'enums.status.PAID', …
      for (const m of src.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)'/g)) {
        if (groups.has(m[1].split('.')[0])) referenced.add(m[1]);
      }
    }
    expect(referenced.size).toBeGreaterThan(500);
    const missing = [...referenced].filter((k) => !(k in enFlat)).sort();
    expect(missing).toEqual([]);
  });

  it('cover the dynamic enum / action / unit keys used by components', () => {
    const expectKeys = (keys: string[]) => expect(keys.filter((k) => !(k in enFlat))).toEqual([]);
    expectKeys(['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'].map((s) => `appointments.actions.${s}`));
    expectKeys(['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'SIGNED', 'AMENDED',
      'ACTIVE', 'INACTIVE', 'DISCONTINUED', 'GENERATED', 'APPROVED', 'REJECTED', 'FAILED', 'WAITING', 'OFFERED', 'BOOKED', 'EXPIRED', 'PENDING', 'APPLIED', 'PARTIALLY_APPLIED', 'DISMISSED', 'SENT'].map((s) => `enums.status.${s}`));
    expectKeys(['OWNER', 'ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST', 'ACCOUNTANT'].map((s) => `enums.role.${s}`));
    expectKeys(['CONSULTATION', 'FOLLOW_UP', 'PROCEDURE', 'CHECKUP', 'EMERGENCY'].map((s) => `enums.type.${s}`));
    expectKeys(['ROUTINE', 'SOON', 'URGENT'].map((s) => `enums.priority.${s}`));
    expectKeys(['IN_APP', 'EMAIL', 'SMS'].map((s) => `enums.channel.${s}`));
    expectKeys(['ROOM', 'EQUIPMENT', 'STAFF', 'OTHER'].map((s) => `enums.resourceType.${s}`));
    expectKeys(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING'].map((s) => `enums.severity.${s}`));
    expectKeys(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'].map((s) => `enums.gender.${s}`));
    expectKeys(['CASH', 'CARD', 'BANK_TRANSFER', 'INSURANCE', 'OTHER'].map((s) => `enums.paymentMethod.${s}`));
    expectKeys(['DAILY', 'WEEKLY', 'MONTHLY'].flatMap((s) => [`enums.frequency.${s}`, `series.units.${s}`]));
    expectKeys(['none', 'low', 'medium', 'high'].map((s) => `enums.risk.${s}`));
    expectKeys(['next-slot', 'skip', 'fail'].map((s) => `series.conflicts.${s}`));
    expectKeys(['invalidWeekday', 'timeFormat', 'endAfterStart'].map((s) => `errors.windows.${s}`));
    expectKeys(['required', 'email', 'minlength', 'maxlength', 'pattern', 'min', 'max', 'password', 'invalid'].map((s) => `validation.${s}`));
    expectKeys(['d', 'h', 'm', 's', 'min', 'minutes', 'days'].map((s) => `common.units.${s}`));
    expectKeys(['subjective', 'objective', 'assessment', 'plan'].map((s) => `encounters.soap.${s}`));
  });
});
