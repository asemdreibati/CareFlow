import { describe, expect, it } from 'vitest';
import { channelOfAddress, foldDigits, normalizePhone, phoneDigitVariants, phoneVariants } from './phone.js';

describe('normalizePhone', () => {
  it('keeps E.164 numbers', () => {
    expect(normalizePhone('+966501234567')).toBe('+966501234567');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
  });

  it('assumes Saudi Arabia for local numbers', () => {
    expect(normalizePhone('0501234567')).toBe('+966501234567');
    expect(normalizePhone('050 123 4567')).toBe('+966501234567');
    expect(normalizePhone('050-123-4567')).toBe('+966501234567');
    expect(normalizePhone('501234567')).toBe('+966501234567');
    expect(normalizePhone('966501234567')).toBe('+966501234567');
    expect(normalizePhone('00966501234567')).toBe('+966501234567');
  });

  it('honours a different default country', () => {
    expect(normalizePhone('0501234567', '971')).toBe('+971501234567');
  });

  it('folds Arabic-Indic digits and strips the whatsapp prefix', () => {
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧')).toBe('+966501234567');
    expect(normalizePhone('whatsapp:+966501234567')).toBe('+966501234567');
    expect(foldDigits('۰۹')).toBe('09');
  });

  it('rejects garbage', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('+12345678901234567')).toBeNull();
  });
});

describe('phoneVariants', () => {
  it('lists the spellings a stored phone may have', () => {
    expect(phoneVariants('+966501234567').sort()).toEqual(['+966501234567', '00966501234567', '0501234567', '501234567', '966501234567'].sort());
  });
  it('has no national variants for foreign numbers', () => {
    expect(phoneVariants('+14155550100').sort()).toEqual(['+14155550100', '0014155550100', '14155550100'].sort());
  });
});

describe('channelOfAddress', () => {
  it('detects WhatsApp senders', () => {
    expect(channelOfAddress('whatsapp:+966501234567')).toBe('WHATSAPP');
    expect(channelOfAddress('+966501234567')).toBe('SMS');
  });
});

describe('phoneDigitVariants', () => {
  it('lists digits-only spellings (compared with the digits of the stored phone)', () => {
    expect(phoneDigitVariants('+966501234567').sort()).toEqual(['00966501234567', '0501234567', '501234567', '966501234567'].sort());
  });
  it('matches stored phones written with spaces, dashes, dots or parentheses', () => {
    const variants = phoneDigitVariants('+966501234567');
    for (const stored of ['+966 50 123 4567', '050-123-4567', '(050) 123 4567', '0096650.123.4567', '+966-50-1234567']) {
      expect(variants).toContain(stored.replace(/[^0-9]/g, ''));
    }
    expect(variants).not.toContain('+966501234567'.replace(/[^0-9]/g, '') + '1');
  });
});
