/**
 * Pure redaction of the patient's own direct identifiers inside free text
 * (SOAP notes, complaints, instructions, questions) before anything is sent to
 * an AI or embedding provider. Structured fields are already de-identified by
 * construction (see ai.context.ts / embeddings.util.ts); this covers what a
 * clinician typed into the note itself, e.g. "Zelda called from 0501234567".
 * No I/O here so it is unit-testable.
 */

export interface PatientIdentifiers {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  mrn?: string | null;
  /** Decrypted national id (never persisted by this module). */
  nationalId?: string | null;
}

export const REDACTED = {
  patient: '[PATIENT]',
  phone: '[PHONE]',
  email: '[EMAIL]',
  mrn: '[MRN]',
  nationalId: '[NATIONAL_ID]',
} as const;

/** Name tokens shorter than this are not redacted on their own (e.g. "Al", "Bo") to avoid shredding the note. */
const MIN_NAME_TOKEN = 3;
/** Phone numbers with fewer significant digits than this are ignored (too ambiguous). */
const MIN_PHONE_DIGITS = 6;
/** Significant (subscriber) digits matched for a phone: Saudi mobiles have 9 after the 0 / +966 prefix. */
const PHONE_CORE_DIGITS = 9;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Not preceded / followed by a letter or digit (Unicode-aware, so Arabic names work too). */
const wordBounded = (pattern: string) => `(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`;
/** Literal match that tolerates any run of whitespace where the source has whitespace. */
const flexibleSpaces = (s: string) => s.trim().split(/\s+/).map(escapeRegex).join('\\s+');

type Rule = { re: RegExp; placeholder: string };

/** Ordered replacement rules for one patient (longest / most specific first). */
export function buildRedactionRules(ids: PatientIdentifiers): Rule[] {
  const rules: Rule[] = [];
  const email = ids.email?.trim();
  if (email) rules.push({ re: new RegExp(escapeRegex(email), 'giu'), placeholder: REDACTED.email });

  const nationalId = ids.nationalId?.trim();
  if (nationalId && nationalId.length >= 4) {
    // Digits may be typed with spaces or dashes in between.
    const chars = [...nationalId.replace(/[\s-]/g, '')].map(escapeRegex).join('[\\s-]?');
    rules.push({ re: new RegExp(wordBounded(chars), 'giu'), placeholder: REDACTED.nationalId });
  }

  const mrn = ids.mrn?.trim();
  if (mrn) {
    const m = mrn.match(/^([A-Za-z]+)[\s-]?(\d+)$/);
    // "MRN-000042" also matches "MRN 000042" / "mrn000042"; the bare number is too ambiguous on its own.
    const pattern = m ? `${escapeRegex(m[1])}[\\s-]?${m[2]}` : escapeRegex(mrn);
    rules.push({ re: new RegExp(wordBounded(pattern), 'giu'), placeholder: REDACTED.mrn });
  }

  const phone = phonePattern(ids.phone);
  if (phone) rules.push({ re: phone, placeholder: REDACTED.phone });

  const first = ids.firstName?.trim() ?? '';
  const last = ids.lastName?.trim() ?? '';
  const names = new Set<string>([first, last, `${first} ${last}`.trim()]);
  for (const part of `${first} ${last}`.split(/\s+/)) if ([...part].length >= MIN_NAME_TOKEN) names.add(part);
  // Longest first so "Zelda Quartermain" becomes one placeholder, not two.
  for (const name of [...names].filter((n) => [...n].length >= 2).sort((a, b) => b.length - a.length)) {
    rules.push({ re: new RegExp(wordBounded(flexibleSpaces(name)), 'giu'), placeholder: REDACTED.patient });
  }
  return rules;
}

/**
 * Regex matching the phone in its stored form and the usual variants: digits
 * only, with separators, and with a national (`05…`) or international
 * (`+966…`, `00966…`, `966…`) prefix. Matches on the last 9 significant digits
 * plus an optional prefix, bounded by non-digits.
 */
export function phonePattern(phone: string | null | undefined): RegExp | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;
  const core = digits.length > PHONE_CORE_DIGITS ? digits.slice(-PHONE_CORE_DIGITS) : digits.replace(/^0+/, '');
  if (core.length < MIN_PHONE_DIGITS) return null;
  const sep = '[\\s\\-.()]?';
  const body = [...core].join(sep);
  // Optional country / trunk prefix ("+966 ", "00966", "0", "+1 5") in front of the significant digits.
  const prefix = `(?:\\+?\\d{1,5}${sep})?(?:\\d{1,3}${sep})?`;
  return new RegExp(`(?<![\\d+])${prefix}${body}(?!\\d)`, 'g');
}

/** Replaces the patient's identifiers in `text`. Null/empty input is returned unchanged. */
export function redactText<T extends string | null | undefined>(text: T, rules: readonly Rule[]): T {
  if (!text) return text;
  let out: string = text;
  for (const { re, placeholder } of rules) out = out.replace(re, placeholder);
  return out as T;
}

/** Convenience: builds the rules and redacts one string. */
export function redactIdentifiers<T extends string | null | undefined>(text: T, ids: PatientIdentifiers): T {
  return redactText(text, buildRedactionRules(ids));
}

/** A reusable redactor bound to one patient (rules are compiled once). */
export function createRedactor(ids: PatientIdentifiers | null | undefined): <T extends string | null | undefined>(text: T) => T {
  const rules = ids ? buildRedactionRules(ids) : [];
  return <T extends string | null | undefined>(text: T) => redactText(text, rules);
}
