import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ResourcesModule } from '../resources/resources.module.js';
import { NoShowService } from './no-show.service.js';
import { RemindersService } from './reminders.service.js';
import { RescheduleService } from './reschedule.service.js';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingListeners } from './scheduling.listeners.js';

/**
 * Reschedule cascade (docs/SCHEDULING.md §6), no-show prediction and the
 * reminders outbox (§7). Cron jobs: reminders worker every minute, nightly
 * no-show retrain.
 */
@Module({
  imports: [NotificationsModule, ResourcesModule],
  controllers: [SchedulingController],
  providers: [RescheduleService, NoShowService, RemindersService, SchedulingListeners],
  exports: [RescheduleService, NoShowService, RemindersService],
})
export class SchedulingModule {}
