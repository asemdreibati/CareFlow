import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Interval } from '../../scheduling-engine/intervals.js';
import { searchSlots, type AvailabilityWindow, type DoctorCandidate, type PreferredWindow, type SlotCandidate } from '../../scheduling-engine/slot-search.js';
import { ResourcesService } from '../resources/resources.service.js';
import type { PreferredWindowInput, SearchSlotsQuery } from './appointments.dto.js';
import { scopedDoctorIdFor } from './appointments.service.js';
import { dayBounds, hhmmToMinutes, INACTIVE_STATUSES, weekdayOfDate, zonedParts, zonedTimeToUtc, type AvailabilityBlock } from './scheduling.js';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 14;
const MAX_RANGE_DAYS = 60;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const doctorSelect = { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } as const;

/** Normalised search parameters (what `SearchSlotsQuery` resolves to). */
export interface SlotSearchParams {
  durationMinutes: number;
  from: Date;
  to: Date;
  doctorId?: string;
  specialty?: string;
  preferredDoctorId?: string;
  preferredWindows: PreferredWindow[];
  resourceIds: string[];
  limit: number;
  patientId?: string;
}

export interface SlotSearchResult {
  query: Omit<SlotSearchParams, 'from' | 'to'> & { from: string; to: string; timezone: string };
  candidates: {
    doctor: { id: string; firstName: string; lastName: string; title: string | null; specialty: string; color: string };
    startsAt: string;
    endsAt: string;
    score: number;
    reasons: string[];
    breakdown: SlotCandidate['breakdown'];
  }[];
}

/** Every calendar day key from `fromDate` to `toDate` inclusive ("YYYY-MM-DD"). */
function listDates(fromDate: string, toDate: string): string[] {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const out: string[] = [];
  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += DAY_MS) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

/** Validates the JSON `preferredWindows` query parameter. */
export function parsePreferredWindows(raw: readonly PreferredWindowInput[] | undefined): PreferredWindow[] {
  if (!raw) return [];
  return raw.map((w, i) => {
    const ok =
      w !== null &&
      typeof w === 'object' &&
      Number.isInteger(w.weekday) &&
      w.weekday >= 0 &&
      w.weekday <= 6 &&
      typeof w.startTime === 'string' &&
      typeof w.endTime === 'string' &&
      HH_MM.test(w.startTime) &&
      HH_MM.test(w.endTime) &&
      hhmmToMinutes(w.startTime) < hhmmToMinutes(w.endTime);
    if (!ok) throw new BadRequestException(`preferredWindows[${i}] must be { weekday: 0-6, startTime: "HH:mm", endTime: "HH:mm" } with startTime < endTime`);
    return { weekday: w.weekday, startTime: w.startTime, endTime: w.endTime };
  });
}

/**
 * Smart slot search (docs/SCHEDULING.md §1): loads doctors, their availability,
 * busy time and resource calendars for the range, expands availability into
 * concrete windows in the clinic timezone and delegates ranking to the pure engine.
 * `searchForClinic` is reusable by other modules (e.g. waitlist matches).
 */
@Injectable()
export class SlotSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resources: ResourcesService,
  ) {}

  async search(user: AuthUser, q: SearchSlotsQuery): Promise<SlotSearchResult> {
    // A restricted DOCTOR only ever searches their own calendar.
    const doctorId = scopedDoctorIdFor(user, q.doctorId);
    const from = q.from ? new Date(q.from) : new Date();
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + DEFAULT_RANGE_DAYS * DAY_MS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Invalid date');
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) throw new BadRequestException(`Search range cannot exceed ${MAX_RANGE_DAYS} days`);

    return this.searchForClinic(user.clinicId, {
      durationMinutes: q.durationMinutes,
      from,
      to,
      doctorId,
      specialty: doctorId ? undefined : q.specialty?.trim() || undefined,
      preferredDoctorId: q.preferredDoctorId,
      preferredWindows: parsePreferredWindows(q.preferredWindows),
      resourceIds: [...new Set(q.resourceIds ?? [])],
      limit: q.limit,
      patientId: q.patientId,
    });
  }

  async searchForClinic(clinicId: string, p: SlotSearchParams): Promise<SlotSearchResult> {
    const timeZone = await this.clinicTimezone(clinicId);
    const doctors = await this.prisma.db.doctor.findMany({
      where: {
        clinicId,
        isActive: true,
        ...(p.doctorId ? { id: p.doctorId } : {}),
        ...(p.specialty ? { specialty: { equals: p.specialty, mode: 'insensitive' } } : {}),
      },
      select: { ...doctorSelect, availability: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
    if (p.doctorId && doctors.length === 0) throw new NotFoundException('Doctor not found');

    // Whole clinic days covering the range, so day-level load is counted completely.
    const dates = listDates(zonedParts(p.from, timeZone).date, zonedParts(new Date(p.to.getTime() - 1), timeZone).date);
    const fetchFrom = dayBounds(dates[0], timeZone).startsAt;
    const fetchTo = dayBounds(dates[dates.length - 1], timeZone).endsAt;
    const doctorIds = doctors.map((d) => d.id);
    const activeFilter = { notIn: [...INACTIVE_STATUSES] };

    const [appointments, timeOff, patientAppointments, resourceFree] = await Promise.all([
      this.prisma.db.appointment.findMany({
        where: { clinicId, doctorId: { in: doctorIds }, status: activeFilter, startsAt: { lt: fetchTo }, endsAt: { gt: fetchFrom } },
        select: { doctorId: true, startsAt: true, endsAt: true },
      }),
      this.prisma.db.doctorTimeOff.findMany({
        where: { clinicId, doctorId: { in: doctorIds }, startsAt: { lt: fetchTo }, endsAt: { gt: fetchFrom } },
        select: { doctorId: true, startsAt: true, endsAt: true },
      }),
      p.patientId
        ? this.prisma.db.appointment.findMany({
            where: { clinicId, patientId: p.patientId, status: activeFilter, startsAt: { lt: fetchTo }, endsAt: { gt: fetchFrom } },
            select: { startsAt: true, endsAt: true },
          })
        : Promise.resolve([]),
      p.resourceIds.length > 0
        ? this.prisma.transaction(async (tx) => {
            const { free } = await this.resources.freeIntervals(tx, clinicId, p.resourceIds, { start: p.from.getTime(), end: p.to.getTime() });
            return p.resourceIds.map((id) => free.get(id) ?? []);
          })
        : Promise.resolve(undefined),
    ]);

    const patientBusy: Interval[] = patientAppointments.map((a) => ({ start: a.startsAt.getTime(), end: a.endsAt.getTime() }));
    const candidates: DoctorCandidate[] = doctors.map((doctor) => {
      const own = appointments.filter((a) => a.doctorId === doctor.id);
      const bookedMinutesByDay: Record<string, number> = {};
      for (const a of own) {
        const key = zonedParts(a.startsAt, timeZone).date;
        bookedMinutesByDay[key] = (bookedMinutesByDay[key] ?? 0) + (a.endsAt.getTime() - a.startsAt.getTime()) / 60_000;
      }
      const busy: Interval[] = [
        ...own.map((a) => ({ start: a.startsAt.getTime(), end: a.endsAt.getTime() })),
        ...timeOff.filter((t) => t.doctorId === doctor.id).map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() })),
        ...patientBusy,
      ];
      return {
        id: doctor.id,
        blocks: expandAvailability(doctor.availability, dates, timeZone),
        slotMinutesByWeekday: slotGrid(doctor.availability),
        busy,
        bookedMinutesByDay,
      };
    });

    const ranked = searchSlots({
      from: p.from.getTime(),
      to: p.to.getTime(),
      durationMinutes: p.durationMinutes,
      doctors: candidates,
      preferredDoctorId: p.preferredDoctorId,
      preferredWindows: p.preferredWindows,
      resourceFree,
      limit: p.limit,
    });

    const doctorById = new Map(doctors.map((d) => [d.id, d]));
    return {
      query: { ...p, from: p.from.toISOString(), to: p.to.toISOString(), timezone: timeZone },
      candidates: ranked.map((c) => {
        const d = doctorById.get(c.doctorId)!;
        return {
          doctor: { id: d.id, firstName: d.firstName, lastName: d.lastName, title: d.title, specialty: d.specialty, color: d.color },
          startsAt: new Date(c.start).toISOString(),
          endsAt: new Date(c.end).toISOString(),
          score: c.score,
          reasons: c.reasons,
          breakdown: c.breakdown,
        };
      }),
    };
  }

  private async clinicTimezone(clinicId: string): Promise<string> {
    const clinic = await this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    return clinic?.timezone || 'UTC';
  }
}

/** Weekly blocks → concrete windows (epoch ms) for each date, in the clinic timezone (DST-safe via `zonedTimeToUtc`). */
export function expandAvailability(blocks: readonly AvailabilityBlock[], dates: readonly string[], timeZone: string): AvailabilityWindow[] {
  const out: AvailabilityWindow[] = [];
  for (const date of dates) {
    const weekday = weekdayOfDate(date);
    for (const b of blocks) {
      if (b.weekday !== weekday) continue;
      const start = zonedTimeToUtc(date, b.startTime, timeZone).getTime();
      // "24:00" (or later) means the end of the clinic day.
      const end = hhmmToMinutes(b.endTime) >= 1440 ? dayBounds(date, timeZone).endsAt.getTime() : zonedTimeToUtc(date, b.endTime, timeZone).getTime();
      if (end <= start) continue;
      out.push({ start, end, date, weekday, wallStartMinutes: hhmmToMinutes(b.startTime) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Slot grid per weekday: the smallest slot length configured for that weekday. */
export function slotGrid(blocks: readonly AvailabilityBlock[]): Partial<Record<number, number>> {
  const grid: Partial<Record<number, number>> = {};
  for (const b of blocks) {
    if (!b.slotMinutes || b.slotMinutes <= 0) continue;
    const cur = grid[b.weekday];
    grid[b.weekday] = cur === undefined ? b.slotMinutes : Math.min(cur, b.slotMinutes);
  }
  return grid;
}
