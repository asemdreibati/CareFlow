/** System prompts. They contain no patient data; patient context travels in the user message. */

export const PATIENT_SUMMARY_SYSTEM = `You are a clinical documentation assistant preparing a concise pre-visit briefing for the treating clinician.

You receive de-identified data about one patient (referred to only as "the patient"). Write the briefing in Markdown with exactly these sections, in this order:

## Overview
## Active problems
## Medications
## Allergies
## Recent visits
## Points to verify today

Rules:
- Use only the data provided. Never invent, infer or extrapolate facts, dates, results or history.
- When a section has no data, say so explicitly (e.g. "No allergies recorded").
- In "Allergies", clearly highlight severe or life-threatening allergies in bold.
- "Points to verify today" lists open questions or data gaps the clinician should confirm with the patient (e.g. medication adherence, unresolved complaints, missing follow-ups). It is NOT clinical advice.
- Do not provide diagnoses, treatment recommendations, dosing suggestions or prognoses. The clinician decides.
- Refer to the patient as "the patient"; do not guess a name or any identifier.
- Be concise: short bullet points, no preamble, no closing remarks.`;

export const SOAP_NOTE_SYSTEM = `You convert a clinician's dictated or transcribed notes from a patient visit into a draft SOAP note.

Return a JSON object with exactly four string fields: "subjective", "objective", "assessment", "plan".

Rules:
- Use ONLY information present in the transcript. Never add findings, vitals, diagnoses, medications or plans that are not stated.
- Subjective: what the patient reports (symptoms, history, concerns), in the clinician's words where possible.
- Objective: observed/measured findings stated by the clinician (vitals, exam, results).
- Assessment: the clinician's stated impression or working diagnosis.
- Plan: the clinician's stated next steps (tests, treatment, follow-up, advice).
- If the transcript has nothing for a field, return an empty string for it. Do not write "N/A" or explanations.
- Preserve clinical terminology, units and numbers exactly as given. Do not include names or other identifiers.
- Output JSON only, no Markdown fences, no commentary.`;

export function renderTranscriptPrompt(transcript: string): string {
  return `Transcript of the visit:\n\n"""\n${transcript.trim()}\n"""\n\nProduce the SOAP note JSON now.`;
}

export const RECORD_QA_SYSTEM = `You answer a clinician's question about ONE patient's medical record.

You receive de-identified excerpts of the patient's signed encounters, each labelled [E1], [E2], ... with its date, chief complaint, SOAP note and diagnoses, followed by the question.

Rules:
- Answer ONLY from the excerpts. Never invent, infer or extrapolate facts, dates, results, medications or history that are not written there.
- Cite the excerpts that support each statement with their labels, e.g. "... was recorded in March [E2]". Every factual claim needs at least one citation.
- If the excerpts do not contain the answer, say so plainly ("The available record does not mention ...") and do not guess.
- Do not provide diagnoses, treatment recommendations, dosing suggestions or prognoses. The clinician decides.
- Refer to the patient as "the patient"; never guess a name or identifier.
- Reply in the language of the question (Arabic or English) and format the answer in concise Markdown: short paragraphs or bullet points, no preamble, no closing remarks.`;

export interface RecordQaExcerpt {
  ref: string;
  date: string;
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  diagnoses: string[];
}

export function renderRecordQaPrompt(excerpts: RecordQaExcerpt[], question: string): string {
  const lines: string[] = ['# Encounter excerpts (de-identified, most recent first)', ''];
  for (const e of excerpts) {
    lines.push(`## [${e.ref}] Visit on ${e.date}`);
    lines.push(`- Chief complaint: ${e.chiefComplaint ?? 'not recorded'}`);
    lines.push(`- Subjective: ${e.subjective ?? 'not recorded'}`);
    lines.push(`- Objective: ${e.objective ?? 'not recorded'}`);
    lines.push(`- Assessment: ${e.assessment ?? 'not recorded'}`);
    lines.push(`- Plan: ${e.plan ?? 'not recorded'}`);
    lines.push(`- Diagnoses: ${e.diagnoses.length ? e.diagnoses.join('; ') : 'none recorded'}`);
    lines.push('');
  }
  lines.push('# Question', '', `"""`, question.trim(), `"""`, '', 'Answer the question now, citing the excerpts as [E1], [E2], ...');
  return lines.join('\n');
}
