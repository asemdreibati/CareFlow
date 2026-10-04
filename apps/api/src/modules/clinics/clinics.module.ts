import { Module } from '@nestjs/common';
import { ClinicsController } from './clinics.controller.js';
import { ClinicsService } from './clinics.service.js';

@Module({ controllers: [ClinicsController], providers: [ClinicsService], exports: [ClinicsService] })
export class ClinicsModule {}
