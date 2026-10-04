import Anthropic, { APIError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';
import { BadGatewayException, HttpException, HttpStatus, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import type { AiProvider, GenerateJsonInput, GenerateJsonResult, GenerateTextInput, GenerateTextResult } from '../ai-provider.js';
import { parseJsonObject } from '../ai.context.js';

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic Messages API. The configured model (Claude Opus 5.5 by default) has
 * thinking always on, so no `thinking` parameter is sent; depth is controlled
 * with `output_config.effort`. JSON answers use structured outputs
 * (`output_config.format`), so the reply is schema-conformant by construction.
 */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude';
  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const message = await this.call(input);
    return { text: firstText(message), inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  }

  async generateJson<T>(input: GenerateJsonInput): Promise<GenerateJsonResult<T>> {
    const message = await this.call(input, { type: 'json_schema', schema: input.schema });
    const text = firstText(message);
    let data: T;
    try {
      data = parseJsonObject<T>(text);
    } catch {
      this.logger.warn('Claude returned a non-JSON reply for a structured request');
      throw new BadGatewayException('AI provider returned malformed JSON');
    }
    return { data, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  }

  private async call(input: GenerateTextInput, format?: Anthropic.JSONOutputFormat): Promise<Anthropic.Message> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: input.system,
        messages: [{ role: 'user', content: input.prompt }],
        output_config: { effort: 'medium', ...(format ? { format } : {}) },
      });
    } catch (err) {
      throw mapClaudeError(err);
    }

    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '';
      throw new UnprocessableEntityException(`The AI model declined to answer this request${why}`);
    }
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      throw new BadGatewayException('AI response was truncated (token limit reached)');
    }
    return message;
  }
}

function firstText(message: Anthropic.Message): string {
  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block || !block.text.trim()) throw new BadGatewayException('AI provider returned an empty response');
  return block.text;
}

function mapClaudeError(err: unknown): Error {
  if (err instanceof HttpException) return err;
  if (err instanceof AuthenticationError) return new ServiceUnavailableException('AI provider rejected the configured credentials');
  if (err instanceof RateLimitError) return new HttpException('AI provider rate limit reached, retry later', HttpStatus.TOO_MANY_REQUESTS);
  if (err instanceof APIError) return new BadGatewayException(`AI provider error${err.status ? ` (${err.status})` : ''}`);
  return new BadGatewayException('AI provider is unreachable');
}
