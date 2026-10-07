import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';

/**
 * Regression tests for the auth / tenancy review findings: invitation consent, refresh
 * rotation races, tokens in URLs, owner and permission escalation rules, doctor profile
 * re-resolution, audit of denied requests, input validation and the database role.
 */
describe('Auth & tenancy hardening (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  let prisma: PrismaService;
  const s = Date.now().toString(36);
  const pw = 'Password123';

  const register = async (slug: string, email: string) => {
    const res = await http.post('/api/v1/auth/register')
      .send({ clinicName: `Clinic ${slug}`, slug, email, password: pw, firstName: 'Real', lastName: 'Owner' }).expect(201);
    return res.body as { tokens: { accessToken: string; refreshToken: string }; session: { clinic: { id: string }; user: { id: string } } };
  };
  const login = async (email: string) => (await http.post('/api/v1/auth/login').send({ email, password: pw }).expect(200)).body;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const auditRows = (clinicId: string, action: string) =>
    tenantContext.runSystem(() => prisma.db.auditLog.findMany({ where: { clinicId, action } }));
  const waitFor = async <T>(fn: () => Promise<T[]>, min = 1): Promise<T[]> => {
    for (let i = 0; i < 40; i++) {
      const rows = await fn();
      if (rows.length >= min) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return fn();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
  });
  afterAll(async () => app.close());

  it('the application database role is subject to Row-Level Security', async () => {
    const [role] = await prisma.raw.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('inviting an existing account creates a pending invitation and reveals nothing about it', async () => {
    const victimEmail = `victim-${s}@test.local`;
    await register(`victim-${s}`, victimEmail);
    await prisma.raw.$executeRaw`SELECT 1`; // keep connection warm
    const attacker = await register(`attacker-${s}`, `attacker-${s}@test.local`);

    const invited = await http.post('/api/v1/members').set(bearer(attacker.tokens.accessToken))
      .send({ email: victimEmail, firstName: 'X', lastName: 'Y', role: 'RECEPTIONIST', password: 'Whatever123' }).expect(201);
    expect(invited.body.status).toBe('INVITED');
    expect(invited.body.isActive).toBe(false);
    expect(invited.body.user.firstName).toBe('');
    expect(invited.body.user.phone).toBeNull();
    expect(invited.body.user.lastLoginAt).toBeNull();

    // The victim's clinics are unchanged until they accept; the invitation is visible to them.
    let victim = await login(victimEmail);
    expect(victim.session.clinics).toHaveLength(1);
    expect(victim.session.invitations).toHaveLength(1);
    // Staff of the inviting clinic cannot activate it on the victim's behalf.
    await http.patch(`/api/v1/members/${invited.body.id}`).set(bearer(attacker.tokens.accessToken)).send({ isActive: true }).expect(409);

    const accepted = await http.post(`/api/v1/auth/invitations/${victim.session.invitations[0].id}/accept`)
      .set(bearer(victim.tokens.accessToken)).expect(200);
    expect(accepted.body.clinics).toHaveLength(2);
    victim = await login(victimEmail);
    expect(victim.session.invitations).toHaveLength(0);
  });

  it('a refresh token can be rotated only once, even under concurrency', async () => {
    const reg = await register(`refresh-${s}`, `refresh-${s}@test.local`);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => http.post('/api/v1/auth/refresh').send({ refreshToken: reg.tokens.refreshToken })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(7);
  });

  it('access tokens are not accepted in the query string, and are redacted from audit paths', async () => {
    const reg = await register(`qs-${s}`, `qs-${s}@test.local`);
    await http.patch(`/api/v1/auth/me?token=${reg.tokens.accessToken}`).send({ locale: 'en' }).expect(401);
    await http.patch(`/api/v1/auth/me?token=${reg.tokens.accessToken}`).set(bearer(reg.tokens.accessToken)).send({ locale: 'en' }).expect(200);
    const rows = await waitFor(() => auditRows(reg.session.clinic.id, 'auth.updateProfile'));
    expect(rows[0].path).not.toContain(reg.tokens.accessToken);
    expect(rows[0].path).toContain('token=%5BREDACTED%5D');
  });

  it('two owners demoting each other at once cannot leave the clinic without an owner', async () => {
    const reg = await register(`owners-${s}`, `own1-${s}@test.local`);
    await http.post('/api/v1/members').set(bearer(reg.tokens.accessToken))
      .send({ email: `own2-${s}@test.local`, firstName: 'O', lastName: 'Two', role: 'OWNER', password: pw }).expect(201);
    const o2 = await login(`own2-${s}@test.local`);
    const members = (await http.get('/api/v1/members').set(bearer(reg.tokens.accessToken)).expect(200)).body as { id: string; user: { email: string } }[];
    const m1 = members.find((m) => m.user.email === `own1-${s}@test.local`)!;
    const m2 = members.find((m) => m.user.email === `own2-${s}@test.local`)!;
    const [a, b] = await Promise.all([
      http.patch(`/api/v1/members/${m2.id}`).set(bearer(reg.tokens.accessToken)).send({ role: 'ADMIN' }),
      http.patch(`/api/v1/members/${m1.id}`).set(bearer(o2.tokens.accessToken)).send({ role: 'ADMIN' }),
    ]);
    expect([a.status, b.status].filter((x) => x === 200).length).toBeLessThanOrEqual(1);
    const owners = await tenantContext.runSystem(() =>
      prisma.db.clinicMembership.count({ where: { clinicId: reg.session.clinic.id, role: 'OWNER', isActive: true } }));
    expect(owners).toBeGreaterThanOrEqual(1);
  });

  it('an ADMIN cannot grant themselves or others permissions outside the ADMIN role', async () => {
    const reg = await register(`admin-${s}`, `adm-owner-${s}@test.local`);
    await http.post('/api/v1/members').set(bearer(reg.tokens.accessToken))
      .send({ email: `adm-${s}@test.local`, firstName: 'A', lastName: 'Dmin', role: 'ADMIN', password: pw }).expect(201);
    const admin = await login(`adm-${s}@test.local`);
    const me = (await http.get('/api/v1/members').set(bearer(admin.tokens.accessToken)).expect(200)).body
      .find((m: { user: { email: string } }) => m.user.email === `adm-${s}@test.local`);
    await http.patch(`/api/v1/members/${me.id}`).set(bearer(admin.tokens.accessToken)).send({ extraPermissions: ['records:sign'] }).expect(403);
    await http.post('/api/v1/members').set(bearer(admin.tokens.accessToken))
      .send({ email: `nurse-${s}@test.local`, firstName: 'N', lastName: 'Urse', role: 'NURSE', password: pw, extraPermissions: ['records:sign'] }).expect(403);
  });

  it('denied (403) requests are recorded in the audit trail', async () => {
    const reg = await register(`deny-${s}`, `deny-owner-${s}@test.local`);
    await http.post('/api/v1/members').set(bearer(reg.tokens.accessToken))
      .send({ email: `acct-${s}@test.local`, firstName: 'A', lastName: 'Cct', role: 'ACCOUNTANT', password: pw }).expect(201);
    const acct = await login(`acct-${s}@test.local`);
    await http.post('/api/v1/members').set(bearer(acct.tokens.accessToken))
      .send({ email: `x-${s}@test.local`, firstName: 'X', lastName: 'X', role: 'ADMIN', password: pw }).expect(403);
    const rows = await waitFor(() => auditRows(reg.session.clinic.id, 'members.invite.denied'));
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe(403);
    expect(JSON.stringify(rows[0].requestBody)).not.toContain(pw);
  });

  it('the doctor profile is re-resolved on every request (unlinking takes effect immediately)', async () => {
    const reg = await register(`doc-${s}`, `doc-owner-${s}@test.local`);
    await http.post('/api/v1/members').set(bearer(reg.tokens.accessToken))
      .send({ email: `dr-${s}@test.local`, firstName: 'D', lastName: 'R', role: 'DOCTOR', password: pw }).expect(201);
    const drLogin = await login(`dr-${s}@test.local`);
    const doctor = (await http.post('/api/v1/doctors').set(bearer(reg.tokens.accessToken))
      .send({ firstName: 'D', lastName: 'R', specialty: 'GP', userId: drLogin.session.user.id }).expect(201)).body;
    // Token issued BEFORE the link still works because doctorId comes from the database.
    await http.get('/api/v1/appointments/search?durationMinutes=30').set(bearer(drLogin.tokens.accessToken)).expect(200);
    await http.patch(`/api/v1/doctors/${doctor.id}`).set(bearer(reg.tokens.accessToken)).send({ isActive: false }).expect(200);
    await http.get('/api/v1/appointments/search?durationMinutes=30').set(bearer(drLogin.tokens.accessToken)).expect(403);
  });

  it('validates logout bodies and clinic time zones', async () => {
    const reg = await register(`val-${s}`, `val-${s}@test.local`);
    await http.post('/api/v1/auth/logout').set(bearer(reg.tokens.accessToken)).send({ refreshToken: { a: 1 }, junk: 1 }).expect(400);
    await http.post('/api/v1/auth/register')
      .send({ clinicName: 'Bad TZ', slug: `badtz-${s}`, timezone: 'Not/AZone', email: `tz-${s}@test.local`, password: pw, firstName: 'T', lastName: 'Z' })
      .expect(400);
    await http.patch('/api/v1/clinic').set(bearer(reg.tokens.accessToken)).send({ timezone: 'Mars/Olympus' }).expect(400);
    await http.patch('/api/v1/clinic').set(bearer(reg.tokens.accessToken)).send({ timezone: 'Asia/Riyadh' }).expect(200);
  });
});
