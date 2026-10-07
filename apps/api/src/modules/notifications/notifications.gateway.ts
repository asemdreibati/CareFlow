import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Notification } from '@prisma/client';
import type { Namespace, Socket } from 'socket.io';
import type { JwtPayload } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import type { Env } from '../../config/env.js';

/**
 * Allowed origins are resolved lazily so the decorator (evaluated at class load,
 * before DI exists) can defer to the validated `Env.corsOrigin` once the gateway
 * is constructed. Until then it falls back to the raw CORS_ORIGIN variable.
 */
let allowedOrigins: readonly string[] = (process.env.CORS_ORIGIN ?? 'http://localhost:4200').split(',').map((s) => s.trim());

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / non-browser clients
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

/**
 * One room per (clinic, user): a socket joins only the room of the clinic its
 * token is bound to, so a user who belongs to several clinics never receives
 * another clinic's notifications on this connection.
 */
export const clinicUserRoom = (clinicId: string, userId: string) => `clinic:${clinicId}:user:${userId}`;

/** How often connected sockets are re-checked against their membership. */
export const SOCKET_REVALIDATE_MS = 60_000;

/** The membership a socket (or a notification recipient) needs: active, accepted, user and clinic active. */
export const activeMembershipWhere = (clinicId: string) =>
  ({ clinicId, isActive: true, acceptedAt: { not: null }, user: { isActive: true }, clinic: { isActive: true } }) as const;

type VerifiedPayload = JwtPayload & { exp?: number };

/**
 * Socket.IO namespace `/notifications`.
 *   client: io('/notifications', { auth: { token: accessToken } })
 *   server → client: 'notification' (the row), 'unread-count' ({ count })
 * A socket is disconnected when its access token expires and when a periodic
 * sweep finds its membership revoked; reconnecting needs a fresh token.
 */
@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsGateway.name);
  private sweep?: NodeJS.Timeout;

  @WebSocketServer()
  server?: Namespace;

  constructor(
    config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {
    allowedOrigins = config.get('corsOrigin', { infer: true }) ?? allowedOrigins;
  }

  onModuleInit() {
    this.sweep = setInterval(() => void this.revalidateConnections(), SOCKET_REVALIDATE_MS);
    this.sweep.unref();
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
  }

  async handleConnection(client: Socket) {
    const payload = await this.authenticate(client);
    if (!payload) {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }
    client.data.userId = payload.sub;
    client.data.clinicId = payload.clinicId;
    // The token is only checked at the handshake: drop the socket the moment it expires.
    if (payload.exp) {
      const timer = setTimeout(() => this.drop(client, 'Token expired'), Math.max(0, payload.exp * 1000 - Date.now()));
      timer.unref();
      client.data.expiryTimer = timer;
    }
    const room = clinicUserRoom(payload.clinicId, payload.sub);
    await client.join(room);
    this.logger.debug(`socket ${client.id} joined ${room}`);

    // Initial badge value for the freshly connected client.
    try {
      const count = await tenantContext.run(
        { requestId: `ws:${client.id}`, clinicId: payload.clinicId, userId: payload.sub },
        async () => await this.prisma.db.notification.count({ where: { clinicId: payload.clinicId, userId: payload.sub, readAt: null } }),
      );
      client.emit('unread-count', { count });
    } catch (err) {
      this.logger.warn(`Could not compute unread count for ${payload.sub}: ${(err as Error).message}`);
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data?.expiryTimer) clearTimeout(client.data.expiryTimer as NodeJS.Timeout);
    if (client.data?.userId) this.logger.debug(`socket ${client.id} left ${clinicUserRoom(client.data.clinicId as string, client.data.userId as string)}`);
  }

  /** Pushes a persisted notification to its owner's room in the notification's clinic. No-op without connected clients or before init. */
  pushNotification(row: Notification) {
    this.safeEmit(clinicUserRoom(row.clinicId, row.userId), 'notification', row);
  }

  pushUnreadCount(clinicId: string, userId: string, count: number) {
    this.safeEmit(clinicUserRoom(clinicId, userId), 'unread-count', { count });
  }

  /**
   * Disconnects sockets whose token has expired or whose membership is no longer
   * active (revoked, deactivated user or clinic). Runs every {@link SOCKET_REVALIDATE_MS}.
   * Returns the number of sockets dropped.
   */
  async revalidateConnections(): Promise<number> {
    const sockets = [...(this.server?.sockets?.values() ?? [])].filter((s) => s.data?.userId && s.data?.clinicId);
    const byClinic = new Map<string, Socket[]>();
    for (const s of sockets) byClinic.set(s.data.clinicId as string, [...(byClinic.get(s.data.clinicId as string) ?? []), s]);
    let dropped = 0;
    for (const [clinicId, group] of byClinic) {
      try {
        const userIds = [...new Set(group.map((s) => s.data.userId as string))];
        const active = await tenantContext.run({ requestId: 'ws:revalidate', clinicId }, async () =>
          await this.prisma.db.clinicMembership.findMany({ where: { ...activeMembershipWhere(clinicId), userId: { in: userIds } }, select: { userId: true } }),
        );
        const allowed = new Set(active.map((m) => m.userId));
        for (const s of group) {
          if (!allowed.has(s.data.userId as string)) {
            this.drop(s, 'Membership is no longer active');
            dropped += 1;
          }
        }
      } catch (err) {
        this.logger.warn(`Socket revalidation failed for clinic ${clinicId}: ${(err as Error).message}`);
      }
    }
    return dropped;
  }

  private drop(client: Socket, message: string) {
    client.emit('error', { message });
    client.disconnect(true);
  }

  private safeEmit(room: string, event: string, payload: unknown) {
    try {
      this.server?.to(room).emit(event, payload);
    } catch (err) {
      this.logger.warn(`Socket emit failed (${event} → ${room}): ${(err as Error).message}`);
    }
  }

  /** Verifies the handshake token and that the membership it refers to is still active. */
  private async authenticate(client: Socket): Promise<VerifiedPayload | null> {
    const raw = (client.handshake.auth as { token?: unknown } | undefined)?.token ?? client.handshake.query?.token;
    const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : undefined;
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<VerifiedPayload>(token);
      if (payload.type !== 'access' || !payload.sub || !payload.clinicId) return null;
      const membership = await tenantContext.run(
        { requestId: `ws:${client.id}`, clinicId: payload.clinicId, userId: payload.sub },
        async () =>
          await this.prisma.db.clinicMembership.findFirst({
            where: { ...activeMembershipWhere(payload.clinicId), userId: payload.sub },
            select: { id: true },
          }),
      );
      return membership ? payload : null;
    } catch (err) {
      this.logger.debug(`Socket auth failed: ${(err as Error).message}`);
      return null;
    }
  }
}
