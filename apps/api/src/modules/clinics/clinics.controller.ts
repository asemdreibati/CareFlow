import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { UpdateClinicDto } from './clinics.dto.js';
import { ClinicsService } from './clinics.service.js';

@ApiTags('clinic')
@ApiBearerAuth()
@Controller('clinic')
export class ClinicsController {
  constructor(private readonly clinics: ClinicsService) {}

  @Get()
  @RequirePermissions(Permission.ClinicRead)
  get(@CurrentUser() user: AuthUser) {
    return this.clinics.get(user.clinicId);
  }

  @Patch()
  @RequirePermissions(Permission.ClinicUpdate)
  @Audit({ action: 'clinic.update', entity: 'Clinic' })
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateClinicDto) {
    return this.clinics.update(user.clinicId, dto);
  }

  @Get('stats')
  @RequirePermissions(Permission.ClinicRead)
  stats(@CurrentUser() user: AuthUser) {
    const restrictToOwn = user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
    return this.clinics.stats(user.clinicId, { ownOnly: restrictToOwn, doctorId: user.doctorId });
  }
}
