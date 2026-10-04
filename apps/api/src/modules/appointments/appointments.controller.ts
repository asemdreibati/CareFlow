import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { AvailabilityQuery, CalendarQuery, CreateAppointmentDto, ListAppointmentsQuery, SetStatusDto, UpdateAppointmentDto } from './appointments.dto.js';
import { AppointmentsService } from './appointments.service.js';

@ApiTags('appointments')
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @RequirePermissions(Permission.AppointmentsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: ListAppointmentsQuery) {
    return this.appointments.list(user, q);
  }

  /** Unpaginated range (max 31 days) for calendar views. Declared before `:id`. */
  @Get('calendar')
  @RequirePermissions(Permission.AppointmentsRead)
  calendar(@CurrentUser() user: AuthUser, @Query() q: CalendarQuery) {
    return this.appointments.calendar(user, q);
  }

  @Get('availability')
  @RequirePermissions(Permission.AppointmentsRead)
  availability(@CurrentUser() user: AuthUser, @Query() q: AvailabilityQuery) {
    return this.appointments.availability(user, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.AppointmentsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(user, id);
  }

  @Post()
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'appointments.create', entity: 'Appointment' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAppointmentDto) {
    return this.appointments.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'appointments.update', entity: 'Appointment' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAppointmentDto) {
    return this.appointments.update(user, id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @Audit({ action: 'appointments.setStatus', entity: 'Appointment' })
  setStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStatusDto) {
    return this.appointments.setStatus(user, id, dto);
  }
}
