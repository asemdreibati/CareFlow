import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MinTrimmedLength, NoNulChars } from './search.validators.js';

export class GlobalSearchQuery {
  @IsString() @MinLength(2) @MinTrimmedLength(2) @MaxLength(200) @NoNulChars()
  q: string;

  /** Max hits per entity group (default 5, max 20). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20)
  limit: number = 5;
}

export class DiagnosisSearchQuery {
  @IsString() @MinLength(1) @MinTrimmedLength(1) @MaxLength(100) @NoNulChars()
  q: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit: number = 20;
}

export class RecordsSearchQuery {
  @IsString() @MinLength(2) @MinTrimmedLength(2) @MaxLength(500) @NoNulChars()
  q: string;

  @IsOptional() @IsUUID() patientId?: string;
  @IsOptional() @IsUUID() doctorId?: string;
  /** Inclusive lower bound on `occurredAt` (ISO 8601). */
  @IsOptional() @IsDateString() from?: string;
  /** Exclusive upper bound on `occurredAt` (ISO 8601). */
  @IsOptional() @IsDateString() to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize: number = 20;

  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
}
