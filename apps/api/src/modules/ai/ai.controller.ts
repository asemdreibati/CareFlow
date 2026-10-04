import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { ListInteractionsQuery, ReviewInteractionDto, SoapNoteDto } from './ai.dto.js';
import { AiService } from './ai.service.js';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** ai:use OR ai:review - checked in the handler because the guard requires ALL listed permissions. */
  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    this.ai.assertAiAccess(user);
    return this.ai.status();
  }

  @Post('patients/:patientId/summary')
  @RequirePermissions(Permission.AiUse)
  @Audit({ action: 'ai.summary', entity: 'AiInteraction' })
  summary(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.ai.patientSummary(user, patientId);
  }

  @Post('encounters/:encounterId/soap-note')
  @RequirePermissions(Permission.AiUse)
  @Audit({ action: 'ai.soapNote', entity: 'AiInteraction' })
  soapNote(@CurrentUser() user: AuthUser, @Param('encounterId', ParseUUIDPipe) encounterId: string, @Body() dto: SoapNoteDto) {
    return this.ai.soapNote(user, encounterId, dto);
  }

  @Post('interactions/:id/review')
  @HttpCode(200)
  @RequirePermissions(Permission.AiReview)
  @Audit({ action: 'ai.review', entity: 'AiInteraction' })
  review(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewInteractionDto) {
    return this.ai.review(user, id, dto);
  }

  /** ai:use OR ai:review. */
  @Get('interactions')
  list(@CurrentUser() user: AuthUser, @Query() q: ListInteractionsQuery) {
    this.ai.assertAiAccess(user);
    return this.ai.list(user, q);
  }
}
