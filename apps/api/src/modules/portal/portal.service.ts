import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Appointment, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { addMinutes, defaultDurationMinutes, INACTIVE_STATUSES } from '../appointments/scheduling.js';
import { SlotSearchService } from '../appointments/slot-search.service.js';
import { toInvoiceView } from '../billing/billing.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { formatWhen, resolveLocale, type Locale, type TemplateKey } from '../messaging/messaging.templates.js';
import { ACTIVE_STATUS_FILTER, appointmentInclude, AppointmentWriterService, type AppointmentRow } from '../waitlist/appointment-writer.service.js';
import { WaitlistService } from '../waitlist/waitlist.service.js';
import type { PortalPatient } from './portal-auth.guard.js';
import type { PortalAppointmentsQuery, PortalBookDto, PortalCancelDto, PortalConsentDto, PortalSlotsQuery, PortalWaitlistDto, UpdatePortalProfileDto } from './portal.dto.js';

const DAY_MS = 86_400_000;
const MAX_SLOT_DAYS = 14;
const DEFAULT_SLOT_LIMIT = 50;
const DEFAULT_DURATION = 30;
const CANCEL_LEAD_MS = 2 * 3_600_000;
const MAX_ACTIVE_WAITLIST = 3;
export const PORTAL_BOOKING_NOTE = 'Booked via patient portal';

const doctorPublic = { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } as const;
const consentSelect = { id: true, type: true, version: true, acceptedAt: true } as const;

/** Fields of an appointment a patient may see (no internal notes, risk scores or audit columns). */
function toPortalAppointment<T extends Appointment & { doctor: Record<string, unknown> }>(a: T) {
  return {
    id: a.id,
    doctorId: a.doctorId,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    status: a.status,
    type: a.type,
    reason: a.reason,
    cancellationNote: a.cancellationNote,
    holdExpiresAt: a.holdExpiresAt,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    doctor: a.doctor,
  };
}

/**
 * Patient self-service. Every query filters by the patient id from the token
 * (RLS already pins the clinic). Appointment writes go through
 * `AppointmentWriterService` so validation and the `appointment.*` events are
 * the same as for staff; the patient id is used as the events' `actorUserId`.
 */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AppointmentWriterService,
    private readonly slotSearch: SlotSearchService,
    private readonly waitlist: WaitlistService,
    private readonly messaging: MessagingService,
  ) {}

  // ─────────────────────────────── profile & clinic ───────────────────────────────

  async me(p: PortalPatient) {
    const row = await this.prisma.db.patient.findFirstOrThrow({
      where: { id: p.id, clinicId: p.clinicId },
      select: {
        id: true,
        mrn: true,
        firstName: true,
        lastName: true,
        dateOfBirth: true,
        gender: true,
        phone: true,
        email: true,
        address: true,
        locale: true,
        portalEnabled: true,
        consents: { select: consentSelect, orderBy: { acceptedAt: 'desc' } },
      },
    });
    return { ...row, locale: this.localeOf(p, row.locale) };
  }

  async updateMe(p: PortalPatient, dto: UpdatePortalProfileDto) {
    await this.prisma.db.patient.update({
      where: { id: p.id },
      data: { locale: dto.locale, email: dto.email === undefined ? undefined : dto.email.trim().toLowerCase(), address: dto.address },
    });
    return this.me(p);
  }

  async clinic(p: PortalPatient) {
    const clinic = await this.prisma.db.clinic.findUniqueOrThrow({
      where: { id: p.clinicId },
      select: { id: true, name: true, slug: true, address: true, phone: true, email: true, timezone: true, currency: true },
    });
    const doctors = await this.prisma.db.doctor.findMany({
      where: { clinicId: p.clinicId, isActive: true },
      select: doctorPublic,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    return { ...clinic, doctors };
  }

  // ─────────────────────────────── appointments ───────────────────────────────

  async appointments(p: PortalPatient, q: PortalAppointmentsQuery) {
    const past = q.scope === 'past' || (q.scope === undefined && q.past !== undefined && q.upcoming === undefined);
    const now = new Date();
    const where: Prisma.AppointmentWhereInput = {
      clinicId: p.clinicId,
      patientId: p.id,
      ...(past ? { OR: [{ endsAt: { lte: now } }, { status: { in: ['COMPLETED', 'CANCELLED', 'NO_SHOW'] } }] } : { endsAt: { gt: now }, status: { notIn: ['COMPLETED', 'CANCELLED', 'NO_SHOW'] } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.appointment.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: { startsAt: past ? 'desc' : 'asc' }, include: { doctor: { select: doctorPublic } } }),
      this.prisma.db.appointment.count({ where }),
    ]);
    return paginate(items.map(toPortalAppointment), total, q);
  }

  async appointment(p: PortalPatient, id: string) {
    const appt = await this.prisma.db.appointment.findFirst({ where: { id, clinicId: p.clinicId, patientId: p.id }, include: { doctor: { select: doctorPublic } } });
    if (!appt) throw new NotFoundException('Appointment not found');
    return toPortalAppointment(appt);
  }

  /** Free slots over at most 14 days; the patient's own appointments are excluded so they cannot double book. */
  async slots(p: PortalPatient, q: PortalSlotsQuery) {
    if (!q.doctorId && !q.specialty?.trim()) throw new BadRequestException('Provide doctorId or specialty');
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + MAX_SLOT_DAYS * DAY_MS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Invalid date');
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to.getTime() - from.getTime() > MAX_SLOT_DAYS * DAY_MS) throw new BadRequestException(`Slot search cannot exceed ${MAX_SLOT_DAYS} days`);
    const start = new Date(Math.max(from.getTime(), Date.now()));
    if (to <= start) return { query: { from: from.toISOString(), to: to.toISOString(), timezone: p.clinic.timezone }, candidates: [] };

    let durationMinutes = q.durationMinutes;
    if (!durationMinutes && q.doctorId) {
      const doctor = await this.writer.loadDoctor(p.clinicId, q.doctorId);
      durationMinutes = defaultDurationMinutes(doctor.availability, start, p.clinic.timezone);
    }
    return this.slotSearch.searchForClinic(p.clinicId, {
      durationMinutes: durationMinutes ?? DEFAULT_DURATION,
      from: start,
      to,
      doctorId: q.doctorId,
      specialty: q.doctorId ? undefined : q.specialty?.trim() || undefined,
      preferredWindows: [],
      resourceIds: [],
      limit: q.limit ?? DEFAULT_SLOT_LIMIT,
      patientId: p.id,
    });
  }

  /** Books a CONSULTATION of the doctor's default length. Idempotent per `Idempotency-Key`. */
  async book(p: PortalPatient, dto: PortalBookDto, idempotencyKeyHeader?: string) {
    const idempotencyKey = (idempotencyKeyHeader ?? '').trim() || undefined;
    if (idempotencyKey && idempotencyKey.length > 200) throw new BadRequestException('Idempotency-Key must be at most 200 characters');
    if (idempotencyKey) {
      const existing = await this.prisma.db.appointment.findFirst({ where: { clinicId: p.clinicId, idempotencyKey }, include: { doctor: { select: doctorPublic } } });
      if (existing) {
        if (existing.patientId !== p.id) throw new ConflictException('Idempotency-Key is already used');
        return { appointment: toPortalAppointment(existing), replayed: true };
      }
    }
    const startsAt = new Date(dto.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException('startsAt is not a valid date');
    if (startsAt.getTime() <= Date.now()) throw new BadRequestException('startsAt must be in the future');

    const [doctor, patient] = await Promise.all([this.writer.loadDoctor(p.clinicId, dto.doctorId), this.writer.loadPatient(p.clinicId, p.id)]);
    const timeZone = p.clinic.timezone || 'UTC';
    const range = { startsAt, endsAt: addMinutes(startsAt, defaultDurationMinutes(doctor.availability, startsAt, timeZone)) };

    const created = await this.writer.withOverlapGuard(() =>
      this.prisma.transaction(async (tx) => {
        await this.writer.assertBookable(tx, doctor, p.clinicId, range, timeZone);
        const clash = await tx.appointment.findFirst({
          where: { clinicId: p.clinicId, patientId: patient.id, status: ACTIVE_STATUS_FILTER, startsAt: { lt: range.endsAt }, endsAt: { gt: range.startsAt } },
          select: { id: true },
        });
        if (clash) throw new ConflictException('You already have an appointment at this time');
        const row = await this.writer.insert(tx, {
          clinicId: p.clinicId,
          doctorId: doctor.id,
          patientId: patient.id,
          ...range,
          type: 'CONSULTATION',
          reason: dto.reason?.trim() || null,
          notes: PORTAL_BOOKING_NOTE,
          createdById: null,
        });
        if (!idempotencyKey) return row;
        await tx.appointment.update({ where: { id: row.id }, data: { idempotencyKey } });
        return { ...row, idempotencyKey };
      }),
    );
    this.writer.emitCreated(created, p.id);
    await this.notifyPatient(p, created, 'appointment.confirmed');
    return { appointment: toPortalAppointment({ ...created, doctor: this.publicDoctor(created) }), replayed: false };
  }

  async confirm(p: PortalPatient, id: string) {
    const existing = await this.loadOwn(p, id);
    if (existing.status === 'CONFIRMED') return this.appointment(p, id);
    if (existing.status !== 'SCHEDULED') throw new ConflictException(`A ${existing.status.toLowerCase().replace('_', ' ')} appointment cannot be confirmed`);
    if (existing.startsAt.getTime() <= Date.now()) throw new ConflictException('This appointment has already started');
    const updated = await this.prisma.transaction((tx) =>
      tx.appointment.update({ where: { id: existing.id }, data: { status: 'CONFIRMED', version: { increment: 1 } }, include: appointmentInclude }),
    );
    this.writer.emitUpdated(updated, p.id);
    return toPortalAppointment({ ...updated, doctor: this.publicDoctor(updated) });
  }

  /** Patients may cancel up to 2 hours before the start; later cancellations go through the clinic (409). */
  async cancel(p: PortalPatient, id: string, dto: PortalCancelDto) {
    const existing = await this.loadOwn(p, id);
    if (existing.status === 'CANCELLED') return this.appointment(p, id);
    if ((INACTIVE_STATUSES as readonly string[]).includes(existing.status) || existing.status === 'COMPLETED' || existing.status === 'CHECKED_IN' || existing.status === 'IN_PROGRESS') {
      throw new ConflictException(`A ${existing.status.toLowerCase().replace('_', ' ')} appointment cannot be cancelled`);
    }
    if (existing.startsAt.getTime() - Date.now() < CANCEL_LEAD_MS) {
      throw new ConflictException('Appointments can only be cancelled online at least 2 hours before they start; please contact the clinic');
    }
    const note = dto.reason?.trim() ? `Cancelled by patient via portal: ${dto.reason.trim()}` : 'Cancelled by patient via portal';
    const cancelled = await this.prisma.transaction((tx) => this.writer.cancel(tx, existing.id, note));
    this.writer.emitCancelled(cancelled, p.id);
    await this.notifyPatient(p, cancelled, 'appointment.cancelled');
    return toPortalAppointment({ ...cancelled, doctor: this.publicDoctor(cancelled) });
  }

  // ─────────────────────────────── invoices ───────────────────────────────

  async invoices(p: PortalPatient) {
    const rows = await this.prisma.db.invoice.findMany({
      where: { clinicId: p.clinicId, patientId: p.id, status: { not: 'DRAFT' } },
      orderBy: { createdAt: 'desc' },
      include: { patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } } },
      take: 200,
    });
    return rows.map(toInvoiceView);
  }

  async invoice(p: PortalPatient, id: string) {
    const row = await this.prisma.db.invoice.findFirst({
      where: { id, clinicId: p.clinicId, patientId: p.id, status: { not: 'DRAFT' } },
      include: {
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true } },
        items: { orderBy: { position: 'asc' } },
        payments: { orderBy: { paidAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Invoice not found');
    return toInvoiceView(row);
  }

  // ─────────────────────────────── waitlist ───────────────────────────────

  async waitlistEntries(p: PortalPatient) {
    const entries = await this.prisma.db.waitlistEntry.findMany({
      where: { clinicId: p.clinicId, patientId: p.id },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: { offeredAppointment: { select: { id: true, doctorId: true, startsAt: true, endsAt: true, status: true, holdExpiresAt: true } } },
      take: 50,
    });
    const doctorIds = [...new Set(entries.map((e) => e.doctorId).filter((d): d is string => !!d))];
    const doctors = doctorIds.length ? await this.prisma.db.doctor.findMany({ where: { clinicId: p.clinicId, id: { in: doctorIds } }, select: doctorPublic }) : [];
    const byId = new Map(doctors.map((d) => [d.id, d]));
    return entries.map((e) => ({ ...e, doctor: e.doctorId ? (byId.get(e.doctorId) ?? null) : null }));
  }

  /** Joins the waitlist (ROUTINE priority, 30-minute slots) for a doctor or a specialty. */
  async joinWaitlist(p: PortalPatient, dto: PortalWaitlistDto) {
    if (!dto.doctorId && !dto.specialty?.trim()) throw new BadRequestException('Provide doctorId or specialty');
    const active = await this.prisma.db.waitlistEntry.count({ where: { clinicId: p.clinicId, patientId: p.id, status: { in: ['WAITING', 'OFFERED'] } } });
    if (active >= MAX_ACTIVE_WAITLIST) throw new ConflictException(`You already have ${MAX_ACTIVE_WAITLIST} open waitlist requests`);
    let specialty = dto.specialty?.trim() || null;
    if (dto.doctorId) specialty = specialty ?? (await this.writer.loadDoctor(p.clinicId, dto.doctorId)).specialty;
    const entry = await this.prisma.db.waitlistEntry.create({
      data: {
        clinicId: p.clinicId,
        patientId: p.id,
        doctorId: dto.doctorId ?? null,
        specialty,
        priority: 'ROUTINE',
        preferredWindows: (dto.preferredWindows ?? []) as unknown as Prisma.InputJsonValue,
        type: 'CONSULTATION',
        notes: dto.notes?.trim() || null,
        // No staff user created this entry; offers notify the doctor's user and message the patient.
        createdById: null,
      },
      include: { offeredAppointment: { select: { id: true, doctorId: true, startsAt: true, endsAt: true, status: true, holdExpiresAt: true } } },
    });
    const doctor = entry.doctorId ? await this.prisma.db.doctor.findFirst({ where: { id: entry.doctorId, clinicId: p.clinicId }, select: doctorPublic }) : null;
    return { ...entry, doctor };
  }

  async acceptOffer(p: PortalPatient, id: string) {
    await this.assertOwnEntry(p, id);
    const { entry, appointment } = await this.waitlist.accept(this.actor(p), id);
    return { entry, appointment: toPortalAppointment({ ...appointment, doctor: this.publicDoctor({ doctor: appointment.doctor }) }) };
  }

  async declineOffer(p: PortalPatient, id: string) {
    await this.assertOwnEntry(p, id);
    return this.waitlist.decline(this.actor(p), id);
  }

  // ─────────────────────────────── consents ───────────────────────────────

  consents(p: PortalPatient) {
    return this.prisma.db.patientConsent.findMany({ where: { clinicId: p.clinicId, patientId: p.id }, select: consentSelect, orderBy: { acceptedAt: 'desc' } });
  }

  /** Idempotent: accepting the same type + version again returns the original record. */
  async acceptConsent(p: PortalPatient, dto: PortalConsentDto) {
    const ctx = tenantContext.get();
    const version = dto.version.trim();
    const existing = await this.prisma.db.patientConsent.findFirst({ where: { patientId: p.id, type: dto.type, version }, select: consentSelect });
    if (existing) return existing;
    return this.prisma.db.patientConsent.create({
      data: { clinicId: p.clinicId, patientId: p.id, type: dto.type, version, ip: ctx?.ip?.slice(0, 64) ?? null, userAgent: ctx?.userAgent?.slice(0, 500) ?? null },
      select: consentSelect,
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async loadOwn(p: PortalPatient, id: string) {
    const appt = await this.prisma.db.appointment.findFirst({ where: { id, clinicId: p.clinicId, patientId: p.id } });
    if (!appt) throw new NotFoundException('Appointment not found');
    return appt;
  }

  private async assertOwnEntry(p: PortalPatient, id: string) {
    const entry = await this.prisma.db.waitlistEntry.findFirst({ where: { id, clinicId: p.clinicId }, select: { patientId: true } });
    if (!entry) throw new NotFoundException('Waitlist entry not found');
    if (entry.patientId !== p.id) throw new ForbiddenException('This waitlist entry belongs to another patient');
  }

  /** Minimal staff-shaped actor so `WaitlistService` can be reused (only `id` and `clinicId` are read). */
  private actor(p: PortalPatient): AuthUser {
    return { id: p.id, email: p.email ?? '', clinicId: p.clinicId, role: 'RECEPTIONIST', permissions: new Set<string>() };
  }

  private publicDoctor(row: { doctor: { id: string; firstName: string; lastName: string; title: string | null; specialty: string; color: string } }) {
    const { id, firstName, lastName, title, specialty, color } = row.doctor;
    return { id, firstName, lastName, title, specialty, color };
  }

  private localeOf(p: PortalPatient, value: string | null = p.locale): Locale {
    const fallback = resolveLocale((p.clinic.settings as { defaultLocale?: string } | null)?.defaultLocale);
    return resolveLocale(value, fallback);
  }

  /** Confirmation / cancellation message to the patient: SMS when a phone exists, else email, else nothing. Best effort. */
  private async notifyPatient(p: PortalPatient, appt: AppointmentRow, template: TemplateKey) {
    const to = p.phone ?? p.email;
    if (!to) return;
    const locale = this.localeOf(p);
    try {
      await this.messaging.send({
        clinicId: p.clinicId,
        patientId: p.id,
        appointmentId: appt.id,
        channel: p.phone ? 'SMS' : 'EMAIL',
        to,
        template,
        locale,
        params: {
          patientName: `${p.firstName} ${p.lastName}`,
          doctorName: `Dr. ${appt.doctor.firstName} ${appt.doctor.lastName}`,
          when: formatWhen(appt.startsAt, p.clinic.timezone || 'UTC', locale),
          clinicName: p.clinic.name,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not send ${template} to patient ${p.id}: ${(err as Error).message}`);
    }
  }
}
