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
import { addMinutes, defaultDurationMinutes, type TimeRange } from '../appointments/scheduling.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ACTIVE_STATUS_FILTER, AppointmentWriterService, appointmentInclude, SYSTEM_ACTOR, type AppointmentRow, type DoctorWithAvailability } from './appointment-writer.service.js';
import { availabilityIntervals, daysBetween, slotStepMinutes, toInterval } from './day-availability.js';
import type { BookWaitlistDto, CreateWaitlistEntryDto, ListWaitlistQuery, UpdateWaitlistEntryDto } from './waitlist.dto.js';

export const HOLD_HOURS = 24;
export const MAX_OFFERS = 3;
export const HOLD_NOTE = 'Waitlist offer';
export const HOLD_EXPIRED_NOTE = 'Hold expired';
const MATCH_DAYS = 14;
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
      const hold = existing.status === 'OFFERED' && existing.offeredAppointmentId ? await this.cancelHold(tx, existing.offeredAppointmentId, 'Waitlist entry cancelled') : null;
      const entry = await tx.waitlistEntry.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', offeredAppointmentId: null, offerExpiresAt: null },
        include: entryInclude,
      });
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
          data: { status: 'BOOKED', offeredAppointmentId: appointment.id, offerExpiresAt: null },
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
    const { appointment, entry } = await this.prisma.transaction(async (tx) => {
      const hold = await tx.appointment.findFirst({ where: { id: existing.offeredAppointmentId as string, clinicId: user.clinicId } });
      if (!hold || hold.status === 'CANCELLED' || hold.status === 'NO_SHOW') throw new ConflictException('The offered slot is no longer held');
      const appointment = await tx.appointment.update({
        where: { id: hold.id },
        data: { holdExpiresAt: null, version: { increment: 1 } },
        include: appointmentInclude,
      });
      const entry = await tx.waitlistEntry.update({ where: { id: existing.id }, data: { status: 'BOOKED', offerExpiresAt: null }, include: entryInclude });
      return { appointment, entry };
    });
    this.writer.emitUpdated(appointment, user.id);
    return { entry: (await this.withParties(user.clinicId, [entry]))[0], appointment: this.writer.toView(appointment) };
  }

  /** The patient declined: the hold is cancelled and the entry waits again (offerCount + 1). */
  async decline(user: AuthUser, id: string) {
    const existing = await this.loadEntry(user.clinicId, id);
    if (existing.status !== 'OFFERED' || !existing.offeredAppointmentId) throw new ConflictException('No offer is pending for this entry');
    const { hold, entry } = await this.prisma.transaction(async (tx) => {
      const hold = await this.cancelHold(tx, existing.offeredAppointmentId as string, 'Waitlist offer declined');
      const entry = await tx.waitlistEntry.update({
        where: { id: existing.id },
        data: { status: 'WAITING', offeredAppointmentId: null, offerExpiresAt: null, offerCount: { increment: 1 } },
        include: entryInclude,
      });
      return { hold, entry };
    });
    if (hold) this.writer.emitCancelled(hold, user.id);
    return (await this.withParties(user.clinicId, [entry]))[0];
  }

  // ─────────────────────────────── backfill ───────────────────────────────

  /**
   * Reacts to `appointment.cancelled`: offers the freed interval to the best
   * waiting entry. Cancelled holds (declined / expired offers) are skipped — the
   * expiry job re-runs backfill itself, and a declined slot is not re-offered.
   */
  async onAppointmentCancelled(e: AppointmentEvent & { holdExpiresAt?: Date | string | null }) {
    try {
      if (e.holdExpiresAt || e.notes === HOLD_NOTE) return;
      const freed = { startsAt: new Date(e.startsAt), endsAt: new Date(e.endsAt) };
      await this.backfill(e.clinicId, e.doctorId, freed, e.actorUserId ?? SYSTEM_ACTOR);
    } catch (err) {
      this.logger.error(`Waitlist backfill failed for appointment ${e.id}: ${(err as Error).message}`, (err as Error).stack);
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
          const current = await tx.waitlistEntry.findFirst({ where: { id: entry.id, status: 'WAITING' }, select: { id: true } });
          if (!current) throw new ConflictException('Entry is no longer waiting');
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
          await tx.waitlistEntry.update({
            where: { id: entry.id },
            data: { status: 'OFFERED', offeredAppointmentId: created.id, offerExpiresAt: expiresAt },
          });
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
   * Cancels held appointments whose hold expired before `now` (per clinic, in a
   * system context), returns their entries to WAITING (offerCount + 1) and
   * re-runs backfill for the freed slot for the next candidate. Never throws.
   */
  async expireHolds(now = new Date()): Promise<{ expired: number; reoffered: number }> {
    const result = { expired: 0, reoffered: 0 };
    let clinicIds: string[] = [];
    try {
      clinicIds = await tenantContext.runSystem(async () => {
        const rows = await this.prisma.db.appointment.findMany({
          where: { holdExpiresAt: { lt: now }, status: ACTIVE_STATUS_FILTER },
          distinct: ['clinicId'],
          select: { clinicId: true },
        });
        return rows.map((r) => r.clinicId);
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
      } catch (err) {
        this.logger.error(`Hold expiry failed for clinic ${clinicId}: ${(err as Error).message}`, (err as Error).stack);
      }
    }
    return result;
  }

  private async expireClinicHolds(clinicId: string, now: Date) {
    const result = { expired: 0, reoffered: 0 };
    const holds = await this.prisma.db.appointment.findMany({
      where: { clinicId, holdExpiresAt: { lt: now }, status: ACTIVE_STATUS_FILTER },
      select: { id: true, doctorId: true, startsAt: true, endsAt: true },
      orderBy: { holdExpiresAt: 'asc' },
    });
    for (const hold of holds) {
      try {
        const { cancelled, entryId } = await this.prisma.transaction(async (tx) => {
          const cancelled = await this.writer.cancel(tx, hold.id, HOLD_EXPIRED_NOTE);
          const entries = await tx.waitlistEntry.findMany({ where: { clinicId, offeredAppointmentId: hold.id, status: 'OFFERED' }, select: { id: true } });
          if (entries.length > 0) {
            await tx.waitlistEntry.updateMany({
              where: { id: { in: entries.map((e) => e.id) } },
              data: { status: 'WAITING', offeredAppointmentId: null, offerExpiresAt: null, offerCount: { increment: 1 } },
            });
          }
          return { cancelled, entryId: entries[0]?.id };
        });
        result.expired++;
        this.writer.emitCancelled(cancelled, SYSTEM_ACTOR);
        const reoffered = await this.backfill(clinicId, hold.doctorId, { startsAt: hold.startsAt, endsAt: hold.endsAt }, SYSTEM_ACTOR, entryId);
        if (reoffered) result.reoffered++;
      } catch (err) {
        this.logger.error(`Hold ${hold.id} could not be expired: ${(err as Error).message}`);
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
