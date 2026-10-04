import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQuery } from '../../common/dto/pagination.dto.js';

export class AuditQuery extends PaginationQuery {
  @IsOptional() @IsString() @MaxLength(100) entityType?: string;
  @IsOptional() @IsString() @MaxLength(100) entityId?: string;
  @IsOptional() @IsUUID() actorUserId?: string;
  /** Exact action name (e.g. `patients.update`) or a prefix such as `billing.`. */
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
