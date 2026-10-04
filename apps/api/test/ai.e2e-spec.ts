import { BadGatewayException, INestApplication, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { AI_PROVIDER_TOKEN, type AiProvider, type GenerateJsonInput, type GenerateTextInput } from '../src/modules/ai/ai-provider.js';

/** In-memory provider: records prompts so tests can assert de-identification, and can be made to fail. */
class FakeProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  textCalls: GenerateTextInput[] = [];
  jsonCalls: GenerateJsonInput[] = [];
  failNext: Error | null = null;
  soap = { subjective: 'Headache for 3 days, worse in the morning.', objective: 'BP 128/82, afebrile.', assessment: 'Tension-type headache.', plan: '' };

  async generateText(input: GenerateTextInput) {
    this.textCalls.push(input);
    this.maybeFail();
    return { text: '## Overview\nThe patient is a 46-year-old female.\n\n## Allergies\n**Penicillin (life-threatening)**', inputTokens: 120, outputTokens: 40 };
  }

  async generateJson<T>(input: GenerateJsonInput) {
    this.jsonCalls.push(input);
    this.maybeFail();
    return { data: this.soap as unknown as T, inputTokens: 80, outputTokens: 30 };
  }

  private maybeFail() {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }
}

describe('AI (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const fake = new FakeProvider();
  const suffix = Date.now().toString(36);
  const slug = `ai-${suffix}`;
  let owner: string;
  let clinicId: string;
  let patientId: string;
  let encounterId: string;
  let summaryId: string;
  let soapId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AI_PROVIDER_TOKEN).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);

    const reg = await http
      .post('/api/v1/auth/register')
      .send({ clinicName: `AI Clinic ${suffix}`, slug, email: `owner-${slug}@test.local`, password: 'Password123', firstName: 'Zelda', lastName: 'Owner' })
      .expect(201);
    owner = reg.body.tokens.accessToken;
    clinicId = reg.body.session.clinic.id;

    const patient = await http
      .post('/api/v1/patients')
      .set(auth(owner))
      .send({
        firstName: 'Zelda',
        lastName: 'Quartermain',
        dateOfBirth: '1980-03-15',
        gender: 'FEMALE',
        phone: '+15550001111',
        email: 'zelda.q@example.com',
        address: '12 Hidden Lane',
        nationalId: '987654321',
        bloodType: 'O+',
      })
      .expect(201);
    patientId = patient.body.id;
    await http.post(`/api/v1/patients/${patientId}/allergies`).set(auth(owner)).send({ substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'LIFE_THREATENING' }).expect(201);

    // The records module is built separately; seed the encounter directly.
    encounterId = await tenantContext.runSystem(async () => {
      const doctor = await prisma.db.doctor.create({ data: { clinicId, firstName: 'Greg', lastName: 'House', specialty: 'General' } });
      const enc = await prisma.db.encounter.create({
        data: { clinicId, patientId, doctorId: doctor.id, chiefComplaint: 'Headache', status: 'DRAFT' },
      });
      await prisma.db.diagnosis.create({ data: { clinicId, encounterId: enc.id, code: 'G44.2', description: 'Tension-type headache', isPrimary: true } });
      await prisma.db.prescription.create({
        data: { clinicId, encounterId: enc.id, patientId, doctorId: doctor.id, medication: 'Ibuprofen', dosage: '400mg', frequency: 'TID' },
      });
      return enc.id;
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ai/status reports the active provider', async () => {
    const res = await http.get('/api/v1/ai/status').set(auth(owner)).expect(200);
    expect(res.body).toEqual({ enabled: true, provider: 'fake', model: 'fake-1' });
  });

  it('POST /ai/patients/:id/summary generates a de-identified briefing and logs access', async () => {
    const res = await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(owner)).expect(201);
    summaryId = res.body.id;
    expect(res.body).toMatchObject({ feature: 'PATIENT_SUMMARY', status: 'GENERATED', provider: 'fake', model: 'fake-1', patientId, inputTokens: 120, outputTokens: 40 });
    expect(res.body.output).toContain('## Overview');
    expect(res.body.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof res.body.latencyMs).toBe('number');

    const call = fake.textCalls.at(-1)!;
    const sent = call.system + call.prompt;
    for (const leak of ['Zelda', 'Quartermain', '5550001111', 'zelda.q@example.com', 'Hidden Lane', '987654321', 'MRN-', patientId]) {
      expect(sent).not.toContain(leak);
    }
    expect(call.prompt).toContain('Gender: female');
    expect(call.prompt).toContain('Penicillin');
    expect(call.prompt).toContain('[SEVERE]');
    expect(call.prompt).toContain('Ibuprofen');
    expect(call.prompt).toContain('G44.2 Tension-type headache (primary)');
    expect(call.prompt).toContain('Chief complaint: Headache');

    const log = await http.get(`/api/v1/patients/${patientId}/access-log`).set(auth(owner)).expect(200);
    expect(log.body.some((row: { action: string }) => row.action === 'AI_SUMMARY')).toBe(true);
  });

  it('returns 404 for a patient of another clinic', async () => {
    const other = await http
      .post('/api/v1/auth/register')
      .send({ clinicName: `Other ${suffix}`, slug: `ai-other-${suffix}`, email: `owner-ai-other-${suffix}@test.local`, password: 'Password123', firstName: 'O', lastName: 'W' })
      .expect(201);
    await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(other.body.tokens.accessToken)).expect(404);
  });

  it('POST /ai/encounters/:id/soap-note validates input and stores structured output', async () => {
    await http.post(`/api/v1/ai/encounters/${encounterId}/soap-note`).set(auth(owner)).send({ transcript: 'too short' }).expect(400);
    await http.post(`/api/v1/ai/encounters/${encounterId}/soap-note`).set(auth(owner)).send({ transcript: 'x'.repeat(30), extra: 1 }).expect(400);

    const transcript = 'Patient reports headache for three days, worse in the morning. BP 128/82, afebrile. Impression tension-type headache.';
    const res = await http.post(`/api/v1/ai/encounters/${encounterId}/soap-note`).set(auth(owner)).send({ transcript }).expect(201);
    soapId = res.body.id;
    expect(res.body).toMatchObject({ feature: 'SOAP_NOTE', status: 'GENERATED', encounterId, patientId, structuredOutput: fake.soap });
    expect(fake.jsonCalls.at(-1)!.prompt).toContain(transcript);
    expect(fake.jsonCalls.at(-1)!.schema).toMatchObject({ type: 'object', required: ['subjective', 'objective', 'assessment', 'plan'] });

    // The encounter itself is untouched until a human approves.
    const enc = await tenantContext.runSystem(() => prisma.db.encounter.findUniqueOrThrow({ where: { id: encounterId } }));
    expect(enc.subjective).toBeNull();
    expect(enc.status).toBe('DRAFT');
  });

  it('persists a FAILED interaction when the provider errors, and rethrows', async () => {
    fake.failNext = new BadGatewayException('upstream exploded');
    await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(owner)).expect(502);
    const failed = await tenantContext.runSystem(() =>
      prisma.db.aiInteraction.findFirst({ where: { clinicId, status: 'FAILED' }, orderBy: { createdAt: 'desc' } }),
    );
    expect(failed?.error).toBe('upstream exploded');
    expect(failed?.feature).toBe('PATIENT_SUMMARY');
  });

  it('POST /ai/interactions/:id/review applies an approved SOAP note to the draft encounter', async () => {
    await http.post(`/api/v1/ai/interactions/${summaryId}/review`).set(auth(owner)).send({ decision: 'MAYBE' }).expect(400);
    // A summary cannot be applied to an encounter.
    await http.post(`/api/v1/ai/interactions/${summaryId}/review`).set(auth(owner)).send({ decision: 'APPROVED', applyToEncounter: true }).expect(400);

    const res = await http.post(`/api/v1/ai/interactions/${soapId}/review`).set(auth(owner)).send({ decision: 'APPROVED', applyToEncounter: true }).expect(200);
    expect(res.body.status).toBe('APPROVED');
    expect(res.body.reviewedById).toBeTruthy();
    expect(res.body.reviewedAt).toBeTruthy();

    const enc = await tenantContext.runSystem(() => prisma.db.encounter.findUniqueOrThrow({ where: { id: encounterId } }));
    expect(enc.subjective).toBe(fake.soap.subjective);
    expect(enc.objective).toBe(fake.soap.objective);
    expect(enc.assessment).toBe(fake.soap.assessment);
    expect(enc.plan).toBeNull(); // empty AI field never overwrites
    expect(enc.status).toBe('DRAFT');

    // Already reviewed.
    await http.post(`/api/v1/ai/interactions/${soapId}/review`).set(auth(owner)).send({ decision: 'REJECTED' }).expect(409);
  });

  it('rejects applying to an encounter that is no longer a draft', async () => {
    const res = await http.post(`/api/v1/ai/encounters/${encounterId}/soap-note`).set(auth(owner)).send({ transcript: 'Follow-up visit, patient reports improvement, no new findings.' }).expect(201);
    await tenantContext.runSystem(() => prisma.db.encounter.update({ where: { id: encounterId }, data: { status: 'SIGNED', signedAt: new Date() } }));
    await http.post(`/api/v1/ai/interactions/${res.body.id}/review`).set(auth(owner)).send({ decision: 'APPROVED', applyToEncounter: true }).expect(409);
    // Signed encounters cannot receive new drafts either.
    await http.post(`/api/v1/ai/encounters/${encounterId}/soap-note`).set(auth(owner)).send({ transcript: 'Another dictation that is long enough to pass.' }).expect(409);
    // Rejecting without applying still works.
    const rejected = await http.post(`/api/v1/ai/interactions/${res.body.id}/review`).set(auth(owner)).send({ decision: 'REJECTED' }).expect(200);
    expect(rejected.body.status).toBe('REJECTED');
  });

  it('GET /ai/interactions lists history with filters', async () => {
    const all = await http.get('/api/v1/ai/interactions').set(auth(owner)).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(4);
    expect(all.body.every((i: { clinicId: string }) => i.clinicId === clinicId)).toBe(true);

    const soaps = await http.get('/api/v1/ai/interactions').set(auth(owner)).query({ feature: 'SOAP_NOTE', patientId }).expect(200);
    expect(soaps.body.length).toBeGreaterThanOrEqual(2);
    expect(soaps.body.every((i: { feature: string }) => i.feature === 'SOAP_NOTE')).toBe(true);

    await http.get('/api/v1/ai/interactions').set(auth(owner)).query({ feature: 'NOPE' }).expect(400);
  });

  it('enforces ai:use / ai:review permissions per role', async () => {
    const member = async (role: string) => {
      const email = `${role.toLowerCase()}-${slug}@test.local`;
      await http.post('/api/v1/members').set(auth(owner)).send({ email, firstName: 'R', lastName: role, role, password: 'Password123' }).expect(201);
      const login = await http.post('/api/v1/auth/login').send({ email, password: 'Password123' }).expect(200);
      return login.body.tokens.accessToken as string;
    };
    const accountant = await member('ACCOUNTANT'); // neither ai:use nor ai:review
    await http.get('/api/v1/ai/status').set(auth(accountant)).expect(403);
    await http.get('/api/v1/ai/interactions').set(auth(accountant)).expect(403);
    await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(accountant)).expect(403);

    const admin = await member('ADMIN'); // ai:review but not ai:use
    await http.get('/api/v1/ai/status').set(auth(admin)).expect(200);
    await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(admin)).expect(403);
    await http.post(`/api/v1/ai/interactions/${summaryId}/review`).set(auth(admin)).send({ decision: 'REJECTED' }).expect(200);
  });

  it('surfaces a disabled provider as 503 and records the failure', async () => {
    fake.failNext = new ServiceUnavailableException('AI is not configured');
    const res = await http.post(`/api/v1/ai/patients/${patientId}/summary`).set(auth(owner)).expect(503);
    expect(res.body.message).toBe('AI is not configured');
    const failed = await tenantContext.runSystem(() => prisma.db.aiInteraction.findFirst({ where: { clinicId, status: 'FAILED' }, orderBy: { createdAt: 'desc' } }));
    expect(failed?.error).toBe('AI is not configured');
  });
});
