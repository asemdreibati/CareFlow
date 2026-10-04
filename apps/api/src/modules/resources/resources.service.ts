import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { enumerateSlots, intersectMany, subtract, type Interval } from '../../scheduling-engine/intervals.js';
import { dayBounds, isValidDateString, type TimeRange } from '../appointments/scheduling.js';
import type { CreateResourceDto, ResourceAvailabilityQuery, ResourceBookingsQuery, UpdateResourceDto } from './resources.dto.js';

/** Fields of a resource exposed on appointment responses and events. */
export const resourceSummarySelect = { id: true, name: true, type: true, color: true } as const;
export type ResourceSummary = Prisma.ResourceGetPayload<{ select: typeof resourceSummarySelect }>;

const bookingInclude = {
  appointment: {
    select: {
      id: true,
      status: true,
      type: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      doctor: { select: { id: true, firstName: true, lastName: true, title: true, color: true } },
      patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
    },
  },
} as const;

const DEFAULT_RESOURCE_SLOT_MINUTES = 30;
const MAX_BOOKINGS_RANGE_DAYS = 62;

const toInterval = (r: TimeRange): Interval => ({ start: r.startsAt.getTime(), end: r.endsAt.getTime() });
const toRange = (i: Interval) => ({ startsAt: new Date(i.start).toISOString(), endsAt: new Date(i.end).toISOString() });

/**
 * Rooms / equipment catalogue plus the shared booking helpers used by the
 * appointments module (validation and free-interval computation inside the
 * booking transaction).
 */
@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────── catalogue ───────────────────────────────

  list(clinicId: string, includeInactive = false) {
    return this.prisma.db.resource.findMany({
      where: { clinicId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  async get(clinicId: string, id: string) {
    const resource = await this.prisma.db.resource.findFirst({ where: { id, clinicId } });
    if (!resource) throw new NotFoundException('Resource not found');
    return resource;
  }

  create(clinicId: string, dto: CreateResourceDto) {
    return this.prisma.db.resource.create({ data: { clinicId, name: dto.name.trim(), type: dto.type, color: dto.color, notes: dto.notes } });
  }

  async update(clinicId: string, id: string, dto: UpdateResourceDto) {
    await this.get(clinicId, id);
    return this.prisma.db.resource.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), type: dto.type, color: dto.color, notes: dto.notes, isActive: dto.isActive },
    });
  }

  // ─────────────────────────────── calendars ───────────────────────────────

  /** Bookings of one resource in a range, with a summary of the appointment behind each. */
  async bookings(clinicId: string, id: string, q: ResourceBookingsQuery) {
    const resource = await this.get(clinicId, id);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to.getTime() - from.getTime() > MAX_BOOKINGS_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`Range cannot exceed ${MAX_BOOKINGS_RANGE_DAYS} days`);
    }
    const bookings = await this.prisma.db.resourceBooking.findMany({
      where: { clinicId, resourceId: id, startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: { startsAt: 'asc' },
      include: bookingInclude,
    });
    return { resource, from: from.toISOString(), to: to.toISOString(), bookings };
  }

  /** Free time common to ALL listed resources on one clinic day (`intersectMany`). */
  async availability(clinicId: string, q: ResourceAvailabilityQuery) {
    if (!isValidDateString(q.date)) throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    const resourceIds = [...new Set(q.resourceIds)];
    const durationMinutes = q.durationMinutes ?? DEFAULT_RESOURCE_SLOT_MINUTES;
    const timeZone = await this.clinicTimezone(clinicId);
    const day = toInterval(dayBounds(q.date, timeZone));

    const { resources, free } = await this.prisma.transaction((tx) => this.freeIntervals(tx, clinicId, resourceIds, day));
    const common = intersectMany(resourceIds.map((id) => free.get(id) ?? []));
    const durationMs = durationMinutes * 60_000;
    return {
      date: q.date,
      timezone: timeZone,
      durationMinutes,
      resources: resources.map((r) => ({ id: r.id, name: r.name, type: r.type, color: r.color })),
      free: common.map(toRange),
      slots: enumerateSlots(common, durationMs, durationMs).map(toRange),
    };
  }

  // ─────────────────────────── booking helpers (shared) ───────────────────────────

  /**
   * Loads the resources, checking each exists and is active (404 / 400).
   * Returns them in the order requested.
   */
  async loadActive(tx: Prisma.TransactionClient, clinicId: string, resourceIds: readonly string[]): Promise<ResourceSummary[]> {
    const ids = [...new Set(resourceIds)];
    if (ids.length === 0) return [];
    const rows = await tx.resource.findMany({ where: { clinicId, id: { in: ids } }, select: { ...resourceSummarySelect, isActive: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => {
      const r = byId.get(id);
      if (!r) throw new NotFoundException(`Resource ${id} not found`);
      if (!r.isActive) throw new BadRequestException(`Resource "${r.name}" is not active`);
      const { isActive: _isActive, ...summary } = r;
      return summary;
    });
  }

  /**
   * Free intervals of each resource inside `window` (window minus active bookings),
   * optionally ignoring the bookings of one appointment (the one being rescheduled).
   */
  async freeIntervals(
    tx: Prisma.TransactionClient,
    clinicId: string,
    resourceIds: readonly string[],
    window: Interval,
    excludeAppointmentId?: string,
  ): Promise<{ resources: ResourceSummary[]; free: Map<string, Interval[]> }> {
    const resources = await this.loadActive(tx, clinicId, resourceIds);
    const busyRows = await tx.resourceBooking.findMany({
      where: {
        clinicId,
        resourceId: { in: resources.map((r) => r.id) },
        active: true,
        startsAt: { lt: new Date(window.end) },
        endsAt: { gt: new Date(window.start) },
        ...(excludeAppointmentId ? { appointmentId: { not: excludeAppointmentId } } : {}),
      },
      select: { resourceId: true, startsAt: true, endsAt: true },
    });
    const busyByResource = new Map<string, Interval[]>();
    for (const b of busyRows) {
      const list = busyByResource.get(b.resourceId) ?? [];
      list.push(toInterval(b));
      busyByResource.set(b.resourceId, list);
    }
    const free = new Map<string, Interval[]>();
    for (const r of resources) free.set(r.id, subtract([window], busyByResource.get(r.id) ?? []));
    return { resources, free };
  }

  /**
   * Friendly pre-check for a booking: every resource must be fully free over `range`.
   * The `resource_bookings_no_overlap` exclusion constraint remains the final arbiter.
   */
  async assertAvailable(
    tx: Prisma.TransactionClient,
    clinicId: string,
    resourceIds: readonly string[],
    range: TimeRange,
    excludeAppointmentId?: string,
  ): Promise<ResourceSummary[]> {
    if (resourceIds.length === 0) return [];
    const window = toInterval(range);
    const { resources, free } = await this.freeIntervals(tx, clinicId, resourceIds, window, excludeAppointmentId);
    for (const r of resources) {
      const gaps = free.get(r.id) ?? [];
      const covered = gaps.some((g) => g.start <= window.start && window.end <= g.end);
      if (!covered) throw new ConflictException(`Resource "${r.name}" is not available`);
    }
    return resources;
  }

  private async clinicTimezone(clinicId: string): Promise<string> {
    const clinic = await this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
    return clinic?.timezone || 'UTC';
  }
}
