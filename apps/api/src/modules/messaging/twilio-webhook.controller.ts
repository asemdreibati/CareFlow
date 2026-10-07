import { Body, Controller, ForbiddenException, Header, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { MessageStatus } from '@prisma/client';
import type { Request } from 'express';
import { Audit, Public } from '../../common/auth/decorators.js';
import { InboundService } from './inbound.service.js';
import { insecureWebhooksAllowed, MESSAGING_CONFIG, type MessagingConfig } from './messaging.config.js';
import type { TwilioInboundBody, TwilioStatusBody } from './messaging.dto.js';
import { MessagingService } from './messaging.service.js';
import { verifyTwilioSignature } from './providers/twilio.provider.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Twilio delivery statuses → message statuses (others are ignored). */
export function mapTwilioStatus(status: string | undefined): MessageStatus | null {
  switch ((status ?? '').toLowerCase()) {
    case 'sent':
      return 'SENT';
    case 'delivered':
    case 'read':
      return 'DELIVERED';
    case 'failed':
    case 'undelivered':
      return 'FAILED';
    default:
      return null;
  }
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);
}

export function twiml(message?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${escapeXml(message)}</Message>` : ''}</Response>`;
}

/**
 * Twilio webhooks (public). Requests are authenticated with Twilio's request
 * signature (HMAC-SHA1 over the public URL + sorted form params, keyed with
 * `TWILIO_AUTH_TOKEN`). Without a token every webhook is rejected (403), unless
 * the developer explicitly opts in with `TWILIO_WEBHOOK_INSECURE=1` (never
 * honoured when `NODE_ENV=production`): then unsigned loopback callers are
 * accepted so a local tunnel/curl can still exercise the flow.
 */
@ApiExcludeController()
@Controller('webhooks/twilio')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly inbound: InboundService,
    private readonly messaging: MessagingService,
    @Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig,
  ) {}

  /** Patient reply (SMS or WhatsApp). Responds with TwiML carrying the acknowledgement. */
  @Public()
  @Post('inbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  @Audit({ action: 'messaging.inbound' })
  async inboundMessage(@Req() req: Request, @Body() body: TwilioInboundBody): Promise<string> {
    this.assertSignature(req, body);
    const from = typeof body.From === 'string' ? body.From : '';
    const text = typeof body.Body === 'string' ? body.Body : '';
    const sid = typeof body.MessageSid === 'string' ? body.MessageSid : typeof body.SmsMessageSid === 'string' ? body.SmsMessageSid : null;
    if (!from) return twiml();
    const result = await this.inbound.handle({ from, body: text, providerMessageId: sid });
    // Duplicates (Twilio retries) get an empty TwiML: the patient is not messaged twice.
    return twiml(result.reply || undefined);
  }

  /** Delivery status callback. */
  @Public()
  @Post('status')
  @HttpCode(204)
  @Audit({ action: 'messaging.status' })
  async status(@Req() req: Request, @Body() body: TwilioStatusBody): Promise<void> {
    this.assertSignature(req, body);
    const sid = typeof body.MessageSid === 'string' ? body.MessageSid : typeof body.SmsSid === 'string' ? body.SmsSid : '';
    const status = mapTwilioStatus(typeof body.MessageStatus === 'string' ? body.MessageStatus : typeof body.SmsStatus === 'string' ? body.SmsStatus : undefined);
    if (!sid || !status) return;
    const error = status === 'FAILED' ? `Twilio ${body.ErrorCode ?? ''} ${body.ErrorMessage ?? ''}`.trim() : undefined;
    const n = await this.messaging.updateDeliveryStatus(sid, status, error);
    if (n === 0) this.logger.debug(`Status callback for unknown message ${sid} (${status})`);
  }

  private assertSignature(req: Request, body: Record<string, unknown>) {
    const token = this.config.twilio.authToken;
    if (!token) {
      // Both the boot-time flag and the live environment must agree (NODE_ENV=production always wins).
      const insecure = this.config.twilio.insecureWebhooks && insecureWebhooksAllowed();
      const loopback = LOOPBACK.has(req.socket?.remoteAddress ?? '') && (req.ip === undefined || LOOPBACK.has(req.ip));
      if (insecure && loopback) return;
      throw new ForbiddenException('Twilio webhooks are disabled until TWILIO_AUTH_TOKEN is configured');
    }
    const url = `${this.config.publicApiUrl}${req.originalUrl}`;
    const header = req.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifyTwilioSignature(token, url, body ?? {}, signature)) {
      this.logger.warn(`Rejected webhook with an invalid Twilio signature for ${req.originalUrl}`);
      throw new ForbiddenException('Invalid Twilio signature');
    }
  }
}
