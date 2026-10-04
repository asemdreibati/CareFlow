import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AiInteraction, AiInteractionStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { AI_PROVIDER_TOKEN, type AiProvider } from './ai-provider.js';
import { SOAP_FIELDS, SOAP_SCHEMA, buildPatientContext, hashContext, normalizeSoap, renderPatientContext, type SoapNote } from './ai.context.js';
import { PATIENT_SUMMARY_SYSTEM, SOAP_NOTE_SYSTEM, renderTranscriptPrompt } from './ai.prompts.js';
import type { ListInteractionsQuery, ReviewInteractionDto, SoapNoteDto } from './ai.dto.js';

const MAX_OUTPUT_TOKENS = 4096;
const HISTORY_LIMIT = 50;
const UPCOMING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN'] as const;

type EncounterHead = { id: string; patientId: string; doctorId: string; status: string };

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
    const patient = await this.prisma.db.patient.findFirst({
      where: { id: patientId, clinicId: user.clinicId },
      // Explicit select: identifiers (name, phone, email, address, national id, notes) never leave the DB layer here.
      select: {
        id: true,
        dateOfBirth: true,
        gender: true,
        bloodType: true,
        allergies: { select: { substance: true, reaction: true, severity: true }, orderBy: { notedAt: 'desc' } },
        prescriptions: {
          where: { status: 'ACTIVE' },
          select: { medication: true, dosage: true, frequency: true, durationDays: true, instructions: true },
          orderBy: { createdAt: 'desc' },
        },
        encounters: {
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
          where: { startsAt: { gte: now }, status: { in: [...UPCOMING_STATUSES] } },
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

  async review(user: AuthUser, id: string, dto: ReviewInteractionDto): Promise<AiInteraction> {
    const interaction = await this.prisma.db.aiInteraction.findFirst({ where: { id, clinicId: user.clinicId } });
    if (!interaction) throw new NotFoundException('AI interaction not found');
    if (interaction.status !== 'GENERATED') throw new ConflictException(`Interaction is already ${interaction.status}`);

    const apply = dto.decision === 'APPROVED' && dto.applyToEncounter === true;
    if (apply) {
      if (interaction.feature !== 'SOAP_NOTE' || !interaction.encounterId) {
        throw new BadRequestException('Only SOAP note drafts can be applied to an encounter');
      }
      if (!user.permissions.has(Permission.RecordsWrite)) throw new ForbiddenException(`Missing permission: ${Permission.RecordsWrite}`);
    }

    return this.prisma.transaction(async (tx) => {
      if (apply) {
        const encounter = await tx.encounter.findFirst({
          where: { id: interaction.encounterId!, clinicId: user.clinicId },
          select: { id: true, patientId: true, doctorId: true, status: true },
        });
        if (!encounter) throw new NotFoundException('Encounter not found');
        this.assertCanEditEncounter(user, encounter);
        if (encounter.status !== 'DRAFT') throw new ConflictException('Encounter is no longer a draft; the AI note cannot be applied');

        const soap = normalizeSoap(interaction.structuredOutput);
        const data: Prisma.EncounterUpdateInput = {};
        for (const field of SOAP_FIELDS) if (soap[field]) data[field] = soap[field];
        if (Object.keys(data).length > 0) await tx.encounter.update({ where: { id: encounter.id }, data });
      }
      return tx.aiInteraction.update({
        where: { id: interaction.id },
        data: { status: dto.decision, reviewedById: user.id, reviewedAt: new Date() },
      });
    });
  }

  // ─────────────────────────────────── History ─────────────────────────────────

  list(user: AuthUser, q: ListInteractionsQuery): Promise<AiInteraction[]> {
    return this.prisma.db.aiInteraction.findMany({
      where: { clinicId: user.clinicId, ...(q.patientId ? { patientId: q.patientId } : {}), ...(q.feature ? { feature: q.feature } : {}) },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });
  }

  // ─────────────────────────────────── Helpers ─────────────────────────────────

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
