import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/auth/decorators.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission, ROLE_PERMISSIONS, ALL_PERMISSIONS } from '../../common/permissions/permissions.js';
import { InviteMemberDto, UpdateMemberDto } from './members.dto.js';
import { MembersService } from './members.service.js';

@ApiTags('members')
@ApiBearerAuth()
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermissions(Permission.MembersRead)
  list(@CurrentUser() user: AuthUser) {
    return this.members.list(user.clinicId);
  }

  /** Reference data for the UI: all permissions and the defaults per role. */
  @Get('permissions')
  @RequirePermissions(Permission.MembersRead)
  permissions() {
    return { all: ALL_PERMISSIONS, byRole: ROLE_PERMISSIONS };
  }

  @Post()
  @RequirePermissions(Permission.MembersManage)
  @Audit({ action: 'members.invite', entity: 'ClinicMembership' })
  invite(@CurrentUser() user: AuthUser, @Body() dto: InviteMemberDto) {
    return this.members.invite(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.MembersManage)
  @Audit({ action: 'members.update', entity: 'ClinicMembership' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(user, id, dto);
  }
}
