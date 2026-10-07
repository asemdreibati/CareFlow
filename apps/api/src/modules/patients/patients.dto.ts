import { PartialType } from '@nestjs/swagger';
import { AllergySeverity, Gender } from '@prisma/client';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CatalogueQuery } from '../../common/dto/pagination.dto.js';
import { NoNulChars } from '../search/search.validators.js';

/** GET /patients: the search text is bound into SQL, so NUL (unstorable in Postgres text) is a 400, not a 500. */
export class PatientListQuery extends CatalogueQuery {
  @IsOptional() @IsString() @MaxLength(200) @NoNulChars()
  declare search?: string;
}

export class CreatePatientDto {
  @IsString() @IsNotEmpty() firstName: string;
  @IsString() @IsNotEmpty() lastName: string;
  @IsOptional() @IsDateString() dateOfBirth?: string;
  @IsOptional() @IsEnum(Gender) gender?: Gender;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  /** Stored encrypted; only returned to users with patients:sensitive. */
  @IsOptional() @IsString() @MaxLength(64) nationalId?: string;
  @IsOptional() @IsString() @MaxLength(5) bloodType?: string;
  @IsOptional() @IsObject() emergencyContact?: { name?: string; phone?: string; relation?: string };
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdatePatientDto extends PartialType(CreatePatientDto) {
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Allow this patient to log in to the patient portal (phone OTP). */
  @IsOptional() @IsBoolean() portalEnabled?: boolean;
  /** Preferred language for messages and the portal. */
  @IsOptional() @IsIn(['ar', 'en']) locale?: 'ar' | 'en';
}

export class CreateAllergyDto {
  @IsString() @IsNotEmpty() substance: string;
  @IsOptional() @IsString() reaction?: string;
  @IsOptional() @IsEnum(AllergySeverity) severity?: AllergySeverity;
}
