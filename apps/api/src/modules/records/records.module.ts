import { Module } from '@nestjs/common';
import { EncountersController, PatientEncountersController, PrescriptionsController } from './records.controller.js';
import { RecordsService } from './records.service.js';

@Module({
  controllers: [PatientEncountersController, EncountersController, PrescriptionsController],
  providers: [RecordsService],
  exports: [RecordsService],
})
export class RecordsModule {}
