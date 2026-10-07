import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolvePermissions } from '../permissions/permissions.js';
import { tenantContext } from '../tenancy/tenant-context.js';
import type { AuthUser, JwtPayload } from './auth-user.js';
import type { Env } from '../../config/env.js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      // Header only: tokens in URLs end up in proxy logs and audit paths. The WebSocket
      // gateway authenticates its handshake separately.
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('jwtSecret', { infer: true }),
    });
  }

  /**
   * Re-validates the membership on every request so revoked access takes effect
   * immediately (not only at token expiry). Permissions are resolved fresh too.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    if ((payload as { type?: string }).type === 'patient') {
      throw new UnauthorizedException('Patient portal tokens cannot access staff endpoints');
    }
    if (payload.type !== 'access') throw new UnauthorizedException('Invalid token type');

    const [membership, doctor] = await tenantContext.runSystem(() =>
      Promise.all([
        this.prisma.db.clinicMembership.findFirst({
          where: { userId: payload.sub, clinicId: payload.clinicId, isActive: true, acceptedAt: { not: null } },
          include: {
            user: { select: { isActive: true, email: true } },
            clinic: { select: { isActive: true } },
          },
        }),
        // The doctor profile is resolved fresh on every request (never trusted from the
        // token) so unlinking or deactivating a profile takes effect immediately.
        this.prisma.db.doctor.findFirst({
          where: { clinicId: payload.clinicId, userId: payload.sub, isActive: true },
          select: { id: true },
        }),
      ]),
    );
    if (!membership || !membership.user.isActive || !membership.clinic.isActive) {
      throw new UnauthorizedException('Membership is no longer active');
    }

    const user: AuthUser = {
      id: payload.sub,
      email: membership.user.email,
      clinicId: payload.clinicId,
      role: membership.role,
      doctorId: doctor?.id,
      permissions: resolvePermissions(membership.role, membership.extraPermissions),
    };

    // Activate RLS for the rest of this request.
    tenantContext.assign({
      clinicId: user.clinicId,
      userId: user.id,
      email: user.email,
      role: user.role,
      doctorId: user.doctorId,
      permissions: user.permissions,
    });
    return user;
  }
}
