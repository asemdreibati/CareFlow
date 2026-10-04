import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateResourceDto, ListResourcesQuery, ResourceAvailabilityQuery, ResourceBookingsQuery, UpdateResourceDto } from './resources.dto.js';
import { ResourcesService } from './resources.service.js';

@ApiTags('resources')
@ApiBearerAuth()
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @RequirePermissions(Permission.DoctorsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: ListResourcesQuery) {
    return this.resources.list(user.clinicId, q.includeInactive ?? false);
  }

  /** Free slots common to all listed resources on one day. Declared before `:id`. */
  @Get('availability')
  @RequirePermissions(Permission.DoctorsRead)
  availability(@CurrentUser() user: AuthUser, @Query() q: ResourceAvailabilityQuery) {
    return this.resources.availability(user.clinicId, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.DoctorsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.resources.get(user.clinicId, id);
  }

  @Get(':id/bookings')
  @RequirePermissions(Permission.DoctorsRead)
  bookings(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: ResourceBookingsQuery) {
    return this.resources.bookings(user.clinicId, id, q);
  }

  @Post()
  @RequirePermissions(Permission.ResourcesWrite)
  @Audit({ action: 'resources.create', entity: 'Resource' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateResourceDto) {
    return this.resources.create(user.clinicId, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.ResourcesWrite)
  @Audit({ action: 'resources.update', entity: 'Resource' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateResourceDto) {
    return this.resources.update(user.clinicId, id, dto);
  }
}
