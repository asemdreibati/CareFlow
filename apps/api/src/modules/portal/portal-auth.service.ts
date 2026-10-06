import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { MESSAGING_CONFIG, type MessagingConfig } from '../messaging/messaging.config.js';
import { MessagingService, withClinic } from '../messaging/messaging.service.js';
import { resolveLocale } from '../messaging/messaging.templates.js';
import { foldDigits, normalizePhone, phoneVariants } from '../messaging/phone.js';
import type { PortalJwtPayload } from './portal-auth.guard.js';
import type { RequestOtpDto, VerifyOtpDto } from './portal.dto.js';

const MINUTE = 60_000;
const INVALID_CODE = 'Invalid or expired code';

export interface PortalSession {
  accessToken: string;
  expiresIn: string;
  patient: { id: string; firstName: string; lastName: string; locale: 'ar' | 'en' };
  clinic: { name: string; slug: string; timezone: string; currency: string };
}

interface PortalPatientRow {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  locale: string | null;
  clinic: { id: string; name: string; slug: string; timezone: string; currency: string; settings: unknown };
}

/** sha256 of the code bound to the clinic + phone, so equal codes never share a hash across tenants. */
export function hashOtp(clinicId: string, phone: string, code: string): string {
  return createHash('sha256').update(`${clinicId}|${phone}|${code}`).digest('hex');
}

/**
 * Phone-OTP login for the patient portal. The request endpoint never reveals
 * whether a phone is known; codes are random 6-digit numbers stored hashed with
 * a short TTL and a bounded number of attempts, and each new request invalidates
 * the earlier unconsumed codes of the same phone + clinic.
 */
@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly messaging: MessagingService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  /** Always `{ sent: true }` (no enumeration). The code goes out by SMS through the messaging module. */
  async requestOtp(dto: RequestOtpDto): Promise<{ sent: true }> {
    const phone = normalizePhone(dto.phone, this.config.defaultCountryCode);
    if (!phone) return { sent: true };
    const patient = await this.findPortalPatient(dto.clinicSlug, phone);
    if (!patient) {
      this.logger.debug(`OTP requested for an unknown phone in clinic ${dto.clinicSlug}`);
      return { sent: true };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttl = this.config.portal.otpTtlMinutes;
    const now = new Date();
    await withClinic(patient.clinicId, async () => {
      await this.prisma.db.otpCode.updateMany({ where: { clinicId: patient.clinicId, phone, purpose: 'PORTAL_LOGIN', consumedAt: null }, data: { consumedAt: now } });
      await this.prisma.db.otpCode.create({
        data: { clinicId: patient.clinicId, phone, purpose: 'PORTAL_LOGIN', codeHash: hashOtp(patient.clinicId, phone, code), expiresAt: new Date(now.getTime() + ttl * MINUTE) },
      });
    });
    const locale = this.localeOf(patient);
    const message = await this.messaging.send({
      clinicId: patient.clinicId,
      patientId: patient.id,
      channel: 'SMS',
      to: phone,
      template: 'portal.otp',
      locale,
      params: { code, minutes: ttl, clinicName: patient.clinic.name },
    });
    if (message.status === 'FAILED') this.logger.warn(`OTP SMS to ${phone} failed: ${message.error}`);
    return { sent: true };
  }

  /** Checks the latest unconsumed code; wrong codes count as attempts until `otpMaxAttempts`. */
  async verify(dto: VerifyOtpDto): Promise<PortalSession> {
    const phone = normalizePhone(dto.phone, this.config.defaultCountryCode);
    const code = foldDigits(dto.code.trim());
    if (!phone || !/^\d{6}$/.test(code)) throw new UnauthorizedException(INVALID_CODE);
    const patient = await this.findPortalPatient(dto.clinicSlug, phone);
    if (!patient) throw new UnauthorizedException(INVALID_CODE);

    const ok = await withClinic(patient.clinicId, async () => {
      const row = await this.prisma.db.otpCode.findFirst({
        where: { clinicId: patient.clinicId, phone, purpose: 'PORTAL_LOGIN', consumedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!row || row.expiresAt.getTime() <= Date.now() || row.attempts >= this.config.portal.otpMaxAttempts) return false;
      const expected = Buffer.from(row.codeHash, 'hex');
      const given = Buffer.from(hashOtp(patient.clinicId, phone, code), 'hex');
      const match = expected.length === given.length && timingSafeEqual(expected, given);
      if (!match) {
        await this.prisma.db.otpCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
        return false;
      }
      // Consume atomically: a concurrent verify with the same code loses.
      const consumed = await this.prisma.db.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      return consumed.count === 1;
    });
    if (!ok) throw new UnauthorizedException(INVALID_CODE);
    return this.issueSession(patient);
  }

  async issueSession(patient: PortalPatientRow): Promise<PortalSession> {
    const payload: PortalJwtPayload = { sub: patient.id, clinicId: patient.clinicId, type: 'patient' };
    const expiresIn = this.config.portal.jwtExpiresIn;
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: expiresIn as JwtSignOptions['expiresIn'] });
    return {
      accessToken,
      expiresIn,
      patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName, locale: this.localeOf(patient) },
      clinic: { name: patient.clinic.name, slug: patient.clinic.slug, timezone: patient.clinic.timezone, currency: patient.clinic.currency },
    };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /** Active, portal-enabled patient with this phone in the (active) clinic. System context: the caller is anonymous. */
  private findPortalPatient(clinicSlug: string, phone: string): Promise<PortalPatientRow | null> {
    const slug = clinicSlug.trim().toLowerCase();
    if (!slug) throw new BadRequestException('clinicSlug is required');
    const variants = phoneVariants(phone, this.config.defaultCountryCode);
    return tenantContext.runSystem(() =>
      this.prisma.db.patient.findFirst({
        where: { clinic: { slug, isActive: true }, phone: { in: variants }, isActive: true, portalEnabled: true },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          clinicId: true,
          firstName: true,
          lastName: true,
          locale: true,
          clinic: { select: { id: true, name: true, slug: true, timezone: true, currency: true, settings: true } },
        },
      }),
    );
  }

  private localeOf(patient: PortalPatientRow): 'ar' | 'en' {
    const fallback = resolveLocale((patient.clinic.settings as { defaultLocale?: string } | null)?.defaultLocale);
    return resolveLocale(patient.locale, fallback);
  }
}
