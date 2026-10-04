import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_PROVIDER_TOKEN } from './ai-provider.js';
import { aiProviderFromConfig } from './ai-provider.factory.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';

/**
 * AI assistance (pre-visit summaries, SOAP drafts). The vendor is chosen once at
 * boot from the `ai` config block; tests swap it via `overrideProvider(AI_PROVIDER_TOKEN)`.
 */
@Module({
  controllers: [AiController],
  providers: [AiService, { provide: AI_PROVIDER_TOKEN, inject: [ConfigService], useFactory: aiProviderFromConfig }],
  exports: [AiService, AI_PROVIDER_TOKEN],
})
export class AiModule {}
