import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { CreateDiagnosisDto, CreateEncounterDto, CreatePrescriptionDto, UpdateEncounterDto, UpdatePrescriptionStatusDto } from './records.dto.js';
import { RecordsService } from './records.service.js';

/** Encounters in the context of a patient: `/patients/:patientId/encounters`. */
@ApiTags('records')
@ApiBearerAuth()
@Controller('patients/:patientId/encounters')
export class PatientEncountersController {
  constructor(private readonly records: RecordsService) {}

  @Get()
  @RequirePermissions(Permission.RecordsRead)
  list(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @Query() q: PaginationQuery) {
    return this.records.listForPatient(user, patientId, q);
  }

  @Post()
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'encounters.create', entity: 'Encounter' })
  create(@CurrentUser() user: AuthUser, @Param('patientId', ParseUUIDPipe) patientId: string, @Body() dto: CreateEncounterDto) {
    return this.records.create(user, patientId, dto);
  }
}

@ApiTags('records')
@ApiBearerAuth()
@Controller('encounters')
export class EncountersController {
  constructor(private readonly records: RecordsService) {}

  @Get(':id')
  @RequirePermissions(Permission.RecordsRead)
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.get(user, id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'encounters.update', entity: 'Encounter' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEncounterDto) {
    return this.records.update(user, id, dto);
  }

  @Post(':id/sign')
  @HttpCode(200)
  @RequirePermissions(Permission.RecordsSign)
  @Audit({ action: 'encounters.sign', entity: 'Encounter' })
  sign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.records.sign(user, id);
  }

  @Post(':id/diagnoses')
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'encounters.addDiagnosis', entity: 'Diagnosis' })
  addDiagnosis(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateDiagnosisDto) {
    return this.records.addDiagnosis(user, id, dto);
  }

  @Delete(':id/diagnoses/:dxId')
  @HttpCode(204)
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'encounters.removeDiagnosis', entity: 'Diagnosis' })
  removeDiagnosis(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('dxId', ParseUUIDPipe) dxId: string) {
    return this.records.removeDiagnosis(user, id, dxId);
  }

  @Post(':id/prescriptions')
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'encounters.addPrescription', entity: 'Prescription' })
  addPrescription(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePrescriptionDto) {
    return this.records.addPrescription(user, id, dto);
  }
}

@ApiTags('records')
@ApiBearerAuth()
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private readonly records: RecordsService) {}

  @Patch(':id')
  @RequirePermissions(Permission.RecordsWrite)
  @Audit({ action: 'prescriptions.updateStatus', entity: 'Prescription' })
  updateStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrescriptionStatusDto) {
    return this.records.updatePrescriptionStatus(user, id, dto.status);
  }
}
