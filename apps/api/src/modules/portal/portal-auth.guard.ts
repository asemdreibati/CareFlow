import { applyDecorators, CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';

/** Claims of a patient-portal token. */
export interface PortalJwtPayload {
  sub: string;
  clinicId: string;
  type: 'patient';
}

/** The authenticated patient, attached to the request as `req.patient`. */
export interface PortalPatient {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  locale: string | null;
  clinic: { id: string; name: string; slug: string; timezone: string; currency: string; settings: unknown };
}

/**
 * Patient-portal authentication: a JWT of `type: 'patient'` (issued by the OTP
 * flow) is verified, the patient re-loaded (must be active with the portal
 * enabled in an active clinic) and the tenant context switched to the clinic
 * so RLS applies to every query of the request.
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { patient?: PortalPatient }>();
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedException('Missing portal token');

    let payload: PortalJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<PortalJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired portal token');
    }
    if (payload.type !== 'patient' || !payload.sub || !payload.clinicId) throw new UnauthorizedException('Invalid portal token');

    const patient = await tenantContext.runSystem(() =>
      this.prisma.db.patient.findFirst({
        where: { id: payload.sub, clinicId: payload.clinicId, isActive: true, portalEnabled: true },
        select: {
          id: true,
          clinicId: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          locale: true,
          clinic: { select: { id: true, name: true, slug: true, timezone: true, currency: true, settings: true, isActive: true } },
        },
      }),
    );
    if (!patient || !patient.clinic.isActive) throw new UnauthorizedException('Portal access is not available for this account');

    const { clinic, ...rest } = patient;
    req.patient = { ...rest, clinic: { id: clinic.id, name: clinic.name, slug: clinic.slug, timezone: clinic.timezone, currency: clinic.currency, settings: clinic.settings } };
    // RLS for the rest of the request: the clinic, no staff user.
    tenantContext.assign({ clinicId: patient.clinicId, patientId: patient.id, userId: undefined, email: undefined, role: undefined, permissions: undefined, doctorId: undefined });
    return true;
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim() || null;
  return null;
}

/** Marks a handler/controller as a patient-portal route: skips the staff JWT guard and applies the portal guard. */
export const PortalRoute = () => applyDecorators(Public(), UseGuards(PortalAuthGuard));

/** Injects the authenticated patient (set by `PortalAuthGuard`). */
export const CurrentPatient = createParamDecorator((data: keyof PortalPatient | undefined, ctx: ExecutionContext) => {
  const patient = ctx.switchToHttp().getRequest().patient as PortalPatient;
  return data ? patient?.[data] : patient;
});
