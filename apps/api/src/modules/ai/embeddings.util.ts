/**
 * Pure helpers for encounter embeddings: pgvector literal (de)serialisation and
 * the de-identified text that gets embedded. No I/O so everything is unit-testable.
 */
import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from './embedding-provider.js';
import { createRedactor, type PatientIdentifiers } from './redaction.js';

// ────────────────────────────── pgvector literals ──────────────────────────────

/** Serialises a vector as the pgvector text literal `[0.1,0.2,...]` (cast with `::vector` in SQL). */
export function toVectorLiteral(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new RangeError(`Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${values.length}`);
  }
  const parts = values.map((v, i) => {
    if (!Number.isFinite(v)) throw new RangeError(`Vector component ${i} is not a finite number`);
    return String(v);
  });
  return `[${parts.join(',')}]`;
}

/** Parses a pgvector text literal (`[0.1,0.2]`) back into numbers. Tolerates whitespace. */
export function parseVectorLiteral(literal: string): number[] {
  const s = literal.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) throw new SyntaxError('Not a vector literal');
  const body = s.slice(1, -1).trim();
  if (body === '') return [];
  return body.split(',').map((part, i) => {
    const n = Number(part.trim());
    if (part.trim() === '' || !Number.isFinite(n)) throw new SyntaxError(`Invalid vector component at index ${i}`);
    return n;
  });
}

/** Scales a vector to unit length so cosine and inner-product distances agree. Zero vectors are returned as-is. */
export function normalizeVector(values: readonly number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return [...values];
  return values.map((v) => v / norm);
}

// ───────────────────────── de-identified encounter text ─────────────────────────

/**
 * The ONLY fields that may be embedded. The type is deliberately narrow so a
 * caller cannot pass names, contacts, MRNs or free-text patient notes by accident;
 * extra properties on the object are ignored by construction.
 */
export interface EncounterEmbeddingInput {
  occurredAt: Date | string;
  chiefComplaint?: string | null;
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
  diagnoses?: { code: string; description: string; isPrimary?: boolean | null }[];
}

const isoDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const clean = (v: string | null | undefined): string | null => {
  const t = v?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

/**
 * Builds the text that is sent to the embedding provider: visit date, chief
 * complaint, SOAP fields and diagnoses. Nothing else - the patient is never named:
 * when `identifiers` are given, the patient's own name, phone, e-mail, MRN and
 * national id typed into the free text are replaced by placeholders.
 */
export function buildEncounterEmbeddingText(input: EncounterEmbeddingInput, identifiers?: PatientIdentifiers | null): string {
  const redact = createRedactor(identifiers);
  const lines: string[] = [`Visit date: ${isoDate(input.occurredAt)}`];
  const fields: [string, string | null | undefined][] = [
    ['Chief complaint', input.chiefComplaint],
    ['Subjective', input.subjective],
    ['Objective', input.objective],
    ['Assessment', input.assessment],
    ['Plan', input.plan],
  ];
  for (const [label, value] of fields) {
    const v = redact(clean(value));
    if (v) lines.push(`${label}: ${v}`);
  }
  const dx = (input.diagnoses ?? []).map((d) => `${d.code} ${redact(d.description)}${d.isPrimary ? ' (primary)' : ''}`);
  if (dx.length > 0) lines.push(`Diagnoses: ${dx.join('; ')}`);
  return lines.join('\n');
}

/** sha256 of the embedded text, stored in `encounter_embeddings.content_hash` to skip unchanged encounters. */
export function hashEmbeddingText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Splits an array into consecutive chunks of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
