import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDER_TOKEN } from './ai-provider.js';
import { aiProviderFromConfig } from './ai-provider.factory.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { EMBEDDING_PROVIDER_TOKEN } from './embedding-provider.js';
import { embeddingProviderFromConfig } from './embedding-provider.factory.js';
import { EncounterEmbeddingListener } from './embeddings.listener.js';
import { EmbeddingsService } from './embeddings.service.js';

/**
 * AI assistance (pre-visit summaries, SOAP drafts, ask-the-record) and encounter
 * embeddings for semantic search. Vendors are chosen once at boot from the `ai`
 * and `embedding` config blocks; tests swap them via
 * `overrideProvider(AI_PROVIDER_TOKEN)` / `overrideProvider(EMBEDDING_PROVIDER_TOKEN)`.
 */
@Module({
  controllers: [AiController],
  providers: [
    AiService,
    EmbeddingsService,
    EncounterEmbeddingListener,
    { provide: AI_PROVIDER_TOKEN, inject: [ConfigService], useFactory: aiProviderFromConfig },
    { provide: EMBEDDING_PROVIDER_TOKEN, inject: [ConfigService], useFactory: embeddingProviderFromConfig },
  ],
  exports: [AiService, EmbeddingsService, AI_PROVIDER_TOKEN, EMBEDDING_PROVIDER_TOKEN],
})
export class AiModule {}
