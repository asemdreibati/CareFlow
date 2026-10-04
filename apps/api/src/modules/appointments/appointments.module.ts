import { Module } from '@nestjs/common';
import { ResourcesModule } from '../resources/resources.module.js';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { SlotSearchService } from './slot-search.service.js';

@Module({
  imports: [ResourcesModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService, SlotSearchService],
  exports: [AppointmentsService, SlotSearchService],
})
export class AppointmentsModule {}
