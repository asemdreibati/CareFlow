import { describe, expect, it } from 'vitest';
import { formatWhen, interpolate, isTemplateKey, renderTemplate, REPLY_INSTRUCTIONS, resolveLocale, TEMPLATE_KEYS } from './messaging.templates.js';

describe('templates', () => {
  it('renders every template in both languages without leftover placeholders', () => {
    const params = { patientName: 'Sara', doctorName: 'Dr. Ali', when: '5 Oct 2026, 10:00', clinicName: 'Demo', code: '123456', minutes: 5, number: 'INV-1', total: '150.00', currency: 'SAR', expires: 'tomorrow' };
    for (const key of TEMPLATE_KEYS) {
      for (const locale of ['ar', 'en'] as const) {
        const r = renderTemplate(key, locale, params);
        expect(r.subject.length).toBeGreaterThan(0);
        expect(r.body.length).toBeGreaterThan(0);
        expect(r.body).not.toMatch(/\{\{/);
        expect(r.subject).not.toMatch(/\{\{/);
      }
    }
  });

  it('includes the reply instructions in reminders', () => {
    expect(renderTemplate('appointment.reminder', 'en', {}).body).toContain(REPLY_INSTRUCTIONS.en);
    expect(renderTemplate('appointment.reminder', 'ar', {}).body).toContain('1');
    expect(renderTemplate('appointment.reminder', 'ar', {}).body).toContain('2');
    expect(renderTemplate('appointment.reminder', 'ar', {}).body).toContain(REPLY_INSTRUCTIONS.ar);
  });

  it('interpolates params and blanks unknown ones', () => {
    expect(interpolate('Hi {{name}} {{ missing }}!', { name: 'Sam' })).toBe('Hi Sam !');
    expect(renderTemplate('portal.otp', 'en', { code: '004212', minutes: 5, clinicName: 'X' }).body).toContain('004212');
    expect(renderTemplate('portal.otp', 'ar', { code: '004212', minutes: 5, clinicName: 'X' }).body).toContain('004212');
  });

  it('resolves locales with an Arabic default', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('ar')).toBe('ar');
    expect(resolveLocale(null)).toBe('ar');
    expect(resolveLocale('fr', 'en')).toBe('en');
    expect(isTemplateKey('portal.otp')).toBe(true);
    expect(isTemplateKey('nope')).toBe(false);
  });

  it('formats dates in the clinic timezone with Latin digits', () => {
    const d = new Date('2026-10-05T07:00:00.000Z');
    expect(formatWhen(d, 'Asia/Riyadh', 'en')).toContain('10:00');
    const ar = formatWhen(d, 'Asia/Riyadh', 'ar');
    expect(ar).toMatch(/10:00/);
    expect(ar).not.toMatch(/[٠-٩]/);
  });
});
