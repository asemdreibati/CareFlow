import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../permissions/permissions.js';
import type { AuthUser } from './auth-user.js';

export const IS_PUBLIC_KEY = 'careflow:isPublic';
export const PERMISSIONS_KEY = 'careflow:permissions';
export const AUDIT_KEY = 'careflow:audit';

/** Marks a route as reachable without a JWT. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires ALL listed permissions on the active clinic membership. */
export const RequirePermissions = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuditOptions {
  /** Dotted action name, e.g. `appointments.cancel`. Defaults to `<controller>.<handler>`. */
  action?: string;
  /** Entity type stored in the audit row, e.g. `Appointment`. */
  entity?: string;
  /** Skip auditing (for high-volume reads that are logged elsewhere). */
  skip?: boolean;
}

/** Customises how the audit interceptor records this handler. */
export const Audit = (options: AuditOptions) => SetMetadata(AUDIT_KEY, options);

/** Injects the authenticated user (from the validated JWT). */
export const CurrentUser = createParamDecorator((data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
  const user = ctx.switchToHttp().getRequest().user as AuthUser;
  return data ? user?.[data] : user;
});
