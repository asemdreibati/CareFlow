import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { DiagnosisSearchQuery, GlobalSearchQuery, RecordsSearchQuery } from './search.dto.js';
import { SearchService } from './search.service.js';

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Global search across patients, encounters, invoices and appointments. Each
   * group is only populated when the user holds that entity's read permission,
   * so the route itself needs no specific permission.
   */
  @Get()
  @Audit({ skip: true })
  global(@CurrentUser() user: AuthUser, @Query() q: GlobalSearchQuery) {
    return this.search.global(user, q);
  }

  /** ICD code / description autocomplete from diagnoses previously recorded in the clinic. */
  @Get('diagnoses')
  @RequirePermissions(Permission.RecordsRead)
  @Audit({ skip: true })
  diagnoses(@CurrentUser() user: AuthUser, @Query() q: DiagnosisSearchQuery) {
    return this.search.diagnoses(user, q);
  }
}

@ApiTags('search')
@ApiBearerAuth()
@Controller('records')
export class RecordsSearchController {
  constructor(private readonly search: SearchService) {}

  /** Paginated full-text search over encounters with rank and snippet (same scoping as GET /encounters/:id). */
  @Get('search')
  @RequirePermissions(Permission.RecordsRead)
  @Audit({ skip: true })
  records(@CurrentUser() user: AuthUser, @Query() q: RecordsSearchQuery) {
    return this.search.records(user, q);
  }
}
