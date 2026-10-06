import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Message, MessageChannel, MessageStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { paginate } from '../../common/dto/pagination.dto.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { MESSAGING_CONFIG, type MessagingConfig } from './messaging.config.js';
import type { ListMessagesQuery, SendMessageDto } from './messaging.dto.js';
import { renderTemplate, resolveLocale, type Locale, type TemplateKey, type TemplateParams } from './messaging.templates.js';
import { normalizePhone } from './phone.js';
import { EMAIL_PROVIDER, SMS_PROVIDER, WHATSAPP_PROVIDER, type EmailProvider, type ProviderResult, type SmsProvider, type WhatsAppProvider } from './providers/provider.js';

export interface SendInput {
  clinicId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  channel: MessageChannel;
  /** Phone (any common spelling, normalised to E.164) or email address. */
  to: string;
  template: TemplateKey;
  locale: Locale;
  params?: TemplateParams;
}

export interface SendRawInput {
  clinicId: string;
  patientId?: string | null;
  appointmentId?: string | null;
  channel: MessageChannel;
  to: string;
  body: string;
  /** Email subject (ignored for SMS / WhatsApp). */
  subject?: string;
  /** Template key recorded on the row when the body came from a template. */
  template?: string | null;
}

export interface InboundInput {
  clinicId: string;
  patientId: string | null;
  appointmentId: string | null;
  channel: MessageChannel;
  address: string;
  body: string;
  provider: string;
  providerMessageId: string | null;
  inReplyToId: string | null;
  intent: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 4000;

/**
 * Runs `fn` with RLS scoped to `clinicId` even when called outside a request
 * for that clinic (public OTP endpoint, reminder worker, webhooks).
 */
export function withClinic<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
  const ctx = tenantContext.get();
  if (ctx?.clinicId === clinicId) return fn();
  return tenantContext.run({ requestId: ctx?.requestId ?? 'messaging', clinicId, ip: ctx?.ip, userAgent: ctx?.userAgent }, async () => await fn());
}

/**
 * Outbound patient communications over SMS / WhatsApp / email. Every send is
 * persisted as a `messages` row (QUEUED → SENT or FAILED with the provider's
 * id or error); failures never throw, callers inspect `status` when they care
 * (the reminders worker does, so a failed reminder is retried).
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  /** Renders a bilingual template and sends it (see `sendRaw`). */
  send(input: SendInput): Promise<Message> {
    const rendered = renderTemplate(input.template, resolveLocale(input.locale), input.params ?? {});
    return this.sendRaw({
      clinicId: input.clinicId,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      channel: input.channel,
      to: input.to,
      body: rendered.body,
      subject: rendered.subject,
      template: input.template,
    });
  }

  /** Sends a literal body. The address is validated/normalised first; an unusable address yields a FAILED row. */
  async sendRaw(input: SendRawInput): Promise<Message> {
    const address = this.normalizeAddress(input.channel, input.to);
    const body = input.body.slice(0, MAX_BODY);
    const base: Prisma.MessageUncheckedCreateInput = {
      clinicId: input.clinicId,
      patientId: input.patientId ?? null,
      appointmentId: input.appointmentId ?? null,
      channel: input.channel,
      direction: 'OUTBOUND',
      address: address ?? input.to.trim().slice(0, 200),
      body,
      template: input.template ?? null,
      status: 'QUEUED',
    };

    if (!address) {
      return withClinic(input.clinicId, () =>
        this.prisma.db.message.create({ data: { ...base, status: 'FAILED', error: `Invalid ${input.channel === 'EMAIL' ? 'email address' : 'phone number'}` } }),
      );
    }

    const queued = await withClinic(input.clinicId, () => this.prisma.db.message.create({ data: base }));
    let result: ProviderResult | undefined;
    let error: string | undefined;
    try {
      result = await this.dispatch(input.channel, address, input.subject ?? '', body);
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      this.logger.warn(`${input.channel} to ${address} failed: ${error}`);
    }
    return withClinic(input.clinicId, () =>
      this.prisma.db.message.update({
        where: { id: queued.id },
        data: result
          ? { status: 'SENT', sentAt: new Date(), provider: result.provider, providerMessageId: result.providerMessageId, error: null }
          : { status: 'FAILED', error: error ?? 'Unknown delivery error' },
      }),
    );
  }

  /** Persists an inbound message (patient reply) in the clinic it belongs to. */
  recordInbound(input: InboundInput): Promise<Message> {
    return withClinic(input.clinicId, () =>
      this.prisma.db.message.create({
        data: {
          clinicId: input.clinicId,
          patientId: input.patientId,
          appointmentId: input.appointmentId,
          channel: input.channel,
          direction: 'INBOUND',
          address: input.address,
          body: input.body.slice(0, MAX_BODY),
          status: 'RECEIVED',
          provider: input.provider,
          providerMessageId: input.providerMessageId,
          inReplyToId: input.inReplyToId,
          intent: input.intent,
        },
      }),
    );
  }

  /** Latest outbound message to `address` of the given template that is linked to an appointment (any clinic; system context). */
  latestOutboundTo(address: string, template: string): Promise<Message | null> {
    return tenantContext.runSystem(() =>
      this.prisma.db.message.findFirst({
        where: { address, direction: 'OUTBOUND', template, appointmentId: { not: null } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Provider status callback → message status. Returns the number of rows touched. */
  async updateDeliveryStatus(providerMessageId: string, status: MessageStatus, error?: string): Promise<number> {
    if (!providerMessageId) return 0;
    const r = await tenantContext.runSystem(() =>
      this.prisma.db.message.updateMany({
        where: {
          providerMessageId,
          direction: 'OUTBOUND',
          // Never downgrade: "sent" only replaces QUEUED, DELIVERED/FAILED replace QUEUED or SENT.
          status: status === 'SENT' ? 'QUEUED' : { in: ['QUEUED', 'SENT'] },
        },
        data: { status, ...(error ? { error } : {}), ...(status === 'SENT' ? { sentAt: new Date() } : {}) },
      }),
    );
    return r.count;
  }

  // ─────────────────────────────── staff API ───────────────────────────────

  async list(user: AuthUser, q: ListMessagesQuery) {
    const where: Prisma.MessageWhereInput = {
      clinicId: user.clinicId,
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.direction ? { direction: q.direction } : {}),
      ...(q.appointmentId ? { appointmentId: q.appointmentId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.message.findMany({ where, skip: q.skip, take: q.pageSize, orderBy: { createdAt: 'desc' } }),
      this.prisma.db.message.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  /** Staff sends a free-text message to a patient's phone or email. */
  async sendManual(user: AuthUser, dto: SendMessageDto): Promise<Message> {
    const patient = await this.prisma.db.patient.findFirst({
      where: { id: dto.patientId, clinicId: user.clinicId },
      select: { id: true, phone: true, email: true, isActive: true },
    });
    if (!patient) throw new NotFoundException('Patient not found');
    if (!patient.isActive) throw new BadRequestException('Patient is not active');
    const to = dto.channel === 'EMAIL' ? patient.email : patient.phone;
    if (!to) throw new BadRequestException(dto.channel === 'EMAIL' ? 'Patient has no email address' : 'Patient has no phone number');
    return this.sendRaw({
      clinicId: user.clinicId,
      patientId: patient.id,
      appointmentId: dto.appointmentId ?? null,
      channel: dto.channel,
      to,
      body: dto.body,
      subject: dto.subject ?? 'Message from your clinic',
    });
  }

  // ─────────────────────────────── internals ───────────────────────────────

  normalizeAddress(channel: MessageChannel, to: string): string | null {
    if (channel === 'EMAIL') {
      const email = to.trim().toLowerCase();
      return EMAIL_RE.test(email) ? email : null;
    }
    return normalizePhone(to, this.config.defaultCountryCode);
  }

  private dispatch(channel: MessageChannel, address: string, subject: string, body: string): Promise<ProviderResult> {
    switch (channel) {
      case 'SMS':
        return this.sms.sendSms(address, body);
      case 'WHATSAPP':
        return this.whatsapp.sendWhatsApp(address, body);
      case 'EMAIL':
        return this.email.sendEmail(address, subject, body);
      default:
        return Promise.reject(new Error(`Unsupported channel ${String(channel)}`));
    }
  }
}
