import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AuditService } from '../audit/audit.service.js';
import { recordDenied } from '../audit/denied-audit.js';
import { IS_PUBLIC_KEY } from './decorators.js';

/** Global guard: every route requires a JWT unless marked @Public(). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /** Records rejected (mutating) requests in the audit trail before refusing them. */
  override handleRequest<TUser>(err: unknown, user: TUser, _info: unknown, context: ExecutionContext): TUser {
    if (err || !user) {
      recordDenied(this.audit, this.reflector, context, 401);
      throw err instanceof Error ? err : new UnauthorizedException();
    }
    return user;
  }
}
