import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Socket } from 'socket.io';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { tenantContext } from '../src/common/tenancy/tenant-context.js';
import { NotificationsGateway, clinicUserRoom } from '../src/modules/notifications/notifications.gateway.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';

type Emit = { room: string; event: string; payload: unknown };

/** Minimal stand-in for the Socket.IO namespace: records `to(room).emit(...)` and holds "connected" sockets. */
function fakeNamespace(emits: Emit[]) {
  return {
    sockets: new Map<string, Socket>(),
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emits.push({ room, event, payload }) }),
  };
}

function fakeSocket(id: string, data: Record<string, unknown> = {}, token?: string) {
  return {
    id,
    data,
    handshake: { auth: token ? { token } : {}, query: {} },
    emit: vi.fn(),
    disconnect: vi.fn(),
    join: vi.fn(async () => undefined),
  } as unknown as Socket & { emit: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; join: ReturnType<typeof vi.fn> };
}

/**
 * Notification delivery is scoped per clinic: rooms are `clinic:<id>:user:<id>`,
 * recipients must be active members of the notification's clinic, and sockets are
 * dropped when their token expires or their membership is revoked.
 */
describe('Notifications delivery scoping (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let gateway: NotificationsGateway;
  let notifications: NotificationsService;
  let jwt: JwtService;
  let originalServer: NotificationsGateway['server'];
  const emits: Emit[] = [];
  const ns = fakeNamespace(emits);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const pw = 'Password1234';
  let clinicA: string, clinicB: string;
  let userU: string, ownerB: string;
  let tokenA: string;

  const api = () => request(app.getHttpServer());
  const setMembership = (isActive: boolean) =>
    tenantContext.runSystem(() => prisma.db.clinicMembership.updateMany({ where: { clinicId: clinicB, userId: userU }, data: { isActive } }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    gateway = app.get(NotificationsGateway);
    notifications = app.get(NotificationsService);
    jwt = app.get(JwtService, { strict: false });
    originalServer = gateway.server;
    gateway.server = ns as unknown as NotificationsGateway['server'];

    const regA = await api().post('/api/v1/auth/register').send({ clinicName: 'A', slug: `nta-${stamp}`, email: `u-${stamp}@nt.test`, password: pw, firstName: 'U', lastName: 'U' }).expect(201);
    const regB = await api().post('/api/v1/auth/register').send({ clinicName: 'B', slug: `ntb-${stamp}`, email: `ob-${stamp}@nt.test`, password: pw, firstName: 'O', lastName: 'B' }).expect(201);
    clinicA = regA.body.session.clinic.id;
    clinicB = regB.body.session.clinic.id;
    userU = regA.body.session.user.id;
    ownerB = regB.body.session.user.id;
    tokenA = regA.body.tokens.accessToken;
    // U is also an (accepted) DOCTOR member of clinic B.
    await tenantContext.runSystem(() => prisma.db.clinicMembership.create({ data: { clinicId: clinicB, userId: userU, role: 'DOCTOR', acceptedAt: new Date() } }));
  });

  afterAll(async () => {
    gateway.server = originalServer;
    await app.close();
  });

  it('joins only the room of the clinic the token is bound to', async () => {
    const client = fakeSocket('s-join', {}, tokenA);
    await gateway.handleConnection(client);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalledTimes(1);
    expect(client.join).toHaveBeenCalledWith(clinicUserRoom(clinicA, userU));
    expect(client.data).toMatchObject({ userId: userU, clinicId: clinicA });
    gateway.handleDisconnect(client);
  });

  it("pushes a clinic-B notification only to U's clinic-B room", async () => {
    emits.length = 0;
    const rows = await notifications.notify([userU], { clinicId: clinicB, type: 'APPOINTMENT_CREATED', title: 't', body: 'b' });
    expect(rows).toHaveLength(1);
    expect(new Set(emits.map((e) => e.room))).toEqual(new Set([clinicUserRoom(clinicB, userU)]));
    expect(emits.map((e) => e.event).sort()).toEqual(['notification', 'unread-count']);
    expect(emits.some((e) => e.room === clinicUserRoom(clinicA, userU) || e.room === `user:${userU}`)).toBe(false);
  });

  it('drops recipients whose membership in the clinic is revoked', async () => {
    await setMembership(false);
    emits.length = 0;
    const rows = await notifications.notify([userU, ownerB], { clinicId: clinicB, type: 'APPOINTMENT_CREATED', title: 't', body: 'b' });
    expect(rows.map((r) => r.userId)).toEqual([ownerB]);
    expect(emits.every((e) => e.room === clinicUserRoom(clinicB, ownerB))).toBe(true);
    // Not a member of clinic B at all: nothing is persisted either.
    const stranger = (await api().post('/api/v1/auth/register').send({ clinicName: 'C', slug: `ntc-${stamp}`, email: `s-${stamp}@nt.test`, password: pw, firstName: 'S', lastName: 'S' }).expect(201)).body.session.user.id;
    expect(await notifications.notify([stranger], { clinicId: clinicB, type: 'APPOINTMENT_CREATED', title: 't', body: 'b' })).toEqual([]);
    await setMembership(true);
  });

  it('periodic revalidation disconnects sockets whose membership was revoked', async () => {
    const uInB = fakeSocket('s1', { userId: userU, clinicId: clinicB });
    const uInA = fakeSocket('s2', { userId: userU, clinicId: clinicA });
    const ownerInB = fakeSocket('s3', { userId: ownerB, clinicId: clinicB });
    for (const s of [uInB, uInA, ownerInB]) ns.sockets.set(s.id, s);
    try {
      expect(await gateway.revalidateConnections()).toBe(0);
      await setMembership(false);
      expect(await gateway.revalidateConnections()).toBe(1);
      expect(uInB.disconnect).toHaveBeenCalledWith(true);
      expect(uInB.emit).toHaveBeenCalledWith('error', { message: 'Membership is no longer active' });
      expect(uInA.disconnect).not.toHaveBeenCalled();
      expect(ownerInB.disconnect).not.toHaveBeenCalled();
    } finally {
      ns.sockets.clear();
      await setMembership(true);
    }
  });

  it('rejects a revoked member at the handshake', async () => {
    await setMembership(false);
    try {
      const tokenB = await jwt.signAsync({ sub: userU, email: `u-${stamp}@nt.test`, clinicId: clinicB, role: 'DOCTOR', type: 'access' });
      const client = fakeSocket('s-revoked', {}, tokenB);
      await gateway.handleConnection(client);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    } finally {
      await setMembership(true);
    }
  });

  it('disconnects a socket when its access token expires', async () => {
    const shortLived = await jwt.signAsync({ sub: userU, email: `u-${stamp}@nt.test`, clinicId: clinicA, role: 'OWNER', type: 'access' }, { expiresIn: 1 });
    const client = fakeSocket('s-exp', {}, shortLived);
    await gateway.handleConnection(client);
    expect(client.join).toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalledWith(true), { timeout: 3000, interval: 50 });
    expect(client.emit).toHaveBeenCalledWith('error', { message: 'Token expired' });
    gateway.handleDisconnect(client);
  });
});
