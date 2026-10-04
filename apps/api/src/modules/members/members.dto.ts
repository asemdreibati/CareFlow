import { Role } from '@prisma/client';
import { ArrayUnique, IsArray, IsBoolean, IsEmail, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ALL_PERMISSIONS } from '../../common/permissions/permissions.js';

export class InviteMemberDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() firstName: string;
  @IsString() @IsNotEmpty() lastName: string;
  @IsEnum(Role) role: Role;
  /** Initial password for the new account (the user should change it on first login). */
  @IsString() @MinLength(10) @MaxLength(128)
  @Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'password must contain a digit' })
  password: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(ALL_PERMISSIONS, { each: true })
  extraPermissions?: string[];
}

export class UpdateMemberDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(ALL_PERMISSIONS, { each: true })
  extraPermissions?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}
