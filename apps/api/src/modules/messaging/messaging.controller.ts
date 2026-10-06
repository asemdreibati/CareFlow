import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import { Permission } from '../../common/permissions/permissions.js';
import { ListMessagesQuery, SendMessageDto } from './messaging.dto.js';
import { MessagingService } from './messaging.service.js';

/** Staff view of the patient message log, plus ad-hoc messages. */
@ApiTags('messages')
@ApiBearerAuth()
@Controller('messages')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @RequirePermissions(Permission.PatientsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: ListMessagesQuery) {
    return this.messaging.list(user, q);
  }

  @Post()
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'messages.send', entity: 'Message' })
  send(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    return this.messaging.sendManual(user, dto);
  }
}
