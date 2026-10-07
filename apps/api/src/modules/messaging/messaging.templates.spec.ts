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

describe('reply instructions and secrets', () => {
  it('every template listed as replyable carries the reply instructions (both languages)', async () => {
    const { REPLYABLE_TEMPLATES } = await import('./messaging.templates.js');
    expect(REPLYABLE_TEMPLATES).toEqual(expect.arrayContaining(['appointment.reminder', 'appointment.confirmed']));
    for (const key of REPLYABLE_TEMPLATES) {
      expect(renderTemplate(key, 'en', {}).body).toContain(REPLY_INSTRUCTIONS.en);
      expect(renderTemplate(key, 'ar', {}).body).toContain(REPLY_INSTRUCTIONS.ar);
    }
    // ...and no other template does, so a reply can only ever target one of those
    for (const key of TEMPLATE_KEYS.filter((k) => !REPLYABLE_TEMPLATES.includes(k))) {
      expect(renderTemplate(key, 'en', {}).body).not.toContain(REPLY_INSTRUCTIONS.en);
    }
  });

  it('splits the OTP code out of the params and masks it', async () => {
    const { splitSecretParams, SECRET_MASK, maskSecretsInBody } = await import('./messaging.templates.js');
    const { redacted, secrets } = splitSecretParams('portal.otp', { code: '004212', minutes: 5, clinicName: 'X' });
    expect(secrets).toEqual({ code: '004212' });
    for (const locale of ['ar', 'en'] as const) {
      const body = renderTemplate('portal.otp', locale, redacted).body;
      expect(body).toContain(SECRET_MASK);
      expect(body).not.toContain('004212');
    }
    expect(splitSecretParams('appointment.reminder', { when: 'x' }).secrets).toEqual({});
    expect(maskSecretsInBody('portal.otp', '004212 is your X login code. It expires in 5 minutes.')).toBe('****** is your X login code. It expires in 5 minutes.');
    expect(maskSecretsInBody('appointment.reminder', 'Room 1234')).toBe('Room 1234');
  });

  it('has every inbound reply in both languages', async () => {
    const { INBOUND_REPLIES } = await import('./messaging.templates.js');
    for (const key of ['contactClinic', 'tooLateToCancel', 'offerDeclined'] as const) {
      expect(INBOUND_REPLIES[key].en.length).toBeGreaterThan(10);
      expect(INBOUND_REPLIES[key].ar.length).toBeGreaterThan(10);
    }
    expect(interpolate(INBOUND_REPLIES.tooLateToCancel.en, { when: 'X' })).toContain('2 hours');
  });
});
