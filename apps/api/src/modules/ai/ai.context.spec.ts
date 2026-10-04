import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { DisabledProvider } from './ai-provider.js';
import { createAiProvider } from './ai-provider.factory.js';
import {
  buildPatientContext,
  computeAgeYears,
  extractJson,
  hashContext,
  normalizeSoap,
  parseJsonObject,
  renderPatientContext,
} from './ai.context.js';

const NOW = new Date('2026-10-04T12:00:00Z');

describe('computeAgeYears', () => {
  it('counts completed years only', () => {
    expect(computeAgeYears('1990-10-05', NOW)).toBe(35);
    expect(computeAgeYears('1990-10-04', NOW)).toBe(36);
    expect(computeAgeYears(new Date('2026-01-01'), NOW)).toBe(0);
  });
  it('returns null for missing, invalid or future dates', () => {
    expect(computeAgeYears(null, NOW)).toBeNull();
    expect(computeAgeYears('not-a-date', NOW)).toBeNull();
    expect(computeAgeYears('2030-01-01', NOW)).toBeNull();
  });
});

describe('buildPatientContext / renderPatientContext', () => {
  // A full Prisma-like patient row: every identifier must be dropped.
  const patient = {
    id: 'p1',
    mrn: 'MRN-000042',
    firstName: 'Zelda',
    lastName: 'Quartermain',
    dateOfBirth: new Date('1980-03-15'),
    gender: 'FEMALE',
    phone: '+15550001111',
    email: 'zelda@example.com',
    address: '12 Hidden Lane',
    nationalIdEnc: 'enc:abc',
    bloodType: 'O+',
    emergencyContact: { name: 'Link', phone: '+15550002222' },
    notes: 'Prefers morning appointments',
  };

  it('keeps only clinical fields and never leaks identifiers', () => {
    const ctx = buildPatientContext({
      patient,
      allergies: [{ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'LIFE_THREATENING' }],
      prescriptions: [{ medication: 'Metformin', dosage: '500mg', frequency: 'BID', durationDays: 90, instructions: null }],
      encounters: [
        {
          occurredAt: new Date('2026-09-01T09:00:00Z'),
          chiefComplaint: 'Fatigue',
          assessment: 'Likely T2DM',
          plan: 'HbA1c, lifestyle',
          diagnoses: [{ code: 'E11.9', description: 'Type 2 diabetes mellitus', isPrimary: true }],
        },
      ],
      upcomingAppointment: { startsAt: new Date('2026-10-10T08:30:00Z'), reason: 'Follow-up', type: 'FOLLOW_UP' },
      now: NOW,
    });

    expect(ctx.ageYears).toBe(46);
    expect(ctx.gender).toBe('FEMALE');
    expect(ctx.allergies[0]).toEqual({ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'LIFE_THREATENING' });
    expect(ctx.recentVisits[0].date).toBe('2026-09-01');
    expect(ctx.upcomingVisit).toEqual({ date: '2026-10-10', reason: 'Follow-up', type: 'FOLLOW_UP' });

    const serialised = JSON.stringify(ctx) + renderPatientContext(ctx);
    for (const leak of ['Zelda', 'Quartermain', 'MRN-000042', '5550001111', 'zelda@example.com', 'Hidden Lane', 'enc:abc', 'Link', 'morning appointments', 'p1']) {
      expect(serialised).not.toContain(leak);
    }
    expect(renderPatientContext(ctx)).toContain('[SEVERE]');
    expect(renderPatientContext(ctx)).toContain('Age: 46 years');
    expect(renderPatientContext(ctx)).toContain('E11.9 Type 2 diabetes mellitus (primary)');
  });

  it('states explicitly when data is absent', () => {
    const text = renderPatientContext(buildPatientContext({ patient: { dateOfBirth: null, gender: null }, now: NOW }));
    expect(text).toContain('Age: unknown');
    expect(text).toContain('Gender: unknown');
    expect(text).toContain('No allergies recorded');
    expect(text).toContain('No active prescriptions recorded');
    expect(text).toContain('No previous visits recorded');
    expect(text).toContain('No upcoming appointment');
  });

  it('hashes deterministically', () => {
    const text = renderPatientContext(buildPatientContext({ patient: { dateOfBirth: '1980-03-15', gender: 'MALE' }, now: NOW }));
    expect(hashContext(text)).toBe(hashContext(text));
    expect(hashContext(text)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashContext(text)).not.toBe(hashContext(text + ' '));
  });
});

describe('JSON parsing', () => {
  it('strips code fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('tolerates surrounding prose', () => {
    expect(parseJsonObject('Here you go:\n{"subjective":"x"}\nHope that helps')).toEqual({ subjective: 'x' });
  });
  it('rejects non-objects', () => {
    expect(() => parseJsonObject('[1,2]')).toThrow(SyntaxError);
    expect(() => parseJsonObject('no json here')).toThrow(SyntaxError);
    expect(() => parseJsonObject('{"a":')).toThrow();
  });
  it('normalises SOAP output', () => {
    expect(normalizeSoap({ subjective: ' s ', objective: 42, plan: null })).toEqual({ subjective: 's', objective: '', assessment: '', plan: '' });
    expect(normalizeSoap(null)).toEqual({ subjective: '', objective: '', assessment: '', plan: '' });
  });
});

describe('createAiProvider', () => {
  it('falls back to the disabled provider without keys', async () => {
    const p = createAiProvider({ provider: 'none', claudeModel: 'claude-opus-5-5', geminiModel: 'gemini-2.5-pro' });
    expect(p).toBeInstanceOf(DisabledProvider);
    await expect(p.generateText({ system: '', prompt: '' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('builds the configured vendor', () => {
    expect(createAiProvider({ provider: 'claude', anthropicApiKey: 'k', claudeModel: 'claude-opus-5-5', geminiModel: 'g' })).toMatchObject({ name: 'claude', model: 'claude-opus-5-5' });
    expect(createAiProvider({ provider: 'gemini', geminiApiKey: 'k', claudeModel: 'c', geminiModel: 'gemini-2.5-pro' })).toMatchObject({ name: 'gemini', model: 'gemini-2.5-pro' });
    expect(createAiProvider({ provider: 'claude', claudeModel: 'c', geminiModel: 'g' })).toBeInstanceOf(DisabledProvider);
  });
});
