import { InvoiceStatus, PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';
import { NoNulChars } from '../search/search.validators.js';
import { MAX_MONEY } from './invoice-math.js';

const MONEY = { maxDecimalPlaces: 2 } as const;

// ───────────────────────────── services (price list) ─────────────────────────────

export class CreateServiceDto {
  @IsString() @Matches(/^[A-Za-z0-9-_.]{1,32}$/, { message: 'code must be 1-32 letters, digits, dashes, dots or underscores' })
  code: string;
  @IsString() @IsNotEmpty() @MaxLength(200) name: string;
  @IsNumber(MONEY) @Min(0) @Max(MAX_MONEY) price: number;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
}

export class UpdateServiceDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9-_.]{1,32}$/, { message: 'code must be 1-32 letters, digits, dashes, dots or underscores' })
  code?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(MAX_MONEY) price?: number;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMinutes?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ─────────────────────────────────── invoices ───────────────────────────────────

export class InvoiceItemDto {
  /** Price-list entry; description and unitPrice default from it. */
  @IsOptional() @IsUUID() serviceId?: string;
  /** Required for free-text lines. */
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(500) description?: string;
  @IsInt() @Min(1) @Max(10_000) quantity: number;
  /** Overrides the service price; required for free-text lines. */
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(MAX_MONEY) unitPrice?: number;
}

export class UpdateInvoiceDto {
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  items?: InvoiceItemDto[];
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(MAX_MONEY) discount?: number;
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(MAX_MONEY) tax?: number;
  @IsOptional() @IsDateString() dueAt?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class CreateInvoiceDto extends UpdateInvoiceDto {
  @IsUUID() patientId: string;
  @IsOptional() @IsUUID() appointmentId?: string;
  @IsOptional() @IsUUID() encounterId?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceItemDto)
  declare items: InvoiceItemDto[];
}

export class InvoiceListQuery extends PaginationQuery {
  @IsOptional() @IsString() @MaxLength(200) @NoNulChars()
  declare search?: string;
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @IsUUID() patientId?: string;
}

// ─────────────────────────────────── payments ───────────────────────────────────

export class CreatePaymentDto {
  @IsNumber(MONEY) @IsPositive() @Max(MAX_MONEY) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @IsOptional() @IsDateString() paidAt?: string;
}

// ─────────────────────────────────── summary ───────────────────────────────────

export class SummaryQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
