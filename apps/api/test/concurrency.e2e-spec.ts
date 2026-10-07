import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { AI_PROVIDER_TOKEN, type AiProvider, type GenerateJsonInput, type GenerateTextInput } from '../src/modules/ai/ai-provider.js';

class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  async generateText(_input: GenerateTextInput) {
    return { text: 'x', inputTokens: 1, outputTokens: 1 };
  }
  async generateJson<T>(_input: GenerateJsonInput) {
    return { data: { subjective: 'AI-S', objective: 'AI-O', assessment: 'AI-A', plan: 'AI-P' } as unknown as T, inputTokens: 1, outputTokens: 1 };
  }
}

/**
 * Races the reviewer reproduced: every state check must be part of the write
 * (compare-and-set / row lock), and sequential numbers must survive concurrent creates.
 */
describe('Concurrency guards (e2e)', () => {
  let app: INestApplication<App>;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const pw = 'Password1234';
  let tok: string;
  let patientId: string;
  const ROUNDS = 8;

  const api = () => request(app.getHttpServer());
  const A = () => ({ Authorization: `Bearer ${tok}` });
  const newInvoice = async (unitPrice = 100) =>
    (await api().post('/api/v1/billing/invoices').set(A()).send({ patientId, items: [{ description: 'Visit', quantity: 1, unitPrice }] }).expect(201)).body.id as string;
  const newDraftEncounter = async () =>
    (await api().post(`/api/v1/patients/${patientId}/encounters`).set(A()).send({ chiefComplaint: 'c', subjective: 'human' }).expect(201)).body.id as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER_TOKEN).useValue(new FakeProvider()).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    const email = `r-${stamp}@race.test`;
    const reg = await api().post('/api/v1/auth/register').send({ clinicName: 'Race', slug: `race-${stamp}`, email, password: pw, firstName: 'R', lastName: 'R' }).expect(201);
    tok = reg.body.tokens.accessToken;
    await api().post('/api/v1/doctors').set(A()).send({ firstName: 'R', lastName: 'R', specialty: 'GP', userId: reg.body.session.user.id }).expect(201);
    tok = (await api().post('/api/v1/auth/login').send({ email, password: pw }).expect(200)).body.tokens.accessToken;
    patientId = (await api().post('/api/v1/patients').set(A()).send({ firstName: 'P', lastName: 'Q' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────── numbering ───────────────────────────────

  it('8 concurrent invoice creates all succeed with distinct sequential numbers', async () => {
    const res = await Promise.all(
      Array.from({ length: 8 }, () => api().post('/api/v1/billing/invoices').set(A()).send({ patientId, items: [{ description: 'v', quantity: 1, unitPrice: 10 }] })),
    );
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(201));
    const seqs = res.map((r) => Number(String(r.body.number).split('-')[2])).sort((a, b) => a - b);
    expect(new Set(res.map((r) => r.body.number)).size).toBe(8);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('8 concurrent patient creates all succeed with distinct MRNs', async () => {
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => api().post('/api/v1/patients').set(A()).send({ firstName: `C${i}`, lastName: 'Z' })));
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(res.map((r) => r.body.mrn)).size).toBe(8);
    // The fixture patient holds MRN-000001.
    expect(res.map((r) => r.body.mrn).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `MRN-${String(i + 2).padStart(6, '0')}`));
  });

  // ──────────────────────────────── invoices ────────────────────────────────

  it('void refuses a partially paid invoice', async () => {
    const inv = await newInvoice();
    await api().post(`/api/v1/billing/invoices/${inv}/issue`).set(A()).expect(200);
    await api().post(`/api/v1/billing/invoices/${inv}/payments`).set(A()).send({ amount: 60, method: 'CASH' }).expect(201);
    const res = await api().post(`/api/v1/billing/invoices/${inv}/void`).set(A()).expect(409);
    expect(res.body.message).toMatch(/PARTIALLY_PAID/);
    const after = (await api().get(`/api/v1/billing/invoices/${inv}`).set(A()).expect(200)).body;
    expect(after).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: 60 });
  });

  it('void racing the final payment never leaves a paid invoice VOID', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await newInvoice();
      await api().post(`/api/v1/billing/invoices/${inv}/issue`).set(A()).expect(200);
      const [pay, vd] = await Promise.all([
        api().post(`/api/v1/billing/invoices/${inv}/payments`).set(A()).send({ amount: 100, method: 'CASH' }),
        api().post(`/api/v1/billing/invoices/${inv}/void`).set(A()),
      ]);
      const final = (await api().get(`/api/v1/billing/invoices/${inv}`).set(A()).expect(200)).body;
      // Exactly one of them wins; the loser gets 409.
      expect([pay.status === 201, vd.status === 200].filter(Boolean)).toHaveLength(1);
      expect(pay.status === 201 ? vd.status : pay.status).toBe(409);
      if (final.status === 'VOID') {
        expect(final.amountPaid).toBe(0);
        expect(final.payments).toHaveLength(0);
      } else {
        expect(final).toMatchObject({ status: 'PAID', amountPaid: 100 });
      }
    }
  });

  it('editing a draft racing its issue never changes an issued invoice', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await newInvoice(100);
      const [patch, issue] = await Promise.all([
        api().patch(`/api/v1/billing/invoices/${inv}`).set(A()).send({ items: [{ description: 'w', quantity: 1, unitPrice: 5 }] }),
        api().post(`/api/v1/billing/invoices/${inv}/issue`).set(A()),
      ]);
      expect(issue.status).toBe(200);
      expect([200, 409]).toContain(patch.status);
      const final = (await api().get(`/api/v1/billing/invoices/${inv}`).set(A()).expect(200)).body;
      expect(final.status).toBe('ISSUED');
      // What the issue response showed is what was issued.
      expect(final.total).toBe(issue.body.total);
      expect(final.items.map((it: { description: string }) => it.description)).toEqual(issue.body.items.map((it: { description: string }) => it.description));
      expect(final.total).toBe(patch.status === 200 ? 5 : 100);
    }
  });

  it('issue is compare-and-set: two concurrent issues give one 200 and one 409', async () => {
    const inv = await newInvoice();
    const res = await Promise.all([1, 2].map(() => api().post(`/api/v1/billing/invoices/${inv}/issue`).set(A())));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  // ─────────────────────────────── encounters / AI ───────────────────────────────

  it('an approved AI note can be applied only once', async () => {
    const enc = await newDraftEncounter();
    const ia = (await api().post(`/api/v1/ai/encounters/${enc}/soap-note`).set(A()).send({ transcript: 'x'.repeat(30) }).expect(201)).body.id;
    const res = await Promise.all([1, 2].map(() => api().post(`/api/v1/ai/interactions/${ia}/review`).set(A()).send({ decision: 'APPROVED', applyToEncounter: true })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('applying an AI note racing the signature never writes into a signed note', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const enc = await newDraftEncounter();
      const ia = (await api().post(`/api/v1/ai/encounters/${enc}/soap-note`).set(A()).send({ transcript: 'x'.repeat(30) }).expect(201)).body.id;
      const [review, sign] = await Promise.all([
        api().post(`/api/v1/ai/interactions/${ia}/review`).set(A()).send({ decision: 'APPROVED', applyToEncounter: true }),
        api().post(`/api/v1/encounters/${enc}/sign`).set(A()),
      ]);
      expect(sign.status).toBe(200);
      const final = (await api().get(`/api/v1/encounters/${enc}`).set(A()).expect(200)).body;
      expect(final.status).toBe('SIGNED');
      // The signed content is exactly what the signature response showed.
      expect(final.subjective).toBe(sign.body.subjective);
      const interaction = (await api().get('/api/v1/ai/interactions').query({ feature: 'SOAP_NOTE', patientId }).set(A()).expect(200)).body.find((r: { id: string }) => r.id === ia);
      if (review.status === 200) {
        expect(final.subjective).toBe('AI-S');
        expect(interaction.status).toBe('APPROVED');
      } else {
        expect(review.status).toBe(409);
        expect(final.subjective).toBe('human');
        expect(interaction.status).toBe('GENERATED'); // the claim was rolled back
      }
    }
  });

  it('a draft edit or diagnosis racing the signature is either included or rejected', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const enc = await newDraftEncounter();
      const [patch, dx, sign] = await Promise.all([
        api().patch(`/api/v1/encounters/${enc}`).set(A()).send({ assessment: 'patched' }),
        api().post(`/api/v1/encounters/${enc}/diagnoses`).set(A()).send({ code: 'R51', description: 'Headache' }),
        api().post(`/api/v1/encounters/${enc}/sign`).set(A()),
      ]);
      expect(sign.status).toBe(200);
      const final = (await api().get(`/api/v1/encounters/${enc}`).set(A()).expect(200)).body;
      // Either landed on the draft before the signature (and is in the signed note), or was rejected:
      // an edit after the signature would have turned the note into AMENDED.
      expect(final.status).toBe('SIGNED');
      expect([200, 409]).toContain(patch.status);
      expect([201, 409]).toContain(dx.status);
      expect(final.assessment).toBe(patch.status === 200 ? 'patched' : null);
      expect(final.diagnoses).toHaveLength(dx.status === 201 ? 1 : 0);
      expect(sign.body.assessment).toBe(final.assessment);
    }
  });

  it('two concurrent signatures give one 200 and one 409', async () => {
    const enc = await newDraftEncounter();
    const res = await Promise.all([1, 2].map(() => api().post(`/api/v1/encounters/${enc}/sign`).set(A())));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});
