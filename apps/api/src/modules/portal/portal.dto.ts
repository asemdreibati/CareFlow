import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsEmail, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { PreferredWindowDto } from '../waitlist/waitlist.dto.js';

export const CONSENT_TYPES = ['PRIVACY', 'TREATMENT', 'MESSAGING'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export class RequestOtpDto {
  @IsString() @Length(2, 100) clinicSlug: string;
  @IsString() @Length(6, 32) phone: string;
}

export class VerifyOtpDto extends RequestOtpDto {
  @IsString() @Matches(/^[0-9٠-٩]{6}$/, { message: 'code must be 6 digits' }) code: string;
}

/** Second login step when several patients share the phone (see the verify response). */
export class SelectPatientDto {
  @IsString() @Length(10, 4000) selectionToken: string;
  @IsUUID() patientId: string;
}

export class UpdatePortalProfileDto {
  @IsOptional() @IsIn(['ar', 'en']) locale?: 'ar' | 'en';
  /** null clears the stored value. */
  @IsOptional() @IsEmail() @MaxLength(200) email?: string | null;
  /** null clears the stored value. */
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
}

export class PortalAppointmentsQuery extends PaginationQuery {
  /** `upcoming` (default) or `past`. */
  @IsOptional() @IsIn(['upcoming', 'past']) scope?: 'upcoming' | 'past';
  /** Flag form: `?upcoming` / `?past` (any value). */
  @IsOptional() @IsString() upcoming?: string;
  @IsOptional() @IsString() past?: string;
}

export class PortalSlotsQuery {
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class PortalBookDto {
  @IsUUID() doctorId: string;
  @IsDateString() startsAt: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PortalCancelDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PortalWaitlistDto {
  @IsOptional() @IsUUID() doctorId?: string;
  @IsOptional() @IsString() @MaxLength(100) specialty?: string;
  /** Only ROUTINE can be requested by patients. */
  @IsOptional() @IsIn(['ROUTINE']) priority?: 'ROUTINE';
  @IsOptional() @IsArray() @ArrayMaxSize(21) @ValidateNested({ each: true }) @Type(() => PreferredWindowDto)
  preferredWindows?: PreferredWindowDto[];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class PortalConsentDto {
  @IsIn(CONSENT_TYPES) type: ConsentType;
  @IsString() @MinLength(1) @MaxLength(50) version: string;
}
