import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module.js';
import { PrismaModule } from './common/prisma/prisma.module.js';
import { RequestContextMiddleware } from './common/tenancy/request-context.middleware.js';
import { loadEnv } from './config/env.js';
import { HealthController } from './health.controller.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AppointmentsModule } from './modules/appointments/appointments.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { ClinicsModule } from './modules/clinics/clinics.module.js';
import { DoctorsModule } from './modules/doctors/doctors.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PatientsModule } from './modules/patients/patients.module.js';
import { RecordsModule } from './modules/records/records.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadEnv] }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    EventEmitterModule.forRoot({ wildcard: true }),
    PrismaModule,
    CommonModule,
    AuthModule,
    ClinicsModule,
    MembersModule,
    DoctorsModule,
    PatientsModule,
    AppointmentsModule,
    RecordsModule,
    BillingModule,
    NotificationsModule,
    AiModule,
    AuditModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
