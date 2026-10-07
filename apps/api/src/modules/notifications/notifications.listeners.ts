import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { NotificationType, Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { activeMembershipWhere } from './notifications.gateway.js';
import { NotificationsService } from './notifications.service.js';

/** Shape of `appointment.*` events (see AppointmentsService). */
interface AppointmentEventPayload {
  id: string;
  clinicId: string;
  startsAt: Date | string;
  endsAt: Date | string;
  status: string;
  createdById: string | null;
  doctor: { id: string; userId: string | null; firstName: string; lastName: string };
  patient: { id: string; firstName: string; lastName: string };
  actorUserId?: string;
}

/** Shape of `invoice.issued` / `payment.received` events (see BillingService). */
interface BillingEventPayload {
  invoice: { id: string; clinicId?: string; number?: string; total?: unknown; amountPaid?: unknown; currency?: string; patientId?: string };
  payment?: { id?: string; amount?: unknown; method?: string };
  actorUserId?: string;
}

const BILLING_ROLES: Role[] = ['OWNER', 'ADMIN', 'ACCOUNTANT'];

/**
 * Maps domain events to notification recipients. Listeners run inside the
 * emitting request's async context (so RLS is active) but must never throw
 * back into it: every handler is wrapped in `guard()`.
 */
@Injectable()
export class NotificationsListeners {
  private readonly logger = new Logger(NotificationsListeners.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('appointment.created')
  onAppointmentCreated(e: AppointmentEventPayload) {
    return this.appointment(e, 'APPOINTMENT_CREATED', 'New appointment', 'booked');
  }

  @OnEvent('appointment.updated')
  onAppointmentUpdated(e: AppointmentEventPayload) {
    return this.appointment(e, 'APPOINTMENT_UPDATED', 'Appointment updated', `updated (${e.status.toLowerCase().replace('_', ' ')})`);
  }

  @OnEvent('appointment.cancelled')
  onAppointmentCancelled(e: AppointmentEventPayload) {
    return this.appointment(e, 'APPOINTMENT_CANCELLED', 'Appointment cancelled', 'cancelled');
  }

  @OnEvent('appointment.checked_in')
  onAppointmentCheckedIn(e: AppointmentEventPayload) {
    return this.appointment(e, 'PATIENT_CHECKED_IN', 'Patient checked in', 'checked in');
  }

  @OnEvent('invoice.issued')
  onInvoiceIssued(e: BillingEventPayload) {
    return this.guard('invoice.issued', async () => {
      const inv = e.invoice;
      await this.notifications.notify(await this.billingRecipients(inv.clinicId, e.actorUserId), {
        clinicId: inv.clinicId,
        type: 'INVOICE_ISSUED',
        title: 'Invoice issued',
        body: `Invoice ${inv.number ?? inv.id} was issued${inv.total != null ? ` for ${String(inv.total)} ${inv.currency ?? ''}`.trimEnd() : ''}.`,
        data: { invoiceId: inv.id, number: inv.number, patientId: inv.patientId },
      });
    });
  }

  @OnEvent('payment.received')
  onPaymentReceived(e: BillingEventPayload) {
    return this.guard('payment.received', async () => {
      const inv = e.invoice;
      const amount = e.payment?.amount != null ? `${String(e.payment.amount)} ${inv.currency ?? ''}`.trimEnd() : 'A payment';
      await this.notifications.notify(await this.billingRecipients(inv.clinicId, e.actorUserId), {
        clinicId: inv.clinicId,
        type: 'PAYMENT_RECEIVED',
        title: 'Payment received',
        body: `${amount} received for invoice ${inv.number ?? inv.id}.`,
        data: { invoiceId: inv.id, number: inv.number, paymentId: e.payment?.id, patientId: inv.patientId },
      });
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  /** Recipients are filtered to active members of `e.clinicId` by NotificationsService.notify(). */
  private appointment(e: AppointmentEventPayload, type: NotificationType, title: string, verb: string) {
    return this.guard(type, async () => {
      const recipients = [e.doctor.userId, e.createdById].filter((id): id is string => !!id && id !== e.actorUserId);
      if (recipients.length === 0) return;
      const when = await this.formatWhen(e.clinicId, new Date(e.startsAt));
      await this.notifications.notify(recipients, {
        clinicId: e.clinicId,
        type,
        title,
        body: `Appointment for ${e.patient.firstName} ${e.patient.lastName} with Dr. ${e.doctor.firstName} ${e.doctor.lastName} on ${when} was ${verb}.`,
        data: { appointmentId: e.id, doctorId: e.doctor.id, patientId: e.patient.id, startsAt: new Date(e.startsAt).toISOString(), status: e.status },
      });
    });
  }

  /** Active OWNER / ADMIN / ACCOUNTANT members of the clinic, minus the actor. */
  private async billingRecipients(clinicId: string | undefined, actorUserId?: string): Promise<string[]> {
    const cid = clinicId ?? tenantContext.get()?.clinicId;
    if (!cid) return [];
    const members = await this.prisma.db.clinicMembership.findMany({
      where: { ...activeMembershipWhere(cid), role: { in: BILLING_ROLES } },
      select: { userId: true },
    });
    return members.map((m) => m.userId).filter((id) => id !== actorUserId);
  }

  private async formatWhen(clinicId: string, date: Date): Promise<string> {
    let timeZone = 'UTC';
    try {
      const clinic = await this.prisma.db.clinic.findUnique({ where: { id: clinicId }, select: { timezone: true } });
      timeZone = clinic?.timezone || 'UTC';
      return new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Notification listener failed for ${label}: ${(err as Error).message}`, (err as Error).stack);
    }
  }
}
