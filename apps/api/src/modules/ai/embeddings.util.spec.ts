import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from './embedding-provider.js';
import {
  buildEncounterEmbeddingText,
  chunk,
  hashEmbeddingText,
  normalizeVector,
  parseVectorLiteral,
  toVectorLiteral,
} from './embeddings.util.js';

const vec = (fill: (i: number) => number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => fill(i));

describe('toVectorLiteral / parseVectorLiteral', () => {
  it('round-trips a 768-dimensional vector', () => {
    const v = vec((i) => (i % 7) * 0.125 - 0.5);
    const literal = toVectorLiteral(v);
    expect(literal.startsWith('[')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
    expect(literal).not.toContain(' ');
    expect(parseVectorLiteral(literal)).toEqual(v);
  });

  it('rejects the wrong width and non-finite components', () => {
    expect(() => toVectorLiteral([0.1, 0.2])).toThrow(RangeError);
    const bad = vec(() => 0.1);
    bad[10] = Number.NaN;
    expect(() => toVectorLiteral(bad)).toThrow(RangeError);
  });

  it('parses whitespace-tolerant literals and rejects malformed ones', () => {
    expect(parseVectorLiteral(' [ 1, -2.5 ,3e-2 ] ')).toEqual([1, -2.5, 0.03]);
    expect(parseVectorLiteral('[]')).toEqual([]);
    expect(() => parseVectorLiteral('1,2,3')).toThrow(SyntaxError);
    expect(() => parseVectorLiteral('[1,,2]')).toThrow(SyntaxError);
    expect(() => parseVectorLiteral('[1,abc]')).toThrow(SyntaxError);
  });
});

describe('normalizeVector', () => {
  it('scales to unit length and leaves zero vectors alone', () => {
    const n = normalizeVector([3, 4]);
    expect(n[0]).toBeCloseTo(0.6);
    expect(n[1]).toBeCloseTo(0.8);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});

describe('buildEncounterEmbeddingText', () => {
  it('contains the clinical fields, the date and diagnoses only', () => {
    const text = buildEncounterEmbeddingText({
      occurredAt: new Date('2026-03-04T09:30:00Z'),
      chiefComplaint: 'صداع  منذ يومين',
      subjective: 'Headache for two days, worse in the morning.',
      objective: 'BP 128/82',
      assessment: null,
      plan: '  ',
      diagnoses: [
        { code: 'R51', description: 'Headache', isPrimary: true },
        { code: 'G44.2', description: 'Tension-type headache' },
      ],
    });
    expect(text).toBe(
      [
        'Visit date: 2026-03-04',
        'Chief complaint: صداع منذ يومين',
        'Subjective: Headache for two days, worse in the morning.',
        'Objective: BP 128/82',
        'Diagnoses: R51 Headache (primary); G44.2 Tension-type headache',
      ].join('\n'),
    );
  });

  it('never copies identifiers even when the source row carries them', () => {
    const row = {
      occurredAt: '2026-01-01T00:00:00Z',
      chiefComplaint: 'Cough',
      patient: { firstName: 'Sami', lastName: 'Haddad', phone: '0501234567', email: 'sami@example.com', mrn: 'MRN-0001' },
      doctor: { firstName: 'Greg', lastName: 'House' },
      notes: 'Lives at 12 Hidden Lane',
      vitals: { bp: '120/80' },
    };
    const text = buildEncounterEmbeddingText(row);
    expect(text).toBe('Visit date: 2026-01-01\nChief complaint: Cough');
    for (const leak of ['Sami', 'Haddad', '0501234567', 'sami@example.com', 'MRN-0001', 'House', 'Hidden Lane', '120/80']) {
      expect(text).not.toContain(leak);
    }
  });

  it('hashes deterministically', () => {
    expect(hashEmbeddingText('abc')).toBe(hashEmbeddingText('abc'));
    expect(hashEmbeddingText('abc')).not.toBe(hashEmbeddingText('abd'));
    expect(hashEmbeddingText('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('chunk', () => {
  it('splits into consecutive batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
