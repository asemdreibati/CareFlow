import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module.js';

/**
 * Multi-tenancy guarantees: data created in one clinic is invisible to another,
 * tokens are bound to a clinic, and permissions are enforced per role.
 */
describe('Tenancy & permissions (e2e)', () => {
  let app: INestApplication<App>;
  let http: ReturnType<typeof request>;
  const suffix = Date.now().toString(36);
  let tokenA: string;
  let tokenB: string;
  let patientA: string;

  const register = async (slug: string) => {
    const res = await http
      .post('/api/v1/auth/register')
      .send({ clinicName: `Clinic ${slug}`, slug, email: `owner-${slug}@test.local`, password: 'Password123', firstName: 'O', lastName: 'W' })
      .expect(201);
    return res.body.tokens.accessToken as string;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    tokenA = await register(`ten-a-${suffix}`);
    tokenB = await register(`ten-b-${suffix}`);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated access', async () => {
    await http.get('/api/v1/patients').expect(401);
  });

  it('isolates patients between clinics', async () => {
    const created = await http
      .post('/api/v1/patients')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ firstName: 'Iso', lastName: 'Lated', nationalId: '987654321' })
      .expect(201);
    patientA = created.body.id;
    expect(created.body.nationalId).toBe('987654321');
    expect(created.body.nationalIdMasked).toBe('*****4321');

    await http.get(`/api/v1/patients/${patientA}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
    await http.get(`/api/v1/patients/${patientA}`).set('Authorization', `Bearer ${tokenB}`).expect(404);
    const listB = await http.get('/api/v1/patients').set('Authorization', `Bearer ${tokenB}`).expect(200);
    expect(listB.body.total).toBe(0);
  });

  it('prevents updating another clinic\'s patient even by id', async () => {
    await http.patch(`/api/v1/patients/${patientA}`).set('Authorization', `Bearer ${tokenB}`).send({ notes: 'x' }).expect(404);
    await http.delete(`/api/v1/patients/${patientA}`).set('Authorization', `Bearer ${tokenB}`).expect(404);
  });

  it('enforces role permissions (accountant cannot create patients or read members)', async () => {
    await http
      .post('/api/v1/members')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ email: `acct-${suffix}@test.local`, firstName: 'A', lastName: 'C', role: 'ACCOUNTANT', password: 'Password123' })
      .expect(201);
    const login = await http
      .post('/api/v1/auth/login')
      .send({ email: `acct-${suffix}@test.local`, password: 'Password123' })
      .expect(200);
    const acct = login.body.tokens.accessToken as string;
    expect(login.body.session.role).toBe('ACCOUNTANT');
    await http.post('/api/v1/patients').set('Authorization', `Bearer ${acct}`).send({ firstName: 'N', lastName: 'O' }).expect(403);
    await http.get('/api/v1/members').set('Authorization', `Bearer ${acct}`).expect(403);
    // Reads allowed, but the identifier stays masked for this role.
    const p = await http.get(`/api/v1/patients/${patientA}`).set('Authorization', `Bearer ${acct}`).expect(200);
    expect(p.body.nationalId).toBeNull();
    expect(p.body.nationalIdMasked).toBe('*****4321');
  });

  it('records who viewed a patient profile', async () => {
    const log = await http.get(`/api/v1/patients/${patientA}/access-log`).set('Authorization', `Bearer ${tokenA}`).expect(200);
    expect(log.body.length).toBeGreaterThanOrEqual(2);
    expect(log.body[0].action).toBe('VIEW_PROFILE');
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const login = await http.post('/api/v1/auth/login').send({ email: `owner-ten-a-${suffix}@test.local`, password: 'Password123' }).expect(200);
    const rt = login.body.tokens.refreshToken as string;
    const refreshed = await http.post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(200);
    expect(refreshed.body.tokens.accessToken).toBeTruthy();
    await http.post('/api/v1/auth/refresh').send({ refreshToken: rt }).expect(401);
  });

  it('lists inactive patients only when asked', async () => {
    const created = await http.post('/api/v1/patients').set('Authorization', `Bearer ${tokenA}`).send({ firstName: 'Gone', lastName: 'Soon' }).expect(201);
    await http.delete(`/api/v1/patients/${created.body.id}`).set('Authorization', `Bearer ${tokenA}`).expect(200);
    const active = await http.get('/api/v1/patients?search=Gone').set('Authorization', `Bearer ${tokenA}`).expect(200);
    expect(active.body.total).toBe(0);
    const all = await http.get('/api/v1/patients?search=Gone&includeInactive=true').set('Authorization', `Bearer ${tokenA}`).expect(200);
    expect(all.body.total).toBe(1);
    await http.get('/api/v1/doctors?includeInactive=true').set('Authorization', `Bearer ${tokenA}`).expect(200);
  });

  it('rejects unknown body fields', async () => {
    await http.post('/api/v1/patients').set('Authorization', `Bearer ${tokenA}`).send({ firstName: 'A', lastName: 'B', clinicId: 'hack' }).expect(400);
  });
});
