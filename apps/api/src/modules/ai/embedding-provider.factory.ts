import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { DisabledEmbeddingProvider, type EmbeddingProvider } from './embedding-provider.js';
import { GeminiEmbeddingProvider } from './providers/gemini-embedding.provider.js';

/** Picks the embedding provider from `embedding.provider` (already resolved against the Gemini key by loadEnv). */
export function createEmbeddingProvider(embedding: Env['embedding']): EmbeddingProvider {
  const logger = new Logger('AiModule');
  if (embedding.provider === 'gemini' && embedding.geminiApiKey) {
    logger.log(`Embedding provider: gemini (${embedding.model})`);
    return new GeminiEmbeddingProvider(embedding.geminiApiKey, embedding.model);
  }
  logger.warn('Embedding provider: none - semantic search is disabled (ask-the-record falls back to recent encounters)');
  return new DisabledEmbeddingProvider();
}

export function embeddingProviderFromConfig(config: ConfigService<Env, true>): EmbeddingProvider {
  return createEmbeddingProvider(config.get('embedding', { infer: true }));
}
