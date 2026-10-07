import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AUDIT_KEY, type AuditOptions } from '../auth/decorators.js';
import { auditActionName, auditPath, MUTATING } from './audit.interceptor.js';
import type { AuditService } from './audit.service.js';

/**
 * Guards run before interceptors, so requests rejected by authentication (401),
 * authorisation (403) or throttling (429) never reach the audit interceptor. Guards
 * call this to keep the "success or failure" promise of the audit trail:
 * every 403 is recorded; 401 and 429 are recorded for mutating requests.
 */
export function recordDenied(audit: AuditService, reflector: Reflector, context: ExecutionContext, statusCode: 401 | 403 | 429): void {
  if (context.getType() !== 'http') return;
  const req = context.switchToHttp().getRequest<Request>();
  if (statusCode !== 403 && !MUTATING.has(req.method)) return;
  const options = reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_KEY, [context.getHandler(), context.getClass()]);
  audit.record({
    action: `${auditActionName(context, options)}.denied`,
    entityType: options?.entity,
    entityId: (req.params as Record<string, string | undefined>)?.id,
    method: req.method,
    path: auditPath(req.originalUrl),
    statusCode,
    requestBody: req.body,
    durationMs: 0,
  });
}
