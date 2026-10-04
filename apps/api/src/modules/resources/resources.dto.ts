import { ResourceType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** "a,b,c" (query string) or an array → string[] */
export const commaList = ({ value }: { value: unknown }): unknown => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return value;
};

export class ListResourcesQuery {
  @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() includeInactive?: boolean;
}

export class CreateResourceDto {
  @IsString() @MaxLength(120) name: string;
  @IsEnum(ResourceType) type: ResourceType;
  @IsOptional() @Matches(HEX_COLOR, { message: 'color must be a #rrggbb value' }) color?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateResourceDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEnum(ResourceType) type?: ResourceType;
  @IsOptional() @Matches(HEX_COLOR, { message: 'color must be a #rrggbb value' }) color?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ResourceBookingsQuery {
  @IsDateString() from: string;
  @IsDateString() to: string;
}

export class ResourceAvailabilityQuery {
  @Transform(commaList) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID('all', { each: true }) resourceIds: string[];
  /** Calendar date in the clinic timezone. */
  @Matches(YYYY_MM_DD, { message: 'date must be YYYY-MM-DD' }) date: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes?: number;
}
