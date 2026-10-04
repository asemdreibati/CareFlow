import { ServiceUnavailableException } from '@nestjs/common';

/** DI token for the active {@link AiProvider}; tests override it with a fake. */
export const AI_PROVIDER_TOKEN = 'AI_PROVIDER';

export interface GenerateTextInput {
  /** System prompt: role, rules and output format. Never contains patient identifiers. */
  system: string;
  /** De-identified user content. */
  prompt: string;
  maxTokens?: number;
}

export interface GenerateJsonInput extends GenerateTextInput {
  /** JSON schema (draft 2020-12 subset) the model output must satisfy. */
  schema: Record<string, unknown>;
}

export interface GenerateTextResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerateJsonResult<T> {
  data: T;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Minimal abstraction over an LLM vendor. Implementations map vendor errors to
 * HTTP exceptions: 422 for refusals/safety blocks, 429 for rate limits, 503 for
 * credential problems, 502 for anything else coming back from the provider.
 */
export interface AiProvider {
  readonly name: 'claude' | 'gemini' | 'none' | (string & {});
  readonly model: string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  generateJson<T>(input: GenerateJsonInput): Promise<GenerateJsonResult<T>>;
}

/** Selected when no API key is configured: every call fails fast with 503. */
export class DisabledProvider implements AiProvider {
  readonly name = 'none';
  readonly model = '';

  generateText(): Promise<GenerateTextResult> {
    return Promise.reject(new ServiceUnavailableException('AI is not configured'));
  }

  generateJson<T>(): Promise<GenerateJsonResult<T>> {
    return Promise.reject(new ServiceUnavailableException('AI is not configured'));
  }
}
