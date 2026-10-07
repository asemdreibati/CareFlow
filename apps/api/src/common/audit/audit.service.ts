import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { tenantContext } from '../tenancy/tenant-context.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  method: string;
  path: string;
  statusCode: number;
  requestBody?: unknown;
  diff?: unknown;
  durationMs: number;
}

const REDACTED_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'refreshToken',
  'accessToken',
  'token',
  'nationalId',
  'nationalIdEnc',
  // one-time codes (patient portal login)
  'code',
  'otp',
]);

/** Deep-copies a value with sensitive keys replaced, so secrets never land in the audit table. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Fire-and-forget: audit failures are logged but never fail the user's request. */
  record(entry: AuditEntry): void {
    const ctx = tenantContext.get();
    const data: Prisma.AuditLogUncheckedCreateInput = {
      clinicId: ctx?.clinicId,
      actorUserId: ctx?.userId,
      actorPatientId: ctx?.patientId,
      actorEmail: ctx?.email,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      method: entry.method,
      path: entry.path,
      statusCode: entry.statusCode,
      requestBody: redact(entry.requestBody) as Prisma.InputJsonValue,
      diff: entry.diff as Prisma.InputJsonValue | undefined,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent?.slice(0, 512),
      requestId: ctx?.requestId ?? 'unknown',
      durationMs: entry.durationMs,
    };
    // Audit rows may have no clinic (e.g. login), so they are written in a system context.
    tenantContext
      .runSystem(() => this.prisma.db.auditLog.create({ data }))
      .catch((err) => this.logger.error(`Failed to write audit log for ${entry.action}`, err));
  }
}
