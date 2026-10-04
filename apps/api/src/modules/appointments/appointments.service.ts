import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type AppointmentStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ResourcesService, resourceSummarySelect, type ResourceSummary } from '../resources/resources.service.js';
import type { AvailabilityQuery, CalendarQuery, CreateAppointmentDto, ListAppointmentsQuery, SetStatusDto, UpdateAppointmentDto } from './appointments.dto.js';
import {
  addMinutes,
  canTransition,
  dayBounds,
  defaultDurationMinutes,
  findScheduleProblem,
  generateSlots,
  isFinalStatus,
  isValidDateString,
  INACTIVE_STATUSES,
  STATUS_TRANSITIONS,
  type TimeRange,
} from './scheduling.js';

/** Doctor fields returned by the API (userId is used internally for notifications and stripped from responses). */
const doctorSelect = { id: true, userId: true, firstName: true, lastName: true, title: true, color: true } as const;
const patientSelect = { id: true, mrn: true, firstName: true, lastName: true, phone: true } as const;
const encounterSelect = { id: true, status: true, occurredAt: true, chiefComplaint: true, signedAt: true } as const;
const bookingsInclude = { select: { active: true, resource: { select: resourceSummarySelect } } } as const;

const listInclude = { doctor: { select: doctorSelect }, patient: { select: patientSelect }, resourceBookings: bookingsInclude } as const;
const detailInclude = { ...listInclude, encounter: { select: encounterSelect } } as const;

type AppointmentWithRelations = Prisma.AppointmentGetPayload<{ include: typeof listInclude }>;

export const APPOINTMENT_EVENTS = {
  created: 'appointment.created',
  updated: 'appointment.updated',
  cancelled: 'appointment.cancelled',
  checkedIn: 'appointment.checked_in',
} as const;

/** Payload of every `appointment.*` event. */
export interface AppointmentEvent {
  id: string;
  clinicId: string;
  doctorId: string;
  patientId: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  type: string;
  reason: string | null;
  notes: string | null;
  cancellationNote: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  idempotencyKey: string | null;
  holdExpiresAt: Date | null;
  noShowRisk: number | null;
  seriesId: string | null;
  occurrenceIndex: number | null;
  isException: boolean;
  doctor: { id: string; userId: string | null; firstName: string; lastName: string };
  patient: { id: string; firstName: string; lastName: string };
  /** Rooms / equipment booked with the appointment (optional so other writers stay compatible). */
  resources?: ResourceSummary[];
  /** The user who performed the action (excluded from notifications). */
  actorUserId: string;
}

const MAX_CALENDAR_DAYS = 31;
const ACTIVE_STATUS_FILTER = { notIn: [...INACTIVE_STATUSES] as AppointmentStatus[] };

/**
 * A DOCTOR without appointments:read_all is pinned to their own doctor profile.
 * Returns the doctorId filter to apply (undefined = no restriction). Shared with
 * the slot search so every read path applies the same rule.
 */
export function scopedDoctorIdFor(user: AuthUser, requested?: string): string | undefined {
  const restricted = user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
  if (!restricted) return requested;
  if (!user.doctorId) throw new ForbiddenException('Your account is not linked to a doctor profile');
  if (requested && requested !== user.doctorId) throw new ForbiddenException('You may only access your own appointments');
  return user.doctorId;
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly resources: ResourcesService,
  ) {}

  // ─────────────────────────────── queries ───────────────────────────────

  async list(user: AuthUser, q: ListAppointmentsQuery) {
    const doctorId = this.scopedDoctorId(user, q.doctorId);
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const where: Prisma.AppointmentWhereInput = {
      clinicId: user.clinicId,
      ...(doctorId ? { doctorId } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(from ? { endsAt: { gt: from } } : {}),
      ...(to ? { startsAt: { lt: to } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.appointment.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: { startsAt: 'asc' }, include: listInclude }),
      this.prisma.db.appointment.count({ where }),
    ]);
    return paginate(items.map((a) => this.toView(a)), total, q);
  }

  /** Unpaginated range query for calendar views (at most 31 days). */
  async calendar(user: AuthUser, q: CalendarQuery) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to.getTime() - from.getTime() > MAX_CALENDAR_DAYS * 86_400_000) {
      throw new BadRequestException(`Calendar range cannot exceed ${MAX_CALENDAR_DAYS} days`);
    }
    const doctorId = this.scopedDoctorId(user, q.doctorId);
    const items = await this.prisma.db.appointment.findMany({
      where: { clinicId: user.clinicId, ...(doctorId ? { doctorId } : {}), startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: { startsAt: 'asc' },
      include: listInclude,
    });
    return items.map((a) => this.toView(a));
  }

  /** Bookable slots for one calendar day (clinic timezone). */
  async availability(user: AuthUser, q: AvailabilityQuery) {
    if (!isValidDateString(q.date)) throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    const doctorId = this.scopedDoctorId(user, q.doctorId) ?? q.doctorId;
    const [doctor, timeZone] = await Promise.all([this.loadDoctor(user.clinicId, doctorId), this.clinicTimezone(user.clinicId)]);
    const day = dayBounds(q.date, timeZone);
    const busy = await this.busyRanges(user.clinicId, doctorId, day);
    const slots = generateSlots({ date: q.date, timeZone, blocks: doctor.availability, durationMinutes: q.durationMinutes, busy });
    return { date: q.date, timezone: timeZone, doctorId, slots: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
  }

  async get(user: AuthUser, id: string) {
    const appt = await this.prisma.db.appointment.findFirst({ where: { id, clinicId: user.clinicId }, include: detailInclude });
    if (!appt) throw new NotFoundException('Appointment not found');
    this.assertCanAccessDoctor(user, appt.doctorId);
    return this.toView(appt);
  }

  // ─────────────────────────────── mutations ───────────────────────────────

  /**
   * Books an appointment (and its resources) in one transaction. With an
   * idempotency key, a repeated call returns the original row (`replayed: true`).
   */
  async create(user: AuthUser, dto: CreateAppointmentDto, idempotencyKeyHeader?: string) {
    this.assertCanAccessDoctor(user, dto.doctorId);
    if (dto.endsAt && dto.durationMinutes) throw new BadRequestException('Provide either endsAt or durationMinutes, not both');
    const idempotencyKey = this.resolveIdempotencyKey(dto.idempotencyKey, idempotencyKeyHeader);
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(user.clinicId, idempotencyKey);
      if (existing) return { appointment: this.toView(existing), replayed: true };
    }

    const [doctor, patient, timeZone] = await Promise.all([
      this.loadDoctor(user.clinicId, dto.doctorId),
      this.loadPatient(user.clinicId, dto.patientId),
      this.clinicTimezone(user.clinicId),
    ]);
    const startsAt = this.parseDate(dto.startsAt, 'startsAt');
    const endsAt = dto.endsAt
      ? this.parseDate(dto.endsAt, 'endsAt')
      : addMinutes(startsAt, dto.durationMinutes ?? defaultDurationMinutes(doctor.availability, startsAt, timeZone));
    const range = { startsAt, endsAt };
    await this.assertBookable(user.clinicId, doctor, range, timeZone);
    const resourceIds = [...new Set(dto.resourceIds ?? [])];

    let created: AppointmentWithRelations;
    try {
      created = await this.withOverlapGuard(() =>
        this.prisma.transaction(async (tx) => {
          await this.resources.assertAvailable(tx, user.clinicId, resourceIds, range);
          const row = await tx.appointment.create({
            data: {
              clinicId: user.clinicId,
              doctorId: doctor.id,
              patientId: patient.id,
              startsAt,
              endsAt,
              type: dto.type,
              reason: dto.reason,
              notes: dto.notes,
              createdById: user.id,
              idempotencyKey,
            },
            select: { id: true },
          });
          if (resourceIds.length > 0) {
            await tx.resourceBooking.createMany({
              data: resourceIds.map((resourceId) => ({ clinicId: user.clinicId, resourceId, appointmentId: row.id, startsAt, endsAt })),
            });
          }
          return tx.appointment.findUniqueOrThrow({ where: { id: row.id }, include: detailInclude });
        }),
      );
    } catch (err) {
      // Two concurrent requests with the same key: the loser returns the winner's row.
      if (idempotencyKey && this.isIdempotencyKeyConflict(err)) {
        const existing = await this.findByIdempotencyKey(user.clinicId, idempotencyKey);
        if (existing) return { appointment: this.toView(existing), replayed: true };
      }
      throw err;
    }
    this.emit(APPOINTMENT_EVENTS.created, created, user);
    return { appointment: this.toView(created), replayed: false };
  }

  async update(user: AuthUser, id: string, dto: UpdateAppointmentDto, expectedVersion?: number) {
    const existing = await this.loadForMutation(user, id);
    if (isFinalStatus(existing.status)) {
      throw new ConflictException(`A ${existing.status.toLowerCase()} appointment cannot be modified`);
    }
    this.assertExpectedVersion(existing.version, expectedVersion ?? dto.expectedVersion);
    const doctorId = dto.doctorId ?? existing.doctorId;
    this.assertCanAccessDoctor(user, doctorId);

    const startsAt = dto.startsAt ? this.parseDate(dto.startsAt, 'startsAt') : existing.startsAt;
    let endsAt = dto.endsAt ? this.parseDate(dto.endsAt, 'endsAt') : existing.endsAt;
    if (dto.startsAt && !dto.endsAt) {
      // Keep the original duration when only the start moves.
      endsAt = addMinutes(startsAt, (existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
    }
    const range = { startsAt, endsAt };
    const scheduleChanged =
      doctorId !== existing.doctorId || startsAt.getTime() !== existing.startsAt.getTime() || endsAt.getTime() !== existing.endsAt.getTime();

    if (scheduleChanged) {
      const [doctor, timeZone] = await Promise.all([this.loadDoctor(user.clinicId, doctorId), this.clinicTimezone(user.clinicId)]);
      await this.assertBookable(user.clinicId, doctor, range, timeZone, existing.id);
    }
    const resourceIds = dto.resourceIds ? [...new Set(dto.resourceIds)] : undefined;
    const guardVersion = expectedVersion ?? dto.expectedVersion ?? existing.version;

    const updated = await this.withOverlapGuard(() =>
      this.prisma.transaction(async (tx) => {
        // The final resource set must be free over the (possibly new) time range.
        let finalResourceIds = resourceIds;
        if (!finalResourceIds && scheduleChanged) {
          const current = await tx.resourceBooking.findMany({ where: { appointmentId: existing.id, active: true }, select: { resourceId: true } });
          finalResourceIds = current.map((b) => b.resourceId);
        }
        if (finalResourceIds && finalResourceIds.length > 0) {
          await this.resources.assertAvailable(tx, user.clinicId, finalResourceIds, range, existing.id);
        }

        // Atomic optimistic lock: only the version we expect is updated.
        const result = await tx.appointment.updateMany({
          where: { id: existing.id, clinicId: user.clinicId, version: guardVersion },
          data: {
            doctorId,
            startsAt,
            endsAt,
            type: dto.type,
            reason: dto.reason,
            notes: dto.notes,
            version: { increment: 1 },
            // Editing one occurrence of a series detaches it from the rule.
            ...(existing.seriesId ? { isException: true } : {}),
          },
        });
        if (result.count === 0) throw await this.versionConflict(tx, existing.id);

        if (resourceIds) {
          // Replace the booked set; rows of removed resources are deleted.
          if (resourceIds.length === 0) await tx.resourceBooking.deleteMany({ where: { appointmentId: existing.id } });
          else await tx.resourceBooking.deleteMany({ where: { appointmentId: existing.id, resourceId: { notIn: resourceIds } } });
          for (const resourceId of resourceIds) {
            await tx.resourceBooking.upsert({
              where: { appointmentId_resourceId: { appointmentId: existing.id, resourceId } },
              update: { startsAt, endsAt, active: true },
              create: { clinicId: user.clinicId, resourceId, appointmentId: existing.id, startsAt, endsAt },
            });
          }
        } else if (scheduleChanged) {
          await tx.resourceBooking.updateMany({ where: { appointmentId: existing.id }, data: { startsAt, endsAt } });
        }
        return tx.appointment.findUniqueOrThrow({ where: { id: existing.id }, include: detailInclude });
      }),
    );
    this.emit(APPOINTMENT_EVENTS.updated, updated, user);
    return this.toView(updated);
  }

  async setStatus(user: AuthUser, id: string, dto: SetStatusDto, expectedVersion?: number) {
    const existing = await this.loadForMutation(user, id);
    if (!canTransition(existing.status, dto.status)) {
      const allowed = STATUS_TRANSITIONS[existing.status];
      throw new BadRequestException(
        allowed.length === 0
          ? `Status ${existing.status} is final and cannot change`
          : `Cannot change status from ${existing.status} to ${dto.status}; allowed: ${allowed.join(', ')}`,
      );
    }
    if (dto.cancellationNote && dto.status !== 'CANCELLED') {
      throw new BadRequestException('cancellationNote is only accepted when cancelling');
    }
    this.assertExpectedVersion(existing.version, expectedVersion ?? dto.expectedVersion);
    const guardVersion = expectedVersion ?? dto.expectedVersion ?? existing.version;

    const updated = await this.prisma.transaction(async (tx) => {
      const result = await tx.appointment.updateMany({
        where: { id: existing.id, clinicId: user.clinicId, version: guardVersion },
        data: {
          status: dto.status,
          version: { increment: 1 },
          ...(dto.status === 'CANCELLED' ? { cancellationNote: dto.cancellationNote ?? null } : {}),
        },
      });
      if (result.count === 0) throw await this.versionConflict(tx, existing.id);
      // Cancelled / no-show appointments release their rooms and equipment.
      if (INACTIVE_STATUSES.includes(dto.status)) {
        await tx.resourceBooking.updateMany({ where: { appointmentId: existing.id }, data: { active: false } });
      }
      return tx.appointment.findUniqueOrThrow({ where: { id: existing.id }, include: detailInclude });
    });
    const event =
      dto.status === 'CANCELLED' ? APPOINTMENT_EVENTS.cancelled : dto.status === 'CHECKED_IN' ? APPOINTMENT_EVENTS.checkedIn : APPOINTMENT_EVENTS.updated;
    this.emit(event, updated, user);
    return this.toView(updated);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private scopedDoctorId(user: AuthUser, requested?: string): string | undefined {
    return scopedDoctorIdFor(user, requested);
  }

  private assertCanAccessDoctor(user: AuthUser, doctorId: string) {
    this.scopedDoctorId(user, doctorId);
  }

  private async loadForMutation(user: AuthUser, id: string) {
    const appt = await this.prisma.db.appointment.findFirst({ where: { id, clinicId: user.clinicId } });
    if (!appt) throw new NotFoundException('Appointment not found');
    this.assertCanAccessDoctor(user, appt.doctorId);
    return appt;
  }

  private async loadDoctor(clinicId: string, doctorId: string) {
    const doctor = await this.prisma.db.doctor.findFirst({ where: { id: doctorId, clinicId }, include: { availability: true } });
    if (!doctor) throw new NotFoundException('Doctor not found');
    if (!doctor.isActive) throw new BadRequestException('Doctor is not active');
    return doctor;
  }

  private async loadPatient(clinicId: string, patientId: string) {
    const patient = await this.prisma.db.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, isActive: true } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (!patient.isActive) throw new BadRequestException('Patient is not active');
    return patient;
  }

  private async clinicTimezone(clinicId: string): Promise<string> {
    const clinic = await this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    return clinic?.timezone || 'UTC';
  }

  /** Friendly validation before the DB exclusion constraint has the final word. */
  private async assertBookable(
    clinicId: string,
    doctor: { id: string; availability: { weekday: number; startTime: string; endTime: string; slotMinutes: number }[] },
    range: TimeRange,
    timeZone: string,
    excludeAppointmentId?: string,
  ) {
    if (Number.isNaN(range.startsAt.getTime()) || Number.isNaN(range.endsAt.getTime())) throw new BadRequestException('Invalid date');
    if (range.endsAt <= range.startsAt) throw new BadRequestException('endsAt must be after startsAt');

    const timeOff = await this.prisma.db.doctorTimeOff.findMany({
      where: { clinicId, doctorId: doctor.id, startsAt: { lt: range.endsAt }, endsAt: { gt: range.startsAt } },
      select: { startsAt: true, endsAt: true },
    });
    const problem = findScheduleProblem(range, doctor.availability, timeOff, timeZone);
    if (problem) throw new BadRequestException(problem);

    const clash = await this.prisma.db.appointment.findFirst({
      where: {
        clinicId,
        doctorId: doctor.id,
        status: ACTIVE_STATUS_FILTER,
        startsAt: { lt: range.endsAt },
        endsAt: { gt: range.startsAt },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException('This time slot overlaps another appointment for the doctor');
  }

  private async busyRanges(clinicId: string, doctorId: string, day: TimeRange): Promise<TimeRange[]> {
    const [timeOff, booked] = await Promise.all([
      this.prisma.db.doctorTimeOff.findMany({
        where: { clinicId, doctorId, startsAt: { lt: day.endsAt }, endsAt: { gt: day.startsAt } },
        select: { startsAt: true, endsAt: true },
      }),
      this.prisma.db.appointment.findMany({
        where: { clinicId, doctorId, status: ACTIVE_STATUS_FILTER, startsAt: { lt: day.endsAt }, endsAt: { gt: day.startsAt } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    return [...timeOff, ...booked];
  }

  /**
   * The `appointments_no_overlap` / `resource_bookings_no_overlap` exclusion
   * constraints are the final arbiters for concurrent bookings. Prisma may surface
   * them as an unknown request error (not handled by the global filter), so
   * translate them here.
   */
  private async withOverlapGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('appointments_no_overlap')) {
          throw new ConflictException('This time slot overlaps another appointment for the doctor');
        }
        if (err.message.includes('resource_bookings_no_overlap')) {
          throw new ConflictException('One of the requested resources is not available at this time');
        }
      }
      throw err;
    }
  }

  private parseDate(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
    return d;
  }

  // ─────────────────────────── idempotency + versions ───────────────────────────

  private resolveIdempotencyKey(body?: string, header?: string): string | undefined {
    const key = (body ?? header ?? '').trim();
    if (!key) return undefined;
    if (key.length > 200) throw new BadRequestException('Idempotency-Key must be at most 200 characters');
    return key;
  }

  private findByIdempotencyKey(clinicId: string, idempotencyKey: string) {
    return this.prisma.db.appointment.findFirst({ where: { clinicId, idempotencyKey }, include: detailInclude });
  }

  private isIdempotencyKeyConflict(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
    const target = (err.meta as { target?: string[] | string } | undefined)?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
    return fields.includes('idempotency');
  }

  private assertExpectedVersion(current: number, expected?: number) {
    if (expected !== undefined && expected !== current) {
      throw new ConflictException(`Appointment was modified by someone else (version ${current})`);
    }
  }

  /** Builds the 409 for a failed guarded update, reporting the version now in the database. */
  private async versionConflict(tx: Prisma.TransactionClient, id: string): Promise<ConflictException> {
    const row = await tx.appointment.findUnique({ where: { id }, select: { version: true } });
    return new ConflictException(`Appointment was modified by someone else (version ${row?.version ?? 'unknown'})`);
  }

  // ─────────────────────────────── shapes ───────────────────────────────

  private emit(event: string, appt: AppointmentWithRelations, actor: AuthUser) {
    const { doctor, patient, resourceBookings, ...rest } = appt;
    const payload: AppointmentEvent = {
      ...rest,
      doctor: { id: doctor.id, userId: doctor.userId, firstName: doctor.firstName, lastName: doctor.lastName },
      patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
      resources: resourceBookings.map((b) => b.resource),
      actorUserId: actor.id,
    };
    this.events.emit(event, payload);
  }

  /** API shape: hides the doctor's userId (internal routing detail) and flattens resource bookings. */
  private toView<T extends AppointmentWithRelations>(appt: T) {
    const { userId: _userId, ...doctor } = appt.doctor;
    const { resourceBookings, ...rest } = appt;
    const resources = resourceBookings.map((b) => b.resource).sort((a, b) => a.name.localeCompare(b.name));
    return { ...rest, doctor, resources };
  }
}
