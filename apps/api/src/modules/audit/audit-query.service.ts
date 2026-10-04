import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paginate } from '../../common/dto/pagination.dto.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { AuditQuery } from './audit.dto.js';

/** Read side of the audit trail (writes happen in the global AuditInterceptor). */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(clinicId: string, q: AuditQuery) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    if (from && to && to < from) throw new BadRequestException('to must be after from');

    const where: Prisma.AuditLogWhereInput = {
      clinicId,
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.action ? { action: q.action.endsWith('.') ? { startsWith: q.action } : q.action } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q.search
        ? { OR: [
            { actorEmail: { contains: q.search, mode: 'insensitive' } },
            { action: { contains: q.search, mode: 'insensitive' } },
            { path: { contains: q.search, mode: 'insensitive' } },
          ] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.db.auditLog.findMany({
        where,
        skip: q.skip,
        take: q.pageSize,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          actorUserId: true,
          actorEmail: true,
          action: true,
          entityType: true,
          entityId: true,
          method: true,
          path: true,
          statusCode: true,
          ip: true,
          durationMs: true,
          requestId: true,
          requestBody: true,
          createdAt: true,
        },
      }),
      this.prisma.db.auditLog.count({ where }),
    ]);
    return paginate(items, total, q);
  }
}
