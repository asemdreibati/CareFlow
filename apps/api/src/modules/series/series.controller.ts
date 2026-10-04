import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateSeriesDto, ListSeriesQuery, UpdateSeriesDto } from './series.dto.js';
import { SeriesService } from './series.service.js';

@ApiTags('series')
@ApiBearerAuth()
@Controller('series')
export class SeriesController {
  constructor(private readonly series: SeriesService) {}

  @Get()
  @RequirePermissions(Permission.AppointmentsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: ListSeriesQuery) {
    return this.series.list(user, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.AppointmentsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.series.get(user, id);
  }

  @Post()
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'series.create', entity: 'AppointmentSeries' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSeriesDto) {
    return this.series.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'series.update', entity: 'AppointmentSeries' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSeriesDto) {
    return this.series.update(user, id, dto);
  }

  @Post(':id/occurrences/:index/detach')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'series.detach', entity: 'Appointment' })
  detach(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('index', ParseIntPipe) index: number) {
    return this.series.detach(user, id, index);
  }
}
