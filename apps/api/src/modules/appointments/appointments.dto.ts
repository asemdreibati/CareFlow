import { AppointmentStatus, AppointmentType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export class ListAppointmentsQuery extends PaginationQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsEnum(AppointmentStatus) status?: AppointmentStatus;
}

export class CalendarQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
  @IsOptional() @IsUUID() doctorId?: string;
}

export class AvailabilityQuery {
  @IsUUID() doctorId: string;
  /** Calendar date in the clinic timezone. */
  @Matches(YYYY_MM_DD, { message: 'date must be YYYY-MM-DD' }) date: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes?: number;
}

export class CreateAppointmentDto {
  @IsUUID() doctorId: string;
  @IsUUID() patientId: string;
  @IsDateString() startsAt: string;
  /** Either endsAt or durationMinutes; when both are absent the doctor's slot length is used. */
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsEnum(AppointmentType) type?: AppointmentType;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsEnum(AppointmentType) type?: AppointmentType;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class SetStatusDto {
  @IsEnum(AppointmentStatus) status: AppointmentStatus;
  @IsOptional() @IsString() @MaxLength(1000) cancellationNote?: string;
}
