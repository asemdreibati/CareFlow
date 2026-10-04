import { AsyncLocalStorage } from 'node:async_hooks';
import type { Role } from '@prisma/client';

/**
 * Per-request context propagated through AsyncLocalStorage. The Prisma layer
 * reads it to set the PostgreSQL session variables that drive Row-Level Security,
 * so every query is tenant-scoped without services having to remember a filter.
 */
export interface TenantContext {
  requestId: string;
  clinicId?: string;
  userId?: string;
  email?: string;
  role?: Role;
  permissions?: ReadonlySet<string>;
  /** Doctor profile id when the user is linked to a doctor in the active clinic. */
  doctorId?: string;
  /** Only set by explicitly privileged system paths (login, provisioning, seeds). */
  bypassRls?: boolean;
  ip?: string;
  userAgent?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export const tenantContext = {
  /** Run `fn` with a fresh context (used by middleware, jobs and tests). */
  run<T>(ctx: TenantContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  /** Bind the current async chain to `ctx` (used at the start of a request). */
  enter(ctx: TenantContext): void {
    storage.enterWith(ctx);
  },
  get(): TenantContext | undefined {
    return storage.getStore();
  },
  /** Mutate the active context in place (the auth guard fills in identity). */
  assign(partial: Partial<TenantContext>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, partial);
  },
  /** Execute `fn` in a privileged system context that bypasses RLS. Use sparingly. */
  runSystem<T>(fn: () => Promise<T>, extra: Partial<TenantContext> = {}): Promise<T> {
    const parent = storage.getStore();
    // Prisma queries are lazy (they run when awaited), so the await MUST happen
    // inside the callback for the privileged context to apply to the query.
    return storage.run(
      { requestId: parent?.requestId ?? 'system', ...parent, ...extra, bypassRls: true },
      async () => await fn(),
    );
  },
};
