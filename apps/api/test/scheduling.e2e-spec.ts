import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { RemindersService } from '../src/modules/scheduling/reminders.service.js';

/**
 * Scheduling module (docs/SCHEDULING.md §6 and §7) end to end against the local
 * database: reschedule cascade, reminders outbox and the no-show model.
 * Registers its own clinic (Asia/Riyadh, UTC+3, no DST) and never touches seeded data.
 */
describe('Scheduling (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let prisma: PrismaService;
  let reminders: RemindersService;

  const ts = Date.now();
  const slug = `sched-test-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@sched-test.local`;

  let ownerToken: string;
  let ownerUserId: string;
  let clinicId: string;
  let doctorA: string;
  let doctorB: string;
  const patients: string[] = [];
  let patientNoEmail: string;
  const displaced: string[] = [];
  let untouchedId: string;
  let proposalId: string;

  // A day one week from now; availability covers every weekday so the weekday does not matter.
  const future = new Date(Date.now() + 7 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  const at = (hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function poll<T>(fn: () => Promise<T | undefined>, attempts = 30, delayMs = 150): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('poll timed out');
  }

  async function createDoctor(firstName: string, lastName: string, specialty: string) {
    const doc = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName, lastName, specialty }).expect(201);
    await request(http)
      .put(`/api/v1/doctors/${doc.body.id}/availability`)
      .set(auth(ownerToken))
      .send({ slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) })
      .expect(200);
    return doc.body.id as string;
  }

  async function book(doctorId: string, patientId: string, startsAt: string, extra: Record<string, unknown> = {}) {
    const res = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt, ...extra }).expect(201);
    return res.body as { id: string; version: number; startsAt: string };
  }

  beforeAll(async () => {
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
      .send({ clinicName: 'Scheduling Test Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    ownerUserId = reg.body.session.user.id;
    clinicId = reg.body.session.clinic.id;
    expect(clinicId).toBeTruthy();

    doctorA = await createDoctor('Alma', 'Alpha', 'General');
    doctorB = await createDoctor('Bruno', 'Beta', 'General');

    for (const [first, last] of [
      ['Pia', 'One'],
      ['Paul', 'Two'],
      ['Petra', 'Three'],
      ['Pete', 'Four'],
    ]) {
      const p = await request(http)
        .post('/api/v1/patients')
        .set(auth(ownerToken))
        .send({ firstName: first, lastName: last, email: `${first.toLowerCase()}-${ts}@sched-test.local`, dateOfBirth: '1985-05-05' })
        .expect(201);
      patients.push(p.body.id);
    }
    const noEmail = await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: 'Nora', lastName: 'NoEmail' }).expect(201);
    patientNoEmail = noEmail.body.id;

    // Doctor A on the future day: 10:00, 11:00, 12:00 (Riyadh) will be displaced by a 09:30–12:30 time off; 13:00 is untouched.
    for (const [i, hhmm] of ['07:00', '08:00', '09:00'].entries()) {
      const a = await book(doctorA, patients[i], at(hhmm), { reason: `Visit ${i + 1}` });
      displaced.push(a.id);
    }
    untouchedId = (await book(doctorA, patients[3], at('10:00'), { durationMinutes: 60 })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────── §6 reschedule cascade ───────────────────────────────

  it('requires scheduling:manage and validates input', async () => {
    await request(http).post('/api/v1/scheduling/time-off-impact').send({ doctorId: doctorA, startsAt: at('06:30'), endsAt: at('09:30') }).expect(401);
    await request(http).post('/api/v1/scheduling/time-off-impact').set(auth(ownerToken)).send({ doctorId: doctorA, startsAt: at('09:30'), endsAt: at('06:30') }).expect(400);
    await request(http).post('/api/v1/scheduling/time-off-impact').set(auth(ownerToken)).send({ doctorId: doctorA, startsAt: at('06:30') }).expect(400);
    await request(http)
      .post('/api/v1/scheduling/time-off-impact')
      .set(auth(ownerToken))
      .send({ doctorId: '00000000-0000-0000-0000-000000000000', startsAt: at('06:30'), endsAt: at('09:30') })
      .expect(404);
  });

  it('previews the impact of a time off: affected appointments and a non-persisted proposal', async () => {
    const res = await request(http)
      .post('/api/v1/scheduling/time-off-impact')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, startsAt: at('06:30'), endsAt: at('09:30') })
      .expect(200);
    expect(res.body.doctor.id).toBe(doctorA);
    const affectedIds = res.body.affected.map((a: { id: string }) => a.id).sort();
    expect(affectedIds).toEqual([...displaced].sort());
    expect(res.body.items).toHaveLength(3);
    expect(res.body.candidateCount).toBeGreaterThan(0);
    // Nothing persisted
    const list = await request(http).get('/api/v1/scheduling/reschedule-proposals').set(auth(ownerToken)).expect(200);
    expect(list.body).toHaveLength(0);
    // Same-doctor-only preview keeps everyone with doctor A
    for (const item of res.body.items) expect(item.toDoctorId === null || item.toDoctorId === doctorA).toBe(true);
  });

  it('creates a persisted proposal assigning every displaced appointment to a distinct free slot', async () => {
    const res = await request(http)
      .post('/api/v1/scheduling/reschedule-proposals')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, startsAt: at('06:30'), endsAt: at('09:30'), reason: 'Conference', allowOtherDoctors: true, createTimeOff: true })
      .expect(201);
    proposalId = res.body.id;
    expect(res.body.status).toBe('PENDING');
    expect(res.body.cause).toContain('Alma Alpha');
    expect(res.body.cause).toContain('Conference');
    expect(res.body.doctorTimeOffId).toBeTruthy();
    expect(res.body.unresolvedAppointmentIds).toEqual([]);
    expect(res.body.items).toHaveLength(3);

    const slots = new Set<string>();
    const timeOffStart = new Date(at('06:30')).getTime();
    const timeOffEnd = new Date(at('09:30')).getTime();
    for (const item of res.body.items) {
      expect(displaced).toContain(item.appointmentId);
      expect(item.to).toBeTruthy();
      expect(Number.isFinite(item.cost)).toBe(true);
      expect([doctorA, doctorB]).toContain(item.toDoctorId);
      expect(item.applied).toBe(false);
      expect(item.durationMinutes).toBe(30);
      // Either the time moved, or the patient was handed to the other doctor at the same time (cost 240).
      expect(item.displacementMinutes > 0 || item.toDoctorId !== doctorA).toBe(true);
      expect(item.cost).toBeGreaterThan(0);
      const key = `${item.toDoctorId}:${item.to}`;
      expect(slots.has(key)).toBe(false);
      slots.add(key);
      // Doctor A's new slots are never inside the time off
      if (item.toDoctorId === doctorA) {
        const start = new Date(item.to).getTime();
        expect(start < timeOffStart || start >= timeOffEnd).toBe(true);
      }
      // Never on top of the untouched 13:00–14:00 Riyadh booking of doctor A
      if (item.toDoctorId === doctorA) {
        const start = new Date(item.to).getTime();
        expect(start < new Date(at('10:00')).getTime() || start >= new Date(at('11:00')).getTime()).toBe(true);
      }
    }
    expect(res.body.totalDisplacementMinutes).toBe(res.body.items.reduce((s: number, i: { displacementMinutes: number }) => s + i.displacementMinutes, 0));

    // The time off exists right away (doctor module guard bypassed because the proposal handles the appointments)
    const doc = await request(http).get(`/api/v1/doctors/${doctorA}`).set(auth(ownerToken)).expect(200);
    const off = doc.body.timeOff.find((t: { id: string }) => t.id === res.body.doctorTimeOffId);
    expect(off).toBeTruthy();
    expect(new Date(off.startsAt).toISOString()).toBe(at('06:30'));
    expect(off.reason).toBe('Conference');

    const one = await request(http).get(`/api/v1/scheduling/reschedule-proposals/${proposalId}`).set(auth(ownerToken)).expect(200);
    expect(one.body.items).toHaveLength(3);
    const pending = await request(http).get('/api/v1/scheduling/reschedule-proposals').set(auth(ownerToken)).query({ status: 'PENDING' }).expect(200);
    expect(pending.body.map((p: { id: string }) => p.id)).toContain(proposalId);
    const applied = await request(http).get('/api/v1/scheduling/reschedule-proposals').set(auth(ownerToken)).query({ status: 'APPLIED' }).expect(200);
    expect(applied.body).toHaveLength(0);
  });

  it('applies the proposal: appointments move, versions bump, events fan out to reminders', async () => {
    const before = await request(http).get(`/api/v1/scheduling/reschedule-proposals/${proposalId}`).set(auth(ownerToken)).expect(200);
    await request(http)
      .post(`/api/v1/scheduling/reschedule-proposals/${proposalId}/apply`)
      .set(auth(ownerToken))
      .send({ itemAppointmentIds: ['00000000-0000-0000-0000-000000000000'] })
      .expect(400);

    const res = await request(http).post(`/api/v1/scheduling/reschedule-proposals/${proposalId}/apply`).set(auth(ownerToken)).send({}).expect(200);
    expect(res.body.status).toBe('APPLIED');
    expect(res.body.appliedById).toBe(ownerUserId);
    expect(res.body.appliedAt).toBeTruthy();
    for (const item of res.body.items) {
      expect(item.applied).toBe(true);
      expect(item.error).toBeUndefined();
      const appt = await request(http).get(`/api/v1/appointments/${item.appointmentId}`).set(auth(ownerToken)).expect(200);
      expect(new Date(appt.body.startsAt).toISOString()).toBe(item.to);
      expect(new Date(appt.body.endsAt).toISOString()).toBe(item.toEndsAt);
      expect(appt.body.doctorId).toBe(item.toDoctorId);
      expect(appt.body.version).toBe(item.version + 1);
      expect(appt.body.version).toBe(2);
      // Reminders followed the appointment to its new time
      const rows = await poll(async () => {
        const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: item.appointmentId, status: 'PENDING' }).expect(200);
        return r.body.length === 3 && r.body.every((x: { scheduledFor: string }) => new Date(x.scheduledFor) < new Date(item.to)) ? r.body : undefined;
      });
      const expected24 = new Date(new Date(item.to).getTime() - 24 * 3_600_000).toISOString();
      expect(rows.filter((x: { scheduledFor: string }) => new Date(x.scheduledFor).toISOString() === expected24)).toHaveLength(2);
      if (item.to !== item.from) {
        const cancelled = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: item.appointmentId, status: 'CANCELLED' }).expect(200);
        expect(cancelled.body).toHaveLength(3); // the rows for the original time
      }
    }
    // The untouched appointment did not move
    const untouched = await request(http).get(`/api/v1/appointments/${untouchedId}`).set(auth(ownerToken)).expect(200);
    expect(new Date(untouched.body.startsAt).toISOString()).toBe(at('10:00'));
    expect(untouched.body.version).toBe(1);
    expect(before.body.status).toBe('PENDING');

    // Final: cannot apply or dismiss twice
    await request(http).post(`/api/v1/scheduling/reschedule-proposals/${proposalId}/apply`).set(auth(ownerToken)).send({}).expect(409);
    await request(http).post(`/api/v1/scheduling/reschedule-proposals/${proposalId}/dismiss`).set(auth(ownerToken)).expect(409);
  });

  it('records an error on an item whose target slot got taken, applies the rest (partial success)', async () => {
    // Two more appointments of doctor B on the day after, displaced by a time off; then steal one target slot before applying.
    const next = new Date(future.getTime() + 86_400_000).toISOString().slice(0, 10);
    const atNext = (hhmm: string) => `${next}T${hhmm}:00.000Z`;
    const x = await book(doctorB, patients[0], atNext('07:00'));
    const y = await book(doctorB, patients[1], atNext('07:30'));
    const res = await request(http)
      .post('/api/v1/scheduling/reschedule-proposals')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, startsAt: atNext('07:00'), endsAt: atNext('08:00'), searchDays: 3 })
      .expect(201);
    expect(res.body.items).toHaveLength(2);
    const victim = res.body.items.find((i: { appointmentId: string }) => i.appointmentId === x.id);
    const other = res.body.items.find((i: { appointmentId: string }) => i.appointmentId === y.id);
    // Steal the victim's proposed slot
    await book(victim.toDoctorId, patients[2], victim.to, { durationMinutes: 30 });

    const applied = await request(http).post(`/api/v1/scheduling/reschedule-proposals/${res.body.id}/apply`).set(auth(ownerToken)).send({}).expect(200);
    expect(applied.body.status).toBe('PARTIALLY_APPLIED');
    const v = applied.body.items.find((i: { appointmentId: string }) => i.appointmentId === x.id);
    const o = applied.body.items.find((i: { appointmentId: string }) => i.appointmentId === y.id);
    expect(v.applied).toBe(false);
    expect(v.error).toMatch(/overlaps/i);
    expect(o.applied).toBe(true);
    const moved = await request(http).get(`/api/v1/appointments/${y.id}`).set(auth(ownerToken)).expect(200);
    expect(new Date(moved.body.startsAt).toISOString()).toBe(other.to);
    const stuck = await request(http).get(`/api/v1/appointments/${x.id}`).set(auth(ownerToken)).expect(200);
    expect(new Date(stuck.body.startsAt).toISOString()).toBe(atNext('07:00'));

    // A partially applied proposal can still be dismissed
    const dismissed = await request(http).post(`/api/v1/scheduling/reschedule-proposals/${res.body.id}/dismiss`).set(auth(ownerToken)).expect(200);
    expect(dismissed.body.status).toBe('DISMISSED');
    await request(http).post(`/api/v1/scheduling/reschedule-proposals/${res.body.id}/apply`).set(auth(ownerToken)).send({}).expect(409);
  });

  it('returns an empty proposal when no appointment is affected', async () => {
    const res = await request(http)
      .post('/api/v1/scheduling/reschedule-proposals')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, startsAt: at('13:00'), endsAt: at('14:00') })
      .expect(201);
    expect(res.body.items).toEqual([]);
    expect(res.body.unresolvedAppointmentIds).toEqual([]);
    expect(res.body.totalDisplacementMinutes).toBe(0);
    await request(http).get(`/api/v1/scheduling/reschedule-proposals/00000000-0000-0000-0000-000000000000`).set(auth(ownerToken)).expect(404);
  });

  // ─────────────────────────────── §7 reminders ───────────────────────────────

  it('creates reminder rows for a future appointment and the worker pass sends the due ones', async () => {
    const rows = await poll(async () => {
      const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: untouchedId }).expect(200);
      return r.body.length === 3 ? r.body : undefined;
    });
    const start = new Date(at('10:00')).getTime();
    const byKey = new Map(rows.map((r: { channel: string; scheduledFor: string }) => [`${r.channel}:${(start - new Date(r.scheduledFor).getTime()) / 3_600_000}`, r]));
    expect([...byKey.keys()].sort()).toEqual(['EMAIL:24', 'IN_APP:2', 'IN_APP:24']);
    expect(rows.every((r: { status: string; attempts: number }) => r.status === 'PENDING' && r.attempts === 0)).toBe(true);

    // Nothing is due yet
    const idle = await reminders.runOnce();
    expect(idle.claimed).toBe(0);

    // Make them due by moving scheduledFor into the past (directly in the DB, as a system job would see it)
    await tenantContext.runSystem(async () => {
      for (const [i, r] of rows.entries()) {
        await prisma.db.reminder.update({ where: { id: r.id }, data: { scheduledFor: new Date(Date.now() - (i + 1) * 60_000) } });
      }
    });
    const pass = await reminders.runOnce();
    expect(pass.claimed).toBe(3);
    expect(pass.sent).toBe(3);
    expect(pass.failed).toBe(0);

    const sent = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: untouchedId, status: 'SENT' }).expect(200);
    expect(sent.body).toHaveLength(3);
    expect(sent.body.every((r: { attempts: number; sentAt: string | null }) => r.attempts === 1 && r.sentAt)).toBe(true);
    const pending = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: untouchedId, status: 'PENDING' }).expect(200);
    expect(pending.body).toHaveLength(0);

    // The owner (creator of the appointment) received the in-app reminders
    const notifs = await request(http).get('/api/v1/notifications').set(auth(ownerToken)).expect(200);
    const mine = notifs.body.items.filter((n: { type: string; data?: { appointmentId?: string } }) => n.type === 'APPOINTMENT_REMINDER' && n.data?.appointmentId === untouchedId);
    expect(mine).toHaveLength(2);
    expect(mine[0].body).toContain('Pete Four');
    expect(mine[0].body).toContain('Dr. Alma Alpha');

    // A second pass does not resend
    const again = await reminders.runOnce();
    expect(again.claimed).toBe(0);
  });

  it('marks a reminder FAILED when delivery is impossible and cancels reminders of cancelled appointments', async () => {
    const appt = await book(doctorB, patientNoEmail, at('12:00'));
    await poll(async () => {
      const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: appt.id }).expect(200);
      return r.body.length === 3 ? true : undefined;
    });
    await tenantContext.runSystem(() => prisma.db.reminder.updateMany({ where: { appointmentId: appt.id, channel: 'EMAIL' }, data: { scheduledFor: new Date(Date.now() - 1000) } }));
    const pass = await reminders.runOnce();
    expect(pass.claimed).toBe(1);
    expect(pass.failed).toBe(1);
    const failed = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: appt.id, status: 'FAILED' }).expect(200);
    expect(failed.body).toHaveLength(1);
    expect(failed.body[0].lastError).toContain('no email');

    await request(http).post(`/api/v1/appointments/${appt.id}/status`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
    await poll(async () => {
      const r = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: appt.id, status: 'CANCELLED' }).expect(200);
      return r.body.length === 2 ? true : undefined;
    });
    const stillPending = await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ appointmentId: appt.id, status: 'PENDING' }).expect(200);
    expect(stillPending.body).toHaveLength(0);
    await request(http).get('/api/v1/scheduling/reminders').set(auth(ownerToken)).query({ status: 'BOGUS' }).expect(400);
  });

  // ─────────────────────────────── §7 no-show model ───────────────────────────────

  it('refuses to train with fewer than 30 samples and has no model yet', async () => {
    const res = await request(http).post('/api/v1/scheduling/no-show-model/train').set(auth(ownerToken)).expect(400);
    expect(res.body.message).toContain('30');
    await request(http).get('/api/v1/scheduling/no-show-model').set(auth(ownerToken)).expect(404);
  });

  it('trains on synthetic history, returns metrics and scores new appointments', async () => {
    // 40 past outcomes: patients One/Two mostly no-shows (booked far ahead), Three/Four reliable (booked shortly before).
    await tenantContext.runSystem(async () => {
      const data = [];
      for (let i = 0; i < 40; i++) {
        const patientIdx = i % 4;
        const unreliable = patientIdx < 2;
        const noShow = unreliable ? i % 8 !== 0 : i % 8 === 1;
        const startsAt = new Date(Date.now() - (60 - i) * 86_400_000);
        startsAt.setUTCHours(7, (i % 2) * 30, 0, 0);
        data.push({
          clinicId,
          doctorId: patientIdx % 2 === 0 ? doctorA : doctorB,
          patientId: patients[patientIdx],
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          status: noShow ? ('NO_SHOW' as const) : ('COMPLETED' as const),
          type: i % 3 === 0 ? ('FOLLOW_UP' as const) : ('CONSULTATION' as const),
          createdAt: new Date(startsAt.getTime() - (unreliable ? 20 : 2) * 86_400_000),
          createdById: ownerUserId,
        });
      }
      await prisma.db.appointment.createMany({ data });
    });

    const trained = await request(http).post('/api/v1/scheduling/no-show-model/train').set(auth(ownerToken)).expect(200);
    expect(trained.body.clinicId).toBe(clinicId);
    expect(trained.body.sampleSize).toBe(40);
    expect(trained.body.metrics.n).toBe(40);
    expect(trained.body.metrics.auc).toBeGreaterThanOrEqual(0);
    expect(trained.body.metrics.auc).toBeLessThanOrEqual(1);
    expect(trained.body.metrics.auc).toBeGreaterThan(0.7); // the synthetic signal is easy to pick up
    expect(trained.body.metrics.accuracy).toBeGreaterThan(0.5);
    expect(trained.body.metrics.positiveRate).toBeGreaterThan(0);
    expect(trained.body.metrics.positiveRate).toBeLessThan(1);
    expect(trained.body.parameters.featureNames).toContain('historicalNoShowRate');
    expect(typeof trained.body.parameters.weights.leadTimeDays).toBe('number');

    const model = await request(http).get('/api/v1/scheduling/no-show-model').set(auth(ownerToken)).expect(200);
    expect(model.body.id).toBe(trained.body.id);

    // A new booking for an unreliable patient gets scored by the listener.
    const risky = await book(doctorA, patients[0], at('12:30'));
    const scored = await poll(async () => {
      const r = await request(http).get(`/api/v1/appointments/${risky.id}`).set(auth(ownerToken)).expect(200);
      return typeof r.body.noShowRisk === 'number' ? r.body : undefined;
    });
    expect(scored.noShowRisk).toBeGreaterThanOrEqual(0);
    expect(scored.noShowRisk).toBeLessThanOrEqual(1);
    const reliable = await book(doctorB, patients[3], at('12:30'));
    const scoredReliable = await poll(async () => {
      const r = await request(http).get(`/api/v1/appointments/${reliable.id}`).set(auth(ownerToken)).expect(200);
      return typeof r.body.noShowRisk === 'number' ? r.body : undefined;
    });
    expect(scored.noShowRisk).toBeGreaterThan(scoredReliable.noShowRisk);

    // At-risk list for the day (threshold lowered so the ordering can be checked regardless of absolute calibration)
    const atRisk = await request(http).get('/api/v1/scheduling/no-show/at-risk').set(auth(ownerToken)).query({ date, threshold: 0 }).expect(200);
    expect(atRisk.body.date).toBe(date);
    const ids = atRisk.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(risky.id);
    expect(ids.indexOf(risky.id)).toBeLessThan(ids.indexOf(reliable.id));
    const risks = atRisk.body.items.map((a: { noShowRisk: number }) => a.noShowRisk);
    expect([...risks].sort((a, b) => b - a)).toEqual(risks);
    const strict = await request(http).get('/api/v1/scheduling/no-show/at-risk').set(auth(ownerToken)).query({ date }).expect(200);
    expect(strict.body.items.every((a: { noShowRisk: number }) => a.noShowRisk >= 0.5)).toBe(true);
    await request(http).get('/api/v1/scheduling/no-show/at-risk').set(auth(ownerToken)).query({ date: '2026-13-40' }).expect(400);
  });
});
