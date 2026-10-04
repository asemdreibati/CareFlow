import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { AuditService } from './audit/audit.service.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { JwtStrategy } from './auth/jwt.strategy.js';
import { PermissionsGuard } from './auth/permissions.guard.js';
import { FieldEncryptionService } from './crypto/field-encryption.service.js';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter.js';
import type { Env } from '../config/env.js';

/** Cross-cutting infrastructure: auth, permissions, audit, encryption, error translation. */
@Global()
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('jwtSecret', { infer: true }),
        signOptions: { expiresIn: config.get('jwtExpiresIn', { infer: true }) },
      }),
    }),
  ],
  providers: [
    JwtStrategy,
    AuditService,
    FieldEncryptionService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
  exports: [JwtModule, PassportModule, AuditService, FieldEncryptionService],
})
export class CommonModule {}
