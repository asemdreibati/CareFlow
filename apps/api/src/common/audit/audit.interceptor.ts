import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { AUDIT_KEY, type AuditOptions } from '../auth/decorators.js';
import { AuditService } from './audit.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
    const action =
      options?.action ??
      `${context.getClass().name.replace(/Controller$/, '').toLowerCase()}.${context.getHandler().name}`;
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
            path: req.originalUrl,
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
            path: req.originalUrl,
            statusCode: typeof err?.status === 'number' ? err.status : 500,
            requestBody: req.body,
            durationMs: Date.now() - started,
          });
        },
      }),
    );
  }
}
