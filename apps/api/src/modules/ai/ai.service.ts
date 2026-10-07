import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AiInteraction, AiInteractionStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { AI_PROVIDER_TOKEN, type AiProvider } from './ai-provider.js';
import { SOAP_FIELDS, SOAP_SCHEMA, buildPatientContext, hashContext, normalizeSoap, renderPatientContext, type SoapNote } from './ai.context.js';
import { PATIENT_SUMMARY_SYSTEM, RECORD_QA_SYSTEM, SOAP_NOTE_SYSTEM, renderRecordQaPrompt, renderTranscriptPrompt, type RecordQaExcerpt } from './ai.prompts.js';
import type { AskRecordDto, ListInteractionsQuery, ReviewInteractionDto, SoapNoteDto } from './ai.dto.js';
import { EmbeddingsService } from './embeddings.service.js';
import { createRedactor, type PatientIdentifiers } from './redaction.js';

const MAX_OUTPUT_TOKENS = 4096;
const HISTORY_LIMIT = 50;
/** Encounters handed to the model for "ask the record" (top-k by cosine distance, or most recent as fallback). */
const RECORD_QA_LIMIT = 6;
const NO_RECORD_ANSWER = 'The record contains no signed encounters for this patient yet, so this question cannot be answered from it.';
const UPCOMING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN'] as const;

type EncounterHead = { id: string; patientId: string; doctorId: string; status: string };

/** The patient's direct identifiers: loaded only to redact them from free text, never sent. */
const identifierSelect = { firstName: true, lastName: true, phone: true, email: true, mrn: true, nationalIdEnc: true } satisfies Prisma.PatientSelect;

/** A DOCTOR without appointments:read_all only works with their own encounters (same rule as the records module). */
function ownDoctorOnly(user: AuthUser): boolean {
  return user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
}

/**
 * Encounter / appointment visibility for the caller. Own-only doctors are pinned
 * to their doctor id; one WITHOUT a doctor profile sees nothing (an undefined
 * `doctorId` would be dropped by Prisma and match every row).
 */
function doctorScope(user: AuthUser): { doctorId: string } | { id: { in: string[] } } | Record<string, never> {
  if (!ownDoctorOnly(user)) return {};
  return user.doctorId ? { doctorId: user.doctorId } : { id: { in: [] } };
}

export interface RecordQaCitation {
  ref: string;
  encounterId: string;
  occurredAt: Date;
  chiefComplaint: string | null;
}

export interface RecordQaAnswer {
  /** Markdown answer citing excerpts as [E1], [E2], ... */
  answer: string;
  /** Excerpts the answer refers to, in order of first mention. */
  citations: RecordQaCitation[];
  interactionId: string;
  /** `semantic` when pgvector ranking was used, `recent` when embeddings are disabled or not yet built. */
  retrieval: 'semantic' | 'recent';
}

const recordQaEncounterSelect = {
  id: true,
  occurredAt: true,
  chiefComplaint: true,
  subjective: true,
  objective: true,
  assessment: true,
  plan: true,
  diagnoses: { select: { code: true, description: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] },
} satisfies Prisma.EncounterSelect;
type RecordQaEncounter = Prisma.EncounterGetPayload<{ select: typeof recordQaEncounterSelect }>;

interface InteractionDraft {
  user: AuthUser;
  feature: AiInteraction['feature'];
  patientId?: string;
  encounterId?: string;
  inputHash: string;
  startedAt: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(AI_PROVIDER_TOKEN) private readonly provider: AiProvider,
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  status() {
    const enabled = this.provider.name !== 'none';
    return { enabled, provider: this.provider.name, model: enabled ? this.provider.model : null };
  }

  /** Throws unless the user may use OR review AI output (status/history endpoints). */
  assertAiAccess(user: AuthUser) {
    if (!user.permissions.has(Permission.AiUse) && !user.permissions.has(Permission.AiReview)) {
      throw new ForbiddenException(`Missing permission: ${Permission.AiUse} or ${Permission.AiReview}`);
    }
  }

  // ───────────────────────────── Patient summary ─────────────────────────────

  async patientSummary(user: AuthUser, patientId: string): Promise<AiInteraction> {
    const now = new Date();
    const scope = doctorScope(user);
    const patient = await this.prisma.db.patient.findFirst({
      where: { id: patientId, clinicId: user.clinicId },
      // Explicit select: only clinical fields reach the context. Identifiers are read solely to
      // scrub them from free text (see redaction.ts); address, notes and contacts are never read.
      select: {
        id: true,
        dateOfBirth: true,
        gender: true,
        bloodType: true,
        ...identifierSelect,
        allergies: { select: { substance: true, reaction: true, severity: true }, orderBy: { notedAt: 'desc' } },
        prescriptions: {
          where: { status: 'ACTIVE' },
          select: { medication: true, dosage: true, frequency: true, durationDays: true, instructions: true },
          orderBy: { createdAt: 'desc' },
        },
        // Own-only doctors: only encounters they authored are summarised.
        encounters: {
          where: scope,
          select: {
            occurredAt: true,
            chiefComplaint: true,
            assessment: true,
            plan: true,
            diagnoses: { select: { code: true, description: true, isPrimary: true } },
          },
          orderBy: { occurredAt: 'desc' },
          take: 10,
        },
        appointments: {
          where: { startsAt: { gte: now }, status: { in: [...UPCOMING_STATUSES] }, ...scope },
          select: { startsAt: true, reason: true, type: true },
          orderBy: { startsAt: 'asc' },
          take: 1,
        },
      },
    });
    if (!patient) throw new NotFoundException('Patient not found');

    const context = buildPatientContext({
      patient,
      allergies: patient.allergies,
      prescriptions: patient.prescriptions,
      encounters: patient.encounters,
      upcomingAppointment: patient.appointments[0] ?? null,
      now,
      identifiers: this.embeddings.patientIdentifiers(patient),
    });
    const prompt = renderPatientContext(context);
    const draft: InteractionDraft = { user, feature: 'PATIENT_SUMMARY', patientId, inputHash: hashContext(prompt), startedAt: Date.now() };

    // The clinical record was read (and sent to the provider) regardless of the outcome.
    await this.prisma.db.recordAccessLog.create({ data: { clinicId: user.clinicId, patientId, userId: user.id, action: 'AI_SUMMARY' } });

    try {
      const result = await this.provider.generateText({ system: PATIENT_SUMMARY_SYSTEM, prompt, maxTokens: MAX_OUTPUT_TOKENS });
      return await this.prisma.db.aiInteraction.create({
        data: this.interactionData(draft, 'GENERATED', { output: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens }),
      });
    } catch (err) {
      await this.recordFailure(draft, err);
      throw err;
    }
  }

  // ─────────────────────────────── Ask the record ───────────────────────────────

  /**
   * Answers a question about one patient's record from the most relevant signed
   * encounters. Retrieval is semantic (question embedding vs `encounter_embeddings`,
   * cosine distance) when embeddings are configured and built for the patient;
   * otherwise it falls back to the most recent signed encounters so the feature
   * works with only an LLM key. Needs an LLM provider (503 otherwise).
   */
  async askRecord(user: AuthUser, patientId: string, dto: AskRecordDto): Promise<RecordQaAnswer> {
    if (this.provider.name === 'none') throw new ServiceUnavailableException('AI is not configured');
    const patient = await this.prisma.db.patient.findFirst({ where: { id: patientId, clinicId: user.clinicId }, select: { id: true, ...identifierSelect } });
    if (!patient) throw new NotFoundException('Patient not found');

    const identifiers = this.embeddings.patientIdentifiers(patient);
    const question = dto.question.trim();
    const { encounters, retrieval } = await this.retrieveForQuestion(user, patientId, question, identifiers);
    const sorted = [...encounters].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    const excerpts: RecordQaExcerpt[] = sorted.map((e, i) => ({
      ref: `E${i + 1}`,
      date: e.occurredAt.toISOString().slice(0, 10),
      chiefComplaint: textOrNull(e.chiefComplaint),
      subjective: textOrNull(e.subjective),
      objective: textOrNull(e.objective),
      assessment: textOrNull(e.assessment),
      plan: textOrNull(e.plan),
      diagnoses: e.diagnoses.map((d) => `${d.code} ${d.description}${d.isPrimary ? ' (primary)' : ''}`),
    }));
    const prompt = renderRecordQaPrompt(excerpts, question, identifiers);
    const draft: InteractionDraft = { user, feature: 'PATIENT_SUMMARY', patientId, inputHash: hashContext(prompt), startedAt: Date.now() };

    // The clinical record was read (and excerpts sent to the provider) regardless of the outcome.
    await this.prisma.db.recordAccessLog.create({ data: { clinicId: user.clinicId, patientId, userId: user.id, action: 'AI_RECORD_QA' } });

    const sources = sorted.map((e, i) => ({ ref: `E${i + 1}`, encounterId: e.id, occurredAt: e.occurredAt, chiefComplaint: textOrNull(e.chiefComplaint) }));
    try {
      const result =
        sorted.length === 0
          ? { text: NO_RECORD_ANSWER, inputTokens: 0, outputTokens: 0 }
          : await this.provider.generateText({ system: RECORD_QA_SYSTEM, prompt, maxTokens: MAX_OUTPUT_TOKENS });
      const citations = citedSources(result.text, sources);
      const structured = { kind: 'RECORD_QA', question, retrieval, citations, sources };
      const interaction = await this.prisma.db.aiInteraction.create({
        data: this.interactionData(draft, 'GENERATED', {
          output: result.text,
          structuredOutput: structured as unknown as Prisma.InputJsonValue,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }),
      });
      return { answer: result.text, citations, interactionId: interaction.id, retrieval };
    } catch (err) {
      await this.recordFailure(draft, err);
      throw err;
    }
  }

  /**
   * Top-k encounters by cosine distance when possible, else the most recent signed
   * ones. Own-only doctors retrieve (and therefore cite) only encounters they authored.
   */
  private async retrieveForQuestion(
    user: AuthUser,
    patientId: string,
    question: string,
    identifiers: PatientIdentifiers,
  ): Promise<{ encounters: RecordQaEncounter[]; retrieval: 'semantic' | 'recent' }> {
    const clinicId = user.clinicId;
    if (ownDoctorOnly(user) && !user.doctorId) return { encounters: [], retrieval: 'recent' };
    const signed = { clinicId, patientId, status: { in: ['SIGNED', 'AMENDED'] as const }, ...doctorScope(user) } satisfies Prisma.EncounterWhereInput;
    if (this.embeddings.enabled) {
      // The question leaves the system too: scrub the patient's identifiers first.
      const vector = await this.embeddings.embedQuery(createRedactor(identifiers)(question));
      const hits = await this.embeddings.similarEncounters(clinicId, patientId, vector, RECORD_QA_LIMIT, ownDoctorOnly(user) ? user.doctorId : undefined);
      if (hits.length > 0) {
        const rows = await this.prisma.db.encounter.findMany({ where: { ...signed, id: { in: hits.map((h) => h.id) } }, select: recordQaEncounterSelect });
        const order = new Map(hits.map((h, i) => [h.id, i]));
        rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        return { encounters: rows, retrieval: 'semantic' };
      }
    }
    const rows = await this.prisma.db.encounter.findMany({ where: signed, select: recordQaEncounterSelect, orderBy: { occurredAt: 'desc' }, take: RECORD_QA_LIMIT });
    return { encounters: rows, retrieval: 'recent' };
  }

  // ───────────────────────────────── SOAP note ─────────────────────────────────

  async soapNote(user: AuthUser, encounterId: string, dto: SoapNoteDto): Promise<AiInteraction> {
    const encounter = await this.loadEncounter(user, encounterId);
    this.assertCanEditEncounter(user, encounter);
    if (encounter.status !== 'DRAFT') throw new ConflictException('Only DRAFT encounters can receive an AI SOAP draft');

    const prompt = renderTranscriptPrompt(dto.transcript);
    const draft: InteractionDraft = {
      user,
      feature: 'SOAP_NOTE',
      patientId: encounter.patientId,
      encounterId: encounter.id,
      inputHash: hashContext(prompt),
      startedAt: Date.now(),
    };

    try {
      const result = await this.provider.generateJson<SoapNote>({ system: SOAP_NOTE_SYSTEM, prompt, schema: SOAP_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS });
      const soap = normalizeSoap(result.data);
      return await this.prisma.db.aiInteraction.create({
        data: this.interactionData(draft, 'GENERATED', {
          structuredOutput: soap as unknown as Prisma.InputJsonValue,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }),
      });
    } catch (err) {
      await this.recordFailure(draft, err);
      throw err;
    }
  }

  // ─────────────────────────────────── Review ──────────────────────────────────

  /**
   * Approve / reject a GENERATED interaction, optionally copying an approved SOAP
   * draft into its (still DRAFT) encounter. Both writes are compare-and-set inside
   * one transaction: the interaction is claimed with `status = 'GENERATED'` (a
   * second reviewer gets 409) and the encounter is written with `status = 'DRAFT'`
   * (a note signed in the meantime gets 409 and the claim is rolled back).
   */
  async review(user: AuthUser, id: string, dto: ReviewInteractionDto): Promise<AiInteraction> {
    const interaction = await this.prisma.db.aiInteraction.findFirst({ where: { id, clinicId: user.clinicId } });
    if (!interaction || !(await this.canSeeInteraction(user, interaction))) throw new NotFoundException('AI interaction not found');
    if (interaction.status !== 'GENERATED') throw new ConflictException(`Interaction is already ${interaction.status}`);

    const apply = dto.decision === 'APPROVED' && dto.applyToEncounter === true;
    if (apply) {
      if (interaction.feature !== 'SOAP_NOTE' || !interaction.encounterId) {
        throw new BadRequestException('Only SOAP note drafts can be applied to an encounter');
      }
      if (!user.permissions.has(Permission.RecordsWrite)) throw new ForbiddenException(`Missing permission: ${Permission.RecordsWrite}`);
    }

    return this.prisma.transaction(async (tx) => {
      const claimed = await tx.aiInteraction.updateMany({
        where: { id: interaction.id, clinicId: user.clinicId, status: 'GENERATED' },
        data: { status: dto.decision, reviewedById: user.id, reviewedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException('Interaction was already reviewed');

      if (apply) {
        const encounter = await tx.encounter.findFirst({
          where: { id: interaction.encounterId!, clinicId: user.clinicId },
          select: { id: true, patientId: true, doctorId: true, status: true },
        });
        if (!encounter) throw new NotFoundException('Encounter not found');
        this.assertCanEditEncounter(user, encounter);

        const soap = normalizeSoap(interaction.structuredOutput);
        const data: Prisma.EncounterUpdateManyMutationInput = { updatedAt: new Date() };
        for (const field of SOAP_FIELDS) if (soap[field]) data[field] = soap[field];
        // The DRAFT check is part of the write: a concurrent sign makes this a no-op → 409.
        const written = await tx.encounter.updateMany({ where: { id: encounter.id, clinicId: user.clinicId, status: 'DRAFT' }, data });
        if (written.count !== 1) throw new ConflictException('Encounter is no longer a draft; the AI note cannot be applied');
      }
      return tx.aiInteraction.findUniqueOrThrow({ where: { id: interaction.id } });
    });
  }

  // ─────────────────────────────────── History ─────────────────────────────────

  /**
   * Latest interactions of the clinic. Own-only doctors see only interactions they
   * ran themselves or that belong to encounters they authored.
   */
  async list(user: AuthUser, q: ListInteractionsQuery): Promise<AiInteraction[]> {
    const where: Prisma.AiInteractionWhereInput = {
      clinicId: user.clinicId,
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.feature ? { feature: q.feature } : {}),
    };
    if (!ownDoctorOnly(user)) {
      return this.prisma.db.aiInteraction.findMany({ where, orderBy: { createdAt: 'desc' }, take: HISTORY_LIMIT });
    }
    const ownEncounter = user.doctorId
      ? Prisma.sql`OR EXISTS (SELECT 1 FROM encounters e WHERE e.id = ai.encounter_id AND e.clinic_id = ai.clinic_id AND e.doctor_id = ${user.doctorId}::uuid)`
      : Prisma.empty;
    const visible = await this.prisma.transaction((tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT ai.id
        FROM ai_interactions ai
        WHERE ai.clinic_id = ${user.clinicId}::uuid
          ${q.patientId ? Prisma.sql`AND ai.patient_id = ${q.patientId}::uuid` : Prisma.empty}
          ${q.feature ? Prisma.sql`AND ai.feature::text = ${q.feature}` : Prisma.empty}
          AND (ai.user_id = ${user.id}::uuid ${ownEncounter})
        ORDER BY ai.created_at DESC
        LIMIT ${HISTORY_LIMIT}`,
    );
    if (visible.length === 0) return [];
    return this.prisma.db.aiInteraction.findMany({ where: { ...where, id: { in: visible.map((r) => r.id) } }, orderBy: { createdAt: 'desc' } });
  }

  // ─────────────────────────────────── Helpers ─────────────────────────────────

  /** Same visibility rule as {@link list}, for one row. */
  private async canSeeInteraction(user: AuthUser, interaction: AiInteraction): Promise<boolean> {
    if (!ownDoctorOnly(user) || interaction.userId === user.id) return true;
    if (!user.doctorId || !interaction.encounterId) return false;
    const own = await this.prisma.db.encounter.findFirst({
      where: { id: interaction.encounterId, clinicId: user.clinicId, doctorId: user.doctorId },
      select: { id: true },
    });
    return !!own;
  }

  private async loadEncounter(user: AuthUser, id: string): Promise<EncounterHead> {
    const encounter = await this.prisma.db.encounter.findFirst({
      where: { id, clinicId: user.clinicId },
      select: { id: true, patientId: true, doctorId: true, status: true },
    });
    if (!encounter) throw new NotFoundException('Encounter not found');
    return encounter;
  }

  /**
   * Doctors may only draft notes for their own encounters unless they can see
   * every schedule; everyone else needs records:write (e.g. nurses).
   */
  private assertCanEditEncounter(user: AuthUser, encounter: EncounterHead) {
    if (user.role === 'DOCTOR') {
      if (encounter.doctorId !== user.doctorId && !user.permissions.has(Permission.AppointmentsReadAll)) {
        throw new ForbiddenException('You can only work on your own encounters');
      }
      return;
    }
    if (!user.permissions.has(Permission.RecordsWrite)) {
      throw new ForbiddenException(`Missing permission: ${Permission.RecordsWrite}`);
    }
  }

  private interactionData(
    draft: InteractionDraft,
    status: AiInteractionStatus,
    extra: Pick<Prisma.AiInteractionUncheckedCreateInput, 'output' | 'structuredOutput' | 'inputTokens' | 'outputTokens' | 'error'>,
  ): Prisma.AiInteractionUncheckedCreateInput {
    return {
      clinicId: draft.user.clinicId,
      userId: draft.user.id,
      patientId: draft.patientId,
      encounterId: draft.encounterId,
      feature: draft.feature,
      provider: this.provider.name,
      model: this.provider.model,
      inputHash: draft.inputHash,
      status,
      latencyMs: Date.now() - draft.startedAt,
      ...extra,
    };
  }

  /** Persist a FAILED row so the attempt is traceable; never masks the original error. */
  private async recordFailure(draft: InteractionDraft, err: unknown) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    this.logger.warn(`${draft.feature} failed via ${this.provider.name}: ${message}`);
    try {
      await this.prisma.db.aiInteraction.create({ data: this.interactionData(draft, 'FAILED', { error: message }) });
    } catch (dbErr) {
      this.logger.error('Could not persist failed AI interaction', dbErr as Error);
    }
  }
}

function textOrNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Sources referenced in the answer as [E1], [E2]..., in order of first mention. Unknown refs are ignored. */
function citedSources(answer: string, sources: RecordQaCitation[]): RecordQaCitation[] {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const seen = new Set<string>();
  const out: RecordQaCitation[] = [];
  for (const match of answer.matchAll(/\[(E\d+)\]/g)) {
    const ref = match[1];
    const src = byRef.get(ref);
    if (src && !seen.has(ref)) {
      seen.add(ref);
      out.push(src);
    }
  }
  return out;
}
