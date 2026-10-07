import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service.js';
import { recordDenied } from '../audit/denied-audit.js';

/** Throttler that records rate-limited mutating requests in the audit trail. */
@Injectable()
export class AuditedThrottlerGuard extends ThrottlerGuard {
  @Inject(AuditService) private readonly audit!: AuditService;
  @Inject(Reflector) private readonly auditReflector!: Reflector;

  protected override async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    recordDenied(this.audit, this.auditReflector, context, 429);
    return super.throwThrottlingException(context, detail);
  }
}
