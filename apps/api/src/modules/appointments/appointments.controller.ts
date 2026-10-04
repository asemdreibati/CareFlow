import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { AvailabilityQuery, CalendarQuery, CreateAppointmentDto, ListAppointmentsQuery, SearchSlotsQuery, SetStatusDto, UpdateAppointmentDto } from './appointments.dto.js';
import { AppointmentsService } from './appointments.service.js';
import { SlotSearchService } from './slot-search.service.js';

/**
 * `If-Match: 3` (also accepts `"3"` / `W/"3"`) → 3. The body's `expectedVersion`
 * wins when both are present.
 */
export function resolveExpectedVersion(body: number | undefined, header: string | undefined): number | undefined {
  if (body !== undefined) return body;
  if (header === undefined || header.trim() === '') return undefined;
  const raw = header.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1');
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) throw new BadRequestException('If-Match must be an appointment version number');
  return version;
}

@ApiTags('appointments')
@ApiBearerAuth()
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly slotSearch: SlotSearchService,
  ) {}

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

  /** Smart slot search: ranked candidates across doctors (docs/SCHEDULING.md §1). */
  @Get('search')
  @RequirePermissions(Permission.AppointmentsRead)
  search(@CurrentUser() user: AuthUser, @Query() q: SearchSlotsQuery) {
    return this.slotSearch.search(user, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.AppointmentsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(user, id);
  }

  /**
   * 201 on creation. With an `Idempotency-Key` (header or body) that was already
   * used in this clinic: 200 + `Idempotent-Replay: true` with the original row.
   * The response is written here because the status code depends on the outcome.
   */
  @Post()
  @RequirePermissions(Permission.AppointmentsWrite)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @Audit({ action: 'appointments.create', entity: 'Appointment' })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAppointmentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() res: Response,
  ) {
    const { appointment, replayed } = await this.appointments.create(user, dto, idempotencyKey);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(replayed ? 200 : 201).json(appointment);
    return appointment;
  }

  @Patch(':id')
  @RequirePermissions(Permission.AppointmentsWrite)
  @ApiHeader({ name: 'If-Match', required: false, description: 'Expected appointment version' })
  @Audit({ action: 'appointments.update', entity: 'Appointment' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.appointments.update(user, id, dto, resolveExpectedVersion(dto.expectedVersion, ifMatch));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermissions(Permission.AppointmentsWrite)
  @ApiHeader({ name: 'If-Match', required: false, description: 'Expected appointment version' })
  @Audit({ action: 'appointments.setStatus', entity: 'Appointment' })
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetStatusDto,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.appointments.setStatus(user, id, dto, resolveExpectedVersion(dto.expectedVersion, ifMatch));
  }
}
