import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { NoShowService } from './no-show.service.js';
import { RemindersService } from './reminders.service.js';
import { RescheduleService } from './reschedule.service.js';
import { ApplyProposalDto, AtRiskQuery, CreateProposalDto, ListProposalsQuery, ListRemindersQuery, TimeOffImpactDto } from './scheduling.dto.js';

@ApiTags('scheduling')
@ApiBearerAuth()
@Controller('scheduling')
@RequirePermissions(Permission.SchedulingManage)
export class SchedulingController {
  constructor(
    private readonly reschedule: RescheduleService,
    private readonly noShow: NoShowService,
    private readonly reminders: RemindersService,
  ) {}

  // ─────────────────────────────── reschedule cascade ───────────────────────────────

  /** Preview: affected appointments and a (non-persisted) proposal for a planned time off. */
  @Post('time-off-impact')
  @HttpCode(200)
  @Audit({ skip: true })
  timeOffImpact(@CurrentUser() user: AuthUser, @Body() dto: TimeOffImpactDto) {
    return this.reschedule.timeOffImpact(user, dto);
  }

  @Post('reschedule-proposals')
  @Audit({ action: 'scheduling.createProposal', entity: 'RescheduleProposal' })
  createProposal(@CurrentUser() user: AuthUser, @Body() dto: CreateProposalDto) {
    return this.reschedule.createProposal(user, dto);
  }

  @Get('reschedule-proposals')
  listProposals(@CurrentUser() user: AuthUser, @Query() q: ListProposalsQuery) {
    return this.reschedule.list(user, q.status);
  }

  @Get('reschedule-proposals/:id')
  getProposal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reschedule.get(user, id);
  }

  @Post('reschedule-proposals/:id/apply')
  @HttpCode(200)
  @Audit({ action: 'scheduling.applyProposal', entity: 'RescheduleProposal' })
  applyProposal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyProposalDto) {
    return this.reschedule.apply(user, id, dto);
  }

  @Post('reschedule-proposals/:id/dismiss')
  @HttpCode(200)
  @Audit({ action: 'scheduling.dismissProposal', entity: 'RescheduleProposal' })
  dismissProposal(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reschedule.dismiss(user, id);
  }

  // ─────────────────────────────── no-show prediction ───────────────────────────────

  @Post('no-show-model/train')
  @HttpCode(200)
  @Audit({ action: 'scheduling.trainNoShowModel', entity: 'NoShowModel' })
  trainNoShowModel(@CurrentUser() user: AuthUser) {
    return this.noShow.train(user.clinicId);
  }

  @Get('no-show-model')
  getNoShowModel(@CurrentUser() user: AuthUser) {
    return this.noShow.get(user);
  }

  @Get('no-show/at-risk')
  atRisk(@CurrentUser() user: AuthUser, @Query() q: AtRiskQuery) {
    return this.noShow.atRisk(user, q.date, q.threshold);
  }

  // ─────────────────────────────── reminders ───────────────────────────────

  @Get('reminders')
  listReminders(@CurrentUser() user: AuthUser, @Query() q: ListRemindersQuery) {
    return this.reminders.list(user, q);
  }
}
