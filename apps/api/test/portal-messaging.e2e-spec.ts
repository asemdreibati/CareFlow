import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { LogProvider } from '../src/modules/messaging/providers/log.provider.js';
import { RemindersService } from '../src/modules/scheduling/reminders.service.js';

/**
 * Patient portal + messaging (docs/PHASE3.md §C) end to end against the local
 * database: OTP login, portal endpoints, reminders routed through the messaging
 * module, Twilio inbound/status webhooks and the staff message log. Registers
 * its own clinic and never touches seeded data. Providers are the logging
 * fallbacks (`.env`), so sent messages are read from `LogProvider.sent`.
 */
describe('Portal + messaging (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let prisma: PrismaService;
  let reminders: RemindersService;

  const ts = Date.now();
  const slug = `portal-test-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@portal-test.local`;
  // Unique Saudi mobile per run, stored in the local spelling to exercise normalisation.
  const national = `5${String(ts).slice(-8)}`;
  const localPhone = `0${national}`;
  const e164 = `+966${national}`;
  const twilioToken = 'test-twilio-token';
  const publicApiUrl = 'http://localhost:3000';

  let ownerToken: string;
  let clinicId: string;
  let doctorId: string;
  let patientId: string;
  let portalToken: string;
  let bookedId: string;
  let confirmTargetId: string;
  let nearId: string;
  let reminderMessageId: string;
  let reminderProviderId: string;

  const future = new Date(Date.now() + 7 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  const at = (hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  function sign(path: string, params: Record<string, string>): string {
    const data = Object.keys(params)
      .sort()
      .reduce((acc, k) => acc + k + params[k], `${publicApiUrl}${path}`);
    return createHmac('sha1', twilioToken).update(data).digest('base64');
  }

  async function poll<T>(fn: () => Promise<T | undefined>, attempts = 30, delayMs = 150): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('poll timed out');
  }

  beforeAll(async () => {
    process.env.TWILIO_AUTH_TOKEN = twilioToken;
    process.env.PUBLIC_API_URL = publicApiUrl;
    process.env.MESSAGING_SMS_PROVIDER = 'log';
    process.env.MESSAGING_EMAIL_PROVIDER = 'log';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    reminders = app.get(RemindersService);

    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Portal Test Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    clinicId = reg.body.session.clinic.id;

    const doc = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName: 'Dana', lastName: 'Doctor', specialty: 'General' }).expect(201);
    doctorId = doc.body.id;
    await request(http)
      .put(`/api/v1/doctors/${doctorId}/availability`)
      .set(auth(ownerToken))
      .send({ slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) })
      .expect(200);

    const patient = await request(http)
      .post('/api/v1/patients')
      .set(auth(ownerToken))
      .send({ firstName: 'Sara', lastName: 'Patient', phone: localPhone, email: `sara-${ts}@portal-test.local`, dateOfBirth: '1990-01-01' })
      .expect(201);
    patientId = patient.body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────── OTP login ───────────────────────────────

  it('staff enables the portal; request-otp never reveals whether a phone exists', async () => {
    const before = await request(http).post('/api/v1/portal/auth/request-otp').send({ clinicSlug: slug, phone: localPhone }).expect(200);
    expect(before.body).toEqual({ sent: true });
    expect(LogProvider.latest(e164, 'SMS')).toBeUndefined();

    const updated = await request(http).patch(`/api/v1/patients/${patientId}`).set(auth(ownerToken)).send({ portalEnabled: true, locale: 'en' }).expect(200);
    expect(updated.body.portalEnabled).toBe(true);
    expect(updated.body.locale).toBe('en');

    const unknown = await request(http).post('/api/v1/portal/auth/request-otp').send({ clinicSlug: slug, phone: '0599999999' }).expect(200);
    expect(unknown.body).toEqual({ sent: true });
    await request(http).post('/api/v1/portal/auth/request-otp').send({ clinicSlug: slug }).expect(400);
  });

  it('sends a 6-digit code by SMS and verifies it (wrong code rejected, code single-use)', async () => {
    await request(http).post('/api/v1/portal/auth/request-otp').send({ clinicSlug: slug, phone: localPhone }).expect(200);
    const sms = LogProvider.latest(e164, 'SMS');
    expect(sms).toBeDefined();
    const code = sms!.body.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeDefined();
    expect(sms!.body).toContain('Portal Test Clinic');

    await request(http).post('/api/v1/portal/auth/verify').send({ clinicSlug: slug, phone: localPhone, code: code === '000000' ? '111111' : '000000' }).expect(401);
    await request(http).post('/api/v1/portal/auth/verify').send({ clinicSlug: slug, phone: localPhone, code: 'abcdef' }).expect(400);

    const ok = await request(http).post('/api/v1/portal/auth/verify').send({ clinicSlug: slug, phone: e164, code }).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.patient).toMatchObject({ id: patientId, firstName: 'Sara', lastName: 'Patient', locale: 'en' });
    expect(ok.body.clinic).toMatchObject({ slug, timezone: 'Asia/Riyadh' });
    portalToken = ok.body.accessToken;

    // Consumed: the same code does not work twice
    await request(http).post('/api/v1/portal/auth/verify').send({ clinicSlug: slug, phone: localPhone, code }).expect(401);

    // The stored row is hashed, never the plain code
    const rows = await tenantContext.runSystem(() => prisma.db.otpCode.findMany({ where: { clinicId, phone: e164 } }));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.codeHash.length === 64 && !r.codeHash.includes(code!))).toBe(true);
  });

  it('rejects portal tokens on staff endpoints and staff tokens on portal endpoints', async () => {
    await request(http).get('/api/v1/patients').set(auth(portalToken)).expect(401);
    await request(http).get('/api/v1/appointments').set(auth(portalToken)).expect(401);
    await request(http).get('/api/v1/portal/me').set(auth(ownerToken)).expect(401);
    await request(http).get('/api/v1/portal/me').expect(401);
  });

  // ─────────────────────────────── profile & clinic ───────────────────────────────

  it('GET /portal/me and /portal/clinic', async () => {
    const me = await request(http).get('/api/v1/portal/me').set(auth(portalToken)).expect(200);
    expect(me.body).toMatchObject({ id: patientId, firstName: 'Sara', locale: 'en', portalEnabled: true });
    expect(me.body.consents).toEqual([]);
    expect(me.body).not.toHaveProperty('nationalIdEnc');

    const clinic = await request(http).get('/api/v1/portal/clinic').set(auth(portalToken)).expect(200);
    expect(clinic.body).toMatchObject({ name: 'Portal Test Clinic', slug, timezone: 'Asia/Riyadh' });
    expect(clinic.body.doctors).toEqual([{ id: doctorId, firstName: 'Dana', lastName: 'Doctor', title: null, specialty: 'General', color: expect.any(String) }]);

    const patched = await request(http).patch('/api/v1/portal/me').set(auth(portalToken)).send({ address: '12 Olaya St' }).expect(200);
    expect(patched.body.address).toBe('12 Olaya St');
    await request(http).patch('/api/v1/portal/me').set(auth(portalToken)).send({ firstName: 'Hacker' }).expect(400);
  });

  // ─────────────────────────────── slots & booking ───────────────────────────────

  it('GET /portal/slots returns slots for a doctor with availability', async () => {
    const res = await request(http).get('/api/v1/portal/slots').set(auth(portalToken)).query({ doctorId }).expect(200);
    expect(res.body.query.timezone).toBe('Asia/Riyadh');
    expect(res.body.candidates.length).toBeGreaterThan(0);
    expect(res.body.candidates[0].doctor.id).toBe(doctorId);
    expect(res.body.candidates.every((c: { durationMinutes?: number; startsAt: string; endsAt: string }) => new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime() === 30 * 60_000)).toBe(true);

    await request(http).get('/api/v1/portal/slots').set(auth(portalToken)).expect(400);
    const tooLong = { doctorId, from: new Date().toISOString(), to: new Date(Date.now() + 20 * 86_400_000).toISOString() };
    await request(http).get('/api/v1/portal/slots').set(auth(portalToken)).query(tooLong).expect(400);
    const bySpecialty = await request(http).get('/api/v1/portal/slots').set(auth(portalToken)).query({ specialty: 'general', limit: 5 }).expect(200);
    expect(bySpecialty.body.candidates.length).toBeLessThanOrEqual(5);
  });

  it('POST /portal/appointments books (201), is idempotent, and staff see it; the patient gets a confirmation SMS', async () => {
    const key = `portal-${ts}`;
    const res = await request(http)
      .post('/api/v1/portal/appointments')
      .set(auth(portalToken))
      .set('Idempotency-Key', key)
      .send({ doctorId, startsAt: at('07:00'), reason: 'Headache' })
      .expect(201);
    bookedId = res.body.id;
    expect(res.body).toMatchObject({ doctorId, status: 'SCHEDULED', type: 'CONSULTATION', reason: 'Headache', startsAt: at('07:00') });
    expect(res.body).not.toHaveProperty('notes');
    expect(res.body.doctor.id).toBe(doctorId);

    const replay = await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).set('Idempotency-Key', key).send({ doctorId, startsAt: at('07:00') }).expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(bookedId);

    const staff = await request(http).get(`/api/v1/appointments/${bookedId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.patient.id).toBe(patientId);
    expect(staff.body.notes).toBe('Booked via patient portal');
    expect(staff.body.createdById).toBeNull();

    const sms = LogProvider.latest(e164, 'SMS');
    expect(sms?.body).toContain('Dr. Dana Doctor');
    expect(sms?.body).toContain('Reply 1 to confirm');

    // Double booking the same slot is refused, as is the past
    await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).send({ doctorId, startsAt: at('07:00') }).expect(409);
    await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).send({ doctorId, startsAt: '2020-01-01T07:00:00.000Z' }).expect(400);
    // Outside availability (Riyadh 20:00)
    await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).send({ doctorId, startsAt: at('17:00') }).expect(400);
  });

  it('lists upcoming/past appointments and the detail', async () => {
    const upcoming = await request(http).get('/api/v1/portal/appointments').set(auth(portalToken)).expect(200);
    expect(upcoming.body.items.map((a: { id: string }) => a.id)).toContain(bookedId);
    const past = await request(http).get('/api/v1/portal/appointments').set(auth(portalToken)).query({ scope: 'past' }).expect(200);
    expect(past.body.items).toHaveLength(0);
    const detail = await request(http).get(`/api/v1/portal/appointments/${bookedId}`).set(auth(portalToken)).expect(200);
    expect(detail.body.id).toBe(bookedId);
    await request(http).get('/api/v1/portal/appointments/00000000-0000-0000-0000-000000000000').set(auth(portalToken)).expect(404);
  });

  it('cancel within 2h → 409; cancel a later appointment → 200 CANCELLED (waitlist/reminders react)', async () => {
    // An appointment starting in 30 minutes, inserted directly (staff booking would be outside availability at some hours).
    const soon = new Date(Date.now() + 30 * 60_000);
    const near = await tenantContext.runSystem(() =>
      prisma.db.appointment.create({ data: { clinicId, doctorId, patientId, startsAt: soon, endsAt: new Date(soon.getTime() + 30 * 60_000) }, select: { id: true } }),
    );
    nearId = near.id;
    const tooLate = await request(http).post(`/api/v1/portal/appointments/${nearId}/cancel`).set(auth(portalToken)).send({}).expect(409);
    expect(tooLate.body.message).toContain('2 hours');

    const cancelled = await request(http).post(`/api/v1/portal/appointments/${bookedId}/cancel`).set(auth(portalToken)).send({ reason: 'Feeling better' }).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancellationNote).toContain('Feeling better');
    const staff = await request(http).get(`/api/v1/appointments/${bookedId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CANCELLED');
    await poll(async () => {
      const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: bookedId, status: 'PENDING' }).expect(200);
      return r.body.length === 0 ? true : undefined;
    });
    // Cancelling again is a no-op
    await request(http).post(`/api/v1/portal/appointments/${bookedId}/cancel`).set(auth(portalToken)).send({}).expect(200);
  });

  it('POST /portal/appointments/:id/confirm', async () => {
    const booked = await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).send({ doctorId, startsAt: at('09:00') }).expect(201);
    const confirmed = await request(http).post(`/api/v1/portal/appointments/${booked.body.id}/confirm`).set(auth(portalToken)).expect(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    await request(http).post(`/api/v1/portal/appointments/${bookedId}/confirm`).set(auth(portalToken)).expect(409);
  });

  // ─────────────────────────────── consents & waitlist ───────────────────────────────

  it('consents: accept (idempotent) and list', async () => {
    const first = await request(http).post('/api/v1/portal/consents').set(auth(portalToken)).send({ type: 'PRIVACY', version: '1.0' }).expect(201);
    expect(first.body).toMatchObject({ type: 'PRIVACY', version: '1.0' });
    const again = await request(http).post('/api/v1/portal/consents').set(auth(portalToken)).send({ type: 'PRIVACY', version: '1.0' }).expect(201);
    expect(again.body.id).toBe(first.body.id);
    await request(http).post('/api/v1/portal/consents').set(auth(portalToken)).send({ type: 'BOGUS', version: '1.0' }).expect(400);
    const list = await request(http).get('/api/v1/portal/consents').set(auth(portalToken)).expect(200);
    expect(list.body).toHaveLength(1);
    const me = await request(http).get('/api/v1/portal/me').set(auth(portalToken)).expect(200);
    expect(me.body.consents).toHaveLength(1);
  });

  it('waitlist: join and list', async () => {
    await request(http).post('/api/v1/portal/waitlist').set(auth(portalToken)).send({}).expect(400);
    await request(http).post('/api/v1/portal/waitlist').set(auth(portalToken)).send({ doctorId, priority: 'URGENT' }).expect(400);
    const entry = await request(http).post('/api/v1/portal/waitlist').set(auth(portalToken)).send({ doctorId, preferredWindows: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }] }).expect(201);
    expect(entry.body).toMatchObject({ patientId, doctorId, specialty: 'General', status: 'WAITING', priority: 'ROUTINE' });
    expect(entry.body.doctor.id).toBe(doctorId);
    const list = await request(http).get('/api/v1/portal/waitlist').set(auth(portalToken)).expect(200);
    expect(list.body.map((e: { id: string }) => e.id)).toContain(entry.body.id);
    await request(http).post(`/api/v1/portal/waitlist/${entry.body.id}/accept`).set(auth(portalToken)).expect(409);
    // Staff see the entry too
    const staff = await request(http).get(`/api/v1/waitlist/${entry.body.id}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.createdById).toBeNull();
  });

  // ─────────────────────────────── reminders → messaging → inbound ───────────────────────────────

  it('reminders go out through the messaging module (SMS for patients with a phone)', async () => {
    const booked = await request(http).post('/api/v1/portal/appointments').set(auth(portalToken)).send({ doctorId, startsAt: at('10:00') }).expect(201);
    confirmTargetId = booked.body.id;
    const rows = await poll(async () => {
      const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: confirmTargetId, status: 'PENDING' }).expect(200);
      return r.body.length === 3 ? r.body : undefined;
    });
    expect(rows.map((r: { channel: string }) => r.channel).sort()).toEqual(['IN_APP', 'IN_APP', 'SMS']);
    const sms = rows.find((r: { channel: string }) => r.channel === 'SMS');
    await tenantContext.runSystem(() => prisma.db.reminder.update({ where: { id: sms.id }, data: { scheduledFor: new Date(Date.now() - 1000) } }));
    // The worker processes every clinic with due rows (other test runs may have left some), so check ours by id.
    const pass = await reminders.runOnce();
    expect(pass.claimed).toBeGreaterThanOrEqual(1);
    const sentRows = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: confirmTargetId, status: 'SENT' }).expect(200);
    expect(sentRows.body.map((r: { id: string }) => r.id)).toEqual([sms.id]);

    const logged = LogProvider.latest(e164, 'SMS');
    expect(logged?.body).toContain('reminder');
    expect(logged?.body).toContain('Reply 1 to confirm or 2 to cancel');

    const messages = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId, channel: 'SMS' }).expect(200);
    const reminder = messages.body.items.find((m: { template: string; appointmentId: string }) => m.template === 'appointment.reminder' && m.appointmentId === confirmTargetId);
    expect(reminder).toMatchObject({ direction: 'OUTBOUND', status: 'SENT', provider: 'log', address: e164 });
    reminderMessageId = reminder.id;
    reminderProviderId = reminder.providerMessageId;
  });

  it('inbound webhook: "1" from the patient confirms the reminded appointment and stores the reply', async () => {
    const path = '/api/v1/webhooks/twilio/inbound';
    const params = { From: e164, To: '+15005550006', Body: '1', MessageSid: `SM${ts}` };
    const res = await request(http).post(path).set('X-Twilio-Signature', sign(path, params)).type('form').send(params).expect(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Response><Message>');
    expect(res.text).toContain('confirmed');

    const staff = await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CONFIRMED');

    const inbound = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId, direction: 'INBOUND' }).expect(200);
    expect(inbound.body.total).toBe(1);
    expect(inbound.body.items[0]).toMatchObject({ intent: 'CONFIRM', body: '1', inReplyToId: reminderMessageId, appointmentId: confirmTargetId, status: 'RECEIVED', channel: 'SMS', providerMessageId: `SM${ts}` });

    // Unknown text is stored with intent UNKNOWN and gets the help reply
    const unknown = { From: `whatsapp:${e164}`, To: 'whatsapp:+14155238886', Body: 'see you there', MessageSid: `SM${ts}b` };
    const r2 = await request(http).post(path).set('X-Twilio-Signature', sign(path, unknown)).type('form').send(unknown).expect(200);
    expect(r2.text).toContain('Reply 1 to confirm');
    const all = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId, direction: 'INBOUND' }).expect(200);
    expect(all.body.items.find((m: { intent: string }) => m.intent === 'UNKNOWN')).toMatchObject({ channel: 'WHATSAPP' });
  });

  it('rejects webhooks with a wrong or missing signature when a token is configured', async () => {
    const path = '/api/v1/webhooks/twilio/inbound';
    const params = { From: e164, Body: '2', MessageSid: `SM${ts}c` };
    await request(http).post(path).set('X-Twilio-Signature', 'bogus').type('form').send(params).expect(403);
    await request(http).post(path).type('form').send(params).expect(403);
    await request(http).post('/api/v1/webhooks/twilio/status').type('form').send({ MessageSid: 'x', MessageStatus: 'delivered' }).expect(403);
    // Still CONFIRMED (the "2" was rejected)
    const staff = await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CONFIRMED');
  });

  it('status callback updates the outbound message status', async () => {
    const path = '/api/v1/webhooks/twilio/status';
    const params = { MessageSid: reminderProviderId, MessageStatus: 'delivered' };
    await request(http).post(path).set('X-Twilio-Signature', sign(path, params)).type('form').send(params).expect(204);
    const messages = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId, channel: 'SMS' }).expect(200);
    expect(messages.body.items.find((m: { id: string }) => m.id === reminderMessageId).status).toBe('DELIVERED');
  });

  it('inbound "2" cancels the next appointment, which frees the slot for the waitlist', async () => {
    const path = '/api/v1/webhooks/twilio/inbound';
    const params = { From: e164, Body: 'إلغاء', MessageSid: `SM${ts}d` };
    const res = await request(http).post(path).set('X-Twilio-Signature', sign(path, params)).type('form').send(params).expect(200);
    expect(res.text).toContain('cancelled');
    const staff = await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CANCELLED');
  });

  // ─────────────────────────────── staff message log ───────────────────────────────

  it('GET /messages lists outbound + inbound; POST /messages sends a free-text message', async () => {
    const all = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId }).expect(200);
    const directions = new Set(all.body.items.map((m: { direction: string }) => m.direction));
    expect(directions).toEqual(new Set(['OUTBOUND', 'INBOUND']));
    expect(all.body.items.every((m: { patientId: string }) => m.patientId === patientId)).toBe(true);
    expect(all.body.items.some((m: { template: string }) => m.template === 'portal.otp')).toBe(true);

    const sent = await request(http).post('/api/v1/messages').set(auth(ownerToken)).send({ patientId, channel: 'SMS', body: 'Please bring your insurance card.' }).expect(201);
    expect(sent.body).toMatchObject({ direction: 'OUTBOUND', status: 'SENT', channel: 'SMS', address: e164, provider: 'log' });
    expect(LogProvider.latest(e164, 'SMS')?.body).toBe('Please bring your insurance card.');

    const email = await request(http).post('/api/v1/messages').set(auth(ownerToken)).send({ patientId, channel: 'EMAIL', body: 'Hello', subject: 'Hi' }).expect(201);
    expect(email.body.status).toBe('SENT');
    await request(http).post('/api/v1/messages').set(auth(ownerToken)).send({ patientId, channel: 'FAX', body: 'x' }).expect(400);
    await request(http).get('/api/v1/messages').expect(401);
  });

  it('portal: invoices list is empty and the token stops working when the portal is disabled', async () => {
    const invoices = await request(http).get('/api/v1/portal/invoices').set(auth(portalToken)).expect(200);
    expect(invoices.body).toEqual([]);
    await request(http).patch(`/api/v1/patients/${patientId}`).set(auth(ownerToken)).send({ portalEnabled: false }).expect(200);
    await request(http).get('/api/v1/portal/me').set(auth(portalToken)).expect(401);
  });
});
