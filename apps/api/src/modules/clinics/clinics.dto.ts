import { IsEmail, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateClinicDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
