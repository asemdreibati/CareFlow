/**
 * Shared SQL fragments for Arabic/Latin-aware search. Every fragment takes the
 * user's query as a bound parameter and normalises it IN SQL with
 * `careflow_normalize()`, the same function that maintains the indexed columns,
 * so diacritics, alef/taa-marbuta variants, accents and case fold identically
 * on both sides. Never concatenate user input into these strings.
 */
import { Prisma } from '@prisma/client';

/** Minimum `word_similarity` for a fuzzy patient match ("mohamed" ~ "mohammed"). */
export const PATIENT_SIMILARITY_THRESHOLD = 0.45;

/** `careflow_normalize($q)` as a bound parameter. */
export function normalized(q: string): Prisma.Sql {
  return Prisma.sql`careflow_normalize(${q})`;
}

/**
 * `'%' || <normalised q with LIKE metacharacters escaped> || '%'` for use with
 * ILIKE (default escape character `\`). Escaping happens in SQL after normalisation
 * so the pattern always derives from the folded text.
 */
export function containsPattern(q: string): Prisma.Sql {
  return Prisma.sql`('%' || replace(replace(replace(careflow_normalize(${q}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`;
}

/** Trigram patient predicate on `patients.search_text` (aliased as `p`). */
export function patientMatch(q: string): Prisma.Sql {
  return Prisma.sql`(p.search_text ILIKE ${containsPattern(q)} OR word_similarity(${normalized(q)}, p.search_text) >= ${PATIENT_SIMILARITY_THRESHOLD})`;
}

/** Similarity score of the query against the patient's search text (higher is better). */
export function patientScore(q: string): Prisma.Sql {
  return Prisma.sql`word_similarity(${normalized(q)}, p.search_text)::float8`;
}

/** Full-text query over the SOAP fields ('simple' dictionary: no stemming, Arabic tokens kept as-is). */
export function encounterTsQuery(q: string): Prisma.Sql {
  return Prisma.sql`websearch_to_tsquery('simple', ${normalized(q)})`;
}

/** Normalised SOAP text used for highlighting, so the query tokens match the way they were indexed. */
export const ENCOUNTER_HEADLINE_SOURCE = Prisma.sql`careflow_normalize(concat_ws(' ', e.chief_complaint, e.assessment, e.subjective, e.objective, e.plan))`;

export const HEADLINE_OPTIONS = 'MaxFragments=2, MaxWords=18, MinWords=6';

/** `'%' || lower(q) || '%'` with LIKE metacharacters escaped, for code/number lookups (`lower(col) LIKE ...`). */
export function lowerContainsPattern(q: string): Prisma.Sql {
  return Prisma.sql`('%' || replace(replace(replace(lower(${q}), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`;
}
