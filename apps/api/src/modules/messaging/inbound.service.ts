import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MessageChannel } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { appointmentInclude, AppointmentWriterService, type AppointmentRow } from '../waitlist/appointment-writer.service.js';
import { WaitlistService } from '../waitlist/waitlist.service.js';
import { decideInbound, type InboundDecision, type ReplyAppointment } from './inbound-decision.js';
import { parseIntent, type InboundIntent } from './inbound-intent.js';
import { MESSAGING_CONFIG, type MessagingConfig } from './messaging.config.js';
import { inboundMessageData, withClinic } from './messaging.service.js';
import { formatWhen, INBOUND_REPLIES, interpolate, REPLYABLE_TEMPLATES, resolveLocale, type InboundReplyKey, type Locale } from './messaging.templates.js';
import { findPatientsByPhoneAnyClinic, isUniqueViolation } from './patient-phone-lookup.js';
import { channelOfAddress, normalizePhone, phoneDigitVariants } from './phone.js';

export const REMINDER_TEMPLATE = 'appointment.reminder';
const CANCELLED_BY_REPLY = 'Cancelled by patient (message reply)';
const DAY_MS = 86_400_000;

export interface InboundMessageInput {
  from: string;
  body: string;
  providerMessageId: string | null;
  provider?: string;
}

export interface InboundResult {
  /** Localised acknowledgement to send back ('' for a duplicate delivery: nothing is sent). */
  reply: string;
  intent: InboundIntent;
  /** Persisted inbound row id (null when the sender is unknown). */
  messageId: string | null;
  appointmentId: string | null;
  action: 'confirmed' | 'cancelled' | 'none';
  /** The provider message id was already processed (webhook retry / replay). */
  duplicate?: boolean;
}

interface Target {
  clinicId: string;
  patientId: string;
  locale: Locale;
  timeZone: string;
  /** Latest outbound message with reply instructions to this phone (within the window) and its appointment. */
  outboundId: string | null;
  appointmentId: string | null;
}

interface Applied {
  rowId: string;
  decision: InboundDecision;
  appointment: ReplyAppointment | null;
  changed: AppointmentRow | null;
}

/**
 * Two-way messaging: interprets a patient's reply (`1` / `2`, yes / no, Arabic
 * or English) and applies it to the appointment of the latest outbound message
 * to that phone that carried reply instructions (`appointment.reminder`,
 * `appointment.confirmed`), sent within the reply window, while that
 * appointment is still SCHEDULED/CONFIRMED and upcoming. Nothing else is ever
 * acted on: otherwise the patient is asked to contact the clinic.
 *
 * Deliveries are de-duplicated by the provider message id (an earlier inbound
 * row with the same id, or a unique violation on insert), and replies to the
 * same outbound message are serialised (row lock) so at most one of them ever
 * changes something. An inbound row's `appointmentId` is set only when that
 * reply acted on the appointment; `inReplyToId` always names the message answered.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AppointmentWriterService,
    private readonly waitlist: WaitlistService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  async handle(input: InboundMessageInput, now: Date = new Date()): Promise<InboundResult> {
    const channel: MessageChannel = channelOfAddress(input.from);
    const phone = normalizePhone(input.from, this.config.defaultCountryCode);
    const intent = parseIntent(input.body);
    const provider = input.provider ?? 'twilio';
    const sid = input.providerMessageId?.trim() || null;
    if (!phone) return { reply: this.bilingual('unknownPatient'), intent, messageId: null, appointmentId: null, action: 'none' };

    if (sid) {
      const dup = await this.findInbound(sid);
      if (dup) return this.duplicate(dup, intent, sid);
    }

    const target = await this.resolveTarget(phone, now);
    if (!target) {
      this.logger.warn(`Inbound ${channel} from an unknown number (${phone.slice(0, 5)}…): ignored`);
      return { reply: this.bilingual('unknownPatient'), intent, messageId: null, appointmentId: null, action: 'none' };
    }

    try {
      return await withClinic(target.clinicId, async () => {
        const applied = await this.apply(target, { channel, phone, intent, provider, sid, body: input.body }, now);
        return this.finish(target, applied, intent);
      });
    } catch (err) {
      if (sid && isUniqueViolation(err)) {
        const dup = await this.findInbound(sid);
        if (dup) return this.duplicate(dup, intent, sid);
      }
      throw err;
    }
  }

  // ─────────────────────────────── apply ───────────────────────────────

  /** One transaction: lock the answered message, decide, record the reply, perform direct appointment writes. */
  private apply(target: Target, msg: { channel: MessageChannel; phone: string; intent: InboundIntent; provider: string; sid: string | null; body: string }, now: Date): Promise<Applied> {
    return this.prisma.transaction(async (tx) => {
      let appointment: ReplyAppointment | null = null;
      let alreadyActedOn = false;
      let heldOfferEntryId: string | null = null;
      if (target.outboundId && target.appointmentId) {
        // Serialises replies to the same outbound message (replays under another id, concurrent deliveries).
        await tx.$queryRaw`SELECT id FROM messages WHERE id = ${target.outboundId}::uuid FOR UPDATE`;
        appointment = await tx.appointment.findFirst({
          where: { id: target.appointmentId, clinicId: target.clinicId },
          select: { id: true, status: true, startsAt: true, holdExpiresAt: true },
        });
        const acted = await tx.message.count({ where: { clinicId: target.clinicId, inReplyToId: target.outboundId, direction: 'INBOUND', appointmentId: { not: null } } });
        alreadyActedOn = acted > 0;
        if (appointment?.holdExpiresAt) {
          const entry = await tx.waitlistEntry.findFirst({
            where: { clinicId: target.clinicId, offeredAppointmentId: appointment.id, patientId: target.patientId, status: 'OFFERED' },
            select: { id: true },
          });
          heldOfferEntryId = entry?.id ?? null;
        }
      }

      const decision = decideInbound({ intent: msg.intent, appointment, alreadyActedOn, heldOfferEntryId, now });
      const acting = decision.action !== 'none' && !!appointment;
      const row = await tx.message.create({
        data: inboundMessageData({
          clinicId: target.clinicId,
          patientId: target.patientId,
          appointmentId: acting ? (appointment as ReplyAppointment).id : null,
          channel: msg.channel,
          address: msg.phone,
          body: msg.body,
          provider: msg.provider,
          providerMessageId: msg.sid,
          inReplyToId: target.outboundId,
          intent: msg.intent,
        }),
        select: { id: true },
      });

      let changed: AppointmentRow | null = null;
      if (appointment && decision.action === 'confirm') {
        changed = await tx.appointment.update({ where: { id: appointment.id }, data: { status: 'CONFIRMED', version: { increment: 1 } }, include: appointmentInclude });
        if (await this.writer.settleHold(tx, appointment.id)) changed = await tx.appointment.findUniqueOrThrow({ where: { id: appointment.id }, include: appointmentInclude });
      } else if (appointment && decision.action === 'cancel') {
        changed = await this.writer.cancel(tx, appointment.id, CANCELLED_BY_REPLY);
      }
      return { rowId: row.id, decision, appointment, changed };
    });
  }

  /** After commit: events, waitlist offers (own transactions), the localised reply. */
  private async finish(target: Target, applied: Applied, intent: InboundIntent): Promise<InboundResult> {
    const { decision, appointment, changed } = applied;
    let replyKey: InboundReplyKey = decision.reply;
    let action: InboundResult['action'] = 'none';

    if (changed && decision.action === 'confirm') {
      this.writer.emitUpdated(changed, target.patientId);
      action = 'confirmed';
    } else if (changed && decision.action === 'cancel') {
      this.writer.emitCancelled(changed, target.patientId);
      action = 'cancelled';
    } else if (decision.action === 'acceptOffer' || decision.action === 'declineOffer') {
      try {
        if (decision.action === 'acceptOffer') {
          await this.waitlist.accept(this.actor(target), decision.entryId);
          await this.confirmIfScheduled(target, (appointment as ReplyAppointment).id);
          action = 'confirmed';
        } else {
          await this.waitlist.decline(this.actor(target), decision.entryId);
          action = 'cancelled';
        }
      } catch (err) {
        this.logger.warn(`Waitlist ${decision.action} by message reply failed for entry ${decision.entryId}: ${(err as Error).message}`);
        // The reply did not act after all: release the claim so it is not counted as an action.
        await this.prisma.db.message.update({ where: { id: applied.rowId }, data: { appointmentId: null } });
        replyKey = 'contactClinic';
      }
    }

    const when = appointment ? formatWhen(appointment.startsAt, target.timeZone, target.locale) : '';
    return {
      reply: this.text(replyKey, target.locale, when),
      intent,
      messageId: applied.rowId,
      appointmentId: action === 'none' ? null : (appointment?.id ?? null),
      action,
    };
  }

  /** A held offer accepted with "1" also becomes CONFIRMED (the patient answered "confirm"). */
  private async confirmIfScheduled(target: Target, appointmentId: string) {
    const row = await this.prisma.transaction(async (tx) => {
      const r = await tx.appointment.updateMany({ where: { id: appointmentId, clinicId: target.clinicId, status: 'SCHEDULED' }, data: { status: 'CONFIRMED', version: { increment: 1 } } });
      return r.count === 1 ? tx.appointment.findUnique({ where: { id: appointmentId }, include: appointmentInclude }) : null;
    });
    if (row) this.writer.emitUpdated(row, target.patientId);
  }

  // ─────────────────────────────── resolution ───────────────────────────────

  /**
   * The latest outbound message with reply instructions to this phone (any
   * clinic, not FAILED, within `replyWindowDays`) and its appointment. Without
   * one, the matching patient (digits-only phone comparison) is resolved only to
   * record the reply in the right clinic and localise the answer: never to pick
   * some other appointment.
   */
  private async resolveTarget(phone: string, now: Date): Promise<Target | null> {
    const since = new Date(now.getTime() - this.config.replyWindowDays * DAY_MS);
    return tenantContext.runSystem(async () => {
      const outbound = await this.prisma.db.message.findFirst({
        where: { address: phone, direction: 'OUTBOUND', template: { in: [...REPLYABLE_TEMPLATES] }, appointmentId: { not: null }, status: { not: 'FAILED' }, createdAt: { gte: since } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, clinicId: true, appointmentId: true },
      });
      if (outbound?.appointmentId) {
        const appt = await this.prisma.db.appointment.findFirst({
          where: { id: outbound.appointmentId, clinicId: outbound.clinicId },
          select: { id: true, patientId: true, clinicId: true, patient: { select: { locale: true } }, clinic: { select: { timezone: true, settings: true } } },
        });
        if (appt) {
          return {
            clinicId: appt.clinicId,
            patientId: appt.patientId,
            locale: this.localeOf(appt.patient.locale, appt.clinic.settings),
            timeZone: appt.clinic.timezone || 'UTC',
            outboundId: outbound.id,
            appointmentId: appt.id,
          };
        }
      }

      const variants = phoneDigitVariants(phone, this.config.defaultCountryCode);
      const patients = await this.prisma.transaction((tx) => findPatientsByPhoneAnyClinic(tx, variants));
      if (patients.length === 0) return null;
      const patient = patients[0];
      return {
        clinicId: patient.clinicId,
        patientId: patient.id,
        locale: this.localeOf(patient.locale, patient.settings),
        timeZone: patient.timezone || 'UTC',
        outboundId: null,
        appointmentId: null,
      };
    });
  }

  private findInbound(providerMessageId: string) {
    return tenantContext.runSystem(() =>
      this.prisma.db.message.findFirst({ where: { providerMessageId, direction: 'INBOUND' }, orderBy: { createdAt: 'asc' }, select: { id: true, appointmentId: true } }),
    );
  }

  private duplicate(row: { id: string; appointmentId: string | null }, intent: InboundIntent, sid: string): InboundResult {
    this.logger.debug(`Duplicate inbound delivery ${sid} ignored`);
    return { reply: '', intent, messageId: row.id, appointmentId: row.appointmentId, action: 'none', duplicate: true };
  }

  /** Minimal staff-shaped actor so `WaitlistService` can be reused (only `id` and `clinicId` are read). */
  private actor(target: Target): AuthUser {
    return { id: target.patientId, email: '', clinicId: target.clinicId, role: 'RECEPTIONIST', permissions: new Set<string>() };
  }

  private localeOf(patientLocale: string | null, clinicSettings: unknown): Locale {
    const fallback = resolveLocale((clinicSettings as { defaultLocale?: string } | null)?.defaultLocale);
    return resolveLocale(patientLocale, fallback);
  }

  private text(key: InboundReplyKey, locale: Locale, when: string): string {
    return interpolate(INBOUND_REPLIES[key][locale], { when });
  }

  private bilingual(key: InboundReplyKey): string {
    return `${INBOUND_REPLIES[key].ar}\n${INBOUND_REPLIES[key].en}`;
  }
}
