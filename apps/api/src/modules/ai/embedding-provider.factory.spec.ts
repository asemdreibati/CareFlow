import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { DisabledEmbeddingProvider, EMBEDDING_DIMENSIONS, embeddingsEnabled } from './embedding-provider.js';
import { createEmbeddingProvider } from './embedding-provider.factory.js';
import { GeminiEmbeddingProvider } from './providers/gemini-embedding.provider.js';

describe('createEmbeddingProvider', () => {
  it('builds the Gemini provider when selected with a key', () => {
    const p = createEmbeddingProvider({ provider: 'gemini', model: 'gemini-embedding-001', geminiApiKey: 'k' });
    expect(p).toBeInstanceOf(GeminiEmbeddingProvider);
    expect(p.name).toBe('gemini');
    expect(p.model).toBe('gemini-embedding-001');
    expect(p.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(embeddingsEnabled(p)).toBe(true);
  });

  it('falls back to the disabled provider without a key or when turned off', async () => {
    for (const cfg of [
      { provider: 'gemini' as const, model: 'm' },
      { provider: 'none' as const, model: 'm', geminiApiKey: 'k' },
    ]) {
      const p = createEmbeddingProvider(cfg);
      expect(p).toBeInstanceOf(DisabledEmbeddingProvider);
      expect(embeddingsEnabled(p)).toBe(false);
      await expect(p.embed(['x'], 'RETRIEVAL_QUERY')).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });
});
