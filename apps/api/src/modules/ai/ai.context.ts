/**
 * Pure helpers for the AI module: de-identified context building, hashing and
 * tolerant JSON parsing. No I/O here so everything is unit-testable.
 */
import { createHash } from 'node:crypto';

// ───────────────────────────── Patient context ─────────────────────────────

export interface PatientContextInput {
  patient: { dateOfBirth?: Date | string | null; gender?: string | null; bloodType?: string | null };
  allergies?: { substance: string; reaction?: string | null; severity?: string | null }[];
  prescriptions?: {
    medication: string;
    dosage?: string | null;
    frequency?: string | null;
    durationDays?: number | null;
    instructions?: string | null;
  }[];
  encounters?: {
    occurredAt: Date | string;
    chiefComplaint?: string | null;
    assessment?: string | null;
    plan?: string | null;
    diagnoses?: { code: string; description: string; isPrimary?: boolean }[];
  }[];
  upcomingAppointment?: { startsAt: Date | string; reason?: string | null; type?: string | null } | null;
  /** Reference date for age computation (defaults to now). */
  now?: Date;
}

export interface PatientContext {
  ageYears: number | null;
  gender: string;
  bloodType: string | null;
  allergies: { substance: string; reaction: string | null; severity: string }[];
  medications: { medication: string; dosage: string | null; frequency: string | null; durationDays: number | null; instructions: string | null }[];
  recentVisits: {
    date: string;
    chiefComplaint: string | null;
    assessment: string | null;
    plan: string | null;
    diagnoses: { code: string; description: string; isPrimary: boolean }[];
  }[];
  upcomingVisit: { date: string; reason: string | null; type: string | null } | null;
}

export function computeAgeYears(dateOfBirth: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime()) || dob > now) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

const isoDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * Picks ONLY the clinical fields allowed to leave the system. Direct identifiers
 * (name, MRN, phone, email, address, national id, emergency contact, free-text
 * notes) are never copied, whatever the input object carries.
 */
export function buildPatientContext(input: PatientContextInput): PatientContext {
  const now = input.now ?? new Date();
  return {
    ageYears: computeAgeYears(input.patient.dateOfBirth, now),
    gender: (input.patient.gender ?? 'UNKNOWN').toString(),
    bloodType: clean(input.patient.bloodType),
    allergies: (input.allergies ?? []).map((a) => ({
      substance: a.substance,
      reaction: clean(a.reaction),
      severity: a.severity ?? 'MODERATE',
    })),
    medications: (input.prescriptions ?? []).map((p) => ({
      medication: p.medication,
      dosage: clean(p.dosage),
      frequency: clean(p.frequency),
      durationDays: p.durationDays ?? null,
      instructions: clean(p.instructions),
    })),
    recentVisits: (input.encounters ?? []).map((e) => ({
      date: isoDate(e.occurredAt),
      chiefComplaint: clean(e.chiefComplaint),
      assessment: clean(e.assessment),
      plan: clean(e.plan),
      diagnoses: (e.diagnoses ?? []).map((d) => ({ code: d.code, description: d.description, isPrimary: d.isPrimary ?? false })),
    })),
    upcomingVisit: input.upcomingAppointment
      ? { date: isoDate(input.upcomingAppointment.startsAt), reason: clean(input.upcomingAppointment.reason), type: input.upcomingAppointment.type ?? null }
      : null,
  };
}

const SEVERE = new Set(['SEVERE', 'LIFE_THREATENING']);

/** Serialises the context as plain text for the prompt. Refers to "the patient" only. */
export function renderPatientContext(ctx: PatientContext): string {
  const lines: string[] = [];
  lines.push('# Patient data (de-identified)');
  lines.push('');
  lines.push('## Demographics');
  lines.push(`- Age: ${ctx.ageYears === null ? 'unknown' : `${ctx.ageYears} years`}`);
  lines.push(`- Gender: ${ctx.gender.toLowerCase()}`);
  lines.push(`- Blood type: ${ctx.bloodType ?? 'not recorded'}`);
  lines.push('');

  lines.push('## Allergies');
  if (ctx.allergies.length === 0) lines.push('- No allergies recorded');
  for (const a of ctx.allergies) {
    const flag = SEVERE.has(a.severity) ? ' [SEVERE]' : '';
    lines.push(`- ${a.substance} (severity: ${a.severity.toLowerCase()}${a.reaction ? `, reaction: ${a.reaction}` : ''})${flag}`);
  }
  lines.push('');

  lines.push('## Active medications');
  if (ctx.medications.length === 0) lines.push('- No active prescriptions recorded');
  for (const m of ctx.medications) {
    const parts = [m.dosage, m.frequency, m.durationDays ? `${m.durationDays} days` : null, m.instructions].filter(Boolean);
    lines.push(`- ${m.medication}${parts.length ? ` - ${parts.join(', ')}` : ''}`);
  }
  lines.push('');

  lines.push('## Recent visits (most recent first)');
  if (ctx.recentVisits.length === 0) lines.push('- No previous visits recorded');
  for (const v of ctx.recentVisits) {
    lines.push(`### Visit on ${v.date}`);
    lines.push(`- Chief complaint: ${v.chiefComplaint ?? 'not recorded'}`);
    lines.push(`- Assessment: ${v.assessment ?? 'not recorded'}`);
    lines.push(`- Plan: ${v.plan ?? 'not recorded'}`);
    if (v.diagnoses.length === 0) lines.push('- Diagnoses: none recorded');
    else lines.push(`- Diagnoses: ${v.diagnoses.map((d) => `${d.code} ${d.description}${d.isPrimary ? ' (primary)' : ''}`).join('; ')}`);
  }
  lines.push('');

  lines.push('## Upcoming appointment');
  if (!ctx.upcomingVisit) lines.push('- No upcoming appointment');
  else {
    lines.push(`- Date: ${ctx.upcomingVisit.date}`);
    lines.push(`- Type: ${ctx.upcomingVisit.type ?? 'not specified'}`);
    lines.push(`- Reason: ${ctx.upcomingVisit.reason ?? 'not specified'}`);
  }
  return lines.join('\n');
}

export function hashContext(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ──────────────────────────────── SOAP output ────────────────────────────────

export interface SoapNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export const SOAP_FIELDS = ['subjective', 'objective', 'assessment', 'plan'] as const;

/** JSON schema shared by both providers (strict: no extra keys, all four present). */
export const SOAP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subjective: { type: 'string', description: "What the patient reports: symptoms, history, concerns. Empty string if the transcript has none." },
    objective: { type: 'string', description: 'Observable findings stated by the clinician: vitals, exam findings, results. Empty string if none.' },
    assessment: { type: 'string', description: "The clinician's stated impression or diagnosis. Empty string if none." },
    plan: { type: 'string', description: 'The clinician\'s stated plan: tests, treatments, follow-up. Empty string if none.' },
  },
  required: ['subjective', 'objective', 'assessment', 'plan'],
  additionalProperties: false,
};

/** Coerces arbitrary model output into a SoapNote: missing/non-string fields become ''. */
export function normalizeSoap(data: unknown): SoapNote {
  const src = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const out = {} as SoapNote;
  for (const field of SOAP_FIELDS) {
    const v = src[field];
    out[field] = typeof v === 'string' ? v.trim() : '';
  }
  return out;
}

// ──────────────────────────────── JSON parsing ───────────────────────────────

/**
 * Pulls the JSON object out of a model reply that may be wrapped in code fences
 * or surrounded by prose. Returns the raw JSON text (not parsed).
 */
export function extractJson(text: string): string {
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith('{') && s.endsWith('}')) return s;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new SyntaxError('No JSON object found in model output');
  return s.slice(start, end + 1);
}

/** Parses a model reply into an object; throws SyntaxError when it is not a JSON object. */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T {
  const parsed: unknown = JSON.parse(extractJson(text));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('Model output is not a JSON object');
  return parsed as T;
}
