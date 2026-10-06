import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { AI_PROVIDER_TOKEN, type AiProvider, type GenerateJsonInput, type GenerateTextInput } from '../src/modules/ai/ai-provider.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDER_TOKEN, type EmbeddingProvider, type EmbeddingTaskType } from '../src/modules/ai/embedding-provider.js';

/** Records prompts so the test can assert de-identification; answers always cite [E1]. */
class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-llm';
  textCalls: GenerateTextInput[] = [];

  async generateText(input: GenerateTextInput) {
    this.textCalls.push(input);
    return { text: 'The patient was seen for recurrent migraine headaches and prophylaxis was started [E1].', inputTokens: 90, outputTokens: 25 };
  }

  generateJson<T>(_input: GenerateJsonInput): Promise<{ data: T }> {
    return Promise.reject(new Error('not used'));
  }
}

/** Deterministic 768-d vectors derived from the text hash (same text → same vector). */
class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake-embeddings';
  readonly model = 'fake-embed-1';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  calls: { texts: string[]; taskType: EmbeddingTaskType }[] = [];

  async embed(texts: string[], taskType: EmbeddingTaskType) {
    this.calls.push({ texts, taskType });
    return texts.map((t) => {
      const out: number[] = [];
      let seed = createHash('sha256').update(t).digest();
      while (out.length < this.dimensions) {
        for (const b of seed) {
          if (out.length >= this.dimensions) break;
          out.push(b / 255 - 0.5);
        }
        seed = createHash('sha256').update(seed).digest();
      }
      return out;
    });
  }
}

/**
 * Arabic/Latin-aware search on a freshly registered clinic (never touches seeded
 * data): trigram patient search, global search, full-text records search, ICD
 * autocomplete, cross-clinic isolation, embeddings backfill and ask-the-record.
 */
describe('Search & ask-the-record (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const ai = new FakeAiProvider();
  const embeddings = new FakeEmbeddingProvider();
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const slug = `srch-${suffix}`;
  const email = `owner-${slug}@test.local`;
  const password = 'Password123';

  let token: string;
  let tokenB: string;
  let clinicId: string;
  let doctorId: string;
  let arabicId: string;
  let latinId: string;
  let samiId: string;
  let encounterId: string;
  let appointmentId: string;
  const invoiceNumber = `INV-SRCH-${suffix}`;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const register = async (s: string, first: string) => {
    const res = await http
      .post('/api/v1/auth/register')
      .send({ clinicName: `Search Clinic ${s}`, slug: s, email: `owner-${s}@test.local`, password, firstName: first, lastName: 'Owner' })
      .expect(201);
    return res.body as { tokens: { accessToken: string }; session: { user: { id: string }; clinic: { id: string } } };
  };

  const embeddingRow = () =>
    tenantContext.runSystem(() =>
      prisma.transaction((tx) =>
        tx.$queryRaw<{ model: string; contentHash: string; dims: number }[]>`
          SELECT model, content_hash AS "contentHash", vector_dims(embedding)::int AS dims
          FROM encounter_embeddings WHERE encounter_id = ${encounterId}::uuid`,
      ),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_PROVIDER_TOKEN)
      .useValue(ai)
      .overrideProvider(EMBEDDING_PROVIDER_TOKEN)
      .useValue(embeddings)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);

    const reg = await register(slug, 'Olive');
    clinicId = reg.session.clinic.id;
    // Link a doctor profile to the owner so they can author and sign encounters.
    const doc = await http
      .post('/api/v1/doctors')
      .set(auth(reg.tokens.accessToken))
      .send({ firstName: 'Olive', lastName: 'Owner', specialty: 'Neurology', userId: reg.session.user.id })
      .expect(201);
    doctorId = doc.body.id;
    const login = await http.post('/api/v1/auth/login').send({ email, password }).expect(200);
    token = login.body.tokens.accessToken;

    tokenB = (await register(`${slug}-b`, 'Bea')).tokens.accessToken;

    const create = async (body: Record<string, unknown>) => (await http.post('/api/v1/patients').set(auth(token)).send(body).expect(201)).body.id as string;
    arabicId = await create({ firstName: 'مُحَمَّد', lastName: 'الأحمد', phone: '0559876543' });
    latinId = await create({ firstName: 'Mohammed', lastName: 'Al-Ahmad', phone: '0551112222' });
    samiId = await create({ firstName: 'Sami', lastName: 'Haddad', phone: '0501234567', email: 'sami@example.com' });

    const enc = await http
      .post(`/api/v1/patients/${samiId}/encounters`)
      .set(auth(token))
      .send({
        chiefComplaint: 'صداع نصفي متكرر',
        subjective: 'Recurrent migraine headaches for two weeks, worse with bright light. يشكو من غثيان مصاحب.',
        objective: 'Neurological exam unremarkable. BP 124/80.',
        assessment: 'Migraine without aura',
        plan: 'Start prophylaxis, headache diary, follow up in 4 weeks',
      })
      .expect(201);
    encounterId = enc.body.id;
    await http.post(`/api/v1/encounters/${encounterId}/diagnoses`).set(auth(token)).send({ code: 'G43.0', description: 'Migraine without aura', isPrimary: true }).expect(201);
    await http.post(`/api/v1/encounters/${encounterId}/sign`).set(auth(token)).expect(200);

    // Upcoming appointment + issued invoice for the global search groups (inserted directly: no availability setup needed).
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await tenantContext.runSystem(async () => {
      const appt = await prisma.db.appointment.create({
        data: { clinicId, doctorId, patientId: samiId, startsAt: tomorrow, endsAt: new Date(tomorrow.getTime() + 30 * 60_000), reason: 'Follow-up' },
      });
      appointmentId = appt.id;
      await prisma.db.invoice.create({ data: { clinicId, patientId: samiId, number: invoiceNumber, status: 'ISSUED', subtotal: 100, total: 100, issuedAt: new Date() } });
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────────────────────── patients list search ─────────────────────────────

  it('GET /patients?search finds the diacritics name from a plain Arabic query', async () => {
    const res = await http.get('/api/v1/patients').query({ search: 'محمد' }).set(auth(token)).expect(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(arabicId);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.page).toBe(1);
    expect(res.body.items[0]).not.toHaveProperty('nationalIdEnc');
    expect(res.body.items[0].nationalId).toBeNull();
  });

  it('GET /patients?search finds a misspelt Latin name via trigram similarity', async () => {
    const res = await http.get('/api/v1/patients').query({ search: 'mohamed' }).set(auth(token)).expect(200);
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(latinId);
    expect(ids).not.toContain(samiId);
  });

  it('GET /patients?search matches inside phone numbers and e-mail addresses', async () => {
    // Substring hits rank first; short numeric queries may also fuzzy-match MRNs further down the list.
    const byPhone = await http.get('/api/v1/patients').query({ search: '0501' }).set(auth(token)).expect(200);
    expect(byPhone.body.total).toBeGreaterThanOrEqual(1);
    expect(byPhone.body.items[0].id).toBe(samiId);

    const byEmail = await http.get('/api/v1/patients').query({ search: 'sami@example.com' }).set(auth(token)).expect(200);
    expect(byEmail.body.items.map((p: { id: string }) => p.id)).toContain(samiId);
  });

  it('GET /patients?search paginates the ranked result and escapes LIKE metacharacters', async () => {
    // Every patient of this fresh clinic carries an "mrn-00000x" token in its search text.
    const page = await http.get('/api/v1/patients').query({ search: 'mrn-', pageSize: 1, page: 2 }).set(auth(token)).expect(200);
    expect(page.body.pageSize).toBe(1);
    expect(page.body.page).toBe(2);
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
    const all = await http.get('/api/v1/patients').query({ search: 'mrn-', pageSize: 10 }).set(auth(token)).expect(200);
    expect(all.body.items.map((p: { id: string }) => p.id).sort()).toEqual([arabicId, latinId, samiId].sort());
    expect(all.body.items[1].id).toBe(page.body.items[0].id);

    const none = await http.get('/api/v1/patients').query({ search: '%%%' }).set(auth(token)).expect(200);
    expect(none.body.total).toBe(0);
  });

  // ──────────────────────────────── global search ────────────────────────────────

  it('GET /search groups patients, encounters, invoices and appointments', async () => {
    const res = await http.get('/api/v1/search').query({ q: 'haddad' }).set(auth(token)).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['appointments', 'encounters', 'invoices', 'patients']);
    expect(res.body.patients).toHaveLength(1);
    expect(res.body.patients[0]).toMatchObject({ id: samiId, firstName: 'Sami', lastName: 'Haddad', phone: '0501234567' });
    expect(res.body.patients[0].score).toBeGreaterThan(0);
    expect(res.body.appointments.map((a: { id: string }) => a.id)).toEqual([appointmentId]);
    expect(res.body.appointments[0].patient.id).toBe(samiId);
    expect(res.body.appointments[0].doctor.id).toBe(doctorId);

    const inv = await http.get('/api/v1/search').query({ q: invoiceNumber.toLowerCase() }).set(auth(token)).expect(200);
    expect(inv.body.invoices).toHaveLength(1);
    expect(inv.body.invoices[0]).toMatchObject({ number: invoiceNumber, status: 'ISSUED', total: 100, amountPaid: 0, balance: 100, patientId: samiId });

    const enc = await http.get('/api/v1/search').query({ q: 'migraine', limit: 3 }).set(auth(token)).expect(200);
    expect(enc.body.encounters.map((e: { id: string }) => e.id)).toEqual([encounterId]);
    expect(enc.body.encounters[0].snippet).toContain('<b>migraine</b>');
    expect(enc.body.encounters[0].patient.id).toBe(samiId);
    expect(enc.body.encounters[0].doctor.id).toBe(doctorId);
  });

  it('GET /search validates the query', async () => {
    await http.get('/api/v1/search').query({ q: 'x' }).set(auth(token)).expect(400);
    await http.get('/api/v1/search').query({ q: 'haddad', limit: 99 }).set(auth(token)).expect(400);
    await http.get('/api/v1/search').query({ q: 'haddad' }).expect(401);
  });

  it('GET /search only returns groups the user may read', async () => {
    await http
      .post('/api/v1/members')
      .set(auth(token))
      .send({ email: `acct-${slug}@test.local`, firstName: 'Acc', lastName: 'Ountant', role: 'ACCOUNTANT', password })
      .expect(201);
    const login = await http.post('/api/v1/auth/login').send({ email: `acct-${slug}@test.local`, password }).expect(200);
    const acct = login.body.tokens.accessToken as string;
    const res = await http.get('/api/v1/search').query({ q: 'migraine' }).set(auth(acct)).expect(200);
    expect(res.body.encounters).toEqual([]); // no records:read
    const pats = await http.get('/api/v1/search').query({ q: 'haddad' }).set(auth(acct)).expect(200);
    expect(pats.body.patients).toHaveLength(1);
    await http.get('/api/v1/records/search').query({ q: 'migraine' }).set(auth(acct)).expect(403);
    await http.get('/api/v1/search/diagnoses').query({ q: 'mig' }).set(auth(acct)).expect(403);
  });

  // ──────────────────────────────── records search ────────────────────────────────

  it('GET /records/search finds Arabic and English SOAP text with snippets and rank', async () => {
    const ar = await http.get('/api/v1/records/search').query({ q: 'صداع' }).set(auth(token)).expect(200);
    expect(ar.body.total).toBe(1);
    expect(ar.body.items[0].id).toBe(encounterId);
    expect(ar.body.items[0].snippet).toContain('<b>صداع</b>');
    expect(ar.body.items[0].rank).toBeGreaterThan(0);
    expect(ar.body.items[0].chiefComplaint).toBe('صداع نصفي متكرر');

    const en = await http.get('/api/v1/records/search').query({ q: 'prophylaxis headache', patientId: samiId, doctorId }).set(auth(token)).expect(200);
    expect(en.body.total).toBe(1);
    expect(en.body.items[0].snippet).toContain('<b>');
    expect(en.body).toMatchObject({ page: 1, pageSize: 20 });

    const other = await http.get('/api/v1/records/search').query({ q: 'migraine', patientId: arabicId }).set(auth(token)).expect(200);
    expect(other.body.total).toBe(0);
    const future = await http.get('/api/v1/records/search').query({ q: 'migraine', from: new Date(Date.now() + 3600_000).toISOString() }).set(auth(token)).expect(200);
    expect(future.body.total).toBe(0);
    const miss = await http.get('/api/v1/records/search').query({ q: 'appendicitis' }).set(auth(token)).expect(200);
    expect(miss.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('GET /search/diagnoses autocompletes codes and descriptions used in the clinic', async () => {
    const byCode = await http.get('/api/v1/search/diagnoses').query({ q: 'g43' }).set(auth(token)).expect(200);
    expect(byCode.body).toEqual([{ code: 'G43.0', description: 'Migraine without aura', uses: 1 }]);
    const byText = await http.get('/api/v1/search/diagnoses').query({ q: 'migrain' }).set(auth(token)).expect(200);
    expect(byText.body.map((d: { code: string }) => d.code)).toEqual(['G43.0']);
  });

  // ───────────────────────────── cross-clinic isolation ─────────────────────────────

  it("another clinic's token never sees these rows", async () => {
    const list = await http.get('/api/v1/patients').query({ search: 'haddad' }).set(auth(tokenB)).expect(200);
    expect(list.body.total).toBe(0);
    const global = await http.get('/api/v1/search').query({ q: 'haddad' }).set(auth(tokenB)).expect(200);
    expect(global.body).toEqual({ patients: [], encounters: [], invoices: [], appointments: [] });
    const records = await http.get('/api/v1/records/search').query({ q: 'migraine' }).set(auth(tokenB)).expect(200);
    expect(records.body.total).toBe(0);
    const dx = await http.get('/api/v1/search/diagnoses').query({ q: 'g43' }).set(auth(tokenB)).expect(200);
    expect(dx.body).toEqual([]);
    await http.post(`/api/v1/ai/patients/${samiId}/ask`).set(auth(tokenB)).send({ question: 'Any headaches?' }).expect(404);
  });

  // ─────────────────────────────── embeddings ───────────────────────────────

  it('embeds a signed encounter in the background and POST /ai/embeddings/backfill refreshes it', async () => {
    // The sign listener runs after the response; give it a moment.
    let rows = await embeddingRow();
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await embeddingRow();
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'fake-embed-1', dims: 768 });
    const documentCalls = embeddings.calls.filter((c) => c.taskType === 'RETRIEVAL_DOCUMENT');
    expect(documentCalls.length).toBeGreaterThanOrEqual(1);
    const embedded = documentCalls[0].texts[0];
    expect(embedded).toContain('Chief complaint: صداع نصفي متكرر');
    expect(embedded).toContain('Diagnoses: G43.0 Migraine without aura (primary)');
    for (const leak of ['Sami', 'Haddad', '0501234567', 'sami@example.com']) expect(embedded).not.toContain(leak);

    const unchanged = await http.post('/api/v1/ai/embeddings/backfill').set(auth(token)).expect(200);
    expect(unchanged.body).toEqual({ scanned: 1, embedded: 0, unchanged: 1, failed: 0 });

    await tenantContext.runSystem(() => prisma.transaction((tx) => tx.$executeRaw`DELETE FROM encounter_embeddings WHERE encounter_id = ${encounterId}::uuid`));
    const refilled = await http.post('/api/v1/ai/embeddings/backfill').set(auth(token)).expect(200);
    expect(refilled.body).toEqual({ scanned: 1, embedded: 1, unchanged: 0, failed: 0 });
    rows = await embeddingRow();
    expect(rows).toHaveLength(1);
    expect(rows[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  // ─────────────────────────────── ask the record ───────────────────────────────

  it('POST /ai/patients/:id/ask answers with citations from semantic retrieval', async () => {
    const before = ai.textCalls.length;
    const res = await http.post(`/api/v1/ai/patients/${samiId}/ask`).set(auth(token)).send({ question: 'Has the patient had headaches?' }).expect(200);
    expect(res.body.answer).toContain('[E1]');
    expect(res.body.retrieval).toBe('semantic');
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0]).toMatchObject({ ref: 'E1', encounterId, chiefComplaint: 'صداع نصفي متكرر' });
    expect(typeof res.body.citations[0].occurredAt).toBe('string');
    expect(res.body.interactionId).toMatch(/^[0-9a-f-]{36}$/);

    // Only de-identified excerpts and the question reached the model.
    expect(ai.textCalls).toHaveLength(before + 1);
    const prompt = ai.textCalls[before].prompt;
    expect(prompt).toContain('[E1]');
    expect(prompt).toContain('Migraine without aura');
    expect(prompt).toContain('Has the patient had headaches?');
    for (const leak of ['Sami', 'Haddad', '0501234567', 'sami@example.com', 'Olive']) expect(prompt).not.toContain(leak);
    expect(embeddings.calls.some((c) => c.taskType === 'RETRIEVAL_QUERY' && c.texts[0] === 'Has the patient had headaches?')).toBe(true);

    const interactions = await http.get('/api/v1/ai/interactions').query({ patientId: samiId }).set(auth(token)).expect(200);
    const row = interactions.body.find((i: { id: string }) => i.id === res.body.interactionId);
    expect(row).toMatchObject({ feature: 'PATIENT_SUMMARY', status: 'GENERATED', provider: 'fake', model: 'fake-llm' });
    expect(row.structuredOutput).toMatchObject({ kind: 'RECORD_QA', question: 'Has the patient had headaches?', retrieval: 'semantic' });
    expect(row.structuredOutput.citations[0].encounterId).toBe(encounterId);

    const log = await http.get(`/api/v1/patients/${samiId}/access-log`).set(auth(token)).expect(200);
    expect(log.body.some((l: { action: string }) => l.action === 'AI_RECORD_QA')).toBe(true);
  });

  it('POST /ai/patients/:id/ask validates input and handles an empty record', async () => {
    await http.post(`/api/v1/ai/patients/${samiId}/ask`).set(auth(token)).send({ question: 'hi' }).expect(400);
    await http.post(`/api/v1/ai/patients/${samiId}/ask`).set(auth(token)).send({}).expect(400);
    const empty = await http.post(`/api/v1/ai/patients/${arabicId}/ask`).set(auth(token)).send({ question: 'Any prior visits?' }).expect(200);
    expect(empty.body.citations).toEqual([]);
    expect(empty.body.retrieval).toBe('recent');
    expect(empty.body.answer).toContain('no signed encounters');
  });
});
