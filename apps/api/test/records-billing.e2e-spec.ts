import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

/**
 * End-to-end flow across records, billing and audit on a freshly registered
 * clinic, so it never touches seeded data:
 *   register → doctor profile for the owner → patient → encounter (dx + rx, sign)
 *   → invoice (draft → issued → partially paid → paid) → summary → audit trail.
 */
describe('Records, billing and audit (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let userId: string;
  let doctorId: string;
  let patientId: string;
  let encounterId: string;
  let diagnosisId: string;
  let prescriptionId: string;
  let serviceId: string;
  let invoiceId: string;

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const slug = `e2e-rb-${stamp}`;
  const email = `owner+${stamp}@e2e.careflow.test`;
  const password = 'Password123';

  const api = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ clinicName: 'E2E Records Clinic', slug, email, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    token = reg.body.tokens.accessToken;
    userId = reg.body.session.user.id;

    // The owner holds every permission; linking a doctor profile lets them author and sign encounters.
    const doc = await api()
      .post('/api/v1/doctors')
      .set(auth())
      .send({ firstName: 'Olive', lastName: 'Owner', specialty: 'General Practice', userId })
      .expect(201);
    doctorId = doc.body.id;

    const login = await api().post('/api/v1/auth/login').send({ email, password }).expect(200);
    token = login.body.tokens.accessToken;
    expect(login.body.session.doctorId).toBe(doctorId);

    const patient = await api()
      .post('/api/v1/patients')
      .set(auth())
      .send({ firstName: 'Pat', lastName: 'Ient', phone: '0500000000' })
      .expect(201);
    patientId = patient.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ───────────────────────────── medical records ─────────────────────────────

  it('creates a DRAFT encounter authored by the logged-in doctor', async () => {
    const res = await api()
      .post(`/api/v1/patients/${patientId}/encounters`)
      .set(auth())
      .send({ chiefComplaint: 'Headache', subjective: 'Two days of headache', vitals: { bp: '120/80', hr: 72 } })
      .expect(201);
    encounterId = res.body.id;
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.doctorId).toBe(doctorId);
    expect(res.body.patientId).toBe(patientId);
    expect(res.body.vitals).toEqual({ bp: '120/80', hr: 72 });
  });

  it('rejects an encounter linked to an unknown appointment', async () => {
    await api()
      .post(`/api/v1/patients/${patientId}/encounters`)
      .set(auth())
      .send({ appointmentId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
  });

  it('adds a diagnosis and a prescription', async () => {
    const dx = await api()
      .post(`/api/v1/encounters/${encounterId}/diagnoses`)
      .set(auth())
      .send({ code: 'R51', description: 'Headache', isPrimary: true })
      .expect(201);
    diagnosisId = dx.body.id;
    expect(dx.body.isPrimary).toBe(true);

    const rx = await api()
      .post(`/api/v1/encounters/${encounterId}/prescriptions`)
      .set(auth())
      .send({ medication: 'Paracetamol', dosage: '500mg', frequency: 'every 6h', durationDays: 3 })
      .expect(201);
    prescriptionId = rx.body.id;
    expect(rx.body.patientId).toBe(patientId);
    expect(rx.body.doctorId).toBe(doctorId);
    expect(rx.body.status).toBe('ACTIVE');
  });

  it('lists the patient encounters newest first with doctor and diagnoses', async () => {
    const res = await api().get(`/api/v1/patients/${patientId}/encounters`).set(auth()).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(encounterId);
    expect(res.body.items[0].doctor.id).toBe(doctorId);
    expect(res.body.items[0].diagnoses).toHaveLength(1);
  });

  it('signs the encounter (authoring doctor only)', async () => {
    const res = await api().post(`/api/v1/encounters/${encounterId}/sign`).set(auth()).expect(200);
    expect(res.body.status).toBe('SIGNED');
    expect(res.body.signedAt).toBeTruthy();

    await api().post(`/api/v1/encounters/${encounterId}/sign`).set(auth()).expect(409);
  });

  it('returns the full encounter and records a VIEW_ENCOUNTER access-log row', async () => {
    const res = await api().get(`/api/v1/encounters/${encounterId}`).set(auth()).expect(200);
    expect(res.body.diagnoses.map((d: { id: string }) => d.id)).toEqual([diagnosisId]);
    expect(res.body.prescriptions.map((p: { id: string }) => p.id)).toEqual([prescriptionId]);
    expect(res.body.patient.id).toBe(patientId);

    const log = await api().get(`/api/v1/patients/${patientId}/access-log`).set(auth()).expect(200);
    const row = log.body.find((r: { action: string; encounterId: string | null }) => r.action === 'VIEW_ENCOUNTER' && r.encounterId === encounterId);
    expect(row).toBeTruthy();
    expect(row.userId).toBe(userId);
  });

  it('editing a signed encounter with records:sign marks it AMENDED', async () => {
    const res = await api().patch(`/api/v1/encounters/${encounterId}`).set(auth()).send({ plan: 'Rest and hydration' }).expect(200);
    expect(res.body.status).toBe('AMENDED');
    expect(res.body.plan).toBe('Rest and hydration');
  });

  it('updates a prescription status', async () => {
    const res = await api().patch(`/api/v1/prescriptions/${prescriptionId}`).set(auth()).send({ status: 'COMPLETED' }).expect(200);
    expect(res.body.status).toBe('COMPLETED');
    await api().patch(`/api/v1/prescriptions/${prescriptionId}`).set(auth()).send({ status: 'BOGUS' }).expect(400);
  });

  // ──────────────────────────────── billing ────────────────────────────────

  it('creates a price-list service', async () => {
    const res = await api()
      .post('/api/v1/billing/services')
      .set(auth())
      .send({ code: 'cons', name: 'General consultation', price: 150, durationMinutes: 30 })
      .expect(201);
    serviceId = res.body.id;
    expect(res.body.code).toBe('CONS');
    expect(res.body.price).toBe(150);

    const list = await api().get('/api/v1/billing/services').set(auth()).expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(serviceId);
  });

  it('creates a DRAFT invoice with computed totals and a sequential number', async () => {
    const res = await api()
      .post('/api/v1/billing/invoices')
      .set(auth())
      .send({
        patientId,
        encounterId,
        items: [
          { serviceId, quantity: 2 },
          { description: 'Lab panel', quantity: 1, unitPrice: 60.5 },
        ],
        discount: 10,
        tax: 5,
      })
      .expect(201);
    invoiceId = res.body.id;
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.number).toMatch(/^INV-\d{4}-000001$/);
    expect(res.body.currency).toBe('USD');
    expect(res.body.items).toHaveLength(2);
    const byDescription = (d: string) => res.body.items.find((i: { description: string }) => i.description === d);
    expect(byDescription('General consultation')).toMatchObject({ serviceId, quantity: 2, unitPrice: 150, total: 300 });
    expect(byDescription('Lab panel')).toMatchObject({ serviceId: null, quantity: 1, unitPrice: 60.5, total: 60.5 });
    expect(res.body.subtotal).toBe(360.5);
    expect(res.body.total).toBe(355.5);
    expect(res.body.amountPaid).toBe(0);
    expect(res.body.balance).toBe(355.5);
    expect(res.body.patient.id).toBe(patientId);
  });

  it('rejects a free-text item without a price and a discount above the subtotal', async () => {
    await api()
      .post('/api/v1/billing/invoices')
      .set(auth())
      .send({ patientId, items: [{ description: 'No price', quantity: 1 }] })
      .expect(400);
    await api().patch(`/api/v1/billing/invoices/${invoiceId}`).set(auth()).send({ discount: 1000 }).expect(400);
  });

  it('allocates the next number for a second invoice', async () => {
    const res = await api()
      .post('/api/v1/billing/invoices')
      .set(auth())
      .send({ patientId, items: [{ serviceId, quantity: 1 }] })
      .expect(201);
    expect(res.body.number).toMatch(/^INV-\d{4}-000002$/);
    const voided = await api().post(`/api/v1/billing/invoices/${res.body.id}/void`).set(auth()).expect(200);
    expect(voided.body.status).toBe('VOID');
  });

  it('refuses payments on a draft, then issues the invoice', async () => {
    await api().post(`/api/v1/billing/invoices/${invoiceId}/payments`).set(auth()).send({ amount: 10, method: 'CASH' }).expect(409);

    const res = await api().post(`/api/v1/billing/invoices/${invoiceId}/issue`).set(auth()).expect(200);
    expect(res.body.status).toBe('ISSUED');
    expect(res.body.issuedAt).toBeTruthy();
    expect(res.body.dueAt).toBeTruthy();
    expect(new Date(res.body.dueAt).getTime() - new Date(res.body.issuedAt).getTime()).toBe(14 * 86_400_000);

    await api().patch(`/api/v1/billing/invoices/${invoiceId}`).set(auth()).send({ notes: 'late' }).expect(409);
  });

  it('records a partial payment', async () => {
    const res = await api()
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set(auth())
      .send({ amount: 100, method: 'CASH', reference: 'R-1' })
      .expect(201);
    expect(res.body.status).toBe('PARTIALLY_PAID');
    expect(res.body.amountPaid).toBe(100);
    expect(res.body.balance).toBe(255.5);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({ amount: 100, method: 'CASH', reference: 'R-1', receivedById: userId });
  });

  it('rejects an overpayment', async () => {
    const res = await api()
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set(auth())
      .send({ amount: 300, method: 'CARD' })
      .expect(400);
    expect(String(res.body.message)).toMatch(/balance/i);
  });

  it('settles the balance and marks the invoice PAID', async () => {
    const res = await api()
      .post(`/api/v1/billing/invoices/${invoiceId}/payments`)
      .set(auth())
      .send({ amount: 255.5, method: 'BANK_TRANSFER' })
      .expect(201);
    expect(res.body.status).toBe('PAID');
    expect(res.body.amountPaid).toBe(355.5);
    expect(res.body.balance).toBe(0);

    await api().post(`/api/v1/billing/invoices/${invoiceId}/payments`).set(auth()).send({ amount: 1, method: 'CASH' }).expect(409);
    await api().post(`/api/v1/billing/invoices/${invoiceId}/void`).set(auth()).expect(409);
  });

  it('lists invoices and reports the summary', async () => {
    const list = await api().get('/api/v1/billing/invoices?status=PAID').set(auth()).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(invoiceId);

    const detail = await api().get(`/api/v1/billing/invoices/${invoiceId}`).set(auth()).expect(200);
    expect(detail.body.payments).toHaveLength(2);

    const summary = await api().get('/api/v1/billing/summary').set(auth()).expect(200);
    expect(summary.body).toMatchObject({ invoiced: 355.5, collected: 355.5, outstanding: 0 });
    expect(summary.body.byStatus).toMatchObject({ DRAFT: 0, ISSUED: 0, PARTIALLY_PAID: 0, PAID: 1, VOID: 1 });

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const empty = await api().get(`/api/v1/billing/summary?from=${future}`).set(auth()).expect(200);
    expect(empty.body).toMatchObject({ invoiced: 0, collected: 0, outstanding: 0 });
  });

  // ───────────────────────────────── audit ─────────────────────────────────

  it('exposes the audit trail for the clinic', async () => {
    // Audit rows are written asynchronously after the response; allow them to land.
    let body: { total: number; items: Record<string, unknown>[] } | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await api().get('/api/v1/audit?entityType=Invoice&pageSize=50').set(auth()).expect(200);
      body = res.body;
      if (body && body.items.some((r) => r.action === 'billing.addPayment' && r.statusCode === 400)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(body).toBeTruthy();
    expect(body!.total).toBeGreaterThan(0);
    const created = body!.items.find((r) => r.action === 'billing.createInvoice' && r.entityId === invoiceId);
    expect(created).toMatchObject({ actorEmail: email, entityType: 'Invoice', method: 'POST', statusCode: 201 });
    expect(typeof created!.durationMs).toBe('number');
    expect(created!.requestBody).toMatchObject({ patientId });

    const overpay = body!.items.find((r) => r.action === 'billing.addPayment' && r.statusCode === 400);
    expect(overpay).toBeTruthy();
    // Newest first.
    const times = body!.items.map((r) => new Date(r.createdAt as string).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const byActor = await api().get(`/api/v1/audit?actorUserId=${userId}&action=encounters.sign`).set(auth()).expect(200);
    expect(byActor.body.items.every((r: { actorUserId: string; action: string }) => r.actorUserId === userId && r.action === 'encounters.sign')).toBe(true);
    expect(byActor.body.total).toBeGreaterThanOrEqual(1);
  });
});
