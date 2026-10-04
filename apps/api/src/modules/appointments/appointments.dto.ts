import { AppointmentStatus, AppointmentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

/** "a,b,c" (query string) or an array → string[] */
const commaList = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return value;
};

/** JSON-encoded query parameter → parsed value (invalid JSON is left as the raw string so validation fails). */
const jsonValue = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

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

/** Wall-clock window in the clinic timezone (element of `preferredWindows`). Validated in the service. */
export interface PreferredWindowInput {
  weekday: number;
  startTime: string;
  endTime: string;
}

/** `GET /appointments/search` (docs/SCHEDULING.md §1). */
export class SearchSlotsQuery {
  @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes: number;
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string;
  /** Defaults to now. */
  @IsOptional() @IsDateString() from?: string;
  /** Defaults to from + 14 days; at most 60 days after from. */
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() preferredDoctorId?: string;
  /** JSON-encoded `[{ weekday, startTime, endTime }]`. */
  @IsOptional() @Transform(jsonValue) @IsArray() @ArrayMaxSize(21) preferredWindows?: PreferredWindowInput[];
  /** Comma-separated resource ids that the slot must have free. */
  @IsOptional() @Transform(commaList) @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) resourceIds?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit: number = 10;
  /** When given, the patient's own appointments are treated as busy time. */
  @IsOptional() @IsUUID() patientId?: string;
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
  /** Rooms / equipment to book together with the appointment. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) resourceIds?: string[];
  /** Same as the `Idempotency-Key` header: retries with the same key return the original appointment. */
  @IsOptional() @IsString() @MaxLength(200) idempotencyKey?: string;
}

export class UpdateAppointmentDto {
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @IsEnum(AppointmentType) type?: AppointmentType;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  /** Replaces the booked resources (empty array releases them all). Omit to keep the current set. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) resourceIds?: string[];
  /** Optimistic locking (same as the `If-Match` header): the version the client last read. */
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

export class SetStatusDto {
  @IsEnum(AppointmentStatus) status: AppointmentStatus;
  @IsOptional() @IsString() @MaxLength(1000) cancellationNote?: string;
  /** Optimistic locking (same as the `If-Match` header). */
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
