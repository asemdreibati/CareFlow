import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { PaginationQuery, paginate } from '../../common/dto/pagination.dto.js';
import type { CreateDoctorDto, CreateTimeOffDto, SetAvailabilityDto, UpdateDoctorDto } from './doctors.dto.js';

@Injectable()
export class DoctorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(clinicId: string, q: PaginationQuery, includeInactive = false) {
    const where: Prisma.DoctorWhereInput = {
      clinicId,
      ...(includeInactive ? {} : { isActive: true }),
      ...(q.search
        ? { OR: [
            { firstName: { contains: q.search, mode: 'insensitive' } },
            { lastName: { contains: q.search, mode: 'insensitive' } },
            { specialty: { contains: q.search, mode: 'insensitive' } },
          ] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.doctor.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], include: { availability: true } }),
      this.prisma.db.doctor.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async get(clinicId: string, id: string) {
    const doctor = await this.prisma.db.doctor.findFirst({
      where: { id, clinicId },
      include: { availability: { orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] }, timeOff: { where: { endsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' } } },
    });
    if (!doctor) throw new NotFoundException('Doctor not found');
    return doctor;
  }

  async create(clinicId: string, dto: CreateDoctorDto) {
    await this.assertUserIsMember(clinicId, dto.userId);
    return this.prisma.db.doctor.create({ data: { ...dto, clinicId } });
  }

  async update(clinicId: string, id: string, dto: UpdateDoctorDto) {
    await this.get(clinicId, id);
    await this.assertUserIsMember(clinicId, dto.userId);
    return this.prisma.db.doctor.update({ where: { id }, data: dto });
  }

  async deactivate(clinicId: string, id: string) {
    await this.get(clinicId, id);
    return this.prisma.db.doctor.update({ where: { id }, data: { isActive: false } });
  }

  /** Replaces the weekly schedule atomically. Slots on the same weekday must not overlap. */
  async setAvailability(clinicId: string, doctorId: string, dto: SetAvailabilityDto) {
    await this.get(clinicId, doctorId);
    const byDay = new Map<number, { s: string; e: string }[]>();
    for (const slot of dto.slots) {
      if (slot.endTime <= slot.startTime) throw new BadRequestException(`endTime must be after startTime (weekday ${slot.weekday})`);
      const list = byDay.get(slot.weekday) ?? [];
      for (const other of list) {
        if (slot.startTime < other.e && other.s < slot.endTime) {
          throw new BadRequestException(`Overlapping availability on weekday ${slot.weekday}`);
        }
      }
      list.push({ s: slot.startTime, e: slot.endTime });
      byDay.set(slot.weekday, list);
    }
    return this.prisma.transaction(async (tx) => {
      await tx.doctorAvailability.deleteMany({ where: { doctorId, clinicId } });
      await tx.doctorAvailability.createMany({
        data: dto.slots.map((s) => ({ clinicId, doctorId, weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, slotMinutes: s.slotMinutes ?? 30 })),
      });
      return tx.doctorAvailability.findMany({ where: { doctorId }, orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] });
    });
  }

  async addTimeOff(clinicId: string, doctorId: string, dto: CreateTimeOffDto) {
    await this.get(clinicId, doctorId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
    const clash = await this.prisma.db.appointment.count({
      where: { clinicId, doctorId, status: { notIn: ['CANCELLED', 'NO_SHOW', 'COMPLETED'] }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    });
    if (clash > 0) throw new BadRequestException(`Doctor has ${clash} active appointment(s) in this period; reschedule them first`);
    return this.prisma.db.doctorTimeOff.create({ data: { clinicId, doctorId, startsAt, endsAt, reason: dto.reason } });
  }

  async removeTimeOff(clinicId: string, doctorId: string, id: string) {
    const row = await this.prisma.db.doctorTimeOff.findFirst({ where: { id, doctorId, clinicId } });
    if (!row) throw new NotFoundException('Time off entry not found');
    await this.prisma.db.doctorTimeOff.delete({ where: { id } });
  }

  private async assertUserIsMember(clinicId: string, userId?: string) {
    if (!userId) return;
    const m = await this.prisma.db.clinicMembership.findFirst({ where: { clinicId, userId, isActive: true } });
    if (!m) throw new BadRequestException('userId is not an active member of this clinic');
  }
}
