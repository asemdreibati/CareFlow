import { ApiError, GoogleGenAI } from '@google/genai';
import { BadGatewayException, HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider, type EmbeddingTaskType } from '../embedding-provider.js';

/** The Gemini embedding endpoint accepts at most 100 texts per request. */
const MAX_BATCH = 100;

/** Google Gemini text embeddings (`models.embedContent`) truncated to 768 dimensions via `outputDimensionality`. */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async embed(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      out.push(...(await this.embedBatch(texts.slice(i, i + MAX_BATCH), taskType)));
    }
    return out;
  }

  private async embedBatch(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
    if (texts.length === 0) return [];
    let embeddings;
    try {
      const res = await this.client.models.embedContent({
        model: this.model,
        contents: texts,
        config: { taskType, outputDimensionality: this.dimensions },
      });
      embeddings = res.embeddings;
    } catch (err) {
      throw mapGeminiError(err);
    }
    if (!embeddings || embeddings.length !== texts.length) {
      throw new BadGatewayException('Embedding provider returned an unexpected number of vectors');
    }
    return embeddings.map((e) => {
      const values = e.values;
      if (!values || values.length !== this.dimensions) {
        throw new BadGatewayException(`Embedding provider returned ${values?.length ?? 0} dimensions, expected ${this.dimensions}`);
      }
      return values;
    });
  }
}

function mapGeminiError(err: unknown): Error {
  if (err instanceof HttpException) return err;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return new ServiceUnavailableException('Embedding provider rejected the configured credentials');
    if (err.status === 429) return new HttpException('Embedding provider rate limit reached, retry later', HttpStatus.TOO_MANY_REQUESTS);
    return new BadGatewayException(`Embedding provider error (${err.status})`);
  }
  return new BadGatewayException('Embedding provider is unreachable');
}
