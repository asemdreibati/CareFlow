import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Encounter, EncounterStatus, PrescriptionStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PaginationQuery, paginate } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { CreateDiagnosisDto, CreateEncounterDto, CreatePrescriptionDto, UpdateEncounterDto } from './records.dto.js';

const doctorSummary = { select: { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } } as const;
const patientSummary = { select: { id: true, mrn: true, firstName: true, lastName: true, dateOfBirth: true, gender: true } } as const;

/**
 * List rows are summaries: no SOAP text or vitals (the full note is only returned
 * by GET /encounters/:id, which writes the record access log).
 */
const encounterSummarySelect = {
  id: true,
  patientId: true,
  doctorId: true,
  appointmentId: true,
  occurredAt: true,
  status: true,
  chiefComplaint: true,
  signedAt: true,
  doctor: doctorSummary,
  diagnoses: { select: { id: true, code: true, description: true, isPrimary: true }, orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] },
} satisfies Prisma.EncounterSelect;

const encounterDetail = {
  doctor: doctorSummary,
  patient: patientSummary,
  appointment: { select: { id: true, startsAt: true, endsAt: true, status: true, type: true } },
  diagnoses: { orderBy: [{ isPrimary: 'desc' }, { code: 'asc' }] },
  prescriptions: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.EncounterInclude;

export const ENCOUNTER_EVENTS = {
  signed: 'encounter.signed',
  amended: 'encounter.amended',
} as const;

/** Payload of `encounter.signed` / `encounter.amended`. */
export interface EncounterEvent {
  id: string;
  clinicId: string;
  patientId: string;
  doctorId: string;
  status: string;
  actorUserId: string;
}

/** Status after an edit: a signed note becomes AMENDED, anything else keeps its status. */
function nextStatus(status: EncounterStatus): EncounterStatus {
  return status === 'SIGNED' ? 'AMENDED' : status;
}

@Injectable()
export class RecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ───────────────────────────── encounters ─────────────────────────────

  async listForPatient(user: AuthUser, patientId: string, q: PaginationQuery) {
    await this.assertPatient(user.clinicId, patientId);
    // An own-only user without a doctor profile sees nothing (`doctorId: undefined` would match every row).
    if (this.ownDoctorOnly(user) && !user.doctorId) return paginate([], 0, q);
    const where: Prisma.EncounterWhereInput = {
      clinicId: user.clinicId,
      patientId,
      ...(this.ownDoctorOnly(user) ? { doctorId: user.doctorId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.encounter.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: { occurredAt: 'desc' }, select: encounterSummarySelect }),
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
    if (this.ownDoctorOnly(user) && !user.doctorId) throw new ForbiddenException('Your account is not linked to a doctor profile');
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
        select: { id: true, patientId: true, doctorId: true, encounter: { select: { id: true } } },
      });
      if (!appointment) throw new NotFoundException('Appointment not found');
      if (appointment.patientId !== patientId) throw new BadRequestException('Appointment belongs to a different patient');
      if (appointment.doctorId !== doctorId) throw new BadRequestException('Appointment belongs to a different doctor');
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
    const updated = await this.prisma.transaction(async (tx) => {
      // Compare-and-set on the status read above: a concurrent sign/amend turns this into a 409, never a silent edit.
      const res = await tx.encounter.updateMany({
        where: { id, clinicId: user.clinicId, status: encounter.status },
        data: {
          ...fields,
          occurredAt: occurredAt ? new Date(occurredAt) : undefined,
          vitals: vitals as Prisma.InputJsonValue | undefined,
          status: nextStatus(encounter.status),
        },
      });
      if (res.count !== 1) throw this.changedConcurrently();
      return tx.encounter.findUniqueOrThrow({ where: { id }, include: encounterDetail });
    });
    if (encounter.status !== 'DRAFT') this.emitEncounterEvent(ENCOUNTER_EVENTS.amended, updated, user);
    return updated;
  }

  /** Only the authoring doctor signs. Signing closes the linked appointment when it is still open. */
  async sign(user: AuthUser, id: string) {
    const encounter = await this.find(user, id);
    if (!user.doctorId || user.doctorId !== encounter.doctorId) {
      throw new ForbiddenException('Only the authoring doctor can sign this encounter');
    }
    if (encounter.status === 'SIGNED') throw new ConflictException('Encounter is already signed');

    const signed = await this.prisma.transaction(async (tx) => {
      // Status is part of the write: whichever of two concurrent signs (or a sign and an edit) commits second gets 409.
      const res = await tx.encounter.updateMany({
        where: { id, clinicId: user.clinicId, status: encounter.status },
        data: { status: 'SIGNED', signedAt: new Date() },
      });
      if (res.count !== 1) throw new ConflictException('Encounter is already signed');
      if (encounter.appointmentId) {
        await tx.appointment.updateMany({
          where: { id: encounter.appointmentId, clinicId: user.clinicId, status: { in: ['CHECKED_IN', 'IN_PROGRESS'] } },
          data: { status: 'COMPLETED' },
        });
      }
      return tx.encounter.findUniqueOrThrow({ where: { id }, include: encounterDetail });
    });
    this.emitEncounterEvent(ENCOUNTER_EVENTS.signed, signed, user);
    return signed;
  }

  /** Fire-and-forget domain event consumed by search indexing (embeddings) and future listeners. */
  private emitEncounterEvent(event: string, encounter: { id: string; clinicId: string; patientId: string; doctorId: string; status: string }, actor: AuthUser) {
    const payload: EncounterEvent = {
      id: encounter.id,
      clinicId: encounter.clinicId,
      patientId: encounter.patientId,
      doctorId: encounter.doctorId,
      status: encounter.status,
      actorUserId: actor.id,
    };
    this.events.emit(event, payload);
  }

  // ───────────────────────────── diagnoses ─────────────────────────────

  async addDiagnosis(user: AuthUser, encounterId: string, dto: CreateDiagnosisDto) {
    const encounter = await this.loadForWrite(user, encounterId);
    const created = await this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      if (dto.isPrimary) await tx.diagnosis.updateMany({ where: { encounterId, clinicId: user.clinicId, isPrimary: true }, data: { isPrimary: false } });
      return tx.diagnosis.create({ data: { ...dto, clinicId: user.clinicId, encounterId } });
    });
    this.emitIfAmended(encounter, user);
    return created;
  }

  async removeDiagnosis(user: AuthUser, encounterId: string, dxId: string) {
    const encounter = await this.loadForWrite(user, encounterId);
    const row = await this.prisma.db.diagnosis.findFirst({ where: { id: dxId, encounterId, clinicId: user.clinicId }, select: { id: true } });
    if (!row) throw new NotFoundException('Diagnosis not found');
    await this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      await tx.diagnosis.deleteMany({ where: { id: dxId, encounterId, clinicId: user.clinicId } });
    });
    this.emitIfAmended(encounter, user);
  }

  // ─────────────────────────── prescriptions ───────────────────────────

  async addPrescription(user: AuthUser, encounterId: string, dto: CreatePrescriptionDto) {
    const encounter = await this.loadForWrite(user, encounterId);
    const created = await this.prisma.transaction(async (tx) => {
      await this.markAmended(tx, encounter);
      return tx.prescription.create({
        // Credited to the prescriber who issues it (a nurse documenting for a doctor falls back to the author).
        data: { ...dto, clinicId: user.clinicId, encounterId, patientId: encounter.patientId, doctorId: user.doctorId ?? encounter.doctorId },
      });
    });
    this.emitIfAmended(encounter, user);
    return created;
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
   * (or amended) record may only be amended by its authoring doctor (who must
   * hold records:sign), and the change is then recorded as an amendment. The
   * status read here is re-checked by every write (compare-and-set).
   */
  private async loadForWrite(user: AuthUser, id: string): Promise<Encounter> {
    const encounter = await this.find(user, id);
    if (encounter.status !== 'DRAFT') {
      if (!user.permissions.has(Permission.RecordsSign)) {
        throw new ConflictException(`Encounter is ${encounter.status.toLowerCase()} and can no longer be edited`);
      }
      if (!user.doctorId || user.doctorId !== encounter.doctorId) {
        throw new ForbiddenException('Only the authoring doctor can amend a signed encounter');
      }
    }
    return encounter;
  }

  /**
   * Status guard for child-row writes (diagnoses, prescriptions): moves SIGNED to
   * AMENDED, and in every case fails with 409 when the encounter's status is no
   * longer the one {@link loadForWrite} saw. The row lock it takes also holds a
   * concurrent sign until this transaction commits.
   */
  private async markAmended(tx: Prisma.TransactionClient, encounter: Encounter) {
    const res = await tx.encounter.updateMany({
      where: { id: encounter.id, clinicId: encounter.clinicId, status: encounter.status },
      data: { status: nextStatus(encounter.status) },
    });
    if (res.count !== 1) throw this.changedConcurrently();
  }

  private emitIfAmended(encounter: Encounter, user: AuthUser) {
    if (encounter.status !== 'DRAFT') this.emitEncounterEvent(ENCOUNTER_EVENTS.amended, { ...encounter, status: nextStatus(encounter.status) }, user);
  }

  private changedConcurrently() {
    return new ConflictException('Encounter was changed (e.g. signed) by someone else; reload and try again');
  }

  private async assertPatient(clinicId: string, patientId: string) {
    const exists = await this.prisma.db.patient.findFirst({ where: { id: patientId, clinicId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Patient not found');
  }
}
