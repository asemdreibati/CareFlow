import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { EMBEDDING_PROVIDER_TOKEN, embeddingsEnabled, type EmbeddingProvider } from './embedding-provider.js';
import { buildEncounterEmbeddingText, chunk, hashEmbeddingText, normalizeVector, toVectorLiteral } from './embeddings.util.js';
import type { PatientIdentifiers } from './redaction.js';

/** Encounters embedded per provider call during a backfill. */
const BACKFILL_BATCH = 16;
/** Only signed clinical content is indexed; drafts change too often and are not part of the record yet. */
const INDEXED_STATUSES = ['SIGNED', 'AMENDED'] as const;

const embeddingSelect = {
  id: true,
  clinicId: true,
  patientId: true,
  status: true,
  occurredAt: true,
  chiefComplaint: true,
  subjective: true,
  objective: true,
  assessment: true,
  plan: true,
  diagnoses: { select: { code: true, description: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] },
  embedding: { select: { contentHash: true, model: true } },
  // Read only to scrub the patient's own identifiers out of the free text; never embedded.
  patient: { select: { firstName: true, lastName: true, phone: true, email: true, mrn: true, nationalIdEnc: true } },
} satisfies Prisma.EncounterSelect;

type EmbeddableEncounter = Prisma.EncounterGetPayload<{ select: typeof embeddingSelect }>;

export type IndexOutcome = 'embedded' | 'unchanged' | 'skipped';

export interface BackfillResult {
  /** Signed/amended encounters examined. */
  scanned: number;
  /** Vectors written (new or outdated content/model). */
  embedded: number;
  /** Already up to date. */
  unchanged: number;
  /** Provider or database failures (logged, not thrown). */
  failed: number;
}

export interface SimilarEncounter {
  id: string;
  distance: number;
}

/**
 * Maintains `encounter_embeddings` (one 768-d vector per signed encounter) and
 * runs the cosine search behind "ask the record". The text that leaves the
 * system is de-identified by construction (see {@link buildEncounterEmbeddingText}).
 */
@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    @Inject(EMBEDDING_PROVIDER_TOKEN) private readonly provider: EmbeddingProvider,
    private readonly prisma: PrismaService,
    private readonly crypto: FieldEncryptionService,
  ) {}

  get enabled(): boolean {
    return embeddingsEnabled(this.provider);
  }

  status() {
    return { enabled: this.enabled, provider: this.provider.name, model: this.enabled ? this.provider.model : null, dimensions: this.provider.dimensions };
  }

  /**
   * (Re)embeds one encounter. Skips drafts and encounters whose content hash and
   * model are unchanged. Runs with whatever tenant context is active, so callers
   * outside a request wrap it in `tenantContext.runSystem(..., { clinicId })`.
   */
  async indexEncounter(clinicId: string, encounterId: string): Promise<IndexOutcome> {
    if (!this.enabled) return 'skipped';
    const encounter = await this.prisma.db.encounter.findFirst({ where: { id: encounterId, clinicId }, select: embeddingSelect });
    if (!encounter || !INDEXED_STATUSES.includes(encounter.status as (typeof INDEXED_STATUSES)[number])) return 'skipped';
    const text = this.embeddingText(encounter);
    const hash = hashEmbeddingText(text);
    if (this.isCurrent(encounter, hash)) return 'unchanged';
    const [vector] = await this.provider.embed([text], 'RETRIEVAL_DOCUMENT');
    await this.upsert(encounter, hash, vector);
    return 'embedded';
  }

  /** Embeds every signed encounter of the clinic whose vector is missing or stale, in batches. */
  async backfill(clinicId: string): Promise<BackfillResult> {
    const result: BackfillResult = { scanned: 0, embedded: 0, unchanged: 0, failed: 0 };
    if (!this.enabled) return result;
    const encounters = await this.prisma.db.encounter.findMany({
      where: { clinicId, status: { in: [...INDEXED_STATUSES] } },
      select: embeddingSelect,
      orderBy: { occurredAt: 'asc' },
    });
    result.scanned = encounters.length;

    const pending: { encounter: EmbeddableEncounter; text: string; hash: string }[] = [];
    for (const encounter of encounters) {
      const text = this.embeddingText(encounter);
      const hash = hashEmbeddingText(text);
      if (this.isCurrent(encounter, hash)) result.unchanged += 1;
      else pending.push({ encounter, text, hash });
    }

    for (const batch of chunk(pending, BACKFILL_BATCH)) {
      let vectors: number[][];
      try {
        vectors = await this.provider.embed(
          batch.map((b) => b.text),
          'RETRIEVAL_DOCUMENT',
        );
      } catch (err) {
        this.logger.warn(`Embedding batch of ${batch.length} failed: ${(err as Error).message}`);
        result.failed += batch.length;
        continue;
      }
      for (let i = 0; i < batch.length; i++) {
        try {
          await this.upsert(batch[i].encounter, batch[i].hash, vectors[i]);
          result.embedded += 1;
        } catch (err) {
          this.logger.warn(`Storing embedding for encounter ${batch[i].encounter.id} failed: ${(err as Error).message}`);
          result.failed += 1;
        }
      }
    }
    return result;
  }

  /** Embeds a free-text question with the retrieval-query task type. */
  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.provider.embed([text], 'RETRIEVAL_QUERY');
    return normalizeVector(vector);
  }

  /** The patient's own identifiers, used only to redact them from text sent to a provider. */
  patientIdentifiers(patient: { firstName: string; lastName: string; phone: string | null; email: string | null; mrn: string; nationalIdEnc: string | null }): PatientIdentifiers {
    let nationalId: string | null = null;
    try {
      nationalId = this.crypto.decrypt(patient.nationalIdEnc);
    } catch {
      nationalId = null; // undecryptable (rotated key): nothing to redact with
    }
    return { firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone, email: patient.email, mrn: patient.mrn, nationalId };
  }

  private embeddingText(encounter: EmbeddableEncounter): string {
    return buildEncounterEmbeddingText(encounter, this.patientIdentifiers(encounter.patient));
  }

  /**
   * Nearest signed encounters of ONE patient by cosine distance. The clinic and
   * patient filters are explicit on top of RLS. `doctorId` restricts the search
   * to one author's encounters (own-only doctors).
   */
  async similarEncounters(clinicId: string, patientId: string, queryVector: number[], limit: number, doctorId?: string): Promise<SimilarEncounter[]> {
    const literal = toVectorLiteral(queryVector);
    const byDoctor = doctorId ? Prisma.sql`AND e.doctor_id = ${doctorId}::uuid` : Prisma.empty;
    const rows = await this.prisma.transaction((tx) =>
      tx.$queryRaw<{ id: string; distance: number }[]>`
        SELECT e.id, (ee.embedding <=> ${literal}::vector)::float8 AS distance
        FROM encounter_embeddings ee
        JOIN encounters e ON e.id = ee.encounter_id AND e.clinic_id = ee.clinic_id
        WHERE ee.clinic_id = ${clinicId}::uuid
          AND ee.patient_id = ${patientId}::uuid
          AND e.clinic_id = ${clinicId}::uuid
          AND e.patient_id = ${patientId}::uuid
          AND e.status IN ('SIGNED', 'AMENDED')
          ${byDoctor}
        ORDER BY ee.embedding <=> ${literal}::vector
        LIMIT ${limit}`,
    );
    return rows.map((r) => ({ id: r.id, distance: Number(r.distance) }));
  }

  private isCurrent(encounter: EmbeddableEncounter, hash: string): boolean {
    return encounter.embedding?.contentHash === hash && encounter.embedding.model === this.provider.model;
  }

  private async upsert(encounter: Pick<EmbeddableEncounter, 'id' | 'clinicId' | 'patientId'>, hash: string, vector: number[]) {
    const literal = toVectorLiteral(normalizeVector(vector));
    const model = this.provider.model;
    await this.prisma.transaction((tx) =>
      tx.$executeRaw`
        INSERT INTO encounter_embeddings (encounter_id, clinic_id, patient_id, model, content_hash, embedding, updated_at)
        VALUES (${encounter.id}::uuid, ${encounter.clinicId}::uuid, ${encounter.patientId}::uuid, ${model}, ${hash}, ${literal}::vector, now())
        ON CONFLICT (encounter_id) DO UPDATE
          SET patient_id = EXCLUDED.patient_id,
              model = EXCLUDED.model,
              content_hash = EXCLUDED.content_hash,
              embedding = EXCLUDED.embedding,
              updated_at = now()
        WHERE encounter_embeddings.clinic_id = ${encounter.clinicId}::uuid`,
    );
  }
}
