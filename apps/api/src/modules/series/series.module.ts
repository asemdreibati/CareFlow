import { Module } from '@nestjs/common';
import { WaitlistModule } from '../waitlist/waitlist.module.js';
import { SeriesController } from './series.controller.js';
import { SeriesService } from './series.service.js';

/** Recurring appointment series (rule expansion, conflict resolution, cancel-future, detach). */
@Module({
  imports: [WaitlistModule],
  controllers: [SeriesController],
  providers: [SeriesService],
  exports: [SeriesService],
})
export class SeriesModule {}
