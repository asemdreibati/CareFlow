import { ServiceUnavailableException } from '@nestjs/common';

/** DI token for the active {@link EmbeddingProvider}; tests override it with a fake. */
export const EMBEDDING_PROVIDER_TOKEN = 'EMBEDDING_PROVIDER';

/** Width of the `encounter_embeddings.embedding vector(768)` column - fixed by the migration. */
export const EMBEDDING_DIMENSIONS = 768;

/** Asymmetric retrieval: documents are indexed with one task type, questions with the other. */
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/**
 * Minimal abstraction over a text-embedding vendor. `embed` returns one vector
 * per input text, in order, each exactly {@link EMBEDDING_DIMENSIONS} wide.
 * Implementations map vendor errors to HTTP exceptions like {@link AiProvider}.
 */
export interface EmbeddingProvider {
  readonly name: 'gemini' | 'none' | (string & {});
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]>;
}

/** Selected when embeddings are turned off or no key is configured: every call fails fast with 503. */
export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly model = '';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  embed(): Promise<number[][]> {
    return Promise.reject(new ServiceUnavailableException('Embeddings are not configured'));
  }
}

export function embeddingsEnabled(provider: EmbeddingProvider): boolean {
  return provider.name !== 'none';
}
