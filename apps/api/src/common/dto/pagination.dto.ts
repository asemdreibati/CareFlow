import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class PaginationQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize: number = 25;

  @IsOptional() @IsString()
  search?: string;

  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paginate<T>(items: T[], total: number, q: PaginationQuery): Paginated<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Pagination plus an `includeInactive` flag for catalogues with soft-deleted rows. */
export class CatalogueQuery extends PaginationQuery {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeInactive: boolean = false;
}
