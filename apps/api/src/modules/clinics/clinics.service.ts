import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { UpdateClinicDto } from './clinics.dto.js';
import { dayBounds, zonedParts } from '../appointments/scheduling.js';

/** Own-schedule scope for doctors: `ownOnly` without a `doctorId` means the user has no doctor profile and sees no appointments. */
export interface StatsScope {
  ownOnly: boolean;
  doctorId?: string;
}

@Injectable()
export class ClinicsService {
  constructor(private readonly prisma: PrismaService) {}

  get(clinicId: string) {
    return this.prisma.db.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: {
        id: true, name: true, slug: true, timezone: true, phone: true, email: true,
        address: true, currency: true, settings: true, isActive: true, createdAt: true,
      },
    });
  }

  update(clinicId: string, dto: UpdateClinicDto) {
    return this.prisma.db.clinic.update({
      where: { id: clinicId },
      data: { ...dto, settings: dto.settings as Prisma.InputJsonValue | undefined },
    });
  }

  /** Headline numbers for the dashboard. */
  async stats(clinicId: string, scope: StatsScope = { ownOnly: false }) {
    const now = new Date();
    const { timezone } = await this.prisma.db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } });
    // "Today" is the clinic's calendar day, not the server's.
    const { startsAt: dayStart, endsAt: dayEnd } = dayBounds(zonedParts(now, timezone).date, timezone);
    const doctorFilter = scope.ownOnly ? { doctorId: scope.doctorId ?? '00000000-0000-0000-0000-000000000000' } : {};

    const [patients, doctors, todayAppointments, upcoming, unpaidInvoices] = await Promise.all([
      this.prisma.db.patient.count({ where: { clinicId, isActive: true } }),
      this.prisma.db.doctor.count({ where: { clinicId, isActive: true } }),
      this.prisma.db.appointment.count({
        where: { clinicId, ...doctorFilter, startsAt: { gte: dayStart, lt: dayEnd }, status: { notIn: ['CANCELLED'] } },
      }),
      this.prisma.db.appointment.count({
        where: { clinicId, ...doctorFilter, startsAt: { gte: now }, status: { in: ['SCHEDULED', 'CONFIRMED'] } },
      }),
      this.prisma.db.invoice.aggregate({
        where: { clinicId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
        _count: true,
        _sum: { total: true, amountPaid: true },
      }),
    ]);
    const outstanding = Number(unpaidInvoices._sum.total ?? 0) - Number(unpaidInvoices._sum.amountPaid ?? 0);
    return { patients, doctors, todayAppointments, upcoming, unpaidInvoices: unpaidInvoices._count, outstanding };
  }
}
