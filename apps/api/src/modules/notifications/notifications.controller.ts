import { Controller, Get, HttpCode, Param, ParseBoolPipe, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { NotificationsService } from './notifications.service.js';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Latest 50 notifications of the caller plus the unread count. */
  @Get()
  @RequirePermissions(Permission.NotificationsRead)
  list(@CurrentUser() user: AuthUser, @Query('unreadOnly', new ParseBoolPipe({ optional: true })) unreadOnly?: boolean) {
    return this.notifications.list(user, unreadOnly ?? false);
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermissions(Permission.NotificationsRead)
  @Audit({ skip: true })
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermissions(Permission.NotificationsRead)
  @Audit({ skip: true })
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user, id);
  }
}
