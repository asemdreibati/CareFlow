import { AppointmentType, RecurrenceFrequency, SeriesStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const RESOLVE_POLICIES = ['skip', 'next-slot', 'fail'] as const;
export type ResolvePolicy = (typeof RESOLVE_POLICIES)[number];

export class CreateSeriesDto {
  @IsUUID() doctorId: string;
  @IsUUID() patientId: string;
  @IsEnum(RecurrenceFrequency) frequency: RecurrenceFrequency;
  @IsOptional() @IsInt() @Min(1) @Max(365) interval?: number;
  /** WEEKLY: 0 = Sunday … 6 = Saturday. */
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) byWeekday?: number[];
  /** MONTHLY: 1..31 (months without that day are skipped). */
  @IsOptional() @IsInt() @Min(1) @Max(31) byMonthDay?: number;
  @Matches(YYYY_MM_DD, { message: 'startsOn must be YYYY-MM-DD' }) startsOn: string;
  @Matches(HHMM, { message: 'startTime must be HH:mm' }) startTime: string;
  @IsInt() @Min(5) @Max(480) durationMinutes: number;
  /** Exactly one of count / until. */
  @IsOptional() @IsInt() @Min(1) @Max(365) count?: number;
  @IsOptional() @Matches(YYYY_MM_DD, { message: 'until must be YYYY-MM-DD' }) until?: string;
  @IsOptional() @IsEnum(AppointmentType) type?: AppointmentType;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** How to handle occurrences that conflict with the doctor's schedule. Default next-slot. */
  @IsOptional() @IsIn(RESOLVE_POLICIES) resolve?: ResolvePolicy;
}

export class ListSeriesQuery {
  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsEnum(SeriesStatus) status?: SeriesStatus;
}

export class UpdateSeriesDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Only CANCELLED is accepted: cancels every future, non-final occurrence. */
  @IsOptional() @IsIn(['CANCELLED']) status?: 'CANCELLED';
}
