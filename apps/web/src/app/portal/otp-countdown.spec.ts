import { describe, expect, it } from 'vitest';
import { formatSeconds, isCompleteOtp, isValidPhone, normalizeDigits, normalizeOtp, normalizePhone, resendCountdown } from './otp-countdown';

describe('resendCountdown', () => {
  const sentAt = 1_000_000;
  it('allows resend immediately when nothing was sent', () => {
    expect(resendCountdown(null, sentAt)).toEqual({ remaining: 0, canResend: true, label: '0:00' });
  });
  it('counts 60 seconds down from the send time', () => {
    expect(resendCountdown(sentAt, sentAt)).toEqual({ remaining: 60, canResend: false, label: '1:00' });
    expect(resendCountdown(sentAt, sentAt + 51_000)).toEqual({ remaining: 9, canResend: false, label: '0:09' });
    expect(resendCountdown(sentAt, sentAt + 59_001).remaining).toBe(1);
  });
  it('unlocks resend exactly at the deadline and stays unlocked after', () => {
    expect(resendCountdown(sentAt, sentAt + 60_000)).toEqual({ remaining: 0, canResend: true, label: '0:00' });
    expect(resendCountdown(sentAt, sentAt + 120_000).canResend).toBe(true);
  });
  it('honours a custom window', () => {
    expect(resendCountdown(sentAt, sentAt + 10_000, 30).remaining).toBe(20);
  });
  it('formats seconds as m:ss', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(65)).toBe('1:05');
    expect(formatSeconds(-5)).toBe('0:00');
  });
});

describe('OTP / phone normalisation', () => {
  it('maps Arabic-Indic and Persian digits to ASCII', () => {
    expect(normalizeDigits('٠٥٠١١١١١١١')).toBe('0501111111');
    expect(normalizeDigits('۱۲۳')).toBe('123');
    expect(normalizeDigits('+966 50')).toBe('+966 50');
  });
  it('keeps only six digits for the code', () => {
    expect(normalizeOtp('12 34-56')).toBe('123456');
    expect(normalizeOtp('١٢٣٤٥٦٧')).toBe('123456');
    expect(isCompleteOtp('123456')).toBe(true);
    expect(isCompleteOtp('12345')).toBe(false);
    expect(isCompleteOtp('12345a')).toBe(false);
  });
  it('normalises phones and validates length', () => {
    expect(normalizePhone(' 050-111 1111 ')).toBe('0501111111');
    expect(normalizePhone('+966 (50) 111-1111')).toBe('+966501111111');
    expect(isValidPhone('0501111111')).toBe(true);
    expect(isValidPhone('+966501111111')).toBe(true);
    expect(isValidPhone('12345')).toBe(false);
    expect(isValidPhone('abc')).toBe(false);
  });
});
