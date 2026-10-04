import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppointmentStatus, AppointmentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { findScheduleProblem, INACTIVE_STATUSES, overlapsAny, type AvailabilityBlock, type TimeRange } from '../appointments/scheduling.js';

export const doctorSelect = { id: true, userId: true, firstName: true, lastName: true, title: true, specialty: true, color: true } as const;
export const patientSelect = { id: true, mrn: true, firstName: true, lastName: true, phone: true } as const;
export const appointmentInclude = { doctor: { select: doctorSelect }, patient: { select: patientSelect } } as const;

export type AppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

export const ACTIVE_STATUS_FILTER = { notIn: [...INACTIVE_STATUSES] as AppointmentStatus[] };

/** Actor id used in events emitted by background jobs (nobody to exclude from notifications). */
export const SYSTEM_ACTOR = 'system';

export interface DoctorWithAvailability {
  id: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  specialty: string;
  availability: AvailabilityBlock[];
}

export interface InsertAppointmentInput {
  clinicId: string;
  doctorId: string;
  patientId: string;
  startsAt: Date;
  endsAt: Date;
  type?: AppointmentType;
  reason?: string | null;
  notes?: string | null;
  createdById: string | null;
  holdExpiresAt?: Date | null;
  seriesId?: string | null;
  occurrenceIndex?: number | null;
  isException?: boolean;
}

export interface BookingProblem {
  kind: 'schedule' | 'overlap';
  message: string;
}

const OVERLAP_MESSAGE = 'This time slot overlaps another appointment for the doctor';

/**
 * Direct appointment writes for modules that cannot go through
 * `AppointmentsService` (waitlist holds, series occurrences). Mirrors its
 * validation (doctor/patient active, availability, time off, overlap), relies on
 * the `appointments_no_overlap` exclusion constraint as the final arbiter and
 * emits the same `appointment.*` events with the same payload shape.
 */
@Injectable()
export class AppointmentWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ─────────────────────────────── lookups ───────────────────────────────

  async loadDoctor(clinicId: string, doctorId: string): Promise<DoctorWithAvailability> {
    const doctor = await this.prisma.db.doctor.findFirst({ where: { id: doctorId, clinicId }, include: { availability: true } });
    if (!doctor) throw new NotFoundException('Doctor not found');
    if (!doctor.isActive) throw new BadRequestException('Doctor is not active');
    return doctor;
  }

  async loadPatient(clinicId: string, patientId: string) {
    const patient = await this.prisma.db.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true, firstName: true, lastName: true, isActive: true } });
    if (!patient) throw new NotFoundException('Patient not found');
    if (!patient.isActive) throw new BadRequestException('Patient is not active');
    return patient;
  }

  async clinicTimezone(clinicId: string): Promise<string> {
    const clinic = await this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    return clinic?.timezone || 'UTC';
  }

  /** Time off and active appointments of the doctor intersecting `range`. */
  async busyRanges(tx: Prisma.TransactionClient, clinicId: string, doctorId: string, range: TimeRange, excludeAppointmentId?: string) {
    const [timeOff, booked] = await Promise.all([
      tx.doctorTimeOff.findMany({
        where: { clinicId, doctorId, startsAt: { lt: range.endsAt }, endsAt: { gt: range.startsAt } },
        select: { startsAt: true, endsAt: true },
      }),
      tx.appointment.findMany({
        where: {
          clinicId,
          doctorId,
          status: ACTIVE_STATUS_FILTER,
          startsAt: { lt: range.endsAt },
          endsAt: { gt: range.startsAt },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
        select: { startsAt: true, endsAt: true },
      }),
    ]);
    return { timeOff, booked };
  }

  /** Friendly validation (availability, time off, overlap) before the DB constraint has the final word. */
  bookingProblem(doctor: DoctorWithAvailability, range: TimeRange, timeOff: readonly TimeRange[], booked: readonly TimeRange[], timeZone: string): BookingProblem | null {
    const problem = findScheduleProblem(range, doctor.availability, timeOff, timeZone);
    if (problem) return { kind: 'schedule', message: problem };
    if (overlapsAny(range, booked)) return { kind: 'overlap', message: OVERLAP_MESSAGE };
    return null;
  }

  /** Validates `range` against the live schedule inside `tx`; throws 400/409 like the appointments module. */
  async assertBookable(tx: Prisma.TransactionClient, doctor: DoctorWithAvailability, clinicId: string, range: TimeRange, timeZone: string) {
    const { timeOff, booked } = await this.busyRanges(tx, clinicId, doctor.id, range);
    const problem = this.bookingProblem(doctor, range, timeOff, booked, timeZone);
    if (!problem) return;
    if (problem.kind === 'overlap') throw new ConflictException(problem.message);
    throw new BadRequestException(problem.message);
  }

  // ─────────────────────────────── writes ───────────────────────────────

  insert(tx: Prisma.TransactionClient, input: InsertAppointmentInput): Promise<AppointmentRow> {
    return tx.appointment.create({
      data: {
        clinicId: input.clinicId,
        doctorId: input.doctorId,
        patientId: input.patientId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        type: input.type,
        reason: input.reason ?? undefined,
        notes: input.notes ?? undefined,
        createdById: input.createdById,
        holdExpiresAt: input.holdExpiresAt ?? null,
        seriesId: input.seriesId ?? null,
        occurrenceIndex: input.occurrenceIndex ?? null,
        isException: input.isException ?? false,
      },
      include: appointmentInclude,
    });
  }

  cancel(tx: Prisma.TransactionClient, id: string, cancellationNote: string): Promise<AppointmentRow> {
    return tx.appointment.update({
      where: { id },
      data: { status: 'CANCELLED', cancellationNote, version: { increment: 1 } },
      include: appointmentInclude,
    });
  }

  /** Translates the exclusion-constraint violation raised by PostgreSQL into a 409. */
  async withOverlapGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.message.includes('appointments_no_overlap')) throw new ConflictException(OVERLAP_MESSAGE);
      throw err;
    }
  }

  // ─────────────────────────────── events & views ───────────────────────────────

  emitCreated(appt: AppointmentRow, actorUserId: string) {
    this.emit(APPOINTMENT_EVENTS.created, appt, actorUserId);
  }

  emitUpdated(appt: AppointmentRow, actorUserId: string) {
    this.emit(APPOINTMENT_EVENTS.updated, appt, actorUserId);
  }

  emitCancelled(appt: AppointmentRow, actorUserId: string) {
    this.emit(APPOINTMENT_EVENTS.cancelled, appt, actorUserId);
  }

  private emit(event: string, appt: AppointmentRow, actorUserId: string) {
    const { doctor, patient, ...rest } = appt;
    const payload: AppointmentEvent = {
      ...rest,
      doctor: { id: doctor.id, userId: doctor.userId, firstName: doctor.firstName, lastName: doctor.lastName },
      patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName },
      actorUserId,
    };
    this.events.emit(event, payload);
  }

  /** API shape: hides the doctor's userId (internal routing detail). */
  toView(appt: AppointmentRow) {
    const { userId: _userId, ...doctor } = appt.doctor;
    return { ...appt, doctor };
  }
}
