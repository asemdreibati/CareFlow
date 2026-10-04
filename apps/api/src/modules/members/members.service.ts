import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { InviteMemberDto, UpdateMemberDto } from './members.dto.js';

const memberSelect = {
  id: true, role: true, extraPermissions: true, isActive: true, createdAt: true,
  user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, lastLoginAt: true } },
} as const;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  list(clinicId: string) {
    return this.prisma.db.clinicMembership.findMany({ where: { clinicId }, select: memberSelect, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Adds a staff member. If the email already has an account (e.g. a doctor who
   * works at another clinic), the existing account is linked; otherwise one is created.
   */
  async invite(actor: AuthUser, dto: InviteMemberDto) {
    if (dto.role === 'OWNER' && actor.role !== 'OWNER') throw new ForbiddenException('Only an owner can add another owner');
    const email = dto.email.toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, 12);

    return tenantContext.runSystem(() =>
      this.prisma.transaction(async (tx) => {
        const user =
          (await tx.user.findUnique({ where: { email } })) ??
          (await tx.user.create({ data: { email, passwordHash, firstName: dto.firstName, lastName: dto.lastName } }));
        const existing = await tx.clinicMembership.findUnique({ where: { clinicId_userId: { clinicId: actor.clinicId, userId: user.id } } });
        if (existing) throw new BadRequestException('User is already a member of this clinic');
        return tx.clinicMembership.create({
          data: { clinicId: actor.clinicId, userId: user.id, role: dto.role, extraPermissions: dto.extraPermissions ?? [] },
          select: memberSelect,
        });
      }),
    );
  }

  async update(actor: AuthUser, membershipId: string, dto: UpdateMemberDto) {
    const target = await this.prisma.db.clinicMembership.findFirst({ where: { id: membershipId, clinicId: actor.clinicId } });
    if (!target) throw new NotFoundException('Member not found');
    if (target.userId === actor.id && (dto.isActive === false || (dto.role && dto.role !== actor.role))) {
      throw new BadRequestException('You cannot deactivate or demote yourself');
    }
    if ((target.role === 'OWNER' || dto.role === 'OWNER') && actor.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can change owner memberships');
    }
    if (target.role === 'OWNER' && (dto.isActive === false || (dto.role && dto.role !== 'OWNER'))) {
      const owners = await this.prisma.db.clinicMembership.count({ where: { clinicId: actor.clinicId, role: 'OWNER', isActive: true } });
      if (owners <= 1) throw new BadRequestException('A clinic must keep at least one active owner');
    }
    return this.prisma.db.clinicMembership.update({ where: { id: membershipId }, data: dto, select: memberSelect });
  }
}
