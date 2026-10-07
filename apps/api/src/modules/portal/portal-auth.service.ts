import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { MESSAGING_CONFIG, type MessagingConfig } from '../messaging/messaging.config.js';
import { MessagingService, withClinic } from '../messaging/messaging.service.js';
import { resolveLocale } from '../messaging/messaging.templates.js';
import { findClinicPatientsByPhone } from '../messaging/patient-phone-lookup.js';
import { foldDigits, normalizePhone, phoneDigitVariants } from '../messaging/phone.js';
import type { PortalJwtPayload } from './portal-auth.guard.js';
import { maskPatientName, padLatency } from './portal-auth.util.js';
import type { RequestOtpDto, SelectPatientDto, VerifyOtpDto } from './portal.dto.js';

const MINUTE = 60_000;
const INVALID_CODE = 'Invalid or expired code';
const INVALID_SELECTION = 'Invalid or expired selection';
const PURPOSE = 'PORTAL_LOGIN' as const;
/** The selection step must follow the verification closely. */
const SELECTION_TTL = '5m';

export interface PortalSession {
  accessToken: string;
  expiresIn: string;
  patient: { id: string; firstName: string; lastName: string; locale: 'ar' | 'en' };
  clinic: { name: string; slug: string; timezone: string; currency: string };
}

/** Returned by `verify` when several portal-enabled patients share the phone: the patient picks one (`POST /portal/auth/select`). */
export interface PortalPatientSelection {
  requiresPatientSelection: true;
  /** Masked names only (first initial + masked last name): the phone holder proved possession, not identity. */
  candidates: { id: string; displayName: string }[];
  /** Short-lived (5 min) proof that the code was verified, bound to the clinic, phone and candidates. */
  selectionToken: string;
}

interface PortalClinic {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  settings: unknown;
}

interface PortalPatientRow {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  locale: string | null;
  clinic: PortalClinic;
}

/** Claims of the patient-selection token (never accepted by the portal or staff guards: `type` differs). */
interface SelectionPayload {
  type: 'portal-selection';
  clinicId: string;
  phone: string;
  candidates: string[];
}

type IssueOutcome = 'issued' | 'cooldown' | 'rate-limited' | 'locked';

/** sha256 of the code bound to the clinic + phone, so equal codes never share a hash across tenants. */
export function hashOtp(clinicId: string, phone: string, code: string): string {
  return createHash('sha256').update(`${clinicId}|${phone}|${code}`).digest('hex');
}

/**
 * Phone-OTP login for the patient portal.
 *
 * - request-otp never reveals whether a phone is known: the lookup, DB writes
 *   and the SMS run in the background and the response is padded to a fixed
 *   minimum latency. Per (clinic, phone): at most `otpRequestLimit` codes per
 *   `otpRequestWindowMinutes`, `otpCooldownSeconds` between two, and none while
 *   the failure budget is exhausted; a throttled request neither sends nor
 *   invalidates the current code.
 * - Codes are random 6-digit numbers stored hashed with a short TTL. Every
 *   verification first RESERVES an attempt atomically (`attempts < max`), so
 *   concurrent guesses cannot exceed the limit; failures across all codes of
 *   the phone are budgeted (`otpFailureBudget` per `otpFailureWindowMinutes`).
 *   Failed verifications are padded to the same minimum latency.
 * - Several patients sharing the phone → the caller picks one with a selection token.
 */
@Injectable()
export class PortalAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(PortalAuthService.name);
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly messaging: MessagingService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  /** Always `{ sent: true }` after the same minimum latency (no enumeration, no timing oracle). */
  async requestOtp(dto: RequestOtpDto): Promise<{ sent: true }> {
    const started = Date.now();
    const slug = this.slugOf(dto.clinicSlug);
    const phone = normalizePhone(dto.phone, this.config.defaultCountryCode);
    if (phone) this.background(() => this.issueCode(slug, phone));
    await padLatency(started, this.config.portal.otpMinLatencyMs);
    return { sent: true };
  }

  /** Checks the latest unconsumed code. Returns a session, or a patient selection when the phone is shared. */
  async verify(dto: VerifyOtpDto): Promise<PortalSession | PortalPatientSelection> {
    const started = Date.now();
    try {
      return await this.verifyCode(dto);
    } catch (err) {
      if (err instanceof UnauthorizedException) await padLatency(started, this.config.portal.otpMinLatencyMs);
      throw err;
    }
  }

  /** Second step for a shared phone: exchanges the selection token for a session of one of its candidates. */
  async selectPatient(dto: SelectPatientDto): Promise<PortalSession> {
    let payload: SelectionPayload;
    try {
      payload = await this.jwt.verifyAsync<SelectionPayload>(dto.selectionToken);
    } catch {
      throw new UnauthorizedException(INVALID_SELECTION);
    }
    if (payload.type !== 'portal-selection' || !payload.clinicId || !payload.phone || !Array.isArray(payload.candidates)) throw new UnauthorizedException(INVALID_SELECTION);
    if (!payload.candidates.includes(dto.patientId)) throw new UnauthorizedException(INVALID_SELECTION);
    // Re-check: still active, portal-enabled and on that phone.
    const patients = await this.findPortalPatients({ clinicId: payload.clinicId }, payload.phone);
    const patient = patients.find((p) => p.id === dto.patientId);
    if (!patient) throw new UnauthorizedException(INVALID_SELECTION);
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

  /** Resolves once every background OTP issuance started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled(this.pending);
  }

  async onModuleDestroy() {
    await this.idle();
  }

  // ─────────────────────────────── request ───────────────────────────────

  /** Background part of request-otp: lookup, throttles, code rotation and the SMS. Never throws. */
  private async issueCode(slug: string, phone: string): Promise<void> {
    const patients = await this.findPortalPatients({ slug }, phone);
    if (patients.length === 0) {
      this.logger.debug(`OTP requested for an unknown phone in clinic ${slug}`);
      return;
    }
    const patient = patients[0];
    const clinicId = patient.clinicId;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttl = this.config.portal.otpTtlMinutes;

    const outcome = await withClinic(clinicId, () =>
      this.prisma.transaction(async (tx): Promise<IssueOutcome> => {
        // One issuer at a time per (clinic, phone), so the counts below are exact under concurrency.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`portal-otp|${clinicId}|${phone}`}, 0))`;
        const now = Date.now();
        const cfg = this.config.portal;
        const horizon = Math.max(cfg.otpRequestWindowMinutes, cfg.otpFailureWindowMinutes) * MINUTE;
        const recent = await tx.otpCode.findMany({
          where: { clinicId, phone, purpose: PURPOSE, createdAt: { gte: new Date(now - horizon) } },
          select: { createdAt: true, attempts: true },
          orderBy: { createdAt: 'desc' },
        });
        const failures = recent.filter((r) => r.createdAt.getTime() >= now - cfg.otpFailureWindowMinutes * MINUTE).reduce((n, r) => n + r.attempts, 0);
        if (failures >= cfg.otpFailureBudget) return 'locked';
        if (recent[0] && recent[0].createdAt.getTime() > now - cfg.otpCooldownSeconds * 1000) return 'cooldown';
        if (recent.filter((r) => r.createdAt.getTime() >= now - cfg.otpRequestWindowMinutes * MINUTE).length >= cfg.otpRequestLimit) return 'rate-limited';

        const at = new Date(now);
        await tx.otpCode.updateMany({ where: { clinicId, phone, purpose: PURPOSE, consumedAt: null }, data: { consumedAt: at } });
        await tx.otpCode.create({ data: { clinicId, phone, purpose: PURPOSE, codeHash: hashOtp(clinicId, phone, code), expiresAt: new Date(now + ttl * MINUTE) } });
        return 'issued';
      }),
    );
    if (outcome !== 'issued') {
      this.logger.warn(`OTP request for ${phone.slice(0, 5)}… in clinic ${slug} refused (${outcome}); nothing sent`);
      return;
    }

    const message = await this.messaging.send({
      clinicId,
      patientId: patient.id,
      channel: 'SMS',
      to: phone,
      template: 'portal.otp',
      locale: this.localeOf(patient),
      params: { code, minutes: ttl, clinicName: patient.clinic.name },
    });
    if (message.status === 'FAILED') this.logger.warn(`OTP SMS to ${phone.slice(0, 5)}… failed: ${message.error}`);
  }

  // ─────────────────────────────── verify ───────────────────────────────

  private async verifyCode(dto: VerifyOtpDto): Promise<PortalSession | PortalPatientSelection> {
    const slug = this.slugOf(dto.clinicSlug);
    const phone = normalizePhone(dto.phone, this.config.defaultCountryCode);
    const code = foldDigits(dto.code.trim());
    if (!phone || !/^\d{6}$/.test(code)) throw new UnauthorizedException(INVALID_CODE);
    const patients = await this.findPortalPatients({ slug }, phone);
    if (patients.length === 0) throw new UnauthorizedException(INVALID_CODE);
    const clinicId = patients[0].clinicId;

    const ok = await withClinic(clinicId, () => this.checkCode(clinicId, phone, code));
    if (!ok) throw new UnauthorizedException(INVALID_CODE);
    if (patients.length === 1) return this.issueSession(patients[0]);

    const payload: SelectionPayload = { type: 'portal-selection', clinicId, phone, candidates: patients.map((p) => p.id) };
    return {
      requiresPatientSelection: true,
      candidates: patients.map((p) => ({ id: p.id, displayName: maskPatientName(p.firstName, p.lastName) })),
      selectionToken: await this.jwt.signAsync(payload, { expiresIn: SELECTION_TTL }),
    };
  }

  /**
   * Budget check → atomic attempt reservation → constant-time compare → atomic
   * consumption. An attempt is reserved BEFORE comparing, so N concurrent
   * guesses can never exceed `otpMaxAttempts`; a successful verification gives
   * its reservation back so `attempts` counts failures only (the budget).
   */
  private async checkCode(clinicId: string, phone: string, code: string): Promise<boolean> {
    const cfg = this.config.portal;
    const now = new Date();
    const budgetWhere = { clinicId, phone, purpose: PURPOSE, createdAt: { gte: new Date(now.getTime() - cfg.otpFailureWindowMinutes * MINUTE) } };
    const failures = async () => (await this.prisma.db.otpCode.aggregate({ where: budgetWhere, _sum: { attempts: true } }))._sum.attempts ?? 0;

    if ((await failures()) >= cfg.otpFailureBudget) return false;
    const row = await this.prisma.db.otpCode.findFirst({
      where: { clinicId, phone, purpose: PURPOSE, consumedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true },
    });
    if (!row) return false;
    const reserved = await this.prisma.db.otpCode.updateMany({
      where: { id: row.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: cfg.otpMaxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return false;
    // Strict budget: concurrent reservations that pushed the phone over it never get to compare.
    if ((await failures()) > cfg.otpFailureBudget) return false;

    const expected = Buffer.from(row.codeHash, 'hex');
    const given = Buffer.from(hashOtp(clinicId, phone, code), 'hex');
    const match = expected.length === given.length && timingSafeEqual(expected, given);
    if (!match) return false;
    // Consume atomically: a concurrent verify with the same code loses.
    const consumed = await this.prisma.db.otpCode.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date(), attempts: { decrement: 1 } } });
    return consumed.count === 1;
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /**
   * Active, portal-enabled patients with this phone in the (active) clinic,
   * oldest first. The clinic is resolved in a system context (the caller is
   * anonymous); the patients are matched inside the clinic's tenant transaction
   * on the digits-only phone, so `+966 50 123 4567` matches `0501234567`.
   */
  private async findPortalPatients(clinic: { slug: string } | { clinicId: string }, phone: string): Promise<PortalPatientRow[]> {
    const row = await tenantContext.runSystem(() =>
      this.prisma.db.clinic.findFirst({
        where: 'slug' in clinic ? { slug: clinic.slug, isActive: true } : { id: clinic.clinicId, isActive: true },
        select: { id: true, name: true, slug: true, timezone: true, currency: true, settings: true },
      }),
    );
    if (!row) return [];
    const variants = phoneDigitVariants(phone, this.config.defaultCountryCode);
    const patients = await withClinic(row.id, () => this.prisma.transaction((tx) => findClinicPatientsByPhone(tx, row.id, variants, { portalEnabledOnly: true })));
    return patients.map((p) => ({ ...p, clinic: row }));
  }

  private slugOf(clinicSlug: string): string {
    const slug = clinicSlug.trim().toLowerCase();
    if (!slug) throw new BadRequestException('clinicSlug is required');
    return slug;
  }

  private background(fn: () => Promise<void>) {
    const task: Promise<void> = fn()
      .catch((err: unknown) => this.logger.error(`Background OTP issuance failed: ${(err as Error).message}`))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  private localeOf(patient: PortalPatientRow): 'ar' | 'en' {
    const fallback = resolveLocale((patient.clinic.settings as { defaultLocale?: string } | null)?.defaultLocale);
    return resolveLocale(patient.locale, fallback);
  }
}
