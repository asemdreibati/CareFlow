import { PartialType } from '@nestjs/swagger';
import { AppointmentType, WaitlistPriority, WaitlistStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class PreferredWindowDto {
  @IsInt() @Min(0) @Max(6) weekday: number;
  @Matches(HHMM, { message: 'startTime must be HH:mm' }) startTime: string;
  @Matches(HHMM, { message: 'endTime must be HH:mm' }) endTime: string;
}

export class CreateWaitlistEntryDto {
  @IsUUID() patientId: string;
  /** Either a specific doctor or any active doctor with the given specialty (at least one is required). */
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsEnum(WaitlistPriority) priority?: WaitlistPriority;
  @IsOptional() @IsDateString() earliestAt?: string;
  @IsOptional() @IsDateString() latestAt?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(21) @ValidateNested({ each: true }) @Type(() => PreferredWindowDto)
  preferredWindows?: PreferredWindowDto[];
  @IsOptional() @IsEnum(AppointmentType) type?: AppointmentType;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateWaitlistEntryDto extends PartialType(CreateWaitlistEntryDto) {}

export class ListWaitlistQuery extends PaginationQuery {
  @IsOptional() @IsEnum(WaitlistStatus) status?: WaitlistStatus;
  @IsOptional() @IsUUID() doctorId?: string;
}

export class BookWaitlistDto {
  @IsDateString() startsAt: string;
  @IsUUID() doctorId: string;
}
