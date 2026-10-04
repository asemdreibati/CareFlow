import { Logger } from '@nestjs/common';
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

export const userRoom = (userId: string) => `user:${userId}`;

/**
 * Socket.IO namespace `/notifications`.
 *   client: io('/notifications', { auth: { token: accessToken } })
 *   server → client: 'notification' (the row), 'unread-count' ({ count })
 */
@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);

  @WebSocketServer()
  server?: Namespace;

  constructor(
    config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {
    allowedOrigins = config.get('corsOrigin', { infer: true }) ?? allowedOrigins;
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
    await client.join(userRoom(payload.sub));
    this.logger.debug(`socket ${client.id} joined ${userRoom(payload.sub)}`);

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
    if (client.data?.userId) this.logger.debug(`socket ${client.id} left ${userRoom(client.data.userId as string)}`);
  }

  /** Pushes a persisted notification to its owner's room. No-op without connected clients or before init. */
  pushNotification(row: Notification) {
    this.safeEmit(userRoom(row.userId), 'notification', row);
  }

  pushUnreadCount(userId: string, count: number) {
    this.safeEmit(userRoom(userId), 'unread-count', { count });
  }

  private safeEmit(room: string, event: string, payload: unknown) {
    try {
      this.server?.to(room).emit(event, payload);
    } catch (err) {
      this.logger.warn(`Socket emit failed (${event} → ${room}): ${(err as Error).message}`);
    }
  }

  /** Verifies the handshake token and that the membership it refers to is still active. */
  private async authenticate(client: Socket): Promise<JwtPayload | null> {
    const raw = (client.handshake.auth as { token?: unknown } | undefined)?.token ?? client.handshake.query?.token;
    const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : undefined;
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      if (payload.type !== 'access' || !payload.sub || !payload.clinicId) return null;
      const membership = await tenantContext.run(
        { requestId: `ws:${client.id}`, clinicId: payload.clinicId, userId: payload.sub },
        async () =>
          await this.prisma.db.clinicMembership.findFirst({
            where: { clinicId: payload.clinicId, userId: payload.sub, isActive: true, user: { isActive: true }, clinic: { isActive: true } },
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
