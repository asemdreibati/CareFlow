import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { DisabledProvider, type AiProvider } from './ai-provider.js';
import { ClaudeProvider } from './providers/claude.provider.js';
import { GeminiProvider } from './providers/gemini.provider.js';

/** Picks the provider from `ai.provider` (already resolved against available keys by loadEnv). */
export function createAiProvider(ai: Env['ai']): AiProvider {
  const logger = new Logger('AiModule');
  switch (ai.provider) {
    case 'claude':
      if (!ai.anthropicApiKey) break;
      logger.log(`AI provider: claude (${ai.claudeModel})`);
      return new ClaudeProvider(ai.anthropicApiKey, ai.claudeModel);
    case 'gemini':
      if (!ai.geminiApiKey) break;
      logger.log(`AI provider: gemini (${ai.geminiModel})`);
      return new GeminiProvider(ai.geminiApiKey, ai.geminiModel);
    default:
      break;
  }
  logger.warn('AI provider: none (no API key configured) - AI endpoints return 503');
  return new DisabledProvider();
}

export function aiProviderFromConfig(config: ConfigService<Env, true>): AiProvider {
  return createAiProvider(config.get('ai', { infer: true }));
}
