import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { UpdateClinicDto } from './clinics.dto.js';

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
  async stats(clinicId: string, doctorId?: string) {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const doctorFilter = doctorId ? { doctorId } : {};

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
