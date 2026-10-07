import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateDoctorDto, CreateTimeOffDto, DoctorListQuery, SetAvailabilityDto, UpdateDoctorDto } from './doctors.dto.js';
import { DoctorsService } from './doctors.service.js';

@ApiTags('doctors')
@ApiBearerAuth()
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctors: DoctorsService) {}

  @Get()
  @RequirePermissions(Permission.DoctorsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: DoctorListQuery) {
    return this.doctors.list(user.clinicId, q, q.includeInactive);
  }

  @Get(':id')
  @RequirePermissions(Permission.DoctorsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.get(user.clinicId, id);
  }

  @Post()
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.create', entity: 'Doctor' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDoctorDto) {
    return this.doctors.create(user.clinicId, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.update', entity: 'Doctor' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDoctorDto) {
    return this.doctors.update(user.clinicId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.deactivate', entity: 'Doctor' })
  deactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.doctors.deactivate(user.clinicId, id);
  }

  @Put(':id/availability')
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.setAvailability', entity: 'Doctor' })
  setAvailability(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAvailabilityDto) {
    return this.doctors.setAvailability(user.clinicId, id, dto);
  }

  @Post(':id/time-off')
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.addTimeOff', entity: 'DoctorTimeOff' })
  addTimeOff(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTimeOffDto) {
    return this.doctors.addTimeOff(user.clinicId, id, dto);
  }

  @Delete(':id/time-off/:timeOffId')
  @HttpCode(204)
  @RequirePermissions(Permission.DoctorsWrite)
  @Audit({ action: 'doctors.removeTimeOff', entity: 'DoctorTimeOff' })
  removeTimeOff(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('timeOffId', ParseUUIDPipe) timeOffId: string) {
    return this.doctors.removeTimeOff(user.clinicId, id, timeOffId);
  }
}
