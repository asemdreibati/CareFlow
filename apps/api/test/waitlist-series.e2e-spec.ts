import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { appointmentInclude, AppointmentWriterService } from '../src/modules/waitlist/appointment-writer.service.js';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service.js';

/**
 * Waitlist backfill + recurring series end to end against the local database.
 * Registers its own clinic (timezone Asia/Riyadh, UTC+3, no DST) so it never touches seeded data.
 */
describe('Waitlist + series (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;
  let waitlistService: WaitlistService;
  let prisma: PrismaService;
  let writer: AppointmentWriterService;
  let clinicId: string;

  const ts = Date.now();
  const slug = `wl-series-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@wl-series.local`;
  const doctorEmail = `doctor-${ts}@wl-series.local`;

  let ownerToken: string;
  let doctorToken: string;
  let doctorId: string;
  let patientA: string;
  let patientB: string;
  let entryId: string;

  // Calendar dates (YYYY-MM-DD); availability covers every weekday so the weekday does not matter.
  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const D1 = day(7); // waitlist day
  const D2 = day(14); // series start
  // Riyadh is UTC+3: 10:00 local = 07:00Z.
  const at = (date: string, hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function poll<T>(fn: () => Promise<T | undefined>, attempts = 30, delayMs = 150): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('poll timed out');
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function bookAppointment(patientId: string, startsAt: string, durationMinutes = 30) {
    const res = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt, durationMinutes }).expect(201);
    return res.body as { id: string; startsAt: string; endsAt: string };
  }

  async function cancelAppointment(id: string) {
    await request(http).post(`/api/v1/appointments/${id}/status`).set(auth(ownerToken)).send({ status: 'CANCELLED', cancellationNote: 'Patient request' }).expect(200);
  }

  async function getEntry(id: string) {
    const res = await request(http).get(`/api/v1/waitlist/${id}`).set(auth(ownerToken)).expect(200);
    return res.body;
  }

  async function getAppointment(id: string) {
    const res = await request(http).get(`/api/v1/appointments/${id}`).set(auth(ownerToken)).expect(200);
    return res.body;
  }

  async function waitForOffer(id: string) {
    return poll(async () => {
      const e = await getEntry(id);
      return e.status === 'OFFERED' ? e : undefined;
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();
    waitlistService = app.get(WaitlistService);
    prisma = app.get(PrismaService);
    writer = app.get(AppointmentWriterService);

    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Waitlist Series Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;
    clinicId = reg.body.session.clinic.id;

    const member = await request(http)
      .post('/api/v1/members')
      .set(auth(ownerToken))
      .send({ email: doctorEmail, firstName: 'Dana', lastName: 'Doctor', role: 'DOCTOR', password })
      .expect(201);
    const doc = await request(http)
      .post('/api/v1/doctors')
      .set(auth(ownerToken))
      .send({ firstName: 'Dana', lastName: 'Doctor', specialty: 'General', userId: member.body.user.id })
      .expect(201);
    doctorId = doc.body.id;
    await request(http)
      .put(`/api/v1/doctors/${doctorId}/availability`)
      .set(auth(ownerToken))
      .send({ slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) })
      .expect(200);

    const a = await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: 'Wanda', lastName: 'Waiting' }).expect(201);
    patientA = a.body.id;
    const b = await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: 'Bob', lastName: 'Booked' }).expect(201);
    patientB = b.body.id;

    const login = await request(http).post('/api/v1/auth/login').send({ email: doctorEmail, password }).expect(200);
    doctorToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    // Let asynchronous event listeners (notifications, reminders, backfill) finish before the DB disconnects.
    await sleep(800);
    await app.close();
  });

  // ─────────────────────────────── waitlist ───────────────────────────────

  describe('waitlist', () => {
    it('creates an entry and validates doctor/specialty', async () => {
      await request(http).post('/api/v1/waitlist').set(auth(ownerToken)).send({ patientId: patientA }).expect(400);
      await request(http).post('/api/v1/waitlist').set(auth(ownerToken)).send({ patientId: patientA, doctorId, bogus: 1 }).expect(400);
      const res = await request(http)
        .post('/api/v1/waitlist')
        .set(auth(ownerToken))
        .send({ patientId: patientA, doctorId, durationMinutes: 30, priority: 'SOON', latestAt: at(day(9), '00:00'), notes: 'Knee follow-up' })
        .expect(201);
      entryId = res.body.id;
      expect(res.body).toMatchObject({ status: 'WAITING', priority: 'SOON', specialty: 'General', offerCount: 0, offeredAppointmentId: null });
      expect(res.body.patient).toMatchObject({ id: patientA, firstName: 'Wanda' });
      expect(res.body.doctor).toMatchObject({ id: doctorId, lastName: 'Doctor' });

      const list = await request(http).get('/api/v1/waitlist').set(auth(ownerToken)).query({ status: 'WAITING', doctorId }).expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].id).toBe(entryId);
      await request(http).get('/api/v1/waitlist').expect(401);
    });

    it('computes matches as free slots of the doctor within the entry bounds', async () => {
      const booked = await bookAppointment(patientB, at(D1, '07:00')); // 10:00 Riyadh
      const res = await request(http).get(`/api/v1/waitlist/matches/${entryId}`).set(auth(ownerToken)).expect(200);
      expect(res.body.entry.id).toBe(entryId);
      const candidates: { doctor: { id: string }; startsAt: string; endsAt: string }[] = res.body.candidates;
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(20);
      expect(candidates.every((c) => c.doctor.id === doctorId)).toBe(true);
      expect(candidates.every((c) => new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime() === 30 * 60_000)).toBe(true);
      const starts = candidates.map((c) => new Date(c.startsAt).getTime());
      expect([...starts].sort((x, y) => x - y)).toEqual(starts);
      expect(starts[0]).toBeGreaterThanOrEqual(Date.now() - 60_000);
      expect(candidates.some((c) => c.startsAt === booked.startsAt)).toBe(false);
      // Every candidate is inside the doctor's 09:00–17:00 Riyadh day (06:00–14:00Z)
      for (const c of candidates) {
        const h = new Date(c.startsAt).getUTCHours();
        expect(h).toBeGreaterThanOrEqual(6);
        expect(h).toBeLessThan(14);
      }
      // Remember the booked appointment for the backfill test
      (globalThis as { __wlBooked?: typeof booked }).__wlBooked = booked;
    });

    it('offers the freed slot (timed hold) when a matching appointment is cancelled, and notifies', async () => {
      const booked = (globalThis as { __wlBooked?: { id: string; startsAt: string; endsAt: string } }).__wlBooked as { id: string; startsAt: string; endsAt: string };
      await cancelAppointment(booked.id);

      const entry = await waitForOffer(entryId);
      expect(entry.offeredAppointmentId).toBeTruthy();
      expect(entry.offerExpiresAt).toBeTruthy();
      expect(entry.offeredAppointment.startsAt).toBe(booked.startsAt);
      expect(entry.offeredAppointment.endsAt).toBe(booked.endsAt);

      const hold = await getAppointment(entry.offeredAppointmentId);
      expect(hold).toMatchObject({ status: 'SCHEDULED', notes: 'Waitlist offer', patientId: patientA, doctorId });
      expect(hold.holdExpiresAt).toBeTruthy();
      const ttl = new Date(hold.holdExpiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(23 * 3_600_000);
      expect(ttl).toBeLessThanOrEqual(24 * 3_600_000);

      // The entry creator (owner) and the doctor's user are notified with a "Waitlist offer"
      const ownerNotif = await poll(async () => {
        const res = await request(http).get('/api/v1/notifications').set(auth(ownerToken)).expect(200);
        return res.body.items.find((n: { title: string; data?: { waitlistEntryId?: string } }) => n.title === 'Waitlist offer' && n.data?.waitlistEntryId === entryId);
      });
      expect(ownerNotif.type).toBe('APPOINTMENT_CREATED');
      expect(ownerNotif.data.appointmentId).toBe(entry.offeredAppointmentId);
      expect(ownerNotif.body).toContain('Wanda Waiting');
      await poll(async () => {
        const res = await request(http).get('/api/v1/notifications').set(auth(doctorToken)).expect(200);
        return res.body.items.find((n: { title: string; data?: { waitlistEntryId?: string } }) => n.title === 'Waitlist offer' && n.data?.waitlistEntryId === entryId);
      });

      // The held slot is no longer bookable by someone else
      await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId: patientB, startsAt: booked.startsAt }).expect(409);
      // Accept/decline are the only moves while OFFERED
      await request(http).post(`/api/v1/waitlist/${entryId}/book`).set(auth(ownerToken)).send({ doctorId, startsAt: at(D1, '12:00') }).expect(409);
    });

    it('declining cancels the hold and returns the entry to WAITING without re-offering', async () => {
      const before = await getEntry(entryId);
      const holdId = before.offeredAppointmentId as string;
      const res = await request(http).post(`/api/v1/waitlist/${entryId}/decline`).set(auth(ownerToken)).expect(200);
      expect(res.body).toMatchObject({ status: 'WAITING', offerCount: 1, offeredAppointmentId: null, offerExpiresAt: null });
      const hold = await getAppointment(holdId);
      expect(hold).toMatchObject({ status: 'CANCELLED', cancellationNote: 'Waitlist offer declined' });

      // The cancelled hold must not trigger a new offer for the same slot
      await sleep(600);
      const after = await getEntry(entryId);
      expect(after.status).toBe('WAITING');
      expect(after.offeredAppointmentId).toBeNull();
      await request(http).post(`/api/v1/waitlist/${entryId}/decline`).set(auth(ownerToken)).expect(409);
      await request(http).post(`/api/v1/waitlist/${entryId}/accept`).set(auth(ownerToken)).expect(409);
    });

    it('expires a hold whose time passed (service routine), freeing the slot and counting the offer', async () => {
      const booked = await bookAppointment(patientB, at(D1, '08:00')); // 11:00 Riyadh
      await cancelAppointment(booked.id);
      const entry = await waitForOffer(entryId);
      const holdId = entry.offeredAppointmentId as string;
      expect((await getAppointment(holdId)).startsAt).toBe(booked.startsAt);

      // Nothing expires yet…
      const none = await waitlistService.expireHolds(new Date());
      expect((await getEntry(entryId)).status).toBe('OFFERED');
      expect(none.expired).toBe(0);

      // …but 25 hours later the hold is gone and the entry waits again.
      const result = await waitlistService.expireHolds(new Date(Date.now() + 25 * 3_600_000));
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const after = await getEntry(entryId);
      expect(after).toMatchObject({ status: 'WAITING', offerCount: 2, offeredAppointmentId: null, offerExpiresAt: null });
      const hold = await getAppointment(holdId);
      expect(hold).toMatchObject({ status: 'CANCELLED', cancellationNote: 'Hold expired' });
      // The freed slot can be booked again
      await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId: patientB, startsAt: booked.startsAt }).expect(201);
    });

    it('accepting an offer turns the hold into a firm appointment (entry BOOKED)', async () => {
      const booked = await bookAppointment(patientB, at(D1, '09:00')); // 12:00 Riyadh
      await cancelAppointment(booked.id);
      const entry = await waitForOffer(entryId);
      const res = await request(http).post(`/api/v1/waitlist/${entryId}/accept`).set(auth(ownerToken)).expect(200);
      expect(res.body.entry).toMatchObject({ id: entryId, status: 'BOOKED', offeredAppointmentId: entry.offeredAppointmentId, offerExpiresAt: null });
      expect(res.body.appointment).toMatchObject({ id: entry.offeredAppointmentId, status: 'SCHEDULED', holdExpiresAt: null, patientId: patientA });
      expect(res.body.appointment.doctor.userId).toBeUndefined();
      // A booked entry is final
      await request(http).patch(`/api/v1/waitlist/${entryId}`).set(auth(ownerToken)).send({ priority: 'URGENT' }).expect(409);
      // No more offers for it: cancelling another appointment leaves it BOOKED
      const other = await bookAppointment(patientB, at(D1, '10:00'));
      await cancelAppointment(other.id);
      await sleep(600);
      expect((await getEntry(entryId)).status).toBe('BOOKED');
    });

    it('books one of the matches directly and cancels entries', async () => {
      const created = await request(http)
        .post('/api/v1/waitlist')
        .set(auth(ownerToken))
        .send({ patientId: patientB, specialty: 'General', durationMinutes: 60, preferredWindows: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }] })
        .expect(201);
      expect(created.body.doctor).toBeNull();
      const id = created.body.id;
      const updated = await request(http).patch(`/api/v1/waitlist/${id}`).set(auth(ownerToken)).send({ priority: 'URGENT', preferredWindows: [] }).expect(200);
      expect(updated.body.priority).toBe('URGENT');
      expect(updated.body.preferredWindows).toEqual([]);

      // Slot 15:00 Riyadh (12:00Z) for 60 minutes
      const booked = await request(http).post(`/api/v1/waitlist/${id}/book`).set(auth(ownerToken)).send({ doctorId, startsAt: at(D1, '12:00') }).expect(201);
      expect(booked.body.entry).toMatchObject({ id, status: 'BOOKED' });
      expect(booked.body.appointment).toMatchObject({ doctorId, patientId: patientB, startsAt: at(D1, '12:00'), endsAt: at(D1, '13:00'), status: 'SCHEDULED' });
      expect(booked.body.entry.offeredAppointmentId).toBe(booked.body.appointment.id);
      // Booking twice is rejected, as is a conflicting direct booking
      await request(http).post(`/api/v1/waitlist/${id}/book`).set(auth(ownerToken)).send({ doctorId, startsAt: at(D1, '12:00') }).expect(409);
      const another = await request(http).post('/api/v1/waitlist').set(auth(ownerToken)).send({ patientId: patientB, doctorId }).expect(201);
      await request(http).post(`/api/v1/waitlist/${another.body.id}/book`).set(auth(ownerToken)).send({ doctorId, startsAt: at(D1, '12:30') }).expect(409);
      await request(http).post(`/api/v1/waitlist/${another.body.id}/book`).set(auth(ownerToken)).send({ doctorId, startsAt: at(D1, '03:00') }).expect(400); // outside availability

      const removed = await request(http).delete(`/api/v1/waitlist/${another.body.id}`).set(auth(ownerToken)).expect(200);
      expect(removed.body.status).toBe('CANCELLED');
      await request(http).get('/api/v1/waitlist/00000000-0000-0000-0000-000000000000').set(auth(ownerToken)).expect(404);
    });
  });

  // ─────────────────────────────── series ───────────────────────────────

  describe('series', () => {
    let seriesId: string;
    let detachedId: string;
    const weekLater = (n: number) => new Date(new Date(`${D2}T00:00:00.000Z`).getTime() + n * 7 * 86_400_000).toISOString().slice(0, 10);
    // 13:00 Riyadh = 10:00Z
    const rule = { doctorId, frequency: 'WEEKLY', startsOn: D2, startTime: '13:00', durationMinutes: 30, count: 4 };

    it('validates the rule', async () => {
      const body = { ...rule, doctorId, patientId: patientA };
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, until: weekLater(4) }).expect(400); // count AND until
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, count: undefined }).expect(400); // neither
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, startTime: '7:00' }).expect(400);
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, byMonthDay: 5 }).expect(400); // not MONTHLY
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, resolve: 'maybe' }).expect(400);
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, startsOn: '2020-01-01', count: 1 }).expect(400); // in the past
    });

    it('creates weekly x4 and moves a conflicting occurrence to the next slot (exception)', async () => {
      // Occupy the second occurrence's slot beforehand
      const blocker = await bookAppointment(patientB, at(weekLater(1), '10:00'));
      expect(blocker.startsAt).toBe(at(weekLater(1), '10:00'));

      const res = await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...rule, doctorId, patientId: patientA, reason: 'Physio' }).expect(201);
      seriesId = res.body.series.id;
      expect(res.body.series).toMatchObject({ frequency: 'WEEKLY', count: 4, status: 'ACTIVE', doctorId, patientId: patientA, type: 'FOLLOW_UP' });
      expect(res.body.skipped).toEqual([]);
      const created: { occurrenceIndex: number; startsAt: string; endsAt: string; isException: boolean; seriesId: string; status: string; doctor: { userId?: string } }[] = res.body.created;
      expect(created).toHaveLength(4);
      expect(created.map((c) => c.occurrenceIndex)).toEqual([0, 1, 2, 3]);
      expect(created.every((c) => c.seriesId === seriesId && c.status === 'SCHEDULED' && c.doctor.userId === undefined)).toBe(true);
      expect(created[0]).toMatchObject({ startsAt: at(weekLater(0), '10:00'), endsAt: at(weekLater(0), '10:30'), isException: false });
      expect(created[1]).toMatchObject({ startsAt: at(weekLater(1), '10:30'), endsAt: at(weekLater(1), '11:00'), isException: true });
      expect(created[2]).toMatchObject({ startsAt: at(weekLater(2), '10:00'), isException: false });
      expect(created[3]).toMatchObject({ startsAt: at(weekLater(3), '10:00'), isException: false });

      const one = await request(http).get(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).expect(200);
      expect(one.body.occurrences.map((o: { occurrenceIndex: number }) => o.occurrenceIndex)).toEqual([0, 1, 2, 3]);
      expect(one.body.doctor).toMatchObject({ id: doctorId });
      expect(one.body.patient).toMatchObject({ id: patientA });

      const list = await request(http).get('/api/v1/series').set(auth(ownerToken)).query({ patientId: patientA, status: 'ACTIVE' }).expect(200);
      expect(list.body.some((s: { id: string; occurrenceCount: number }) => s.id === seriesId && s.occurrenceCount === 4)).toBe(true);

      // Occurrences are real appointments: the doctor sees them and the slots are taken
      const cal = await request(http).get('/api/v1/appointments').set(auth(doctorToken)).query({ from: at(weekLater(0), '00:00'), to: at(weekLater(3), '23:59') }).expect(200);
      expect(cal.body.items.filter((a: { seriesId: string | null }) => a.seriesId === seriesId)).toHaveLength(4);
      await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId: patientB, startsAt: at(weekLater(2), '10:00') }).expect(409);
    });

    it('fail policy returns 409 with the conflicting occurrences and creates nothing', async () => {
      const before = await request(http).get('/api/v1/series').set(auth(ownerToken)).expect(200);
      const res = await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...rule, doctorId, patientId: patientB, resolve: 'fail' }).expect(409);
      expect(res.body.conflicts).toHaveLength(4);
      expect(res.body.conflicts.map((c: { index: number }) => c.index)).toEqual([0, 1, 2, 3]);
      expect(res.body.conflicts[0].plannedStartsAt).toBe(at(weekLater(0), '10:00'));
      expect(res.body.conflicts[0].reason).toMatch(/overlap/i);
      const after = await request(http).get('/api/v1/series').set(auth(ownerToken)).expect(200);
      expect(after.body).toHaveLength(before.body.length);
      // Nothing was inserted for patient B at those times
      const appts = await request(http).get('/api/v1/appointments').set(auth(ownerToken)).query({ patientId: patientB, from: at(weekLater(0), '09:00'), to: at(weekLater(0), '11:00') }).expect(200);
      expect(appts.body.total).toBe(0);
    });

    it('skip policy drops conflicting occurrences', async () => {
      const res = await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...rule, doctorId, patientId: patientB, count: 3, resolve: 'skip' }).expect(201);
      expect(res.body.created).toEqual([]);
      expect(res.body.skipped.map((s: { index: number }) => s.index)).toEqual([0, 1, 2]);
      // Partial conflict: one week later at 13:30 only the second week is free (the moved exception sits at 13:30)
      const partial = await request(http)
        .post('/api/v1/series')
        .set(auth(ownerToken))
        .send({ ...rule, doctorId, patientId: patientB, startTime: '13:30', count: 2, resolve: 'skip' })
        .expect(201);
      expect(partial.body.created.map((c: { occurrenceIndex: number }) => c.occurrenceIndex)).toEqual([0]);
      expect(partial.body.skipped.map((s: { index: number }) => s.index)).toEqual([1]);
      // Clean up so the slot is free for the other tests
      await request(http).patch(`/api/v1/series/${partial.body.series.id}`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
    });

    it('detaches one occurrence so it can be edited independently', async () => {
      const res = await request(http).post(`/api/v1/series/${seriesId}/occurrences/0/detach`).set(auth(ownerToken)).expect(200);
      detachedId = res.body.id;
      expect(res.body).toMatchObject({ seriesId: null, isException: true, occurrenceIndex: 0, status: 'SCHEDULED' });
      await request(http).post(`/api/v1/series/${seriesId}/occurrences/0/detach`).set(auth(ownerToken)).expect(404);
      await request(http).post(`/api/v1/series/${seriesId}/occurrences/99/detach`).set(auth(ownerToken)).expect(404);
      const one = await request(http).get(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).expect(200);
      expect(one.body.occurrences.map((o: { occurrenceIndex: number }) => o.occurrenceIndex)).toEqual([1, 2, 3]);
    });

    it('cancel-future cancels the remaining occurrences and leaves the detached one', async () => {
      const edited = await request(http).patch(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).send({ reason: 'Physio (updated)' }).expect(200);
      expect(edited.body).toMatchObject({ status: 'ACTIVE', reason: 'Physio (updated)', cancelledCount: 0 });

      const res = await request(http).patch(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancelledCount).toBe(3);
      expect(res.body.cancelled.map((c: { occurrenceIndex: number }) => c.occurrenceIndex)).toEqual([1, 2, 3]);
      expect(res.body.cancelled.every((c: { status: string; cancellationNote: string }) => c.status === 'CANCELLED' && c.cancellationNote === 'Series cancelled')).toBe(true);

      expect((await getAppointment(detachedId)).status).toBe('SCHEDULED');
      const one = await request(http).get(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).expect(200);
      expect(one.body.occurrences.every((o: { status: string }) => o.status === 'CANCELLED')).toBe(true);
      await request(http).patch(`/api/v1/series/${seriesId}`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(409);
      // The slots are free again
      await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId: patientB, startsAt: at(weekLater(2), '10:00') }).expect(201);
    });
  });

  // ─────────────────────────────── review regressions ───────────────────────────────

  describe('hold lifecycle and series regressions', () => {
    let seq = 0;
    // Each test gets its own doctor with a unique specialty so no other entry matches its slots.
    async function newDoctor() {
      seq++;
      const doc = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName: `Reg${seq}`, lastName: 'Doc', specialty: `Reg-${ts}-${seq}` }).expect(201);
      await request(http)
        .put(`/api/v1/doctors/${doc.body.id}/availability`)
        .set(auth(ownerToken))
        .send({ slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) })
        .expect(200);
      return doc.body.id as string;
    }
    async function newPatient(name: string) {
      return (await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: name, lastName: 'Reg' }).expect(201)).body.id as string;
    }
    async function bookWith(doc: string, patientId: string, startsAt: string, extra: Record<string, unknown> = {}) {
      const res = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId: doc, patientId, startsAt, durationMinutes: 30, ...extra }).expect(201);
      return res.body as { id: string; startsAt: string };
    }
    async function setStatus(id: string, status: string) {
      return request(http).post(`/api/v1/appointments/${id}/status`).set(auth(ownerToken)).send({ status }).expect(200);
    }
    async function enqueue(patientId: string, doc: string, extra: Record<string, unknown> = {}) {
      return (await request(http).post('/api/v1/waitlist').set(auth(ownerToken)).send({ patientId, doctorId: doc, durationMinutes: 30, ...extra }).expect(201)).body as { id: string };
    }
    /** An entry holding an offer for a freshly cancelled slot of `doc` on `date` at `hhmmUtc`. */
    async function offeredHold(doc: string, date: string, hhmmUtc: string, extra: Record<string, unknown> = {}) {
      const waiting = await newPatient('Waiting');
      const entry = await enqueue(waiting, doc, extra);
      const blocker = await bookWith(doc, await newPatient('Blocker'), at(date, hhmmUtc));
      await cancelAppointment(blocker.id);
      const offered = await waitForOffer(entry.id);
      return { entryId: entry.id, holdId: offered.offeredAppointmentId as string, patientId: waiting };
    }
    const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);

    it('a confirmed / checked-in hold is settled and never cancelled by the expiry job', async () => {
      const doc = await newDoctor();
      const { entryId: e, holdId } = await offeredHold(doc, day(3), '07:00');
      await setStatus(holdId, 'CONFIRMED');
      const confirmed = await getAppointment(holdId);
      expect(confirmed.holdExpiresAt).toBeNull();
      expect(confirmed.notes).toBe('Booked from waitlist');
      expect(await getEntry(e)).toMatchObject({ status: 'BOOKED', offeredAppointmentId: holdId, offerExpiresAt: null });
      for (const s of ['CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) await setStatus(holdId, s);
      await waitlistService.expireHolds(later(25));
      expect((await getAppointment(holdId)).status).toBe('COMPLETED');
    });

    it('the expiry job only cancels SCHEDULED holds and settles progressed ones (portal / SMS confirmations)', async () => {
      const doc = await newDoctor();
      // Confirmed outside AppointmentsService (as the portal / SMS reply do): the expiry job must not cancel it.
      const a = await offeredHold(doc, day(3), '08:00');
      await tenantContext.runSystem(() => prisma.db.appointment.update({ where: { id: a.holdId }, data: { status: 'CONFIRMED' } }));
      const result = await waitlistService.expireHolds(later(25));
      expect(result.settled).toBeGreaterThanOrEqual(1);
      expect(await getAppointment(a.holdId)).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null });
      expect((await getEntry(a.entryId)).status).toBe('BOOKED');

      // The appointment.updated event of such a confirmation settles the hold right away.
      const b = await offeredHold(doc, day(3), '09:00');
      const row = await tenantContext.run({ requestId: 'test', clinicId }, () =>
        prisma.transaction((tx) => tx.appointment.update({ where: { id: b.holdId }, data: { status: 'CONFIRMED', version: { increment: 1 } }, include: appointmentInclude })),
      );
      await tenantContext.run({ requestId: 'test', clinicId }, async () => writer.emitUpdated(row, 'test'));
      await poll(async () => ((await getEntry(b.entryId)).status === 'BOOKED' ? true : undefined));
      expect((await getAppointment(b.holdId)).holdExpiresAt).toBeNull();
    });

    it('a hold cancelled by staff or marked NO_SHOW sends its entry back to WAITING; stale offers are swept', async () => {
      const doc = await newDoctor();
      const a = await offeredHold(doc, day(4), '07:00');
      await setStatus(a.holdId, 'CANCELLED');
      expect(await getEntry(a.entryId)).toMatchObject({ status: 'WAITING', offerCount: 1, offeredAppointmentId: null, offerExpiresAt: null });

      const doc2 = await newDoctor();
      const b = await offeredHold(doc2, day(4), '08:00');
      await setStatus(b.holdId, 'NO_SHOW');
      expect(await getEntry(b.entryId)).toMatchObject({ status: 'WAITING', offerCount: 1, offeredAppointmentId: null });

      // An entry left OFFERED for a dead appointment (e.g. by an older writer) is released by the job.
      await tenantContext.runSystem(() =>
        prisma.db.waitlistEntry.update({ where: { id: b.entryId }, data: { status: 'OFFERED', offeredAppointmentId: b.holdId, offerExpiresAt: later(-1) } }),
      );
      const result = await waitlistService.expireHolds(new Date());
      expect(result.released).toBeGreaterThanOrEqual(1);
      expect(await getEntry(b.entryId)).toMatchObject({ status: 'WAITING', offerCount: 2, offeredAppointmentId: null });
    });

    it('cancelling an accepted waitlist appointment backfills the slot for the next entry', async () => {
      const doc = await newDoctor();
      const first = await offeredHold(doc, day(5), '07:00', { priority: 'URGENT' });
      const second = await enqueue(await newPatient('Second'), doc);
      const accepted = await request(http).post(`/api/v1/waitlist/${first.entryId}/accept`).set(auth(ownerToken)).expect(200);
      expect(accepted.body.appointment).toMatchObject({ holdExpiresAt: null, notes: 'Booked from waitlist' });
      await cancelAppointment(first.holdId);
      const offered = await waitForOffer(second.id);
      expect(offered.offeredAppointment.startsAt).toBe(at(day(5), '07:00'));
      expect((await getEntry(first.entryId)).status).toBe('BOOKED');
    });

    it('concurrent backfills (series cancel) give one entry exactly one hold', async () => {
      const doc = await newDoctor();
      const owner = await newPatient('Series');
      const series = await request(http)
        .post('/api/v1/series')
        .set(auth(ownerToken))
        .send({ doctorId: doc, patientId: owner, frequency: 'DAILY', startsOn: day(6), startTime: '13:00', durationMinutes: 30, count: 4 })
        .expect(201);
      const waiting = await newPatient('Single');
      const entry = await enqueue(waiting, doc);
      await request(http).patch(`/api/v1/series/${series.body.series.id}`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
      const offered = await waitForOffer(entry.id);
      await sleep(1500); // let every backfill listener finish
      const appts = await request(http).get('/api/v1/appointments').set(auth(ownerToken)).query({ patientId: waiting, pageSize: 50 }).expect(200);
      const holds = appts.body.items.filter((a: { status: string }) => a.status !== 'CANCELLED');
      expect(holds).toHaveLength(1);
      expect(holds[0].id).toBe((await getEntry(entry.id)).offeredAppointmentId);
      expect(offered.status).toBe('OFFERED');
    });

    it('series cancel releases resource bookings', async () => {
      const doc = await newDoctor();
      const other = await newDoctor();
      const p = await newPatient('Room');
      const room = (await request(http).post('/api/v1/resources').set(auth(ownerToken)).send({ name: `Room ${ts}`, type: 'ROOM' }).expect(201)).body.id as string;
      const series = await request(http)
        .post('/api/v1/series')
        .set(auth(ownerToken))
        .send({ doctorId: doc, patientId: p, frequency: 'WEEKLY', startsOn: day(30), startTime: '13:00', durationMinutes: 30, count: 2 })
        .expect(201);
      const occ = series.body.created[1];
      await request(http).patch(`/api/v1/appointments/${occ.id}`).set(auth(ownerToken)).send({ resourceIds: [room] }).expect(200);
      await request(http).patch(`/api/v1/series/${series.body.series.id}`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
      const bookings = await request(http).get(`/api/v1/resources/${room}/bookings`).set(auth(ownerToken)).query({ from: at(day(29), '00:00'), to: at(day(45), '00:00') }).expect(200);
      expect(bookings.body.bookings).toHaveLength(1);
      expect(bookings.body.bookings[0].active).toBe(false);
      await bookWith(other, p, occ.startsAt, { resourceIds: [room] });
    });

    it('next-slot never lands in time off loaded before the planned time (moves to the first free slot)', async () => {
      const doc = await newDoctor();
      const p = await newPatient('Moved');
      const D = day(20);
      // Riyadh: 09:00–10:00 and 12:00–17:00 local are time off; the occurrence is planned at 16:00 local.
      await request(http).post(`/api/v1/doctors/${doc}/time-off`).set(auth(ownerToken)).send({ startsAt: at(D, '06:00'), endsAt: at(D, '07:00') }).expect(201);
      await request(http).post(`/api/v1/doctors/${doc}/time-off`).set(auth(ownerToken)).send({ startsAt: at(D, '09:00'), endsAt: at(D, '14:00') }).expect(201);
      const res = await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ doctorId: doc, patientId: p, frequency: 'DAILY', startsOn: D, startTime: '16:00', durationMinutes: 30, count: 1 }).expect(201);
      expect(res.body.skipped).toEqual([]);
      expect(res.body.created[0]).toMatchObject({ startsAt: at(D, '07:00'), isException: true });
    });

    it('next-slot skips an earlier appointment of the day instead of failing the whole series', async () => {
      const doc = await newDoctor();
      const p = await newPatient('Moved2');
      const D = day(21);
      await bookWith(doc, await newPatient('Early'), at(D, '06:00'));
      await request(http).post(`/api/v1/doctors/${doc}/time-off`).set(auth(ownerToken)).send({ startsAt: at(D, '09:00'), endsAt: at(D, '14:00') }).expect(201);
      const res = await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ doctorId: doc, patientId: p, frequency: 'DAILY', startsOn: D, startTime: '16:00', durationMinutes: 30, count: 3 }).expect(201);
      expect(res.body.created).toHaveLength(3);
      expect(res.body.created[0]).toMatchObject({ startsAt: at(D, '06:30'), isException: true });
      expect(res.body.created[1]).toMatchObject({ startsAt: at(day(22), '13:00'), isException: false });
    });

    it('rejects an interval above the database bound (52) with 400', async () => {
      const doc = await newDoctor();
      const p = await newPatient('Interval');
      const body = { doctorId: doc, patientId: p, frequency: 'WEEKLY', startsOn: day(10), startTime: '10:00', durationMinutes: 30, count: 1 };
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, interval: 53 }).expect(400);
      await request(http).post('/api/v1/series').set(auth(ownerToken)).send({ ...body, interval: 52 }).expect(201);
    });
  });
});
