import { Module } from '@nestjs/common';
import { AuditQueryService } from './audit-query.service.js';
import { AuditController } from './audit.controller.js';

@Module({ controllers: [AuditController], providers: [AuditQueryService] })
export class AuditModule {}
