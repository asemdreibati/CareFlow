import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Permission } from '../../common/permissions/permissions.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { DiagnosisSearchQuery, GlobalSearchQuery, RecordsSearchQuery } from './search.dto.js';
import {
  ENCOUNTER_HEADLINE_SOURCE,
  HEADLINE_OPTIONS,
  PATIENT_SIMILARITY_THRESHOLD,
  containsPattern,
  encounterTsQuery,
  lowerContainsPattern,
  normalized,
  patientMatch,
  patientScore,
} from './search.sql.js';

/** Upcoming appointments shown per matched patient in the global search. */
const APPOINTMENTS_PER_PATIENT = 3;
const UPCOMING_STATUSES = ['SCHEDULED', 'CONFIRMED', 'CHECKED_IN'] as const;

export interface PatientHit {
  id: string;
  mrn: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  dateOfBirth: Date | null;
  gender: string;
  isActive: boolean;
  /** `word_similarity` of the normalised query against the patient's search text (0..1). */
  score: number;
}

export interface EncounterHit {
  id: string;
  patientId: string;
  doctorId: string;
  occurredAt: Date;
  status: string;
  chiefComplaint: string | null;
  /** `ts_rank_cd` of the full-text match (relative; higher is better). */
  rank: number;
  /** `ts_headline` fragments with matches wrapped in `<b>…</b>` (normalised text). */
  snippet: string;
  patient: { id: string; mrn: string; firstName: string; lastName: string };
  doctor: { id: string; firstName: string; lastName: string; title: string | null; specialty: string };
}

export interface InvoiceHit {
  id: string;
  number: string;
  status: string;
  total: number;
  amountPaid: number;
  balance: number;
  issuedAt: Date | null;
  patientId: string;
  patient: { id: string; mrn: string; firstName: string; lastName: string };
}

export interface DiagnosisHit {
  code: string;
  description: string;
  /** How many encounters of the clinic carry this exact code + description. */
  uses: number;
}

export interface GlobalSearchResult {
  patients: PatientHit[];
  encounters: EncounterHit[];
  invoices: InvoiceHit[];
  appointments: AppointmentHit[];
}

const appointmentHitInclude = {
  doctor: { select: { id: true, firstName: true, lastName: true, title: true, specialty: true, color: true } },
  patient: { select: { id: true, mrn: true, firstName: true, lastName: true } },
} satisfies Prisma.AppointmentInclude;
export type AppointmentHit = Prisma.AppointmentGetPayload<{ include: typeof appointmentHitInclude }>;

interface EncounterFilters {
  patientId?: string;
  doctorId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Trigram / full-text search over the clinic's data. Every statement filters on
 * `clinic_id` explicitly (RLS is the backstop) and binds the user's query as a
 * parameter that is normalised in SQL.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────── global search ───────────────────────────────

  async global(user: AuthUser, q: GlobalSearchQuery): Promise<GlobalSearchResult> {
    const can = (p: string) => user.permissions.has(p);
    const query = q.q.trim();
    const limit = q.limit;

    const [patients, encounters, invoices] = await Promise.all([
      can(Permission.PatientsRead) ? this.searchPatients(user.clinicId, query, limit) : Promise.resolve([]),
      can(Permission.RecordsRead) ? this.encounterHits(user, query, {}, limit, 0).then((r) => r.items) : Promise.resolve([]),
      can(Permission.BillingRead) ? this.searchInvoices(user.clinicId, query, limit) : Promise.resolve([]),
    ]);
    const appointments =
      can(Permission.AppointmentsRead) && patients.length > 0
        ? await this.upcomingAppointments(
            user,
            patients.map((p) => p.id),
            limit,
          )
        : [];
    return { patients, encounters, invoices, appointments };
  }

  // ─────────────────────────────── records search ───────────────────────────────

  /** Paginated full-text search over encounters. Logs nothing (snippets only, no full record is opened). */
  async records(user: AuthUser, q: RecordsSearchQuery) {
    const filters: EncounterFilters = {
      patientId: q.patientId,
      doctorId: q.doctorId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    };
    const { items, total } = await this.encounterHits(user, q.q.trim(), filters, q.pageSize, q.skip);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  // ───────────────────────────── diagnoses autocomplete ─────────────────────────────

  /** Distinct ICD code + description pairs previously recorded in the clinic, most used first. */
  async diagnoses(user: AuthUser, q: DiagnosisSearchQuery): Promise<DiagnosisHit[]> {
    const query = q.q.trim();
    const rows = await this.prisma.transaction((tx) =>
      tx.$queryRaw<{ code: string; description: string; uses: number }[]>`
        SELECT d.code, d.description, count(*)::int AS uses
        FROM diagnoses d
        WHERE d.clinic_id = ${user.clinicId}::uuid
          AND (
            lower(d.code) LIKE ${lowerContainsPattern(query)}
            OR careflow_normalize(d.description) ILIKE ${containsPattern(query)}
            OR word_similarity(${normalized(query)}, careflow_normalize(d.description)) >= ${PATIENT_SIMILARITY_THRESHOLD}
          )
        GROUP BY d.code, d.description
        ORDER BY uses DESC, d.code ASC
        LIMIT ${q.limit}`,
    );
    return rows.map((r) => ({ code: r.code, description: r.description, uses: Number(r.uses) }));
  }

  // ──────────────────────────────── entity queries ────────────────────────────────

  private async searchPatients(clinicId: string, q: string, limit: number): Promise<PatientHit[]> {
    const rows = await this.prisma.transaction((tx) =>
      tx.$queryRaw<PatientHit[]>`
        SELECT p.id, p.mrn, p.first_name AS "firstName", p.last_name AS "lastName", p.phone, p.email,
               p.date_of_birth AS "dateOfBirth", p.gender::text AS gender, p.is_active AS "isActive",
               ${patientScore(q)} AS score
        FROM patients p
        WHERE p.clinic_id = ${clinicId}::uuid
          AND p.is_active
          AND ${patientMatch(q)}
        ORDER BY score DESC, p.last_name ASC, p.first_name ASC
        LIMIT ${limit}`,
    );
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  /**
   * Full-text encounter hits with rank and highlighted snippet. DOCTOR without
   * `appointments:read_all` only sees encounters they authored (same rule as GET /encounters/:id).
   */
  private async encounterHits(user: AuthUser, q: string, filters: EncounterFilters, limit: number, offset: number): Promise<{ items: EncounterHit[]; total: number }> {
    const ownOnly = user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
    if (ownOnly && !user.doctorId) return { items: [], total: 0 };
    const doctorIds = [filters.doctorId, ownOnly ? user.doctorId : undefined].filter((d): d is string => !!d);
    if (doctorIds.length === 2 && doctorIds[0] !== doctorIds[1]) return { items: [], total: 0 };
    const doctorId = doctorIds[0];

    const where = Prisma.sql`
      e.clinic_id = ${user.clinicId}::uuid
      AND e.search_vector @@ query
      ${doctorId ? Prisma.sql`AND e.doctor_id = ${doctorId}::uuid` : Prisma.empty}
      ${filters.patientId ? Prisma.sql`AND e.patient_id = ${filters.patientId}::uuid` : Prisma.empty}
      ${filters.from ? Prisma.sql`AND e.occurred_at >= ${filters.from}` : Prisma.empty}
      ${filters.to ? Prisma.sql`AND e.occurred_at < ${filters.to}` : Prisma.empty}`;

    type Row = {
      id: string;
      patientId: string;
      doctorId: string;
      occurredAt: Date;
      status: string;
      chiefComplaint: string | null;
      rank: number;
      snippet: string;
      pMrn: string;
      pFirstName: string;
      pLastName: string;
      dFirstName: string;
      dLastName: string;
      dTitle: string | null;
      dSpecialty: string;
    };

    const { rows, total } = await this.prisma.transaction(async (tx) => {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT e.id, e.patient_id AS "patientId", e.doctor_id AS "doctorId", e.occurred_at AS "occurredAt",
               e.status::text AS status, e.chief_complaint AS "chiefComplaint",
               ts_rank_cd(e.search_vector, query)::float8 AS rank,
               ts_headline('simple', ${ENCOUNTER_HEADLINE_SOURCE}, query, ${HEADLINE_OPTIONS}) AS snippet,
               p.mrn AS "pMrn", p.first_name AS "pFirstName", p.last_name AS "pLastName",
               d.first_name AS "dFirstName", d.last_name AS "dLastName", d.title AS "dTitle", d.specialty AS "dSpecialty"
        FROM encounters e
        CROSS JOIN ${encounterTsQuery(q)} AS query
        JOIN patients p ON p.id = e.patient_id AND p.clinic_id = e.clinic_id
        JOIN doctors d ON d.id = e.doctor_id AND d.clinic_id = e.clinic_id
        WHERE ${where}
        ORDER BY rank DESC, e.occurred_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      const count = await tx.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total
        FROM encounters e
        CROSS JOIN ${encounterTsQuery(q)} AS query
        WHERE ${where}`;
      return { rows, total: Number(count[0]?.total ?? 0) };
    });

    const items: EncounterHit[] = rows.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      doctorId: r.doctorId,
      occurredAt: r.occurredAt,
      status: r.status,
      chiefComplaint: r.chiefComplaint,
      rank: Number(r.rank),
      snippet: r.snippet,
      patient: { id: r.patientId, mrn: r.pMrn, firstName: r.pFirstName, lastName: r.pLastName },
      doctor: { id: r.doctorId, firstName: r.dFirstName, lastName: r.dLastName, title: r.dTitle, specialty: r.dSpecialty },
    }));
    return { items, total };
  }

  private async searchInvoices(clinicId: string, q: string, limit: number): Promise<InvoiceHit[]> {
    type Row = {
      id: string;
      number: string;
      status: string;
      total: number;
      amountPaid: number;
      issuedAt: Date | null;
      patientId: string;
      pMrn: string;
      pFirstName: string;
      pLastName: string;
    };
    const rows = await this.prisma.transaction((tx) =>
      tx.$queryRaw<Row[]>`
        SELECT i.id, i.number, i.status::text AS status, i.total::float8 AS total, i.amount_paid::float8 AS "amountPaid",
               i.issued_at AS "issuedAt", i.patient_id AS "patientId",
               p.mrn AS "pMrn", p.first_name AS "pFirstName", p.last_name AS "pLastName"
        FROM invoices i
        JOIN patients p ON p.id = i.patient_id AND p.clinic_id = i.clinic_id
        WHERE i.clinic_id = ${clinicId}::uuid
          AND lower(i.number) LIKE ${lowerContainsPattern(q)}
        ORDER BY i.created_at DESC
        LIMIT ${limit}`,
    );
    return rows.map((r) => {
      const total = Number(r.total);
      const amountPaid = Number(r.amountPaid);
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        total,
        amountPaid,
        balance: Math.round((total - amountPaid) * 100) / 100,
        issuedAt: r.issuedAt,
        patientId: r.patientId,
        patient: { id: r.patientId, mrn: r.pMrn, firstName: r.pFirstName, lastName: r.pLastName },
      };
    });
  }

  /** Next upcoming appointments of the matched patients (≤ 3 per patient, ≤ limit overall). */
  private async upcomingAppointments(user: AuthUser, patientIds: string[], limit: number): Promise<AppointmentHit[]> {
    const ownOnly = user.role === 'DOCTOR' && !user.permissions.has(Permission.AppointmentsReadAll);
    if (ownOnly && !user.doctorId) return [];
    const rows = await this.prisma.db.appointment.findMany({
      where: {
        clinicId: user.clinicId,
        patientId: { in: patientIds },
        startsAt: { gte: new Date() },
        status: { in: [...UPCOMING_STATUSES] },
        ...(ownOnly ? { doctorId: user.doctorId } : {}),
      },
      include: appointmentHitInclude,
      orderBy: { startsAt: 'asc' },
      take: patientIds.length * APPOINTMENTS_PER_PATIENT,
    });
    const perPatient = new Map<string, number>();
    const out: AppointmentHit[] = [];
    for (const a of rows) {
      const n = perPatient.get(a.patientId) ?? 0;
      if (n >= APPOINTMENTS_PER_PATIENT) continue;
      perPatient.set(a.patientId, n + 1);
      out.push(a);
      if (out.length >= limit) break;
    }
    return out;
  }
}
