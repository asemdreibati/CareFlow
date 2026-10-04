import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Reminder, ReminderChannel, ReminderStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { AppointmentEvent } from '../appointments/appointments.service.js';
import { EmailSender } from '../notifications/email.sender.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { errorMessage, inClinic, MOVABLE_STATUSES } from './scheduling.common.js';

const HOUR = 3_600_000;
export const REMINDER_MAX_ATTEMPTS = 3;
export const REMINDER_BATCH = 100;
const LIST_LIMIT = 200;
/** Reminder schedule: channel and hours before the appointment. */
const REMINDER_PLAN: readonly { channel: ReminderChannel; hoursBefore: number }[] = [
  { channel: 'IN_APP', hoursBefore: 24 },
  { channel: 'IN_APP', hoursBefore: 2 },
  { channel: 'EMAIL', hoursBefore: 24 },
];

/** A delivery problem that will not go away by retrying (no address, appointment gone). */
class PermanentReminderError extends Error {}

export interface ReminderPassResult {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  cancelled: number;
}

@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailSender,
  ) {}

  // ─────────────────────────────── outbox maintenance (listeners) ───────────────────────────────

  /**
   * Upserts the reminder rows for an appointment after it was created or updated.
   * Rows are wanted only while the appointment is still bookable (SCHEDULED /
   * CONFIRMED) and starts in the future; a reminder whose send time has already
   * passed is not created (sending "24h before" after the fact is noise). Pending
   * rows that no longer match (moved appointment, finished status) are cancelled;
   * previously cancelled rows for a slot that is wanted again are revived.
   */
  async syncForAppointment(e: AppointmentEvent, now = new Date()): Promise<void> {
    const startsAt = new Date(e.startsAt);
    const active = MOVABLE_STATUSES.includes(e.status) && startsAt.getTime() > now.getTime();
    const wanted = active
      ? REMINDER_PLAN.map((p) => ({ channel: p.channel, scheduledFor: new Date(startsAt.getTime() - p.hoursBefore * HOUR) })).filter((w) => w.scheduledFor.getTime() > now.getTime())
      : [];
    await inClinic(e.clinicId, async () => {
      await this.prisma.db.reminder.updateMany({
        where: { clinicId: e.clinicId, appointmentId: e.id, status: 'PENDING', NOT: wanted.map((w) => ({ channel: w.channel, scheduledFor: w.scheduledFor })) },
        data: { status: 'CANCELLED' },
      });
      for (const w of wanted) {
        await this.prisma.db.reminder.upsert({
          where: { appointmentId_channel_scheduledFor: { appointmentId: e.id, channel: w.channel, scheduledFor: w.scheduledFor } },
          create: { clinicId: e.clinicId, appointmentId: e.id, channel: w.channel, scheduledFor: w.scheduledFor },
          update: {},
        });
      }
      if (wanted.length > 0) {
        await this.prisma.db.reminder.updateMany({
          where: { clinicId: e.clinicId, appointmentId: e.id, status: 'CANCELLED', OR: wanted.map((w) => ({ channel: w.channel, scheduledFor: w.scheduledFor })) },
          data: { status: 'PENDING', attempts: 0, lastError: null },
        });
      }
    });
  }

  async cancelForAppointment(e: AppointmentEvent): Promise<void> {
    await inClinic(e.clinicId, async () => {
      await this.prisma.db.reminder.updateMany({ where: { clinicId: e.clinicId, appointmentId: e.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    });
  }

  // ─────────────────────────────── queries ───────────────────────────────

  list(user: AuthUser, q: { appointmentId?: string; status?: ReminderStatus }) {
    return this.prisma.db.reminder.findMany({
      where: { clinicId: user.clinicId, ...(q.appointmentId ? { appointmentId: q.appointmentId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ scheduledFor: 'asc' }, { channel: 'asc' }],
      take: LIST_LIMIT,
    });
  }

  // ─────────────────────────────── worker ───────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.runOnce();
      if (r.claimed > 0) this.logger.log(`Reminders: claimed=${r.claimed} sent=${r.sent} retried=${r.retried} failed=${r.failed} cancelled=${r.cancelled}`);
    } catch (err) {
      this.logger.error(`Reminder worker failed: ${errorMessage(err)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One worker pass: for every clinic with due PENDING rows, claim up to 100
   * (compare-and-set on status + attempts), deliver, then mark SENT, or PENDING
   * again with `lastError` (retry on the next pass) until the third attempt
   * fails → FAILED. Exposed so tests can drive it without the cron.
   */
  async runOnce(now = new Date()): Promise<ReminderPassResult> {
    const total: ReminderPassResult = { claimed: 0, sent: 0, failed: 0, retried: 0, cancelled: 0 };
    const clinics = await tenantContext.runSystem(() =>
      this.prisma.db.reminder.findMany({
        where: { status: 'PENDING', scheduledFor: { lte: now }, attempts: { lt: REMINDER_MAX_ATTEMPTS } },
        distinct: ['clinicId'],
        select: { clinicId: true },
      }),
    );
    for (const { clinicId } of clinics) {
      try {
        const r = await tenantContext.runSystem(() => this.processClinic(clinicId, now), { clinicId, requestId: 'reminders-worker' });
        total.claimed += r.claimed;
        total.sent += r.sent;
        total.failed += r.failed;
        total.retried += r.retried;
        total.cancelled += r.cancelled;
      } catch (err) {
        this.logger.error(`Reminder pass failed for clinic ${clinicId}: ${errorMessage(err)}`);
      }
    }
    return total;
  }

  private async processClinic(clinicId: string, now: Date): Promise<ReminderPassResult> {
    const result: ReminderPassResult = { claimed: 0, sent: 0, failed: 0, retried: 0, cancelled: 0 };
    const due = await this.prisma.db.reminder.findMany({
      where: { clinicId, status: 'PENDING', scheduledFor: { lte: now }, attempts: { lt: REMINDER_MAX_ATTEMPTS } },
      orderBy: { scheduledFor: 'asc' },
      take: REMINDER_BATCH,
    });
    for (const row of due) {
      // In-flight marker: only one worker wins the compare-and-set.
      const claim = await this.prisma.db.reminder.updateMany({ where: { id: row.id, status: 'PENDING', attempts: row.attempts }, data: { attempts: { increment: 1 } } });
      if (claim.count === 0) continue;
      result.claimed++;
      const attempt = row.attempts + 1;
      try {
        const outcome = await this.deliver(row, clinicId, now);
        if (outcome === 'obsolete') {
          await this.prisma.db.reminder.update({ where: { id: row.id }, data: { status: 'CANCELLED', lastError: 'Appointment is no longer upcoming' } });
          result.cancelled++;
        } else {
          await this.prisma.db.reminder.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
          result.sent++;
        }
      } catch (err) {
        const message = errorMessage(err).slice(0, 1000);
        const final = err instanceof PermanentReminderError || attempt >= REMINDER_MAX_ATTEMPTS;
        await this.prisma.db.reminder.update({ where: { id: row.id }, data: { status: final ? 'FAILED' : 'PENDING', lastError: message } });
        if (final) result.failed++;
        else result.retried++;
      }
    }
    return result;
  }

  private async deliver(row: Reminder, clinicId: string, now: Date): Promise<'sent' | 'obsolete'> {
    const appt = await this.prisma.db.appointment.findFirst({
      where: { id: row.appointmentId, clinicId },
      include: {
        doctor: { select: { id: true, userId: true, firstName: true, lastName: true } },
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
        clinic: { select: { name: true, timezone: true } },
      },
    });
    if (!appt) throw new PermanentReminderError('Appointment no longer exists');
    if (!MOVABLE_STATUSES.includes(appt.status) || appt.startsAt.getTime() <= now.getTime()) return 'obsolete';

    const when = new Intl.DateTimeFormat('en-GB', { timeZone: appt.clinic.timezone || 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(appt.startsAt);
    const patientName = `${appt.patient.firstName} ${appt.patient.lastName}`;
    const doctorName = `Dr. ${appt.doctor.firstName} ${appt.doctor.lastName}`;
    const data = { appointmentId: appt.id, doctorId: appt.doctor.id, patientId: appt.patient.id, startsAt: appt.startsAt.toISOString(), channel: row.channel, reminderId: row.id };

    switch (row.channel) {
      case 'IN_APP': {
        const recipients = [appt.doctor.userId, appt.createdById].filter((id): id is string => !!id);
        if (recipients.length === 0) throw new PermanentReminderError('No in-app recipient (doctor has no user and creator is unknown)');
        await this.notifications.notify(recipients, {
          clinicId,
          type: 'APPOINTMENT_REMINDER',
          title: 'Appointment reminder',
          body: `Reminder: ${patientName} has an appointment with ${doctorName} on ${when}.`,
          data,
        });
        return 'sent';
      }
      case 'EMAIL': {
        if (!appt.patient.email) throw new PermanentReminderError('Patient has no email address');
        await this.email.send(
          appt.patient.email,
          `Appointment reminder - ${appt.clinic.name}`,
          `Dear ${patientName},\n\nThis is a reminder of your appointment with ${doctorName} on ${when}.\n\n${appt.clinic.name}`,
        );
        return 'sent';
      }
      default:
        throw new PermanentReminderError(`Channel ${row.channel} is not configured`);
    }
  }
}
