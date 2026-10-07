import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundService } from './inbound.service.js';
import { insecureWebhooksAllowed, loadMessagingConfig, type MessagingConfig } from './messaging.config.js';
import type { MessagingService } from './messaging.service.js';
import { TwilioWebhookController } from './twilio-webhook.controller.js';

function controller(config: MessagingConfig) {
  const inbound = { handle: vi.fn(async () => ({ reply: 'ok', intent: 'CONFIRM', messageId: 'm', appointmentId: null, action: 'none' })) };
  return { ctrl: new TwilioWebhookController(inbound as unknown as InboundService, {} as MessagingService, config), inbound };
}

const loopbackReq = { ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, headers: {}, originalUrl: '/api/v1/webhooks/twilio/inbound' } as unknown as Request;
const remoteReq = { ip: '203.0.113.9', socket: { remoteAddress: '203.0.113.9' }, headers: {}, originalUrl: '/api/v1/webhooks/twilio/inbound' } as unknown as Request;
const body = { From: '+966501234567', Body: '1', MessageSid: 'SM1' };

describe('Twilio webhook without TWILIO_AUTH_TOKEN', () => {
  const saved = { token: process.env.TWILIO_AUTH_TOKEN, insecure: process.env.TWILIO_WEBHOOK_INSECURE, env: process.env.NODE_ENV };
  afterEach(() => {
    process.env.TWILIO_AUTH_TOKEN = saved.token;
    process.env.TWILIO_WEBHOOK_INSECURE = saved.insecure;
    process.env.NODE_ENV = saved.env;
  });

  function configWith(insecure: string | undefined, nodeEnv: string) {
    process.env.TWILIO_AUTH_TOKEN = '';
    if (insecure === undefined) delete process.env.TWILIO_WEBHOOK_INSECURE;
    else process.env.TWILIO_WEBHOOK_INSECURE = insecure;
    process.env.NODE_ENV = nodeEnv;
    return loadMessagingConfig();
  }

  it('rejects unsigned loopback requests unless TWILIO_WEBHOOK_INSECURE=1 (was: accepted by default)', async () => {
    const { ctrl, inbound } = controller(configWith(undefined, 'development'));
    await expect(ctrl.inboundMessage(loopbackReq, body)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.status(loopbackReq, { MessageSid: 'SM1', MessageStatus: 'delivered' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(inbound.handle).not.toHaveBeenCalled();
  });

  it('accepts unsigned loopback requests with the explicit opt-in (development only), never remote ones', async () => {
    const { ctrl, inbound } = controller(configWith('1', 'development'));
    await expect(ctrl.inboundMessage(loopbackReq, body)).resolves.toContain('<Message>ok</Message>');
    expect(inbound.handle).toHaveBeenCalledTimes(1);
    await expect(ctrl.inboundMessage(remoteReq, body)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never allows the insecure mode in production', async () => {
    const config = configWith('1', 'production');
    expect(config.twilio.insecureWebhooks).toBe(false);
    const { ctrl } = controller(config);
    await expect(ctrl.inboundMessage(loopbackReq, body)).rejects.toBeInstanceOf(ForbiddenException);

    // Even a config loaded earlier is overridden by the live NODE_ENV
    const { ctrl: early } = controller(configWith('1', 'development'));
    process.env.NODE_ENV = 'production';
    await expect(early.inboundMessage(loopbackReq, body)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('insecureWebhooksAllowed requires exactly "1" outside production', () => {
    expect(insecureWebhooksAllowed({ TWILIO_WEBHOOK_INSECURE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(insecureWebhooksAllowed({ TWILIO_WEBHOOK_INSECURE: 'true', NODE_ENV: 'development' })).toBe(false);
    expect(insecureWebhooksAllowed({ TWILIO_WEBHOOK_INSECURE: '1', NODE_ENV: 'production' })).toBe(false);
    expect(insecureWebhooksAllowed({ NODE_ENV: 'development' })).toBe(false);
  });

  it('a duplicate delivery (empty reply) answers with an empty TwiML response', async () => {
    const { ctrl, inbound } = controller(configWith('1', 'development'));
    inbound.handle.mockResolvedValueOnce({ reply: '', intent: 'CONFIRM', messageId: 'm', appointmentId: null, action: 'none' });
    await expect(ctrl.inboundMessage(loopbackReq, body)).resolves.toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
