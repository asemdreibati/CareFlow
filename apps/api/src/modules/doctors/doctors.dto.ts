import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsEmail, IsHexColor, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateDoctorDto {
  @IsString() @IsNotEmpty() firstName: string;
  @IsString() @IsNotEmpty() lastName: string;
  @IsOptional() @IsString() @MaxLength(20) title?: string;
  @IsString() @IsNotEmpty() specialty: string;
  @IsOptional() @IsString() licenseNumber?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  /** Link to an existing clinic member so they can log in as this doctor. */
  @IsOptional() @IsUUID() userId?: string;
}

export class UpdateDoctorDto extends PartialType(CreateDoctorDto) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AvailabilitySlotDto {
  @IsInt() @Min(0) @Max(6) weekday: number;
  @Matches(HHMM) startTime: string;
  @Matches(HHMM) endTime: string;
  @IsOptional() @IsInt() @Min(5) @Max(240) slotMinutes?: number;
}

export class SetAvailabilityDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => AvailabilitySlotDto)
  slots: AvailabilitySlotDto[];
}

export class CreateTimeOffDto {
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsOptional() @IsString() reason?: string;
}
