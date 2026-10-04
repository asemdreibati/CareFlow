import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

/**
 * Appointments + notifications end to end against the local database.
 * Registers its own clinic (timezone Asia/Riyadh, UTC+3) so it never touches seeded data.
 */
describe('Appointments (e2e)', () => {
  let app: INestApplication<App>;
  let http: App;

  const ts = Date.now();
  const slug = `appt-test-${ts}`;
  const password = 'Password123!';
  const ownerEmail = `owner-${ts}@appt-test.local`;
  const doctorEmail = `doctor-${ts}@appt-test.local`;

  let ownerToken: string;
  let doctorToken: string;
  let doctorUserId: string;
  let doctorId: string;
  let otherDoctorId: string;
  let patientId: string;
  let appointmentId: string;

  // A date one week from now, as YYYY-MM-DD. Availability covers every weekday so the weekday does not matter.
  const future = new Date(Date.now() + 7 * 86_400_000);
  const date = future.toISOString().slice(0, 10);
  // Riyadh is UTC+3 (no DST): 10:00 local = 07:00Z.
  const at = (hhmmUtc: string) => `${date}T${hhmmUtc}:00.000Z`;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function poll<T>(fn: () => Promise<T | undefined>, attempts = 20, delayMs = 150): Promise<T> {
    for (let i = 0; i < attempts; i++) {
      const v = await fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error('poll timed out');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    // Clinic + owner
    const reg = await request(http)
      .post('/api/v1/auth/register')
      .send({ clinicName: 'Appointment Test Clinic', slug, timezone: 'Asia/Riyadh', email: ownerEmail, password, firstName: 'Olive', lastName: 'Owner' })
      .expect(201);
    ownerToken = reg.body.tokens.accessToken;

    // A DOCTOR member, linked to a doctor profile with availability every day 09:00–17:00 (30-minute slots)
    const member = await request(http)
      .post('/api/v1/members')
      .set(auth(ownerToken))
      .send({ email: doctorEmail, firstName: 'Dana', lastName: 'Doctor', role: 'DOCTOR', password })
      .expect(201);
    doctorUserId = member.body.user.id;

    const doc = await request(http)
      .post('/api/v1/doctors')
      .set(auth(ownerToken))
      .send({ firstName: 'Dana', lastName: 'Doctor', specialty: 'General', userId: doctorUserId })
      .expect(201);
    doctorId = doc.body.id;
    await request(http)
      .put(`/api/v1/doctors/${doctorId}/availability`)
      .set(auth(ownerToken))
      .send({ slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00', slotMinutes: 30 })) })
      .expect(200);

    // A second doctor (no availability) to exercise doctor scoping
    const other = await request(http)
      .post('/api/v1/doctors')
      .set(auth(ownerToken))
      .send({ firstName: 'Omar', lastName: 'Other', specialty: 'Dermatology' })
      .expect(201);
    otherDoctorId = other.body.id;

    const patient = await request(http).post('/api/v1/patients').set(auth(ownerToken)).send({ firstName: 'Pat', lastName: 'Patient' }).expect(201);
    patientId = patient.body.id;

    // Login as the doctor after the profile exists so the token carries doctorId
    const login = await request(http).post('/api/v1/auth/login').send({ email: doctorEmail, password }).expect(200);
    doctorToken = login.body.tokens.accessToken;
    expect(login.body.session.doctorId).toBe(doctorId);
  });

  afterAll(async () => {
    await app.close();
  });

  it('books an appointment using the doctor slot length as default duration', async () => {
    const res = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId, patientId, startsAt: at('07:00'), reason: 'Checkup' })
      .expect(201);
    appointmentId = res.body.id;
    expect(res.body.status).toBe('SCHEDULED');
    expect(new Date(res.body.endsAt).toISOString()).toBe(at('07:30'));
    expect(res.body.doctor).toMatchObject({ id: doctorId, firstName: 'Dana', lastName: 'Doctor' });
    expect(res.body.doctor.userId).toBeUndefined();
    expect(res.body.patient).toMatchObject({ id: patientId, firstName: 'Pat', lastName: 'Patient' });
    expect(res.body.patient.mrn).toBeTruthy();
  });

  it('rejects an overlapping booking with 409', async () => {
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId, patientId, startsAt: at('07:15'), durationMinutes: 30 })
      .expect(409);
  });

  it('rejects a booking outside availability with 400', async () => {
    // 05:00Z = 08:00 Riyadh, before the 09:00 opening
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt: at('05:00') }).expect(400);
    // endsAt before startsAt
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId, patientId, startsAt: at('08:00'), endsAt: at('07:45') })
      .expect(400);
    // doctor without any availability
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId: otherDoctorId, patientId, startsAt: at('07:00') }).expect(400);
  });

  it('rejects a booking inside doctor time off with 400', async () => {
    // 14:00–15:00 Riyadh
    await request(http)
      .post(`/api/v1/doctors/${doctorId}/time-off`)
      .set(auth(ownerToken))
      .send({ startsAt: at('11:00'), endsAt: at('12:00'), reason: 'Lunch meeting' })
      .expect(201);
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt: at('11:00') }).expect(400);
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt: at('11:45') }).expect(400);
  });

  it('computes availability slots without booked, time-off or past slots', async () => {
    const res = await request(http).get('/api/v1/appointments/availability').set(auth(ownerToken)).query({ doctorId, date }).expect(200);
    expect(res.body.date).toBe(date);
    const starts: string[] = res.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts[0]).toBe(at('06:00')); // 09:00 Riyadh
    expect(starts.at(-1)).toBe(at('13:30')); // 16:30 Riyadh (last 30-minute slot before 17:00)
    expect(starts).not.toContain(at('07:00')); // booked
    expect(starts).toContain(at('06:30'));
    expect(starts).toContain(at('07:30'));
    expect(starts).not.toContain(at('11:00')); // time off
    expect(starts).not.toContain(at('11:30'));
    expect(res.body.slots[0].endsAt).toBe(at('06:30'));
    // 16 half-hour slots in 8 hours, minus 1 booked and 2 time off
    expect(starts).toHaveLength(13);

    // Requested duration overrides the slot length
    const hour = await request(http).get('/api/v1/appointments/availability').set(auth(ownerToken)).query({ doctorId, date, durationMinutes: 60 }).expect(200);
    const hourStarts: string[] = hour.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(hourStarts).toContain(at('08:00'));
    expect(hourStarts).not.toContain(at('07:00')); // would overlap the booking (07:00–07:30)
    expect(hourStarts).toContain(at('06:00')); // 06:00–07:00 only touches the booking, so it is bookable
    expect(hourStarts).not.toContain(at('10:30')); // 10:30–11:30 would run into the time off
  });

  it('lists, filters and fetches appointments', async () => {
    const list = await request(http)
      .get('/api/v1/appointments')
      .set(auth(ownerToken))
      .query({ from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.000Z`, doctorId })
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(appointmentId);
    expect(list.body.items[0].doctor).toMatchObject({ id: doctorId });

    const byStatus = await request(http).get('/api/v1/appointments').set(auth(ownerToken)).query({ status: 'CANCELLED' }).expect(200);
    expect(byStatus.body.total).toBe(0);

    const cal = await request(http)
      .get('/api/v1/appointments/calendar')
      .set(auth(ownerToken))
      .query({ from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.000Z` })
      .expect(200);
    expect(Array.isArray(cal.body)).toBe(true);
    expect(cal.body).toHaveLength(1);

    await request(http)
      .get('/api/v1/appointments/calendar')
      .set(auth(ownerToken))
      .query({ from: `${date}T00:00:00.000Z`, to: new Date(future.getTime() + 40 * 86_400_000).toISOString() })
      .expect(400);

    const one = await request(http).get(`/api/v1/appointments/${appointmentId}`).set(auth(ownerToken)).expect(200);
    expect(one.body.id).toBe(appointmentId);
    expect(one.body.patient.mrn).toBeTruthy();
    expect(one.body.encounter).toBeNull();
  });

  it('scopes a DOCTOR without appointments:read_all to their own schedule', async () => {
    const list = await request(http).get('/api/v1/appointments').set(auth(doctorToken)).expect(200);
    expect(list.body.items.every((a: { doctorId: string }) => a.doctorId === doctorId)).toBe(true);
    expect(list.body.total).toBe(1);

    await request(http).get('/api/v1/appointments').set(auth(doctorToken)).query({ doctorId: otherDoctorId }).expect(403);
    await request(http).get('/api/v1/appointments/availability').set(auth(doctorToken)).query({ doctorId: otherDoctorId, date }).expect(403);
    await request(http)
      .post('/api/v1/appointments')
      .set(auth(doctorToken))
      .send({ doctorId: otherDoctorId, patientId, startsAt: at('09:00') })
      .expect(403);
    await request(http).patch(`/api/v1/appointments/${appointmentId}`).set(auth(doctorToken)).send({ doctorId: otherDoctorId }).expect(403);
  });

  it('notifies the linked doctor user about the booking (not the actor)', async () => {
    const body = await poll(async () => {
      const res = await request(http).get('/api/v1/notifications').set(auth(doctorToken)).expect(200);
      const hit = res.body.items.find((n: { type: string; data?: { appointmentId?: string } }) => n.type === 'APPOINTMENT_CREATED' && n.data?.appointmentId === appointmentId);
      return hit ? res.body : undefined;
    });
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);
    const row = body.items.find((n: { type: string }) => n.type === 'APPOINTMENT_CREATED');
    expect(row.readAt).toBeNull();
    expect(row.body).toContain('Pat Patient');

    // The owner created it, so they get nothing for this event.
    const owner = await request(http).get('/api/v1/notifications').set(auth(ownerToken)).expect(200);
    expect(owner.body.items.filter((n: { type: string }) => n.type === 'APPOINTMENT_CREATED')).toHaveLength(0);

    // Mark one read, then read-all
    const read = await request(http).post(`/api/v1/notifications/${row.id}/read`).set(auth(doctorToken)).expect(200);
    expect(read.body.readAt).toBeTruthy();
    // Other users cannot touch it
    await request(http).post(`/api/v1/notifications/${row.id}/read`).set(auth(ownerToken)).expect(404);
    const unread = await request(http).get('/api/v1/notifications').set(auth(doctorToken)).query({ unreadOnly: true }).expect(200);
    expect(unread.body.items.some((n: { id: string }) => n.id === row.id)).toBe(false);
    const all = await request(http).post('/api/v1/notifications/read-all').set(auth(doctorToken)).expect(200);
    expect(all.body.unreadCount).toBe(0);
  });

  it('enforces the status transition table and edit rules', async () => {
    const url = `/api/v1/appointments/${appointmentId}/status`;
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'COMPLETED' }).expect(400); // SCHEDULED → COMPLETED not allowed
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'CONFIRMED', cancellationNote: 'x' }).expect(400); // note only when cancelling
    const confirmed = await request(http).post(url).set(auth(ownerToken)).send({ status: 'CONFIRMED' }).expect(200);
    expect(confirmed.body.status).toBe('CONFIRMED');
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'SCHEDULED' }).expect(400);

    // The doctor checks the patient in → the creator (owner) is notified; the doctor (actor) is not.
    const checkedIn = await request(http).post(url).set(auth(doctorToken)).send({ status: 'CHECKED_IN' }).expect(200);
    expect(checkedIn.body.status).toBe('CHECKED_IN');
    await poll(async () => {
      const res = await request(http).get('/api/v1/notifications').set(auth(ownerToken)).expect(200);
      return res.body.items.some((n: { type: string; data?: { appointmentId?: string } }) => n.type === 'PATIENT_CHECKED_IN' && n.data?.appointmentId === appointmentId)
        ? true
        : undefined;
    });
    const doctorNotifs = await request(http).get('/api/v1/notifications').set(auth(doctorToken)).expect(200);
    expect(doctorNotifs.body.items.some((n: { type: string }) => n.type === 'PATIENT_CHECKED_IN')).toBe(false);

    // Editing is still allowed while active
    const edited = await request(http).patch(`/api/v1/appointments/${appointmentId}`).set(auth(ownerToken)).send({ notes: 'Running late' }).expect(200);
    expect(edited.body.notes).toBe('Running late');

    await request(http).post(url).set(auth(ownerToken)).send({ status: 'COMPLETED' }).expect(400); // CHECKED_IN → COMPLETED not allowed
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'IN_PROGRESS' }).expect(200);
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(400); // IN_PROGRESS → CANCELLED not allowed
    const done = await request(http).post(url).set(auth(ownerToken)).send({ status: 'COMPLETED' }).expect(200);
    expect(done.body.status).toBe('COMPLETED');

    // Final: no more edits or transitions
    await request(http).patch(`/api/v1/appointments/${appointmentId}`).set(auth(ownerToken)).send({ notes: 'nope' }).expect(409);
    await request(http).post(url).set(auth(ownerToken)).send({ status: 'CANCELLED' }).expect(400);
  });

  it('reschedules, cancels and frees the slot', async () => {
    const created = await request(http)
      .post('/api/v1/appointments')
      .set(auth(ownerToken))
      .send({ doctorId, patientId, startsAt: at('08:00'), durationMinutes: 30, type: 'FOLLOW_UP' })
      .expect(201);
    const id = created.body.id;

    // Move start only: the duration is kept
    const moved = await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ startsAt: at('09:00') }).expect(200);
    expect(new Date(moved.body.endsAt).toISOString()).toBe(at('09:30'));
    // Moving onto the time off is rejected, moving onto itself is fine
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ startsAt: at('11:30') }).expect(400);
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ startsAt: at('09:00'), endsAt: at('10:00') }).expect(200);

    const cancelled = await request(http)
      .post(`/api/v1/appointments/${id}/status`)
      .set(auth(ownerToken))
      .send({ status: 'CANCELLED', cancellationNote: 'Patient request' })
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancellationNote: 'Patient request' });
    await request(http).patch(`/api/v1/appointments/${id}`).set(auth(ownerToken)).send({ notes: 'x' }).expect(409);

    // Cancelled appointments do not block the slot (service check and DB exclusion constraint agree)
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt: at('09:00'), durationMinutes: 60 }).expect(201);
    const avail = await request(http).get('/api/v1/appointments/availability').set(auth(ownerToken)).query({ doctorId, date }).expect(200);
    const starts: string[] = avail.body.slots.map((s: { startsAt: string }) => s.startsAt);
    expect(starts).not.toContain(at('09:00'));
    expect(starts).not.toContain(at('09:30'));
  });

  it('validates input', async () => {
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId }).expect(400);
    await request(http).post('/api/v1/appointments').set(auth(ownerToken)).send({ doctorId, patientId, startsAt: at('12:00'), bogus: 1 }).expect(400);
    await request(http).get('/api/v1/appointments/availability').set(auth(ownerToken)).query({ doctorId, date: '2026-13-40' }).expect(400);
    await request(http).get('/api/v1/appointments/availability').set(auth(ownerToken)).query({ doctorId }).expect(400);
    await request(http).get('/api/v1/appointments/00000000-0000-0000-0000-000000000000').set(auth(ownerToken)).expect(404);
    await request(http).get('/api/v1/appointments').expect(401);
  });
});
