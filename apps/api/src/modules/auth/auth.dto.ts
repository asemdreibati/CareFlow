import { IsTimeZone } from '../../common/validation/is-time-zone.js';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() password: string;
  /** Optional: pick the clinic to activate when the user belongs to several. */
  @IsOptional() @IsUUID() clinicId?: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

export class SwitchClinicDto {
  @IsUUID() clinicId: string;
}

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string;
  @IsString() @MinLength(10) @MaxLength(128)
  @Matches(/[A-Z]/, { message: 'newPassword must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'newPassword must contain a digit' })
  newPassword: string;
}

export class RegisterClinicDto {
  @IsString() @IsNotEmpty() @MaxLength(120) clinicName: string;
  @IsString() @Matches(/^[a-z0-9-]{3,40}$/, { message: 'slug must be 3-40 lowercase letters, digits or dashes' })
  slug: string;
  @IsOptional() @IsTimeZone() timezone?: string;
  @IsEmail() email: string;
  @IsString() @MinLength(10) @MaxLength(128)
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a digit' })
  password: string;
  @IsString() @IsNotEmpty() firstName: string;
  @IsString() @IsNotEmpty() lastName: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsIn(['ar', 'en']) locale?: 'ar' | 'en';
  @IsOptional() @IsString() @IsNotEmpty() firstName?: string;
  @IsOptional() @IsString() @IsNotEmpty() lastName?: string;
  @IsOptional() @IsString() phone?: string;
}

export class LogoutDto {
  @IsOptional() @IsString() @IsNotEmpty() refreshToken?: string;
}
