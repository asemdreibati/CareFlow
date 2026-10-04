import { PrescriptionStatus } from '@prisma/client';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class UpdateEncounterDto {
  @IsOptional() @IsDateString() occurredAt?: string;
  @IsOptional() @IsString() @MaxLength(1000) chiefComplaint?: string;
  @IsOptional() @IsString() @MaxLength(20000) subjective?: string;
  @IsOptional() @IsString() @MaxLength(20000) objective?: string;
  @IsOptional() @IsString() @MaxLength(20000) assessment?: string;
  @IsOptional() @IsString() @MaxLength(20000) plan?: string;
  /** Free-form measurements, e.g. { bp: "120/80", hr: 72, tempC: 36.8 }. */
  @IsOptional() @IsObject() vitals?: Record<string, unknown>;
}

export class CreateEncounterDto extends UpdateEncounterDto {
  /** Link to the visit's appointment (same clinic and patient; one encounter per appointment). */
  @IsOptional() @IsUUID() appointmentId?: string;
  /** Required when the caller is not a doctor (e.g. a NURSE documenting for a doctor). */
  @IsOptional() @IsUUID() doctorId?: string;
}

export class CreateDiagnosisDto {
  /** ICD-10 code. */
  @IsString() @IsNotEmpty() @MaxLength(16) code: string;
  @IsString() @IsNotEmpty() @MaxLength(500) description: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class CreatePrescriptionDto {
  @IsString() @IsNotEmpty() @MaxLength(200) medication: string;
  @IsString() @IsNotEmpty() @MaxLength(200) dosage: string;
  @IsString() @IsNotEmpty() @MaxLength(200) frequency: string;
  @IsOptional() @IsInt() @Min(1) durationDays?: number;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
}

export class UpdatePrescriptionStatusDto {
  @IsEnum(PrescriptionStatus) status: PrescriptionStatus;
}
