import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { enumerateSlots, freeIntervals, normalize, overlapsSorted, type Interval } from '../../scheduling-engine/intervals.js';
import { addDays, expandRecurrence, RecurrenceRuleError, type Occurrence, type RecurrenceRule } from '../../scheduling-engine/recurrence.js';
import { dayBounds, findScheduleProblem, type TimeRange } from '../appointments/scheduling.js';
import { AppointmentWriterService, appointmentInclude, type AppointmentRow, type DoctorWithAvailability } from '../waitlist/appointment-writer.service.js';
import { availabilityIntervals, slotStepMinutes, toInterval, toRange } from '../waitlist/day-availability.js';
import type { CreateSeriesDto, ListSeriesQuery, UpdateSeriesDto } from './series.dto.js';

/** How many days after the planned date `next-slot` may move an occurrence. */
const NEXT_SLOT_DAYS = 3;
const OVERLAP_REASON = 'Overlaps another appointment for the doctor';
const SERIES_CANCELLED_NOTE = 'Series cancelled';

export interface SkippedOccurrence {
  index: number;
  plannedStartsAt: string;
  reason: string;
}

interface PlannedOccurrence {
  occurrence: Occurrence;
  range: TimeRange;
  isException: boolean;
}

const doctorSummary = { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } as const;
const patientSummary = { id: true, mrn: true, firstName: true, lastName: true, phone: true } as const;

/**
 * Recurring appointment series: expands the rule (pure engine), resolves
 * conflicts per policy and inserts every occurrence in one transaction.
 */
@Injectable()
export class SeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AppointmentWriterService,
  ) {}

  // ─────────────────────────────── create ───────────────────────────────

  async create(user: AuthUser, dto: CreateSeriesDto) {
    const [doctor, patient, timeZone] = await Promise.all([
      this.writer.loadDoctor(user.clinicId, dto.doctorId),
      this.writer.loadPatient(user.clinicId, dto.patientId),
      this.writer.clinicTimezone(user.clinicId),
    ]);
    const rule: RecurrenceRule = {
      frequency: dto.frequency,
      interval: dto.interval,
      byWeekday: dto.byWeekday,
      byMonthDay: dto.byMonthDay,
      startsOn: dto.startsOn,
      startTime: dto.startTime,
      durationMinutes: dto.durationMinutes,
      count: dto.count,
      until: dto.until,
    };
    let occurrences: Occurrence[];
    try {
      occurrences = expandRecurrence(rule, timeZone);
    } catch (err) {
      if (err instanceof RecurrenceRuleError) throw new BadRequestException(err.message);
      throw err;
    }
    if (occurrences.length === 0) throw new BadRequestException('The recurrence rule produces no occurrences');
    const now = new Date();
    if (occurrences[0].startsAt < now) throw new BadRequestException('The first occurrence must be in the future');
    const resolve = dto.resolve ?? 'next-slot';

    // next-slot may move an occurrence earlier on its planned day: busy time and
    // time off are loaded from the start of the first occurrence's calendar day.
    const searchWindow: TimeRange = {
      startsAt: dayBounds(occurrences[0].date, timeZone).startsAt,
      endsAt: new Date(occurrences[occurrences.length - 1].endsAt.getTime() + (NEXT_SLOT_DAYS + 1) * 86_400_000),
    };

    const result = await this.writer.withOverlapGuard(() =>
      this.prisma.transaction(
        async (tx) => {
          const { timeOff, booked } = await this.writer.busyRanges(tx, user.clinicId, doctor.id, searchWindow);
          const { plan, skipped, conflicts } = this.planOccurrences(occurrences, doctor, timeOff, booked, timeZone, resolve, now);
          if (conflicts.length > 0) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              message: `${conflicts.length} occurrence(s) conflict with the doctor's schedule`,
              conflicts,
            });
          }
          const series = await tx.appointmentSeries.create({
            data: {
              clinicId: user.clinicId,
              doctorId: doctor.id,
              patientId: patient.id,
              frequency: dto.frequency,
              interval: dto.interval ?? 1,
              byWeekday: dto.byWeekday ?? [],
              byMonthDay: dto.byMonthDay ?? null,
              startsOn: new Date(`${dto.startsOn}T00:00:00.000Z`),
              startTime: dto.startTime,
              durationMinutes: dto.durationMinutes,
              count: dto.count ?? null,
              until: dto.until ? new Date(`${dto.until}T00:00:00.000Z`) : null,
              type: dto.type ?? 'FOLLOW_UP',
              reason: dto.reason,
              createdById: user.id,
            },
          });
          const created: AppointmentRow[] = [];
          for (const p of plan) {
            created.push(
              await this.writer.insert(tx, {
                clinicId: user.clinicId,
                doctorId: doctor.id,
                patientId: patient.id,
                startsAt: p.range.startsAt,
                endsAt: p.range.endsAt,
                type: dto.type ?? 'FOLLOW_UP',
                reason: dto.reason,
                createdById: user.id,
                seriesId: series.id,
                occurrenceIndex: p.occurrence.index,
                isException: p.isException,
              }),
            );
          }
          return { series, created, skipped };
        },
        { timeout: 60_000 },
      ),
    );
    for (const appt of result.created) this.writer.emitCreated(appt, user.id);
    return { series: result.series, created: result.created.map((a) => this.writer.toView(a)), skipped: result.skipped };
  }

  /**
   * Checks every occurrence against availability, time off and the busy set
   * (existing appointments plus the occurrences placed so far) and applies the
   * resolve policy. Pure: no database access.
   */
  private planOccurrences(
    occurrences: readonly Occurrence[],
    doctor: DoctorWithAvailability,
    timeOff: readonly TimeRange[],
    booked: readonly TimeRange[],
    timeZone: string,
    resolve: 'skip' | 'next-slot' | 'fail',
    now: Date,
  ) {
    let busy: Interval[] = normalize(booked.map(toInterval));
    const timeOffIntervals = normalize(timeOff.map(toInterval));
    const plan: PlannedOccurrence[] = [];
    const skipped: SkippedOccurrence[] = [];
    const conflicts: SkippedOccurrence[] = [];

    for (const occurrence of occurrences) {
      const range = { startsAt: occurrence.startsAt, endsAt: occurrence.endsAt };
      const problem = findScheduleProblem(range, doctor.availability, timeOff, timeZone) ?? (overlapsSorted(busy, toInterval(range)) ? OVERLAP_REASON : null);
      if (!problem) {
        plan.push({ occurrence, range, isException: false });
        busy = normalize([...busy, toInterval(range)]);
        continue;
      }
      const entry = { index: occurrence.index, plannedStartsAt: occurrence.startsAt.toISOString(), reason: problem };
      if (resolve === 'skip') {
        skipped.push(entry);
        continue;
      }
      if (resolve === 'fail') {
        conflicts.push(entry);
        continue;
      }
      const moved = this.findNextSlot(occurrence, doctor, timeOff, timeOffIntervals, busy, timeZone, now);
      if (!moved) {
        skipped.push({ ...entry, reason: `${problem}; no free slot within ${NEXT_SLOT_DAYS} days` });
        continue;
      }
      plan.push({ occurrence, range: moved, isException: true });
      busy = normalize([...busy, toInterval(moved)]);
    }
    return { plan, skipped, conflicts };
  }

  /**
   * `next-slot`: the earliest free slot on the planned day (preferring one at or
   * after the planned time), else the earliest free slot on one of the next
   * NEXT_SLOT_DAYS days. Every candidate is re-validated with the same rules as
   * a booking (availability incl. DST, time off, overlap) before it is accepted.
   */
  private findNextSlot(
    occurrence: Occurrence,
    doctor: DoctorWithAvailability,
    timeOff: readonly TimeRange[],
    timeOffIntervals: readonly Interval[],
    busy: readonly Interval[],
    timeZone: string,
    now: Date,
  ): TimeRange | null {
    const durationMs = occurrence.endsAt.getTime() - occurrence.startsAt.getTime();
    const planned = occurrence.startsAt.getTime();
    const blocked = normalize([...busy, ...timeOffIntervals]);
    for (let d = 0; d <= NEXT_SLOT_DAYS; d++) {
      const date = addDays(occurrence.date, d);
      const availability = availabilityIntervals(doctor.availability, date, timeZone);
      if (availability.length === 0) continue;
      const free = freeIntervals(availability, blocked, durationMs);
      const slots = enumerateSlots(free, durationMs, slotStepMinutes(doctor.availability, date) * 60_000).filter((s) => s.start >= now.getTime());
      const ordered = d === 0 ? [...slots.filter((s) => s.start >= planned), ...slots.filter((s) => s.start < planned)] : slots;
      for (const slot of ordered) {
        const range = toRange(slot);
        if (findScheduleProblem(range, doctor.availability, timeOff, timeZone)) continue;
        if (overlapsSorted(busy, slot)) continue;
        return range;
      }
    }
    return null;
  }

  // ─────────────────────────────── queries ───────────────────────────────

  async list(user: AuthUser, q: ListSeriesQuery) {
    const where: Prisma.AppointmentSeriesWhereInput = {
      clinicId: user.clinicId,
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.doctorId ? { doctorId: q.doctorId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const items = await this.prisma.db.appointmentSeries.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { appointments: true } } },
    });
    return this.withParties(user.clinicId, items.map(({ _count, ...s }) => ({ ...s, occurrenceCount: _count.appointments })));
  }

  async get(user: AuthUser, id: string) {
    const series = await this.loadSeries(user.clinicId, id);
    const occurrences = await this.prisma.db.appointment.findMany({
      where: { clinicId: user.clinicId, seriesId: series.id },
      orderBy: [{ occurrenceIndex: 'asc' }, { startsAt: 'asc' }],
      include: appointmentInclude,
    });
    const [withParties] = await this.withParties(user.clinicId, [series]);
    return { ...withParties, occurrences: occurrences.map((a) => this.writer.toView(a)) };
  }

  // ─────────────────────────────── mutations ───────────────────────────────

  /** `status: CANCELLED` cancels every future, non-final occurrence (one transaction) and the series. */
  async update(user: AuthUser, id: string, dto: UpdateSeriesDto) {
    const existing = await this.loadSeries(user.clinicId, id);
    if (dto.status === 'CANCELLED' && existing.status === 'CANCELLED') throw new ConflictException('Series is already cancelled');
    const now = new Date();
    const { series, cancelled } = await this.prisma.transaction(async (tx) => {
      const cancelled: AppointmentRow[] = [];
      if (dto.status === 'CANCELLED') {
        const future = await tx.appointment.findMany({
          where: { clinicId: user.clinicId, seriesId: existing.id, startsAt: { gt: now }, status: { notIn: ['COMPLETED', 'CANCELLED', 'NO_SHOW'] } },
          select: { id: true },
          orderBy: { startsAt: 'asc' },
        });
        for (const row of future) cancelled.push(await this.writer.cancel(tx, row.id, SERIES_CANCELLED_NOTE));
      }
      const series = await tx.appointmentSeries.update({
        where: { id: existing.id },
        data: { ...(dto.reason !== undefined ? { reason: dto.reason } : {}), ...(dto.status === 'CANCELLED' ? { status: 'CANCELLED' } : {}) },
      });
      return { series, cancelled };
    });
    for (const appt of cancelled) this.writer.emitCancelled(appt, user.id);
    const [withParties] = await this.withParties(user.clinicId, [series]);
    return { ...withParties, cancelledCount: cancelled.length, cancelled: cancelled.map((a) => this.writer.toView(a)) };
  }

  /** Detaches one occurrence so it can be edited independently of the series. */
  async detach(user: AuthUser, id: string, index: number) {
    const series = await this.loadSeries(user.clinicId, id);
    const appt = await this.prisma.db.appointment.findFirst({ where: { clinicId: user.clinicId, seriesId: series.id, occurrenceIndex: index }, select: { id: true } });
    if (!appt) throw new NotFoundException(`Occurrence ${index} not found in this series`);
    const updated = await this.prisma.db.appointment.update({
      where: { id: appt.id },
      data: { seriesId: null, isException: true, version: { increment: 1 } },
      include: appointmentInclude,
    });
    return this.writer.toView(updated);
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async loadSeries(clinicId: string, id: string) {
    const series = await this.prisma.db.appointmentSeries.findFirst({ where: { id, clinicId } });
    if (!series) throw new NotFoundException('Series not found');
    return series;
  }

  /** The series has no doctor/patient relations in the schema; attach summaries by id. */
  private async withParties<T extends { doctorId: string; patientId: string }>(clinicId: string, items: T[]) {
    const doctorIds = [...new Set(items.map((s) => s.doctorId))];
    const patientIds = [...new Set(items.map((s) => s.patientId))];
    const [doctors, patients] = await Promise.all([
      doctorIds.length ? this.prisma.db.doctor.findMany({ where: { clinicId, id: { in: doctorIds } }, select: doctorSummary }) : [],
      patientIds.length ? this.prisma.db.patient.findMany({ where: { clinicId, id: { in: patientIds } }, select: patientSummary }) : [],
    ]);
    const d = new Map(doctors.map((x) => [x.id, x]));
    const p = new Map(patients.map((x) => [x.id, x]));
    return items.map((s) => ({ ...s, doctor: d.get(s.doctorId) ?? null, patient: p.get(s.patientId) ?? null }));
  }
}
