import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Notification, NotificationType, Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { tenantContext } from '../../common/tenancy/tenant-context.js';
import { NotificationsGateway, activeMembershipWhere } from './notifications.gateway.js';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /**
   * Clinic the notification belongs to. Defaults to the clinic of the current
   * request context; required when called outside a request (jobs, sockets).
   */
  clinicId?: string;
}

const LIST_LIMIT = 50;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /**
   * Single entry point for creating notifications: one row per distinct user who
   * is still an ACTIVE member of the clinic (revoked members, pending invitations
   * and deactivated users are dropped), persisted, then pushed over Socket.IO to
   * each user's room for that clinic together with the fresh unread count.
   * Returns the created rows.
   */
  async notify(userIds: readonly string[], input: NotifyInput): Promise<Notification[]> {
    const requested = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (requested.length === 0) return [];
    const clinicId = input.clinicId ?? tenantContext.get()?.clinicId;
    if (!clinicId) {
      this.logger.warn(`notify(${input.type}) called without a clinic context; dropped`);
      return [];
    }
    const members = await this.inClinic(clinicId, () =>
      this.prisma.db.clinicMembership.findMany({ where: { ...activeMembershipWhere(clinicId), userId: { in: requested } }, select: { userId: true } }),
    );
    const active = new Set(members.map((m) => m.userId));
    const recipients = requested.filter((id) => active.has(id));
    if (recipients.length === 0) return [];

    const rows = await this.inClinic(clinicId, () =>
      this.prisma.db.notification.createManyAndReturn({
        data: recipients.map((userId) => ({
          clinicId,
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        })),
      }),
    );

    for (const row of rows) this.gateway.pushNotification(row);
    await Promise.all(
      recipients.map(async (userId) => {
        const count = await this.inClinic(clinicId, () => this.unreadCount(clinicId, userId));
        this.gateway.pushUnreadCount(clinicId, userId, count);
      }),
    );
    return rows;
  }

  /** Latest 50 notifications of the current user in the active clinic, plus the unread count. */
  async list(user: AuthUser, unreadOnly = false) {
    const where: Prisma.NotificationWhereInput = { clinicId: user.clinicId, userId: user.id, ...(unreadOnly ? { readAt: null } : {}) };
    const [items, unreadCount] = await Promise.all([
      this.prisma.db.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: LIST_LIMIT }),
      this.unreadCount(user.clinicId, user.id),
    ]);
    return { items, unreadCount };
  }

  async markRead(user: AuthUser, id: string) {
    const row = await this.prisma.db.notification.findFirst({ where: { id, clinicId: user.clinicId, userId: user.id } });
    if (!row) throw new NotFoundException('Notification not found');
    const updated = row.readAt ? row : await this.prisma.db.notification.update({ where: { id }, data: { readAt: new Date() } });
    const count = await this.unreadCount(user.clinicId, user.id);
    this.gateway.pushUnreadCount(user.clinicId, user.id, count);
    return updated;
  }

  async markAllRead(user: AuthUser) {
    const result = await this.prisma.db.notification.updateMany({
      where: { clinicId: user.clinicId, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    this.gateway.pushUnreadCount(user.clinicId, user.id, 0);
    return { updated: result.count, unreadCount: 0 };
  }

  unreadCount(clinicId: string, userId: string): Promise<number> {
    return this.prisma.db.notification.count({ where: { clinicId, userId, readAt: null } });
  }

  /**
   * Runs `fn` with RLS scoped to `clinicId`. Inside a request for the same clinic
   * the existing context is reused; otherwise a plain (non-bypass) tenant context
   * is created so the policy still applies.
   */
  private inClinic<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
    const ctx = tenantContext.get();
    if (ctx?.clinicId === clinicId) return fn();
    return tenantContext.run({ requestId: ctx?.requestId ?? 'notifications', userId: ctx?.userId, clinicId }, async () => await fn());
  }
}
