import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { MessageChannel } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { APPOINTMENT_EVENTS, type AppointmentEvent } from '../appointments/appointments.service.js';
import { MessagingService, withClinic } from './messaging.service.js';
import { formatWhen, resolveLocale, type Locale } from './messaging.templates.js';

/** `invoice.issued` payload (see BillingService) - only the fields read here. */
interface InvoiceIssuedEvent {
  invoice: { id: string; clinicId: string; patientId: string; number: string; total: number; currency: string };
  actorUserId?: string;
}

interface Recipient {
  patientId: string;
  patientName: string;
  channel: MessageChannel;
  to: string;
  locale: Locale;
  clinicName: string;
  timeZone: string;
}

/**
 * Patient-facing messages driven by domain events: a waitlist hold (held
 * appointment created by the backfill) and an issued invoice. Reminders and
 * portal confirmations are sent by their own services. Handlers never throw
 * back into the emitting request.
 */
@Injectable()
export class MessagingListeners {
  private readonly logger = new Logger(MessagingListeners.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  @OnEvent(APPOINTMENT_EVENTS.created)
  onAppointmentCreated(e: AppointmentEvent) {
    if (!e.holdExpiresAt) return Promise.resolve();
    return this.guard('waitlist.offer', async () => {
      const r = await this.recipient(e.clinicId, e.patientId);
      if (!r) return;
      await this.messaging.send({
        clinicId: e.clinicId,
        patientId: r.patientId,
        appointmentId: e.id,
        channel: r.channel,
        to: r.to,
        template: 'waitlist.offer',
        locale: r.locale,
        params: {
          patientName: r.patientName,
          doctorName: `Dr. ${e.doctor.firstName} ${e.doctor.lastName}`,
          when: formatWhen(new Date(e.startsAt), r.timeZone, r.locale),
          expires: formatWhen(new Date(e.holdExpiresAt as Date), r.timeZone, r.locale),
          clinicName: r.clinicName,
        },
      });
    });
  }

  @OnEvent('invoice.issued')
  onInvoiceIssued(e: InvoiceIssuedEvent) {
    return this.guard('invoice.issued', async () => {
      const inv = e.invoice;
      if (!inv?.clinicId || !inv.patientId) return;
      const r = await this.recipient(inv.clinicId, inv.patientId);
      if (!r) return;
      await this.messaging.send({
        clinicId: inv.clinicId,
        patientId: r.patientId,
        channel: r.channel,
        to: r.to,
        template: 'invoice.issued',
        locale: r.locale,
        params: { patientName: r.patientName, number: inv.number, total: Number(inv.total).toFixed(2), currency: inv.currency, clinicName: r.clinicName },
      });
    });
  }

  /** Patient contact details; SMS when a phone exists, email otherwise, nothing when neither. */
  private recipient(clinicId: string, patientId: string): Promise<Recipient | null> {
    return withClinic(clinicId, async () => {
      const patient = await this.prisma.db.patient.findFirst({
        where: { id: patientId, clinicId, isActive: true },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true, locale: true, clinic: { select: { name: true, timezone: true, settings: true } } },
      });
      if (!patient) return null;
      const to = patient.phone ?? patient.email;
      if (!to) return null;
      const fallback = resolveLocale((patient.clinic.settings as { defaultLocale?: string } | null)?.defaultLocale);
      return {
        patientId: patient.id,
        patientName: `${patient.firstName} ${patient.lastName}`,
        channel: patient.phone ? 'SMS' : 'EMAIL',
        to,
        locale: resolveLocale(patient.locale, fallback),
        clinicName: patient.clinic.name,
        timeZone: patient.clinic.timezone || 'UTC',
      };
    });
  }

  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Messaging listener failed for ${label}: ${(err as Error).message}`);
    }
  }
}
