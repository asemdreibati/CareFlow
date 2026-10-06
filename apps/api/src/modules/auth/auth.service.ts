import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { ClinicMembership, Role, User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { resolvePermissions } from '../../common/permissions/permissions.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { AuthUser, JwtPayload } from '../../common/auth/auth-user.js';
import type { Env } from '../../config/env.js';
import type { ChangePasswordDto, LoginDto, RegisterClinicDto, UpdateProfileDto } from './auth.dto.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface SessionInfo {
  user: { id: string; email: string; firstName: string; lastName: string; locale: string | null };
  clinic: { id: string; name: string; slug: string; timezone: string; currency: string };
  role: Role;
  doctorId?: string;
  permissions: string[];
  clinics: { id: string; name: string; slug: string; role: Role }[];
}

const BCRYPT_ROUNDS = 12;

function parseDurationMs(value: string): number {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (!m) return 7 * 24 * 3600 * 1000;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Self-service provisioning: creates a clinic and its first OWNER in one transaction. */
  async registerClinic(dto: RegisterClinicDto): Promise<{ tokens: TokenPair; session: SessionInfo }> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const email = dto.email.toLowerCase();

    const { user, membership } = await tenantContext.runSystem(() =>
      this.prisma.transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({ where: { email } });
        const existingSlug = await tx.clinic.findUnique({ where: { slug: dto.slug } });
        if (existingSlug) throw new ConflictException('Clinic slug is already taken');
        if (existingUser) throw new ConflictException('An account with this email already exists');

        const clinic = await tx.clinic.create({
          data: { name: dto.clinicName, slug: dto.slug, timezone: dto.timezone ?? 'UTC' },
        });
        const user = await tx.user.create({
          data: { email, passwordHash, firstName: dto.firstName, lastName: dto.lastName },
        });
        const membership = await tx.clinicMembership.create({
          data: { clinicId: clinic.id, userId: user.id, role: 'OWNER' },
          include: { clinic: true },
        });
        return { user, membership };
      }),
    );
    return this.issueSession(user, membership.clinicId);
  }

  async login(dto: LoginDto): Promise<{ tokens: TokenPair; session: SessionInfo }> {
    const email = dto.email.toLowerCase();
    const user = await tenantContext.runSystem(() =>
      this.prisma.db.user.findUnique({
        where: { email },
        include: { memberships: { where: { isActive: true, clinic: { isActive: true } } } },
      }),
    );
    // Constant-time-ish: always run bcrypt even when the user does not exist.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok || !user.isActive) throw new UnauthorizedException('Invalid credentials');
    if (user.memberships.length === 0) throw new UnauthorizedException('No active clinic membership');

    const clinicId = dto.clinicId ?? user.memberships[0].clinicId;
    if (!user.memberships.some((m) => m.clinicId === clinicId)) {
      throw new UnauthorizedException('Not a member of the requested clinic');
    }
    await tenantContext.runSystem(() =>
      this.prisma.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
    );
    return this.issueSession(user, clinicId);
  }

  async refresh(refreshToken: string): Promise<{ tokens: TokenPair; session: SessionInfo }> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await tenantContext.runSystem(() =>
      this.prisma.db.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } }),
    );
    if (!stored || stored.revokedAt || stored.expiresAt < new Date() || !stored.user.isActive) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    const [, clinicId] = refreshToken.split('.'); // token = <random>.<clinicId>
    if (!clinicId) throw new UnauthorizedException('Malformed refresh token');

    // Rotate: revoke the used token, issue a new pair.
    await tenantContext.runSystem(() =>
      this.prisma.db.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
    );
    return this.issueSession(stored.user, clinicId);
  }

  async logout(refreshToken: string | undefined, userId: string): Promise<void> {
    await tenantContext.runSystem(async () => {
      if (refreshToken) {
        await this.prisma.db.refreshToken.updateMany({
          where: { tokenHash: this.hashToken(refreshToken), userId },
          data: { revokedAt: new Date() },
        });
      } else {
        await this.prisma.db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
    });
  }

  async switchClinic(user: AuthUser, clinicId: string): Promise<{ tokens: TokenPair; session: SessionInfo }> {
    const dbUser = await tenantContext.runSystem(() => this.prisma.db.user.findUniqueOrThrow({ where: { id: user.id } }));
    const membership = await tenantContext.runSystem(() =>
      this.prisma.db.clinicMembership.findFirst({ where: { userId: user.id, clinicId, isActive: true } }),
    );
    if (!membership) throw new UnauthorizedException('Not a member of the requested clinic');
    return this.issueSession(dbUser, clinicId);
  }

  async me(user: AuthUser): Promise<SessionInfo> {
    const dbUser = await tenantContext.runSystem(() => this.prisma.db.user.findUniqueOrThrow({ where: { id: user.id } }));
    return this.buildSession(dbUser, user.clinicId);
  }

  /** Profile fields the user may change about themselves (UI language, name, phone). */
  async updateProfile(user: AuthUser, dto: UpdateProfileDto): Promise<SessionInfo> {
    const updated = await tenantContext.runSystem(() => this.prisma.db.user.update({ where: { id: user.id }, data: dto }));
    return this.buildSession(updated, user.clinicId);
  }

  async changePassword(user: AuthUser, dto: ChangePasswordDto): Promise<void> {
    const dbUser = await tenantContext.runSystem(() => this.prisma.db.user.findUniqueOrThrow({ where: { id: user.id } }));
    if (!(await bcrypt.compare(dto.currentPassword, dbUser.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await tenantContext.runSystem(async () => {
      await this.prisma.db.user.update({ where: { id: user.id }, data: { passwordHash } });
      await this.prisma.db.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async issueSession(user: User, clinicId: string): Promise<{ tokens: TokenPair; session: SessionInfo }> {
    const session = await this.buildSession(user, clinicId);
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      clinicId,
      role: session.role,
      doctorId: session.doctorId,
      type: 'access',
    };
    const accessToken = await this.jwt.signAsync(payload);
    const refreshToken = await this.createRefreshToken(user.id, clinicId);
    return {
      tokens: { accessToken, refreshToken, expiresIn: this.config.get('jwtExpiresIn', { infer: true }) },
      session,
    };
  }

  private async buildSession(user: User, clinicId: string): Promise<SessionInfo> {
    return tenantContext.runSystem(async () => {
      const memberships = await this.prisma.db.clinicMembership.findMany({
        where: { userId: user.id, isActive: true, clinic: { isActive: true } },
        include: { clinic: true },
        orderBy: { createdAt: 'asc' },
      });
      const active = memberships.find((m) => m.clinicId === clinicId) as (ClinicMembership & { clinic: { id: string; name: string; slug: string; timezone: string; currency: string } }) | undefined;
      if (!active) throw new UnauthorizedException('Not a member of the requested clinic');
      const doctor = await this.prisma.db.doctor.findFirst({
        where: { clinicId, userId: user.id, isActive: true },
        select: { id: true },
      });
      return {
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, locale: user.locale ?? null },
        clinic: {
          id: active.clinic.id,
          name: active.clinic.name,
          slug: active.clinic.slug,
          timezone: active.clinic.timezone,
          currency: active.clinic.currency,
        },
        role: active.role,
        doctorId: doctor?.id,
        permissions: [...resolvePermissions(active.role, active.extraPermissions)],
        clinics: memberships.map((m) => ({ id: m.clinic.id, name: m.clinic.name, slug: m.clinic.slug, role: m.role })),
      };
    });
  }

  private async createRefreshToken(userId: string, clinicId: string): Promise<string> {
    const token = `${randomBytes(48).toString('base64url')}.${clinicId}`;
    const ttl = parseDurationMs(this.config.get('jwtRefreshExpiresIn', { infer: true }));
    await tenantContext.runSystem(() =>
      this.prisma.db.refreshToken.create({
        data: { userId, tokenHash: this.hashToken(token), expiresAt: new Date(Date.now() + ttl) },
      }),
    );
    return token;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
