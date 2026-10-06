import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppointmentStatus, MessageChannel } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { appointmentInclude, AppointmentWriterService, type AppointmentRow } from '../waitlist/appointment-writer.service.js';
import { parseIntent, type InboundIntent } from './inbound-intent.js';
import { MESSAGING_CONFIG, type MessagingConfig } from './messaging.config.js';
import { MessagingService, withClinic } from './messaging.service.js';
import { formatWhen, INBOUND_REPLIES, interpolate, resolveLocale, type Locale } from './messaging.templates.js';
import { channelOfAddress, normalizePhone, phoneVariants } from './phone.js';

export const REMINDER_TEMPLATE = 'appointment.reminder';
const REPLYABLE: readonly AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];
const CANCELLED_BY_REPLY = 'Cancelled by patient (message reply)';

export interface InboundMessageInput {
  from: string;
  body: string;
  providerMessageId: string | null;
  provider?: string;
}

export interface InboundResult {
  /** Localised acknowledgement to send back. */
  reply: string;
  intent: InboundIntent;
  /** Persisted inbound row id (null when the sender is unknown). */
  messageId: string | null;
  appointmentId: string | null;
  action: 'confirmed' | 'cancelled' | 'none';
}

interface Target {
  clinicId: string;
  patientId: string;
  locale: Locale;
  timeZone: string;
  appointment: { id: string; status: AppointmentStatus; startsAt: Date } | null;
  inReplyToId: string | null;
}

/**
 * Two-way messaging: interprets a patient's reply (`1` / `2`, yes / no, Arabic
 * or English) and applies it to the appointment the latest reminder was about,
 * or else to the patient's next upcoming appointment. Works across clinics
 * (the phone is the only identity) in a system context, then performs the
 * writes in the clinic's RLS scope so the standard `appointment.*` events fire.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly writer: AppointmentWriterService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  async handle(input: InboundMessageInput): Promise<InboundResult> {
    const channel: MessageChannel = channelOfAddress(input.from);
    const phone = normalizePhone(input.from, this.config.defaultCountryCode);
    const intent = parseIntent(input.body);
    const provider = input.provider ?? 'twilio';
    if (!phone) return { reply: this.bilingual('unknownPatient'), intent, messageId: null, appointmentId: null, action: 'none' };

    const target = await this.resolveTarget(phone);
    if (!target) {
      this.logger.warn(`Inbound ${channel} from an unknown number (${phone.slice(0, 5)}…): ignored`);
      return { reply: this.bilingual('unknownPatient'), intent, messageId: null, appointmentId: null, action: 'none' };
    }

    return withClinic(target.clinicId, async () => {
      let action: InboundResult['action'] = 'none';
      let reply: string;
      const appt = target.appointment;
      const when = appt ? formatWhen(appt.startsAt, target.timeZone, target.locale) : '';

      if (intent === 'CONFIRM' && appt) {
        if (appt.status === 'SCHEDULED') {
          const row = await this.prisma.db.appointment.update({ where: { id: appt.id }, data: { status: 'CONFIRMED', version: { increment: 1 } }, include: appointmentInclude });
          this.writer.emitUpdated(row, target.patientId);
          action = 'confirmed';
        }
        reply = this.text('confirmed', target.locale, when);
      } else if (intent === 'CANCEL' && appt) {
        const row: AppointmentRow = await this.prisma.transaction((tx) => this.writer.cancel(tx, appt.id, CANCELLED_BY_REPLY));
        this.writer.emitCancelled(row, target.patientId);
        action = 'cancelled';
        reply = this.text('cancelled', target.locale, when);
      } else if (intent === 'UNKNOWN') {
        reply = this.text('unknown', target.locale, when);
      } else {
        reply = this.text('nothing', target.locale, when);
      }

      const row = await this.messaging.recordInbound({
        clinicId: target.clinicId,
        patientId: target.patientId,
        appointmentId: appt?.id ?? null,
        channel,
        address: phone,
        body: input.body,
        provider,
        providerMessageId: input.providerMessageId,
        inReplyToId: target.inReplyToId,
        intent,
      });
      return { reply, intent, messageId: row.id, appointmentId: appt?.id ?? null, action };
    });
  }

  // ─────────────────────────────── resolution ───────────────────────────────

  /**
   * 1. The appointment of the latest outbound reminder to this phone, when it is
   *    still upcoming. 2. Otherwise the patient's (any clinic) next upcoming
   *    SCHEDULED/CONFIRMED appointment. 3. Otherwise just the patient (no appointment).
   */
  private async resolveTarget(phone: string): Promise<Target | null> {
    const now = new Date();
    const variants = phoneVariants(phone, this.config.defaultCountryCode);
    return tenantContext.runSystem(async () => {
      const reminder = await this.prisma.db.message.findFirst({
        where: { address: phone, direction: 'OUTBOUND', template: REMINDER_TEMPLATE, appointmentId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, clinicId: true, patientId: true, appointmentId: true },
      });
      if (reminder?.appointmentId) {
        const appt = await this.prisma.db.appointment.findFirst({
          where: { id: reminder.appointmentId, status: { in: [...REPLYABLE] }, startsAt: { gt: now } },
          select: { id: true, status: true, startsAt: true, patientId: true, clinicId: true, patient: { select: { locale: true } }, clinic: { select: { timezone: true, settings: true } } },
        });
        if (appt) {
          return {
            clinicId: appt.clinicId,
            patientId: appt.patientId,
            locale: this.localeOf(appt.patient.locale, appt.clinic.settings),
            timeZone: appt.clinic.timezone || 'UTC',
            appointment: { id: appt.id, status: appt.status, startsAt: appt.startsAt },
            inReplyToId: reminder.id,
          };
        }
      }

      const patients = await this.prisma.db.patient.findMany({
        where: { phone: { in: variants }, isActive: true, clinic: { isActive: true } },
        select: { id: true, clinicId: true, locale: true, clinic: { select: { timezone: true, settings: true } } },
        orderBy: { createdAt: 'asc' },
      });
      if (patients.length === 0) return null;

      const next = await this.prisma.db.appointment.findFirst({
        where: { patientId: { in: patients.map((p) => p.id) }, status: { in: [...REPLYABLE] }, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        select: { id: true, status: true, startsAt: true, patientId: true },
      });
      const patient = (next ? patients.find((p) => p.id === next.patientId) : undefined) ?? patients[0];
      return {
        clinicId: patient.clinicId,
        patientId: patient.id,
        locale: this.localeOf(patient.locale, patient.clinic.settings),
        timeZone: patient.clinic.timezone || 'UTC',
        appointment: next ? { id: next.id, status: next.status, startsAt: next.startsAt } : null,
        inReplyToId: reminder?.id ?? null,
      };
    });
  }

  private localeOf(patientLocale: string | null, clinicSettings: unknown): Locale {
    const fallback = resolveLocale((clinicSettings as { defaultLocale?: string } | null)?.defaultLocale);
    return resolveLocale(patientLocale, fallback);
  }

  private text(key: keyof typeof INBOUND_REPLIES, locale: Locale, when: string): string {
    return interpolate(INBOUND_REPLIES[key][locale], { when });
  }

  private bilingual(key: keyof typeof INBOUND_REPLIES): string {
    return `${INBOUND_REPLIES[key].ar}\n${INBOUND_REPLIES[key].en}`;
  }
}
