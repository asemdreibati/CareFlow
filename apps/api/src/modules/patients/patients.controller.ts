import { Body, Controller, Delete, Get, HttpCode, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateAllergyDto, CreatePatientDto, UpdatePatientDto } from './patients.dto.js';
import { PatientsService } from './patients.service.js';

@ApiTags('patients')
@ApiBearerAuth()
@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get()
  @RequirePermissions(Permission.PatientsRead)
  list(@CurrentUser() user: AuthUser, @Query() q: PaginationQuery, @Query('includeInactive', new ParseBoolPipe({ optional: true })) includeInactive?: boolean) {
    return this.patients.list(user, q, includeInactive ?? false);
  }

  @Get(':id')
  @RequirePermissions(Permission.PatientsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.get(user, id);
  }

  @Get(':id/access-log')
  @RequirePermissions(Permission.AuditRead)
  accessLog(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.accessLog(user, id);
  }

  @Post()
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'patients.create', entity: 'Patient' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePatientDto) {
    return this.patients.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'patients.update', entity: 'Patient' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePatientDto) {
    return this.patients.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'patients.deactivate', entity: 'Patient' })
  deactivate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.deactivate(user, id);
  }

  @Post(':id/allergies')
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'patients.addAllergy', entity: 'Allergy' })
  addAllergy(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAllergyDto) {
    return this.patients.addAllergy(user, id, dto);
  }

  @Delete(':id/allergies/:allergyId')
  @HttpCode(204)
  @RequirePermissions(Permission.PatientsWrite)
  @Audit({ action: 'patients.removeAllergy', entity: 'Allergy' })
  removeAllergy(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('allergyId', ParseUUIDPipe) allergyId: string) {
    return this.patients.removeAllergy(user, id, allergyId);
  }
}
