import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, ProposalStatus, RescheduleProposal } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { firstEndingAfter, freeIntervals, normalize, overlapsSorted, type Interval } from '../../scheduling-engine/intervals.js';
import { disjointAssignment } from '../../scheduling-engine/matching.js';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { ResourcesService } from '../resources/resources.service.js';
import { blocksForWeekday, findScheduleProblem, weekdayOfDate, zonedParts, zonedTimeToUtc, type AvailabilityBlock } from '../appointments/scheduling.js';
import type { ApplyProposalDto, CreateProposalDto, TimeOffImpactDto } from './scheduling.dto.js';
import { addDays, BLOCKING_STATUSES, errorMessage, eventInclude, MOVABLE_STATUSES, toAppointmentEvent, type AppointmentWithEventRelations } from './scheduling.common.js';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_SEARCH_DAYS = 14;
const MAX_CANDIDATES = 2000;
const DOCTOR_CHANGE_COST = 240;
const WEEKDAY_CHANGE_COST = 60;
const PROPOSAL_LIST_LIMIT = 100;

/** One line of a proposal (stored as JSON on `reschedule_proposals.items`). */
export interface ProposalItem {
  appointmentId: string;
  patientId: string;
  patientName: string;
  /** Original start (ISO). */
  from: string;
  /** Proposed start (ISO), null when no slot was found. */
  to: string | null;
  toEndsAt: string | null;
  fromDoctorId: string;
  toDoctorId: string | null;
  toDoctorName: string | null;
  durationMinutes: number;
  displacementMinutes: number;
  /** Matching cost (minutes + penalties). */
  cost: number | null;
  /** Row version observed when the proposal was computed. */
  version: number;
  applied: boolean;
  error?: string;
}

export interface ComputedProposal {
  doctor: { id: string; firstName: string; lastName: string; specialty: string };
  timeOff: { startsAt: string; endsAt: string };
  searchWindow: { from: string; to: string };
  candidateCount: number;
  affected: AffectedAppointment[];
  items: ProposalItem[];
  unresolvedAppointmentIds: string[];
  totalDisplacementMinutes: number;
}

interface AffectedAppointment {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  type: string;
  version: number;
}

interface Candidate {
  doctorId: string;
  doctorName: string;
  start: number;
  /** End of the free gap the candidate lies in (duration must fit before it). */
  gapEnd: number;
  weekday: number;
}

interface DisplacedRow {
  id: string;
  patientId: string;
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  type: string;
  version: number;
  patient: { firstName: string; lastName: string };
}

const doctorWithAvailability = { id: true, firstName: true, lastName: true, specialty: true, isActive: true, availability: true } as const;

@Injectable()
export class RescheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly resources: ResourcesService,
  ) {}

  // ─────────────────────────────── preview / create ───────────────────────────────

  /** Preview only: nothing is persisted. */
  async timeOffImpact(user: AuthUser, dto: TimeOffImpactDto): Promise<ComputedProposal> {
    return this.compute(user.clinicId, dto);
  }

  async createProposal(user: AuthUser, dto: CreateProposalDto) {
    const computed = await this.compute(user.clinicId, dto);
    const cause = `Time off for Dr. ${computed.doctor.firstName} ${computed.doctor.lastName} from ${computed.timeOff.startsAt} to ${computed.timeOff.endsAt}${dto.reason ? ` (${dto.reason})` : ''}`;
    const proposal = await this.prisma.transaction(async (tx) => {
      let doctorTimeOffId: string | null = null;
      if (dto.createTimeOff) {
        // Deliberately bypasses the doctors module's "has appointments" guard: this proposal handles them.
        const timeOff = await tx.doctorTimeOff.create({
          data: { clinicId: user.clinicId, doctorId: dto.doctorId, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt), reason: dto.reason },
        });
        doctorTimeOffId = timeOff.id;
      }
      return tx.rescheduleProposal.create({
        data: {
          clinicId: user.clinicId,
          cause,
          doctorTimeOffId,
          items: computed.items as unknown as Prisma.InputJsonValue,
          unresolvedAppointmentIds: computed.unresolvedAppointmentIds,
          totalDisplacementMinutes: computed.totalDisplacementMinutes,
          createdById: user.id,
        },
      });
    });
    return { ...this.toView(proposal), preview: computed };
  }

  async list(user: AuthUser, status?: ProposalStatus) {
    const rows = await this.prisma.db.rescheduleProposal.findMany({
      where: { clinicId: user.clinicId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: PROPOSAL_LIST_LIMIT,
    });
    return rows.map((r) => this.toView(r));
  }

  async get(user: AuthUser, id: string) {
    return this.toView(await this.load(user.clinicId, id));
  }

  async dismiss(user: AuthUser, id: string) {
    const proposal = await this.load(user.clinicId, id);
    if (proposal.status === 'APPLIED' || proposal.status === 'DISMISSED') {
      throw new ConflictException(`Proposal is already ${proposal.status.toLowerCase()}`);
    }
    const updated = await this.prisma.db.rescheduleProposal.update({ where: { id }, data: { status: 'DISMISSED' } });
    return this.toView(updated);
  }

  // ─────────────────────────────── apply ───────────────────────────────

  /**
   * Moves the selected (default: all pending) items. Every item runs in its own
   * transaction so a failure (overlap, concurrent edit, DB constraint) is recorded
   * on that item while the others still apply. Emits `appointment.updated` per move.
   */
  async apply(user: AuthUser, id: string, dto: ApplyProposalDto) {
    const proposal = await this.load(user.clinicId, id);
    if (proposal.status === 'DISMISSED') throw new ConflictException('Proposal was dismissed');
    if (proposal.status === 'APPLIED') throw new ConflictException('Proposal was already applied');
    const items = this.items(proposal);
    const known = new Set(items.map((i) => i.appointmentId));
    const unknown = (dto.itemAppointmentIds ?? []).filter((i) => !known.has(i));
    if (unknown.length > 0) throw new BadRequestException(`Not part of this proposal: ${unknown.join(', ')}`);
    const wanted = dto.itemAppointmentIds ? new Set(dto.itemAppointmentIds) : null;

    const emitted: AppointmentEvent[] = [];
    for (const item of items) {
      if (item.applied || !item.to || !item.toDoctorId) continue;
      if (wanted && !wanted.has(item.appointmentId)) continue;
      try {
        const updated = await this.applyItem(user.clinicId, item);
        item.applied = true;
        delete item.error;
        emitted.push(toAppointmentEvent(updated, user.id));
      } catch (err) {
        item.applied = false;
        item.error = errorMessage(err);
      }
    }

    const movable = items.filter((i) => i.to && i.toDoctorId);
    const appliedCount = movable.filter((i) => i.applied).length;
    const status: ProposalStatus = movable.length > 0 && appliedCount === movable.length ? 'APPLIED' : appliedCount > 0 ? 'PARTIALLY_APPLIED' : proposal.status;
    const saved = await this.prisma.db.rescheduleProposal.update({
      where: { id },
      data: {
        items: items as unknown as Prisma.InputJsonValue,
        status,
        ...(appliedCount > 0 ? { appliedById: user.id, appliedAt: new Date() } : {}),
      },
    });
    for (const e of emitted) this.events.emit(APPOINTMENT_EVENTS.updated, e);
    return this.toView(saved);
  }

  private async applyItem(clinicId: string, item: ProposalItem): Promise<AppointmentWithEventRelations> {
    const startsAt = new Date(item.to as string);
    const endsAt = new Date(startsAt.getTime() + item.durationMinutes * MINUTE);
    const toDoctorId = item.toDoctorId as string;
    try {
      return await this.prisma.transaction(async (tx) => {
        const appt = await tx.appointment.findFirst({ where: { id: item.appointmentId, clinicId } });
        if (!appt) throw new Error('Appointment not found');
        if (!MOVABLE_STATUSES.includes(appt.status)) throw new Error(`Appointment is ${appt.status.toLowerCase()} and cannot be moved`);
        if (appt.startsAt.getTime() !== new Date(item.from).getTime() || appt.doctorId !== item.fromDoctorId) {
          throw new Error('Appointment was changed after the proposal was computed');
        }
        const [doctor, clinic] = await Promise.all([
          tx.doctor.findFirst({ where: { id: toDoctorId, clinicId }, select: doctorWithAvailability }),
          tx.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }),
        ]);
        if (!doctor || !doctor.isActive) throw new Error('Target doctor is not available');
        const timeOff = await tx.doctorTimeOff.findMany({
          where: { clinicId, doctorId: toDoctorId, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
          select: { startsAt: true, endsAt: true },
        });
        const problem = findScheduleProblem({ startsAt, endsAt }, doctor.availability, timeOff, clinic?.timezone || 'UTC');
        if (problem) throw new Error(problem);
        const others = await tx.appointment.findMany({
          where: { clinicId, doctorId: toDoctorId, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, id: { not: appt.id } },
          select: { startsAt: true, endsAt: true },
        });
        const busy = normalize(others.map((o) => ({ start: o.startsAt.getTime(), end: o.endsAt.getTime() })));
        if (overlapsSorted(busy, { start: startsAt.getTime(), end: endsAt.getTime() })) {
          throw new Error('The proposed slot overlaps another appointment for the doctor');
        }
        // Rooms / equipment move with the appointment and must be free at the new time.
        const bookings = await tx.resourceBooking.findMany({ where: { appointmentId: appt.id, active: true }, select: { resourceId: true } });
        if (bookings.length > 0) {
          await this.resources.assertAvailable(tx, clinicId, bookings.map((b) => b.resourceId), { startsAt, endsAt }, appt.id);
        }
        const res = await tx.appointment.updateMany({
          where: { id: appt.id, clinicId, version: appt.version },
          data: { doctorId: toDoctorId, startsAt, endsAt, version: { increment: 1 }, ...(appt.seriesId ? { isException: true } : {}) },
        });
        if (res.count === 0) throw new Error(`Appointment was modified by someone else (version ${appt.version})`);
        await tx.resourceBooking.updateMany({ where: { appointmentId: appt.id }, data: { startsAt, endsAt } });
        return tx.appointment.findUniqueOrThrow({ where: { id: appt.id }, include: eventInclude });
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('appointments_no_overlap')) {
        throw new Error('The proposed slot overlaps another appointment for the doctor (database constraint)');
      }
      if (err instanceof Error && err.message.includes('resource_bookings_no_overlap')) {
        throw new Error('One of the booked resources is not available at the proposed time (database constraint)');
      }
      throw err;
    }
  }

  // ─────────────────────────────── computation ───────────────────────────────

  private async compute(clinicId: string, dto: TimeOffImpactDto, now = new Date()): Promise<ComputedProposal> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BadRequestException('Invalid date');
    if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
    const searchDays = dto.searchDays ?? DEFAULT_SEARCH_DAYS;

    const [doctor, clinic] = await Promise.all([
      this.prisma.db.doctor.findFirst({ where: { id: dto.doctorId, clinicId }, select: doctorWithAvailability }),
      this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }),
    ]);
    if (!doctor) throw new NotFoundException('Doctor not found');
    const timeZone = clinic?.timezone || 'UTC';

    const displaced: DisplacedRow[] = await this.prisma.db.appointment.findMany({
      where: { clinicId, doctorId: doctor.id, status: { in: [...MOVABLE_STATUSES] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
      orderBy: { startsAt: 'asc' },
      select: { id: true, patientId: true, doctorId: true, startsAt: true, endsAt: true, status: true, type: true, version: true, patient: { select: { firstName: true, lastName: true } } },
    });
    const base = {
      doctor: { id: doctor.id, firstName: doctor.firstName, lastName: doctor.lastName, specialty: doctor.specialty },
      timeOff: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
      affected: displaced.map((a) => this.affected(a)),
    };
    const windowEnd = new Date(endsAt.getTime() + searchDays * DAY_MS);
    // Same doctor: only after the time off. Other doctors: from the start of the time off (they are not away).
    const sameDoctorFrom = new Date(Math.max(now.getTime(), endsAt.getTime()));
    const otherDoctorFrom = new Date(Math.max(now.getTime(), startsAt.getTime()));
    const searchWindow = { from: otherDoctorFrom.toISOString(), to: windowEnd.toISOString() };
    if (displaced.length === 0) {
      return { ...base, searchWindow, candidateCount: 0, items: [], unresolvedAppointmentIds: [], totalDisplacementMinutes: 0 };
    }

    const otherDoctors = dto.allowOtherDoctors
      ? await this.prisma.db.doctor.findMany({ where: { clinicId, isActive: true, specialty: doctor.specialty, id: { not: doctor.id } }, select: doctorWithAvailability })
      : [];
    const doctors = [doctor, ...otherDoctors];
    const doctorIds = doctors.map((d) => d.id);
    const displacedIds = displaced.map((a) => a.id);
    const patientIds = [...new Set(displaced.map((a) => a.patientId))];

    const [booked, timeOffRows, patientRows] = await Promise.all([
      this.prisma.db.appointment.findMany({
        where: { clinicId, doctorId: { in: doctorIds }, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: windowEnd }, endsAt: { gt: otherDoctorFrom }, id: { notIn: displacedIds } },
        select: { doctorId: true, startsAt: true, endsAt: true },
      }),
      this.prisma.db.doctorTimeOff.findMany({
        where: { clinicId, doctorId: { in: doctorIds }, startsAt: { lt: windowEnd }, endsAt: { gt: otherDoctorFrom } },
        select: { doctorId: true, startsAt: true, endsAt: true },
      }),
      this.prisma.db.appointment.findMany({
        where: { clinicId, patientId: { in: patientIds }, status: { in: [...BLOCKING_STATUSES] }, startsAt: { lt: windowEnd }, endsAt: { gt: otherDoctorFrom }, id: { notIn: displacedIds } },
        select: { patientId: true, startsAt: true, endsAt: true },
      }),
    ]);
    const busyByDoctor = new Map<string, Interval[]>();
    const push = (map: Map<string, Interval[]>, key: string, i: Interval) => {
      const list = map.get(key);
      if (list) list.push(i);
      else map.set(key, [i]);
    };
    for (const b of [...booked, ...timeOffRows]) push(busyByDoctor, b.doctorId, { start: b.startsAt.getTime(), end: b.endsAt.getTime() });
    // The time off being planned is busy for its doctor even before it is persisted.
    push(busyByDoctor, doctor.id, { start: startsAt.getTime(), end: endsAt.getTime() });
    const patientBusy = new Map<string, Interval[]>();
    for (const p of patientRows) push(patientBusy, p.patientId, { start: p.startsAt.getTime(), end: p.endsAt.getTime() });
    for (const [k, v] of patientBusy) patientBusy.set(k, normalize(v));

    // Candidate slots (right side of the bipartite graph).
    let candidates: Candidate[] = [];
    for (const d of doctors) {
      const from = d.id === doctor.id ? sameDoctorFrom : otherDoctorFrom;
      candidates.push(...this.candidateSlots(d, { start: from.getTime(), end: windowEnd.getTime() }, normalize(busyByDoctor.get(d.id) ?? []), timeZone));
    }
    candidates.sort((a, b) => a.start - b.start || a.doctorId.localeCompare(b.doctorId));
    if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES);

    // Cost matrix.
    const matrix: number[][] = displaced.map((a) => {
      const origStart = a.startsAt.getTime();
      const duration = a.endsAt.getTime() - origStart;
      const origWeekday = zonedParts(a.startsAt, timeZone).weekday;
      const mine = patientBusy.get(a.patientId) ?? [];
      return candidates.map((c) => {
        if (c.start + duration > c.gapEnd) return Infinity;
        if (overlapsSorted(mine, { start: c.start, end: c.start + duration })) return Infinity;
        let cost = Math.abs(c.start - origStart) / MINUTE;
        if (c.doctorId !== a.doctorId) cost += DOCTOR_CHANGE_COST;
        if (c.weekday !== origWeekday) cost += WEEKDAY_CHANGE_COST;
        return cost;
      });
    });
    const assignment = this.solve(matrix, displaced, candidates);

    const items: ProposalItem[] = [];
    const unresolvedAppointmentIds: string[] = [];
    let totalDisplacementMinutes = 0;
    displaced.forEach((a, row) => {
      const col = assignment[row];
      const c = col >= 0 ? candidates[col] : null;
      const duration = (a.endsAt.getTime() - a.startsAt.getTime()) / MINUTE;
      const displacement = c ? Math.round(Math.abs(c.start - a.startsAt.getTime()) / MINUTE) : 0;
      if (!c) unresolvedAppointmentIds.push(a.id);
      totalDisplacementMinutes += displacement;
      items.push({
        appointmentId: a.id,
        patientId: a.patientId,
        patientName: `${a.patient.firstName} ${a.patient.lastName}`,
        from: a.startsAt.toISOString(),
        to: c ? new Date(c.start).toISOString() : null,
        toEndsAt: c ? new Date(c.start + duration * MINUTE).toISOString() : null,
        fromDoctorId: a.doctorId,
        toDoctorId: c ? c.doctorId : null,
        toDoctorName: c ? c.doctorName : null,
        durationMinutes: duration,
        displacementMinutes: displacement,
        cost: c ? matrix[row][col] : null,
        version: a.version,
        applied: false,
      });
    });
    return { ...base, searchWindow, candidateCount: candidates.length, items, unresolvedAppointmentIds, totalDisplacementMinutes };
  }

  /**
   * Min-cost matching whose placements never overlap on the same doctor: the
   * grid guarantees distinct starts, not disjoint ranges (a 60-minute appointment
   * on a 30-minute grid can collide with its neighbour). See `disjointAssignment`
   * for the repair loop (bounded by the number of candidate columns).
   */
  private solve(matrix: number[][], displaced: readonly DisplacedRow[], candidates: readonly Candidate[]): number[] {
    const durations = displaced.map((a) => a.endsAt.getTime() - a.startsAt.getTime());
    return disjointAssignment(matrix, durations, candidates.map((c) => ({ group: c.doctorId, start: c.start }))).assignment;
  }

  /** Grid-aligned free starts of one doctor inside `window` (epoch ms), with the free gap end for duration checks. */
  private candidateSlots(
    doctor: { id: string; firstName: string; lastName: string; availability: AvailabilityBlock[] },
    window: Interval,
    busy: readonly Interval[],
    timeZone: string,
  ): Candidate[] {
    const out: Candidate[] = [];
    if (doctor.availability.length === 0 || window.end <= window.start) return out;
    const doctorName = `${doctor.firstName} ${doctor.lastName}`;
    const seen = new Set<number>();
    const firstDate = zonedParts(new Date(window.start), timeZone).date;
    const lastDate = zonedParts(new Date(window.end), timeZone).date;
    for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
      const weekday = weekdayOfDate(date);
      for (const block of blocksForWeekday(doctor.availability, weekday)) {
        const stepMs = (block.slotMinutes || 30) * MINUTE;
        const blockStart = zonedTimeToUtc(date, block.startTime, timeZone).getTime();
        const blockEnd = zonedTimeToUtc(date, block.endTime, timeZone).getTime();
        if (blockEnd <= blockStart) continue;
        const free = freeIntervals([{ start: Math.max(blockStart, window.start), end: Math.min(blockEnd, window.end) }], busy, stepMs);
        if (free.length === 0) continue;
        for (let s = blockStart; s + stepMs <= blockEnd; s += stepMs) {
          if (s < window.start || seen.has(s)) continue;
          const idx = firstEndingAfter(free, s);
          const gap = free[idx];
          if (!gap || gap.start > s || s + stepMs > gap.end) continue;
          seen.add(s);
          out.push({ doctorId: doctor.id, doctorName, start: s, gapEnd: gap.end, weekday });
        }
      }
    }
    return out;
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async load(clinicId: string, id: string) {
    const proposal = await this.prisma.db.rescheduleProposal.findFirst({ where: { id, clinicId } });
    if (!proposal) throw new NotFoundException('Proposal not found');
    return proposal;
  }

  private items(proposal: RescheduleProposal): ProposalItem[] {
    return Array.isArray(proposal.items) ? (proposal.items as unknown as ProposalItem[]) : [];
  }

  private affected(a: DisplacedRow): AffectedAppointment {
    return {
      id: a.id,
      patientId: a.patientId,
      patientName: `${a.patient.firstName} ${a.patient.lastName}`,
      doctorId: a.doctorId,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      type: a.type,
      version: a.version,
    };
  }

  private toView(proposal: RescheduleProposal) {
    return { ...proposal, items: this.items(proposal) };
  }
}
