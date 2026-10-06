import { describe, expect, it } from 'vitest';
import ar from '../../../public/i18n/portal.ar.json';
import en from '../../../public/i18n/portal.en.json';

type Tree = { [k: string]: string | Tree };

function flatten(obj: Tree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? flatten(v as Tree, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
const placeholders = (s: string) => (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).map((p) => p.replace(/\s/g, '')).sort();
const lookup = (obj: Tree, path: string): string => path.split('.').reduce<unknown>((o, k) => (o as Tree)?.[k], obj) as string;

describe('portal i18n bundles', () => {
  const enKeys = flatten(en as Tree).sort();
  const arKeys = flatten(ar as Tree).sort();

  it('are rooted under the portal.* key group', () => {
    expect(Object.keys(en)).toEqual(['portal']);
    expect(Object.keys(ar)).toEqual(['portal']);
  });
  it('have identical key sets', () => {
    expect(arKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !arKeys.includes(k))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(150);
  });
  it('have no empty strings and matching {{placeholders}}', () => {
    for (const key of enKeys) {
      const e = lookup(en as Tree, key);
      const a = lookup(ar as Tree, key);
      expect(typeof e, key).toBe('string');
      expect(e.trim().length, key).toBeGreaterThan(0);
      expect(a.trim().length, key).toBeGreaterThan(0);
      expect(placeholders(a), key).toEqual(placeholders(e));
    }
  });
});
