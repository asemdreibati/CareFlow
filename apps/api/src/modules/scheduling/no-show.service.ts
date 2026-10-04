import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { AppointmentStatus, NoShowModel, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { predictLogistic, trainLogistic, type LogisticModel, type LogisticSample } from '../../scheduling-engine/logistic.js';
import { extractNoShowFeatures, NO_SHOW_FEATURE_NAMES, patientHistoryBefore, type PatientHistory } from '../../scheduling-engine/noshow-features.js';
import type { AppointmentEvent } from '../appointments/appointments.service.js';
import { dayBounds, isValidDateString } from '../appointments/scheduling.js';
import { errorMessage, inClinic } from './scheduling.common.js';

export const NO_SHOW_MIN_SAMPLES = 30;
const MAX_TRAINING_ROWS = 20_000;
const DEFAULT_RISK_THRESHOLD = 0.5;
const OUTCOME_STATUSES: readonly AppointmentStatus[] = ['COMPLETED', 'NO_SHOW'];
/** Statuses worth scoring (the visit has not happened yet). */
const SCORABLE_STATUSES: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];
const TRAIN_OPTIONS = { epochs: 400, lr: 0.1, l2: 0.01 } as const;

/** JSON stored in `no_show_models.parameters`. */
export interface StoredNoShowParameters {
  featureNames: string[];
  bias: number;
  weights: Record<string, number>;
  means: Record<string, number>;
  scales: Record<string, number>;
}

@Injectable()
export class NoShowService {
  private readonly logger = new Logger(NoShowService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────── training ───────────────────────────────

  /** Trains on the clinic's COMPLETED vs NO_SHOW history and upserts the clinic's model. */
  async train(clinicId: string) {
    const [rows, clinic] = await Promise.all([
      this.prisma.db.appointment.findMany({
        where: { clinicId, status: { in: [...OUTCOME_STATUSES] } },
        orderBy: { startsAt: 'asc' },
        take: MAX_TRAINING_ROWS,
        select: { patientId: true, startsAt: true, createdAt: true, type: true, status: true, patient: { select: { dateOfBirth: true } } },
      }),
      this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } }),
    ]);
    if (rows.length < NO_SHOW_MIN_SAMPLES) {
      throw new BadRequestException(`At least ${NO_SHOW_MIN_SAMPLES} completed or no-show appointments are required to train the model (found ${rows.length})`);
    }
    const timeZone = clinic?.timezone || 'UTC';

    // Rows are in start order, so each sample sees only the patient's history before it (no leakage).
    const history = new Map<string, PatientHistory>();
    const samples: LogisticSample[] = rows.map((r) => {
      const h = history.get(r.patientId) ?? { pastAppointments: 0, pastNoShows: 0, lastVisitAt: null };
      const features = extractNoShowFeatures({
        startsAt: r.startsAt,
        createdAt: r.createdAt,
        type: r.type,
        timeZone,
        patientDateOfBirth: r.patient.dateOfBirth,
        patientPastAppointments: h.pastAppointments,
        patientPastNoShows: h.pastNoShows,
        patientLastVisitAt: h.lastVisitAt,
      });
      const isNoShow = r.status === 'NO_SHOW';
      history.set(r.patientId, {
        pastAppointments: h.pastAppointments + 1,
        pastNoShows: h.pastNoShows + (isNoShow ? 1 : 0),
        lastVisitAt: isNoShow ? h.lastVisitAt : r.startsAt,
      });
      return { features, label: isNoShow ? 1 : 0 };
    });

    const model = trainLogistic(samples, TRAIN_OPTIONS);
    const parameters = this.toStored(model);
    const metrics = { ...model.metrics, trainedOn: new Date().toISOString() };
    return this.prisma.db.noShowModel.upsert({
      where: { clinicId },
      create: { clinicId, parameters: parameters as unknown as Prisma.InputJsonValue, sampleSize: samples.length, metrics },
      update: { parameters: parameters as unknown as Prisma.InputJsonValue, sampleSize: samples.length, metrics, trainedAt: new Date() },
    });
  }

  async get(user: AuthUser) {
    const model = await this.prisma.db.noShowModel.findUnique({ where: { clinicId: user.clinicId } });
    if (!model) throw new NotFoundException('No no-show model has been trained for this clinic yet');
    return model;
  }

  /** Nightly retrain (02:10 server time) for every clinic with enough outcomes. Never throws. */
  @Cron('10 2 * * *')
  async retrainAll(): Promise<void> {
    try {
      const groups = await tenantContext.runSystem(() =>
        this.prisma.db.appointment.groupBy({ by: ['clinicId'], where: { status: { in: [...OUTCOME_STATUSES] } }, _count: { _all: true } }),
      );
      for (const g of groups) {
        if (g._count._all < NO_SHOW_MIN_SAMPLES) continue;
        try {
          const model = await tenantContext.runSystem(() => this.train(g.clinicId), { clinicId: g.clinicId, requestId: 'no-show-retrain' });
          this.logger.log(`Retrained no-show model for clinic ${g.clinicId}: n=${model.sampleSize}`);
        } catch (err) {
          this.logger.error(`No-show retrain failed for clinic ${g.clinicId}: ${errorMessage(err)}`);
        }
      }
    } catch (err) {
      this.logger.error(`No-show retrain sweep failed: ${errorMessage(err)}`);
    }
  }

  // ─────────────────────────────── scoring ───────────────────────────────

  /**
   * Computes and stores `noShowRisk` for one appointment when the clinic has a
   * model. Writes with a direct `updateMany` and emits nothing (no event loop).
   */
  async score(e: AppointmentEvent): Promise<number | null> {
    if (!SCORABLE_STATUSES.includes(e.status)) return null;
    return inClinic(e.clinicId, async () => {
      const model = await this.prisma.db.noShowModel.findUnique({ where: { clinicId: e.clinicId } });
      if (!model) return null;
      const [patient, clinic, past] = await Promise.all([
        this.prisma.db.patient.findFirst({ where: { id: e.patientId, clinicId: e.clinicId }, select: { dateOfBirth: true } }),
        this.prisma.db.clinic.findUnique({ where: { id: e.clinicId }, select: { timezone: true } }),
        this.prisma.db.appointment.findMany({
          where: { clinicId: e.clinicId, patientId: e.patientId, status: { in: [...OUTCOME_STATUSES] }, id: { not: e.id } },
          select: { patientId: true, startsAt: true, status: true },
        }),
      ]);
      const startsAt = new Date(e.startsAt);
      const h = patientHistoryBefore(past, startsAt);
      const features = extractNoShowFeatures({
        startsAt,
        createdAt: new Date(e.createdAt),
        type: e.type,
        timeZone: clinic?.timezone || 'UTC',
        patientDateOfBirth: patient?.dateOfBirth ?? null,
        patientPastAppointments: h.pastAppointments,
        patientPastNoShows: h.pastNoShows,
        patientLastVisitAt: h.lastVisitAt,
      });
      const risk = this.clamp(predictLogistic(this.fromStored(model), features));
      await this.prisma.db.appointment.updateMany({ where: { id: e.id, clinicId: e.clinicId }, data: { noShowRisk: risk } });
      return risk;
    });
  }

  /** Appointments of one day (clinic timezone) with risk ≥ threshold, highest first. */
  async atRisk(user: AuthUser, date: string, threshold = DEFAULT_RISK_THRESHOLD) {
    if (!isValidDateString(date)) throw new BadRequestException('date must be a valid YYYY-MM-DD date');
    const clinic = await this.prisma.db.clinic.findUnique({ where: { id: user.clinicId }, select: { timezone: true } });
    const timeZone = clinic?.timezone || 'UTC';
    const day = dayBounds(date, timeZone);
    const items = await this.prisma.db.appointment.findMany({
      where: { clinicId: user.clinicId, startsAt: { gte: day.startsAt, lt: day.endsAt }, status: { in: [...SCORABLE_STATUSES] }, noShowRisk: { gte: threshold } },
      orderBy: [{ noShowRisk: 'desc' }, { startsAt: 'asc' }],
      include: {
        doctor: { select: { id: true, firstName: true, lastName: true, title: true, color: true } },
        patient: { select: { id: true, mrn: true, firstName: true, lastName: true, phone: true, email: true } },
      },
    });
    return { date, timezone: timeZone, threshold, items };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private toStored(model: LogisticModel): StoredNoShowParameters {
    const names = [...NO_SHOW_FEATURE_NAMES];
    const record = (values: number[]) => Object.fromEntries(names.map((n, i) => [n, values[i] ?? 0]));
    return { featureNames: names, bias: model.bias, weights: record(model.weights), means: record(model.means), scales: record(model.scales) };
  }

  private fromStored(row: NoShowModel): Pick<LogisticModel, 'bias' | 'weights' | 'means' | 'scales'> {
    const p = row.parameters as unknown as Partial<StoredNoShowParameters>;
    const names = p.featureNames ?? [...NO_SHOW_FEATURE_NAMES];
    const pick = (rec: Record<string, number> | undefined, fallback: number) => names.map((n) => (typeof rec?.[n] === 'number' ? rec[n] : fallback));
    return { bias: typeof p.bias === 'number' ? p.bias : 0, weights: pick(p.weights, 0), means: pick(p.means, 0), scales: pick(p.scales, 1) };
  }

  private clamp(x: number): number {
    if (!Number.isFinite(x)) return 0.5;
    return Math.min(1, Math.max(0, x));
  }
}
