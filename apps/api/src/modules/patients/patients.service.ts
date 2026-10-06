import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Patient } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service.js';
import { PaginationQuery, paginate, type Paginated } from '../../common/dto/pagination.dto.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { patientMatch, patientScore } from '../search/search.sql.js';
import type { CreateAllergyDto, CreatePatientDto, UpdatePatientDto } from './patients.dto.js';

export type PatientView = Omit<Patient, 'nationalIdEnc'> & { nationalId: string | null; nationalIdMasked: string | null };

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldEncryptionService,
  ) {}

  async list(user: AuthUser, q: PaginationQuery, includeInactive = false): Promise<Paginated<PatientView>> {
    const search = q.search?.trim();
    if (search) return this.searchList(user, search, q, includeInactive);
    const where: Prisma.PatientWhereInput = {
      clinicId: user.clinicId,
      ...(includeInactive ? {} : { isActive: true }),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.patient.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
      this.prisma.db.patient.count({ where }),
    ]);
    // List views never expose the identifier, even masked.
    return paginate(items.map((p) => this.toView(p, false)), total, q);
  }

  /**
   * Trigram search over `patients.search_text` (normalised name, MRN, phone,
   * email): substring match OR `word_similarity` >= 0.45, so "محمد" finds
   * "مُحَمَّد", "mohamed" finds "Mohammed" and "0501" finds a phone number.
   * The query is normalised in SQL with `careflow_normalize()`; rows are then
   * loaded by id in the ranked order so the response shape is unchanged.
   */
  private async searchList(user: AuthUser, search: string, q: PaginationQuery, includeInactive: boolean): Promise<Paginated<PatientView>> {
    const activeOnly = includeInactive ? Prisma.empty : Prisma.sql`AND p.is_active`;
    const { ids, total } = await this.prisma.transaction(async (tx) => {
      const page = await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id
        FROM patients p
        WHERE p.clinic_id = ${user.clinicId}::uuid
          ${activeOnly}
          AND ${patientMatch(search)}
        ORDER BY ${patientScore(search)} DESC, p.last_name ASC, p.first_name ASC
        LIMIT ${q.pageSize} OFFSET ${q.skip}`;
      const count = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total
        FROM patients p
        WHERE p.clinic_id = ${user.clinicId}::uuid
          ${activeOnly}
          AND ${patientMatch(search)}`;
      return { ids: page.map((r) => r.id), total: Number(count[0]?.total ?? 0) };
    });
    if (ids.length === 0) return paginate([], total, q);
    const rows = await this.prisma.db.patient.findMany({ where: { id: { in: ids }, clinicId: user.clinicId } });
    const byId = new Map(rows.map((p) => [p.id, p]));
    const items = ids.map((id) => byId.get(id)).filter((p): p is Patient => !!p);
    return paginate(items.map((p) => this.toView(p, false)), total, q);
  }

  /** Full profile. Viewing it is recorded in the record access log. */
  async get(user: AuthUser, id: string) {
    const patient = await this.prisma.db.patient.findFirst({
      where: { id, clinicId: user.clinicId },
      include: {
        allergies: { orderBy: { notedAt: 'desc' } },
        appointments: { orderBy: { startsAt: 'desc' }, take: 10, include: { doctor: { select: { id: true, firstName: true, lastName: true, title: true } } } },
        prescriptions: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!patient) throw new NotFoundException('Patient not found');
    await this.logAccess(user, id, 'VIEW_PROFILE');
    const { allergies, appointments, prescriptions, ...base } = patient;
    return { ...this.toView(base, user.permissions.has(Permission.PatientsSensitive)), allergies, appointments, prescriptions };
  }

  async create(user: AuthUser, dto: CreatePatientDto) {
    const { nationalId, dateOfBirth, emergencyContact, ...rest } = dto;
    const created = await this.prisma.transaction(async (tx) => {
      const mrn = await this.nextMrn(tx, user.clinicId);
      return tx.patient.create({
        data: {
          ...rest,
          clinicId: user.clinicId,
          mrn,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          emergencyContact: emergencyContact as Prisma.InputJsonValue | undefined,
          nationalIdEnc: this.crypto.encrypt(nationalId),
        },
      });
    });
    return this.toView(created, user.permissions.has(Permission.PatientsSensitive));
  }

  async update(user: AuthUser, id: string, dto: UpdatePatientDto) {
    await this.assertExists(user.clinicId, id);
    const { nationalId, dateOfBirth, emergencyContact, ...rest } = dto;
    const updated = await this.prisma.db.patient.update({
      where: { id },
      data: {
        ...rest,
        dateOfBirth: dateOfBirth === undefined ? undefined : dateOfBirth ? new Date(dateOfBirth) : null,
        emergencyContact: emergencyContact as Prisma.InputJsonValue | undefined,
        ...(nationalId !== undefined ? { nationalIdEnc: this.crypto.encrypt(nationalId) } : {}),
      },
    });
    return this.toView(updated, user.permissions.has(Permission.PatientsSensitive));
  }

  async deactivate(user: AuthUser, id: string) {
    await this.assertExists(user.clinicId, id);
    const p = await this.prisma.db.patient.update({ where: { id }, data: { isActive: false } });
    return this.toView(p, false);
  }

  async addAllergy(user: AuthUser, patientId: string, dto: CreateAllergyDto) {
    await this.assertExists(user.clinicId, patientId);
    return this.prisma.db.allergy.create({ data: { ...dto, clinicId: user.clinicId, patientId } });
  }

  async removeAllergy(user: AuthUser, patientId: string, id: string) {
    const row = await this.prisma.db.allergy.findFirst({ where: { id, patientId, clinicId: user.clinicId } });
    if (!row) throw new NotFoundException('Allergy not found');
    await this.prisma.db.allergy.delete({ where: { id } });
  }

  accessLog(user: AuthUser, patientId: string) {
    return this.prisma.db.recordAccessLog.findMany({ where: { clinicId: user.clinicId, patientId }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  /** Append-only trail of who opened this patient's data. */
  logAccess(user: AuthUser, patientId: string, action: string, encounterId?: string) {
    return this.prisma.db.recordAccessLog.create({ data: { clinicId: user.clinicId, patientId, userId: user.id, action, encounterId } });
  }

  async assertExists(clinicId: string, id: string) {
    const exists = await this.prisma.db.patient.findFirst({ where: { id, clinicId }, select: { id: true } });
    if (!exists) throw new NotFoundException('Patient not found');
  }

  toView(p: Patient, revealSensitive: boolean): PatientView {
    const { nationalIdEnc, ...rest } = p;
    return {
      ...rest,
      nationalId: revealSensitive ? this.crypto.decrypt(nationalIdEnc) : null,
      nationalIdMasked: this.crypto.mask(nationalIdEnc),
    };
  }

  /** Sequential medical record number per clinic, e.g. MRN-000042. */
  private async nextMrn(tx: Prisma.TransactionClient, clinicId: string): Promise<string> {
    const count = await tx.patient.count({ where: { clinicId } });
    for (let n = count + 1; n < count + 1000; n++) {
      const mrn = `MRN-${String(n).padStart(6, '0')}`;
      const taken = await tx.patient.findUnique({ where: { clinicId_mrn: { clinicId, mrn } }, select: { id: true } });
      if (!taken) return mrn;
    }
    throw new Error('Could not allocate MRN');
  }
}
