import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogProvider } from './log.provider.js';

describe('LogProvider', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    LogProvider.clear();
    vi.restoreAllMocks();
  });

  it('never keeps or logs a body that carries secrets; the test hook returns the code under NODE_ENV=test only', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const provider = new LogProvider();
    await provider.sendSms('+966500000001', '123456 is your code', { template: 'portal.otp', redactedBody: '****** is your code', secrets: { code: '123456' } });

    expect(LogProvider.latest('+966500000001')?.body).toBe('****** is your code');
    expect(LogProvider.sent.some((m) => m.body.includes('123456'))).toBe(false);
    expect(log.mock.calls.flat().join(' ')).not.toContain('123456');
    expect(LogProvider.lastOtpForTests('+966500000001')).toBe('123456');

    process.env.NODE_ENV = 'production';
    expect(LogProvider.lastOtpForTests('+966500000001')).toBeUndefined();
    await provider.sendSms('+966500000002', '654321 is your code', { redactedBody: '****** is your code', secrets: { code: '654321' } });
    process.env.NODE_ENV = 'test';
    // Not recorded while the hook was disabled
    expect(LogProvider.lastOtpForTests('+966500000002')).toBeUndefined();
  });

  it('masks everything when secrets come without a redacted body', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LogProvider().sendSms('+966500000003', '111111', { secrets: { code: '111111' } });
    expect(LogProvider.latest('+966500000003')?.body).toBe('[redacted]');
  });

  it('keeps ordinary messages verbatim', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LogProvider().sendSms('+966500000004', 'Reminder 1234');
    expect(LogProvider.latest('+966500000004')?.body).toBe('Reminder 1234');
  });
});
