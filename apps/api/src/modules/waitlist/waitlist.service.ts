import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma, WaitlistEntry } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { topK } from '../../scheduling-engine/heap.js';
import { enumerateSlots, freeIntervals } from '../../scheduling-engine/intervals.js';
import { entryAdmitsSlot, firstAdmittedSlot, rankEntries, type PreferredWindow, type WaitlistCandidate } from '../../scheduling-engine/waitlist-matching.js';
import type { AppointmentEvent } from '../appointments/appointments.service.js';
import { addMinutes, defaultDurationMinutes, INACTIVE_STATUSES, type TimeRange } from '../appointments/scheduling.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ACTIVE_STATUS_FILTER, AppointmentWriterService, appointmentInclude, SYSTEM_ACTOR, type AppointmentRow, type DoctorWithAvailability } from './appointment-writer.service.js';
import { availabilityIntervals, daysBetween, slotStepMinutes, toInterval } from './day-availability.js';
import { HOLD_BOOKED_NOTE, HOLD_EXPIRED_NOTE, HOLD_NOTE, HOLD_SETTLING_STATUSES, isHoldSettlingStatus } from './hold-lifecycle.js';
import type { BookWaitlistDto, CreateWaitlistEntryDto, ListWaitlistQuery, UpdateWaitlistEntryDto } from './waitlist.dto.js';

export { HOLD_BOOKED_NOTE, HOLD_EXPIRED_NOTE, HOLD_NOTE } from './hold-lifecycle.js';
export const HOLD_HOURS = 24;
export const MAX_OFFERS = 3;
const MATCH_DAYS = 14;
const INACTIVE_STATUS_SET = new Set<string>(INACTIVE_STATUSES);

export interface HoldMaintenanceResult {
  /** Expired SCHEDULED holds cancelled by the job. */
  expired: number;
  /** Freed slots offered to the next entry. */
  reoffered: number;
  /** Holds (or their entries) found confirmed / checked in and marked BOOKED. */
  settled: number;
  /** OFFERED entries whose appointment was gone, returned to WAITING. */
  released: number;
}
const MATCH_LIMIT = 20;

const entryInclude = {
  offeredAppointment: { select: { id: true, doctorId: true, startsAt: true, endsAt: true, status: true, holdExpiresAt: true } },
} as const;

type EntryRow = Prisma.WaitlistEntryGetPayload<{ include: typeof entryInclude }>;

const doctorSummary = { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } as const;
const patientSummary = { id: true, mrn: true, firstName: true, lastName: true, phone: true } as const;

/**
 * Waitlist: entries waiting for a slot, backfilled automatically when an
 * appointment is cancelled (timed hold the patient accepts or declines) and
 * bookable directly from the computed matches.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AppointmentWriterService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─────────────────────────────── CRUD ───────────────────────────────

  async list(user: AuthUser, q: ListWaitlistQuery) {
    const where: Prisma.WaitlistEntryWhereInput = {
      clinicId: user.clinicId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.doctorId ? { doctorId: q.doctorId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.waitlistEntry.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }], include: entryInclude }),
      this.prisma.db.waitlistEntry.count({ where }),
    ]);
    return paginate(await this.withParties(user.clinicId, items), total, q);
  }

  async get(user: AuthUser, id: string) {
    const entry = await this.loadEntry(user.clinicId, id);
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  async create(user: AuthUser, dto: CreateWaitlistEntryDto) {
    if (!dto.doctorId && !dto.specialty) throw new BadRequestException('Provide doctorId or specialty');
    await this.writer.loadPatient(user.clinicId, dto.patientId);
    let specialty = dto.specialty?.trim() || null;
    if (dto.doctorId) {
      const doctor = await this.writer.loadDoctor(user.clinicId, dto.doctorId);
      specialty = specialty ?? doctor.specialty;
    }
    const { earliestAt, latestAt } = this.parseBounds(dto.earliestAt, dto.latestAt);
    const entry = await this.prisma.db.waitlistEntry.create({
      data: {
        clinicId: user.clinicId,
        patientId: dto.patientId,
        doctorId: dto.doctorId ?? null,
        specialty,
        durationMinutes: dto.durationMinutes ?? 30,
        priority: dto.priority ?? 'ROUTINE',
        earliestAt: earliestAt ?? new Date(),
        latestAt,
        preferredWindows: (dto.preferredWindows ?? []) as unknown as Prisma.InputJsonValue,
        type: dto.type ?? 'CONSULTATION',
        notes: dto.notes,
        createdById: user.id,
      },
      include: entryInclude,
    });
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  async update(user: AuthUser, id: string, dto: UpdateWaitlistEntryDto) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status === 'BOOKED' || existing.status === 'CANCELLED') {
      throw new ConflictException(`A ${existing.status.toLowerCase()} waitlist entry cannot be modified`);
    }
    if (dto.patientId) await this.writer.loadPatient(user.clinicId, dto.patientId);
    const doctorId = dto.doctorId === undefined ? existing.doctorId : dto.doctorId;
    let specialty = dto.specialty === undefined ? existing.specialty : dto.specialty?.trim() || null;
    if (dto.doctorId) specialty = specialty ?? (await this.writer.loadDoctor(user.clinicId, dto.doctorId)).specialty;
    if (!doctorId && !specialty) throw new BadRequestException('Provide doctorId or specialty');
    const { earliestAt, latestAt } = this.parseBounds(dto.earliestAt ?? existing.earliestAt.toISOString(), dto.latestAt === undefined ? existing.latestAt?.toISOString() : dto.latestAt);
    const entry = await this.prisma.db.waitlistEntry.update({
      where: { id: existing.id },
      data: {
        patientId: dto.patientId,
        doctorId,
        specialty,
        durationMinutes: dto.durationMinutes,
        priority: dto.priority,
        earliestAt,
        latestAt,
        ...(dto.preferredWindows !== undefined ? { preferredWindows: dto.preferredWindows as unknown as Prisma.InputJsonValue } : {}),
        type: dto.type,
        notes: dto.notes,
      },
      include: entryInclude,
    });
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  /** DELETE → CANCELLED. An outstanding hold is cancelled as well. */
  async remove(user: AuthUser, id: string) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status === 'CANCELLED') return (await this.withParties(user.clinicId, [existing]))[0];
    const { entry, hold } = await this.prisma.transaction(async (tx) => {
      // Entry first: the hold's cancellation must not send it back to WAITING.
      const entry = await tx.waitlistEntry.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', offeredAppointmentId: null, offerExpiresAt: null },
        include: entryInclude,
      });
      const hold = existing.status === 'OFFERED' && existing.offeredAppointmentId ? await this.cancelHold(tx, existing.offeredAppointmentId, 'Waitlist entry cancelled') : null;
      return { entry, hold };
    });
    if (hold) this.writer.emitCancelled(hold, user.id);
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  // ─────────────────────────────── matches & booking ───────────────────────────────

  /**
   * Slots that would satisfy the entry now: free slots of the matching doctors
   * over the next 14 days (availability minus time off and active appointments),
   * filtered by the entry's constraints, earliest 20.
   */
  async matches(user: AuthUser, id: string) {
    const entry = await this.loadEntry(user.clinicId, id);
    const timeZone = await this.writer.clinicTimezone(user.clinicId);
    const doctors = await this.matchingDoctors(user.clinicId, entry);
    const now = new Date();
    const from = new Date(Math.max(now.getTime(), entry.earliestAt.getTime()));
    const horizon = new Date(from.getTime() + MATCH_DAYS * 86_400_000);
    const to = entry.latestAt && entry.latestAt < horizon ? entry.latestAt : horizon;
    const candidate = this.toCandidate(entry);
    type Hit = { doctor: typeof doctors[number]; startsAt: Date; endsAt: Date };
    const hits: Hit[] = [];
    if (to > from) {
      const busyByDoctor = await this.prisma.transaction(async (tx) => {
        const out = new Map<string, TimeRange[]>();
        for (const doctor of doctors) {
          const { timeOff, booked } = await this.writer.busyRanges(tx, user.clinicId, doctor.id, { startsAt: from, endsAt: to });
          out.set(doctor.id, [...timeOff, ...booked]);
        }
        return out;
      });
      for (const doctor of doctors) {
        const busy = (busyByDoctor.get(doctor.id) ?? []).map(toInterval);
        for (const day of daysBetween(from, to, timeZone)) {
          const availability = availabilityIntervals(doctor.availability, day, timeZone);
          if (availability.length === 0) continue;
          const step = slotStepMinutes(doctor.availability, day);
          const free = freeIntervals(availability, busy, candidate.durationMinutes * 60_000);
          for (const s of enumerateSlots(free, candidate.durationMinutes * 60_000, step * 60_000)) {
            if (s.start < from.getTime()) continue;
            const slot = { startsAt: new Date(s.start), endsAt: new Date(s.end) };
            if (entryAdmitsSlot(candidate, slot, timeZone)) hits.push({ doctor, ...slot });
          }
        }
      }
    }
    const best = topK(hits, MATCH_LIMIT, (a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.doctor.lastName.localeCompare(b.doctor.lastName));
    return {
      entry: (await this.withParties(user.clinicId, [entry]))[0],
      candidates: best.map((h) => ({
        doctor: { id: h.doctor.id, firstName: h.doctor.firstName, lastName: h.doctor.lastName, title: h.doctor.title, specialty: h.doctor.specialty, color: h.doctor.color },
        startsAt: h.startsAt.toISOString(),
        endsAt: h.endsAt.toISOString(),
      })),
    };
  }

  /** Book one of the matches directly: creates the appointment and marks the entry BOOKED. */
  async book(user: AuthUser, id: string, dto: BookWaitlistDto) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status !== 'WAITING') throw new ConflictException(`Only WAITING entries can be booked (entry is ${existing.status})`);
    if (existing.doctorId && existing.doctorId !== dto.doctorId) throw new BadRequestException('doctorId does not match the doctor requested by the entry');
    const [doctor, patient, timeZone] = await Promise.all([
      this.writer.loadDoctor(user.clinicId, dto.doctorId),
      this.writer.loadPatient(user.clinicId, existing.patientId),
      this.writer.clinicTimezone(user.clinicId),
    ]);
    if (!existing.doctorId && existing.specialty && doctor.specialty !== existing.specialty) {
      throw new BadRequestException(`Doctor specialty does not match the entry (${existing.specialty})`);
    }
    const startsAt = new Date(dto.startsAt);
    if (Number.isNaN(startsAt.getTime())) throw new BadRequestException('startsAt is not a valid date');
    const range = { startsAt, endsAt: addMinutes(startsAt, existing.durationMinutes) };

    const { appointment, entry } = await this.writer.withOverlapGuard(() =>
      this.prisma.transaction(async (tx) => {
        // Compare-and-set against a concurrent hold / second booking of the same entry.
        const claim = await tx.waitlistEntry.updateMany({ where: { id: existing.id, status: 'WAITING' }, data: { status: 'BOOKED', offerExpiresAt: null } });
        if (claim.count === 0) throw new ConflictException('Only WAITING entries can be booked (the entry changed meanwhile)');
        await this.writer.assertBookable(tx, doctor, user.clinicId, range, timeZone);
        const appointment = await this.writer.insert(tx, {
          clinicId: user.clinicId,
          doctorId: doctor.id,
          patientId: patient.id,
          ...range,
          type: existing.type,
          reason: existing.notes,
          createdById: user.id,
        });
        const entry = await tx.waitlistEntry.update({
          where: { id: existing.id },
          data: { offeredAppointmentId: appointment.id },
          include: entryInclude,
        });
        return { appointment, entry };
      }),
    );
    this.writer.emitCreated(appointment, user.id);
    return { entry: (await this.withParties(user.clinicId, [entry]))[0], appointment: this.writer.toView(appointment) };
  }

  /** The patient accepted the offered hold: the hold becomes a firm appointment. */
  async accept(user: AuthUser, id: string) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status !== 'OFFERED' || !existing.offeredAppointmentId) throw new ConflictException('No offer is pending for this entry');
    const holdId = existing.offeredAppointmentId;
    const { appointment, entry } = await this.prisma.transaction(async (tx) => {
      // Compare-and-set on both rows: the expiry job (or a staff cancel) may have won the race.
      const claim = await tx.waitlistEntry.updateMany({
        where: { id: existing.id, status: 'OFFERED', offeredAppointmentId: holdId },
        data: { status: 'BOOKED', offerExpiresAt: null },
      });
      if (claim.count === 0) throw new ConflictException('No offer is pending for this entry');
      const firm = await tx.appointment.updateMany({
        where: { id: holdId, clinicId: user.clinicId, status: ACTIVE_STATUS_FILTER },
        // The note no longer marks a hold: a later cancellation must backfill the slot.
        data: { holdExpiresAt: null, notes: HOLD_BOOKED_NOTE, version: { increment: 1 } },
      });
      if (firm.count === 0) throw new ConflictException('The offered slot is no longer held');
      const appointment = await tx.appointment.findUniqueOrThrow({ where: { id: holdId }, include: appointmentInclude });
      const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: existing.id }, include: entryInclude });
      return { appointment, entry };
    });
    this.writer.emitUpdated(appointment, user.id);
    return { entry: (await this.withParties(user.clinicId, [entry]))[0], appointment: this.writer.toView(appointment) };
  }

  /** The patient declined: the hold is cancelled and the entry waits again (offerCount + 1). */
  async decline(user: AuthUser, id: string) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status !== 'OFFERED' || !existing.offeredAppointmentId) throw new ConflictException('No offer is pending for this entry');
    const holdId = existing.offeredAppointmentId;
    const { hold, entry } = await this.prisma.transaction(async (tx) => {
      // Compare-and-set first (vs accept / expiry), then cancel the hold (which finds no OFFERED entry left to release).
      const claim = await tx.waitlistEntry.updateMany({
        where: { id: existing.id, status: 'OFFERED', offeredAppointmentId: holdId },
        data: { status: 'WAITING', offeredAppointmentId: null, offerExpiresAt: null, offerCount: { increment: 1 } },
      });
      if (claim.count === 0) throw new ConflictException('No offer is pending for this entry');
      const hold = await this.cancelHold(tx, holdId, 'Waitlist offer declined');
      const entry = await tx.waitlistEntry.findUniqueOrThrow({ where: { id: existing.id }, include: entryInclude });
      return { hold, entry };
    });
    if (hold) this.writer.emitCancelled(hold, user.id);
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  // ─────────────────────────────── backfill ───────────────────────────────

  /**
   * Reacts to `appointment.cancelled`: offers the freed interval to the best
   * waiting entry. Cancelled holds that were never taken (declined / expired /
   * withdrawn offers, still carrying `holdExpiresAt`) are skipped — the expiry
   * job re-runs backfill itself, and a declined slot is not re-offered. An
   * accepted or confirmed waitlist appointment has no `holdExpiresAt` any more
   * and is backfilled like any other appointment.
   */
  async onAppointmentCancelled(e: AppointmentEvent & { holdExpiresAt?: Date | string | null }) {
    try {
      if (e.holdExpiresAt) return;
      const freed = { startsAt: new Date(e.startsAt), endsAt: new Date(e.endsAt) };
      await this.backfill(e.clinicId, e.doctorId, freed, e.actorUserId ?? SYSTEM_ACTOR);
    } catch (err) {
      this.logger.error(`Waitlist backfill failed for appointment ${e.id}: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  /**
   * Reacts to `appointment.updated` / `appointment.checked_in`: a hold that was
   * confirmed or checked in by any path (staff, portal, SMS reply) becomes firm —
   * `holdExpiresAt` is cleared and the entry is BOOKED. Never throws.
   */
  async onAppointmentProgressed(e: AppointmentEvent) {
    if (!e.holdExpiresAt || !isHoldSettlingStatus(e.status)) return;
    try {
      await this.prisma.transaction((tx) => this.writer.settleHold(tx, e.id));
    } catch (err) {
      this.logger.error(`Settling hold ${e.id} failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  /**
   * Offers `freed` (clipped to the future) to the best admitting WAITING entry of
   * the doctor (or their specialty): creates a held appointment (24h), marks the
   * entry OFFERED and notifies. Candidates are tried in heap order until one
   * hold succeeds. Returns the offered entry id or null.
   */
  async backfill(clinicId: string, doctorId: string, freed: TimeRange, actorUserId: string, excludeEntryId?: string): Promise<string | null> {
    const now = new Date();
    const start = new Date(Math.max(freed.startsAt.getTime(), now.getTime()));
    if (freed.endsAt.getTime() - start.getTime() < 5 * 60_000) return null;
    const window = { startsAt: start, endsAt: freed.endsAt };

    const doctor = await this.prisma.db.doctor.findFirst({ where: { id: doctorId, clinicId, isActive: true }, include: { availability: true } });
    if (!doctor) return null;
    const timeZone = await this.writer.clinicTimezone(clinicId);
    const lengthMinutes = (window.endsAt.getTime() - window.startsAt.getTime()) / 60_000;

    const entries = await this.prisma.db.waitlistEntry.findMany({
      where: {
        clinicId,
        status: 'WAITING',
        offerCount: { lt: MAX_OFFERS },
        durationMinutes: { lte: Math.floor(lengthMinutes) },
        earliestAt: { lt: window.endsAt },
        OR: [{ latestAt: null }, { latestAt: { gt: window.startsAt } }],
        ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
        AND: [{ OR: [{ doctorId: doctor.id }, { doctorId: null, specialty: doctor.specialty }] }],
      },
    });
    const step = defaultDurationMinutes(doctor.availability, window.startsAt, timeZone);
    const ranked = rankEntries(entries.map((row) => ({ ...this.toCandidate(row), row })));

    for (const candidate of ranked) {
      const slot = firstAdmittedSlot(candidate, window, timeZone, step);
      if (!slot) continue;
      const offered = await this.tryHold(clinicId, doctor, candidate.row, slot, timeZone, actorUserId);
      if (offered) return candidate.row.id;
    }
    return null;
  }

  /** Attempts one hold for one entry; false when the slot is not bookable (the next candidate is tried). */
  private async tryHold(clinicId: string, doctor: DoctorWithAvailability, entry: WaitlistEntry, slot: TimeRange, timeZone: string, actorUserId: string): Promise<boolean> {
    const expiresAt = new Date(Date.now() + HOLD_HOURS * 3_600_000);
    let hold: AppointmentRow;
    try {
      hold = await this.writer.withOverlapGuard(() =>
        this.prisma.transaction(async (tx) => {
          const patient = await tx.patient.findFirst({ where: { id: entry.patientId, clinicId, isActive: true }, select: { id: true } });
          if (!patient) throw new BadRequestException('Patient is not active');
          // Claim the entry first (compare-and-set): concurrent backfills (e.g. a whole
          // series cancelled at once) block here and give up once it is OFFERED.
          const claim = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: 'WAITING' }, data: { status: 'OFFERED', offerExpiresAt: expiresAt } });
          if (claim.count === 0) throw new ConflictException('Entry is no longer waiting');
          await this.writer.assertBookable(tx, doctor, clinicId, slot, timeZone);
          const created = await this.writer.insert(tx, {
            clinicId,
            doctorId: doctor.id,
            patientId: entry.patientId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            type: entry.type,
            reason: entry.notes,
            notes: HOLD_NOTE,
            createdById: entry.createdById ?? (actorUserId === SYSTEM_ACTOR ? null : actorUserId),
            holdExpiresAt: expiresAt,
          });
          await tx.waitlistEntry.update({ where: { id: entry.id }, data: { offeredAppointmentId: created.id } });
          return created;
        }),
      );
    } catch (err) {
      this.logger.warn(`Waitlist hold for entry ${entry.id} not possible: ${(err as Error).message}`);
      return false;
    }

    this.writer.emitCreated(hold, actorUserId);
    const when = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(hold.startsAt);
    const expires = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(expiresAt);
    await this.notifications.notify([entry.createdById, doctor.userId].filter((id): id is string => !!id), {
      clinicId,
      type: 'APPOINTMENT_CREATED',
      title: 'Waitlist offer',
      body: `A slot on ${when} with Dr. ${doctor.firstName} ${doctor.lastName} is held for ${hold.patient.firstName} ${hold.patient.lastName} until ${expires}.`,
      data: { appointmentId: hold.id, waitlistEntryId: entry.id, doctorId: doctor.id, patientId: entry.patientId, startsAt: hold.startsAt.toISOString(), holdExpiresAt: expiresAt.toISOString() },
    });
    return true;
  }

  // ─────────────────────────────── hold expiry ───────────────────────────────

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireHoldsJob() {
    try {
      await this.expireHolds();
    } catch (err) {
      this.logger.error(`Hold expiry job failed: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  /**
   * Hold maintenance per clinic (system context), never throws:
   * - SCHEDULED holds whose expiry passed are cancelled (compare-and-set, so a
   *   hold confirmed / checked in meanwhile is never touched), their entries wait
   *   again (offerCount + 1) and backfill re-runs for the freed slot;
   * - holds that progressed (confirmed, checked in, …) but still carry
   *   `holdExpiresAt` are settled (entry BOOKED);
   * - OFFERED entries whose offer expired but whose appointment is no longer an
   *   active hold (cancelled / no-show / gone) wait again.
   */
  async expireHolds(now = new Date()): Promise<HoldMaintenanceResult> {
    const result: HoldMaintenanceResult = { expired: 0, reoffered: 0, settled: 0, released: 0 };
    let clinicIds: string[] = [];
    try {
      clinicIds = await tenantContext.runSystem(async () => {
        const [holds, entries] = await Promise.all([
          this.prisma.db.appointment.findMany({
            where: { OR: [{ holdExpiresAt: { lt: now }, status: 'SCHEDULED' }, { holdExpiresAt: { not: null }, status: { in: [...HOLD_SETTLING_STATUSES] } }] },
            distinct: ['clinicId'],
            select: { clinicId: true },
          }),
          this.prisma.db.waitlistEntry.findMany({ where: { status: 'OFFERED', offerExpiresAt: { lt: now } }, distinct: ['clinicId'], select: { clinicId: true } }),
        ]);
        return [...new Set([...holds, ...entries].map((r) => r.clinicId))];
      });
    } catch (err) {
      this.logger.error(`Hold expiry: could not list clinics: ${(err as Error).message}`);
      return result;
    }

    for (const clinicId of clinicIds) {
      try {
        const r = await tenantContext.runSystem(() => this.expireClinicHolds(clinicId, now), { clinicId });
        result.expired += r.expired;
        result.reoffered += r.reoffered;
        result.settled += r.settled;
        result.released += r.released;
      } catch (err) {
        this.logger.error(`Hold expiry failed for clinic ${clinicId}: ${(err as Error).message}`, (err as Error).stack);
      }
    }
    return result;
  }

  private async expireClinicHolds(clinicId: string, now: Date): Promise<HoldMaintenanceResult> {
    const result: HoldMaintenanceResult = { expired: 0, reoffered: 0, settled: 0, released: 0 };

    // 1. Holds the patient already took: never expire them, settle them.
    const progressed = await this.prisma.db.appointment.findMany({
      where: { clinicId, holdExpiresAt: { not: null }, status: { in: [...HOLD_SETTLING_STATUSES] } },
      select: { id: true },
    });
    for (const row of progressed) {
      try {
        if (await this.prisma.transaction((tx) => this.writer.settleHold(tx, row.id))) result.settled++;
      } catch (err) {
        this.logger.error(`Hold ${row.id} could not be settled: ${(err as Error).message}`);
      }
    }

    // 2. Expired holds that are still only SCHEDULED.
    const holds = await this.prisma.db.appointment.findMany({
      where: { clinicId, holdExpiresAt: { lt: now }, status: 'SCHEDULED' },
      select: { id: true, doctorId: true, startsAt: true, endsAt: true },
      orderBy: { holdExpiresAt: 'asc' },
    });
    for (const hold of holds) {
      try {
        const { cancelled, entryId } = await this.prisma.transaction(async (tx) => {
          const entries = await tx.waitlistEntry.findMany({ where: { clinicId, offeredAppointmentId: hold.id, status: 'OFFERED' }, select: { id: true } });
          // Compare-and-set: loses against a concurrent accept / confirm / check-in / cancel.
          const cancelled = await this.writer.cancelIf(tx, hold.id, { clinicId, status: 'SCHEDULED', holdExpiresAt: { lt: now } }, HOLD_EXPIRED_NOTE);
          return { cancelled, entryId: entries[0]?.id };
        });
        if (!cancelled) continue;
        result.expired++;
        this.writer.emitCancelled(cancelled, SYSTEM_ACTOR);
        const reoffered = await this.backfill(clinicId, hold.doctorId, { startsAt: hold.startsAt, endsAt: hold.endsAt }, SYSTEM_ACTOR, entryId);
        if (reoffered) result.reoffered++;
      } catch (err) {
        this.logger.error(`Hold ${hold.id} could not be expired: ${(err as Error).message}`);
      }
    }

    // 3. Offers stuck in OFFERED although their appointment is no longer an active hold.
    const stale = await this.prisma.db.waitlistEntry.findMany({
      where: { clinicId, status: 'OFFERED', offerExpiresAt: { lt: now } },
      select: { id: true, offeredAppointmentId: true, offeredAppointment: { select: { status: true, holdExpiresAt: true } } },
    });
    for (const entry of stale) {
      const appt = entry.offeredAppointment;
      if (appt && appt.status === 'SCHEDULED' && appt.holdExpiresAt) continue; // still a live hold (handled above once expired)
      try {
        const firm = !!appt && !INACTIVE_STATUS_SET.has(appt.status);
        const res = await this.prisma.db.waitlistEntry.updateMany({
          where: { id: entry.id, status: 'OFFERED', offeredAppointmentId: entry.offeredAppointmentId },
          data: firm
            ? { status: 'BOOKED', offerExpiresAt: null }
            : { status: 'WAITING', offeredAppointmentId: null, offerExpiresAt: null, offerCount: { increment: 1 } },
        });
        if (res.count > 0) {
          if (firm) result.settled++;
          else result.released++;
        }
      } catch (err) {
        this.logger.error(`Waitlist entry ${entry.id} could not be released: ${(err as Error).message}`);
      }
    }
    return result;
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private async loadEntry(clinicId: string, id: string): Promise<EntryRow> {
    const entry = await this.prisma.db.waitlistEntry.findFirst({ where: { id, clinicId }, include: entryInclude });
    if (!entry) throw new NotFoundException('Waitlist entry not found');
    return entry;
  }

  private cancelHold(tx: Prisma.TransactionClient, appointmentId: string, note: string): Promise<AppointmentRow | null> {
    return tx.appointment
      .findFirst({ where: { id: appointmentId, status: ACTIVE_STATUS_FILTER }, select: { id: true } })
      .then((row) => (row ? this.writer.cancel(tx, row.id, note) : null));
  }

  private parseBounds(earliest?: string, latest?: string | null) {
    const earliestAt = earliest ? new Date(earliest) : undefined;
    const latestAt = latest ? new Date(latest) : null;
    if (earliestAt && Number.isNaN(earliestAt.getTime())) throw new BadRequestException('earliestAt is not a valid date');
    if (latestAt && Number.isNaN(latestAt.getTime())) throw new BadRequestException('latestAt is not a valid date');
    if (earliestAt && latestAt && latestAt <= earliestAt) throw new BadRequestException('latestAt must be after earliestAt');
    return { earliestAt, latestAt };
  }

  private toCandidate(row: WaitlistEntry): WaitlistCandidate {
    return {
      id: row.id,
      priority: row.priority,
      createdAt: row.createdAt,
      durationMinutes: row.durationMinutes,
      earliestAt: row.earliestAt,
      latestAt: row.latestAt,
      preferredWindows: Array.isArray(row.preferredWindows) ? (row.preferredWindows as unknown as PreferredWindow[]) : [],
    };
  }

  private async matchingDoctors(clinicId: string, entry: WaitlistEntry) {
    const where: Prisma.DoctorWhereInput = entry.doctorId ? { id: entry.doctorId, clinicId, isActive: true } : { clinicId, isActive: true, specialty: entry.specialty ?? undefined };
    return this.prisma.db.doctor.findMany({ where, include: { availability: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] });
  }

  /** Attaches doctor / patient summaries (the entry has no such relations in the schema). */
  private async withParties<T extends { doctorId: string | null; patientId: string }>(clinicId: string, entries: T[]) {
    const doctorIds = [...new Set(entries.map((e) => e.doctorId).filter((id): id is string => !!id))];
    const patientIds = [...new Set(entries.map((e) => e.patientId))];
    const [doctors, patients] = await Promise.all([
      doctorIds.length ? this.prisma.db.doctor.findMany({ where: { clinicId, id: { in: doctorIds } }, select: doctorSummary }) : [],
      patientIds.length ? this.prisma.db.patient.findMany({ where: { clinicId, id: { in: patientIds } }, select: patientSummary }) : [],
    ]);
    const d = new Map(doctors.map((x) => [x.id, x]));
    const p = new Map(patients.map((x) => [x.id, x]));
    return entries.map((e) => ({ ...e, doctor: e.doctorId ? (d.get(e.doctorId) ?? null) : null, patient: p.get(e.patientId) ?? null }));
  }
}
