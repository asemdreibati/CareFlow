import { PartialType } from '@nestjs/swagger';
import { AllergySeverity, Gender } from '@prisma/client';
import { IsBoolean, IsDateString, IsEmail, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

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
}

export class CreateAllergyDto {
  @IsString() @IsNotEmpty() substance: string;
  @IsOptional() @IsString() reaction?: string;
  @IsOptional() @IsEnum(AllergySeverity) severity?: AllergySeverity;
}
