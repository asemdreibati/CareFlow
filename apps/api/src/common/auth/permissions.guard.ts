import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './decorators.js';
import type { AuthUser } from './auth-user.js';
import { AuditService } from '../audit/audit.service.js';
import { recordDenied } from '../audit/denied-audit.js';

/** Global guard: enforces @RequirePermissions() against the user's resolved permission set. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) return false;

    const missing = required.filter((p) => !user.permissions.has(p));
    if (missing.length > 0) {
      recordDenied(this.audit, this.reflector, context, 403);
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }
}
