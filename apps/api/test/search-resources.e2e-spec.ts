import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

/**
 * Smart slot search, resources, idempotency and optimistic locking end to end
 * (docs/SCHEDULING.md §1–3). Registers its own clinic (Asia/Riyadh, UTC+3) so it
 * never touches seeded data.
 */
describe('Slot search + resources + booking robustness (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;

  const ts = Date.now();
  const slug = `search-test-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@search-test.local`;
  const doctorEmail = `doctor-${ts}@search-test.local`;

  let ownerToken: string;
  let doctorToken: string;
  let doctorA: string; // "Adams" – linked to the DOCTOR member
  let doctorB: string; // "Baker"
  let patientId: string;
  let roomId: string;
  let scannerId: string;

  // A date one week from now. Availability covers every weekday so the weekday does not matter.
  const future = new Date(Date.now() + 7 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  // Riyadh is UTC+3 (no DST): 09:00 local = 06:00Z.
  const at = (hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const everyDay = (slotMinutes: number) => [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes }));

  interface Candidate {
    doctor: { id: string; firstName: string; lastName: string; specialty: string };
    startsAt: string;
    endsAt: string;
    score: number;
    reasons: string[];
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Search Test Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;

    const member = await request(http)
      .post('/api/v1/members')
      .set(auth(ownerToken))
      .send({ email: doctorEmail, firstName: 'Alice', lastName: 'Adams', role: 'DOCTOR', password })
      .expect(201);

    const a = await request(http)
      .post('/api/v1/doctors')
      .set(auth(ownerToken))
      .send({ firstName: 'Alice', lastName: 'Adams', specialty: 'General', userId: member.body.user.id })
      .expect(201);
    doctorA = a.body.id;
    await request(http).put(`/api/v1/doctors/${doctorA}/availability`).set(auth(ownerToken)).send({ slots: everyDay(30) }).expect(200);

    const b = await request(http).post('/api/v1/doctors').set(auth(ownerToken)).send({ firstName: 'Bob', lastName: 'Baker', specialty: 'General' }).expect(201);
    doctorB = b.body.id;
    await request(http).put(`/api/v1/doctors/${doctorB}/availability`).set(auth(ownerToken)).send({ slots: everyDay(30) }).expect(200);

    const patient = await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: 'Pat', lastName: 'Patient' }).expect(201);
    patientId = patient.body.id;

    const login = await request(http).post('/api/v1/auth/login').send({ email: doctorEmail, password }).expect(200);
    doctorToken = login.body.tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────── §1 smart search ───────────────────────────────

  it('ranks candidate slots across two doctors with reasons', async () => {
    const res = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: at('14:00'), limit: 6 })
      .expect(200);
    expect(res.body.query).toMatchObject({ durationMinutes: 30, timezone: 'Asia/Riyadh', limit: 6 });
    const candidates: Candidate[] = res.body.candidates;
    expect(candidates).toHaveLength(6);
    // Both doctors tie at 09:00 Riyadh; ties are broken deterministically and scores never decrease.
    expect(candidates[0].startsAt).toBe(at('06:00'));
    expect(candidates[1].startsAt).toBe(at('06:00'));
    expect(new Set(candidates.slice(0, 2).map((c) => c.doctor.id))).toEqual(new Set([doctorA, doctorB]));
    expect(candidates[0].endsAt).toBe(at('06:30'));
    expect(candidates[0].score).toBe(0);
    for (let i = 1; i < candidates.length; i++) expect(candidates[i].score).toBeGreaterThanOrEqual(candidates[i - 1].score);
    expect(candidates[0].reasons).toEqual(expect.arrayContaining(['Earliest possible start', 'Doctor has a free day']));
    expect(candidates[0].doctor).toMatchObject({ specialty: 'General' });
  });

  it('respects preferredDoctorId, durationMinutes, preferredWindows, doctorId and specialty', async () => {
    const preferred = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 60, from: at('06:00'), to: at('14:00'), preferredDoctorId: doctorB, limit: 5 })
      .expect(200);
    const candidates: Candidate[] = preferred.body.candidates;
    expect(candidates.every((c) => c.doctor.id === doctorB)).toBe(true); // the 6h bonus outranks the other doctor's whole morning
    expect(candidates[0]).toMatchObject({ startsAt: at('06:00'), endsAt: at('07:00'), score: -6 });
    expect(candidates[0].reasons).toContain('Preferred doctor');
    for (const c of candidates) expect(new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime()).toBe(60 * 60_000);

    // Preferred window 10:00–11:00 Riyadh (07:00Z) on this weekday: −3h beats the soonness of the 09:00 and 09:30 slots.
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const windows = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: at('14:00'), doctorId: doctorA, preferredWindows: JSON.stringify([{ weekday, startTime: '10:00', endTime: '11:00' }]), limit: 3 })
      .expect(200);
    const w: Candidate[] = windows.body.candidates;
    expect(w.every((c) => c.doctor.id === doctorA)).toBe(true);
    expect(w.map((c) => c.startsAt)).toEqual([at('07:00'), at('07:30'), at('06:00')]);
    expect(w.map((c) => c.score)).toEqual([-2, -1.5, 0]);
    expect(w[0].reasons).toContain('Within a preferred time window');

    const bySpecialty = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: at('14:00'), specialty: 'Dermatology' })
      .expect(200);
    expect(bySpecialty.body.candidates).toEqual([]);
  });

  it('validates search input and scopes a restricted DOCTOR to their own calendar', async () => {
    await request(http).get('/api/v1/appointments/search').set(auth(ownerToken)).query({ from: at('06:00') }).expect(400); // durationMinutes required
    await request(http).get('/api/v1/appointments/search').set(auth(ownerToken)).query({ durationMinutes: 30, from: at('06:00'), to: at('05:00') }).expect(400);
    await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: new Date(future.getTime() + 61 * 86_400_000).toISOString() })
      .expect(400);
    await request(http).get('/api/v1/appointments/search').set(auth(ownerToken)).query({ durationMinutes: 30, preferredWindows: 'not-json' }).expect(400);
    await request(http).get('/api/v1/appointments/search').set(auth(ownerToken)).query({ durationMinutes: 30, preferredWindows: JSON.stringify([{ weekday: 9, startTime: '09:00', endTime: '10:00' }]) }).expect(400);
    await request(http).get('/api/v1/appointments/search').set(auth(ownerToken)).query({ durationMinutes: 30, limit: 500 }).expect(400);
    await request(http).get('/api/v1/appointments/search').query({ durationMinutes: 30 }).expect(401);

    const own = await request(http).get('/api/v1/appointments/search').set(auth(doctorToken)).query({ durationMinutes: 30, from: at('06:00'), to: at('14:00') }).expect(200);
    expect(own.body.candidates.length).toBeGreaterThan(0);
    expect(own.body.candidates.every((c: Candidate) => c.doctor.id === doctorA)).toBe(true);
    await request(http).get('/api/v1/appointments/search').set(auth(doctorToken)).query({ durationMinutes: 30, doctorId: doctorB }).expect(403);
  });

  // ─────────────────────────────── §2 resources ───────────────────────────────

  it('manages the resource catalogue with the right permissions', async () => {
    const room = await request(http).post('/api/v1/resources').set(auth(ownerToken)).send({ name: 'Room 1', type: 'ROOM', color: '#ff8800' }).expect(201);
    roomId = room.body.id;
    expect(room.body).toMatchObject({ name: 'Room 1', type: 'ROOM', color: '#ff8800', isActive: true });
    const scanner = await request(http).post('/api/v1/resources').set(auth(ownerToken)).send({ name: 'Ultrasound', type: 'EQUIPMENT' }).expect(201);
    scannerId = scanner.body.id;

    await request(http).post('/api/v1/resources').set(auth(ownerToken)).send({ name: 'Room 1', type: 'ROOM' }).expect(409); // unique per clinic
    await request(http).post('/api/v1/resources').set(auth(ownerToken)).send({ name: 'Bad', type: 'SPACESHIP' }).expect(400);
    await request(http).post('/api/v1/resources').set(auth(doctorToken)).send({ name: 'Nope', type: 'ROOM' }).expect(403); // doctors lack resources:write

    const list = await request(http).get('/api/v1/resources').set(auth(doctorToken)).expect(200); // doctors:read is enough to list
    expect(list.body.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([roomId, scannerId]));

    const updated = await request(http).patch(`/api/v1/resources/${scannerId}`).set(auth(ownerToken)).send({ notes: 'Second floor', isActive: false }).expect(200);
    expect(updated.body).toMatchObject({ notes: 'Second floor', isActive: false });
    const active = await request(http).get('/api/v1/resources').set(auth(ownerToken)).expect(200);
    expect(active.body.some((r: { id: string }) => r.id === scannerId)).toBe(false);
    const all = await request(http).get('/api/v1/resources').set(auth(ownerToken)).query({ includeInactive: true }).expect(200);
    expect(all.body.some((r: { id: string }) => r.id === scannerId)).toBe(true);
    await request(http).patch(`/api/v1/resources/${scannerId}`).set(auth(ownerToken)).send({ isActive: true }).expect(200);
    await request(http).get(`/api/v1/resources/${roomId}`).set(auth(ownerToken)).expect(200);
    await request(http).get('/api/v1/resources/00000000-0000-0000-0000-000000000000').set(auth(ownerToken)).expect(404);
  });

  it('books a resource with the appointment and blocks a second overlapping booking by another doctor', async () => {
    const booked = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, patientId, startsAt: at('07:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);
    expect(booked.body.resources).toEqual([{ id: roomId, name: 'Room 1', type: 'ROOM', color: '#ff8800' }]);
    expect(booked.body.version).toBe(1);

    // Same room, other doctor, overlapping time → 409 with the resource name
    const clash = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('07:15'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(409);
    expect(clash.body.message).toBe('Resource "Room 1" is not available');
    // Nothing was written for the failed booking
    const list = await request(http).get('/api/v1/appointments').set(auth(ownerToken)).query({ doctorId: doctorB }).expect(200);
    expect(list.body.total).toBe(0);

    // Adjacent time with the same room is fine, as is an overlapping time without the room
    const adjacent = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('07:30'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);
    expect(adjacent.body.resources.map((r: { id: string }) => r.id)).toEqual([roomId]);
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId: doctorB, patientId, startsAt: at('07:00'), durationMinutes: 30 }).expect(201);

    // Unknown / inactive resources are rejected
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, patientId, startsAt: at('10:00'), resourceIds: ['00000000-0000-0000-0000-000000000000'] })
      .expect(404);
    await request(http).patch(`/api/v1/resources/${scannerId}`).set(auth(ownerToken)).send({ isActive: false }).expect(200);
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId: doctorA, patientId, startsAt: at('10:00'), resourceIds: [scannerId] }).expect(400);
    await request(http).patch(`/api/v1/resources/${scannerId}`).set(auth(ownerToken)).send({ isActive: true }).expect(200);
  });

  it('exposes resource bookings and availability, and the search honours resourceIds', async () => {
    const bookings = await request(http)
      .get(`/api/v1/resources/${roomId}/bookings`)
      .set(auth(ownerToken))
      .query({ from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.000Z` })
      .expect(200);
    expect(bookings.body.resource.id).toBe(roomId);
    expect(bookings.body.bookings).toHaveLength(2);
    expect(bookings.body.bookings[0]).toMatchObject({ active: true, startsAt: at('07:00'), endsAt: at('07:30') });
    expect(bookings.body.bookings[0].appointment).toMatchObject({ status: 'SCHEDULED', doctor: { id: doctorA }, patient: { id: patientId } });

    const avail = await request(http)
      .get('/api/v1/resources/availability')
      .set(auth(ownerToken))
      .query({ resourceIds: `${roomId},${scannerId}`, date, durationMinutes: 30 })
      .expect(200);
    expect(avail.body.timezone).toBe('Asia/Riyadh');
    const free: { startsAt: string; endsAt: string }[] = avail.body.free;
    const bookedStart = new Date(at('07:00')).getTime();
    const bookedEnd = new Date(at('08:00')).getTime();
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((f) => new Date(f.endsAt).getTime() <= bookedStart || new Date(f.startsAt).getTime() >= bookedEnd)).toBe(true);
    const slotStarts: string[] = avail.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(slotStarts).not.toContain(at('07:00'));
    expect(slotStarts).not.toContain(at('07:30'));
    expect(slotStarts).toContain(at('06:30'));
    expect(slotStarts).toContain(at('08:00'));
    await request(http).get('/api/v1/resources/availability').set(auth(ownerToken)).query({ resourceIds: roomId, date: '2026-13-40' }).expect(400);

    // Search with the room required: no candidate may overlap the room's bookings.
    const search = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: at('14:00'), resourceIds: roomId, limit: 50 })
      .expect(200);
    const candidates: Candidate[] = search.body.candidates;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => new Date(c.endsAt).getTime() <= bookedStart || new Date(c.startsAt).getTime() >= bookedEnd)).toBe(true);
    // Doctor B is now busy 07:00–08:00 (two bookings) and doctor A 07:00–07:30: with the room, 06:00 and 06:30 stay available for both.
    expect(candidates.filter((c) => c.startsAt === at('06:30')).map((c) => c.doctor.id).sort()).toEqual([doctorA, doctorB].sort());
    // The patient's own appointments count as busy for every doctor.
    const forPatient = await request(http)
      .get('/api/v1/appointments/search')
      .set(auth(ownerToken))
      .query({ durationMinutes: 30, from: at('06:00'), to: at('14:00'), patientId, limit: 50 })
      .expect(200);
    expect(forPatient.body.candidates.every((c: Candidate) => c.startsAt !== at('07:00') && c.startsAt !== at('07:30'))).toBe(true);
  });

  it('moves and releases resource bookings on reschedule and cancellation', async () => {
    const created = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, patientId, startsAt: at('11:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);
    const id = created.body.id;

    // Reschedule keeps the room booked at the new time
    const moved = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ startsAt: at('12:00') }).expect(200);
    expect(moved.body.resources.map((r: { id: string }) => r.id)).toEqual([roomId]);
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('12:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(409);
    // The old time is free again for the room
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('11:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);

    // Moving onto a time where the room is taken is refused, even for the same doctor's free slot
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ startsAt: at('11:00') }).expect(409);

    // Swap the room for the scanner, then drop every resource
    const swapped = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ resourceIds: [scannerId] }).expect(200);
    expect(swapped.body.resources.map((r: { id: string }) => r.id)).toEqual([scannerId]);
    const none = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ resourceIds: [] }).expect(200);
    expect(none.body.resources).toEqual([]);

    // Cancelling releases the resource (inactive booking rows)
    const withRoom = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorA, patientId, startsAt: at('13:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);
    await request(http).post(`/api/v1/appointments/${withRoom.body.id}/status`).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(200);
    const avail = await request(http).get('/api/v1/resources/availability').set(auth(ownerToken)).query({ resourceIds: roomId, date, durationMinutes: 30 }).expect(200);
    expect(avail.body.slots.map((s: { startsAt: string }) => s.startsAt)).toContain(at('13:00'));
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('13:00'), durationMinutes: 30, resourceIds: [roomId] })
      .expect(201);
  });

  // ─────────────────────────────── §3 robustness ───────────────────────────────

  it('replays an idempotent booking instead of creating a second appointment', async () => {
    const key = `key-${ts}`;
    const payload = { doctorId: doctorA, patientId, startsAt: at('08:00'), durationMinutes: 30 };
    const first = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).set('Idempotency-Key', key).send(payload).expect(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    expect(first.body.idempotencyKey).toBe(key);

    const replay = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).set('Idempotency-Key', key).send(payload).expect(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);

    // The key is honoured even when the payload would otherwise conflict, and via the body field too
    const bodyKey = await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ ...payload, startsAt: at('08:15'), idempotencyKey: key }).expect(200);
    expect(bodyKey.body.id).toBe(first.body.id);
    expect(bodyKey.headers['idempotent-replay']).toBe('true');

    const list = await request(http).get('/api/v1/appointments').set(auth(ownerToken)).query({ doctorId: doctorA, from: at('08:00'), to: at('08:30') }).expect(200);
    expect(list.body.total).toBe(1);
    // A different key books normally (different slot)
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).set('Idempotency-Key', `${key}-2`).send({ ...payload, startsAt: at('08:30') }).expect(201);
  });

  it('enforces optimistic locking with expectedVersion / If-Match', async () => {
    const created = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId: doctorB, patientId, startsAt: at('09:00'), durationMinutes: 30 })
      .expect(201);
    const id = created.body.id;
    expect(created.body.version).toBe(1);

    const v2 = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).set('If-Match', '1').send({ notes: 'first edit' }).expect(200);
    expect(v2.body.version).toBe(2);

    const stale = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ notes: 'stale', expectedVersion: 1 }).expect(409);
    expect(stale.body.message).toBe('Appointment was modified by someone else (version 2)');
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).set('If-Match', '"1"').send({ notes: 'stale' }).expect(409);
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).set('If-Match', 'abc').send({ notes: 'bad' }).expect(400);
    const current = await request(http).get(`/api/v1/appointments/${id}`).set(auth(ownerToken)).expect(200);
    expect(current.body).toMatchObject({ notes: 'first edit', version: 2 });

    const v3 = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ notes: 'second edit', expectedVersion: 2 }).expect(200);
    expect(v3.body).toMatchObject({ notes: 'second edit', version: 3 });

    // Status changes are versioned too
    await request(http).post(`/api/v1/appointments/${id}/status`).set(auth(ownerToken)).set('If-Match', '2').send({ status: 'CONFIRMED' }).expect(409);
    const confirmed = await request(http).post(`/api/v1/appointments/${id}/status`).set(auth(ownerToken)).send({ status: 'CONFIRMED', expectedVersion: 3 }).expect(200);
    expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', version: 4 });
    // Without a version the update still succeeds and bumps the version
    const v5 = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ reason: 'no lock' }).expect(200);
    expect(v5.body.version).toBe(5);
  });
});
