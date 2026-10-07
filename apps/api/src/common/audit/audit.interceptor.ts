import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY, type AuditOptions } from '../auth/decorators.js';
import { AuditService } from './audit.service.js';

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SECRET_QUERY_PARAMS = new Set(['token', 'access_token', 'accesstoken', 'refreshtoken', 'refresh_token', 'code', 'otp']);

/** Request path for audit rows, with credential-like query parameters removed. */
export function auditPath(originalUrl: string): string {
  const q = originalUrl.indexOf('?');
  if (q < 0) return originalUrl;
  const params = new URLSearchParams(originalUrl.slice(q + 1));
  for (const key of Array.from(params.keys())) if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) params.set(key, '[REDACTED]');
  const query = params.toString();
  return query ? `${originalUrl.slice(0, q)}?${query}` : originalUrl.slice(0, q);
}

/** Default audit action name: `<controller>.<handler>`. */
export function auditActionName(context: ExecutionContext, options?: AuditOptions): string {
  return options?.action ?? `${context.getClass().name.replace(/Controller$/, '').toLowerCase()}.${context.getHandler().name}`;
}

/**
 * Global interceptor: records every mutating request (and any read explicitly
 * decorated with @Audit) in the append-only audit log, including failures.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();
    const shouldAudit = !options?.skip && (MUTATING.has(req.method) || options !== undefined);
    if (!shouldAudit) return next.handle();

    const started = Date.now();
    const action = auditActionName(context, options);
    const entityIdFromRoute = (req.params as Record<string, string | undefined>)?.id;

    return next.handle().pipe(
      tap({
        next: (result) => {
          const res = context.switchToHttp().getResponse<Response>();
          const entityId =
            entityIdFromRoute ??
            (result && typeof result === 'object' && 'id' in result ? String((result as { id: unknown }).id) : undefined);
          this.audit.record({
            action,
            entityType: options?.entity,
            entityId,
            method: req.method,
            path: auditPath(req.originalUrl),
            statusCode: res.statusCode,
            requestBody: req.body,
            durationMs: Date.now() - started,
          });
        },
        error: (err: { status?: number }) => {
          this.audit.record({
            action,
            entityType: options?.entity,
            entityId: entityIdFromRoute,
            method: req.method,
            path: auditPath(req.originalUrl),
            statusCode: typeof err?.status === 'number' ? err.status : 500,
            requestBody: req.body,
            durationMs: Date.now() - started,
          });
        },
      }),
    );
  }
}
