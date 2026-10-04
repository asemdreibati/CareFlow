import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppointmentStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
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

const listInclude = { doctor: { select: doctorSelect }, patient: { select: patientSelect } } as const;
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
  doctor: { id: string; userId: string | null; firstName: string; lastName: string };
  patient: { id: string; firstName: string; lastName: string };
  /** The user who performed the action (excluded from notifications). */
  actorUserId: string;
}

const MAX_CALENDAR_DAYS = 31;
const ACTIVE_STATUS_FILTER = { notIn: [...INACTIVE_STATUSES] as AppointmentStatus[] };

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
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

  async create(user: AuthUser, dto: CreateAppointmentDto) {
    this.assertCanAccessDoctor(user, dto.doctorId);
    if (dto.endsAt && dto.durationMinutes) throw new BadRequestException('Provide either endsAt or durationMinutes, not both');

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

    const created = await this.withOverlapGuard(() =>
      this.prisma.db.appointment.create({
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
        },
        include: detailInclude,
      }),
    );
    this.emit(APPOINTMENT_EVENTS.created, created, user);
    return this.toView(created);
  }

  async update(user: AuthUser, id: string, dto: UpdateAppointmentDto) {
    const existing = await this.loadForMutation(user, id);
    if (isFinalStatus(existing.status)) {
      throw new ConflictException(`A ${existing.status.toLowerCase()} appointment cannot be modified`);
    }
    const doctorId = dto.doctorId ?? existing.doctorId;
    this.assertCanAccessDoctor(user, doctorId);

    const startsAt = dto.startsAt ? this.parseDate(dto.startsAt, 'startsAt') : existing.startsAt;
    let endsAt = dto.endsAt ? this.parseDate(dto.endsAt, 'endsAt') : existing.endsAt;
    if (dto.startsAt && !dto.endsAt) {
      // Keep the original duration when only the start moves.
      endsAt = addMinutes(startsAt, (existing.endsAt.getTime() - existing.startsAt.getTime()) / 60_000);
    }
    const scheduleChanged =
      doctorId !== existing.doctorId || startsAt.getTime() !== existing.startsAt.getTime() || endsAt.getTime() !== existing.endsAt.getTime();

    if (scheduleChanged) {
      const [doctor, timeZone] = await Promise.all([this.loadDoctor(user.clinicId, doctorId), this.clinicTimezone(user.clinicId)]);
      await this.assertBookable(user.clinicId, doctor, { startsAt, endsAt }, timeZone, existing.id);
    }

    const updated = await this.withOverlapGuard(() =>
      this.prisma.db.appointment.update({
        where: { id: existing.id },
        data: { doctorId, startsAt, endsAt, type: dto.type, reason: dto.reason, notes: dto.notes },
        include: detailInclude,
      }),
    );
    this.emit(APPOINTMENT_EVENTS.updated, updated, user);
    return this.toView(updated);
  }

  async setStatus(user: AuthUser, id: string, dto: SetStatusDto) {
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
    const updated = await this.prisma.db.appointment.update({
      where: { id: existing.id },
      data: { status: dto.status, ...(dto.status === 'CANCELLED' ? { cancellationNote: dto.cancellationNote ?? null } : {}) },
      include: detailInclude,
    });
    const event =
      dto.status === 'CANCELLED' ? APPOINTMENT_EVENTS.cancelled : dto.status === 'CHECKED_IN' ? APPOINTMENT_EVENTS.checkedIn : APPOINTMENT_EVENTS.updated;
    this.emit(event, updated, user);
    return this.toView(updated);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /**
   * A DOCTOR without appointments:read_all is pinned to their own doctor profile.
   * Returns the doctorId filter to apply (undefined = no restriction).
   */
  private scopedDoctorId(user: AuthUser, requested?: string): string | undefined {
    if (!this.isRestrictedDoctor(user)) return requested;
    if (!user.doctorId) throw new ForbiddenException('Your account is not linked to a doctor profile');
    if (requested && requested !== user.doctorId) throw new ForbiddenException('You may only access your own appointments');
    return user.doctorId;
  }

  private assertCanAccessDoctor(user: AuthUser, doctorId: string) {
    this.scopedDoctorId(user, doctorId);
  }

  private isRestrictedDoctor(user: AuthUser): boolean {
    return user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
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
   * The `appointments_no_overlap` exclusion constraint is the final arbiter for
   * concurrent bookings. Prisma may surface it as an unknown request error (not
   * handled by the global filter), so translate it here.
   */
  private async withOverlapGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.message.includes('appointments_no_overlap')) {
        throw new ConflictException('This time slot overlaps another appointment for the doctor');
      }
      throw err;
    }
  }

  private parseDate(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a valid date`);
    return d;
  }

  private emit(event: string, appt: AppointmentWithRelations, actor: AuthUser) {
    const { doctor, patient, ...rest } = appt;
    const payload: AppointmentEvent = {
      ...rest,
      doctor: { id: doctor.id, userId: doctor.userId, firstName: doctor.firstName, lastName: doctor.lastName },
      patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
      actorUserId: actor.id,
    };
    this.events.emit(event, payload);
  }

  /** API shape: hides the doctor's userId (internal routing detail). */
  private toView<T extends AppointmentWithRelations>(appt: T) {
    const { userId: _userId, ...doctor } = appt.doctor;
    return { ...appt, doctor };
  }
}
