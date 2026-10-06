import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { ENCOUNTER_EVENTS, type EncounterEvent } from '../records/records.service.js';
import { EmbeddingsService } from './embeddings.service.js';

/**
 * Keeps `encounter_embeddings` in sync with the record: every signed or amended
 * encounter is (re)embedded in the background. Listeners run outside the request
 * context, so the work is wrapped in a system context pinned to the clinic.
 * Failures are logged, never thrown (the clinical write already succeeded).
 */
@Injectable()
export class EncounterEmbeddingListener {
  private readonly logger = new Logger(EncounterEmbeddingListener.name);

  constructor(private readonly embeddings: EmbeddingsService) {}

  @OnEvent(ENCOUNTER_EVENTS.signed)
  @OnEvent(ENCOUNTER_EVENTS.amended)
  async onEncounterChanged(event: EncounterEvent): Promise<void> {
    if (!this.embeddings.enabled) return;
    try {
      const outcome = await tenantContext.runSystem(() => this.embeddings.indexEncounter(event.clinicId, event.id), { clinicId: event.clinicId });
      this.logger.debug(`Encounter ${event.id}: embedding ${outcome}`);
    } catch (err) {
      this.logger.warn(`Embedding encounter ${event.id} failed: ${(err as Error).message}`);
    }
  }
}
