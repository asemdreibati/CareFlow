import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { tenantContext } from '../tenancy/tenant-context.js';

/**
 * Builds the SET LOCAL statement that activates Row-Level Security for the
 * current tenant. `set_config(..., true)` is transaction-scoped, so the values
 * never leak between pooled connections.
 */
function tenantSettingsSql(base: PrismaClient) {
  const ctx = tenantContext.get();
  return base.$executeRaw`
    SELECT set_config('app.current_clinic_id', ${ctx?.clinicId ?? ''}, true),
           set_config('app.current_user_id',   ${ctx?.userId ?? ''}, true),
           set_config('app.bypass_rls',        ${ctx?.bypassRls ? 'on' : 'off'}, true)`;
}

function createTenantClient(base: PrismaClient) {
  return base.$extends({
    name: 'tenant-rls',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // Every single operation runs in its own short transaction with the
          // tenant settings applied first. Multi-step work uses `transaction()`.
          const [, result] = await base.$transaction([tenantSettingsSql(base), query(args)]);
          return result;
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof createTenantClient>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly base = new PrismaClient({
    log: process.env.PRISMA_LOG ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  /**
   * Tenant-aware client. Use for single operations:
   *   this.prisma.db.patient.findMany(...)
   * RLS is applied automatically from the request context.
   */
  readonly db: TenantClient = createTenantClient(this.base);

  async onModuleInit() {
    await this.base.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }

  /**
   * Multi-step work in one transaction (tenant settings are applied once).
   * The callback receives a plain transaction client - do NOT use `this.db` inside.
   */
  async transaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return this.base.$transaction(async (tx) => {
      const ctx = tenantContext.get();
      await tx.$executeRaw`
        SELECT set_config('app.current_clinic_id', ${ctx?.clinicId ?? ''}, true),
               set_config('app.current_user_id',   ${ctx?.userId ?? ''}, true),
               set_config('app.bypass_rls',        ${ctx?.bypassRls ? 'on' : 'off'}, true)`;
      return fn(tx);
    }, options);
  }

  /** Raw access without tenant settings - only for health checks and migrations tooling. */
  get raw(): PrismaClient {
    return this.base;
  }
}
