import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ROLE_PERMISSIONS } from '../../common/permissions/permissions.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { InviteMemberDto, UpdateMemberDto } from './members.dto.js';

const memberSelect = {
  id: true, role: true, extraPermissions: true, isActive: true, acceptedAt: true, createdAt: true,
  user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, lastLoginAt: true } },
} as const;

type MemberRow = Prisma.ClinicMembershipGetPayload<{ select: typeof memberSelect }>;
export type MemberStatus = 'ACTIVE' | 'INACTIVE' | 'INVITED';

/**
 * Pending invitations show only the email: until the invited person accepts, their
 * profile (name, phone, activity) belongs to them and to the clinics they work for.
 */
function toView(m: MemberRow) {
  const status: MemberStatus = !m.acceptedAt ? 'INVITED' : m.isActive ? 'ACTIVE' : 'INACTIVE';
  const user = status === 'INVITED'
    ? { id: m.user.id, email: m.user.email, firstName: '', lastName: '', phone: null, lastLoginAt: null }
    : m.user;
  return { id: m.id, role: m.role, extraPermissions: m.extraPermissions, isActive: m.isActive, status, createdAt: m.createdAt, user };
}

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(clinicId: string) {
    const rows = await this.prisma.db.clinicMembership.findMany({ where: { clinicId }, select: memberSelect, orderBy: { createdAt: 'asc' } });
    return rows.map(toView);
  }

  /**
   * Adds a staff member.
   * - New email: an account is created with the given initial password and the membership is active.
   * - Existing account (e.g. a doctor who also works elsewhere): a PENDING invitation is created; it
   *   becomes active only when that user accepts it from their own session. Nothing about the
   *   existing account is revealed to the inviting clinic.
   */
  async invite(actor: AuthUser, dto: InviteMemberDto) {
    if (dto.role === 'OWNER' && actor.role !== 'OWNER') throw new ForbiddenException('Only an owner can add another owner');
    this.assertGrantable(actor, dto.extraPermissions);
    const email = dto.email.toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, 12);

    const row = await tenantContext.runSystem(() =>
      this.prisma.transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({ where: { email } });
        if (existingUser) {
          const existing = await tx.clinicMembership.findUnique({ where: { clinicId_userId: { clinicId: actor.clinicId, userId: existingUser.id } } });
          if (existing) throw new BadRequestException('User is already a member of this clinic');
        }
        const user = existingUser ?? (await tx.user.create({ data: { email, passwordHash, firstName: dto.firstName, lastName: dto.lastName } }));
        return tx.clinicMembership.create({
          data: {
            clinicId: actor.clinicId,
            userId: user.id,
            role: dto.role,
            extraPermissions: dto.extraPermissions ?? [],
            invitedById: actor.id,
            ...(existingUser ? { isActive: false, acceptedAt: null } : { isActive: true, acceptedAt: new Date() }),
          },
          select: memberSelect,
        });
      }),
    );
    return toView(row);
  }

  async update(actor: AuthUser, membershipId: string, dto: UpdateMemberDto) {
    const target = await this.prisma.db.clinicMembership.findFirst({ where: { id: membershipId, clinicId: actor.clinicId } });
    if (!target) throw new NotFoundException('Member not found');
    const isSelf = target.userId === actor.id;
    if (isSelf && (dto.isActive === false || (dto.role && dto.role !== actor.role))) {
      throw new BadRequestException('You cannot deactivate or demote yourself');
    }
    if (isSelf && dto.extraPermissions !== undefined) {
      throw new ForbiddenException('You cannot change your own permissions');
    }
    if ((target.role === 'OWNER' || dto.role === 'OWNER') && actor.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can change owner memberships');
    }
    if (!target.acceptedAt && dto.isActive === true) {
      throw new ConflictException('This invitation has not been accepted yet');
    }
    this.assertGrantable(actor, dto.extraPermissions);

    const losesOwner = target.role === 'OWNER' && (dto.isActive === false || (dto.role !== undefined && dto.role !== 'OWNER'));
    const row = await this.prisma.transaction(async (tx) => {
      if (losesOwner) {
        // Lock the clinic's active owner rows so two owners demoting each other at the same
        // time are serialised; the second one re-reads and sees a single remaining owner.
        const owners = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM clinic_memberships
           WHERE clinic_id = ${actor.clinicId}::uuid AND role = 'OWNER' AND is_active
           FOR UPDATE`;
        if (!owners.some((o) => o.id === membershipId)) throw new ConflictException('Membership changed, please retry');
        if (owners.length <= 1) throw new BadRequestException('A clinic must keep at least one active owner');
      }
      return tx.clinicMembership.update({ where: { id: membershipId }, data: dto, select: memberSelect });
    });
    return toView(row);
  }

  /** Withdraw a pending invitation. Accepted memberships are deactivated instead (PATCH isActive=false). */
  async revokeInvitation(actor: AuthUser, membershipId: string) {
    const res = await this.prisma.db.clinicMembership.deleteMany({ where: { id: membershipId, clinicId: actor.clinicId, acceptedAt: null } });
    if (res.count !== 1) throw new NotFoundException('Pending invitation not found');
  }

  /**
   * Extra permissions are a delegation: an owner may grant anything, everyone else only
   * permissions their own role already carries (an ADMIN cannot hand out clinical
   * authoring rights that the ADMIN role deliberately lacks).
   */
  private assertGrantable(actor: AuthUser, permissions: readonly string[] | undefined) {
    if (!permissions?.length || actor.role === 'OWNER') return;
    const own = new Set<string>(ROLE_PERMISSIONS[actor.role as Role]);
    const denied = permissions.filter((p) => !own.has(p));
    if (denied.length) throw new ForbiddenException(`You cannot grant: ${denied.join(', ')}`);
  }
}
