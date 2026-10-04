import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Encounter, PrescriptionStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PaginationQuery, paginate } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { CreateDiagnosisDto, CreateEncounterDto, CreatePrescriptionDto, UpdateEncounterDto } from './records.dto.js';

const doctorSummary = { select: { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } } as const;
const patientSummary = { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true } } as const;

const encounterDetail = {
  doctor: doctorSummary,
  patient: patientSummary,
  appointment: { select: { id: true, startsAt: true, endsAt: true, status: true, type: true } },
  diagnoses: { orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] },
  prescriptions: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.EncounterInclude;

@Injectable()
export class RecordsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── encounters ─────────────────────────────

  async listForPatient(user: AuthUser, patientId: string, q: PaginationQuery) {
    await this.assertPatient(user.clinicId, patientId);
    const where: Prisma.EncounterWhereInput = {
      clinicId: user.clinicId,
      patientId,
      ...(this.ownDoctorOnly(user) ? { doctorId: user.doctorId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.encounter.findMany({
        where,
        skip: q.skip,
        take: q.pageSize,
        orderBy: { occurredAt: 'desc' },
        include: { doctor: doctorSummary, diagnoses: { orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] } },
      }),
      this.prisma.db.encounter.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  /** Full encounter. Opening it is recorded in the append-only record access log. */
  async get(user: AuthUser, id: string) {
    const encounter = await this.prisma.db.encounter.findFirst({ where: { id, clinicId: user.clinicId }, include: encounterDetail });
    if (!encounter) throw new NotFoundException('Encounter not found');
    this.assertAccess(user, encounter);
    await this.prisma.db.recordAccessLog.create({
      data: { clinicId: user.clinicId, patientId: encounter.patientId, userId: user.id, encounterId: encounter.id, action: 'VIEW_ENCOUNTER' },
    });
    return encounter;
  }

  async create(user: AuthUser, patientId: string, dto: CreateEncounterDto) {
    await this.assertPatient(user.clinicId, patientId);
    const { appointmentId, doctorId: requestedDoctorId, occurredAt, vitals, ...fields } = dto;

    // Authorship: a doctor documents their own visits; other clinical staff must name the doctor.
    const doctorId = user.doctorId ?? requestedDoctorId;
    if (!doctorId) throw new BadRequestException('doctorId is required when the caller is not a doctor');
    if (user.doctorId && requestedDoctorId && requestedDoctorId !== user.doctorId && this.ownDoctorOnly(user)) {
      throw new ForbiddenException('Doctors can only author their own encounters');
    }
    const doctor = await this.prisma.db.doctor.findFirst({ where: { id: doctorId, clinicId: user.clinicId, isActive: true }, select: { id: true } });
    if (!doctor) throw new BadRequestException('doctorId is not an active doctor of this clinic');

    if (appointmentId) {
      const appointment = await this.prisma.db.appointment.findFirst({
        where: { id: appointmentId, clinicId: user.clinicId },
        select: { id: true, patientId: true, encounter: { select: { id: true } } },
      });
      if (!appointment) throw new NotFoundException('Appointment not found');
      if (appointment.patientId !== patientId) throw new BadRequestException('Appointment belongs to a different patient');
      if (appointment.encounter) throw new ConflictException('This appointment already has an encounter');
    }

    return this.prisma.db.encounter.create({
      data: {
        ...fields,
        clinicId: user.clinicId,
        patientId,
        doctorId,
        appointmentId,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
        vitals: vitals as Prisma.InputJsonValue | undefined,
      },
      include: encounterDetail,
    });
  }

  async update(user: AuthUser, id: string, dto: UpdateEncounterDto) {
    const encounter = await this.loadForWrite(user, id);
    const { occurredAt, vitals, ...fields } = dto;
    return this.prisma.db.encounter.update({
      where: { id },
      data: {
        ...fields,
        occurredAt: occurredAt ? new Date(occurredAt) : undefined,
        vitals: vitals as Prisma.InputJsonValue | undefined,
        ...(encounter.status === 'SIGNED' ? { status: 'AMENDED' } : {}),
      },
      include: encounterDetail,
    });
  }

  /** Only the authoring doctor signs. Signing closes the linked appointment when it is still open. */
  async sign(user: AuthUser, id: string) {
    const encounter = await this.find(user, id);
    if (!user.doctorId || user.doctorId !== encounter.doctorId) {
      throw new ForbiddenException('Only the authoring doctor can sign this encounter');
    }
    if (encounter.status === 'SIGNED') throw new ConflictException('Encounter is already signed');

    return this.prisma.transaction(async (tx) => {
      if (encounter.appointmentId) {
        await tx.appointment.updateMany({
          where: { id: encounter.appointmentId, clinicId: user.clinicId, status: { in: ['CHECKED_IN', 'IN_PROGRESS'] } },
          data: { status: 'COMPLETED' },
        });
      }
      return tx.encounter.update({ where: { id }, data: { status: 'SIGNED', signedAt: new Date() }, include: encounterDetail });
    });
  }

  // ───────────────────────────── diagnoses ─────────────────────────────

  async addDiagnosis(user: AuthUser, encounterId: string, dto: CreateDiagnosisDto) {
    const encounter = await this.loadForWrite(user, encounterId);
    return this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      if (dto.isPrimary) await tx.diagnosis.updateMany({ where: { encounterId, clinicId: user.clinicId, isPrimary: true }, data: { isPrimary: false } });
      return tx.diagnosis.create({ data: { ...dto, clinicId: user.clinicId, encounterId } });
    });
  }

  async removeDiagnosis(user: AuthUser, encounterId: string, dxId: string) {
    const encounter = await this.loadForWrite(user, encounterId);
    const row = await this.prisma.db.diagnosis.findFirst({ where: { id: dxId, encounterId, clinicId: user.clinicId }, select: { id: true } });
    if (!row) throw new NotFoundException('Diagnosis not found');
    await this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      await tx.diagnosis.delete({ where: { id: dxId } });
    });
  }

  // ─────────────────────────── prescriptions ───────────────────────────

  async addPrescription(user: AuthUser, encounterId: string, dto: CreatePrescriptionDto) {
    const encounter = await this.loadForWrite(user, encounterId);
    return this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      return tx.prescription.create({
        data: { ...dto, clinicId: user.clinicId, encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId },
      });
    });
  }

  async updatePrescriptionStatus(user: AuthUser, id: string, status: PrescriptionStatus) {
    const rx = await this.prisma.db.prescription.findFirst({ where: { id, clinicId: user.clinicId } });
    if (!rx) throw new NotFoundException('Prescription not found');
    if (this.ownDoctorOnly(user) && rx.doctorId !== user.doctorId) {
      throw new ForbiddenException('You can only manage prescriptions you issued');
    }
    return this.prisma.db.prescription.update({ where: { id }, data: { status } });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /** Doctors see only their own encounters unless they hold appointments:read_all. */
  private ownDoctorOnly(user: AuthUser): boolean {
    return user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
  }

  private assertAccess(user: AuthUser, encounter: Pick<Encounter, 'doctorId'>) {
    if (this.ownDoctorOnly(user) && encounter.doctorId !== user.doctorId) {
      throw new ForbiddenException('You can only access your own encounters');
    }
  }

  private async find(user: AuthUser, id: string): Promise<Encounter> {
    const encounter = await this.prisma.db.encounter.findFirst({ where: { id, clinicId: user.clinicId } });
    if (!encounter) throw new NotFoundException('Encounter not found');
    this.assertAccess(user, encounter);
    return encounter;
  }

  /**
   * Loads an encounter the caller may modify. Drafts are freely editable; a signed
   * (or amended) record may only be touched by someone who can sign, and the
   * change is then recorded as an amendment.
   */
  private async loadForWrite(user: AuthUser, id: string): Promise<Encounter> {
    const encounter = await this.find(user, id);
    if (encounter.status !== 'DRAFT' && !user.permissions.has(Permission.RecordsSign)) {
      throw new ConflictException(`Encounter is ${encounter.status.toLowerCase()} and can no longer be edited`);
    }
    return encounter;
  }

  private async markAmended(tx: Prisma.TransactionClient, encounter: Encounter) {
    if (encounter.status === 'SIGNED') {
      await tx.encounter.update({ where: { id: encounter.id }, data: { status: 'AMENDED' } });
    }
  }

  private async assertPatient(clinicId: string, patientId: string) {
    const exists = await this.prisma.db.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Patient not found');
  }
}
