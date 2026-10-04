import { ApiError, FinishReason, GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { BadGatewayException, HttpException, HttpStatus, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { AiProvider, GenerateJsonInput, GenerateJsonResult, GenerateTextInput, GenerateTextResult } from '../ai-provider.js';
import { parseJsonObject } from '../ai.context.js';

const DEFAULT_MAX_TOKENS = 4096;
const BLOCKED: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
]);

/** Google Gemini API via @google/genai. JSON answers use `responseJsonSchema`. */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const res = await this.call(input);
    return { text: textOf(res), ...usage(res) };
  }

  async generateJson<T>(input: GenerateJsonInput): Promise<GenerateJsonResult<T>> {
    const res = await this.call(input, input.schema);
    let data: T;
    try {
      data = parseJsonObject<T>(textOf(res));
    } catch {
      this.logger.warn('Gemini returned a non-JSON reply for a structured request');
      throw new BadGatewayException('AI provider returned malformed JSON');
    }
    return { data, ...usage(res) };
  }

  private async call(input: GenerateTextInput, schema?: Record<string, unknown>): Promise<GenerateContentResponse> {
    let res: GenerateContentResponse;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: input.prompt,
        config: {
          systemInstruction: input.system,
          maxOutputTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(schema ? { responseMimeType: 'application/json', responseJsonSchema: schema } : {}),
        },
      });
    } catch (err) {
      throw mapGeminiError(err);
    }

    if (res.promptFeedback?.blockReason) {
      throw new UnprocessableEntityException(`The AI model declined to answer this request (${res.promptFeedback.blockReason})`);
    }
    const finish = res.candidates?.[0]?.finishReason;
    if (finish && BLOCKED.has(finish)) {
      throw new UnprocessableEntityException(`The AI model declined to answer this request (${finish})`);
    }
    if (finish === FinishReason.MAX_TOKENS) {
      throw new BadGatewayException('AI response was truncated (token limit reached)');
    }
    return res;
  }
}

function textOf(res: GenerateContentResponse): string {
  const text = res.text;
  if (!text || !text.trim()) throw new BadGatewayException('AI provider returned an empty response');
  return text;
}

function usage(res: GenerateContentResponse): { inputTokens?: number; outputTokens?: number } {
  const u = res.usageMetadata;
  return { inputTokens: u?.promptTokenCount, outputTokens: u?.candidatesTokenCount };
}

function mapGeminiError(err: unknown): Error {
  if (err instanceof HttpException) return err;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return new ServiceUnavailableException('AI provider rejected the configured credentials');
    if (err.status === 429) return new HttpException('AI provider rate limit reached, retry later', HttpStatus.TOO_MANY_REQUESTS);
    return new BadGatewayException(`AI provider error (${err.status})`);
  }
  return new BadGatewayException('AI provider is unreachable');
}
