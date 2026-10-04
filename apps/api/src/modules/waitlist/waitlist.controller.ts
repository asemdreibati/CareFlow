import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import { Permission } from '../../common/permissions/permissions.js';
import { BookWaitlistDto, CreateWaitlistEntryDto, ListWaitlistQuery, UpdateWaitlistEntryDto } from './waitlist.dto.js';
import { WaitlistService } from './waitlist.service.js';

@ApiTags('waitlist')
@ApiBearerAuth()
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @RequirePermissions(Permission.AppointmentsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: ListWaitlistQuery) {
    return this.waitlist.list(user, q);
  }

  /** Slots that would satisfy the entry right now (next 14 days, earliest 20). Declared before `:id`. */
  @Get('matches/:id')
  @RequirePermissions(Permission.AppointmentsRead)
  matches(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.matches(user, id);
  }

  @Get(':id')
  @RequirePermissions(Permission.AppointmentsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.get(user, id);
  }

  @Post()
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.create', entity: 'WaitlistEntry' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWaitlistEntryDto) {
    return this.waitlist.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.update', entity: 'WaitlistEntry' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWaitlistEntryDto) {
    return this.waitlist.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.cancel', entity: 'WaitlistEntry' })
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.remove(user, id);
  }

  @Post(':id/book')
  @HttpCode(201)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.book', entity: 'WaitlistEntry' })
  book(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookWaitlistDto) {
    return this.waitlist.book(user, id, dto);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.accept', entity: 'WaitlistEntry' })
  accept(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.accept(user, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'waitlist.decline', entity: 'WaitlistEntry' })
  decline(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.waitlist.decline(user, id);
  }
}
