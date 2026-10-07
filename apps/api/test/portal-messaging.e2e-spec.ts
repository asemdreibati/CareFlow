import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { LogProvider } from '../src/modules/messaging/providers/log.provider.js';
import { PortalAuthService } from '../src/modules/portal/portal-auth.service.js';
import { RemindersService } from '../src/modules/scheduling/reminders.service.js';

/**
 * Patient portal + messaging (docs/PHASE3.md §C) end to end against the local
 * database: OTP login, portal endpoints, reminders routed through the messaging
 * module, Twilio inbound/status webhooks and the staff message log. Registers
 * its own clinic and never touches seeded data. Providers are the logging
 * fallbacks (`.env`): OTP codes are masked everywhere, the plain code is read
 * through the test-only hook `LogProvider.lastOtpForTests` (NODE_ENV=test).
 *
 * request-otp works in the background, so tests wait with `PortalAuthService.idle()`.
 * Express trusts `X-Forwarded-For` here and every request gets its own client
 * address (the per-IP throttler would otherwise couple the tests together).
 */
describe('Portal + messaging (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let prisma: PrismaService;
  let reminders: RemindersService;
  let portalAuth: PortalAuthService;
  let jwt: JwtService;

  const ts = Date.now();
  const slug = `portal-test-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@portal-test.local`;
  // Unique Saudi mobiles per run, stored in the local spelling to exercise normalisation.
  const nationalOf = (k: number) => `5${String((Number(String(ts).slice(-8)) + k * 7919) % 100_000_000).padStart(8, '0')}`;
  const national = nationalOf(0);
  const localPhone = `0${national}`;
  const e164 = `+966${national}`;
  const twilioToken = 'test-twilio-token';
  const publicApiUrl = 'http://localhost:3000';

  let ownerToken: string;
  let clinicId: string;
  let doctorId: string;
  let doctor2Id: string;
  let patientId: string;
  let portalToken: string;
  let firstOtp: string;
  let bookedId: string;
  let confirmTargetId: string;
  let nearId: string;
  let reminderMessageId: string;
  let reminderProviderId: string;

  const future = new Date(Date.now() + 7 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  const at = (hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;
  /** `hh:mm` UTC on the day `n` days from now (Asia/Riyadh is UTC+3: 06:00Z = 09:00 local). */
  const day = (n: number, hhmmUtc: string) => `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${hhmmUtc}:00.000Z`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  let ipSeq = 1;
  const freshIp = () => `10.77.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`;
  const sys = <T>(fn: () => Promise<T>) => tenantContext.runSystem(fn);

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

  /** POST request-otp from a fresh client address, wait for the background issuance, return the plain code (if one was sent). */
  async function requestOtp(phone: string, toE164: string, ip = freshIp()): Promise<string | undefined> {
    const before = LogProvider.lastOtpForTests(toE164);
    const res = await request(http).post('/api/v1/portal/auth/request-otp').set('X-Forwarded-For', ip).send({ clinicSlug: slug, phone }).expect(200);
    expect(res.body).toEqual({ sent: true });
    await portalAuth.idle();
    const after = LogProvider.lastOtpForTests(toE164);
    return after !== before ? after : undefined;
  }

  const verify = (phone: string, code: string, ip = freshIp()) => request(http).post('/api/v1/portal/auth/verify').set('X-Forwarded-For', ip).send({ clinicSlug: slug, phone, code });

  const otpRows = (phone: string) => sys(() => prisma.db.otpCode.findMany({ where: { clinicId, phone }, orderBy: { createdAt: 'asc' } }));

  /** Moves every OTP row of `phone` `seconds` into the past (cool-down / windows without waiting). */
  const backdateOtps = (phone: string, seconds: number) =>
    sys(() => prisma.transaction((tx) => tx.$executeRaw`UPDATE otp_codes SET created_at = created_at - (${seconds} * interval '1 second') WHERE clinic_id = ${clinicId}::uuid AND phone = ${phone}`));

  const wrongCode = (code: string, n: number) => String((Number(code) + n) % 1_000_000).padStart(6, '0');

  async function createPatient(firstName: string, lastName: string, phone: string | undefined, opts: { portal?: boolean; locale?: 'ar' | 'en' } = {}) {
    const res = await request(http)
      .post('/api/v1/patients')
      .set(auth(ownerToken))
      .send({ firstName, lastName, ...(phone ? { phone } : {}), dateOfBirth: '1990-01-01' })
      .expect(201);
    if (opts.portal !== false) await request(http).patch(`/api/v1/patients/${res.body.id}`).set(auth(ownerToken)).send({ portalEnabled: true, locale: opts.locale ?? 'en' }).expect(200);
    return res.body.id as string;
  }

  const portalTokenFor = (id: string) => jwt.signAsync({ sub: id, clinicId, type: 'patient' }, { expiresIn: '1h' });

  async function staffBook(patient: string, doctor: string, startsAt: string): Promise<string> {
    const res = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId: doctor, patientId: patient, startsAt, durationMinutes: 30 }).expect(201);
    return res.body.id;
  }

  const insertAppointment = (patient: string, doctor: string, startsAt: Date) =>
    sys(() => prisma.db.appointment.create({ data: { clinicId, doctorId: doctor, patientId: patient, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }, select: { id: true } })).then((r) => r.id);

  /** An outbound row exactly like the reminder worker writes (template + appointment + address). */
  const insertOutbound = (patient: string, appointmentId: string, address: string, opts: { template?: string; createdAt?: Date; status?: 'SENT' | 'FAILED' } = {}) =>
    sys(() =>
      prisma.db.message.create({
        data: {
          clinicId,
          patientId: patient,
          appointmentId,
          channel: 'SMS',
          direction: 'OUTBOUND',
          address,
          body: 'Reminder. Reply 1 to confirm or 2 to cancel.',
          template: opts.template ?? 'appointment.reminder',
          status: opts.status ?? 'SENT',
          ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        },
        select: { id: true },
      }),
    ).then((r) => r.id);

  const appointmentRow = (id: string) => sys(() => prisma.db.appointment.findUniqueOrThrow({ where: { id }, select: { status: true, holdExpiresAt: true, cancellationNote: true } }));

  async function sms(from: string, body: string, sid: string) {
    const path = '/api/v1/webhooks/twilio/inbound';
    const params = { From: from, To: '+15005550006', Body: body, MessageSid: sid };
    return request(http).post(path).set('X-Twilio-Signature', sign(path, params)).type('form').send(params).expect(200);
  }

  const inboundRows = (patient: string) =>
    sys(() => prisma.db.message.findMany({ where: { clinicId, patientId: patient, direction: 'INBOUND' }, orderBy: { createdAt: 'asc' } }));

  beforeAll(async () => {
    process.env.TWILIO_AUTH_TOKEN = twilioToken;
    process.env.PUBLIC_API_URL = publicApiUrl;
    process.env.MESSAGING_SMS_PROVIDER = 'log';
    process.env.MESSAGING_EMAIL_PROVIDER = 'log';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    const express = app as unknown as NestExpressApplication;
    express.set('trust proxy', true);
    // Requests without an explicit client address get a fresh one, so the per-IP
    // throttler never couples unrelated tests (it is not under test here).
    express.use((req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
      if (!req.headers['x-forwarded-for']) req.headers['x-forwarded-for'] = freshIp();
      next();
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // Listen once on an ephemeral port: concurrent supertest calls then share one listener.
    await app.listen(0, '127.0.0.1');
    http = app.getHttpServer();
    prisma = app.get(PrismaService);
    reminders = app.get(RemindersService);
    portalAuth = app.get(PortalAuthService);
    jwt = app.get(JwtService);

    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Portal Test Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    clinicId = reg.body.session.clinic.id;

    const slots = { slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) };
    const doc = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName: 'Dana', lastName: 'Doctor', specialty: 'General' }).expect(201);
    doctorId = doc.body.id;
    await request(http).put(`/api/v1/doctors/${doctorId}/availability`).set(auth(ownerToken)).send(slots).expect(200);
    const doc2 = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName: 'Hana', lastName: 'Second', specialty: 'Dermatology' }).expect(201);
    doctor2Id = doc2.body.id;
    await request(http).put(`/api/v1/doctors/${doctor2Id}/availability`).set(auth(ownerToken)).send(slots).expect(200);

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
    expect(await requestOtp(localPhone, e164)).toBeUndefined();
    expect(LogProvider.latest(e164, 'SMS')).toBeUndefined();

    const updated = await request(http).patch(`/api/v1/patients/${patientId}`).set(auth(ownerToken)).send({ portalEnabled: true, locale: 'en' }).expect(200);
    expect(updated.body.portalEnabled).toBe(true);
    expect(updated.body.locale).toBe('en');

    const unknown = await request(http).post('/api/v1/portal/auth/request-otp').set('X-Forwarded-For', freshIp()).send({ clinicSlug: slug, phone: '0599999999' }).expect(200);
    expect(unknown.body).toEqual({ sent: true });
    await request(http).post('/api/v1/portal/auth/request-otp').set('X-Forwarded-For', freshIp()).send({ clinicSlug: slug }).expect(400);
  });

  it('sends a 6-digit code by SMS and verifies it (wrong code rejected, code single-use); the code is masked everywhere', async () => {
    const code = await requestOtp(localPhone, e164);
    expect(code).toMatch(/^\d{6}$/);
    firstOtp = code!;
    const sms = LogProvider.latest(e164, 'SMS');
    expect(sms?.body).toContain('Portal Test Clinic');
    // Provider history / log output only ever see the masked body
    expect(sms?.body).toContain('******');
    expect(LogProvider.sent.some((m) => m.body.includes(code!))).toBe(false);

    await verify(localPhone, wrongCode(code!, 1)).expect(401);
    await verify(localPhone, 'abcdef').expect(400);

    const ok = await verify(e164, code!).expect(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body).not.toHaveProperty('requiresPatientSelection');
    expect(ok.body.patient).toMatchObject({ id: patientId, firstName: 'Sara', lastName: 'Patient', locale: 'en' });
    expect(ok.body.clinic).toMatchObject({ slug, timezone: 'Asia/Riyadh' });
    portalToken = ok.body.accessToken;

    // Consumed: the same code does not work twice
    await verify(localPhone, code!).expect(401);

    // The stored row is hashed, never the plain code; the success did not count as a failed attempt
    const rows = await otpRows(e164);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.codeHash.length === 64 && !r.codeHash.includes(code!))).toBe(true);
    expect(rows[rows.length - 1].attempts).toBe(1);

    // Staff with patients:read (GET /messages) see the masked body only (review finding: plain OTP was readable)
    const messages = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId }).expect(200);
    const otpMessages = messages.body.items.filter((m: { template: string }) => m.template === 'portal.otp');
    expect(otpMessages.length).toBeGreaterThanOrEqual(1);
    expect(otpMessages.every((m: { body: string }) => m.body.includes('******') && !m.body.includes(code!))).toBe(true);
    const stored = await sys(() => prisma.db.message.findMany({ where: { clinicId, template: 'portal.otp' }, select: { body: true } }));
    expect(stored.every((m) => !m.body.includes(code!))).toBe(true);
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
    expect(clinic.body.doctors).toEqual(
      expect.arrayContaining([{ id: doctorId, firstName: 'Dana', lastName: 'Doctor', title: null, specialty: 'General', color: expect.any(String) }]),
    );

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
    nearId = await insertAppointment(patientId, doctorId, new Date(Date.now() + 30 * 60_000));
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
    const res = await sms(e164, '1', `SM${ts}`);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Response><Message>');
    expect(res.text).toContain('confirmed');

    const staff = await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CONFIRMED');

    const inbound = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId, direction: 'INBOUND' }).expect(200);
    expect(inbound.body.total).toBe(1);
    expect(inbound.body.items[0]).toMatchObject({ intent: 'CONFIRM', body: '1', inReplyToId: reminderMessageId, appointmentId: confirmTargetId, status: 'RECEIVED', channel: 'SMS', providerMessageId: `SM${ts}` });

    // Unknown text is stored with intent UNKNOWN and gets the help reply
    const path = '/api/v1/webhooks/twilio/inbound';
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

  it('a patient who confirmed can still cancel by replying "2" to the same reminder; a further reply changes nothing', async () => {
    const res = await sms(e164, 'إلغاء', `SM${ts}d`);
    expect(res.text).toContain('has been cancelled');
    const staff = await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200);
    expect(staff.body.status).toBe('CANCELLED');
    const rows = await inboundRows(patientId);
    expect(rows.find((m) => m.providerMessageId === `SM${ts}d`)).toMatchObject({ intent: 'CANCEL', inReplyToId: reminderMessageId, appointmentId: confirmTargetId });
    const again = await sms(e164, '1', `SM${ts}d2`);
    expect(again.text).toContain('contact the clinic');
    expect((await request(http).get(`/api/v1/appointments/${confirmTargetId}`).set(auth(ownerToken)).expect(200)).body.status).toBe('CANCELLED');
  });

  // ─────────────────────────────── review regressions: inbound replies ───────────────────────────────

  it('t2: "2" after a portal booking cancels THAT booking, not an older reminded appointment; webhook replays are ignored', async () => {
    const phone = nationalOf(11);
    const repE164 = `+966${phone}`;
    const rep = await createPatient('Rana', 'Reply', `0${phone}`);
    const token = await portalTokenFor(rep);
    // Y: booked by staff, reminded an hour ago (inside the reply window)
    const y = await staffBook(rep, doctorId, day(3, '07:00'));
    await insertOutbound(rep, y, repE164, { createdAt: new Date(Date.now() - 3_600_000) });
    // X: booked via the portal → "appointment.confirmed" carrying "Reply 1 to confirm or 2 to cancel"
    const x = await request(http).post('/api/v1/portal/appointments').set(auth(token)).send({ doctorId, startsAt: day(10, '08:00') }).expect(201);
    const confirmation = await sys(() => prisma.db.message.findFirst({ where: { appointmentId: x.body.id, template: 'appointment.confirmed' } }));
    expect(confirmation?.body).toContain('Reply 1 to confirm or 2 to cancel');

    const first = await sms(repE164, '2', `SM${ts}t2a`);
    expect(first.text).toContain('has been cancelled');
    expect((await appointmentRow(x.body.id)).status).toBe('CANCELLED');
    expect((await appointmentRow(y)).status).toBe('SCHEDULED');

    // Twilio retries / replays the same MessageSid: nothing happens, no reply, no second row
    const replay = await sms(repE164, '2', `SM${ts}t2a`);
    expect(replay.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect((await appointmentRow(y)).status).toBe('SCHEDULED');
    const rows = await sys(() => prisma.db.message.count({ where: { providerMessageId: `SM${ts}t2a`, direction: 'INBOUND' } }));
    expect(rows).toBe(1);

    // Another "2": the latest instruction-bearing message is about X (cancelled) → no fallback to Y's older reminder
    const again = await sms(repE164, '2', `SM${ts}t2b`);
    expect(again.text).toContain('contact the clinic');
    expect((await appointmentRow(y)).status).toBe('SCHEDULED');
  });

  it('never falls back to "the next appointment": no recent instruction-bearing message → nothing changes', async () => {
    const phone = nationalOf(12);
    const repE164 = `+966${phone}`;
    const rep = await createPatient('Nabil', 'NoFallback', `0${phone}`);
    const y = await staffBook(rep, doctorId, day(3, '09:00'));

    const res = await sms(repE164, '2', `SM${ts}nf1`);
    expect(res.text).toContain('contact the clinic');
    expect((await appointmentRow(y)).status).toBe('SCHEDULED');
    // Recorded for staff in the patient's clinic, linked to nothing
    expect((await inboundRows(rep)).at(-1)).toMatchObject({ intent: 'CANCEL', appointmentId: null, inReplyToId: null });

    // A reminder older than the 7-day window, or one that was never delivered, does not count either
    await insertOutbound(rep, y, repE164, { createdAt: new Date(Date.now() - 8 * 86_400_000) });
    await insertOutbound(rep, y, repE164, { status: 'FAILED' });
    const old = await sms(repE164, 'cancel', `SM${ts}nf2`);
    expect(old.text).toContain('contact the clinic');
    expect((await appointmentRow(y)).status).toBe('SCHEDULED');
  });

  it('concurrent replies to the same reminder act at most once', async () => {
    const phone = nationalOf(13);
    const repE164 = `+966${phone}`;
    const rep = await createPatient('Cora', 'Concurrent', `0${phone}`);
    const y = await staffBook(rep, doctorId, day(3, '08:00'));
    await insertOutbound(rep, y, repE164);

    const [a, b] = await Promise.all([sms(repE164, '2', `SM${ts}cc1`), sms(repE164, 'no', `SM${ts}cc2`)]);
    const texts = [a.text, b.text];
    expect(texts.filter((t) => t.includes('has been cancelled'))).toHaveLength(1);
    expect(texts.filter((t) => t.includes('contact the clinic'))).toHaveLength(1);
    expect((await appointmentRow(y)).status).toBe('CANCELLED');
    expect((await inboundRows(rep)).filter((m) => m.appointmentId !== null)).toHaveLength(1);
  });

  it('SMS cancellation applies the 2-hour rule like the portal', async () => {
    const phone = nationalOf(14);
    const repE164 = `+966${phone}`;
    const rep = await createPatient('Lina', 'Late', `0${phone}`);
    const soon = await insertAppointment(rep, doctor2Id, new Date(Date.now() + 70 * 60_000));
    await insertOutbound(rep, soon, repE164);

    const res = await sms(repE164, '2', `SM${ts}late`);
    expect(res.text).toContain('less than 2 hours');
    expect((await appointmentRow(soon)).status).toBe('SCHEDULED');
    expect((await inboundRows(rep)).at(-1)).toMatchObject({ intent: 'CANCEL', appointmentId: null });
    // Confirming is still possible
    const ok = await sms(repE164, '1', `SM${ts}late2`);
    expect(ok.text).toContain('confirmed');
    expect((await appointmentRow(soon)).status).toBe('CONFIRMED');
  });

  // ─────────────────────────────── review regressions: held waitlist offers ───────────────────────────────

  it('t3: held waitlist offers are declined / accepted through the waitlist (portal cancel, portal confirm, SMS "1")', async () => {
    const phone = nationalOf(15);
    const holdE164 = `+966${phone}`;
    const holder = await createPatient('Hiba', 'Holder', `0${phone}`);
    const token = await portalTokenFor(holder);
    const other = await createPatient('Omar', 'Other', undefined, { portal: false });
    const entry = await request(http).post('/api/v1/portal/waitlist').set(auth(token)).send({ doctorId: doctor2Id }).expect(201);

    /** Staff cancel another patient's appointment → the backfill holds the slot for the waiting entry. */
    async function offer(entryId: string, startsAt: string, previousHold?: string): Promise<string> {
      const z = await staffBook(other, doctor2Id, startsAt);
      await request(http).post(`/api/v1/appointments/${z}/status`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
      return poll(async () => {
        const e = await sys(() => prisma.db.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } }));
        return e.status === 'OFFERED' && e.offeredAppointmentId && e.offeredAppointmentId !== previousHold ? e.offeredAppointmentId : undefined;
      });
    }
    const entryRow = (id: string) => sys(() => prisma.db.waitlistEntry.findUniqueOrThrow({ where: { id } }));

    // Portal cancel of a hold = decline: the entry waits again (before: the entry stayed OFFERED on a cancelled slot)
    const h1 = await offer(entry.body.id, day(5, '06:00'));
    expect((await appointmentRow(h1)).holdExpiresAt).not.toBeNull();
    const declined = await request(http).post(`/api/v1/portal/appointments/${h1}/cancel`).set(auth(token)).send({}).expect(200);
    expect(declined.body.status).toBe('CANCELLED');
    expect(await entryRow(entry.body.id)).toMatchObject({ status: 'WAITING', offeredAppointmentId: null, offerCount: 1 });

    // Portal confirm of a hold = accept: hold cleared, entry BOOKED, appointment CONFIRMED
    // (before: CONFIRMED but still held, so the expiry job cancelled it later)
    const h2 = await offer(entry.body.id, day(5, '07:00'), h1);
    const confirmed = await request(http).post(`/api/v1/portal/appointments/${h2}/confirm`).set(auth(token)).expect(200);
    expect(confirmed.body).toMatchObject({ id: h2, status: 'CONFIRMED', holdExpiresAt: null });
    expect((await entryRow(entry.body.id)).status).toBe('BOOKED');

    // SMS "1" to a reminder of a held offer = accept as well
    const entry2 = await request(http).post('/api/v1/portal/waitlist').set(auth(token)).send({ doctorId: doctor2Id }).expect(201);
    const h3 = await offer(entry2.body.id, day(5, '08:00'));
    await insertOutbound(holder, h3, holdE164);
    const res = await sms(holdE164, '1', `SM${ts}hold`);
    expect(res.text).toContain('confirmed');
    expect(await appointmentRow(h3)).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
    expect((await entryRow(entry2.body.id)).status).toBe('BOOKED');
  });

  // ─────────────────────────────── review regressions: booking limits ───────────────────────────────

  it('t4: portal bookings are capped (active count, horizon, slot grid) with localised errors', async () => {
    const booker = await createPatient('Badr', 'Booker', `0${nationalOf(16)}`);
    const token = await portalTokenFor(booker);
    const book = (startsAt: string) => request(http).post('/api/v1/portal/appointments').set(auth(token)).send({ doctorId, startsAt });

    const far = await book(day(100, '06:00')).expect(400);
    expect(far.body.message).toContain('90 days');
    const misaligned = await book(day(4, '07:07')).expect(400);
    expect(misaligned.body.message).toContain('available time slots');
    await book(day(4, '07:15')).expect(400);

    for (const t of ['06:00', '06:30', '07:00']) await book(day(4, t)).expect(201);
    const fourth = await book(day(4, '07:30')).expect(409);
    expect(fourth.body.message).toContain('3 upcoming appointments');

    // Configurable per clinic (clinic.settings), and localised
    const clinic = await sys(() => prisma.db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { settings: true } }));
    const settings = (clinic.settings ?? {}) as Record<string, unknown>;
    await sys(() => prisma.db.clinic.update({ where: { id: clinicId }, data: { settings: { ...settings, portalMaxActiveBookings: 4, portalBookingHorizonDays: 120 } } }));
    try {
      await book(day(4, '07:30')).expect(201);
      await book(day(100, '06:00')).expect(409); // within 120 days now, but the 4-booking cap applies
      await request(http).patch('/api/v1/portal/me').set(auth(token)).send({ locale: 'ar' }).expect(200);
      const ar = await book(day(4, '08:00')).expect(409);
      expect(ar.body.message).toContain('4');
      expect(ar.body.message).toMatch(/[؀-ۿ]/);
    } finally {
      await sys(() => prisma.db.clinic.update({ where: { id: clinicId }, data: { settings: settings as object } }));
    }
  });

  it('concurrent portal bookings with the same Idempotency-Key: exactly one 201, the rest replay it (200)', async () => {
    const patient = await createPatient('Ines', 'Idem', `0${nationalOf(17)}`);
    const token = await portalTokenFor(patient);
    const key = `idem-${ts}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(http).post('/api/v1/portal/appointments').set(auth(token)).set('Idempotency-Key', key).send({ doctorId, startsAt: day(6, '06:00') })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 200).every((r) => r.headers['idempotent-replay'] === 'true')).toBe(true);
    const rows = await sys(() => prisma.db.appointment.count({ where: { clinicId, patientId: patient } }));
    expect(rows).toBe(1);
  });

  it('PATCH /portal/me accepts null to clear email and address', async () => {
    const patient = await createPatient('Nora', 'Nulls', `0${nationalOf(18)}`);
    const token = await portalTokenFor(patient);
    const set = await request(http).patch('/api/v1/portal/me').set(auth(token)).send({ email: `nora-${ts}@portal-test.local`, address: '1 King Rd' }).expect(200);
    expect(set.body).toMatchObject({ email: `nora-${ts}@portal-test.local`, address: '1 King Rd' });
    const cleared = await request(http).patch('/api/v1/portal/me').set(auth(token)).send({ email: null, address: null }).expect(200);
    expect(cleared.body).toMatchObject({ email: null, address: null });
    await request(http).patch('/api/v1/portal/me').set(auth(token)).send({ email: 'not-an-email' }).expect(400);
  });

  // ─────────────────────────────── review regressions: OTP ───────────────────────────────

  it('t1: concurrent wrong guesses can never exceed the attempt limit', async () => {
    const phone = nationalOf(21);
    const otpE164 = `+966${phone}`;
    await createPatient('Ola', 'Race', `0${phone}`);
    const code = await requestOtp(`0${phone}`, otpE164);
    expect(code).toBeDefined();

    // 10 wrong guesses at once (max attempts = 5): exactly 5 are counted, all fail
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => verify(`0${phone}`, wrongCode(code!, i + 1))));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(401));
    const rows = await otpRows(otpE164);
    expect(rows.at(-1)?.attempts).toBe(5);
    // The right code is useless now
    await verify(`0${phone}`, code!).expect(401);

    // 9 wrong + the right one at once: at most 5 are compared, at most one wins
    const phone2 = nationalOf(22);
    const otpE164b = `+966${phone2}`;
    await createPatient('Omar', 'Race', `0${phone2}`);
    const code2 = await requestOtp(`0${phone2}`, otpE164b);
    const mixed = await Promise.all([...Array.from({ length: 9 }, (_, i) => verify(`0${phone2}`, wrongCode(code2!, i + 1))), verify(`0${phone2}`, code2!)]);
    const successes = mixed.filter((r) => r.status === 200).length;
    expect(successes).toBeLessThanOrEqual(1);
    const row = (await otpRows(otpE164b)).at(-1)!;
    expect(row.attempts + successes).toBeLessThanOrEqual(5);
  });

  it('OTP failure budget: 10 failures per phone per hour across codes lock out verify and request', async () => {
    const phone = nationalOf(23);
    const otpE164 = `+966${phone}`;
    await createPatient('Bu', 'Dget', `0${phone}`);

    const a = await requestOtp(`0${phone}`, otpE164);
    await Promise.all(Array.from({ length: 5 }, (_, i) => verify(`0${phone}`, wrongCode(a!, i + 1)).expect(401)));
    await backdateOtps(otpE164, 16 * 60); // outside the request window, inside the failure window
    const b = await requestOtp(`0${phone}`, otpE164);
    expect(b).toBeDefined();
    await Promise.all(Array.from({ length: 4 }, (_, i) => verify(`0${phone}`, wrongCode(b!, i + 1)).expect(401)));
    await backdateOtps(otpE164, 16 * 60);
    const c = await requestOtp(`0${phone}`, otpE164);
    expect(c).toBeDefined();
    await verify(`0${phone}`, wrongCode(c!, 1)).expect(401); // 10th failure

    // The right code of a fresh, unexhausted code is refused: the phone is over budget
    await verify(`0${phone}`, c!).expect(401);
    expect((await otpRows(otpE164)).at(-1)).toMatchObject({ attempts: 1, consumedAt: null });
    // ...and no new code is sent while locked (the response is the same)
    await backdateOtps(otpE164, 2 * 60);
    expect(await requestOtp(`0${phone}`, otpE164)).toBeUndefined();
    expect(await otpRows(otpE164)).toHaveLength(3);

    // After the window the phone can log in again
    await backdateOtps(otpE164, 61 * 60);
    const d = await requestOtp(`0${phone}`, otpE164);
    expect(d).toBeDefined();
    await verify(`0${phone}`, d!).expect(200);
  });

  it('OTP requests: 60 s cool-down and 3 per 15 minutes per phone; throttled requests neither send nor invalidate', async () => {
    const phone = nationalOf(24);
    const otpE164 = `+966${phone}`;
    await createPatient('Tara', 'Throttle', `0${phone}`);

    const c1 = await requestOtp(`0${phone}`, otpE164);
    expect(c1).toBeDefined();
    expect(await requestOtp(`0${phone}`, otpE164)).toBeUndefined(); // cool-down
    expect(await otpRows(otpE164)).toHaveLength(1);

    await backdateOtps(otpE164, 61);
    const c2 = await requestOtp(`0${phone}`, otpE164);
    expect(c2).toBeDefined();
    await backdateOtps(otpE164, 61);
    const c3 = await requestOtp(`0${phone}`, otpE164);
    expect(c3).toBeDefined();
    await backdateOtps(otpE164, 61);
    expect(await requestOtp(`0${phone}`, otpE164)).toBeUndefined(); // 4th within 15 minutes
    const rows = await otpRows(otpE164);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)?.consumedAt).toBeNull();

    // The current code survived the throttled requests
    await verify(`0${phone}`, c3!).expect(200);
  });

  it('request-otp takes the same (padded) time for known and unknown phones', async () => {
    const phone = nationalOf(25);
    await createPatient('Tim', 'Timing', `0${phone}`);
    const time = async (p: string) => {
      const t0 = performance.now();
      await request(http).post('/api/v1/portal/auth/request-otp').set('X-Forwarded-For', freshIp()).send({ clinicSlug: slug, phone: p }).expect(200);
      return performance.now() - t0;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(await time(`0${phone}`));
      unknown.push(await time(`05999${String(ts).slice(-2)}${i}${i}${i}`));
    }
    await portalAuth.idle();
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[1];
    for (const ms of [...known, ...unknown]) expect(ms).toBeGreaterThanOrEqual(390);
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(150);

    // Failed verifies are padded too
    const t0 = performance.now();
    await verify('0599999999', '123456').expect(401);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(390);
  });

  it('t5: stored phones with spaces / dashes / parentheses match (OTP and inbound replies)', async () => {
    const phone = nationalOf(26);
    const otpE164 = `+966${phone}`;
    const spaced = `+966 ${phone.slice(0, 2)} ${phone.slice(2, 5)} ${phone.slice(5)}`;
    const fmt = await createPatient('Fatima', 'Format', spaced);
    expect((await sys(() => prisma.db.patient.findUniqueOrThrow({ where: { id: fmt }, select: { phone: true } }))).phone).toBe(spaced);

    const code = await requestOtp(otpE164, otpE164);
    expect(code).toBeDefined();
    const ok = await verify(`(0${phone.slice(0, 2)}) ${phone.slice(2, 5)}-${phone.slice(5)}`, code!).expect(200);
    // Single match: the response shape is unchanged (no selection step)
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.patient.id).toBe(fmt);
    expect(ok.body).not.toHaveProperty('requiresPatientSelection');

    // Inbound reply from that number is attributed to the patient (was: "not registered")
    const res = await sms(otpE164, '1', `SM${ts}fmt`);
    expect(res.text).not.toContain('not registered');
    expect(res.text).toContain('contact the clinic');
    expect((await inboundRows(fmt)).at(-1)).toMatchObject({ intent: 'CONFIRM', appointmentId: null });
  });

  it('two patients sharing a phone: verify asks which one, POST /portal/auth/select issues the session', async () => {
    const phone = nationalOf(27);
    const shared = `+966${phone}`;
    const alpha = await createPatient('Tala', 'Alpha', `+966 ${phone.slice(0, 2)} ${phone.slice(2)}`);
    const beta = await createPatient('Tamer', 'Beta', `0${phone.slice(0, 2)}-${phone.slice(2, 5)}-${phone.slice(5)}`);

    const code = await requestOtp(`0${phone}`, shared);
    expect(code).toBeDefined();
    const res = await verify(`0${phone}`, code!).expect(200);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body.requiresPatientSelection).toBe(true);
    expect(res.body.candidates).toEqual([
      { id: alpha, displayName: 'T. A***' },
      { id: beta, displayName: 'T. B***' },
    ]);
    const selectionToken = res.body.selectionToken as string;

    // The selection token is not a portal token
    await request(http).get('/api/v1/portal/me').set(auth(selectionToken)).expect(401);
    // Only the listed candidates can be chosen
    await request(http).post('/api/v1/portal/auth/select').set('X-Forwarded-For', freshIp()).send({ selectionToken, patientId }).expect(401);
    await request(http).post('/api/v1/portal/auth/select').set('X-Forwarded-For', freshIp()).send({ selectionToken: `${selectionToken}x`, patientId: beta }).expect(401);

    const session = await request(http).post('/api/v1/portal/auth/select').set('X-Forwarded-For', freshIp()).send({ selectionToken, patientId: beta }).expect(200);
    expect(session.body.patient).toMatchObject({ id: beta, firstName: 'Tamer', lastName: 'Beta' });
    const me = await request(http).get('/api/v1/portal/me').set(auth(session.body.accessToken)).expect(200);
    expect(me.body.id).toBe(beta);
  });

  // ─────────────────────────────── staff message log ───────────────────────────────

  it('GET /messages lists outbound + inbound; POST /messages sends a free-text message', async () => {
    const all = await request(http).get('/api/v1/messages').set(auth(ownerToken)).query({ patientId }).expect(200);
    const directions = new Set(all.body.items.map((m: { direction: string }) => m.direction));
    expect(directions).toEqual(new Set(['OUTBOUND', 'INBOUND']));
    expect(all.body.items.every((m: { patientId: string }) => m.patientId === patientId)).toBe(true);
    const otp = all.body.items.filter((m: { template: string }) => m.template === 'portal.otp');
    expect(otp.length).toBeGreaterThan(0);
    expect(otp.every((m: { body: string }) => !m.body.includes(firstOtp))).toBe(true);

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
