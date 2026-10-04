import { ProposalStatus, ReminderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export class TimeOffImpactDto {
  @IsUUID() doctorId: string;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  /** Also consider free slots of other active doctors with the same specialty. */
  @IsOptional() @IsBoolean() allowOtherDoctors?: boolean;
  /** How many days after the time off to search for slots (default 14). */
  @IsOptional() @IsInt() @Min(1) @Max(60) searchDays?: number;
}

export class CreateProposalDto extends TimeOffImpactDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /** Insert the doctor_time_off row in the same transaction as the proposal. */
  @IsOptional() @IsBoolean() createTimeOff?: boolean;
}

export class ListProposalsQuery {
  @IsOptional() @IsEnum(ProposalStatus) status?: ProposalStatus;
}

export class ApplyProposalDto {
  /** Subset of the proposal's appointment ids to move (default: all unapplied items). */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) itemAppointmentIds?: string[];
}

export class AtRiskQuery {
  /** Calendar date in the clinic timezone. */
  @Matches(YYYY_MM_DD, { message: 'date must be YYYY-MM-DD' }) date: string;
  @IsOptional() @Type(() => Number) @Min(0) @Max(1) threshold?: number;
}

export class ListRemindersQuery {
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsEnum(ReminderStatus) status?: ReminderStatus;
}
